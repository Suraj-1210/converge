// Counsellor tasks and shortlist follow-ups (19 Nov 2026, items 7-10 with
// Suraj): the codes and labels shared by the server (src/server/tasks.ts,
// src/server/shortlist-follow-up.ts) and the My Tasks pages. Dates are IST
// calendar days as "YYYY-MM-DD", the same keys the DATE columns come back as.

// ---- Tasks ------------------------------------------------------------------

export const TaskCategory = {
  STUDENT_REVIEW: 0,
  SHORTLISTING: 1,
  PARTNER_FOLLOW_UP: 2,
  DOCUMENT_VERIFICATION: 3,
  APPLICATION_PROCESSING: 4,
  UNIVERSITY_FOLLOW_UP: 5,
  OFFER_LETTER: 6,
  VISA: 7,
  INTERNAL_COORDINATION: 8,
  OTHER: 9,
} as const;
export type TaskCategory = (typeof TaskCategory)[keyof typeof TaskCategory];

export const TaskCategoryLabel: Record<TaskCategory, string> = {
  [TaskCategory.STUDENT_REVIEW]: "Student Review",
  [TaskCategory.SHORTLISTING]: "Shortlisting",
  [TaskCategory.PARTNER_FOLLOW_UP]: "Partner Follow-up",
  [TaskCategory.DOCUMENT_VERIFICATION]: "Document Verification",
  [TaskCategory.APPLICATION_PROCESSING]: "Application Processing",
  [TaskCategory.UNIVERSITY_FOLLOW_UP]: "University Follow-up",
  [TaskCategory.OFFER_LETTER]: "Offer Letter",
  [TaskCategory.VISA]: "Visa",
  [TaskCategory.INTERNAL_COORDINATION]: "Internal Coordination",
  [TaskCategory.OTHER]: "Other",
};
export const TASK_CATEGORY_CODES = Object.values(TaskCategory) as TaskCategory[];
export const taskCategoryLabel = (c: number) => (TaskCategoryLabel as Record<number, string | undefined>)[c] ?? "Other";

// Stored status. "Overdue" is never stored: it is derived from the due date
// and the 7 PM day close (taskState below).
export const TaskStatus = {
  PENDING: 0,
  IN_PROGRESS: 1,
  COMPLETED: 2,
  CANCELLED: 3,
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// What the lists show.
export type TaskState = "pending" | "in_progress" | "completed" | "overdue" | "cancelled";
export const TaskStateLabel: Record<TaskState, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  completed: "Completed",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

// 0 Low, 1 Medium, 2 High (same codes as student_note.priority).
export const TASK_PRIORITY_LABEL = ["Low", "Medium", "High"] as const;
export const taskPriorityLabel = (p: number) => TASK_PRIORITY_LABEL[p] ?? "Medium";

// cp_task.source: where the task comes from. Everything but "manual" is
// marked "auto" in the lists.
export type TaskSource = "manual" | "note" | "follow_up" | "shortlist";
export const TaskSourceLabel: Record<TaskSource, string> = {
  manual: "Manual",
  note: "Tasks & Notes reminder",
  follow_up: "Application follow-up",
  shortlist: "Shortlist follow-up",
};

export const taskCode = (id: number) => `TSK-${String(id).padStart(4, "0")}`;

// A task is overdue once its due day has closed: any earlier day, or today
// after the working day ends (7 PM IST). Decided with Suraj, 19 Nov 2026.
export function taskState(
  t: { status: number; dueDate: string | null },
  today: string,
  dayClosed: boolean,
): TaskState {
  if (t.status === TaskStatus.COMPLETED) return "completed";
  if (t.status === TaskStatus.CANCELLED) return "cancelled";
  if (t.dueDate && (t.dueDate < today || (t.dueDate === today && dayClosed))) return "overdue";
  return t.status === TaskStatus.IN_PROGRESS ? "in_progress" : "pending";
}

// "Close your day": why a task wasn't completed (PDF page 5).
export const DELAY_REASONS = [
  { code: "waiting_student", label: "Waiting on student" },
  { code: "waiting_partner", label: "Waiting on partner" },
  { code: "waiting_university", label: "Waiting on university" },
  { code: "system_issue", label: "System / portal issue" },
  { code: "workload", label: "Workload — ran out of time" },
  { code: "other", label: "Other" },
] as const;
export type DelayReason = (typeof DELAY_REASONS)[number]["code"];
export const DELAY_REASON_CODES = DELAY_REASONS.map((r) => r.code) as [DelayReason, ...DelayReason[]];
export const delayReasonLabel = (code: string | null | undefined) =>
  DELAY_REASONS.find((r) => r.code === code)?.label ?? (code ? "Other" : "—");

// cp_task_shift_request.status
export const ShiftStatus = {
  DRAFT: 0,
  PENDING: 1,
  APPROVED: 2,
  REJECTED: 3,
  REASON_ONLY: 4,
  LAPSED: 5,
} as const;
export type ShiftStatus = (typeof ShiftStatus)[keyof typeof ShiftStatus];
export const ShiftStatusLabel: Record<ShiftStatus, string> = {
  [ShiftStatus.DRAFT]: "Draft",
  [ShiftStatus.PENDING]: "Awaiting decision",
  [ShiftStatus.APPROVED]: "Approved",
  [ShiftStatus.REJECTED]: "Rejected",
  [ShiftStatus.REASON_ONLY]: "No shift requested",
  [ShiftStatus.LAPSED]: "No longer needed",
};

// ---- Shortlist follow-up ----------------------------------------------------

// shortlist_follow_up.status
export const ShortlistCaseStatus = {
  OPEN: 0,
  CONFIRMED: 1,
  CLOSED: 2,
  ENDED: 3,
} as const;
export type ShortlistCaseStatus = (typeof ShortlistCaseStatus)[keyof typeof ShortlistCaseStatus];

// The stages a counsellor records (the shared day is stage 1).
export const FOLLOW_UP_STAGE = { FIRST: 2, SECOND: 3, FINAL: 4 } as const;
export type FollowUpStage = 2 | 3 | 4;
export const FollowUpStageLabel: Record<FollowUpStage, string> = {
  2: "First follow-up",
  3: "Second follow-up",
  4: "Final follow-up",
};
export const followUpStageLabel = (s: number) => (FollowUpStageLabel as Record<number, string | undefined>)[s] ?? "Follow-up";
// Working days from one stage to the next (stage 2 = the next working day
// after the shortlist was shared; then +3, +3).
export const STAGE_GAP_WORKING_DAYS: Record<FollowUpStage, number> = { 2: 1, 3: 3, 4: 3 };

// The partner-confirmation status shown on the student and the pipeline.
export type ShortlistPhase =
  | "shared"
  | "awaiting"
  | "first"
  | "second"
  | "final"
  | "confirmed"
  | "closed"
  | "ended";
export const ShortlistPhaseLabel: Record<ShortlistPhase, string> = {
  shared: "Shortlist Shared",
  awaiting: "Awaiting Partner Confirmation",
  first: "First Follow-up",
  second: "Second Follow-up",
  final: "Final Follow-up",
  confirmed: "Confirmed",
  closed: "Closed – Shortlisting",
  ended: "Follow-up stopped",
};
export const PIPELINE_PHASES: ShortlistPhase[] = ["shared", "awaiting", "first", "second", "final"];

// Partner response recorded at a follow-up.
export const PARTNER_RESPONSES = [
  { code: "confirmed", label: "Confirmed the shortlist", hint: "Stops follow-ups, moves to Begin Application" },
  { code: "changes", label: "Asked for changes", hint: "Stops this round so you can edit and re-share the shortlist" },
  { code: "pending", label: "No confirmation yet", hint: "Comment required" },
] as const;
export type PartnerResponse = (typeof PARTNER_RESPONSES)[number]["code"];
export const partnerResponseLabel = (code: string | null | undefined) =>
  PARTNER_RESPONSES.find((r) => r.code === code)?.label ?? "—";

export const FOLLOW_UP_CHANNELS = [
  { code: "call", label: "Call done" },
  { code: "email", label: "Email sent" },
  { code: "whatsapp", label: "WhatsApp follow-up" },
] as const;
export type FollowUpChannel = (typeof FOLLOW_UP_CHANNELS)[number]["code"];
export const followUpChannelLabel = (code: string) =>
  FOLLOW_UP_CHANNELS.find((c) => c.code === code)?.label ?? code;

export const CALL_OUTCOMES = ["Spoke to partner", "No answer", "Call back requested", "Number busy / unreachable"] as const;

// Close case at the shortlisting stage (Suraj, 19 Nov 2026). "Other" needs a
// comment.
export const SHORTLIST_CLOSURE_REASONS = [
  { code: "partner_not_responding", label: "Partner not responding" },
  { code: "student_not_interested", label: "Student not interested" },
  { code: "other_provider", label: "Chose another provider" },
  { code: "budget", label: "Budget / finance" },
  { code: "deferred", label: "Plans deferred to a later intake" },
  { code: "not_eligible", label: "Profile not eligible" },
  { code: "other", label: "Other" },
] as const;
export type ShortlistClosureReason = (typeof SHORTLIST_CLOSURE_REASONS)[number]["code"];
export const SHORTLIST_CLOSURE_CODES = SHORTLIST_CLOSURE_REASONS.map((r) => r.code) as [
  ShortlistClosureReason,
  ...ShortlistClosureReason[],
];
export const shortlistClosureLabel = (code: string | null | undefined) =>
  SHORTLIST_CLOSURE_REASONS.find((r) => r.code === code)?.label ?? (code ? "Other" : "—");

// Why a case stopped without a confirmation or a closure.
export const CASE_END_REASON_LABEL: Record<string, string> = {
  changes_requested: "Partner asked for changes",
  all_rejected: "Partner rejected every proposed university",
  withdrawn: "Proposals withdrawn",
  student_inactive: "Student marked inactive",
};

// ---- Dates ------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "2026-11-18" → "18 Nov"
export function fmtShortDay(key: string | null | undefined): string {
  if (!key) return "—";
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

// "2026-11-18" → "Wed, 18 Nov"
export function fmtWeekday(key: string | null | undefined): string {
  if (!key) return "—";
  const dt = new Date(`${key}T00:00:00Z`);
  return `${WEEKDAYS[dt.getUTCDay()]}, ${fmtShortDay(key)}`;
}

// ISO instant → "18 Nov, 4:30 PM" in IST.
export function fmtIstDateTime(iso: string | null | undefined, withYear = false): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function calendarDaysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
}
