import { z } from "zod";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  EVENT_TYPE_CODES,
  EventRegistrationStatus,
  UserStatus,
  UserType,
  type EventType,
} from "~/server/db/enums";

// ---------------------------------------------------------------------------
// Events — admin CRUD over the `event` table. start/end_time are MySQL TIME
// columns serialized to "HH:MM" (UTC); event_date is a DATE exchanged as
// "YYYY-MM-DD" (UTC). is_active maps to Published(1)/Draft(0).
//
// Partner invites + RSVP ride on the existing event_registration table
// (event_id, user_id, status) — no new tables. user_id is the partner's
// owner user. status uses EventRegistrationStatus.
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
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

const eventInput = z.object({
  title: z.string().trim().min(1).max(255),
  eventType: z
    .number()
    .int()
    .refine((v) => EVENT_TYPE_CODES.includes(v as EventType), "Invalid type"),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
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
  // Owner user IDs to invite. undefined = leave invites unchanged.
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
        invitedPartners: invited,
        partnersInvited: invited.length,
        rsvpsAccepted: invited.filter((i) => ACCEPTED_RSVP.includes(i.status))
          .length,
      };
    });
  }),

  // Approved agency partners available to invite (owner user id + agency name).
  // Every approved partner user who can be invited: agency owners (shown by
  // agency name), their agency counsellors, and independent counsellors.
  // Only owners were listed before (16 Nov: "not all counsellors are shown").
  partnersForInvite: protectedAdminProcedure.query(async () => {
    const users = await db.user.findMany({
      where: {
        status: UserStatus.APPROVED,
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
      await syncInvites(ev.id, input.invitePartnerIds);
      await db.audit_log.create({
        data: {
          action: "event.created",
          entity_type: "event",
          entity_id: ev.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { id: ev.id };
    }),

  update: protectedAdminProcedure
    .input(eventInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db.event.update({
        where: { id: input.id },
        data: { ...toData(input), updated_at: new Date() },
      });
      await syncInvites(input.id, input.invitePartnerIds);
      await db.audit_log.create({
        data: {
          action: "event.updated",
          entity_type: "event",
          entity_id: input.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { id: input.id };
    }),

  delete: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // event_registration cascades on delete (FK onDelete: Cascade).
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

  // Published events visible to partners, with the partner's own RSVP status.
  forPartners: protectedPartnerProcedure.query(async ({ ctx }) => {
    const rows = await db.event.findMany({
      where: { is_active: 1 },
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
      },
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
    return rows.map((e) => ({
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
      rsvpStatus: myStatus.get(e.id) ?? null,
    }));
  }),

  // Partner accepts/declines an invite (or self-RSVPs to a published event).
  rsvp: protectedPartnerProcedure
    .input(
      z.object({
        eventId: z.number().int().positive(),
        status: z.enum(["accepted", "declined"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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
