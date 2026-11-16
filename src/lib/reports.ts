// Reports & Analytics (Super Admin, 16 Nov 2026): the ONE set of metric
// definitions every tab, chart, drill-down and export uses, so the same
// filters give the same numbers everywhere. The SQL lives in
// ~/server/reports; it builds its conditions from the stage lists below.
//
// Reference: the manual "Converge B2B Weekly Report" workbook. It is the
// reference for metrics, counting rules and section structure, not visuals.
//
// Decisions (Suraj, 16 Nov 2026):
//   Lead            = a student added by a partner; lead date = student.created_at
//   Application date = application.submitted_at (marked submitted to the uni)
//   RM              = the partner's BDM (agency owner / independent user.bdm_id)
//   Counsellor      = the student's Collegepond counsellor (cp_counsellor_id)
//   Intake          = stored intake: deferred intake, else the course's, else
//                     the student's (as Student Placements shows it)
//   Vendor          = the application's commission contract vendor (no vendor
//                     on the contract = Direct), else the counsellor's free-text
//                     vendor, else "Not set"
//   Active          = see ACTIVE_STAGES below

import { UniApplicationStatus as S, UniApplicationStatusLabel } from "~/server/db/enums";
import { APPLICATION_STAGE_ORDER, CLOSED_STAGES } from "~/lib/application-stages";

// ---------------------------------------------------------------------------
// "Active"
// ---------------------------------------------------------------------------
// Suraj: "the student is interested and has shortlisted and progressed to
// application". Checked against the workbook's Data sheet (Lead Status ×
// application status, 280 rows): every Active row is at Application
// Submitted or later; Documents Pending is almost always "Not Processed";
// Case Closed (0 of 27) and Withdrawn (0 of 2) are never Active, Rejected
// by University is Active only once in 7; Visa Approved is always Active.
// So an application is active when:
//   - the student is not marked Inactive (student.inactive_at IS NULL), and
//   - it is at Application Submitted or any later open stage, up to and
//     including Visa Approved / Enrolled (closed outcomes are not active).
export const ACTIVE_STAGES: number[] = [
  S.APPLICATION_SUBMITTED,
  S.APPLICATION_UNDER_REVIEW,
  S.CONDITIONAL_OFFER,
  S.UNCONDITIONAL_OFFER,
  S.DEPOSIT_PAID,
  S.VISA_FILED,
  S.VISA_SECURED,
  S.ENROLLED,
];

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
// level:
//   app       one row per application
//   student   distinct students over those applications
//   lead      students by lead date (student.created_at)
//   shortlist distinct students shortlisted (shortlist.created_at)
export type MetricLevel = "app" | "student" | "lead" | "shortlist";

export type MetricKey =
  | "total"
  | "active"
  | "activeUnique"
  | "docsPending"
  | "submitted"
  | "conditional"
  | "unconditional"
  | "depositPaid"
  | "depositInProcess"
  | "visaFiled"
  | "visaApproved"
  | "enrolled"
  | "visaRejected"
  | "visaDecisions"
  | "rejected"
  | "withdrawn"
  | "caseClosed"
  | "deferred"
  | "leads"
  | "shortlisted"
  | "partnerShortlistApproved";

export interface MetricDef {
  label: string;
  level: MetricLevel;
  // Application stages counted (app/student metrics). Unset = see `rule`.
  stages?: number[];
  // The counting rule in plain words ("How these are counted").
  rule: string;
}

export const METRICS: Record<MetricKey, MetricDef> = {
  total: { label: "Total Applications", level: "app", rule: "Every application, at any stage." },
  active: {
    label: "Total Active Applications",
    level: "app",
    stages: ACTIVE_STAGES,
    rule: "Applications at Application Submitted or later (up to Visa Approved / Enrolled) of a student not marked Inactive. Closed outcomes are not active.",
  },
  activeUnique: {
    label: "Active Unique Applicants",
    level: "student",
    stages: ACTIVE_STAGES,
    rule: "Distinct students with at least one active application. A student with several applications counts once.",
  },
  docsPending: {
    label: "Documents Pending",
    level: "app",
    stages: [S.BEGIN_APPLICATION, S.DOCUMENTS_PENDING],
    rule: "Applications not yet submitted: Begin Application or Documents Pending. They have no submitted date, so a date range leaves them out.",
  },
  submitted: {
    label: "Applications Submitted",
    level: "app",
    stages: [S.APPLICATION_SUBMITTED, S.APPLICATION_UNDER_REVIEW],
    rule: "Applications currently at Application Submitted or Under Review (awaiting the university's decision).",
  },
  conditional: {
    label: "Conditional Offer Received",
    level: "app",
    stages: [S.CONDITIONAL_OFFER],
    rule: "Applications currently at Conditional Offer.",
  },
  unconditional: {
    label: "Unconditional Offer Received",
    level: "app",
    stages: [S.UNCONDITIONAL_OFFER],
    rule: "Applications currently at Unconditional Offer.",
  },
  depositPaid: {
    label: "Deposit Paid",
    level: "app",
    stages: [S.DEPOSIT_PAID, S.VISA_FILED],
    rule: "Applications currently at Deposit Paid or Visa Filed (deposit paid, visa decision not yet in). Visa Approved is counted under Visa Approved.",
  },
  depositInProcess: {
    label: "Deposit Paid · visa not filed",
    level: "app",
    stages: [S.DEPOSIT_PAID],
    rule: "Applications at Deposit Paid whose visa has not been filed yet (the Deposit Wise list).",
  },
  visaFiled: { label: "Visa Filed", level: "app", stages: [S.VISA_FILED], rule: "Applications currently at Visa Filed." },
  visaApproved: {
    label: "Visa Approved",
    level: "app",
    stages: [S.VISA_SECURED, S.ENROLLED],
    rule: "Applications at Visa Approved or Enrolled.",
  },
  enrolled: { label: "Enrolled", level: "app", stages: [S.ENROLLED], rule: "Applications confirmed Enrolled (included in Visa Approved)." },
  visaRejected: { label: "Visa Rejected", level: "app", stages: [S.VISA_REJECTED], rule: "Applications at Visa Rejected." },
  visaDecisions: {
    label: "Total Visa Decisions",
    level: "app",
    stages: [S.VISA_SECURED, S.ENROLLED, S.VISA_REJECTED],
    rule: "Visa Approved plus Visa Rejected.",
  },
  rejected: {
    label: "Rejected by University",
    level: "app",
    stages: [S.REJECTED_BY_UNIVERSITY],
    rule: "Applications at Rejected by University.",
  },
  withdrawn: {
    label: "Application Withdrawn",
    level: "app",
    stages: [S.APPLICATION_WITHDRAWAL, S.DECLINED_BY_STUDENT],
    rule: "Applications withdrawn, or offers declined by the student.",
  },
  caseClosed: { label: "Case Closed", level: "app", stages: [S.COURSE_CLOSED], rule: "Applications at Case Closed." },
  deferred: {
    label: "Defer Count (to next intake)",
    level: "app",
    rule: "Applications deferred to a later intake (they stay open at their stage), plus older ones closed as Deferred to Next Intake.",
  },
  leads: {
    label: "Leads Received",
    level: "lead",
    rule: "Distinct students added by partners, by the date they were added (Lead Submitted Date). Not limited to students with applications.",
  },
  shortlisted: {
    label: "Students Shortlisted",
    level: "shortlist",
    rule: "Distinct students for whom the Collegepond counsellor proposed at least one programme in the period (shortlist rows they added, whatever the partner later decided). Partner-proposed programmes are not counted here.",
  },
  partnerShortlistApproved: {
    label: "Partner proposals approved",
    level: "shortlist",
    rule: "Distinct students with a partner-proposed programme that this counsellor approved in the period. Shown alongside, never added to Students Shortlisted.",
  },
};

// The workbook's "Full metric summary" order.
export const SUMMARY_METRICS: MetricKey[] = [
  "total",
  "active",
  "activeUnique",
  "submitted",
  "conditional",
  "unconditional",
  "depositPaid",
  "docsPending",
  "withdrawn",
  "caseClosed",
  "rejected",
  "visaApproved",
  "visaRejected",
  "visaFiled",
  "deferred",
];

// The application metrics an aggregate row carries (everything but leads and
// shortlists, which come from their own tables).
export const APP_METRIC_KEYS = [
  "total",
  "active",
  "activeUnique",
  "docsPending",
  "submitted",
  "conditional",
  "unconditional",
  "depositPaid",
  "depositInProcess",
  "visaFiled",
  "visaApproved",
  "enrolled",
  "visaRejected",
  "visaDecisions",
  "rejected",
  "withdrawn",
  "caseClosed",
  "deferred",
] as const satisfies readonly MetricKey[];
export type AppMetricKey = (typeof APP_METRIC_KEYS)[number];
export type AppCounts = Record<AppMetricKey, number>;

// ---------------------------------------------------------------------------
// Stage funnel: applications that REACHED each stage (current stage, stage
// history or a submitted date), so closed applications still count for the
// stages they passed. Unlike the metrics above, which use the current stage.
// ---------------------------------------------------------------------------
export const FUNNEL_STEPS = [
  { key: "reachedSubmitted", label: "Submitted", minStage: S.APPLICATION_SUBMITTED, color: "#1570EF" },
  { key: "reachedOffer", label: "Offer received", minStage: S.CONDITIONAL_OFFER, color: "#7F56D9" },
  { key: "reachedUnconditional", label: "Unconditional offer", minStage: S.UNCONDITIONAL_OFFER, color: "#9E77ED" },
  { key: "reachedDeposit", label: "Deposit paid", minStage: S.DEPOSIT_PAID, color: "#F79009" },
  { key: "reachedVisaFiled", label: "Visa filed", minStage: S.VISA_FILED, color: "#0BA5EC" },
  { key: "reachedVisaApproved", label: "Visa approved", minStage: S.VISA_SECURED, color: "#12B76A" },
  { key: "reachedEnrolled", label: "Enrolled", minStage: S.ENROLLED, color: "#067647" },
] as const;
export type FunnelKey = (typeof FUNNEL_STEPS)[number]["key"];
export const FUNNEL_RULE =
  "Applications that reached each stage at some point (from the current stage, the stage history or a submitted date), so a closed application still counts for the stages it passed.";

// Anything a count can drill into.
export type DrillMetric = MetricKey | FunnelKey;

export function drillLabel(m: DrillMetric): string {
  const f = FUNNEL_STEPS.find((s) => s.key === m);
  return f ? `Reached ${f.label}` : METRICS[m as MetricKey].label;
}

// Drill-down sort keys.
export const DRILL_SORTS = [
  "student",
  "partner",
  "university",
  "intake",
  "country",
  "counsellor",
  "rm",
  "vendor",
  "lead",
  "submitted",
  "stage",
  "stageAt",
] as const;
export type DrillSort = (typeof DRILL_SORTS)[number];

// ---------------------------------------------------------------------------
// Dimensions (the "X Wise" groupings) and filters
// ---------------------------------------------------------------------------
export type Dimension = "partner" | "rm" | "counsellor" | "country" | "university" | "intake" | "vendor";

export const DIMENSION_LABEL: Record<Dimension, string> = {
  partner: "Partner",
  rm: "Relationship Manager",
  counsellor: "Counsellor",
  country: "Country",
  university: "University",
  intake: "Intake",
  vendor: "Vendor",
};

// Every filter is a string so it round-trips through the URL. Empty = any.
//   partner     "o<org id>" (agency / institution) or "u<user id>" (independent)
//   rm, counsellor  cp_user id, or "none" for unassigned
//   university  university id; country ISO2; intake and vendor by label
//   status      an application status code
//   from, to    YYYY-MM-DD, India time, inclusive
export interface ReportFilters {
  from?: string;
  to?: string;
  intake?: string;
  country?: string;
  partner?: string;
  rm?: string;
  counsellor?: string;
  university?: string;
  vendor?: string;
  status?: string;
}

export const FILTER_KEYS = [
  "intake",
  "country",
  "partner",
  "rm",
  "counsellor",
  "university",
  "vendor",
  "status",
] as const satisfies readonly (keyof ReportFilters)[];

export const NONE = "none";

// Application status filter options, in pipeline order then closed outcomes.
export const UniStatusOptions = [...APPLICATION_STAGE_ORDER, ...CLOSED_STAGES].map((code) => ({
  value: code,
  label: UniApplicationStatusLabel[code],
}));
export const VENDOR_DIRECT = "Direct";
export const VENDOR_NOT_SET = "Not set";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
export const REPORT_TABS = [
  { key: "overview", label: "Overview" },
  { key: "weekly", label: "Weekly" },
  { key: "rm", label: "RM Wise" },
  { key: "counsellor", label: "Counsellor Wise" },
  { key: "partner", label: "Partner Wise" },
  { key: "country", label: "Country Wise" },
  { key: "university", label: "University Wise" },
  { key: "deposit", label: "Deposit Wise" },
  { key: "visa", label: "Visa Wise" },
  { key: "intake", label: "Intake Wise" },
] as const;
export type ReportTab = (typeof REPORT_TABS)[number]["key"];

// ---------------------------------------------------------------------------
// Dates (India time; timestamps are stored in UTC)
// ---------------------------------------------------------------------------
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;

export const isIsoDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function todayIst(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// Inclusive day count of a range.
export function daysInRange(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

// The UTC instants bounding [from 00:00 IST, to+1 00:00 IST).
export function istRangeToUtc(from: string, to: string): { start: Date; end: Date } {
  return {
    start: new Date(Date.parse(`${from}T00:00:00+05:30`)),
    end: new Date(Date.parse(`${addDays(to, 1)}T00:00:00+05:30`)),
  };
}

// The period of the same length straight before [from, to].
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const n = daysInRange(from, to);
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

export type PeriodPreset = "all" | "this_week" | "last_week" | "this_month" | "last_month" | "last_7" | "custom";

export const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "last_7", label: "Last 7 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "custom", label: "Custom range" },
];

// Weeks run Monday to Sunday.
export function presetRange(preset: PeriodPreset, today: string = todayIst()): { from: string; to: string } | null {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  const monthStart = `${today.slice(0, 8)}01`;
  switch (preset) {
    case "this_week":
      return { from: addDays(today, -dow), to: today };
    case "last_week":
      return { from: addDays(today, -dow - 7), to: addDays(today, -dow - 1) };
    case "last_7":
      return { from: addDays(today, -6), to: today };
    case "this_month":
      return { from: monthStart, to: today };
    case "last_month": {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
    default:
      return null;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "15 Oct 2026"
export function fmtIsoDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

// "15 Oct – 21 Oct 2026" / "All time"
export function periodLabel(from?: string, to?: string): string {
  if (!isIsoDate(from) || !isIsoDate(to)) return "All time";
  const a = fmtIsoDay(from);
  const b = fmtIsoDay(to);
  return a.slice(-4) === b.slice(-4) ? `${a.slice(0, -5)} – ${b}` : `${a} – ${b}`;
}

// Intakes in calendar order ("Sep 2026" before "Jan 2027", "Spring 2027"
// before "Fall 2027"); anything else after, alphabetically.
const SEASON_MONTH: Record<string, number> = { spring: 1, summer: 5, fall: 8, autumn: 8, winter: 11 };
export function intakeSortKey(s: string): number {
  const m = /^([A-Za-z]+)[,\s]*.*?(\d{4})$/.exec(s.trim());
  if (!m) return Number.POSITIVE_INFINITY;
  const word = m[1]!.toLowerCase();
  const month = MONTHS.findIndex((x) => word.startsWith(x.toLowerCase()));
  const idx = month >= 0 ? month : (SEASON_MONTH[word] ?? 12);
  return Number(m[2]) * 13 + idx;
}
