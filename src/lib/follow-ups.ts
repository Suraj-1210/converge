// Application follow-ups (decided with Suraj, 30 Oct 2026): shared by the
// server (src/server/follow-ups.ts) and the admin Application tab. Dates are
// calendar days in the TAT timezone (IST) as "YYYY-MM-DD", the same keys the
// DATE columns come back as.

import { UniApplicationStatus } from "~/server/db/enums";

// The application is with the university: follow-ups can be scheduled, and
// open ones end by themselves when it moves anywhere else.
export const FOLLOW_UP_STAGES: number[] = [
  UniApplicationStatus.APPLICATION_SUBMITTED,
  UniApplicationStatus.APPLICATION_UNDER_REVIEW,
];
export const isFollowUpStage = (status: number) => FOLLOW_UP_STAGES.includes(status);

// Expected decision time when the counsellor hasn't set one: a Faster TAT
// course (course.faster_tat, at most "Within 7 days") 1 week, otherwise 4.
export const DEFAULT_DECISION_WEEKS = 4;
export const FASTER_TAT_DECISION_WEEKS = 1;
export const MAX_DECISION_WEEKS = 52;
// How far ahead a follow-up may be scheduled.
export const MAX_FOLLOW_UP_DAYS_AHEAD = 365;

export const isDateKey = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const DAY_MS = 24 * 60 * 60 * 1000;
const ms = (key: string) => Date.parse(`${key}T00:00:00Z`);

export function addDays(key: string, days: number): string {
  return new Date(ms(key) + days * DAY_MS).toISOString().slice(0, 10);
}

// Whole days from `from` to `to` (negative when `to` is earlier).
export function daysBetween(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / DAY_MS);
}

// "14 Nov 2026"
export function fmtDay(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export type FollowUpKind = "upcoming" | "today" | "overdue" | "completed" | "closed";

// Status of one follow-up on `today`.
export function followUpStatus(
  f: { dueDate: string; completedOn: string | null; closedOn: string | null },
  today: string,
): { kind: FollowUpKind; days: number; label: string } {
  if (f.completedOn) return { kind: "completed", days: 0, label: `Completed ${fmtDay(f.completedOn)}` };
  if (f.closedOn) return { kind: "closed", days: 0, label: `Closed ${fmtDay(f.closedOn)}` };
  const d = daysBetween(today, f.dueDate);
  if (d > 0) return { kind: "upcoming", days: d, label: `Due in ${plural(d, "day")}` };
  if (d === 0) return { kind: "today", days: 0, label: "Due today" };
  return { kind: "overdue", days: -d, label: `Overdue ${plural(-d, "day")}` };
}
