import { type RouterOutputs } from "~/trpc/react";
import {
  COURSE_LEVEL_OPTIONS,
  CourseLevelLabel,
  StudentStatusLabel,
} from "~/components/students/status";
import {
  GENDER_CODES,
  GenderLabel,
  UniApplicationStatusLabel,
} from "~/server/db/enums";

// ---------------------------------------------------------------------------
// Types (derived from the router so they can't drift)
// ---------------------------------------------------------------------------

export type AdminStudent = RouterOutputs["students"]["adminList"][number];
export type StudentApplication = AdminStudent["applications"][number];
export type CpCounsellor = RouterOutputs["users"]["listByRole"][number];
export type OrgOption = RouterOutputs["students"]["listOrgs"][number];
export type AdminStudentFull = RouterOutputs["students"]["adminGet"];
export type ShortlistCard = AdminStudentFull["shortlists"][number];
export type ApplicationCard = AdminStudentFull["applicationCards"][number];

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function studentName(
  s: Pick<AdminStudent, "firstName" | "lastName">,
): string {
  return `${s.firstName} ${s.lastName}`.trim();
}

// Ids are seeded ≥ 10001 so this reads CP-10001 like the design mock.
export function displayId(id: number): string {
  return `CP-${id}`;
}

export function studentInitials(
  s: Pick<AdminStudent, "firstName" | "lastName">,
): string {
  return (
    (s.firstName[0] ?? "") + (s.lastName[0] ?? s.firstName[1] ?? "")
  ).toUpperCase();
}

// Ten gradients like the mock's avatarGradients; picked by id so each
// student's avatar is stable across renders/sorts.
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg, #1570EF, #0B4EA2)",
  "linear-gradient(135deg, #7F56D9, #5925DC)",
  "linear-gradient(135deg, #12B76A, #027A48)",
  "linear-gradient(135deg, #F79009, #B54708)",
  "linear-gradient(135deg, #0BA5EC, #026AA2)",
  "linear-gradient(135deg, #F04438, #B42318)",
  "linear-gradient(135deg, #9E77ED, #6938EF)",
  "linear-gradient(135deg, #667085, #344054)",
  "linear-gradient(135deg, #F63D68, #C01048)",
  "linear-gradient(135deg, #039855, #054F31)",
];

export function avatarGradient(id: number): string {
  return AVATAR_GRADIENTS[id % AVATAR_GRADIENTS.length] ?? AVATAR_GRADIENTS[0]!;
}

export function statusLabel(status: number): string {
  return (
    (StudentStatusLabel as Record<number, string | undefined>)[status] ??
    `Status ${status}`
  );
}

export function levelShort(level: number | null): string {
  if (level === null) return "—";
  return (
    (CourseLevelLabel as Record<number, string | undefined>)[level] ??
    String(level)
  );
}

// ---------------------------------------------------------------------------
// Countries (local ISO2 → display name, mirroring the uni-assist page)
// ---------------------------------------------------------------------------

export const COUNTRY_NAME: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  IE: "Ireland",
  NZ: "New Zealand",
  SG: "Singapore",
  FR: "France",
  NL: "Netherlands",
  AE: "UAE",
  IN: "India",
  CH: "Switzerland",
  HK: "Hong Kong",
  JP: "Japan",
};

export function countryName(code: string | null): string {
  if (!code) return "—";
  return COUNTRY_NAME[code] ?? code;
}

// Country Preference options for the Add Student modal (mock order).
export const ADD_COUNTRY_OPTIONS = [
  "US",
  "GB",
  "CA",
  "AU",
  "DE",
  "IE",
  "NZ",
  "SG",
  "FR",
  "NL",
  "AE",
].map((code) => ({ value: code, label: COUNTRY_NAME[code] ?? code }));

// ---------------------------------------------------------------------------
// Add Student modal constants
// ---------------------------------------------------------------------------

export const PHONE_CODES = [
  "+91",
  "+1",
  "+44",
  "+61",
  "+49",
  "+33",
  "+971",
  "+65",
];

// Required digit count per country code (mock's validation map).
export const PHONE_LENGTH: Record<string, number> = {
  "+91": 10,
  "+1": 10,
  "+44": 10,
  "+61": 9,
  "+49": 11,
  "+33": 9,
  "+971": 9,
  "+65": 8,
};

export const PROGRAM_OPTIONS = [
  "Computer Science",
  "Data Science",
  "Business Analytics",
  "MBA / Business Admin",
  "Finance",
  "Engineering",
  "Mechanical Engineering",
  "Civil Engineering",
  "Psychology",
  "Physics",
  "Information Technology",
  "Nursing",
  "Pharmacy",
  "Architecture",
  "Law",
  "Media & Communications",
];

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// COURSE_LEVEL_OPTIONS with stringified values for <select> elements.
export const COURSE_LEVEL_SELECT_OPTIONS = COURSE_LEVEL_OPTIONS.map((o) => ({
  value: String(o.value),
  label: o.label,
}));

export const GENDER_SELECT_OPTIONS = GENDER_CODES.map((code) => ({
  value: String(code),
  label: GenderLabel[code],
}));

// Nationality options reuse the ISO2 map above (profile form select).
export const NATIONALITY_OPTIONS = Object.entries(COUNTRY_NAME)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

// Splits a stored "+91 98200 11234" phone into a dial-code + local number
// for the profile form's code <select> + number input.
export function splitPhone(stored: string | null): {
  code: string;
  number: string;
} {
  if (!stored) return { code: "+91", number: "" };
  const m = /^(\+\d{1,4})\s+(.*)$/.exec(stored);
  if (!m) return { code: "+91", number: stored };
  return { code: m[1]!, number: m[2]! };
}

// ---------------------------------------------------------------------------
// Derived university / program
// ---------------------------------------------------------------------------

// Applications with status < 20 are active (happy path); the furthest one is
// the student's "primary" application. Terminal-only students fall back to
// any application; lead students have none.
export function primaryApplication(
  s: Pick<AdminStudent, "applications">,
): StudentApplication | null {
  const active = s.applications.filter((a) => a.status < 20);
  if (active.length > 0) {
    return active.reduce((best, a) => (a.status > best.status ? a : best));
  }
  return s.applications[0] ?? null;
}

export function derivedUniversity(s: Pick<AdminStudent, "applications">): string {
  return primaryApplication(s)?.university ?? "Not Assigned";
}

export function derivedProgram(
  s: Pick<AdminStudent, "applications" | "interestedProgram">,
): string {
  return primaryApplication(s)?.program ?? s.interestedProgram ?? "—";
}

// ---------------------------------------------------------------------------
// Per-application status badge tones (slide-over "Universities Applied")
// ---------------------------------------------------------------------------

// Happy-path stages 0–7 follow the mock's statusColors for the analogous
// student statuses; terminal outcomes (≥ 20) collapse to red / gray.
const UNI_APP_TONE: Record<number, { color: string; bg: string }> = {
  0: { color: "#7F56D9", bg: "#F9F5FF" }, // Begin Application
  1: { color: "#F79009", bg: "#FFF6ED" }, // Documents Pending
  2: { color: "#1570EF", bg: "#EFF8FF" }, // Application Submitted
  3: { color: "#0BA5EC", bg: "#F0F9FF" }, // Application Under Review
  4: { color: "#7F56D9", bg: "#F9F5FF" }, // Conditional Offer
  5: { color: "#9E77ED", bg: "#F9F5FF" }, // Unconditional Offer
  6: { color: "#F79009", bg: "#FFF6ED" }, // Deposit Paid
  7: { color: "#12B76A", bg: "#ECFDF3" }, // Visa Secured
};

const UNI_APP_GRAY_TERMINALS = new Set([24, 25]); // Deferred, Course Closed

export function uniAppBadge(status: number): {
  label: string;
  color: string;
  bg: string;
} {
  const label =
    (UniApplicationStatusLabel as Record<number, string | undefined>)[
      status
    ] ?? `Status ${status}`;
  if (status < 20) {
    const tone = UNI_APP_TONE[status] ?? { color: "#667085", bg: "#F2F4F7" };
    return { label, ...tone };
  }
  return UNI_APP_GRAY_TERMINALS.has(status)
    ? { label, color: "#667085", bg: "#F2F4F7" }
    : { label, color: "#B42318", bg: "#FEF3F2" };
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

// ---------------------------------------------------------------------------
// CSV export (hand-rolled; BOM so Excel reads UTF-8)
// ---------------------------------------------------------------------------

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function downloadCsv(filename: string, rows: string[][]): void {
  const csv =
    "\uFEFF" + rows.map((r) => r.map(csvField).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function todayYmd(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
