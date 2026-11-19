import "server-only";
import { addDays } from "~/lib/follow-ups";
import { dateInTimezone } from "~/server/out-of-office";
import { getTatConfig, type TatConfig } from "~/server/tat";

// Working days for counsellor tasks and shortlist follow-ups (decided with
// Suraj, 19 Nov 2026): Monday to Friday, 10:00-19:00 IST, and the day closes
// at 7 PM. "Next working day" and "+3 working days" count these days. The TAT
// holidays (Settings -> TAT Settings) are skipped too. Partner chat TAT keeps
// its own Mon-Sat hours (src/server/tat.ts); this only borrows the timezone
// and the holiday list from it.

export const TASK_WORK_DAYS = [1, 2, 3, 4, 5];
export const TASK_DAY_START_MINUTE = 600; // 10:00
export const TASK_DAY_END_MINUTE = 1140; // 19:00, the day close

export async function taskWorkConfig(): Promise<TatConfig> {
  const tat = await getTatConfig();
  return {
    timezone: tat.timezone,
    workDays: TASK_WORK_DAYS,
    dayStartMinute: TASK_DAY_START_MINUTE,
    dayEndMinute: TASK_DAY_END_MINUTE,
    holidays: tat.holidays,
  };
}

const isoWeekday = (key: string) => {
  const d = new Date(`${key}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

export function isWorkingDay(key: string, c: TatConfig): boolean {
  return c.workDays.includes(isoWeekday(key)) && !c.holidays.has(key);
}

// The n-th working day after `key` (n >= 1). Bounded so a config with no
// working days can't loop forever.
export function addWorkingDays(key: string, n: number, c: TatConfig): string {
  let cur = key;
  let left = Math.max(1, n);
  for (let i = 0; i < 400 && left > 0; i++) {
    cur = addDays(cur, 1);
    if (isWorkingDay(cur, c)) left--;
  }
  return cur;
}

// The working day on or before `key`.
export function workingDayOnOrBefore(key: string, c: TatConfig): string {
  let cur = key;
  for (let i = 0; i < 30 && !isWorkingDay(cur, c); i++) cur = addDays(cur, -1);
  return cur;
}

// Count working days strictly after `from` up to and including `to`.
export function workingDaysBetween(from: string, to: string, c: TatConfig): number {
  if (to <= from) return 0;
  let n = 0;
  let cur = from;
  for (let i = 0; i < 800 && cur < to; i++) {
    cur = addDays(cur, 1);
    if (isWorkingDay(cur, c)) n++;
  }
  return n;
}

function minuteOfDay(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export type TaskClock = {
  today: string; // IST date
  dayClosed: boolean; // past 7 PM today
  minutesToClose: number; // 0 once closed
  isWorkingDay: boolean;
  nextWorkingDay: string;
  config: TatConfig;
};

export async function taskClock(now = new Date()): Promise<TaskClock> {
  const c = await taskWorkConfig();
  const today = dateInTimezone(now, c.timezone);
  const minute = minuteOfDay(now, c.timezone);
  return {
    today,
    dayClosed: minute >= TASK_DAY_END_MINUTE,
    minutesToClose: Math.max(0, TASK_DAY_END_MINUTE - minute),
    isWorkingDay: isWorkingDay(today, c),
    nextWorkingDay: addWorkingDays(today, 1, c),
    config: c,
  };
}

// Shortlisting SLA clock (Suraj, 19 Nov 2026): elapsed minutes between two
// instants, with Saturdays, Sundays and TAT holidays (Settings -> TAT
// Settings) not counted. Other days count around the clock (10 Nov 11:00 →
// 11 Nov 14:00 = 27h). Pure arithmetic plus one pass over the holiday list
// (no day loop), so a report over thousands of students stays fast.
function offsetMinutesAt(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

// Weekday minutes from a fixed Monday to a local wall-clock instant.
function weekdayMinutesTo(localMs: number): number {
  const minutes = Math.floor(localMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const rem = minutes - days * 1440;
  const d = days + 3; // 1970-01-01 was a Thursday; day 0 = Monday 29 Dec 1969
  const weeks = Math.floor(d / 7);
  const dow = d - weeks * 7; // 0 Mon … 6 Sun
  return weeks * 5 * 1440 + Math.min(dow, 5) * 1440 + (dow < 5 ? rem : 0);
}

const DAY_MS = 86_400_000;

export function slaMinutesIn(start: Date, end: Date, timezone: string, holidays: ReadonlySet<string>): number {
  if (end <= start) return 0;
  // Local wall-clock instants, as if the timezone were UTC.
  const a = start.getTime() + offsetMinutesAt(start, timezone) * 60_000;
  const b = end.getTime() + offsetMinutesAt(end, timezone) * 60_000;
  let minutes = weekdayMinutesTo(b) - weekdayMinutesTo(a);
  for (const key of holidays) {
    const h = Date.parse(`${key}T00:00:00Z`);
    if (Number.isNaN(h) || h >= b || h + DAY_MS <= a) continue;
    const dow = new Date(h).getUTCDay();
    if (dow === 0 || dow === 6) continue; // a weekend holiday is already out
    minutes -= Math.floor((Math.min(b, h + DAY_MS) - Math.max(a, h)) / 60_000);
  }
  return Math.max(0, minutes);
}

export async function slaMinutesBetween(start: Date, end: Date): Promise<number> {
  const c = await getTatConfig();
  return slaMinutesIn(start, end, c.timezone, c.holidays);
}
