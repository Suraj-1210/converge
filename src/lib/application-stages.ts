// Application stage ordering and display, shared by the admin and partner
// portals and the server. application.status codes are stored numbers that
// are NOT in pipeline order (Visa Filed = 9 was added between Deposit Paid 6
// and Visa Secured 7 on 17 Oct 2026), so anything that asks "is this stage
// before / after / the furthest" must go through stageIndex(), never compare
// the raw codes.

import { TERMINAL_FALLBACK_STAGE, UniApplicationStatus } from "~/server/db/enums";

// The happy path, by position.
export const APPLICATION_STAGE_ORDER: UniApplicationStatus[] = [
  UniApplicationStatus.BEGIN_APPLICATION,
  UniApplicationStatus.DOCUMENTS_PENDING,
  UniApplicationStatus.APPLICATION_SUBMITTED,
  UniApplicationStatus.APPLICATION_UNDER_REVIEW,
  UniApplicationStatus.CONDITIONAL_OFFER,
  UniApplicationStatus.UNCONDITIONAL_OFFER,
  UniApplicationStatus.DEPOSIT_PAID,
  UniApplicationStatus.VISA_FILED,
  UniApplicationStatus.VISA_SECURED,
  UniApplicationStatus.ENROLLED,
];

// Terminal outcomes: the application is closed (codes >= 20).
export const CLOSED_STAGES: UniApplicationStatus[] = [
  UniApplicationStatus.REJECTED_BY_UNIVERSITY,
  UniApplicationStatus.APPLICATION_WITHDRAWAL,
  UniApplicationStatus.DECLINED_BY_STUDENT,
  UniApplicationStatus.VISA_REJECTED,
  UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE,
  UniApplicationStatus.COURSE_CLOSED,
];

// Closed outcomes shown as a failure (red); Deferred and Case Closed are
// neutral (gray).
export const NEGATIVE_CLOSED_STAGES: UniApplicationStatus[] = [
  UniApplicationStatus.REJECTED_BY_UNIVERSITY,
  UniApplicationStatus.APPLICATION_WITHDRAWAL,
  UniApplicationStatus.DECLINED_BY_STUDENT,
  UniApplicationStatus.VISA_REJECTED,
];

const CLOSED = new Set<number>(CLOSED_STAGES);
const NEGATIVE = new Set<number>(NEGATIVE_CLOSED_STAGES);

export const isClosedStage = (code: number) => CLOSED.has(code) || code >= 20;
export const isNegativeClosedStage = (code: number) => NEGATIVE.has(code);

// Position on the happy path (0 = Begin Application … 9 = Enrolled), or -1
// for a closed outcome or an unknown code.
export function stageIndex(code: number): number {
  return APPLICATION_STAGE_ORDER.indexOf(code as UniApplicationStatus);
}

// True when `code` is at or past `min` on the happy path.
export function stageAtLeast(code: number, min: UniApplicationStatus): boolean {
  const i = stageIndex(code);
  return i >= 0 && i >= stageIndex(min);
}

// The happy-path stages after `code` (for reverting stage history).
export function stagesAfter(code: number): UniApplicationStatus[] {
  const i = stageIndex(code);
  return i < 0 ? [] : APPLICATION_STAGE_ORDER.slice(i + 1);
}

// The stage immediately before `code`, or null at the start.
export function previousStage(code: number): UniApplicationStatus | null {
  const i = stageIndex(code);
  return i > 0 ? APPLICATION_STAGE_ORDER[i - 1]! : null;
}

// The furthest of several happy-path codes (closed codes are ignored).
export function furthestStage(codes: number[]): UniApplicationStatus | null {
  let best: number | null = null;
  for (const c of codes) {
    if (stageIndex(c) < 0) continue;
    if (best === null || stageIndex(c) > stageIndex(best)) best = c;
  }
  return best as UniApplicationStatus | null;
}

// The furthest open application of a student: their "primary" one.
export function furthestOpen<T extends { status: number }>(apps: T[]): T | null {
  let best: T | null = null;
  for (const a of apps) {
    if (stageIndex(a.status) < 0) continue;
    if (!best || stageIndex(a.status) > stageIndex(best.status)) best = a;
  }
  return best;
}

// Badge tone per status (dot/text colour + pastel background). Happy-path
// stages follow the mock's statusColors; closed outcomes collapse to red
// (negative) or gray (Deferred / Case Closed).
const STAGE_TONE: Record<number, { color: string; bg: string }> = {
  [UniApplicationStatus.BEGIN_APPLICATION]: { color: "#7F56D9", bg: "#F9F5FF" },
  [UniApplicationStatus.DOCUMENTS_PENDING]: { color: "#F79009", bg: "#FFF6ED" },
  [UniApplicationStatus.APPLICATION_SUBMITTED]: { color: "#1570EF", bg: "#EFF8FF" },
  [UniApplicationStatus.APPLICATION_UNDER_REVIEW]: { color: "#0BA5EC", bg: "#F0F9FF" },
  [UniApplicationStatus.CONDITIONAL_OFFER]: { color: "#7F56D9", bg: "#F9F5FF" },
  [UniApplicationStatus.UNCONDITIONAL_OFFER]: { color: "#9E77ED", bg: "#F9F5FF" },
  [UniApplicationStatus.DEPOSIT_PAID]: { color: "#F79009", bg: "#FFF6ED" },
  [UniApplicationStatus.VISA_FILED]: { color: "#0BA5EC", bg: "#F0F9FF" },
  [UniApplicationStatus.VISA_SECURED]: { color: "#12B76A", bg: "#ECFDF3" },
  [UniApplicationStatus.ENROLLED]: { color: "#067647", bg: "#ECFDF3" },
};
const NEGATIVE_TONE = { color: "#B42318", bg: "#FEF3F2" };
const NEUTRAL_TONE = { color: "#667085", bg: "#F2F4F7" };

export function stageTone(code: number): { color: string; bg: string } {
  if (isClosedStage(code)) return isNegativeClosedStage(code) ? NEGATIVE_TONE : NEUTRAL_TONE;
  return STAGE_TONE[code] ?? NEUTRAL_TONE;
}

// One-word labels for compact stage tracks.
const SHORT: Record<number, string> = {
  [UniApplicationStatus.BEGIN_APPLICATION]: "Started",
  [UniApplicationStatus.DOCUMENTS_PENDING]: "Documents",
  [UniApplicationStatus.APPLICATION_SUBMITTED]: "Submitted",
  [UniApplicationStatus.APPLICATION_UNDER_REVIEW]: "Review",
  [UniApplicationStatus.CONDITIONAL_OFFER]: "Conditional",
  [UniApplicationStatus.UNCONDITIONAL_OFFER]: "Offer",
  [UniApplicationStatus.DEPOSIT_PAID]: "Deposit",
  [UniApplicationStatus.VISA_FILED]: "Visa Filed",
  [UniApplicationStatus.VISA_SECURED]: "Visa",
  [UniApplicationStatus.ENROLLED]: "Enrolled",
  [UniApplicationStatus.REJECTED_BY_UNIVERSITY]: "Rejected",
  [UniApplicationStatus.APPLICATION_WITHDRAWAL]: "Withdrawn",
  [UniApplicationStatus.DECLINED_BY_STUDENT]: "Declined",
  [UniApplicationStatus.VISA_REJECTED]: "Visa Rejected",
  [UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE]: "Deferred",
  [UniApplicationStatus.COURSE_CLOSED]: "Closed",
};

export function stageShortLabel(code: number): string {
  return SHORT[code] ?? "—";
}

// Fill colour of a progress track for an application at `code`: blue while
// in progress, green once Enrolled (the commission-claim milestone), red for
// a negative outcome, gray for Deferred / Case Closed.
export function stageTrackColour(code: number): string {
  if (isClosedStage(code)) return isNegativeClosedStage(code) ? "#FDA29B" : "#D0D5DD";
  if (code === UniApplicationStatus.ENROLLED) return "#12B76A";
  return "#1570EF";
}

// The happy-path stage an application is at: its status while open; for a
// closed outcome, the furthest stage its history reached (by position), else
// the typical stage for that outcome.
export function currentStage(status: number, history: { stage: number }[]): UniApplicationStatus {
  if (stageIndex(status) >= 0) return status as UniApplicationStatus;
  return (
    furthestStage(history.map((h) => h.stage)) ??
    TERMINAL_FALLBACK_STAGE[status] ??
    UniApplicationStatus.VISA_FILED
  );
}
