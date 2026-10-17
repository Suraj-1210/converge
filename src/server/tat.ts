import "server-only";
import { db } from "~/server/db";
import { type TatTarget, tatStatus } from "~/lib/tat";

// Business-hours TAT, configured in Settings -> TAT Settings (Super Admin).
// Decided with Suraj, 17 Oct 2026: Mon–Sat 10:00–19:00 IST, holidays
// excluded. Each TAT action (first: "chat_response", Collegepond replying
// in partner chat) has a target in business minutes and a warning percentage.
// Any future TAT action should measure time through here.

export interface TatConfig {
  timezone: string;
  workDays: number[]; // ISO weekdays, 1 = Monday … 7 = Sunday
  dayStartMinute: number;
  dayEndMinute: number;
  holidays: Set<string>; // "YYYY-MM-DD" in the TAT timezone
}

export const DEFAULT_TAT_CONFIG: Omit<TatConfig, "holidays"> = {
  timezone: "Asia/Kolkata",
  workDays: [1, 2, 3, 4, 5, 6],
  dayStartMinute: 600,
  dayEndMinute: 1140,
};

export const CHAT_RESPONSE = "chat_response";

const CACHE_MS = 30_000;
let cache: { at: number; config: TatConfig; targets: Map<string, TatTarget> } | null = null;

export function invalidateTatCache() {
  cache = null;
}

export function parseWorkDays(s: string): number[] {
  return [...new Set(s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort();
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function load() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [row, holidays, targets] = await Promise.all([
    db.tat_setting.findUnique({ where: { id: 1 } }),
    db.tat_holiday.findMany({ select: { holiday_date: true } }),
    db.tat_action_target.findMany(),
  ]);
  const timezone = row && isValidTimezone(row.timezone) ? row.timezone : DEFAULT_TAT_CONFIG.timezone;
  const config: TatConfig = {
    timezone,
    workDays: row ? parseWorkDays(row.work_days) : DEFAULT_TAT_CONFIG.workDays,
    dayStartMinute: row?.day_start_minute ?? DEFAULT_TAT_CONFIG.dayStartMinute,
    dayEndMinute: row?.day_end_minute ?? DEFAULT_TAT_CONFIG.dayEndMinute,
    // DATE columns come back as UTC midnight of that calendar date.
    holidays: new Set(holidays.map((h) => h.holiday_date.toISOString().slice(0, 10))),
  };
  cache = {
    at: Date.now(),
    config,
    targets: new Map(
      targets.map((t) => [
        t.action_key,
        { key: t.action_key, label: t.label, thresholdMinutes: t.threshold_minutes, warningPct: t.warning_pct, active: t.active === 1 },
      ]),
    ),
  };
  return cache;
}

export async function getTatConfig(): Promise<TatConfig> {
  return (await load()).config;
}

// The target for an action, or null if it's missing or switched off (then
// nothing is measured against it: no warnings, no breaches).
export async function getTatTarget(key: string): Promise<TatTarget | null> {
  const t = (await load()).targets.get(key);
  return t?.active ? t : null;
}

// ---- Business-time arithmetic ------------------------------------------------

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Long enough for any real wait; bounds the loops if hours are misconfigured.
const MAX_DAYS = 400;

// Minutes the timezone is ahead of UTC at this instant.
function offsetMinutes(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / MIN);
}

// A calendar date in the TAT timezone, as UTC-midnight millis of that date
// (used only as a day counter and for its weekday and YYYY-MM-DD).
function localDate(at: number, tz: string): number {
  const shifted = at + offsetMinutes(at, tz) * MIN;
  return Math.floor(shifted / DAY) * DAY;
}

// The real instant of minute `m` of that local day.
function instantOf(day: number, m: number, tz: string): number {
  const guess = day + m * MIN;
  const first = guess - offsetMinutes(guess, tz) * MIN;
  return guess - offsetMinutes(first, tz) * MIN;
}

function workingWindow(day: number, c: TatConfig): [number, number] | null {
  const dow = new Date(day).getUTCDay();
  const iso = dow === 0 ? 7 : dow;
  if (!c.workDays.includes(iso)) return null;
  if (c.holidays.has(new Date(day).toISOString().slice(0, 10))) return null;
  if (c.dayEndMinute <= c.dayStartMinute) return null;
  return [instantOf(day, c.dayStartMinute, c.timezone), instantOf(day, c.dayEndMinute, c.timezone)];
}

// Working minutes between two instants (0 if end <= start).
export function businessMinutesBetween(start: Date, end: Date, c: TatConfig): number {
  const s = start.getTime();
  const e = end.getTime();
  if (e <= s) return 0;
  let total = 0;
  const last = localDate(e, c.timezone);
  for (let day = localDate(s, c.timezone), i = 0; day <= last && i < MAX_DAYS; day += DAY, i++) {
    const w = workingWindow(day, c);
    if (!w) continue;
    const from = Math.max(s, w[0]);
    const to = Math.min(e, w[1]);
    if (to > from) total += to - from;
  }
  return Math.floor(total / MIN);
}

// The instant `minutes` working minutes after `start`, or null if the
// configuration has no working time in reach.
export function addBusinessMinutes(start: Date, minutes: number, c: TatConfig): Date | null {
  let left = minutes * MIN;
  const s = start.getTime();
  for (let day = localDate(s, c.timezone), i = 0; i < MAX_DAYS; day += DAY, i++) {
    const w = workingWindow(day, c);
    if (!w) continue;
    const from = Math.max(s, w[0]);
    if (w[1] <= from) continue;
    if (w[1] - from >= left) return new Date(from + left);
    left -= w[1] - from;
  }
  return null;
}

// Where a wait that began at `since` stands now against a target.
export function tatClock(since: Date, now: Date, target: TatTarget, c: TatConfig) {
  const elapsed = businessMinutesBetween(since, now, c);
  return {
    elapsedMinutes: elapsed,
    remainingMinutes: target.thresholdMinutes - elapsed,
    status: tatStatus(elapsed, target),
    dueAt: addBusinessMinutes(since, target.thresholdMinutes, c),
  };
}
