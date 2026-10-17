"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "~/components/ui/button";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { UniLogo } from "~/components/ui/uni-logo";
import { api, type RouterOutputs } from "~/trpc/react";

type Program = RouterOutputs["universities"]["searchPrograms"][number];

// ----- Constants ----------------------------------------------------------

const DEGREE_LEVELS: Array<{ code: number; label: string }> = [
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

const INTAKE_MONTHS = [
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

// ISO2 → display name. Same map the admin universities page uses; kept local
// to avoid a circular shared-data dep.
const COUNTRY_NAME: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  IE: "Ireland",
  NZ: "New Zealand",
  DE: "Germany",
  FR: "France",
  NL: "Netherlands",
  SG: "Singapore",
  AE: "UAE",
  IN: "India",
};

function flagEmoji(iso2: string): string {
  if (iso2.length !== 2) return "";
  return iso2
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(c.charCodeAt(0) + 127397))
    .join("");
}

function studentName(s: { firstName: string; lastName: string }): string {
  return `${s.firstName} ${s.lastName}`.trim();
}

type SortBy = "relevance" | "tuition-asc" | "tuition-desc" | "uni-az";

interface SearchFormState {
  query: string;
  intakeMonth: string;
  intakeYear: string;
  degreeLevel: string;
  country: string;
}

const emptyForm = (): SearchFormState => ({
  query: "",
  intakeMonth: "",
  intakeYear: "",
  degreeLevel: "",
  country: "",
});

// ----- Page ---------------------------------------------------------------

export default function PartnerUniAssistPage() {
  const router = useRouter();
  const me = api.auth.me.useQuery(undefined, { retry: false });

  // Bounce away if approval state shifted (mirrors /partner/dashboard).
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/partner/dashboard") {
      router.replace(target);
    }
  }, [me.data?.redirectUrl, router]);

  // Form state (the inputs the user is editing).
  const [form, setForm] = useState<SearchFormState>(emptyForm());
  // Applied state (what actually drives the query). Decoupled so typing in
  // the box doesn't refetch on every keystroke — only on Search / filter pick.
  const [applied, setApplied] = useState<SearchFormState>(emptyForm());
  const [sortBy, setSortBy] = useState<SortBy>("relevance");

  // The student whose shortlist the Shortlist buttons edit. Preselected from
  // ?student=<id> (the student profile links here); read once on mount
  // rather than via useSearchParams so the page needs no Suspense boundary.
  const [studentId, setStudentId] = useState<number | null>(null);
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get("student"));
    if (Number.isInteger(id) && id > 0) setStudentId(id);
  }, []);

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };

  const filtersMeta = api.universities.listSearchFilters.useQuery();
  const programs = api.universities.searchPrograms.useQuery({
    query: applied.query.trim() || undefined,
    country: applied.country || undefined,
    intakeYear: applied.intakeYear ? Number(applied.intakeYear) : undefined,
    intakeMonth: applied.intakeMonth || undefined,
    degreeLevel:
      applied.degreeLevel === "" ? undefined : Number(applied.degreeLevel),
    sortBy,
  });

  const handleSearch = () => setApplied(form);
  const handleReset = () => {
    setForm(emptyForm());
    setApplied(emptyForm());
    setSortBy("relevance");
  };

  // Filter dropdowns auto-apply on change (search input is the only one that
  // needs an explicit Search click).
  const setFilter = <K extends keyof SearchFormState>(
    key: K,
    value: SearchFormState[K],
  ) => {
    const nextForm = { ...form, [key]: value };
    setForm(nextForm);
    setApplied({ ...applied, [key]: value });
  };

  // Students this partner can see (owner: the agency's; counsellor: assigned
  // or created; independent: their own). The server re-checks on every call.
  const students = api.students.partnerList.useQuery();
  const selectedStudent = students.data?.find((s) => s.id === studentId) ?? null;
  const shortlistQ = api.students.partnerShortlist.useQuery(
    { studentId: studentId ?? 0 },
    { enabled: studentId !== null },
  );
  const shortlist = useMemo(
    () => new Map((shortlistQ.data ?? []).map((r) => [r.courseId, r])),
    [shortlistQ.data],
  );
  const utils = api.useUtils();
  const onShortlistChanged = (msg: string) => {
    void utils.students.partnerShortlist.invalidate();
    if (studentId !== null) void utils.students.partnerGet.invalidate({ id: studentId });
    showToast(msg);
  };
  const addShortlist = api.students.partnerAddShortlist.useMutation({
    onSuccess: () =>
      onShortlistChanged(`Shortlisted for ${selectedStudent ? studentName(selectedStudent) : "the student"}`),
    onError: (e) => showToast(e.message),
  });
  const removeShortlist = api.students.partnerRemoveShortlist.useMutation({
    onSuccess: () => onShortlistChanged("Removed from shortlist"),
    onError: (e) => showToast(e.message),
  });
  const shortlistBusy = addShortlist.isPending || removeShortlist.isPending;

  const toggleShortlist = (courseId: number) => {
    if (studentId === null) {
      showToast("Select a student first, then shortlist programs for them");
      return;
    }
    if (shortlistBusy) return;
    const entry = shortlist.get(courseId);
    if (!entry) addShortlist.mutate({ studentId, courseId });
    else if (entry.byCollegepond) showToast("Collegepond shortlisted this program for the student");
    else removeShortlist.mutate({ studentId, courseId });
  };

  const studentOptions = useMemo(
    () =>
      [...(students.data ?? [])]
        .sort((a, b) => studentName(a).localeCompare(studentName(b)))
        .map((s) => ({ value: String(s.id), label: studentName(s) })),
    [students.data],
  );

  // ---- Filter options ----
  const countryOptions = useMemo(() => {
    const list = filtersMeta.data?.countries ?? [];
    return [
      { value: "", label: "Any country" },
      ...list.map((c) => ({
        value: c,
        label: `${flagEmoji(c)} ${COUNTRY_NAME[c] ?? c}`,
      })),
    ];
  }, [filtersMeta.data]);

  const yearOptions = useMemo(() => {
    const list = filtersMeta.data?.years ?? [];
    return [
      { value: "", label: "Any year" },
      ...list.map((y) => ({ value: String(y), label: String(y) })),
    ];
  }, [filtersMeta.data]);

  const intakeOptions = [
    { value: "", label: "Any intake" },
    ...INTAKE_MONTHS.map((m) => ({ value: m, label: m })),
  ];

  const levelOptions = [
    { value: "", label: "Any level" },
    ...DEGREE_LEVELS.map((d) => ({ value: String(d.code), label: d.label })),
  ];

  const SORT_OPTIONS = [
    { value: "relevance", label: "Relevance" },
    { value: "tuition-asc", label: "Tuition: Low to High" },
    { value: "tuition-desc", label: "Tuition: High to Low" },
    { value: "uni-az", label: "University A–Z" },
  ];

  const rows = programs.data ?? [];

  return (
    <>
      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Uni Assist</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Search universities and courses worldwide
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <label className="relative flex h-[42px] items-center gap-2 rounded-lg border border-[#D0D5DD] bg-white pr-3 pl-1.5 text-sm font-medium text-[#344054] focus-within:border-[#1570EF] hover:border-[#1570EF]">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#98A2B3] to-[#667085]">
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2} className="h-3.5 w-3.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </span>
            <span className="sr-only">Shortlist for student</span>
            <select
              value={studentId === null ? "" : String(studentId)}
              onChange={(e) => setStudentId(e.target.value ? Number(e.target.value) : null)}
              className="h-full max-w-[240px] min-w-[180px] cursor-pointer appearance-none bg-transparent pr-6 outline-none"
            >
              <option value="">
                {students.isLoading ? "Loading students…" : "Select student to shortlist for"}
              </option>
              {studentOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3">
              <ChevronDown />
            </span>
          </label>
          {selectedStudent && (
            <a
              href={`/partner/students/${selectedStudent.id}?tab=applications`}
              className="text-xs font-medium text-[#1570EF] hover:underline"
            >
              {shortlist.size} shortlisted · view profile
            </a>
          )}
        </div>
      </div>

      {/* Search card */}
      <div className="mb-4 rounded-2xl border border-[#E4E7EC] bg-white p-6">
        {/* Search input */}
        <div className="mb-4 flex h-11 items-center gap-2.5 rounded-lg border border-[#D0D5DD] px-3.5 transition-all focus-within:border-[#1570EF] focus-within:shadow-[0_0_0_3px_rgba(21,112,239,0.1)]">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} className="h-5 w-5 stroke-[#98A2B3]">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={form.query}
            onChange={(e) => setForm({ ...form, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            placeholder="Search Program / University"
            className="flex-1 border-none bg-transparent text-sm text-[#101828] outline-none placeholder:text-[#98A2B3]"
          />
        </div>

        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-2.5">
          <FilterPill
            value={form.intakeMonth}
            onChange={(v) => setFilter("intakeMonth", v)}
            options={intakeOptions}
            placeholder="Intake"
          />
          <FilterPill
            value={form.intakeYear}
            onChange={(v) => setFilter("intakeYear", v)}
            options={yearOptions}
            placeholder="Year"
          />
          <FilterPill
            value={form.degreeLevel}
            onChange={(v) => setFilter("degreeLevel", v)}
            options={levelOptions}
            placeholder="Study Level"
          />
          <FilterPill
            value={form.country}
            onChange={(v) => setFilter("country", v)}
            options={countryOptions}
            placeholder="Country"
          />
          {/* Discipline filter is on the mock but we don't have a discipline
              column yet — wire up once we add taxonomy. */}

          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={handleReset}
              className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-5 py-2.5 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
            >
              Reset
            </button>
            <Button onClick={handleSearch} className="!h-[42px] !px-6">
              Search
            </Button>
          </div>
        </div>
      </div>

      {filtersMeta.error && (
        <div className="mb-4 rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-3 text-sm text-[#B42318]">
          Couldn&apos;t load the search filters: {filtersMeta.error.message}
        </div>
      )}

      {/* Results bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold text-[#344054]">
          {programs.isLoading
            ? "Searching…"
            : `Showing ${rows.length} program${rows.length === 1 ? "" : "s"}`}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[#667085]">Sort by:</span>
          <FormSelect
            options={SORT_OPTIONS}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="!h-[36px] !text-xs"
          />
        </div>
      </div>

      {/* Results */}
      {programs.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
          {programs.error.message}
        </div>
      ) : programs.isLoading ? (
        <div className="rounded-2xl border border-dashed border-[#D0D5DD] bg-white p-12 text-center text-sm text-[#98A2B3]">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#D0D5DD] bg-white p-12 text-center">
          <div className="text-sm font-semibold text-[#667085]">
            No programs match your search
          </div>
          <div className="mt-1 text-xs text-[#98A2B3]">
            Try clearing some filters or adjusting your query.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((p) => (
            <ProgramCard
              key={p.id}
              program={p}
              shortlisted={shortlist.has(p.id)}
              onToggleShortlist={() => toggleShortlist(p.id)}
            />
          ))}
        </div>
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </>
  );
}

// ----- Filter pill --------------------------------------------------------

function FilterPill({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  const isAny = value === "";
  const selected = options.find((o) => o.value === value);
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-[38px] min-w-[140px] cursor-pointer appearance-none rounded-lg border bg-white pr-9 pl-3 text-sm font-medium transition-colors hover:border-[#1570EF] focus:border-[#1570EF] focus:outline-none focus:shadow-[0_0_0_3px_rgba(21,112,239,0.1)] ${
          isAny ? "border-[#D0D5DD] text-[#344054]" : "border-[#1570EF] text-[#1570EF]"
        }`}
      >
        {/* Placeholder option shows when nothing is picked. */}
        <option value="">{placeholder}</option>
        {options
          .filter((o) => o.value !== "")
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </select>
      <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
        <ChevronDown />
      </div>
      {/* Selected label (rendered visually instead of the raw <option> text
          so flag emojis show on Safari, which doesn't render emoji in <option>
          consistently). */}
      {!isAny && selected && (
        <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center pr-9 text-sm font-medium text-[#1570EF]">
          {selected.label}
        </div>
      )}
    </div>
  );
}

// ----- Program card -------------------------------------------------------

function ProgramCard({
  program,
  shortlisted,
  onToggleShortlist,
}: {
  program: Program;
  shortlisted: boolean;
  onToggleShortlist: () => void;
}) {
  const uni = program.university;
  const tags = collectTags(program);
  const tuition = formatTuition(program.tuitionFee, program.currency);
  const intake = formatIntake(program.intakeMonth, program.intakeYear);
  const duration = program.durationMonths
    ? formatDuration(program.durationMonths)
    : null;

  return (
    <div className="flex flex-wrap items-center gap-5 rounded-2xl border border-[#E4E7EC] bg-white p-5 transition-all hover:border-[#B2DDFF] hover:shadow-[0_4px_16px_rgba(21,112,239,0.06)]">
      {/* University block */}
      <div className="flex min-w-[220px] flex-shrink-0 items-center gap-3.5">
        <UniLogo name={uni?.name ?? "?"} logoUrl={uni?.logoUrl} size={48} />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight text-[#101828]">
            {uni?.name ?? "—"}
          </div>
          {uni && (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-[#667085]">
              <span aria-hidden>{flagEmoji(uni.country)}</span>
              {uni.city ? `${uni.city}, ` : ""}
              {COUNTRY_NAME[uni.country] ?? uni.country}
            </div>
          )}
        </div>
      </div>

      {/* Course details */}
      <div className="min-w-0 flex-1">
        {program.url ? (
          <a
            href={program.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-[15px] font-bold text-[#1570EF] no-underline hover:underline"
          >
            {program.name}
          </a>
        ) : (
          <div className="block text-[15px] font-bold text-[#1570EF]">
            {program.name}
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap gap-4">
          {duration && (
            <MetaItem strong>
              <ClockIcon />
              {duration}
            </MetaItem>
          )}
          {intake && (
            <MetaItem>
              <CalendarIcon />
              {intake}
            </MetaItem>
          )}
          {tuition && (
            <MetaItem strong>
              <MoneyIcon />
              {tuition}
            </MetaItem>
          )}
        </div>
      </div>

      {/* Right: tags + shortlist */}
      <div className="flex flex-shrink-0 flex-col items-end gap-2.5">
        {tags.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {tags.map((t) => (
              <Tag key={t.label} tone={t.tone}>
                {t.label}
              </Tag>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onToggleShortlist}
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-4 py-2 text-[13px] font-semibold transition-colors ${
            shortlisted
              ? "border-[#A6F4C5] bg-[#ECFDF3] text-[#067647]"
              : "border-[#D0D5DD] bg-white text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            fill={shortlisted ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={2}
            className="h-3.5 w-3.5"
          >
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          {shortlisted ? "Shortlisted" : "Shortlist"}
        </button>
      </div>
    </div>
  );
}

// ----- Tag mapping --------------------------------------------------------

type TagTone = "scholarship" | "stem" | "feewaiver" | "coop" | "open" | "tat" | "deposit";

function collectTags(p: Program): Array<{ label: string; tone: TagTone }> {
  const out: Array<{ label: string; tone: TagTone }> = [];
  if (p.hasScholarship) out.push({ label: "Scholarship", tone: "scholarship" });
  if (p.isStem) out.push({ label: "STEM", tone: "stem" });
  if (p.hasAppFeeWaiver) out.push({ label: "Fee Waiver", tone: "feewaiver" });
  if (p.isCoopAvailable) out.push({ label: "Co-op", tone: "coop" });
  if (p.hasFasterTat) out.push({ label: "Faster TAT", tone: "tat" });
  if (p.isOpen) out.push({ label: "Open", tone: "open" });
  return out;
}

function Tag({ tone, children }: { tone: TagTone; children: React.ReactNode }) {
  const palette: Record<TagTone, string> = {
    scholarship: "bg-[#ECFDF3] text-[#12B76A]",
    stem: "bg-[#EFF8FF] text-[#1570EF]",
    feewaiver: "bg-[#FEF3F2] text-[#F04438]",
    coop: "bg-[#F9F5FF] text-[#7F56D9]",
    open: "bg-[#ECFDF3] text-[#027A48]",
    tat: "bg-[#FFFAEB] text-[#DC6803]",
    deposit: "bg-[#F0F9FF] text-[#0EA5E9]",
  };
  return (
    <span
      className={`whitespace-nowrap rounded-xl px-2.5 py-0.5 text-[11px] font-semibold ${palette[tone]}`}
    >
      {children}
    </span>
  );
}

// ----- Format helpers -----------------------------------------------------

function formatTuition(fee: number | null, currency: string | null): string | null {
  if (fee === null) return null;
  const ccy = currency ?? "";
  const formatted = fee.toLocaleString("en-US");
  return `${ccy} ${formatted}/yr`.trim();
}

function formatIntake(month: string | null, year: number | null): string | null {
  if (!month && !year) return null;
  if (month && year) return `${month} ${year}`;
  if (month) return month;
  return String(year);
}

function formatDuration(months: number): string {
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

// ----- Tiny icons / atoms -------------------------------------------------

function MetaItem({
  children,
  strong,
}: {
  children: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 text-[13px] ${
        strong ? "font-semibold text-[#101828]" : "text-[#667085]"
      }`}
    >
      {children}
    </div>
  );
}

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className="h-3 w-3 stroke-[#98A2B3]"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className="h-3.5 w-3.5"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className="h-3.5 w-3.5"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function MoneyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className="h-3.5 w-3.5"
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}
