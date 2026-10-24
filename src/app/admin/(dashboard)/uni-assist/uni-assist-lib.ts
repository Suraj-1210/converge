import { type RouterOutputs } from "~/trpc/react";
import { fasterTatLabel } from "~/lib/faster-tat";
import {
  HOME_CURRENCY,
  convertAmount,
  formatMoney,
  inBracket,
  type InrRates,
} from "~/lib/fx-convert";

export type Program = RouterOutputs["universities"]["listCourses"][number];

// ----- Constants ----------------------------------------------------------

// Same code → label mapping the partner Uni Assist and admin universities
// pages use (course.degree_level).
export const DEGREE_LEVELS: Array<{ code: number; label: string }> = [
  { code: 0, label: "Undergraduate" },
  { code: 1, label: "Masters" },
  { code: 2, label: "MBA" },
  { code: 3, label: "PhD/Doctorate" },
  { code: 4, label: "PG Diploma/Certificate" },
  { code: 5, label: "Diploma" },
  { code: 6, label: "Associate Degree" },
  { code: 7, label: "Foundation Year" },
  { code: 8, label: "High School" },
];

export function degreeLabel(code: number | null): string {
  if (code === null) return "";
  return DEGREE_LEVELS.find((d) => d.code === code)?.label ?? "";
}

export const INTAKE_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "IE", name: "Ireland" },
  { code: "NZ", name: "New Zealand" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "SG", name: "Singapore" },
  { code: "AE", name: "UAE" },
  { code: "IN", name: "India" },
  { code: "CH", name: "Switzerland" },
  { code: "HK", name: "Hong Kong" },
  { code: "JP", name: "Japan" },
];

export const COUNTRY_NAME: Record<string, string> = Object.fromEntries(
  COUNTRIES.map((c) => [c.code, c.name]),
);

export function flagEmoji(iso2: string): string {
  if (iso2.length !== 2) return "";
  return iso2
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(c.charCodeAt(0) + 127397))
    .join("");
}

export const DURATION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "12", label: "1 Year" },
  { value: "18", label: "1.5 Years" },
  { value: "24", label: "2 Years" },
  { value: "36", label: "3 Years" },
  { value: "48", label: "4 Years" },
];

// English proficiency tests we can actually filter on — the course table has
// requirement columns for exactly these three (no PTE / standardized tests).
export const ENG_TESTS: Array<{
  value: EngTest;
  label: string;
  min: number;
  max: number;
  step: number;
  placeholder: string;
}> = [
  { value: "IELTS", label: "IELTS", min: 0, max: 9, step: 0.5, placeholder: "7.0" },
  { value: "TOEFL", label: "TOEFL iBT (0–120)", min: 0, max: 120, step: 1, placeholder: "100" },
  { value: "TOEFL2026", label: "TOEFL iBT 2026 (1–6)", min: 1, max: 6, step: 0.5, placeholder: "4.5" },
  { value: "DET", label: "DET", min: 10, max: 160, step: 1, placeholder: "120" },
];

export type EngTest = "IELTS" | "TOEFL" | "TOEFL2026" | "DET";

// Currencies a user can view, filter and sort fees in. Conversion uses the
// live fx_rate table (Settings → Exchange Rates) via ~/lib/fx-convert.
export const DISPLAY_CURRENCIES = ["EUR", "INR", "USD", "GBP"];

// Faster TAT filter: programs at least this fast.
export const FASTER_TAT_FILTER: Array<{ value: string; label: string }> = [
  { value: "3", label: "Any faster TAT" },
  { value: "2", label: "1–3 days or faster" },
  { value: "1", label: "Same day" },
];

// ----- Filter state -------------------------------------------------------

// Yes / No are independently toggleable (mock behaviour); both on or both off
// means "don't filter".
export interface TriState {
  yes: boolean;
  no: boolean;
}

export interface FilterState {
  query: string;
  intakeMonths: string[];
  intakeYear: string;
  degreeLevel: string;
  countries: string[];
  duration: string; // months, as string ("" = any)
  engTest: "" | EngTest;
  engScore: string;
  stem: TriState;
  feeWaiver: TriState;
  scholarship: TriState;
  open: TriState;
  fasterTat: string; // "" = any, else the slowest faster-TAT code allowed
  // Currency fees are shown (≈), sorted and bracketed in.
  tuitionCurrency: string;
  // The picked bracket's bounds in tuitionCurrency, digits ("" = open end).
  tuitionMin: string;
  tuitionMax: string;
}

export const emptyTri = (): TriState => ({ yes: false, no: false });

export const emptyFilters = (): FilterState => ({
  query: "",
  intakeMonths: [],
  intakeYear: "",
  degreeLevel: "",
  countries: [],
  duration: "",
  engTest: "",
  engScore: "",
  stem: emptyTri(),
  feeWaiver: emptyTri(),
  scholarship: emptyTri(),
  open: emptyTri(),
  fasterTat: "",
  tuitionCurrency: HOME_CURRENCY,
  tuitionMin: "",
  tuitionMax: "",
});

export function parseAmount(formatted: string): number {
  const raw = formatted.replace(/[^0-9]/g, "");
  return raw ? parseInt(raw, 10) : 0;
}

// Bracket key for the dropdown ("10000-20000", "-10000", "40000-").
export function bracketKey(min: string, max: string): string {
  return min || max ? `${min}-${max}` : "";
}

function passTri(t: TriState, value: boolean): boolean {
  if (t.yes === t.no) return true; // none or both selected → no filter
  return t.yes ? value : !value;
}

export function applyFilters(
  rows: Program[],
  f: FilterState,
  rates: InrRates,
): Program[] {
  const query = f.query.trim().toLowerCase();
  const year = f.intakeYear ? Number(f.intakeYear) : null;
  const level = f.degreeLevel === "" ? null : Number(f.degreeLevel);
  const duration = f.duration ? Number(f.duration) : null;
  const engScore = f.engTest && f.engScore ? Number(f.engScore) : null;
  const fasterTat = f.fasterTat ? Number(f.fasterTat) : null;
  const tuitionMin = f.tuitionMin ? parseAmount(f.tuitionMin) : null;
  const tuitionMax = f.tuitionMax ? parseAmount(f.tuitionMax) : null;
  const tuitionActive = tuitionMin !== null || tuitionMax !== null;

  return rows.filter((p) => {
    if (query) {
      const inCourse = p.name.toLowerCase().includes(query);
      const inUni = p.university?.name.toLowerCase().includes(query) ?? false;
      if (!inCourse && !inUni) return false;
    }
    if (year !== null && p.intakeYear !== year) return false;
    if (level !== null && p.degreeLevel !== level) return false;
    if (f.intakeMonths.length > 0) {
      const months = p.intakeMonth ?? "";
      if (!f.intakeMonths.some((m) => months.includes(m))) return false;
    }
    if (f.countries.length > 0) {
      if (!p.university || !f.countries.includes(p.university.country)) {
        return false;
      }
    }
    if (duration !== null && p.durationMonths !== duration) return false;
    if (!passTri(f.stem, p.isStem)) return false;
    if (!passTri(f.feeWaiver, p.hasAppFeeWaiver)) return false;
    if (!passTri(f.scholarship, p.hasScholarship)) return false;
    if (!passTri(f.open, p.isOpen)) return false;
    if (fasterTat !== null && (p.fasterTat === null || p.fasterTat > fasterTat)) {
      return false;
    }
    if (engScore !== null && !Number.isNaN(engScore)) {
      // Pass when the program states no requirement, or the student's score
      // meets it. TOEFL is compared on the scale the student's score is on:
      // the two scales aren't convertible point for point, so a program that
      // only states the other scale counts as stating no requirement.
      const req =
        f.engTest === "IELTS"
          ? p.ielts
          : f.engTest === "TOEFL"
            ? p.toefl
            : f.engTest === "TOEFL2026"
              ? p.toefl2026
              : p.det;
      if (req !== null && req > engScore) return false;
    }
    if (tuitionActive) {
      // Courses are priced in their own currencies: compare converted fees.
      // One with no rate can't be placed in a bracket, so it drops out.
      const fee =
        p.tuitionFee === null
          ? null
          : convertAmount(p.tuitionFee, p.currency, f.tuitionCurrency, rates);
      if (fee === null || !inBracket(fee, tuitionMin, tuitionMax)) return false;
    }
    return true;
  });
}

export type SortBy = "relevance" | "tuition-asc" | "tuition-desc" | "uni-az";

export function sortPrograms(
  rows: Program[],
  sortBy: SortBy,
  currency: string,
  rates: InrRates,
): Program[] {
  const sorted = [...rows];
  const uniName = (p: Program) => p.university?.name ?? "";
  // Tuition sorts compare fees converted to the picked currency so mixed
  // currencies order correctly. No fee, or no rate for it, sorts last.
  const fee = (p: Program, missing: number) =>
    (p.tuitionFee === null
      ? null
      : convertAmount(p.tuitionFee, p.currency, currency, rates)) ?? missing;
  if (sortBy === "tuition-asc") {
    sorted.sort(
      (a, b) =>
        fee(a, Infinity) - fee(b, Infinity) || a.name.localeCompare(b.name),
    );
  } else if (sortBy === "tuition-desc") {
    sorted.sort(
      (a, b) =>
        fee(b, -Infinity) - fee(a, -Infinity) || a.name.localeCompare(b.name),
    );
  } else {
    // "relevance" and "uni-az" both order by university then program name.
    sorted.sort(
      (a, b) =>
        uniName(a).localeCompare(uniName(b)) || a.name.localeCompare(b.name),
    );
  }
  return sorted;
}

// ----- Display helpers ----------------------------------------------------

export function formatTuition(
  fee: number | null,
  currency: string | null,
): string | null {
  if (fee === null) return null;
  return `${formatMoney(fee, currency)}/yr`;
}

// Approximate fee in another currency ("≈ ₹17,40,000"). Null when it's
// already in that currency or there's no rate to convert with.
export function approxIn(
  fee: number | null,
  from: string | null,
  to: string,
  rates: InrRates,
): string | null {
  if (fee === null || !from || from === to) return null;
  const converted = convertAmount(fee, from, to, rates);
  return converted === null ? null : `≈ ${formatMoney(converted, to)}`;
}

// Application fee alone, in the course currency ("€70"; "None" when zero).
// The fee waiver is a separate field: see feeWaiverLabel / the card tag.
export function appFeeOnly(fee: number | null, currency: string | null): string | null {
  if (fee === null) return null;
  return fee === 0 ? "None" : formatMoney(fee, currency);
}

// Application fee as the Universities page shows it (course currency + amount),
// noting a fee waiver when the course has one. Null when neither is recorded.
export function appFeeAmount(
  fee: number | null,
  currency: string | null,
  hasWaiver: boolean,
): string | null {
  if (fee === null) return hasWaiver ? "Waiver available" : null;
  const amount = appFeeOnly(fee, currency)!;
  return `${amount}${hasWaiver && fee > 0 ? " (waiver available)" : ""}`;
}

export function fasterTatTag(code: number | null): string | null {
  const label = fasterTatLabel(code);
  return label ? `Faster TAT: ${label}` : null;
}

// The same, labelled for a card's meta line ("App fee: USD 75").
export function formatAppFee(
  fee: number | null,
  currency: string | null,
  hasWaiver: boolean,
): string | null {
  const amount = appFeeAmount(fee, currency, hasWaiver);
  return amount === null ? null : `App fee: ${amount}`;
}

export function formatIntake(
  month: string | null,
  year: number | null,
): string | null {
  if (!month && !year) return null;
  if (month && year) return `${month} ${year}`;
  if (month) return month;
  return String(year);
}

export function formatDuration(months: number): string {
  if (months % 12 === 0) {
    const y = months / 12;
    return y === 1 ? "1 year" : `${y} years`;
  }
  if (months >= 12) {
    const y = (months / 12).toFixed(1).replace(/\.0$/, "");
    return `${y} years`;
  }
  return `${months} months`;
}

// ----- Students -----------------------------------------------------------

export interface StudentLite {
  id: number;
  firstName: string;
  lastName: string;
  orgName: string;
}

export function studentName(s: StudentLite): string {
  return `${s.firstName} ${s.lastName}`.trim();
}

export function studentDisplayId(id: number): string {
  return `CP-${String(id).padStart(5, "0")}`;
}

export function studentInitials(s: StudentLite): string {
  return (
    (s.firstName[0] ?? "") + (s.lastName[0] ?? s.firstName[1] ?? "")
  ).toUpperCase();
}

// Flat colours (vs UniLogo's gradients) so student avatars read differently
// from university tiles. Hash of the name picks one — stable per student.
const STUDENT_COLORS = [
  "#7F56D9",
  "#1570EF",
  "#E11D48",
  "#F79009",
  "#12B76A",
  "#0BA5EC",
  "#9E77ED",
];

export function studentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return STUDENT_COLORS[h % STUDENT_COLORS.length] ?? STUDENT_COLORS[0]!;
}

// ----- Saved search templates ----------------------------------------------

// Templates live in the DB (uni_assist_template) and are shared team-wide.
export type SearchTemplate =
  RouterOutputs["universities"]["listSearchTemplates"][number];

// The JSON column round-trips the page's FilterState; merge over defaults so
// templates saved before a field existed still load cleanly.
export function templateToFilters(t: SearchTemplate): FilterState {
  const stored = (t.filters ?? {}) as Partial<FilterState>;
  const merged = { ...emptyFilters(), ...stored };
  // Templates from before brackets saved "" for "any currency" and free-typed
  // amounts like "10,000": keep the bounds, default the currency.
  return {
    ...merged,
    tuitionCurrency: merged.tuitionCurrency || HOME_CURRENCY,
    tuitionMin: merged.tuitionMin.replace(/[^0-9]/g, ""),
    tuitionMax: merged.tuitionMax.replace(/[^0-9]/g, ""),
  };
}

// ----- Download ------------------------------------------------------------

// Only a selected student's shortlist can be downloaded, this many programs
// per sheet (Portal Testing Day 5).
export const MAX_DOWNLOAD_PROGRAMS = 10;

export interface DownloadField {
  key: string;
  label: string;
  value: (p: Program) => string;
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");

// Fixed columns plus, when fees are being viewed in another currency, an
// approximate tuition column in it.
export function downloadFields(displayCurrency: string, rates: InrRates): DownloadField[] {
  return [
    ...DOWNLOAD_FIELDS,
    {
      key: "tuitionApprox",
      label: `Tuition Fee (approx. ${displayCurrency})`,
      value: (p) => {
        if (p.tuitionFee === null) return "";
        const v = convertAmount(p.tuitionFee, p.currency, displayCurrency, rates);
        return v === null ? "" : formatMoney(v, displayCurrency);
      },
    },
  ];
}

const DOWNLOAD_FIELDS: DownloadField[] = [
  { key: "uni", label: "University", value: (p) => p.university?.name ?? "" },
  { key: "course", label: "Course / Program", value: (p) => p.name },
  { key: "level", label: "Study Level", value: (p) => degreeLabel(p.degreeLevel) },
  {
    key: "duration",
    label: "Duration",
    value: (p) => (p.durationMonths ? formatDuration(p.durationMonths) : ""),
  },
  {
    key: "intake",
    label: "Intake",
    value: (p) => formatIntake(p.intakeMonth, p.intakeYear) ?? "",
  },
  {
    key: "tuition",
    label: "Tuition Fee",
    value: (p) => (p.tuitionFee === null ? "" : formatMoney(p.tuitionFee, p.currency)),
  },
  // Two separate fields, never combined: what the application costs, and
  // whether the university waives it.
  {
    key: "appFee",
    label: "Application Fee",
    value: (p) => appFeeOnly(p.appFee, p.currency) ?? "",
  },
  { key: "feeWaiver", label: "Fee Waiver", value: (p) => yesNo(p.hasAppFeeWaiver) },
  {
    key: "fasterTat",
    label: "Faster TAT",
    value: (p) => fasterTatLabel(p.fasterTat) ?? "Standard",
  },
  {
    key: "country",
    label: "Country",
    value: (p) =>
      p.university ? (COUNTRY_NAME[p.university.country] ?? p.university.country) : "",
  },
  { key: "city", label: "City", value: (p) => p.university?.city ?? "" },
  { key: "stem", label: "STEM", value: (p) => yesNo(p.isStem) },
  { key: "scholarship", label: "Scholarship", value: (p) => yesNo(p.hasScholarship) },
  { key: "open", label: "Open Program", value: (p) => yesNo(p.isOpen) },
];
