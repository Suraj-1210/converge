"use client";

import Link from "next/link";
import { DeferredPanel } from "~/components/students/deferred-panel";
import { Link as VTLink } from "next-view-transitions";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useUrlState } from "~/lib/url-state";
import { flushSync } from "react-dom";
import { Button } from "~/components/ui/button";
import { Toast } from "~/components/ui/toast";
import {
  OverallStatusBadge,
  StudentOverallStatus,
  StudentOverallStatusLabel,
  StudentStatusBadge,
  StudentStatusGroup,
  studentStatusGroup,
} from "~/components/students/status";
import { api } from "~/trpc/react";
import { useExportLog } from "~/lib/export-log";
import { SkeletonTable } from "~/components/dashboard/widgets";
import {
  countryName,
  derivedProgram,
  derivedUniversity,
  derivedVendors,
  displayId,
  downloadCsv,
  levelShort,
  statusLabel,
  studentInitials,
  studentName,
  timeAgo,
  todayYmd,
  avatarGradient,
  type AdminStudent,
} from "./lib";
import {
  AddStudentModal,
  BulkAssignModal,
  BulkImportStudentsModal,
  BulkStatusModal,
  StatusGroupedSelect,
} from "./modals";
import { StudentSlideOver } from "./slide-over";

type TabId = "all" | "leads" | "preapp" | "offer" | "decision" | "postoffer";

const TABS: { id: TabId; label: string; group: StudentStatusGroup | null }[] = [
  { id: "all", label: "All", group: null },
  { id: "leads", label: "Leads", group: StudentStatusGroup.LEADS },
  {
    id: "preapp",
    label: "Pre-Application",
    group: StudentStatusGroup.PRE_APPLICATION,
  },
  { id: "offer", label: "Offer Stage", group: StudentStatusGroup.OFFER },
  {
    id: "decision",
    label: "Student Decision",
    group: StudentStatusGroup.DECISION,
  },
  { id: "postoffer", label: "Post-Offer", group: StudentStatusGroup.POST_OFFER },
];

type SortKey =
  | "name"
  | "partner"
  | "id"
  | "phone"
  | "overall"
  | "status"
  | "vendor"
  | "university"
  | "program"
  | "level"
  | "country"
  | "intake"
  | "counselor"
  | "updatedAt";

const SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Student" },
  { key: "partner", label: "Partner" },
  { key: "id", label: "ID" },
  { key: "phone", label: "Phone" },
  { key: "overall", label: "Student Status" },
  { key: "status", label: "Status" },
  { key: "vendor", label: "Vendor" },
  { key: "university", label: "University" },
  { key: "program", label: "Program" },
  { key: "level", label: "Level" },
  { key: "country", label: "Country" },
  { key: "intake", label: "Intake" },
  { key: "counselor", label: "Counselor" },
  { key: "updatedAt", label: "Last Updated" },
];

function sortValue(s: AdminStudent, key: SortKey): string | number {
  switch (key) {
    case "name":
      return studentName(s).toLowerCase();
    case "partner":
      return s.orgName.toLowerCase();
    case "id":
      return s.id;
    case "phone":
      return (s.phone ?? "").toLowerCase();
    case "overall":
      return StudentOverallStatusLabel[s.overallStatus];
    case "status":
      return statusLabel(s.status).toLowerCase();
    case "vendor":
      return (derivedVendors(s)[0] ?? "~").toLowerCase(); // unset sorts last
    case "university":
      return derivedUniversity(s).toLowerCase();
    case "program":
      return derivedProgram(s).toLowerCase();
    case "level":
      return levelShort(s.courseLevel).toLowerCase();
    case "country":
      return countryName(s.country).toLowerCase();
    case "intake":
      return (s.intake ?? "").toLowerCase();
    case "counselor":
      return (s.cpCounsellorName ?? "Unassigned").toLowerCase();
    case "updatedAt":
      return Date.parse(s.updatedAt);
  }
}

// A type, not an interface: useUrlState needs a plain string record.
type Filters = {
  search: string;
  partner: string;
  status: string;
  overall: string;
  intake: string;
  country: string;
  university: string;
  level: string;
  dateFrom: string;
  dateTo: string;
};

const emptyFilters: Filters = {
  search: "",
  partner: "",
  status: "",
  overall: "",
  intake: "",
  country: "",
  university: "",
  level: "",
  dateFrom: "",
  dateTo: "",
};

export default function StudentsPage() {
  const utils = api.useUtils();
  const logExport = useExportLog();
  const studentsQuery = api.students.adminList.useQuery();

  // Warm the shared /students/[id] route chunk once the list loads, so the very
  // first name-click can morph. In dev, routes compile on-demand and Links
  // don't auto-prefetch; an explicit router.prefetch() triggers it. (In prod
  // this is belt-and-suspenders on top of Link prefetch.)
  const router = useRouter();
  useEffect(() => {
    const firstId = studentsQuery.data?.[0]?.id;
    if (firstId != null) router.prefetch(`/admin/students/${firstId}`);
  }, [router, studentsQuery.data]);
  const orgsQuery = api.students.listOrgs.useQuery();
  // Only the counsellors this user may assign to (their team, for leads and
  // counsellors); the server enforces the same rule.
  const counsellorsQuery = api.users.assignableCounsellors.useQuery();

  const students = useMemo(
    () => studentsQuery.data ?? [],
    [studentsQuery.data],
  );
  const counsellors = counsellorsQuery.data ?? [];

  // Tab, filters and the partner-edits toggle live in the URL, so a refresh
  // keeps them (27 Oct testing).
  const [view, setView] = useUrlState({ tab: "all", partnerEdits: "" });
  const tab: TabId = TABS.some((t) => t.id === view.tab) ? (view.tab as TabId) : "all";
  // Students a partner edited that nobody has reviewed yet (the admin bell
  // links here with ?partnerEdits=1).
  const partnerEditsOnly = view.partnerEdits === "1";
  const partnerEditedCount = students.filter((s) => s.partnerEditCount > 0).length;
  const [filters, setFilters] = useUrlState<Filters>(emptyFilters);
  const [sort, setSort] = useState<{ column: SortKey; direction: "asc" | "desc" }>(
    { column: "updatedAt", direction: "desc" },
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [slideOverId, setSlideOverId] = useState<number | null>(null);
  const [morphId, setMorphId] = useState<number | null>(null);

  // Native View Transition: morph the clicked row's avatar into the slide-over.
  // The row avatar is named first (captured as the "old" snapshot), then the
  // name is handed to the slide-over avatar (the "new" snapshot) so the browser
  // tweens the circle between the two positions. Falls back to an instant open
  // where the API is unsupported.
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

  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };

  const setFilter = (patch: Partial<Filters>) => setFilters(patch);

  // ---- Mutations -----------------------------------------------------------

  const bulkStatusMut = api.students.bulkUpdateStatus.useMutation({
    onSuccess: (res, vars) => {
      void utils.students.adminList.invalidate();
      showToast(`${res.updated} student(s) updated to ${statusLabel(vars.status)}`);
      setSelectedIds(new Set());
      setStatusModalOpen(false);
    },
    onError: (err) => showToast(err.message),
  });

  const assignBulkMut = api.students.assignCpCounsellor.useMutation({
    onSuccess: (res) => {
      void utils.students.adminList.invalidate();
      showToast(`${res.updated} student(s) assigned to ${res.counsellorName}`);
      setSelectedIds(new Set());
      setAssignModalOpen(false);
    },
    onError: (err) => showToast(err.message),
  });

  // Separate instance for single-row assigns (table inline + slide-over) so
  // the toast can name the student instead of a count.
  const assignSingleMut = api.students.assignCpCounsellor.useMutation({
    onSuccess: (res, vars) => {
      void utils.students.adminList.invalidate();
      const target = students.find((s) => s.id === vars.ids[0]);
      showToast(
        `${target ? studentName(target) : "Student"} assigned to ${res.counsellorName}`,
      );
    },
    onError: (err) => showToast(err.message),
  });

  // ---- Derived data --------------------------------------------------------

  const tabCounts = useMemo(() => {
    const counts: Record<TabId, number> = {
      all: students.length,
      leads: 0,
      preapp: 0,
      offer: 0,
      decision: 0,
      postoffer: 0,
    };
    for (const s of students) {
      const group = studentStatusGroup(s.status);
      const t = TABS.find((x) => x.group === group);
      if (t) counts[t.id]++;
    }
    return counts;
  }, [students]);

  const partnerOptions = useMemo(
    () => distinct(students.map((s) => s.orgName)),
    [students],
  );
  const intakeOptions = useMemo(
    () => distinct(students.map((s) => s.intake).filter(isString)),
    [students],
  );
  const countryOptions = useMemo(() => {
    const codes = distinct(students.map((s) => s.country).filter(isString));
    return codes
      .map((code) => ({ value: code, label: countryName(code) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [students]);
  const universityOptions = useMemo(
    () => distinct(students.map(derivedUniversity)),
    [students],
  );
  const levelOptions = useMemo(() => {
    const codes = [
      ...new Set(
        students
          .map((s) => s.courseLevel)
          .filter((l): l is number => l !== null),
      ),
    ].sort((a, b) => a - b);
    return codes.map((code) => ({ value: String(code), label: levelShort(code) }));
  }, [students]);

  const tabGroup = TABS.find((t) => t.id === tab)?.group ?? null;

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const fromTs = filters.dateFrom ? Date.parse(filters.dateFrom) : null;
    const toTs = filters.dateTo ? Date.parse(filters.dateTo) + 86_399_999 : null;
    return students.filter((s) => {
      if (tabGroup !== null && studentStatusGroup(s.status) !== tabGroup) {
        return false;
      }
      if (partnerEditsOnly && s.partnerEditCount === 0) return false;
      if (q) {
        const haystack = [
          studentName(s),
          displayId(s.id),
          s.email ?? "",
          s.orgName,
          derivedUniversity(s),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (filters.partner && s.orgName !== filters.partner) return false;
      if (filters.overall && s.overallStatus !== filters.overall) return false;
      if (filters.status !== "" && s.status !== Number(filters.status)) {
        return false;
      }
      if (filters.intake && s.intake !== filters.intake) return false;
      if (filters.country && s.country !== filters.country) return false;
      if (filters.university && derivedUniversity(s) !== filters.university) {
        return false;
      }
      if (filters.level !== "" && s.courseLevel !== Number(filters.level)) {
        return false;
      }
      if (fromTs !== null || toTs !== null) {
        const ts = Date.parse(s.updatedAt);
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      return true;
    });
  }, [students, tabGroup, filters, partnerEditsOnly]);

  const sorted = useMemo(() => {
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = sortValue(a, sort.column);
      const vb = sortValue(b, sort.column);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return 0;
    });
  }, [filtered, sort]);

  const slideStudent =
    slideOverId === null
      ? null
      : (students.find((s) => s.id === slideOverId) ?? null);

  // ---- Actions ---------------------------------------------------------------

  const handleSort = (column: SortKey) => {
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  };

  const allSelected =
    sorted.length > 0 && sorted.every((s) => selectedIds.has(s.id));

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(sorted.map((s) => s.id)));
  };

  const toggleRow = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const switchTab = (id: TabId) => {
    setView({ tab: id });
    setSelectedIds(new Set());
  };

  // Exports the current filtered+sorted view (data columns only).
  const exportCsv = () => {
    const rows: string[][] = [
      [
        "Student",
        "Email",
        "Partner",
        "ID",
        "Phone",
        "Student Status",
        "Status",
        "Vendor",
        "University",
        "Program",
        "Level",
        "Country",
        "Intake",
        "Counselor",
        "Last Updated",
      ],
      ...sorted.map((s) => [
        studentName(s),
        s.email ?? "",
        s.orgName,
        displayId(s.id),
        s.phone ?? "",
        StudentOverallStatusLabel[s.overallStatus],
        statusLabel(s.status),
        derivedVendors(s).join(", ") || "Not set",
        derivedUniversity(s),
        derivedProgram(s),
        levelShort(s.courseLevel),
        countryName(s.country),
        s.intake ?? "",
        s.cpCounsellorName ?? "Unassigned",
        new Date(s.updatedAt).toISOString(),
      ]),
    ];
    downloadCsv(`Collegepond_Admin_Students_${todayYmd()}.csv`, rows);
    logExport("Students CSV", sorted.length);
    showToast(`CSV downloaded — ${sorted.length} students exported`);
  };

  const deferred = api.applicationPipeline.deferredList.useQuery();

  // ---- Render ----------------------------------------------------------------

  return (
    <>
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">All Students</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Cross-partner student view across all partner accounts.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={exportCsv}
            className="!h-[40px] !px-4 !text-[13px]"
          >
            Export CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() => setImportOpen(true)}
            className="!h-[40px] !px-4 !text-[13px]"
          >
            Bulk Import
          </Button>
          <Button
            onClick={() => setAddOpen(true)}
            className="!h-[40px] !px-4 !text-[13px]"
          >
            + Add Student
          </Button>
        </div>
      </div>

      {/* Deferred to a later intake: still open, listed so they aren't lost */}
      <DeferredPanel
        rows={deferred.data}
        hrefFor={(id) => `/admin/students/${id}?tab=application`}
      />

      {/* Pipeline tabs */}
      <div className="mb-5 flex gap-2 overflow-x-auto border-b border-[#E4E7EC]">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              className={`-mb-px flex cursor-pointer items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap transition ${
                active
                  ? "border-[#1570EF] text-[#1570EF]"
                  : "border-transparent text-[#667085] hover:text-[#344054]"
              }`}
            >
              {t.label}
              <span
                className={`rounded-xl px-2 py-0.5 text-xs font-semibold ${
                  active
                    ? "bg-[#EFF8FF] text-[#1570EF]"
                    : "bg-[#F2F4F7] text-[#667085]"
                }`}
              >
                {tabCounts[t.id]}
              </span>
            </button>
          );
        })}
      </div>

      {(partnerEditedCount > 0 || partnerEditsOnly) && (
        <button
          type="button"
          onClick={() => setView({ partnerEdits: partnerEditsOnly ? "" : "1" })}
          aria-pressed={partnerEditsOnly}
          className={`mb-4 inline-flex h-[32px] cursor-pointer items-center gap-2 rounded-full border px-3.5 text-[13px] font-semibold transition-colors ${
            partnerEditsOnly
              ? "border-[#DC6803] bg-[#DC6803] text-white"
              : "border-[#FEDF89] bg-[#FFFAEB] text-[#B54708] hover:border-[#DC6803]"
          }`}
        >
          Updated by partners ({partnerEditedCount})
          {partnerEditsOnly && <span aria-hidden>×</span>}
        </button>
      )}

      {/* Filter bar */}
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <div className="flex h-[38px] w-[220px] items-center gap-2 rounded-lg border border-[#D0D5DD] bg-white px-3">
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
            onChange={(e) => setFilter({ search: e.target.value })}
            placeholder="Search students..."
            className="w-full border-none bg-transparent text-[13px] text-[#344054] outline-none placeholder:text-[#98A2B3]"
          />
        </div>
        <FilterSelect
          value={filters.partner}
          onChange={(partner) => setFilter({ partner })}
          options={partnerOptions.map((p) => ({ value: p, label: p }))}
          placeholder="All Partners"
        />
        <FilterSelect
          value={filters.overall}
          onChange={(overall) => setFilter({ overall })}
          options={Object.values(StudentOverallStatus).map((v) => ({
            value: v,
            label: StudentOverallStatusLabel[v],
          }))}
          placeholder="All Student Statuses"
        />
        <StatusGroupedSelect
          value={filters.status}
          onChange={(status) => setFilter({ status })}
          placeholder="All Statuses"
          className={`h-[38px] min-w-[140px] rounded-lg border pr-9 pl-3 text-[13px] font-medium transition-colors hover:border-[#1570EF] focus:border-[#1570EF] ${
            filters.status === ""
              ? "border-[#D0D5DD] text-[#344054]"
              : "border-[#1570EF] text-[#1570EF]"
          }`}
        />
        <FilterSelect
          value={filters.intake}
          onChange={(intake) => setFilter({ intake })}
          options={intakeOptions.map((i) => ({ value: i, label: i }))}
          placeholder="All Intakes"
        />
        <FilterSelect
          value={filters.country}
          onChange={(country) => setFilter({ country })}
          options={countryOptions}
          placeholder="All Countries"
        />
        <FilterSelect
          value={filters.university}
          onChange={(university) => setFilter({ university })}
          options={universityOptions.map((u) => ({ value: u, label: u }))}
          placeholder="All Universities"
        />
        <FilterSelect
          value={filters.level}
          onChange={(level) => setFilter({ level })}
          options={levelOptions}
          placeholder="All Levels"
        />
        <div className="flex items-center gap-1.5">
          <DateInput
            label="From"
            value={filters.dateFrom}
            onChange={(dateFrom) => setFilter({ dateFrom })}
          />
          <DateInput
            label="To"
            value={filters.dateTo}
            onChange={(dateTo) => setFilter({ dateTo })}
          />
        </div>
        <button
          onClick={() => setFilters(emptyFilters)}
          className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 text-[13px] font-medium text-[#667085] hover:bg-[#F9FAFB]"
        >
          Reset
        </button>
      </div>

      {/* Table toolbar */}
      <div className="mb-3 flex items-center gap-2.5">
        <span className="text-sm font-semibold text-[#344054]">Students</span>
        <span className="rounded-xl bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">
          {sorted.length}
        </span>
      </div>

      {/* Table */}
      {studentsQuery.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
          {studentsQuery.error.message}
        </div>
      ) : studentsQuery.isLoading ? (
        <Card>
          <SkeletonTable rows={8} cols={7} />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="w-10 border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="h-4 w-4 cursor-pointer accent-[#1570EF]"
                    />
                  </th>
                  {SORTABLE_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      onClick={() => handleSort(col.key)}
                      className="cursor-pointer border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-xs font-semibold tracking-wider whitespace-nowrap text-[#667085] uppercase select-none hover:text-[#344054]"
                    >
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        <SortIcon
                          direction={
                            sort.column === col.key ? sort.direction : null
                          }
                        />
                      </span>
                    </th>
                  ))}
                  <th className="border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-xs font-semibold tracking-wider text-[#667085] uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td
                      colSpan={SORTABLE_COLUMNS.length + 2}
                      className="px-5 py-10 text-center text-sm text-[#98A2B3]"
                    >
                      No students match the current filters.
                    </td>
                  </tr>
                ) : (
                  sorted.map((s) => (
                    <StudentRow
                      key={s.id}
                      student={s}
                      morphing={morphId === s.id}
                      selected={selectedIds.has(s.id)}
                      onToggle={() => toggleRow(s.id)}
                      onView={() => openStudent(s.id)}
                      counsellors={counsellors}
                      onAssign={(cpCounsellorId) =>
                        assignSingleMut.mutate({ ids: [s.id], cpCounsellorId })
                      }
                      assigning={assignSingleMut.isPending}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-5 left-1/2 z-[150] flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded-xl border border-[#E4E7EC] bg-white px-5 py-3 shadow-[0_12px_40px_rgba(16,24,40,0.18)]">
          <span className="text-sm font-semibold whitespace-nowrap text-[#344054]">
            {selectedIds.size} student(s) selected
          </span>
          <Button
            onClick={() => setStatusModalOpen(true)}
            className="!h-[36px] !px-4 !text-[13px]"
          >
            Update Status
          </Button>
          <Button
            variant="secondary"
            onClick={() => setAssignModalOpen(true)}
            className="!h-[36px] !px-4 !text-[13px]"
          >
            Assign / Reassign Counselor
          </Button>
          <Button
            variant="secondary"
            onClick={exportCsv}
            className="!h-[36px] !px-4 !text-[13px]"
          >
            Export CSV
          </Button>
        </div>
      )}

      {/* Modals */}
      <AddStudentModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        orgs={orgsQuery.data ?? []}
        counsellors={counsellors}
        onToast={showToast}
      />
      <BulkImportStudentsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        orgs={orgsQuery.data ?? []}
        counsellors={counsellors}
        onToast={showToast}
      />
      <BulkStatusModal
        open={statusModalOpen}
        count={selectedIds.size}
        onClose={() => setStatusModalOpen(false)}
        onConfirm={(status, note, effectiveDate) =>
          bulkStatusMut.mutate({
            ids: [...selectedIds],
            status,
            note,
            effectiveDate,
          })
        }
        saving={bulkStatusMut.isPending}
        onToast={showToast}
      />
      <BulkAssignModal
        open={assignModalOpen}
        count={selectedIds.size}
        counsellors={counsellors}
        onClose={() => setAssignModalOpen(false)}
        onConfirm={(cpCounsellorId) =>
          assignBulkMut.mutate({ ids: [...selectedIds], cpCounsellorId })
        }
        saving={assignBulkMut.isPending}
        onToast={showToast}
      />

      {/* Slide-over */}
      {slideStudent && (
        <StudentSlideOver
          student={slideStudent}
          counsellors={counsellors}
          onClose={() => setSlideOverId(null)}
          onReassign={(cpCounsellorId) =>
            assignSingleMut.mutate({ ids: [slideStudent.id], cpCounsellorId })
          }
          assigning={assignSingleMut.isPending}
        />
      )}

      <Toast
        message={toastMsg}
        open={toastOpen}
        onClose={() => setToastOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

function StudentRow({
  student: s,
  morphing,
  selected,
  onToggle,
  onView,
  counsellors,
  onAssign,
  assigning,
}: {
  student: AdminStudent;
  morphing: boolean;
  selected: boolean;
  onToggle: () => void;
  onView: () => void;
  counsellors: { id: number; firstName: string; lastName: string; email: string }[];
  onAssign: (cpCounsellorId: number) => void;
  assigning: boolean;
}) {
  const program = derivedProgram(s);
  const vendors = derivedVendors(s);
  const td = "px-3.5 py-3 text-sm text-[#344054]";
  return (
    <tr
      className={`border-b border-[#F2F4F7] last:border-b-0 ${
        selected ? "bg-[#F5FAFF]" : "hover:bg-[#F9FAFB]"
      }`}
    >
      <td className="px-3.5 py-3">
        <input
          type="checkbox"
          aria-label={`Select ${studentName(s)}`}
          checked={selected}
          onChange={onToggle}
          className="h-4 w-4 cursor-pointer accent-[#1570EF]"
        />
      </td>
      <td className="px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
            style={{
              background: avatarGradient(s.id),
              viewTransitionName: morphing
                ? "student-morph"
                : `student-avatar-${s.id}`,
            }}
          >
            {studentInitials(s)}
          </div>
          <div className="min-w-0">
            <VTLink
              href={`/admin/students/${s.id}`}
              style={{ viewTransitionName: `student-name-${s.id}` }}
              className="text-sm font-semibold whitespace-nowrap text-[#101828] hover:text-[#1570EF] hover:underline"
            >
              {studentName(s)}
            </VTLink>
            <div className="truncate text-[11px] text-[#98A2B3]">
              {s.email ?? "—"}
            </div>
          </div>
        </div>
      </td>
      <td className={`${td} whitespace-nowrap text-[#667085]`}>{s.partnerLabel}</td>
      <td className={`${td} whitespace-nowrap`}>
        <Link
          href={`/admin/students/${s.id}`}
          className="font-medium text-[#1570EF] hover:text-[#0b4ea2] hover:underline"
        >
          {displayId(s.id)}
        </Link>
      </td>
      <td className={`${td} whitespace-nowrap`}>{s.phone ?? "—"}</td>
      <td className="px-3.5 py-3">
        <OverallStatusBadge status={s.overallStatus} inactive={s.inactive} />
      </td>
      <td className="px-3.5 py-3">
        <StudentStatusBadge status={s.status} />
      </td>
      <td className={`${td} whitespace-nowrap`}>
        {vendors.length > 0 ? (
          <span
            className="rounded-md bg-[#F4F3FF] px-2 py-0.5 text-xs font-medium text-[#5925DC]"
            title={`Counsellor's vendor choice: ${vendors.join(", ")}`}
          >
            {vendors[0]}
            {vendors.length > 1 ? ` +${vendors.length - 1}` : ""}
          </span>
        ) : (
          <span className="text-xs text-[#98A2B3] italic">Not set</span>
        )}
      </td>
      <td className={`${td} whitespace-nowrap`}>{derivedUniversity(s)}</td>
      <td className={td}>
        <div className="max-w-[160px] truncate" title={program}>
          {program}
        </div>
      </td>
      <td className={`${td} text-xs font-bold`}>{levelShort(s.courseLevel)}</td>
      <td className={`${td} whitespace-nowrap`}>{countryName(s.country)}</td>
      <td className={`${td} whitespace-nowrap`}>{s.intake ?? "—"}</td>
      <td className="px-3.5 py-3">
        <div className="text-sm whitespace-nowrap text-[#344054]">
          {s.cpCounsellorName ?? "Unassigned"}
        </div>
        {s.cpAutoAssigned && (
          <div
            className="mt-0.5 text-[10px] font-semibold tracking-wide text-[#027A48] uppercase"
            title={`Auto-assigned to ${s.cpCounsellorName ?? "a counsellor"}`}
          >
            Auto-assigned
          </div>
        )}
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onAssign(Number(e.target.value));
          }}
          disabled={assigning}
          aria-label={`Assign counselor to ${studentName(s)}`}
          className="mt-1 h-[24px] max-w-[110px] cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-1 text-[11px] text-[#667085] outline-none hover:border-[#1570EF] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">Assign</option>
          {counsellors.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {`${c.firstName} ${c.lastName}`.trim() || c.email}
            </option>
          ))}
        </select>
      </td>
      <td
        className={`${td} whitespace-nowrap`}
        title={new Date(s.updatedAt).toLocaleString()}
      >
        {timeAgo(s.updatedAt)}
      </td>
      <td className="px-3.5 py-3">
        <button
          onClick={onView}
          className="cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
        >
          View
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Filter widgets
// ---------------------------------------------------------------------------

const chevronBg = `url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%2398A2B3' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

function FilterSelect({
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
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ backgroundImage: chevronBg }}
      className={`h-[38px] min-w-[130px] cursor-pointer appearance-none rounded-lg border bg-white bg-[right_12px_center] bg-no-repeat pr-9 pl-3 text-[13px] font-medium transition-colors outline-none hover:border-[#1570EF] focus:border-[#1570EF] ${
        value === ""
          ? "border-[#D0D5DD] text-[#344054]"
          : "border-[#1570EF] text-[#1570EF]"
      }`}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs font-medium text-[#667085]">
      {label}
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-[38px] cursor-pointer rounded-lg border bg-white px-2.5 text-[13px] outline-none hover:border-[#1570EF] focus:border-[#1570EF] ${
          value
            ? "border-[#1570EF] text-[#1570EF]"
            : "border-[#D0D5DD] text-[#344054]"
        }`}
      />
    </label>
  );
}

function SortIcon({ direction }: { direction: "asc" | "desc" | null }) {
  if (!direction) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="#98A2B3"
        strokeWidth={1.5}
        className="h-3 w-3 shrink-0"
      >
        <path d="M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="#1570EF"
      strokeWidth={2}
      className={`h-3 w-3 shrink-0 ${direction === "desc" ? "rotate-180" : ""}`}
    >
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
      {children}
    </div>
  );
}

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isString(v: string | null): v is string {
  return v !== null && v !== "";
}
