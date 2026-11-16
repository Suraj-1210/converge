import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  BannerKind,
  EVENT_TYPE_CODES,
  EventAudience,
  EventRegistrationStatus,
  UserStatus,
  UserType,
  type EventType,
} from "~/server/db/enums";
import {
  announceEventUpdate,
  eventVisibleTo,
  isPdfUrl,
  materialSnapshot,
  shareEvent,
} from "~/server/event-sharing";
import {
  ROTATE_KEY,
  ROTATE_MAX,
  ROTATE_MIN,
  bannerSelect,
  bannerStatus,
  rotateSeconds,
  slidesFor,
  toSlide,
} from "~/server/partner-banners";
import { resolveStorageUrl } from "~/server/storage";

// ---------------------------------------------------------------------------
// Events — admin CRUD over the `event` table. start/end_time are MySQL TIME
// columns serialized to "HH:MM" (UTC); event_date is a DATE exchanged as
// "YYYY-MM-DD" (UTC). is_active maps to Published(1)/Draft(0).
//
// Partner invites + RSVP ride on the existing event_registration table
// (event_id, user_id, status). status uses EventRegistrationStatus.
//
// Creatives, audience, sharing (email + bell, once per person) and the
// partner dashboard banner: src/server/event-sharing.ts and
// src/server/partner-banners.ts. Every admin procedure here is gated by the
// Events tab (API_SECTIONS "events." in ~/lib/admin-sections).
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const ACCEPTED_RSVP: number[] = [
  EventRegistrationStatus.ACCEPTED,
  EventRegistrationStatus.ATTENDED,
];

function timeToDate(hhmm: string | null | undefined): Date | null {
  if (!hhmm) return null;
  return new Date(`1970-01-01T${hhmm}:00.000Z`);
}
function dateToTime(d: Date | null): string | null {
  return d ? d.toISOString().slice(11, 16) : null;
}

// An admin-entered web link: http(s) only.
const webUrl = z
  .string()
  .trim()
  .max(500)
  .url("Enter a full link starting with https://")
  .refine((u) => /^https?:\/\//i.test(u), "Links must start with http:// or https://");
// A file from /api/upload: a public Spaces URL, or /uploads/… in local dev.
const uploadedUrl = z
  .string()
  .trim()
  .max(500)
  .refine((u) => /^https:\/\//i.test(u) || u.startsWith("/uploads/"), "Upload the file again");

const eventInput = z.object({
  title: z.string().trim().min(1).max(255),
  eventType: z
    .number()
    .int()
    .refine((v) => EVENT_TYPE_CODES.includes(v as EventType), "Invalid type"),
  eventDate: z.string().regex(DATE_KEY, "Invalid date"),
  startTime: z.string().regex(HHMM).nullable().optional(),
  endTime: z.string().regex(HHMM).nullable().optional(),
  isVirtual: z.boolean(),
  location: z.string().trim().max(255).nullable().optional(),
  meetingUrl: z.string().trim().max(500).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  maxAttendees: z.number().int().positive().max(100000).nullable().optional(),
  organizer: z.string().trim().max(255).nullable().optional(),
  agenda: z.string().trim().max(5000).nullable().optional(),
  actualAttendance: z.number().int().min(0).max(1000000).nullable().optional(),
  isActive: z.boolean(),
  creativeUrl: uploadedUrl.nullable().optional(),
  registrationUrl: webUrl.nullable().optional(),
  audience: z.enum(["all", "selected"]),
  // Email + bell the audience when published (once per person).
  sharePartners: z.boolean(),
  // Keep the event on the partner dashboard banner. undefined = leave as is.
  showOnDashboard: z.boolean().optional(),
  // Partner user IDs to invite (audience "selected"). undefined = unchanged.
  invitePartnerIds: z.array(z.number().int().positive()).optional(),
});

function toData(input: z.infer<typeof eventInput>) {
  return {
    title: input.title,
    event_type: input.eventType,
    description: input.description ?? null,
    event_date: new Date(`${input.eventDate}T00:00:00.000Z`),
    start_time: timeToDate(input.startTime),
    end_time: timeToDate(input.endTime),
    location: input.isVirtual ? null : (input.location ?? null),
    is_virtual: input.isVirtual ? 1 : 0,
    meeting_url: input.isVirtual ? (input.meetingUrl ?? null) : null,
    max_attendees: input.maxAttendees ?? null,
    organizer: input.organizer ?? null,
    agenda: input.agenda ?? null,
    actual_attendance: input.actualAttendance ?? null,
    is_active: input.isActive ? 1 : 0,
    creative_url: input.creativeUrl ?? null,
    registration_url: input.registrationUrl ?? null,
    audience: input.audience === "all" ? EventAudience.ALL : EventAudience.SELECTED,
    share_partners: input.sharePartners ? 1 : 0,
  };
}

// Sync invited partners for an event. Keeps existing rows (and their RSVP
// status) for still-invited partners; removes those no longer selected.
async function syncInvites(eventId: number, partnerIds: number[] | undefined) {
  if (partnerIds === undefined) return;
  await db.event_registration.deleteMany({
    where: {
      event_id: eventId,
      user_id: { notIn: partnerIds.length > 0 ? partnerIds : [-1] },
    },
  });
  if (partnerIds.length === 0) return;
  const existing = await db.event_registration.findMany({
    where: { event_id: eventId },
    select: { user_id: true },
  });
  const have = new Set(existing.map((e) => e.user_id));
  const toAdd = partnerIds.filter((id) => !have.has(id));
  if (toAdd.length > 0) {
    await db.event_registration.createMany({
      data: toAdd.map((uid) => ({
        event_id: eventId,
        user_id: uid,
        status: EventRegistrationStatus.INVITED,
      })),
    });
  }
}

// "Show on partner dashboard": one EVENT slide per event, switched on/off.
async function syncEventBanner(eventId: number, on: boolean | undefined, cpUserId: number) {
  if (on === undefined) return;
  const slide = await db.partner_banner.findFirst({
    where: { event_id: eventId, kind: BannerKind.EVENT },
    orderBy: { id: "asc" },
    select: { id: true, is_active: true },
  });
  if (on && !slide) {
    await db.partner_banner.create({
      data: { kind: BannerKind.EVENT, event_id: eventId, created_by_cp_user_id: cpUserId },
    });
  } else if (slide && slide.is_active !== (on ? 1 : 0)) {
    await db.partner_banner.update({
      where: { id: slide.id },
      data: { is_active: on ? 1 : 0, updated_at: new Date() },
    });
  }
}

// Partner-facing event fields (the events list and the event page).
const partnerEventSelect = {
  id: true,
  title: true,
  event_type: true,
  description: true,
  event_date: true,
  start_time: true,
  end_time: true,
  location: true,
  is_virtual: true,
  meeting_url: true,
  max_attendees: true,
  organizer: true,
  agenda: true,
  creative_url: true,
  registration_url: true,
} as const;

function partnerEvent(
  e: {
    id: number;
    title: string;
    event_type: number;
    description: string | null;
    event_date: Date;
    start_time: Date | null;
    end_time: Date | null;
    location: string | null;
    is_virtual: number;
    meeting_url: string | null;
    max_attendees: number | null;
    organizer: string | null;
    agenda: string | null;
    creative_url: string | null;
    registration_url: string | null;
  },
  rsvpStatus: number | null,
) {
  return {
    id: e.id,
    title: e.title,
    eventType: e.event_type,
    description: e.description,
    eventDate: e.event_date.toISOString().slice(0, 10),
    startTime: dateToTime(e.start_time),
    endTime: dateToTime(e.end_time),
    location: e.location,
    isVirtual: e.is_virtual === 1,
    meetingUrl: e.meeting_url,
    maxAttendees: e.max_attendees,
    organizer: e.organizer,
    agenda: e.agenda,
    creativeUrl: resolveStorageUrl(e.creative_url),
    creativeIsPdf: isPdfUrl(e.creative_url),
    registrationUrl: e.registration_url,
    rsvpStatus,
  };
}

const bannerInput = z.object({
  id: z.number().int().positive().optional(),
  kind: z.enum(["event", "info"]),
  eventId: z.number().int().positive().nullable().optional(),
  title: z.string().trim().max(150).nullable().optional(),
  summary: z.string().trim().max(300).nullable().optional(),
  details: z.string().trim().max(5000).nullable().optional(),
  linkUrl: webUrl.nullable().optional(),
  linkLabel: z.string().trim().max(60).nullable().optional(),
  imageUrl: uploadedUrl.nullable().optional(),
  displayFrom: z.string().regex(DATE_KEY).nullable().optional(),
  displayTo: z.string().regex(DATE_KEY).nullable().optional(),
  sortOrder: z.number().int().min(-1000).max(1000),
  isActive: z.boolean(),
});
const dbDate = (k: string | null | undefined) => (k ? new Date(`${k}T00:00:00.000Z`) : null);
const blank = (v: string | null | undefined) => (v && v.trim() !== "" ? v.trim() : null);

export const eventsRouter = createTRPCRouter({
  list: protectedAdminProcedure.query(async () => {
    const rows = await db.event.findMany({
      orderBy: { event_date: "desc" },
      select: {
        id: true,
        title: true,
        event_type: true,
        description: true,
        event_date: true,
        start_time: true,
        end_time: true,
        location: true,
        is_virtual: true,
        meeting_url: true,
        max_attendees: true,
        organizer: true,
        agenda: true,
        actual_attendance: true,
        is_active: true,
        creative_url: true,
        registration_url: true,
        audience: true,
        share_partners: true,
        _count: { select: { event_share: true } },
        partner_banner: {
          where: { kind: BannerKind.EVENT, is_active: 1 },
          select: { id: true },
          take: 1,
        },
      },
    });

    // Invited partners per event (from event_registration).
    const ids = rows.map((e) => e.id);
    const regs =
      ids.length > 0
        ? await db.event_registration.findMany({
            where: { event_id: { in: ids } },
            select: {
              event_id: true,
              status: true,
              user: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  organization: { select: { name: true } },
                },
              },
            },
          })
        : [];
    const byEvent = new Map<
      number,
      { userId: number; name: string; status: number }[]
    >();
    for (const r of regs) {
      const name =
        r.user.organization?.name ??
        `${r.user.first_name} ${r.user.last_name}`.trim();
      const arr = byEvent.get(r.event_id) ?? [];
      arr.push({ userId: r.user.id, name, status: r.status });
      byEvent.set(r.event_id, arr);
    }

    return rows.map((e) => {
      const invited = byEvent.get(e.id) ?? [];
      return {
        id: e.id,
        title: e.title,
        eventType: e.event_type,
        description: e.description,
        eventDate: e.event_date.toISOString().slice(0, 10),
        startTime: dateToTime(e.start_time),
        endTime: dateToTime(e.end_time),
        location: e.location,
        isVirtual: e.is_virtual === 1,
        meetingUrl: e.meeting_url,
        maxAttendees: e.max_attendees,
        organizer: e.organizer,
        agenda: e.agenda,
        actualAttendance: e.actual_attendance,
        isActive: e.is_active === 1,
        creativeUrl: resolveStorageUrl(e.creative_url),
        creativeRef: e.creative_url,
        creativeIsPdf: isPdfUrl(e.creative_url),
        registrationUrl: e.registration_url,
        audience: e.audience === EventAudience.ALL ? ("all" as const) : ("selected" as const),
        sharePartners: e.share_partners === 1,
        sharedCount: e._count.event_share,
        onDashboard: e.partner_banner.length > 0,
        invitedPartners: invited,
        partnersInvited: invited.length,
        rsvpsAccepted: invited.filter((i) => ACCEPTED_RSVP.includes(i.status))
          .length,
      };
    });
  }),

  // Every approved partner user who can be invited: agency owners (shown by
  // agency name), their agency counsellors, and independent counsellors.
  // Only owners were listed before (16 Nov: "not all counsellors are shown").
  partnersForInvite: protectedAdminProcedure.query(async () => {
    const users = await db.user.findMany({
      where: {
        status: UserStatus.APPROVED,
        deleted_at: null,
        type: {
          in: [UserType.AGENCY_OWNER, UserType.AGENCY_COUNSELLOR, UserType.INDEPENDENT_COUNSELLOR],
        },
      },
      select: {
        id: true,
        type: true,
        first_name: true,
        last_name: true,
        organization: { select: { name: true } },
      },
    });
    const kindOf = (t: number) =>
      t === UserType.AGENCY_OWNER
        ? ("owner" as const)
        : t === UserType.AGENCY_COUNSELLOR
          ? ("agencyCounsellor" as const)
          : ("independent" as const);
    return users
      .map((u) => {
        const person = `${u.first_name} ${u.last_name}`.trim();
        const org = u.organization?.name ?? null;
        const kind = kindOf(u.type);
        return {
          userId: u.id,
          kind,
          // Owner: the agency; agency counsellor: person + agency; independent: person.
          name: kind === "owner" ? (org ?? person) : person,
          detail: kind === "owner" ? person : kind === "agencyCounsellor" ? org : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }),

  create: protectedAdminProcedure
    .input(eventInput)
    .mutation(async ({ ctx, input }) => {
      const ev = await db.event.create({
        data: toData(input),
        select: { id: true },
      });
      await syncInvites(ev.id, input.audience === "selected" ? input.invitePartnerIds : undefined);
      await syncEventBanner(ev.id, input.showOnDashboard, ctx.cpUser.id);
      const shared = await shareEvent(ev.id);
      await db.audit_log.create({
        data: {
          action: "event.created",
          entity_type: "event",
          entity_id: ev.id,
          metadata: { byCpUserId: ctx.cpUser.id, notified: shared.notified },
        },
      });
      return { id: ev.id, notified: shared.notified, updatesSent: 0 };
    }),

  update: protectedAdminProcedure
    .input(eventInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const before = await db.event.findUnique({
        where: { id: input.id },
        select: {
          event_date: true,
          start_time: true,
          end_time: true,
          is_virtual: true,
          location: true,
          meeting_url: true,
        },
      });
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      const data = toData(input);
      // A change of date, time, place or link re-issues the calendar invite.
      const changed = materialSnapshot(before) !== materialSnapshot(data);
      await db.event.update({
        where: { id: input.id },
        data: {
          ...data,
          ...(changed ? { ics_sequence: { increment: 1 } } : {}),
          updated_at: new Date(),
        },
      });
      await syncInvites(input.id, input.audience === "selected" ? input.invitePartnerIds : undefined);
      await syncEventBanner(input.id, input.showOnDashboard, ctx.cpUser.id);
      const shared = await shareEvent(input.id);
      const updatesSent = changed ? await announceEventUpdate(input.id, shared.batch) : 0;
      await db.audit_log.create({
        data: {
          action: "event.updated",
          entity_type: "event",
          entity_id: input.id,
          metadata: { byCpUserId: ctx.cpUser.id, notified: shared.notified, updatesSent },
        },
      });
      return { id: input.id, notified: shared.notified, updatesSent };
    }),

  delete: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // event_registration, event_share and the event's banner slides cascade.
      await db.event.delete({ where: { id: input.id } });
      await db.audit_log.create({
        data: {
          action: "event.deleted",
          entity_type: "event",
          entity_id: input.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { success: true as const };
    }),

  // ---- Partner dashboard banner (Events → Dashboard banners) --------------

  bannerList: protectedAdminProcedure.query(async () => {
    const [rows, secs] = await Promise.all([
      db.partner_banner.findMany({
        orderBy: [{ sort_order: "asc" }, { id: "asc" }],
        select: bannerSelect,
      }),
      rotateSeconds(),
    ]);
    return {
      rotateSeconds: secs,
      slides: rows.map((b) => ({
        id: b.id,
        kind: b.kind === BannerKind.EVENT ? ("event" as const) : ("info" as const),
        eventId: b.event_id,
        eventTitle: b.event?.title ?? null,
        eventDate: b.event ? b.event.event_date.toISOString().slice(0, 10) : null,
        title: b.title,
        summary: b.summary,
        details: b.details,
        linkUrl: b.link_url,
        linkLabel: b.link_label,
        imageRef: b.image_url,
        imageUrl: resolveStorageUrl(b.image_url),
        displayFrom: b.display_from ? b.display_from.toISOString().slice(0, 10) : null,
        displayTo: b.display_to ? b.display_to.toISOString().slice(0, 10) : null,
        sortOrder: b.sort_order,
        isActive: b.is_active === 1,
        status: bannerStatus(b),
        preview: toSlide(b),
      })),
    };
  }),

  bannerSave: protectedAdminProcedure.input(bannerInput).mutation(async ({ ctx, input }) => {
    const eventId = input.kind === "event" ? (input.eventId ?? null) : null;
    if (input.kind === "event" && eventId === null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the event this slide is for." });
    }
    if (input.kind === "info" && !blank(input.title)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "An information slide needs a title." });
    }
    if (input.displayFrom && input.displayTo && input.displayTo < input.displayFrom) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "“Show until” is before “Show from”." });
    }
    if (eventId !== null) {
      const ev = await db.event.findUnique({ where: { id: eventId }, select: { id: true } });
      if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
    }
    const info = input.kind === "info";
    const data = {
      kind: info ? BannerKind.INFO : BannerKind.EVENT,
      event_id: eventId,
      title: blank(input.title),
      summary: blank(input.summary),
      details: info ? blank(input.details) : null,
      link_url: info ? (input.linkUrl ?? null) : null,
      link_label: info ? blank(input.linkLabel) : null,
      image_url: input.imageUrl ?? null,
      display_from: dbDate(input.displayFrom),
      display_to: dbDate(input.displayTo),
      sort_order: input.sortOrder,
      is_active: input.isActive ? 1 : 0,
    };
    const saved = input.id
      ? await db.partner_banner.update({
          where: { id: input.id },
          data: { ...data, updated_at: new Date() },
          select: { id: true },
        })
      : await db.partner_banner.create({
          data: { ...data, created_by_cp_user_id: ctx.cpUser.id },
          select: { id: true },
        });
    await db.audit_log.create({
      data: {
        action: input.id ? "partner_banner.updated" : "partner_banner.created",
        entity_type: "partner_banner",
        entity_id: saved.id,
        metadata: { byCpUserId: ctx.cpUser.id, kind: input.kind },
      },
    });
    return { id: saved.id };
  }),

  bannerDelete: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db.partner_banner.delete({ where: { id: input.id } });
      await db.audit_log.create({
        data: {
          action: "partner_banner.deleted",
          entity_type: "partner_banner",
          entity_id: input.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { success: true as const };
    }),

  bannerSetRotation: protectedAdminProcedure
    .input(z.object({ seconds: z.number().int().min(ROTATE_MIN).max(ROTATE_MAX) }))
    .mutation(async ({ ctx, input }) => {
      await db.system_config.upsert({
        where: { config_key: ROTATE_KEY },
        create: { config_key: ROTATE_KEY, value: JSON.stringify(input.seconds) },
        update: { value: JSON.stringify(input.seconds) },
      });
      await db.audit_log.create({
        data: {
          action: "partner_banner.rotation_set",
          entity_type: "system_config",
          metadata: { byCpUserId: ctx.cpUser.id, seconds: input.seconds },
        },
      });
      return { seconds: input.seconds };
    }),

  // ---- Partner portal ------------------------------------------------------

  // Published events this partner may see (for everyone, or invited), with
  // their own RSVP status.
  forPartners: protectedPartnerProcedure.query(async ({ ctx }) => {
    const rows = await db.event.findMany({
      where: eventVisibleTo(ctx.cpPartner.id),
      orderBy: { event_date: "desc" },
      select: partnerEventSelect,
    });
    const ids = rows.map((e) => e.id);
    const myRegs =
      ids.length > 0
        ? await db.event_registration.findMany({
            where: { user_id: ctx.cpPartner.id, event_id: { in: ids } },
            select: { event_id: true, status: true },
          })
        : [];
    const myStatus = new Map(myRegs.map((r) => [r.event_id, r.status]));
    return rows.map((e) => partnerEvent(e, myStatus.get(e.id) ?? null));
  }),

  // One event's page: banner, email and bell links all land here.
  partnerGet: protectedPartnerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const e = await db.event.findFirst({
        where: { id: input.id, ...eventVisibleTo(ctx.cpPartner.id) },
        select: partnerEventSelect,
      });
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "This event isn't available." });
      const reg = await db.event_registration.findFirst({
        where: { event_id: e.id, user_id: ctx.cpPartner.id },
        select: { status: true },
      });
      return partnerEvent(e, reg?.status ?? null);
    }),

  // The partner dashboard banner: this user's slides + the rotation interval.
  // Part of the dashboard, not the Events tab; event slides are left out for
  // partners whose Events tab is off (src/server/partner-banners.ts).
  partnerBanner: protectedPartnerProcedure.query(async ({ ctx }) => {
    const me = await db.user.findUnique({
      where: { id: ctx.cpPartner.id },
      select: { id: true, type: true },
    });
    const [slides, secs] = await Promise.all([me ? slidesFor(me) : [], rotateSeconds()]);
    return { slides, rotateSeconds: secs };
  }),

  // Partner accepts/declines an invite (or self-RSVPs to an event for everyone).
  rsvp: protectedPartnerProcedure
    .input(
      z.object({
        eventId: z.number().int().positive(),
        status: z.enum(["accepted", "declined"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const visible = await db.event.findFirst({
        where: { id: input.eventId, ...eventVisibleTo(ctx.cpPartner.id) },
        select: { id: true },
      });
      if (!visible) {
        throw new TRPCError({ code: "NOT_FOUND", message: "This event isn't available." });
      }
      const status =
        input.status === "accepted"
          ? EventRegistrationStatus.ACCEPTED
          : EventRegistrationStatus.DECLINED;
      const existing = await db.event_registration.findFirst({
        where: { event_id: input.eventId, user_id: ctx.cpPartner.id },
        select: { id: true },
      });
      if (existing) {
        await db.event_registration.update({
          where: { id: existing.id },
          data: { status },
        });
      } else {
        await db.event_registration.create({
          data: { event_id: input.eventId, user_id: ctx.cpPartner.id, status },
        });
      }
      return { success: true as const };
    }),
});
