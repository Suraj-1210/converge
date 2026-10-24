"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "~/components/ui/button";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { UniLogo } from "~/components/ui/uni-logo";
import { ShortlistApproval } from "~/server/db/enums";
import { api } from "~/trpc/react";
import {
  DownloadDialog,
  LoadTemplateDialog,
  SaveTemplateDialog,
  SubmitCourseDialog,
} from "./dialogs";
import { bracketsFor, formatMoney, type TuitionBracket } from "~/lib/fx-convert";
import {
  COUNTRY_NAME,
  DEGREE_LEVELS,
  DISPLAY_CURRENCIES,
  DURATION_OPTIONS,
  ENG_TESTS,
  FASTER_TAT_FILTER,
  INTAKE_MONTHS,
  applyFilters,
  appFeeOnly,
  approxIn,
  bracketKey,
  degreeLabel,
  emptyFilters,
  emptyTri,
  fasterTatTag,
  flagEmoji,
  formatDuration,
  formatIntake,
  sortPrograms,
  templateToFilters,
  studentColor,
  studentDisplayId,
  studentInitials,
  studentName,
  type EngTest,
  type FilterState,
  type Program,
  type SearchTemplate,
  type SortBy,
  type StudentLite,
  type TriState,
} from "./uni-assist-lib";

const RESULTS_PER_PAGE = 8;

const MONTH_FULL: Record<string, string> = {
  Jan: "January",
  Feb: "February",
  Mar: "March",
  Apr: "April",
  May: "May",
  Jun: "June",
  Jul: "July",
  Aug: "August",
  Sep: "September",
  Oct: "October",
  Nov: "November",
  Dec: "December",
};

// Note: the design mock also has Discipline, standardized-test (GRE/GMAT/
// SAT/ACT) and "15 years of education" filters. The course table has no
// columns for any of those yet — wire them up when the taxonomy lands.

export default function AdminUniAssistPage() {
  const utils = api.useUtils();
  const courses = api.universities.listCourses.useQuery();
  const students = api.students.listLite.useQuery();
  const templates = api.universities.listSearchTemplates.useQuery();
  // Live fx_rate rates (INR per unit) + configured tuition brackets.
  const money = api.universities.uniAssistMoney.useQuery();
  const rates = useMemo(() => money.data?.rates ?? {}, [money.data]);

  // Form state (what the user is editing) vs applied state (what drives the
  // results). Dropdowns/toggles apply instantly; typed fields (query, tuition
  // range, test score) apply on Search.
  const [form, setForm] = useState<FilterState>(emptyFilters());
  const [applied, setApplied] = useState<FilterState>(emptyFilters());
  const [sortBy, setSortBy] = useState<SortBy>("relevance");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [selectedStudents, setSelectedStudents] = useState<StudentLite[]>([]);
  const [linkedStudent, setLinkedStudent] = useState<StudentLite | null>(null);

  const [page, setPage] = useState(1);
  const [showAll, setShowAll] = useState(false);

  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadPrograms, setDownloadPrograms] = useState<Program[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };

  // Student context handoff (e.g. from a future student profile page):
  // /admin/uni-assist?student=<id> preselects that student and pins a banner.
  // Read from window.location instead of useSearchParams to avoid needing a
  // Suspense boundary for this one-shot read.
  useEffect(() => {
    if (!students.data) return;
    const id = Number(
      new URLSearchParams(window.location.search).get("student"),
    );
    if (!id) return;
    const match = students.data.find((s) => s.id === id);
    if (match) {
      setLinkedStudent(match);
      setSelectedStudents([match]);
    }
  }, [students.data]);

  // Shortlists live in the DB (shortlist table); the buttons reflect the
  // union across whichever students are selected.
  const studentIds = useMemo(
    () => selectedStudents.map((s) => s.id),
    [selectedStudents],
  );
  const shortlistsQuery = api.students.shortlistsForStudents.useQuery(
    { studentIds },
    { enabled: studentIds.length > 0 },
  );
  // Where each program stands for the selected students: a partner pick
  // waiting on us, ours rejected or awaiting the partner, or approved.
  const shortlisted = useMemo(() => {
    const m = new Map<number, ShortlistState>();
    if (studentIds.length === 0) return m;
    const rank: Record<ShortlistState, number> = {
      none: 0,
      done: 1,
      pending: 2,
      rejected: 3,
      pick: 4,
    };
    for (const r of shortlistsQuery.data ?? []) {
      const state: ShortlistState =
        r.approvalStatus === ShortlistApproval.APPROVED
          ? "done"
          : r.byPartner
            ? "pick"
            : r.approvalStatus === ShortlistApproval.REJECTED
              ? "rejected"
              : "pending";
      const prev = m.get(r.courseId) ?? "none";
      m.set(r.courseId, rank[state] > rank[prev] ? state : prev);
    }
    return m;
  }, [shortlistsQuery.data, studentIds]);

  const filtered = useMemo(
    () =>
      sortPrograms(
        applyFilters(courses.data ?? [], applied, rates),
        sortBy,
        applied.tuitionCurrency,
        rates,
      ),
    [courses.data, applied, sortBy, rates],
  );
  const brackets = useMemo(
    () => bracketsFor(money.data?.brackets ?? {}, form.tuitionCurrency),
    [money.data, form.tuitionCurrency],
  );
  const ratesMissing = money.isSuccess && Object.keys(rates).length === 0;

  useEffect(() => {
    setPage(1);
  }, [applied, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / RESULTS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const visible = showAll
    ? filtered
    : filtered.slice(
        (safePage - 1) * RESULTS_PER_PAGE,
        safePage * RESULTS_PER_PAGE,
      );

  // ---- Filter helpers ----

  const engTestMeta = ENG_TESTS.find((t) => t.value === form.engTest);
  const engScoreError = useMemo(() => {
    if (!engTestMeta || !form.engScore.trim()) return null;
    const n = Number(form.engScore);
    if (Number.isNaN(n) || n < engTestMeta.min || n > engTestMeta.max) {
      return `Score must be between ${engTestMeta.min} and ${engTestMeta.max}`;
    }
    const steps = Math.round((n - engTestMeta.min) / engTestMeta.step);
    if (Math.abs(steps * engTestMeta.step + engTestMeta.min - n) > 1e-9) {
      return `Score must be in increments of ${engTestMeta.step}`;
    }
    return null;
  }, [engTestMeta, form.engScore]);

  // Instant-apply for click-driven filters. Typed fields stay form-only until
  // Search.
  const setFilter = (patch: Partial<FilterState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setApplied((prev) => ({ ...prev, ...patch }));
  };

  const handleSearch = () => {
    if (engScoreError) {
      showToast(engScoreError);
      return;
    }
    setApplied(form);
  };

  const handleReset = () => {
    setForm(emptyFilters());
    setApplied(emptyFilters());
    setSortBy("relevance");
    setShowAll(false);
  };

  const createTemplate = api.universities.createSearchTemplate.useMutation({
    onSuccess: async (_data, vars) => {
      await utils.universities.listSearchTemplates.invalidate();
      showToast(`Search template “${vars.name}” saved`);
    },
    onError: (e) => showToast(e.message),
  });
  const deleteTemplate = api.universities.deleteSearchTemplate.useMutation({
    onSuccess: async () => {
      await utils.universities.listSearchTemplates.invalidate();
      showToast("Template deleted");
    },
    onError: (e) => showToast(e.message),
  });

  const applyTemplate = (t: SearchTemplate) => {
    const filters = templateToFilters(t);
    setForm(filters);
    setApplied(filters);
    if (
      filters.duration ||
      filters.engTest ||
      filters.fasterTat ||
      filters.tuitionMin ||
      filters.tuitionMax ||
      filters.stem.yes ||
      filters.stem.no ||
      filters.feeWaiver.yes ||
      filters.feeWaiver.no ||
      filters.scholarship.yes ||
      filters.scholarship.no ||
      filters.open.yes ||
      filters.open.no
    ) {
      setAdvancedOpen(true);
    }
    showToast(`Loaded: ${t.name}`);
  };

  const handleSaveTemplate = (name: string) => {
    createTemplate.mutate({ name, filters: form });
  };

  const handleDeleteTemplate = (id: number) => {
    deleteTemplate.mutate({ id });
  };

  // ---- Shortlist ----

  // Optimistic add/remove against the current selection's query key so the
  // bookmark buttons flip instantly.
  const addShortlistMut = api.students.addShortlist.useMutation({
    onMutate: async (vars) => {
      await utils.students.shortlistsForStudents.cancel({ studentIds });
      const prev = utils.students.shortlistsForStudents.getData({ studentIds });
      utils.students.shortlistsForStudents.setData({ studentIds }, (old) => {
        // Shortlisting a partner's pick approves it; the rest are new rows
        // awaiting the partner.
        const rows = (old ?? []).map((r) =>
          r.courseId === vars.courseId &&
          r.byPartner &&
          vars.studentIds.includes(r.studentId)
            ? { ...r, approvalStatus: ShortlistApproval.APPROVED as number }
            : r,
        );
        const have = new Set(
          rows.filter((r) => r.courseId === vars.courseId).map((r) => r.studentId),
        );
        return [
          ...rows,
          ...vars.studentIds
            .filter((id) => !have.has(id))
            .map((studentId) => ({
              studentId,
              courseId: vars.courseId,
              byPartner: false,
              approvalStatus: ShortlistApproval.PENDING as number,
            })),
        ];
      });
      return { prev };
    },
    onSuccess: (res) => {
      const parts: string[] = [];
      if (res.added > 0) {
        parts.push(
          res.awaitingPartner > 0
            ? `Shortlisted for ${selectedStudents.map(studentName).join(", ")}, awaiting partner approval`
            : `Shortlisted for ${selectedStudents.map(studentName).join(", ")}`,
        );
      }
      if (res.approvedPartnerPicks > 0) {
        parts.push(
          `Approved ${res.approvedPartnerPicks === 1 ? "the partner's pick" : `${res.approvedPartnerPicks} partner picks`}`,
        );
      }
      showToast(parts.join(". ") || "Already shortlisted");
    },
    onError: (e, _vars, mutCtx) => {
      utils.students.shortlistsForStudents.setData({ studentIds }, mutCtx?.prev);
      showToast(e.message);
    },
    onSettled: () => void utils.students.shortlistsForStudents.invalidate(),
  });
  const removeShortlistMut = api.students.removeShortlist.useMutation({
    onMutate: async (vars) => {
      await utils.students.shortlistsForStudents.cancel({ studentIds });
      const prev = utils.students.shortlistsForStudents.getData({ studentIds });
      utils.students.shortlistsForStudents.setData({ studentIds }, (old) =>
        (old ?? []).filter((r) => r.courseId !== vars.courseId),
      );
      return { prev };
    },
    onError: (e, _vars, mutCtx) => {
      utils.students.shortlistsForStudents.setData({ studentIds }, mutCtx?.prev);
      showToast(e.message);
    },
    onSettled: () => void utils.students.shortlistsForStudents.invalidate(),
  });

  const toggleShortlist = (p: Program) => {
    if (selectedStudents.length === 0) {
      showToast("Please select a student first");
      return;
    }
    const state = shortlisted.get(p.id) ?? "none";
    if (state === "pick" || state === "none") {
      // Adds it for the selected students and approves any partner picks.
      addShortlistMut.mutate({ studentIds, courseId: p.id });
    } else {
      removeShortlistMut.mutate({ studentIds, courseId: p.id });
      showToast("Removed from shortlist");
    }
  };

  // ---- Download (one student's shortlist only) ----

  const openDownload = async () => {
    if (selectedStudents.length === 0) {
      showToast(
        "Select a student first. Only programs on the student's shortlist can be downloaded.",
      );
      return;
    }
    if (selectedStudents.length > 1) {
      showToast("Select just one student. Downloads are one student's shortlist at a time.");
      return;
    }
    const student = selectedStudents[0]!;
    // Rejected picks stay on the shortlist (re-propose) but aren't options.
    const ids = (shortlistsQuery.data ?? [])
      .filter(
        (r) =>
          r.studentId === student.id &&
          r.approvalStatus !== ShortlistApproval.REJECTED,
      )
      .map((r) => r.courseId);
    if (ids.length === 0) {
      showToast(
        `Nothing is shortlisted for ${studentName(student)} yet. Shortlist programs first, then download.`,
      );
      return;
    }
    try {
      const rows = await utils.universities.listCourses.fetch({ ids });
      setDownloadPrograms(sortPrograms(rows, "relevance", applied.tuitionCurrency, rates));
      setDownloadOpen(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't load the shortlist");
    }
  };

  // ---- Filter options derived from data ----

  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    for (const p of courses.data ?? []) {
      if (p.intakeYear !== null) years.add(p.intakeYear);
    }
    return [...years].sort().map((y) => ({ value: String(y), label: String(y) }));
  }, [courses.data]);

  const countryOptions = useMemo(() => {
    const codes = new Set<string>();
    for (const p of courses.data ?? []) {
      if (p.university) codes.add(p.university.country);
    }
    return [...codes].sort().map((c) => ({
      value: c,
      label: `${flagEmoji(c)} ${COUNTRY_NAME[c] ?? c}`,
    }));
  }, [courses.data]);

  const chips = useMemo(
    () => buildChips(applied, bracketsFor(money.data?.brackets ?? {}, applied.tuitionCurrency)),
    [applied, money.data],
  );

  const removeChip = (chip: FilterChip) => {
    setForm((prev) => chip.clear(prev));
    setApplied((prev) => chip.clear(prev));
  };

  // ---- Render ----

  return (
    <>
      {/* Student context banner (arrived via ?student=<id>) */}
      {linkedStudent && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[#B2DDFF] bg-[#EFF8FF] px-5 py-3">
          <div className="flex items-center gap-2.5 text-sm text-[#344054]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1570EF"
              strokeWidth={2}
              className="h-[18px] w-[18px]"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>
              Shortlisting for{" "}
              <strong className="text-[#101828]">
                {studentName(linkedStudent)}
              </strong>{" "}
              <span className="text-xs text-[#667085]">
                {studentDisplayId(linkedStudent.id)}
              </span>
            </span>
          </div>
          <Link
            href="/admin/students"
            className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1570EF] hover:underline"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="h-3.5 w-3.5"
            >
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Back to Students
          </Link>
        </div>
      )}

      {/* Page header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Uni Assist</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Search universities and courses worldwide for any student
          </p>
        </div>
        <StudentSelector
          students={students.data ?? []}
          selected={selectedStudents}
          onChange={setSelectedStudents}
        />
      </div>

      {/* Search & filter card */}
      <div className="mb-4 rounded-[14px] border border-[#E4E7EC] bg-white p-6">
        <div className="mb-4 flex h-11 items-center gap-2.5 rounded-lg border border-[#D0D5DD] px-3.5 transition-all focus-within:border-[#1570EF] focus-within:shadow-[0_0_0_3px_rgba(21,112,239,0.1)]">
          <SearchIcon className="h-5 w-5 stroke-[#98A2B3]" />
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

        <div className="flex flex-wrap items-center gap-2.5">
          <MultiSelect
            placeholder="Intake"
            options={INTAKE_MONTHS.map((m) => ({
              value: m,
              label: MONTH_FULL[m] ?? m,
            }))}
            selected={form.intakeMonths}
            onChange={(intakeMonths) => setFilter({ intakeMonths })}
          />
          <FilterPill
            value={form.intakeYear}
            onChange={(intakeYear) => setFilter({ intakeYear })}
            options={yearOptions}
            placeholder="Year"
          />
          <FilterPill
            value={form.degreeLevel}
            onChange={(degreeLevel) => setFilter({ degreeLevel })}
            options={DEGREE_LEVELS.map((d) => ({
              value: String(d.code),
              label: d.label,
            }))}
            placeholder="Study Level"
          />
          <MultiSelect
            placeholder="Country"
            options={countryOptions}
            selected={form.countries}
            onChange={(countries) => setFilter({ countries })}
          />
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-4 py-2.5 text-[13px] font-semibold transition-colors ${
              advancedOpen
                ? "border-[#1570EF] bg-[#EFF8FF] text-[#1570EF]"
                : "border-[#D0D5DD] bg-white text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            Advanced
          </button>

          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setSaveOpen(true)}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#FEDF89] bg-white px-3.5 py-2.5 text-[13px] font-semibold text-[#DC6803] hover:border-[#F79009] hover:bg-[#FFFCF5]"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="h-3.5 w-3.5"
              >
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              Save
            </button>
            <button
              type="button"
              onClick={() => setLoadOpen(true)}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#D0D5DD] bg-white px-3.5 py-2.5 text-[13px] font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="h-3.5 w-3.5"
              >
                <path d="M3 15v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              Load
            </button>
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

        {/* Advanced filters */}
        {advancedOpen && (
          <div className="mt-4 border-t border-[#E4E7EC] pt-4">
            <div className="mb-3.5 text-[13px] font-semibold text-[#101828]">
              Advanced Filters
            </div>
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
              <AdvField label="Duration">
                <FormSelect
                  options={DURATION_OPTIONS}
                  placeholder="Any"
                  value={form.duration}
                  onChange={(e) => setFilter({ duration: e.target.value })}
                  className="!h-[38px] !text-[13px]"
                />
              </AdvField>
              <AdvField label="English Proficiency Test">
                <div className="flex gap-2">
                  <FormSelect
                    options={ENG_TESTS.map((t) => ({
                      value: t.value,
                      label: t.label,
                    }))}
                    placeholder="Any test"
                    value={form.engTest}
                    onChange={(e) =>
                      setFilter({
                        engTest: e.target.value as "" | EngTest,
                        engScore: "",
                      })
                    }
                    className="!h-[38px] !text-[13px]"
                  />
                  {engTestMeta && (
                    <div className="w-[110px] shrink-0">
                      <input
                        value={form.engScore}
                        onChange={(e) =>
                          setForm({ ...form, engScore: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSearch();
                        }}
                        placeholder={`e.g. ${engTestMeta.placeholder}`}
                        className={`h-[38px] w-full rounded-lg border px-3 text-center text-[13px] text-[#344054] outline-none focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.1)] ${
                          engScoreError ? "border-[#F04438]" : "border-[#D0D5DD]"
                        }`}
                      />
                    </div>
                  )}
                </div>
                {engTestMeta && (
                  <div
                    className={`mt-1 text-[11px] ${engScoreError ? "text-[#F04438]" : "text-[#667085]"}`}
                  >
                    {engScoreError ??
                      `Shows programs requiring ${engTestMeta.label} ≤ your score (${engTestMeta.min}–${engTestMeta.max})`}
                  </div>
                )}
              </AdvField>
              <AdvField label="STEM Programs">
                <TriToggle
                  value={form.stem}
                  onChange={(stem) => setFilter({ stem })}
                />
              </AdvField>
              <AdvField label="Application Fee Waiver">
                <TriToggle
                  value={form.feeWaiver}
                  onChange={(feeWaiver) => setFilter({ feeWaiver })}
                />
              </AdvField>
              <AdvField label="Scholarship Available">
                <TriToggle
                  value={form.scholarship}
                  onChange={(scholarship) => setFilter({ scholarship })}
                />
              </AdvField>
              <AdvField label="Open Programs">
                <TriToggle
                  value={form.open}
                  onChange={(open) => setFilter({ open })}
                />
              </AdvField>
              <AdvField label="Faster TAT">
                <FormSelect
                  options={FASTER_TAT_FILTER}
                  placeholder="Any"
                  value={form.fasterTat}
                  onChange={(e) => setFilter({ fasterTat: e.target.value })}
                  className="!h-[38px] !text-[13px]"
                />
              </AdvField>
              {/* Tuition range: brackets from Settings, in the Fees-in currency */}
              <AdvField label={`Tuition Range (${form.tuitionCurrency})`}>
                <FormSelect
                  options={brackets.map((b) => ({
                    value: bracketKey(b.min, b.max),
                    label: b.label,
                  }))}
                  placeholder={brackets.length ? "Any" : "No brackets configured"}
                  value={bracketKey(form.tuitionMin, form.tuitionMax)}
                  onChange={(e) => {
                    const b = brackets.find(
                      (x) => bracketKey(x.min, x.max) === e.target.value,
                    );
                    setFilter({ tuitionMin: b?.min ?? "", tuitionMax: b?.max ?? "" });
                  }}
                  className="!h-[38px] !text-[13px]"
                />
                <div className="mt-1 text-[11px] text-[#667085] italic">
                  Fees in other currencies are converted to{" "}
                  {form.tuitionCurrency} (approximate) for filtering.
                </div>
              </AdvField>
            </div>
          </div>
        )}
      </div>

      {/* Results bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="text-sm font-semibold text-[#344054]">
            {courses.isLoading
              ? "Searching…"
              : showAll
                ? `Showing all ${filtered.length} programs`
                : `Showing ${filtered.length} program${filtered.length === 1 ? "" : "s"}`}
          </div>
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <span
                  key={chip.key}
                  className="flex items-center gap-1.5 rounded-2xl border border-[#B2DDFF] bg-[#EFF8FF] py-1 pr-2 pl-3 text-xs font-medium text-[#1570EF]"
                >
                  {chip.label}
                  <button
                    type="button"
                    aria-label={`Remove ${chip.label} filter`}
                    onClick={() => removeChip(chip)}
                    className="flex cursor-pointer items-center"
                  >
                    <svg
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      className="h-2.5 w-2.5"
                    >
                      <line x1="2" y1="2" x2="10" y2="10" />
                      <line x1="10" y1="2" x2="2" y2="10" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void openDownload()}
            title="Download the selected student's shortlisted programs (up to 10)"
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#D0D5DD] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="h-3.5 w-3.5"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </button>
          <span className="text-xs font-medium text-[#667085]">Fees in:</span>
          <FormSelect
            options={DISPLAY_CURRENCIES.map((c) => ({ value: c, label: c }))}
            value={form.tuitionCurrency}
            // A bracket belongs to one currency, so switching clears it.
            onChange={(e) =>
              setFilter({ tuitionCurrency: e.target.value, tuitionMin: "", tuitionMax: "" })
            }
            className="!h-[36px] !text-xs"
          />
          <span className="text-xs font-medium text-[#667085]">Sort by:</span>
          <FormSelect
            options={[
              { value: "relevance", label: "Relevance" },
              { value: "tuition-asc", label: "Tuition: Low to High" },
              { value: "tuition-desc", label: "Tuition: High to Low" },
              { value: "uni-az", label: "University A–Z" },
            ]}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="!h-[36px] !text-xs"
          />
        </div>
      </div>

      {ratesMissing && (
        <div className="mb-3 rounded-lg border border-[#FEDF89] bg-[#FFFAEB] px-4 py-2.5 text-[13px] text-[#B54708]">
          Exchange rates aren&apos;t loaded, so fees can&apos;t be converted
          between currencies. Refresh them in Settings → Exchange Rates.
        </div>
      )}

      {/* Results */}
      {courses.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
          {courses.error.message}
        </div>
      ) : courses.isLoading ? (
        <div className="rounded-2xl border border-dashed border-[#D0D5DD] bg-white p-12 text-center text-sm text-[#98A2B3]">
          Loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#D0D5DD] bg-white p-12 text-center">
          <div className="text-sm font-semibold text-[#667085]">
            No programs found
          </div>
          <div className="mt-1 text-xs text-[#98A2B3]">
            Try adjusting your search criteria or filters.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((p) => (
            <ProgramCard
              key={p.id}
              program={p}
              shortlistState={shortlisted.get(p.id) ?? "none"}
              canShortlist={selectedStudents.length > 0}
              onToggleShortlist={() => toggleShortlist(p)}
              displayCurrency={applied.tuitionCurrency}
              rates={rates}
            />
          ))}
        </div>
      )}

      {/* Can't find course banner */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#D0D5DD] bg-white px-5 py-3.5 text-sm text-[#667085]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#98A2B3"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        Can&apos;t find the course you&apos;re looking for?
        <button
          type="button"
          onClick={() => setSubmitOpen(true)}
          className="cursor-pointer font-semibold text-[#1570EF] hover:underline"
        >
          Click here to submit a course
        </button>
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          {showAll ? (
            <div />
          ) : (
            <Pagination
              page={safePage}
              totalPages={totalPages}
              onPage={(p) => {
                setPage(p);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          )}
          {filtered.length > RESULTS_PER_PAGE && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-[13px] font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
            >
              {showAll ? "Show Paginated" : "Show All Results"}
            </button>
          )}
        </div>
      )}

      {/* Dialogs */}
      <DownloadDialog
        open={downloadOpen}
        onClose={() => setDownloadOpen(false)}
        programs={downloadPrograms}
        studentName={selectedStudents.length === 1 ? studentName(selectedStudents[0]!) : ""}
        displayCurrency={applied.tuitionCurrency}
        rates={rates}
        onDone={showToast}
      />
      <SaveTemplateDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        onSave={handleSaveTemplate}
      />
      <LoadTemplateDialog
        open={loadOpen}
        onClose={() => setLoadOpen(false)}
        templates={templates.data ?? []}
        loading={templates.isLoading}
        onLoad={applyTemplate}
        onDelete={handleDeleteTemplate}
      />
      <SubmitCourseDialog
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
      />

      <Toast
        message={toastMsg}
        open={toastOpen}
        onClose={() => setToastOpen(false)}
      />
    </>
  );
}

// ----- Filter chips ---------------------------------------------------------

interface FilterChip {
  key: string;
  label: string;
  clear: (f: FilterState) => FilterState;
}

function triLabel(name: string, t: TriState): string | null {
  if (t.yes === t.no) return null;
  return `${name}: ${t.yes ? "Yes" : "No"}`;
}

function buildChips(f: FilterState, brackets: TuitionBracket[]): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.query.trim()) {
    chips.push({
      key: "query",
      label: f.query.trim(),
      clear: (s) => ({ ...s, query: "" }),
    });
  }
  for (const m of f.intakeMonths) {
    chips.push({
      key: `month-${m}`,
      label: MONTH_FULL[m] ?? m,
      clear: (s) => ({
        ...s,
        intakeMonths: s.intakeMonths.filter((x) => x !== m),
      }),
    });
  }
  if (f.intakeYear) {
    chips.push({
      key: "year",
      label: f.intakeYear,
      clear: (s) => ({ ...s, intakeYear: "" }),
    });
  }
  if (f.degreeLevel !== "") {
    chips.push({
      key: "level",
      label: degreeLabel(Number(f.degreeLevel)),
      clear: (s) => ({ ...s, degreeLevel: "" }),
    });
  }
  for (const c of f.countries) {
    chips.push({
      key: `country-${c}`,
      label: COUNTRY_NAME[c] ?? c,
      clear: (s) => ({ ...s, countries: s.countries.filter((x) => x !== c) }),
    });
  }
  if (f.duration) {
    const opt = DURATION_OPTIONS.find((d) => d.value === f.duration);
    chips.push({
      key: "duration",
      label: opt?.label ?? formatDuration(Number(f.duration)),
      clear: (s) => ({ ...s, duration: "" }),
    });
  }
  if (f.engTest && f.engScore.trim()) {
    chips.push({
      key: "eng",
      label: `${f.engTest} ${f.engScore.trim()}`,
      clear: (s) => ({ ...s, engTest: "", engScore: "" }),
    });
  }
  const tris: Array<[string, keyof FilterState & ("stem" | "feeWaiver" | "scholarship" | "open"), string]> = [
    ["stem", "stem", "STEM"],
    ["feeWaiver", "feeWaiver", "Fee Waiver"],
    ["scholarship", "scholarship", "Scholarship"],
    ["open", "open", "Open"],
  ];
  for (const [key, field, name] of tris) {
    const label = triLabel(name, f[field]);
    if (label) {
      chips.push({
        key,
        label,
        clear: (s) => ({ ...s, [field]: emptyTri() }),
      });
    }
  }
  if (f.fasterTat) {
    const opt = FASTER_TAT_FILTER.find((o) => o.value === f.fasterTat);
    chips.push({
      key: "fasterTat",
      label: `Faster TAT: ${opt?.label ?? f.fasterTat}`,
      clear: (s) => ({ ...s, fasterTat: "" }),
    });
  }
  if (f.tuitionMin || f.tuitionMax) {
    // A saved template's bounds may not match a current bracket.
    const b = brackets.find((x) => x.min === f.tuitionMin && x.max === f.tuitionMax);
    const min = f.tuitionMin ? formatMoney(Number(f.tuitionMin), f.tuitionCurrency) : null;
    const max = f.tuitionMax ? formatMoney(Number(f.tuitionMax), f.tuitionCurrency) : null;
    chips.push({
      key: "tuition",
      label: `Tuition: ${b?.label ?? (min && max ? `${min} – ${max}` : min ? `${min} and above` : `Under ${max}`)}`,
      clear: (s) => ({ ...s, tuitionMin: "", tuitionMax: "" }),
    });
  }
  return chips;
}

// ----- Student selector -----------------------------------------------------

function StudentSelector({
  students,
  selected,
  onChange,
}: {
  students: StudentLite[];
  selected: StudentLite[];
  onChange: (next: StudentLite[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const toggle = (s: StudentLite) => {
    const isSelected = selected.some((x) => x.id === s.id);
    onChange(
      isSelected ? selected.filter((x) => x.id !== s.id) : [...selected, s],
    );
  };

  const q = search.trim().toLowerCase();
  const options = q
    ? students.filter(
        (s) =>
          studentName(s).toLowerCase().includes(q) ||
          studentDisplayId(s.id).toLowerCase().includes(q),
      )
    : students;

  return (
    <div className="min-w-[240px]">
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            setSearch("");
          }}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-[#D0D5DD] bg-white px-3.5 py-2 text-sm text-[#344054] transition-colors hover:border-[#1570EF]"
        >
          {selected.length === 1 ? (
            <StudentAvatar student={selected[0]!} />
          ) : (
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ${
                selected.length > 1
                  ? "bg-[#1570EF]"
                  : "bg-gradient-to-br from-[#98A2B3] to-[#667085]"
              }`}
            >
              {selected.length > 1 ? (
                selected.length
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth={2}
                  className="h-3.5 w-3.5"
                >
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              )}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {selected.length === 0 ? (
              <span className="text-[#667085]">Select Student (optional)</span>
            ) : selected.length === 1 ? (
              <>
                {studentName(selected[0]!)}{" "}
                <span className="text-[11px] text-[#98A2B3]">
                  {studentDisplayId(selected[0]!.id)}
                </span>
              </>
            ) : (
              `${selected.length} Students`
            )}
          </span>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="#98A2B3"
            strokeWidth={1.5}
            className="h-3.5 w-3.5 shrink-0"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>

        {open && (
          <div className="absolute top-[calc(100%+4px)] right-0 z-[80] min-w-[280px] overflow-hidden rounded-[10px] border border-[#E4E7EC] bg-white shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search students..."
              className="w-full border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-[13px] text-[#101828] outline-none placeholder:text-[#98A2B3]"
            />
            <div className="max-h-[240px] overflow-y-auto">
              {options.length === 0 ? (
                <div className="px-3.5 py-4 text-center text-[13px] text-[#98A2B3]">
                  No students found
                </div>
              ) : (
                options.map((s) => {
                  const isSelected = selected.some((x) => x.id === s.id);
                  return (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => toggle(s)}
                      className={`flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-[#F0F7FF] hover:text-[#1570EF] ${
                        isSelected
                          ? "bg-[#EFF8FF] font-semibold text-[#1570EF]"
                          : "text-[#344054]"
                      }`}
                    >
                      <StudentAvatar student={s} />
                      <span className="min-w-0 flex-1 truncate">
                        {studentName(s)}{" "}
                        <span className="text-xs font-normal text-[#98A2B3]">
                          {studentDisplayId(s.id)}
                        </span>
                      </span>
                      {isSelected && (
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#1570EF"
                          strokeWidth={2.5}
                          className="h-4 w-4 shrink-0"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="mt-2 flex max-w-[320px] flex-wrap justify-end gap-1.5">
          {selected.map((s) => (
            <span
              key={s.id}
              className="flex items-center gap-1.5 rounded-2xl border border-[#B2DDFF] bg-[#EFF8FF] py-1 pr-2.5 pl-1 text-xs font-medium text-[#1570EF]"
            >
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full text-[8px] font-semibold text-white"
                style={{ background: studentColor(studentName(s)) }}
              >
                {studentInitials(s)}
              </span>
              {studentName(s)}
              <button
                type="button"
                aria-label={`Remove ${studentName(s)}`}
                onClick={() => onChange(selected.filter((x) => x.id !== s.id))}
                className="flex cursor-pointer items-center"
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  className="h-2.5 w-2.5"
                >
                  <line x1="2" y1="2" x2="10" y2="10" />
                  <line x1="10" y1="2" x2="2" y2="10" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StudentAvatar({ student }: { student: StudentLite }) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
      style={{ background: studentColor(studentName(student)) }}
    >
      {studentInitials(student)}
    </span>
  );
}

// ----- Multi-select dropdown ------------------------------------------------

function MultiSelect({
  placeholder,
  options,
  selected,
  onChange,
}: {
  placeholder: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const allSelected =
    options.length > 0 && selected.length === options.length;

  const toggleOption = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-[38px] min-w-[140px] cursor-pointer items-center gap-2 rounded-lg border bg-white px-3.5 text-[13px] font-medium transition-colors hover:border-[#1570EF] ${
          open || selected.length > 0
            ? "border-[#1570EF] text-[#1570EF]"
            : "border-[#D0D5DD] text-[#344054]"
        }`}
      >
        {placeholder}
        {selected.length > 0 && (
          <span className="min-w-[18px] rounded-[10px] bg-[#1570EF] px-1.5 py-px text-center text-[11px] font-semibold text-white">
            {selected.length}
          </span>
        )}
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="#98A2B3"
          strokeWidth={1.5}
          className="ml-auto h-3 w-3"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-[calc(100%+4px)] left-0 z-[80] flex min-w-[220px] flex-col overflow-hidden rounded-[10px] border border-[#E4E7EC] bg-white shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
          <div className="max-h-[260px] overflow-y-auto py-1.5">
            <MsOption
              label="All"
              checked={allSelected}
              onClick={() =>
                onChange(allSelected ? [] : options.map((o) => o.value))
              }
              className="border-b border-[#E4E7EC] font-semibold"
            />
            {options.map((o) => (
              <MsOption
                key={o.value}
                label={o.label}
                checked={selected.includes(o.value)}
                onClick={() => toggleOption(o.value)}
              />
            ))}
          </div>
          <div className="border-t border-[#E4E7EC] p-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full cursor-pointer rounded-md bg-[#1570EF] py-1.5 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MsOption({
  label,
  checked,
  onClick,
  className = "",
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-[#344054] transition-colors hover:bg-[#F0F7FF] ${className}`}
    >
      <span
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2 transition-colors ${
          checked ? "border-[#1570EF] bg-[#1570EF]" : "border-[#D0D5DD]"
        }`}
      >
        {checked && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth={3}
            className="h-3 w-3"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      {label}
    </button>
  );
}

// ----- Single-select filter pill (same pattern as the partner page) ---------

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
        className={`h-[38px] min-w-[140px] cursor-pointer appearance-none rounded-lg border bg-white pr-9 pl-3 text-[13px] font-medium transition-colors hover:border-[#1570EF] focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.1)] focus:outline-none ${
          isAny ? "border-[#D0D5DD] text-[#344054]" : "border-[#1570EF] text-[#1570EF]"
        }`}
      >
        <option value="">{placeholder}</option>
        {options
          .filter((o) => o.value !== "")
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </select>
      <div className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="#98A2B3"
          strokeWidth={1.5}
          className="h-3 w-3"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </div>
      {/* Render the selected label over the select so flag emojis show on
          Safari, which doesn't render emoji in <option> consistently. */}
      {!isAny && selected && (
        <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center bg-white pr-1 text-[13px] font-medium text-[#1570EF]">
          {selected.label}
        </div>
      )}
    </div>
  );
}

// ----- Yes / No tri-state toggle ---------------------------------------------

function TriToggle({
  value,
  onChange,
}: {
  value: TriState;
  onChange: (next: TriState) => void;
}) {
  return (
    <div className="flex h-[38px] overflow-hidden rounded-lg border border-[#D0D5DD]">
      <button
        type="button"
        onClick={() => onChange({ ...value, yes: !value.yes })}
        className={`flex-1 cursor-pointer border-r border-[#D0D5DD] px-3.5 text-[13px] font-medium transition-colors ${
          value.yes
            ? "bg-[#1570EF] text-white"
            : "bg-white text-[#667085] hover:bg-[#F9FAFB]"
        }`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => onChange({ ...value, no: !value.no })}
        className={`flex-1 cursor-pointer px-3.5 text-[13px] font-medium transition-colors ${
          value.no
            ? "bg-[#1570EF] text-white"
            : "bg-white text-[#667085] hover:bg-[#F9FAFB]"
        }`}
      >
        No
      </button>
    </div>
  );
}

function AdvField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-[#667085]">{label}</div>
      {children}
    </div>
  );
}

// ----- Program card (mirrors the partner page card, plus admin shortlist) ----

// Shortlist button state for the selected students (most actionable wins).
type ShortlistState = "none" | "done" | "pending" | "rejected" | "pick";

const SHORTLIST_BUTTON: Record<
  Exclude<ShortlistState, "none">,
  { label: string; title: string; className: string }
> = {
  done: {
    label: "Shortlisted",
    title: "Approved. Start the application from the student's Application tab. Click to remove.",
    className: "border-[#A6F4C5] bg-[#ECFDF3] text-[#067647]",
  },
  pending: {
    label: "Awaiting partner",
    title: "Shortlisted. The partner approves it before an application can start. Click to remove.",
    className: "border-[#FEDF89] bg-[#FFFAEB] text-[#B54708]",
  },
  rejected: {
    label: "Rejected by partner",
    title: "The partner rejected this. Re-propose it from the student's Application tab, or click to remove.",
    className: "border-[#FECDCA] bg-[#FEF3F2] text-[#B42318]",
  },
  pick: {
    label: "Approve partner pick",
    title: "The partner proposed this program. Click to approve it.",
    className: "border-[#D9D6FE] bg-[#F4F3FF] text-[#5925DC]",
  },
};

function ProgramCard({
  program,
  shortlistState,
  canShortlist,
  onToggleShortlist,
  displayCurrency,
  rates,
}: {
  program: Program;
  shortlistState: ShortlistState;
  canShortlist: boolean;
  onToggleShortlist: () => void;
  displayCurrency: string;
  rates: Record<string, number>;
}) {
  const uni = program.university;
  const tags = collectTags(program);
  const shortlisted = shortlistState !== "none";
  const button = shortlistState === "none" ? null : SHORTLIST_BUTTON[shortlistState];
  const tuition =
    program.tuitionFee === null ? null : formatMoney(program.tuitionFee, program.currency);
  const tuitionApprox = approxIn(program.tuitionFee, program.currency, displayCurrency, rates);
  const appFee = appFeeOnly(program.appFee, program.currency);
  const intake = formatIntake(program.intakeMonth, program.intakeYear);
  const duration = program.durationMonths
    ? formatDuration(program.durationMonths)
    : null;
  const level = degreeLabel(program.degreeLevel);

  return (
    <div className="flex flex-wrap items-center gap-5 rounded-2xl border border-[#E4E7EC] bg-white p-5 transition-all hover:border-[#B2DDFF] hover:shadow-[0_4px_16px_rgba(21,112,239,0.06)]">
      <div className="flex min-w-[220px] flex-shrink-0 items-center gap-3.5">
        <UniLogo name={uni?.name ?? "?"} logoUrl={uni?.logoUrl} size={48} />
        <div className="min-w-0">
          <div className="text-sm leading-tight font-semibold text-[#101828]">
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
          {level && <MetaItem>{level}</MetaItem>}
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
              Tuition Fee: {tuition}
              {tuitionApprox && (
                <span
                  className="font-normal text-[#667085]"
                  title={`Approximate, converted to ${displayCurrency} at mid-market rates`}
                >
                  ({tuitionApprox})
                </span>
              )}
            </MetaItem>
          )}
          {appFee && <MetaItem>Application Fee: {appFee}</MetaItem>}
        </div>
      </div>

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
          title={
            canShortlist
              ? button?.title
              : "Select a student first to shortlist this program"
          }
          aria-disabled={!canShortlist}
          className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-[13px] font-semibold transition-colors ${
            !canShortlist
              ? "cursor-not-allowed border-[#EAECF0] bg-[#F9FAFB] text-[#98A2B3]"
              : button
                ? `cursor-pointer ${button.className}`
                : "cursor-pointer border-[#D0D5DD] bg-white text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            fill={shortlisted && canShortlist ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={2}
            className="h-3.5 w-3.5"
          >
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          {canShortlist && button ? button.label : "Shortlist"}
        </button>
      </div>
    </div>
  );
}

type TagTone =
  | "scholarship"
  | "stem"
  | "feewaiver"
  | "coop"
  | "open"
  | "tat"
  | "closed";

function collectTags(p: Program): Array<{ label: string; tone: TagTone }> {
  const out: Array<{ label: string; tone: TagTone }> = [];
  if (p.hasScholarship) out.push({ label: "Scholarship", tone: "scholarship" });
  if (p.isStem) out.push({ label: "STEM", tone: "stem" });
  if (p.hasAppFeeWaiver) out.push({ label: "Fee Waiver", tone: "feewaiver" });
  if (p.isCoopAvailable) out.push({ label: "Co-op", tone: "coop" });
  const tat = fasterTatTag(p.fasterTat);
  if (tat) out.push({ label: tat, tone: "tat" });
  // Admins manage the catalogue, so closed programs surface too (the partner
  // side only flags open ones).
  if (p.isOpen) out.push({ label: "Open", tone: "open" });
  else out.push({ label: "Closed", tone: "closed" });
  return out;
}

function Tag({ tone, children }: { tone: TagTone; children: ReactNode }) {
  const palette: Record<TagTone, string> = {
    scholarship: "bg-[#ECFDF3] text-[#12B76A]",
    stem: "bg-[#EFF8FF] text-[#1570EF]",
    feewaiver: "bg-[#FEF3F2] text-[#F04438]",
    coop: "bg-[#F9F5FF] text-[#7F56D9]",
    open: "bg-[#ECFDF3] text-[#027A48]",
    tat: "bg-[#FFFAEB] text-[#DC6803]",
    closed: "bg-[#F2F4F7] text-[#667085]",
  };
  return (
    <span
      className={`rounded-xl px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${palette[tone]}`}
    >
      {children}
    </span>
  );
}

// ----- Pagination ------------------------------------------------------------

function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return <div />;

  const items: Array<number | "…"> = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
      items.push(i);
    } else if (items[items.length - 1] !== "…") {
      items.push("…");
    }
  }

  const navClass =
    "flex cursor-pointer items-center gap-1 rounded-lg border border-[#D0D5DD] bg-white px-3 py-2 text-[13px] font-medium text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#D0D5DD] disabled:hover:text-[#344054]";

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
        className={navClass}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="h-3 w-3"
        >
          <path d="M10 12L6 8l4-4" />
        </svg>
        Previous
      </button>
      {items.map((item, i) =>
        item === "…" ? (
          <span key={`e-${i}`} className="px-1 text-[13px] text-[#98A2B3]">
            …
          </span>
        ) : (
          <button
            type="button"
            key={item}
            onClick={() => onPage(item)}
            className={`h-9 min-w-9 cursor-pointer rounded-lg border px-2 text-[13px] font-medium transition-colors ${
              item === page
                ? "border-[#1570EF] bg-[#1570EF] text-white"
                : "border-[#D0D5DD] bg-white text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
            }`}
          >
            {item}
          </button>
        ),
      )}
      <button
        type="button"
        disabled={page === totalPages}
        onClick={() => onPage(page + 1)}
        className={navClass}
      >
        Next
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="h-3 w-3"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
    </div>
  );
}

// ----- Hooks / icons ----------------------------------------------------------

function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

function MetaItem({
  children,
  strong,
}: {
  children: ReactNode;
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

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} className={className}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
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
