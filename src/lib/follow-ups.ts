// Application follow-ups (decided with Suraj, 30 Oct 2026; deposit and visa
// kinds 16 Nov 2026): shared by the server (src/server/follow-ups.ts) and the
// admin Application tab. Dates are calendar days in the TAT timezone (IST) as
// "YYYY-MM-DD", the same keys the DATE columns come back as.

import { UniApplicationStatus } from "~/server/db/enums";

// What a follow-up is about (application_follow_up.kind). Each kind has its
// own numbering (Follow-up 1, 2 … per kind) and its own stages: a follow-up
// can be scheduled while the application is at one of them, and open ones
// close by themselves when it moves anywhere else.
//   decision  the university's decision (Application Submitted / Under Review)
//   deposit   the deposit, before its deadline (Unconditional Offer). Created
//             automatically 7 days before application.deposit_deadline.
//   visa      the visa file with the partner (visa documentation: Deposit
//             Paid / Visa Filed). Weekly until the visa is in.
export const FOLLOW_UP_KINDS = ["decision", "deposit", "visa"] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];
export const isFollowUpKind = (s: string): s is FollowUpKind => (FOLLOW_UP_KINDS as readonly string[]).includes(s);

export const FOLLOW_UP_KIND_LABEL: Record<FollowUpKind, string> = {
  decision: "University decision",
  deposit: "Deposit",
  visa: "Visa file",
};

export const FOLLOW_UP_KIND_STAGES: Record<FollowUpKind, number[]> = {
  decision: [UniApplicationStatus.APPLICATION_SUBMITTED, UniApplicationStatus.APPLICATION_UNDER_REVIEW],
  deposit: [UniApplicationStatus.UNCONDITIONAL_OFFER],
  visa: [UniApplicationStatus.DEPOSIT_PAID, UniApplicationStatus.VISA_FILED],
};
export const isFollowUpKindStage = (kind: FollowUpKind, status: number) =>
  FOLLOW_UP_KIND_STAGES[kind].includes(status);

// The university-decision stages (the original follow-ups).
export const FOLLOW_UP_STAGES: number[] = FOLLOW_UP_KIND_STAGES.decision;
export const isFollowUpStage = (status: number) => isFollowUpKindStage("decision", status);

// Deposit: the follow-up falls due this many days before the deadline.
export const DEPOSIT_FOLLOW_UP_DAYS_BEFORE = 7;
// Visa file: weekly, and the partner is asked to respond within N days.
export const VISA_FOLLOW_UP_INTERVAL_DAYS = 7;
export const MAX_RESPOND_WITHIN_DAYS = 30;
export const MAX_FOLLOW_UP_REMARKS = 1000;

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

export type FollowUpState = "upcoming" | "today" | "overdue" | "completed" | "closed";

// Status of one follow-up on `today`.
export function followUpStatus(
  f: { dueDate: string; completedOn: string | null; closedOn: string | null },
  today: string,
): { state: FollowUpState; days: number; label: string } {
  if (f.completedOn) return { state: "completed", days: 0, label: `Completed ${fmtDay(f.completedOn)}` };
  if (f.closedOn) return { state: "closed", days: 0, label: `Closed ${fmtDay(f.closedOn)}` };
  const d = daysBetween(today, f.dueDate);
  if (d > 0) return { state: "upcoming", days: d, label: `Due in ${plural(d, "day")}` };
  if (d === 0) return { state: "today", days: 0, label: "Due today" };
  return { state: "overdue", days: -d, label: `Overdue ${plural(-d, "day")}` };
}
