import {
  CourseLevel,
  CourseLevelLabel,
  StudentStatus,
  StudentStatusGroup,
  StudentStatusGroupLabel,
  StudentStatusLabel,
  studentStatusGroup,
  COURSE_LEVEL_CODES,
  STUDENT_STATUS_CODES,
  STUDENT_STATUS_ORDER,
  InactiveReasonLabel,
  StudentOverallStatus,
  StudentOverallStatusLabel,
  type InactiveReason,
} from "~/server/db/enums";

export {
  CourseLevel,
  CourseLevelLabel,
  StudentStatus,
  StudentStatusGroup,
  StudentStatusGroupLabel,
  StudentStatusLabel,
  studentStatusGroup,
  COURSE_LEVEL_CODES,
  STUDENT_STATUS_CODES,
  STUDENT_STATUS_ORDER,
  StudentOverallStatus,
  StudentOverallStatusLabel,
};

// Dot/text colour per status — lifted verbatim from the design mock
// (cp-students.html statusColors).
const STATUS_COLOR: Record<number, string> = {
  [StudentStatus.NEW]: "#1570EF",
  [StudentStatus.INTERESTED]: "#0BA5EC",
  [StudentStatus.CONNECTED]: "#12B76A",
  [StudentStatus.SHORTLISTED]: "#F79009",
  [StudentStatus.NO_INTEREST]: "#667085",
  [StudentStatus.NO_RESPONSE]: "#98A2B3",
  [StudentStatus.BEGIN_APPLICATION]: "#7F56D9",
  [StudentStatus.DOCUMENT_PENDING]: "#F79009",
  [StudentStatus.APP_SUBMITTED]: "#1570EF",
  [StudentStatus.APP_UNDER_REVIEW]: "#0BA5EC",
  [StudentStatus.CONDITIONAL_OFFER]: "#7F56D9",
  [StudentStatus.UNCONDITIONAL_OFFER]: "#9E77ED",
  [StudentStatus.REJECTED_BY_UNIVERSITY]: "#F04438",
  [StudentStatus.APPLICATION_WITHDRAWAL]: "#F97066",
  [StudentStatus.DECLINED_BY_STUDENT]: "#F63D68",
  [StudentStatus.NOT_QUALIFIED]: "#667085",
  [StudentStatus.DEPOSIT_PAID]: "#F79009",
  [StudentStatus.VISA_SECURED]: "#12B76A",
  [StudentStatus.VISA_REJECTED]: "#F04438",
  [StudentStatus.DEFERRED_TO_NEXT_INTAKE]: "#667085",
  [StudentStatus.COURSE_CLOSED]: "#039855",
  [StudentStatus.VISA_FILED]: "#0BA5EC",
  // The commission-claim milestone.
  [StudentStatus.ENROLLED]: "#039855",
};

// Pastel backgrounds keyed by the dot colour (mock's getStatusBg).
const COLOR_BG: Record<string, string> = {
  "#1570EF": "#EFF8FF",
  "#12B76A": "#ECFDF3",
  "#667085": "#F2F4F7",
  "#F79009": "#FFF6ED",
  "#0BA5EC": "#F0F9FF",
  "#7F56D9": "#F9F5FF",
  "#9E77ED": "#F9F5FF",
  "#F04438": "#FEF3F2",
  "#F97066": "#FEF3F2",
  "#F63D68": "#FFF1F3",
  "#039855": "#ECFDF3",
  "#98A2B3": "#F2F4F7",
};

const FALLBACK = "#667085";

export function studentStatusColor(status: number): {
  color: string;
  bg: string;
} {
  const color = STATUS_COLOR[status] ?? FALLBACK;
  return { color, bg: COLOR_BG[color] ?? "#F2F4F7" };
}

export function StudentStatusBadge({ status }: { status: number }) {
  const { color, bg } = studentStatusColor(status);
  const label =
    StudentStatusLabel[status as StudentStatus] ?? `Status ${status}`;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-2xl px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap"
      style={{ color, background: bg }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

// Status <option>s grouped the way the mock's selects are (optgroup per
// pipeline group), for filter dropdowns and bulk-update modals.
export const STATUS_GROUP_OPTIONS = (
  Object.values(StudentStatusGroup) as StudentStatusGroup[]
).map((group) => ({
  group,
  label: StudentStatusGroupLabel[group],
  options: STUDENT_STATUS_ORDER.filter(
    (code) => studentStatusGroup(code) === group,
  ).map((code) => ({
    value: code,
    label: StudentStatusLabel[code],
  })),
}));

export const COURSE_LEVEL_OPTIONS = COURSE_LEVEL_CODES.map((code) => ({
  value: code,
  label:
    code === CourseLevel.FOUNDATION
      ? "Foundation Year"
      : code === CourseLevel.UG
        ? "Undergraduate"
        : code === CourseLevel.PG
          ? "Masters / Postgraduate"
          : code === CourseLevel.PHD
            ? "PhD / Doctorate"
            : CourseLevelLabel[code],
  // Short form for table cells (UG/PG/…).
  short: CourseLevelLabel[code],
}));

export const INTAKE_OPTIONS = [
  "Fall 2026",
  "Spring 2027",
  "Fall 2027",
  "Spring 2028",
  "Fall 2028",
];

// Overall student status (Active / Inactive / Not Processed – Documents
// Pending), derived in src/lib/student-pipeline.ts. A manual Inactive shows
// its reason.
const OVERALL_TONE: Record<StudentOverallStatus, { color: string; bg: string }> = {
  active: { color: "#027A48", bg: "#ECFDF3" },
  inactive: { color: "#667085", bg: "#F2F4F7" },
  docs_pending: { color: "#B54708", bg: "#FFFAEB" },
};

export function OverallStatusBadge({
  status,
  inactive,
}: {
  status: StudentOverallStatus;
  inactive?: { reason: string | null; note?: string | null } | null;
}) {
  const tone = OVERALL_TONE[status];
  const reason = inactive?.reason ? InactiveReasonLabel[inactive.reason as InactiveReason] : null;
  const title = reason
    ? `Marked inactive: ${reason}${inactive?.note ? ` — ${inactive.note}` : ""}`
    : status === StudentOverallStatus.INACTIVE
      ? "Every application is closed"
      : undefined;
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-2xl px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap"
      style={{ color: tone.color, background: tone.bg }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone.color }} />
      {StudentOverallStatusLabel[status]}
      {reason && <span className="font-medium opacity-80">· {reason}</span>}
    </span>
  );
}
