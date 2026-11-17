import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "~/server/db";
import { createNotifications } from "~/server/notify";
import {
  appUrl,
  emailFromAddress,
  partnerEventCancelledEmail,
  partnerEventEmail,
  sendEmail,
} from "~/server/email";
import { buildIcs, emailAddress } from "~/server/ics";
import { EventAudience, UserStatus, UserType } from "~/server/db/enums";
import { resolvePartnerTabs } from "~/lib/partner-tabs";
import type { Prisma } from "../../generated/prisma";

// Sharing events with partners (16 Nov 2026, Suraj's decisions).
//
//   Audience   event.audience: ALL approved partner users, or SELECTED (the
//              invite list in event_registration). Only partner users whose
//              Events tab is on count.
//   Visibility a partner sees a published event when it's for everyone or
//              they're on its invite list (eventVisibleTo).
//   Sharing    when a published event with share_partners on is saved, each
//              audience member not yet in event_share gets ONE bell
//              notification and ONE email (poster inline, details, a button to
//              the portal event page, an .ics invite). Past events are never
//              announced. event_share's unique (event, user) key is what makes
//              "never twice" hold, even for two saves at once.
//   Updates    a change of date, time, place or link on a shared event bumps
//              ics_sequence and emails everyone already told an "updated"
//              email with the new invite (no second bell).
//
// Emails go out after the save returns (one SES call each; an "all partners"
// event can mean hundreds), and email_sent_at / updated_sent_at record which
// went through.

export const PARTNER_USER_TYPES: number[] = [
  UserType.AGENCY_OWNER,
  UserType.AGENCY_COUNSELLOR,
  UserType.INDEPENDENT_COUNSELLOR,
];

const IST_OFFSET_MS = 330 * 60 * 1000;

// Today's date in India as YYYY-MM-DD, and as the UTC-midnight Date that a
// MySQL DATE column compares against.
export function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export function istTodayDate(): Date {
  return new Date(`${istToday()}T00:00:00.000Z`);
}

export const dateKey = (d: Date) => d.toISOString().slice(0, 10);
const hhmm = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : null);

// The events a partner user may see in the portal.
export function eventVisibleTo(userId: number): Prisma.eventWhereInput {
  return {
    is_active: 1,
    OR: [
      { audience: EventAudience.ALL },
      { event_registration: { some: { user_id: userId } } },
    ],
  };
}

const activePartner = {
  status: UserStatus.APPROVED,
  deleted_at: null,
  type: { in: PARTNER_USER_TYPES },
} satisfies Prisma.userWhereInput;

// Of these partner users, the ones whose Events tab is on (Tab Access: user
// override ?? type default ?? built-in), resolved in bulk.
async function withEventsTab(
  users: { id: number; type: number }[],
): Promise<number[]> {
  if (users.length === 0) return [];
  const [defaults, overrides] = await Promise.all([
    db.cp_tab_default.findMany({
      where: { portal: "partner", tab: "events" },
      select: { user_type: true, enabled: true },
    }),
    db.cp_tab_override.findMany({
      where: { user_id: { in: users.map((u) => u.id) }, tab: "events" },
      select: { user_id: true, enabled: true },
    }),
  ]);
  const typeOn = new Map(defaults.map((d) => [d.user_type, d.enabled === 1]));
  const userOn = new Map(overrides.map((o) => [o.user_id, o.enabled === 1]));
  return users
    .filter((u) => {
      const def = typeOn.get(u.type);
      const own = userOn.get(u.id);
      return resolvePartnerTabs(
        u.type,
        new Map(def === undefined ? [] : [["events", def]]),
        new Map(own === undefined ? [] : [["events", own]]),
      ).includes("events");
    })
    .map((u) => u.id);
}

// Everyone an event is for, right now.
export async function eventAudienceIds(
  eventId: number,
  audience: number,
): Promise<number[]> {
  const users =
    audience === EventAudience.ALL
      ? await db.user.findMany({
          where: activePartner,
          select: { id: true, type: true },
        })
      : (
          await db.event_registration.findMany({
            where: { event_id: eventId, user: activePartner },
            select: { user: { select: { id: true, type: true } } },
          })
        ).map((r) => r.user);
  const unique = Array.from(new Map(users.map((u) => [u.id, u])).values());
  return withEventsTab(unique);
}

// Whether a partner user can see the Events tab (and so event slides).
export async function hasEventsTab(user: {
  id: number;
  type: number;
}): Promise<boolean> {
  return (await withEventsTab([user])).length === 1;
}

type EventRow = NonNullable<Awaited<ReturnType<typeof loadEvent>>>;
function loadEvent(id: number) {
  return db.event.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      description: true,
      event_date: true,
      start_time: true,
      end_time: true,
      location: true,
      is_virtual: true,
      meeting_url: true,
      organizer: true,
      creative_url: true,
      registration_url: true,
      audience: true,
      share_partners: true,
      ics_sequence: true,
      is_active: true,
    },
  });
}

const shareable = (e: EventRow) =>
  e.is_active === 1 &&
  e.share_partners === 1 &&
  dateKey(e.event_date) >= istToday();

export const isPdfUrl = (url: string | null | undefined) =>
  !!url && /\.pdf(\?|#|$)/i.test(url);

function absoluteUrl(url: string): string {
  return /^https?:\/\//i.test(url)
    ? url
    : `${appUrl().replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

function time12(t: string): string {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

export function eventWhen(e: {
  event_date: Date;
  start_time: Date | null;
  end_time: Date | null;
}): {
  date: string;
  time: string | null;
} {
  const date = new Date(
    `${dateKey(e.event_date)}T00:00:00Z`,
  ).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const s = hhmm(e.start_time);
  const en = hhmm(e.end_time);
  const time = s ? `${time12(s)}${en ? ` – ${time12(en)}` : ""} IST` : null;
  return { date, time };
}

const eventPath = (id: number) => `/partner/events/${id}`;
const placeOf = (e: { is_virtual: number; location: string | null }) =>
  e.is_virtual === 1 ? "Online" : (e.location ?? null);

// Event times are wall-clock India time (stored as "HH:MM" in a TIME column).
function instant(day: string, t: Date | null): Date | null {
  const v = hhmm(t);
  return v ? new Date(`${day}T${v}:00+05:30`) : null;
}

function calendarFor(
  e: EventRow,
  attendee: { name: string; email: string },
  method: "REQUEST" | "CANCEL" = "REQUEST",
  sequence = e.ics_sequence,
): string {
  const day = dateKey(e.event_date);
  const start = instant(day, e.start_time);
  let end = instant(day, e.end_time);
  if (start && end && end <= start) end = null;
  const page = absoluteUrl(eventPath(e.id));
  const where =
    e.is_virtual === 1 ? (e.meeting_url ?? "Online") : (e.location ?? "");
  return buildIcs(method, {
    uid: `partner-event-${e.id}@collegepond.com`,
    sequence,
    date: day,
    start,
    end,
    location: where || null,
    summary: e.title,
    description: [e.description ?? "", `Event page: ${page}`]
      .filter(Boolean)
      .join("\n\n"),
    url: page,
    organizer: emailAddress(emailFromAddress()),
    attendee,
  });
}

async function sendEventEmails(
  e: EventRow,
  shares: { id: number; user_id: number }[],
  updated: boolean,
) {
  if (shares.length === 0) return;
  const users = await db.user.findMany({
    where: { id: { in: shares.map((s) => s.user_id) } },
    select: { id: true, email: true, first_name: true, last_name: true },
  });
  const byUser = new Map(users.map((u) => [u.id, u]));
  const { date, time } = eventWhen(e);
  const place = placeOf(e);
  const lines = [
    `Date: ${date}`,
    ...(time ? [`Time: ${time}`] : []),
    ...(place ? [`Where: ${place}`] : []),
    ...(e.organizer ? [`Organiser: ${e.organizer}`] : []),
  ];
  const poster = e.creative_url ? absoluteUrl(e.creative_url) : null;
  for (const s of shares) {
    const u = byUser.get(s.user_id);
    if (!u?.email) continue;
    const name = `${u.first_name} ${u.last_name}`.trim();
    try {
      const msg = partnerEventEmail(
        { name: u.first_name },
        {
          title: e.title,
          lines,
          description: e.description,
          posterUrl: poster && !isPdfUrl(poster) ? poster : null,
          posterPdfUrl: poster && isPdfUrl(poster) ? poster : null,
          eventPath: eventPath(e.id),
          registrationUrl: e.registration_url,
          updated,
        },
        appUrl(),
      );
      await sendEmail(u.email, msg, {
        calendar: {
          method: "REQUEST",
          ics: calendarFor(e, { name, email: u.email }),
          fileName: "event.ics",
        },
      });
      await db.event_share.update({
        where: { id: s.id },
        data: updated
          ? { updated_sent_at: new Date() }
          : { email_sent_at: new Date() },
      });
    } catch (err) {
      // The share id, never the address, so a failure can be traced.
      console.error(
        `[event-share] email failed for event ${e.id}, share ${s.id}:`,
        err,
      );
    }
  }
}

// Announce a saved event to everyone in its audience who hasn't been told.
// Returns the share batch (to tell this save's new recipients apart) and how
// many were notified.
export async function shareEvent(
  eventId: number,
): Promise<{ batch: string | null; notified: number }> {
  const e = await loadEvent(eventId);
  if (!e || !shareable(e)) return { batch: null, notified: 0 };
  const audience = await eventAudienceIds(e.id, e.audience);
  const told = new Set(
    (
      await db.event_share.findMany({
        where: { event_id: e.id },
        select: { user_id: true },
      })
    ).map((s) => s.user_id),
  );
  const fresh = audience.filter((id) => !told.has(id));
  if (fresh.length === 0) return { batch: null, notified: 0 };

  const batch = randomBytes(8).toString("hex");
  await db.event_share.createMany({
    data: fresh.map((user_id) => ({
      event_id: e.id,
      user_id,
      share_batch: batch,
    })),
    skipDuplicates: true,
  });
  // Exactly the rows this save inserted: a concurrent save's rows carry its
  // own batch, and rows that already existed were skipped.
  const mine = await db.event_share.findMany({
    where: { event_id: e.id, share_batch: batch },
    select: { id: true, user_id: true },
  });
  const { date, time } = eventWhen(e);
  const place = placeOf(e);
  await createNotifications(
    mine.map((m) => m.user_id),
    {
      type: "event.invite",
      title: `New event: ${e.title}`,
      body: [date, time, place].filter(Boolean).join(" · "),
      link: eventPath(e.id),
      tone: "blue",
    },
  );
  void sendEventEmails(e, mine, false).catch((err) =>
    console.error("[event-share] send failed:", err),
  );
  return { batch, notified: mine.length };
}

// After a change of date, time, place or link: everyone already told (except
// this save's new recipients, whose email already has the new details) gets
// an "updated" email and the re-issued invite. Call after bumping ics_sequence.
export async function announceEventUpdate(
  eventId: number,
  skipBatch: string | null,
): Promise<number> {
  const e = await loadEvent(eventId);
  if (!e || !shareable(e)) return 0;
  const shares = await db.event_share.findMany({
    where: {
      event_id: e.id,
      ...(skipBatch ? { share_batch: { not: skipBatch } } : {}),
    },
    select: { id: true, user_id: true },
  });
  void sendEventEmails(e, shares, true).catch((err) =>
    console.error("[event-share] update failed:", err),
  );
  return shares.length;
}

// Cancel a shared event for some (or all) of the partners already told about
// it: deleted, unpublished, or taken off the invite list (16 Nov follow-up).
// Each gets a "cancelled" email whose .ics CANCEL (same UID, a higher
// SEQUENCE) removes the invite from their calendar, and their event_share row
// is removed so a later re-publish or re-invite announces it afresh. Past
// events are left alone. Call BEFORE deleting the event (shares cascade).
// Returns how many were cancelled; the emails go out after the call returns.
export async function cancelEventShares(
  eventId: number,
  userIds?: number[],
): Promise<number> {
  if (userIds?.length === 0) return 0;
  const e = await loadEvent(eventId);
  if (!e || dateKey(e.event_date) < istToday()) return 0;
  const shares = await db.event_share.findMany({
    where: { event_id: e.id, ...(userIds ? { user_id: { in: userIds } } : {}) },
    select: { id: true, user_id: true, email_sent_at: true },
  });
  if (shares.length === 0) return 0;
  // A higher SEQUENCE than any invite sent; a later re-invite goes higher still.
  const sequence = e.ics_sequence + 1;
  await db.event.update({ where: { id: e.id }, data: { ics_sequence: sequence } });
  await db.event_share.deleteMany({ where: { id: { in: shares.map((s) => s.id) } } });
  // Only people whose invite email actually went out have it in a calendar.
  const toEmail = shares.filter((s) => s.email_sent_at != null).map((s) => s.user_id);
  void sendCancelEmails(e, sequence, toEmail).catch((err) =>
    console.error("[event-share] cancel failed:", err),
  );
  return shares.length;
}

async function sendCancelEmails(e: EventRow, sequence: number, userIds: number[]) {
  if (userIds.length === 0) return;
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, first_name: true, last_name: true },
  });
  const { date, time } = eventWhen(e);
  const place = placeOf(e);
  const lines = [`Date: ${date}`, ...(time ? [`Time: ${time}`] : []), ...(place ? [`Where: ${place}`] : [])];
  for (const u of users) {
    if (!u.email) continue;
    try {
      await sendEmail(u.email, partnerEventCancelledEmail({ name: u.first_name }, { title: e.title, lines }), {
        calendar: {
          method: "CANCEL",
          ics: calendarFor(e, { name: `${u.first_name} ${u.last_name}`.trim(), email: u.email }, "CANCEL", sequence),
          fileName: "event.ics",
        },
      });
    } catch (err) {
      // The user id, never the address, so a failure can be traced.
      console.error(`[event-share] cancel email failed for event ${e.id}, user ${u.id}:`, err);
    }
  }
}

// The fields whose change makes an "updated" email.
export function materialSnapshot(e: {
  event_date: Date;
  start_time: Date | null;
  end_time: Date | null;
  is_virtual: number;
  location: string | null;
  meeting_url: string | null;
}): string {
  return JSON.stringify([
    dateKey(e.event_date),
    hhmm(e.start_time),
    hhmm(e.end_time),
    e.is_virtual,
    e.location ?? "",
    e.meeting_url ?? "",
  ]);
}
