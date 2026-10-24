import "server-only";
import { db } from "~/server/db";
import { getTatConfig } from "~/server/tat";

// Out of office for Collegepond counsellors (decided with Suraj, 24 Oct
// 2026). A counsellor (or their Counselling Lead, or a Super Admin) sets From
// and To dates and an alternate from their team. While the counsellor is out
// the alternate gets, automatically:
//   - their students' partner chats: the alternate can open and reply to
//     them (staffStudentScope), and unread-message emails, bell items and
//     in-app notifications go to the alternate (partner-chat.ts);
//   - the chat reply TAT: "awaiting your reply", warnings, and the reply's
//     TAT attribution (tat_counsellor_cp_user_id) are the alternate's;
//   - new auto-assigned students (autoAssignStudents).
// Partners see "<Name> is out of office <dates>. Contact <Alternate>" on
// their dashboard and in the student's chat.
//
// The dates are inclusive calendar days in the TAT timezone (IST). Nothing is
// switched off at the end: "out" is worked out from the dates on every read,
// so it ends by itself after the To date. If the alternate is out too, their
// own alternate covers (up to a few hops; a loop stops at the last person
// in it who isn't out).
//
// This module only answers "who is out, and who covers them". Who may set
// it is in routers/out-of-office.ts.

export type OooPeriod = {
  cpUserId: number;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  alternateId: number;
};

const CACHE_MS = 30_000;
const MAX_HOPS = 4;
let cache: { at: number; today: string; active: Map<number, OooPeriod> } | null = null;

export function invalidateOutOfOfficeCache() {
  cache = null;
}

// Today's date in a timezone, as YYYY-MM-DD.
export function dateInTimezone(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export async function oooToday(now = new Date()): Promise<string> {
  return dateInTimezone(now, (await getTatConfig()).timezone);
}

// DATE columns come back as UTC midnight of that calendar date.
export const dateKey = (d: Date) => d.toISOString().slice(0, 10);

// Everyone out of office today whose alternate is an active account.
async function load(now = new Date()) {
  const today = await oooToday(now);
  if (cache?.today === today && Date.now() - cache.at < CACHE_MS) return cache;
  const day = new Date(`${today}T00:00:00Z`);
  const rows = await db.cp_out_of_office.findMany({
    where: { from_date: { lte: day }, to_date: { gte: day }, alternate: { status: 1 } },
    select: { cp_user_id: true, from_date: true, to_date: true, alternate_cp_user_id: true },
  });
  cache = {
    at: Date.now(),
    today,
    active: new Map(
      rows.map((r) => [
        r.cp_user_id,
        { cpUserId: r.cp_user_id, from: dateKey(r.from_date), to: dateKey(r.to_date), alternateId: r.alternate_cp_user_id },
      ]),
    ),
  };
  return cache;
}

export async function activeOutOfOffice(): Promise<Map<number, OooPeriod>> {
  return (await load()).active;
}

function follow(active: Map<number, OooPeriod>, id: number): number {
  let cur = id;
  const seen = new Set<number>([cur]);
  for (let i = 0; i < MAX_HOPS; i++) {
    const p = active.get(cur);
    if (!p || seen.has(p.alternateId)) break;
    cur = p.alternateId;
    seen.add(cur);
  }
  return cur;
}

// Who acts for this counsellor today: their alternate (or the alternate's
// alternate …) while they're out, otherwise themselves.
export async function responderFor(cpUserId: number): Promise<number>;
export async function responderFor(cpUserId: number | null): Promise<number | null>;
export async function responderFor(cpUserId: number | null): Promise<number | null> {
  if (cpUserId === null) return null;
  const active = await activeOutOfOffice();
  return active.size ? follow(active, cpUserId) : cpUserId;
}

// The counsellors this person is covering today (directly or down a chain).
export async function coveredCounsellorIds(cpUserId: number): Promise<number[]> {
  const active = await activeOutOfOffice();
  if (active.size === 0) return [];
  return [...active.keys()].filter((id) => id !== cpUserId && follow(active, id) === cpUserId);
}

// "24 Oct – 28 Oct 2026" / "24 Oct 2026".
export function formatOooDates(from: string, to: string): string {
  const fmt = (s: string, year: boolean) =>
    new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(year ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  if (from === to) return fmt(from, true);
  return `${fmt(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmt(to, true)}`;
}

const personSelect = { id: true, first_name: true, last_name: true, email: true, phone: true } as const;
const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();

export type OooNotice = {
  cpUserId: number;
  name: string;
  from: string;
  to: string;
  dates: string;
  alternate: { id: number; name: string; email: string; phone: string };
};

// Out-of-office notices for these staff (only those out today), with the
// person who covers them, for partner-facing screens.
export async function oooNotices(cpUserIds: (number | null | undefined)[]): Promise<OooNotice[]> {
  const ids = [...new Set(cpUserIds.filter((x): x is number => typeof x === "number"))];
  if (ids.length === 0) return [];
  const active = await activeOutOfOffice();
  const out = ids.filter((id) => active.has(id));
  if (out.length === 0) return [];
  const responders = new Map(out.map((id) => [id, follow(active, id)]));
  const people = await db.collegepond_user.findMany({
    where: { id: { in: [...out, ...responders.values()] } },
    select: personSelect,
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  return out.flatMap((id) => {
    const p = byId.get(id);
    const alt = byId.get(responders.get(id)!);
    const period = active.get(id)!;
    if (!p || !alt || alt.id === id) return [];
    return [
      {
        cpUserId: id,
        name: fullName(p),
        from: period.from,
        to: period.to,
        dates: formatOooDates(period.from, period.to),
        alternate: { id: alt.id, name: fullName(alt), email: alt.email, phone: alt.phone },
      },
    ];
  });
}
