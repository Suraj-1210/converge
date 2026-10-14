"use client";

import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "~/components/ui/button";
import { StatCard } from "~/components/ui/stat-card";
import { Toast } from "~/components/ui/toast";
import {
  CourseLevelLabel,
  StudentStatus,
  StudentStatusBadge,
  StudentStatusGroup,
  StudentStatusLabel,
  STUDENT_STATUS_CODES,
  studentStatusGroup,
  type CourseLevel,
} from "~/components/students/status";
import { api, type RouterOutputs } from "~/trpc/react";
import { Skeleton, SkeletonTable } from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";
import { stageLabel } from "~/components/dashboard/format";
import {
  AddStudentModal,
  COUNTRY_NAME,
  type CreatedStudent,
} from "./add-student-modal";
import { StudentCounsellor, StudentDocuments } from "./student-panel-extras";

type PartnerStudent = RouterOutputs["students"]["partnerList"][number];

// ----- Display helpers ------------------------------------------------------

// Deterministic avatar gradient per student id (mock assigns a fixed gradient
// per record; we derive it from the id so it is stable across reloads).
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg, #1570EF, #6941C6)",
  "linear-gradient(135deg, #F04438, #B42318)",
  "linear-gradient(135deg, #12B76A, #027A48)",
  "linear-gradient(135deg, #F79009, #B54708)",
  "linear-gradient(135deg, #7F56D9, #42307D)",
  "linear-gradient(135deg, #0BA5EC, #026AA2)",
  "linear-gradient(135deg, #F63D68, #C01048)",
  "linear-gradient(135deg, #667085, #344054)",
];

function avatarGradient(id: number): string {
  return (
    AVATAR_GRADIENTS[id % AVATAR_GRADIENTS.length] ??
    "linear-gradient(135deg, #667085, #344054)"
  );
}

// Relative time per the mock: Just now / N min ago / N hr ago / N day(s) ago,
// then an absolute "d MMM yyyy" date beyond 7 days.
function relativeTime(iso: string): string {
  const then = new Date(iso);
  const mins = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days <= 7) return days === 1 ? "1 day ago" : `${days} days ago`;
  return then.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function levelShort(level: number | null): string {
  if (level === null) return "—";
  const label: string | undefined = CourseLevelLabel[level as CourseLevel];
  return label ?? "—";
}

// University/program shown on the row: in-flight application (status < 20)
// at its furthest stage wins; otherwise any application; otherwise fall back
// to the pre-application program of interest.
function derivedApplication(s: PartnerStudent): {
  university: string;
  program: string;
} {
  const inFlight = s.applications.filter((a) => a.status < 20);
  const pick =
    inFlight.length > 0
      ? inFlight.reduce((best, a) => (a.status > best.status ? a : best))
      : s.applications[0];
  if (pick) return { university: pick.university, program: pick.program };
  return { university: "Not Assigned", program: s.interestedProgram ?? "—" };
}

// ----- Filters ----------------------------------------------------------------

interface Filters {
  search: string;
  intake: string;
  country: string;
  from: string;
  to: string;
}

const emptyFilters = (): Filters => ({
  search: "",
  intake: "",
  country: "",
  from: "",
  to: "",
});

// ----- Page --------------------------------------------------------------------

export default function PartnerStudentsPage() {
  const router = useRouter();
  const me = api.auth.me.useQuery(undefined, { retry: false });

  // Bounce away if approval state shifted (mirrors /partner/dashboard).
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/partner/dashboard") {
      router.replace(target);
    }
  }, [me.data?.redirectUrl, router]);

  const students = api.students.partnerList.useQuery();
  const rows = useMemo(() => students.data ?? [], [students.data]);

  const [filters, setFilters] = useState<Filters>(emptyFilters());
  // null = "All". Reset whenever the filter bar changes (mock behaviour).
  const [activePill, setActivePill] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [addOpen, setAddOpen] = useState(false);

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const [slideOverId, setSlideOverId] = useState<number | null>(null);
  const [morphId, setMorphId] = useState<number | null>(null);

  // Native View Transition: morph the clicked row's avatar into the slide-over.
  const openStudent = (id: number) => {
    const doc: Document & {
      startViewTransition?: (cb: () => void) => unknown;
    } = document;
    if (!doc.startViewTransition) {
      setSlideOverId(id);
      return;
    }
    flushSync(() => setMorphId(id));
    doc.startViewTransition(() => {
      flushSync(() => {
        setSlideOverId(id);
        setMorphId(null);
      });
    });
  };

  const slideStudent =
    slideOverId === null
      ? null
      : (rows.find((s) => s.id === slideOverId) ?? null);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };

  // The dashboard mock deep-links to the page with #add-student to open the
  // Add Student modal directly; clear the hash once consumed.
  useEffect(() => {
    if (window.location.hash === "#add-student") {
      setAddOpen(true);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, []);

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setActivePill(null);
  };

  const handleReset = () => {
    setFilters(emptyFilters());
    setActivePill(null);
    setSortDir("desc");
  };

  // Search + intake + country + date-range filtered set. Stat cards and the
  // status pills are computed from this (before the status-pill filter).
  const baseFiltered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const fromTs = filters.from
      ? new Date(`${filters.from}T00:00:00`).getTime()
      : null;
    const toTs = filters.to
      ? new Date(`${filters.to}T23:59:59.999`).getTime()
      : null;
    return rows.filter((s) => {
      if (q) {
        const hay =
          `${s.firstName} ${s.lastName} cp-${s.id} ${s.email ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.intake && s.intake !== filters.intake) return false;
      if (filters.country && s.country !== filters.country) return false;
      if (fromTs !== null || toTs !== null) {
        const updated = new Date(s.updatedAt).getTime();
        if (fromTs !== null && updated < fromTs) return false;
        if (toTs !== null && updated > toTs) return false;
      }
      return true;
    });
  }, [rows, filters]);

  const stats = useMemo(() => {
    let apps = 0;
    let offers = 0;
    let deposits = 0;
    let visas = 0;
    for (const s of baseFiltered) {
      if (studentStatusGroup(s.status) >= StudentStatusGroup.PRE_APPLICATION)
        apps++;
      if (
        s.status === StudentStatus.CONDITIONAL_OFFER ||
        s.status === StudentStatus.UNCONDITIONAL_OFFER
      )
        offers++;
      if (s.status === StudentStatus.DEPOSIT_PAID) deposits++;
      if (s.status === StudentStatus.VISA_SECURED) visas++;
    }
    return { apps, offers, deposits, visas };
  }, [baseFiltered]);

  const statusCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const s of baseFiltered) {
      counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
    }
    return counts;
  }, [baseFiltered]);

  // Pills: one per status with count > 0, in status-code order.
  const pillCodes = useMemo(
    () => STUDENT_STATUS_CODES.filter((c) => (statusCounts.get(c) ?? 0) > 0),
    [statusCounts],
  );

  const tableRows = useMemo(() => {
    const filtered =
      activePill === null
        ? baseFiltered
        : baseFiltered.filter((s) => s.status === activePill);
    return [...filtered].sort((a, b) => {
      const diff =
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      return sortDir === "asc" ? diff : -diff;
    });
  }, [baseFiltered, activePill, sortDir]);

  // ---- Filter options (distinct values from the full visible set) ----
  const intakeOptions = useMemo(() => {
    const distinct = Array.from(
      new Set(rows.map((s) => s.intake).filter((v): v is string => !!v)),
    ).sort();
    return distinct.map((i) => ({ value: i, label: i }));
  }, [rows]);

  const countryOptions = useMemo(() => {
    const distinct = Array.from(
      new Set(rows.map((s) => s.country).filter((v): v is string => !!v)),
    );
    return distinct
      .map((c) => ({ value: c, label: COUNTRY_NAME[c] ?? c }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const handleCreated = (student: CreatedStudent) => {
    setAddOpen(false);
    showToast(
      `${student.firstName} ${student.lastName} added as CP-${student.id}!`,
    );
  };

  return (
    <>
      {/* Page header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Students</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Manage your student pipeline and applications.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            className="h-4 w-4"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add New Student
        </Button>
      </div>

      {students.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
          {students.error.message}
        </div>
      ) : students.isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[88px]" />
            ))}
          </div>
          <div className="overflow-hidden rounded-2xl border border-[#E4E7EC] bg-white">
            <SkeletonTable rows={6} cols={6} />
          </div>
        </div>
      ) : (
        <>
          {/* Filter bar */}
          <div className="mb-4 rounded-2xl border border-[#E4E7EC] bg-white p-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex h-[38px] min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-[#D0D5DD] px-3 transition-all focus-within:border-[#1570EF] focus-within:shadow-[0_0_0_3px_rgba(21,112,239,0.1)] md:max-w-[300px]">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  strokeWidth={2}
                  className="h-4 w-4 shrink-0 stroke-[#98A2B3]"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  value={filters.search}
                  onChange={(e) => setFilter("search", e.target.value)}
                  placeholder="Search by name, CP-ID or email"
                  className="w-full border-none bg-transparent text-sm text-[#101828] outline-none placeholder:text-[#98A2B3]"
                />
              </div>
              <FilterPill
                value={filters.intake}
                onChange={(v) => setFilter("intake", v)}
                options={intakeOptions}
                placeholder="All Intakes"
              />
              <FilterPill
                value={filters.country}
                onChange={(v) => setFilter("country", v)}
                options={countryOptions}
                placeholder="All Countries"
              />
              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="students-filter-from"
                  className="text-xs font-medium text-[#667085]"
                >
                  From
                </label>
                <input
                  id="students-filter-from"
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilter("from", e.target.value)}
                  className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-2.5 text-sm text-[#344054] outline-none transition-colors hover:border-[#1570EF] focus:border-[#1570EF]"
                />
                <label
                  htmlFor="students-filter-to"
                  className="text-xs font-medium text-[#667085]"
                >
                  To
                </label>
                <input
                  id="students-filter-to"
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilter("to", e.target.value)}
                  className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-2.5 text-sm text-[#344054] outline-none transition-colors hover:border-[#1570EF] focus:border-[#1570EF]"
                />
              </div>
              <button
                type="button"
                onClick={handleReset}
                className="ml-auto cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
              >
                Reset
              </button>
            </div>
          </div>

          {/* Stat cards */}
          <Stagger className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <FadeUp className="h-full">
              <StatCard label="All Applications" value={stats.apps} />
            </FadeUp>
            <FadeUp className="h-full">
              <StatCard label="Offers" value={stats.offers} />
            </FadeUp>
            <FadeUp className="h-full">
              <StatCard label="Deposits" value={stats.deposits} />
            </FadeUp>
            <FadeUp className="h-full">
              <StatCard label="Visas Received" value={stats.visas} />
            </FadeUp>
          </Stagger>

          {/* Status filter pills */}
          <div className="mb-4 flex flex-wrap gap-2">
            <StatusPill
              label={`All (${baseFiltered.length})`}
              active={activePill === null}
              onClick={() => setActivePill(null)}
            />
            {pillCodes.map((code) => (
              <StatusPill
                key={code}
                label={`${StudentStatusLabel[code]} (${statusCounts.get(code) ?? 0})`}
                active={activePill === code}
                onClick={() => setActivePill(code)}
              />
            ))}
          </div>

          {/* Students table */}
          <div className="overflow-x-auto rounded-2xl border border-[#E4E7EC] bg-white">
            <table className="w-full min-w-[920px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[#E4E7EC] bg-[#F9FAFB]">
                  <Th>Student</Th>
                  <Th>University</Th>
                  <Th>Program</Th>
                  <Th>Level</Th>
                  <Th>Country</Th>
                  <Th>Intake</Th>
                  <Th>Status</Th>
                  <th className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() =>
                        setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                      }
                      className="flex cursor-pointer items-center gap-1 text-xs font-semibold whitespace-nowrap text-[#667085] hover:text-[#1570EF]"
                      title="Sort by last updated"
                    >
                      Updated
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`h-3 w-3 transition-transform ${
                          sortDir === "asc" ? "rotate-180" : ""
                        }`}
                      >
                        <path d="M8 3v10M4 9l4 4 4-4" />
                      </svg>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-12 text-center text-sm text-[#98A2B3]"
                    >
                      No students match the current filters
                    </td>
                  </tr>
                ) : (
                  tableRows.map((s) => (
                    <StudentRow
                      key={s.id}
                      student={s}
                      onView={() => openStudent(s.id)}
                      morphing={morphId === s.id}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <AddStudentModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={handleCreated}
      />
      <Toast
        message={toastMsg}
        open={toastOpen}
        onClose={() => setToastOpen(false)}
      />

      {slideStudent && (
        <PartnerStudentSlideOver
          student={slideStudent}
          isOwner={me.data?.kind === "agency"}
          onMessage={showToast}
          onClose={() => setSlideOverId(null)}
        />
      )}
    </>
  );
}

// ----- Table row --------------------------------------------------------------

function StudentRow({
  student: s,
  onView,
  morphing,
}: {
  student: PartnerStudent;
  onView: () => void;
  morphing: boolean;
}) {
  const { university, program } = derivedApplication(s);
  const initials =
    `${s.firstName.charAt(0)}${s.lastName.charAt(0)}`.toUpperCase();
  return (
    <tr className="border-b border-[#F2F4F7] transition-colors last:border-b-0 hover:bg-[#F9FAFB]">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onView}
            aria-label={`View ${s.firstName} ${s.lastName}`}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-xs font-semibold text-white"
            style={{
              background: avatarGradient(s.id),
              viewTransitionName: morphing ? "student-morph" : undefined,
            }}
          >
            {initials}
          </button>
          <div className="min-w-0">
            <div className="text-sm font-semibold whitespace-nowrap text-[#101828]">
              {s.firstName} {s.lastName}
            </div>
            <div className="text-xs text-[#98A2B3]">CP-{s.id}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="max-w-[200px] truncate text-sm text-[#344054]">
          {university}
        </div>
      </td>
      <td className="px-4 py-3">
        <div
          className="max-w-[180px] truncate text-sm text-[#344054]"
          title={program}
        >
          {program}
        </div>
      </td>
      <td className="px-4 py-3 text-sm whitespace-nowrap text-[#344054]">
        {levelShort(s.courseLevel)}
      </td>
      <td className="px-4 py-3 text-sm whitespace-nowrap text-[#344054]">
        {s.country ? (COUNTRY_NAME[s.country] ?? s.country) : "—"}
      </td>
      <td className="px-4 py-3 text-sm whitespace-nowrap text-[#344054]">
        {s.intake ?? "—"}
      </td>
      <td className="px-4 py-3">
        <StudentStatusBadge status={s.status} />
      </td>
      <td
        className="px-4 py-3 text-sm whitespace-nowrap text-[#667085]"
        title={new Date(s.updatedAt).toLocaleString("en-IN")}
      >
        {relativeTime(s.updatedAt)}
      </td>
    </tr>
  );
}

function SlideDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
        {label}
      </div>
      <div className="mt-0.5 text-sm break-words text-[#344054]">{value}</div>
    </div>
  );
}

// Quick-peek panel for a partner's student. The avatar carries a
// view-transition-name so the native View Transition morphs the row avatar
// into this header (see openStudent in the page component).
function PartnerStudentSlideOver({
  student: s,
  isOwner,
  onMessage,
  onClose,
}: {
  student: PartnerStudent;
  isOwner: boolean;
  onMessage: (msg: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { university, program } = derivedApplication(s);
  const initials =
    `${s.firstName.charAt(0)}${s.lastName.charAt(0)}`.toUpperCase();

  return (
    <div className="fixed inset-0 z-[200]">
      <div
        className="absolute inset-0 bg-[rgba(16,24,40,0.45)]"
        onClick={onClose}
      />
      <aside className="absolute top-0 right-0 flex h-full w-[480px] max-w-[calc(100vw-32px)] flex-col bg-white shadow-[-12px_0_40px_rgba(0,0,0,0.18)]">
        <div className="flex items-start justify-between gap-3 border-b border-[#E4E7EC] px-6 py-5">
          <div className="flex items-center gap-3.5">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
              style={{
                background: avatarGradient(s.id),
                viewTransitionName: "student-morph",
              }}
            >
              {initials}
            </div>
            <div>
              <div className="text-base font-bold text-[#101828]">
                {s.firstName} {s.lastName}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StudentStatusBadge status={s.status} />
                <span className="text-xs text-[#98A2B3]">CP-{s.id}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[#E4E7EC] bg-white hover:bg-[#F9FAFB]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#667085"
              strokeWidth={2}
              className="h-4 w-4"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-2.5 text-sm">
            <div className="flex items-center gap-2.5">
              <span className="w-14 shrink-0 text-[#98A2B3]">Email</span>
              <span className="break-all text-[#344054]">{s.email ?? "—"}</span>
            </div>
            <div className="flex items-center gap-2.5">
              <span className="w-14 shrink-0 text-[#98A2B3]">Phone</span>
              <span className="text-[#344054]">{s.phone ?? "—"}</span>
            </div>
          </div>

          <div className="mt-6 mb-3 border-b border-[#F2F4F7] pb-1.5 text-[11px] font-bold tracking-wider text-[#667085] uppercase">
            Academic Details
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 rounded-lg bg-[#F9FAFB] p-4">
            <SlideDetail label="University" value={university} />
            <SlideDetail label="Program" value={program} />
            <SlideDetail label="Level" value={levelShort(s.courseLevel)} />
            <SlideDetail label="Intake" value={s.intake ?? "—"} />
            <SlideDetail
              label="Country"
              value={s.country ? (COUNTRY_NAME[s.country] ?? s.country) : "—"}
            />
            <SlideDetail label="Student ID" value={`CP-${s.id}`} />
          </div>

          <div className="mt-6 mb-3 border-b border-[#F2F4F7] pb-1.5 text-[11px] font-bold tracking-wider text-[#667085] uppercase">
            Universities Applied ({s.applications.length})
          </div>
          {s.applications.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#D0D5DD] px-4 py-5 text-center text-[13px] text-[#98A2B3]">
              No applications yet.
            </div>
          ) : (
            <div className="space-y-2">
              {s.applications.map((app) => (
                <div
                  key={app.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[#E4E7EC] px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#101828]">
                      {app.university}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-[#667085]">
                      {app.program}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-2xl bg-[#F2F4F7] px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap text-[#344054]">
                    {stageLabel(app.status)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Agency students only: an independent has no team to route to. */}
          {s.orgId !== null && (
            <StudentCounsellor
              studentId={s.id}
              counsellorId={s.counsellorId}
              counsellorName={s.counsellorName}
              isOwner={isOwner}
              onChanged={onMessage}
            />
          )}
          <StudentDocuments studentId={s.id} onUploaded={onMessage} />
        </div>
      </aside>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-xs font-semibold whitespace-nowrap text-[#667085]">
      {children}
    </th>
  );
}

// ----- Status pill --------------------------------------------------------------

function StatusPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-[34px] cursor-pointer rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
        active
          ? "border-[#1570EF] bg-[#1570EF] text-white"
          : "border-[#D0D5DD] bg-white text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
      }`}
    >
      {label}
    </button>
  );
}

// ----- Filter pill (same convention as the partner uni-assist page) -------------

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
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-[38px] min-w-[140px] cursor-pointer appearance-none rounded-lg border bg-white pr-9 pl-3 text-sm font-medium transition-colors hover:border-[#1570EF] focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.1)] focus:outline-none ${
          isAny
            ? "border-[#D0D5DD] text-[#344054]"
            : "border-[#1570EF] text-[#1570EF]"
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
      <div className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="h-3 w-3 stroke-[#98A2B3]"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </div>
    </div>
  );
}
