"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";

// ---- Types (mirrors src/server/universities/import.ts) -------------------

type RowStatus = "new" | "update" | "error";

interface PreviewUniRow {
  id: string;
  rowNum: number;
  xlsxId: number | null;
  data: {
    code: string | null;
    name: string;
    country: string;
    city: string | null;
    type: number;
    ranking: number | null;
    appSource: string | null;
    website: string | null;
    logoUrl: string | null;
    isOpen: boolean;
  };
  matchedDbId: number | null;
  matchedBy: "code" | "name+country" | null;
  status: RowStatus;
  errors: string[];
  logoFromZip: string | null;
}

interface PreviewCourseRow {
  id: string;
  rowNum: number;
  xlsxId: number | null;
  xlsxUniversityId: number | null;
  data: {
    name: string;
    code: string | null;
    degreeLevel: number | null;
    durationMonths: number | null;
    tuitionFee: number | null;
    currency: string | null;
    isOpen: boolean;
    url: string | null;
    toefl: number | null;
    toefl2026: number | null;
    ielts: number | null;
    det: number | null;
    pte: number | null;
    gre: number | null;
    gmat: number | null;
    applicationDeadline: string | null;
    isStem: boolean;
    intakeMonth: string | null;
    intakeYear: number | null;
    isCoopAvailable: boolean;
    hasAppFeeWaiver: boolean;
    appFee: number | null;
    hasTuitionDeposit: boolean;
    hasScholarship: boolean;
    scholarshipAmount: number | null;
    minEntryRequirements: string | null;
    minEntryRequirementsScale: string | null;
    hasFasterTat: boolean;
  };
  matchedDbId: number | null;
  status: RowStatus;
  errors: string[];
}

export interface ImportPreview {
  universities: PreviewUniRow[];
  courses: PreviewCourseRow[];
  zipFilenames: string[];
  fatalError?: string;
}

interface ImportSummary {
  universities: { created: number; updated: number };
  courses: { created: number; updated: number };
  errors: Array<{ sheet: "University" | "Course"; row: number; message: string }>;
}

interface Props {
  open: boolean;
  preview: ImportPreview | null;
  onClose: () => void;
  onCommitted: (summary: ImportSummary) => void;
}

// ---- Live re-validation --------------------------------------------------

/**
 * Re-derive each row's `errors` and `status` from the current edited data.
 * Runs purely on the client — the server re-validates on commit too.
 *
 * The only field admins can edit inline today is `code`. Adding more is a
 * matter of widening this function and the table cells; the server side
 * already accepts any of the columns.
 */
const CODE_REGEX = /^[a-zA-Z0-9]{3}$/;

function revalidate(unis: PreviewUniRow[]): PreviewUniRow[] {
  const seenCodes = new Map<string, number>(); // code → rowNum (first occurrence)

  // First pass: structural checks (required fields + code shape).
  const passOne = unis.map((u) => {
    const errs: string[] = [];
    if (!u.data.name.trim()) errs.push("name is required");
    if (u.data.country.length !== 2)
      errs.push("country must be a 2-letter ISO code");
    const code = u.data.code?.trim() ?? "";
    if (!code) {
      errs.push("code is required");
    } else if (!CODE_REGEX.test(code)) {
      errs.push("code must be exactly 3 alphanumeric characters");
    }
    return { ...u, errors: errs };
  });

  // Second pass: within-CSV duplicate code detection (only for codes that
  // passed shape validation in pass one — invalid codes don't dedupe).
  return passOne.map((u) => {
    const errs = [...u.errors];
    const code = u.data.code?.trim() ?? "";
    if (code && CODE_REGEX.test(code)) {
      const key = code.toLowerCase();
      const firstRow = seenCodes.get(key);
      if (firstRow !== undefined) {
        errs.push(`duplicate code (also in row ${firstRow})`);
      } else {
        seenCodes.set(key, u.rowNum);
      }
    }
    const status: RowStatus =
      errs.length > 0 ? "error" : u.matchedDbId ? "update" : "new";
    return { ...u, errors: errs, status };
  });
}

// ---- Component -----------------------------------------------------------

export function ImportPreviewModal({ open, preview, onClose, onCommitted }: Props) {
  const [universities, setUniversities] = useState<PreviewUniRow[]>([]);
  const [courses, setCourses] = useState<PreviewCourseRow[]>([]);
  const [tab, setTab] = useState<"universities" | "courses">("universities");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Re-seed local state whenever the parent passes a fresh preview ref.
  useEffect(() => {
    if (preview) {
      setUniversities(revalidate(preview.universities));
      setCourses(preview.courses);
      setTab("universities");
      setCommitError(null);
    }
  }, [preview]);

  const uniCounts = useMemo(() => countByStatus(universities), [universities]);
  const courseCounts = useMemo(() => countByStatus(courses), [courses]);

  const totalErrors = uniCounts.error + courseCounts.error;
  const canCommit =
    !!preview &&
    !preview.fatalError &&
    universities.length + courses.length > 0 &&
    totalErrors === 0;

  const updateUniCode = (rowId: string, value: string) => {
    setUniversities((prev) =>
      revalidate(
        prev.map((u) =>
          u.id === rowId
            ? { ...u, data: { ...u.data, code: value || null } }
            : u,
        ),
      ),
    );
  };

  const deleteUni = (rowId: string) => {
    setUniversities((prev) => revalidate(prev.filter((u) => u.id !== rowId)));
  };

  const deleteCourse = (rowId: string) => {
    setCourses((prev) => prev.filter((c) => c.id !== rowId));
  };

  const handleCommit = async () => {
    if (!preview) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const body: ImportPreview = {
        universities,
        courses,
        zipFilenames: preview.zipFilenames,
      };
      const res = await fetch("/api/admin/uni-import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as ImportSummary | { error: string };
      if (!res.ok || "error" in json) {
        setCommitError(("error" in json && json.error) || `HTTP ${res.status}`);
      } else {
        onCommitted(json);
      }
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Review Bulk Import"
      onClose={onClose}
      width="w-[920px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className="!h-[38px] !px-4">
            Cancel
          </Button>
          <Button
            onClick={handleCommit}
            loading={committing}
            disabled={!canCommit}
            className="!h-[38px] !px-4"
          >
            Confirm &amp; Import
          </Button>
        </>
      }
    >
      {preview?.fatalError ? (
        <ErrorBanner message={preview.fatalError} />
      ) : !preview ? (
        <div className="py-6 text-sm text-[#98A2B3]">Loading preview…</div>
      ) : (
        <>
          {/* Summary line */}
          <div className="flex flex-wrap gap-3 text-sm">
            <SummaryPill
              label={`${universities.length} ${universities.length === 1 ? "university" : "universities"}`}
            />
            <SummaryPill
              tone="green"
              label={`${uniCounts.new} new`}
              hidden={uniCounts.new === 0}
            />
            <SummaryPill
              tone="blue"
              label={`${uniCounts.update} update`}
              hidden={uniCounts.update === 0}
            />
            <SummaryPill
              tone="red"
              label={`${uniCounts.error} error${uniCounts.error === 1 ? "" : "s"}`}
              hidden={uniCounts.error === 0}
            />
            <span className="mx-1 text-[#D0D5DD]">·</span>
            <SummaryPill
              label={`${courses.length} program${courses.length === 1 ? "" : "s"}`}
            />
            <SummaryPill
              tone="green"
              label={`${courseCounts.new} new`}
              hidden={courseCounts.new === 0}
            />
            <SummaryPill
              tone="blue"
              label={`${courseCounts.update} update`}
              hidden={courseCounts.update === 0}
            />
            <SummaryPill
              tone="red"
              label={`${courseCounts.error} error${courseCounts.error === 1 ? "" : "s"}`}
              hidden={courseCounts.error === 0}
            />
            {preview.zipFilenames.length > 0 && (
              <>
                <span className="mx-1 text-[#D0D5DD]">·</span>
                <SummaryPill
                  tone="purple"
                  label={`${preview.zipFilenames.length} logo${preview.zipFilenames.length === 1 ? "" : "s"} extracted from ZIP`}
                />
              </>
            )}
          </div>

          {/* Tabs */}
          <div className="mt-4 flex border-b-2 border-[#E4E7EC]">
            <TabBtn
              active={tab === "universities"}
              onClick={() => setTab("universities")}
            >
              Universities ({universities.length})
            </TabBtn>
            <TabBtn active={tab === "courses"} onClick={() => setTab("courses")}>
              Programs ({courses.length})
            </TabBtn>
          </div>

          {/* Tables */}
          <div className="mt-4 max-h-[420px] overflow-auto rounded-lg border border-[#E4E7EC]">
            {tab === "universities" ? (
              <UniversitiesTable
                rows={universities}
                onUpdateCode={updateUniCode}
                onDelete={deleteUni}
              />
            ) : (
              <CoursesTable rows={courses} onDelete={deleteCourse} />
            )}
          </div>

          {tab === "universities" && totalErrors > 0 && (
            <div className="mt-3 rounded-lg border border-[#FEDF89] bg-[#FFFCF5] p-3 text-xs text-[#B54708]">
              Edit the highlighted <code className="font-mono">code</code> cells
              to resolve duplicates. Confirm becomes available once every row is
              error-free.
            </div>
          )}

          {commitError && (
            <div className="mt-4">
              <ErrorBanner message={commitError} />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---- Tables --------------------------------------------------------------

function UniversitiesTable({
  rows,
  onUpdateCode,
  onDelete,
}: {
  rows: PreviewUniRow[];
  onUpdateCode: (id: string, value: string) => void;
  onDelete: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-[#98A2B3]">
        No universities in this file.
      </div>
    );
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="sticky top-0 z-10 bg-[#F9FAFB]">
        <tr>
          <Th width="60px">Row</Th>
          <Th width="120px">Code</Th>
          <Th>Name</Th>
          <Th width="80px">Country</Th>
          <Th width="120px">City</Th>
          <Th width="60px">Logo</Th>
          <Th width="100px">Status</Th>
          <Th width="50px" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const codeHasError = r.errors.some(
            (e) => e.includes("code") && !e.includes("country"),
          );
          return (
            <tr
              key={r.id}
              className={`border-t border-[#F2F4F7] ${
                r.status === "error" ? "bg-[#FEF3F2]" : ""
              }`}
            >
              <Td className="text-[#98A2B3]">{r.rowNum}</Td>
              <Td>
                <input
                  type="text"
                  value={r.data.code ?? ""}
                  onChange={(e) => onUpdateCode(r.id, e.target.value)}
                  placeholder="3 chars"
                  maxLength={3}
                  className={`h-8 w-full rounded border px-2 font-mono text-xs outline-none focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.1)] ${
                    codeHasError
                      ? "border-[#F04438] bg-[#FEF3F2]"
                      : "border-[#D0D5DD] bg-white"
                  }`}
                />
              </Td>
              <Td className="font-semibold text-[#101828]">{r.data.name || "—"}</Td>
              <Td>{r.data.country || "—"}</Td>
              <Td className="text-[#667085]">{r.data.city ?? "—"}</Td>
              <Td>
                {r.logoFromZip ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#7F56D9]">
                    <CheckIcon className="h-3 w-3" />
                    ZIP
                  </span>
                ) : r.data.logoUrl ? (
                  <span className="text-xs text-[#667085]">URL</span>
                ) : (
                  <span className="text-xs text-[#98A2B3]">—</span>
                )}
              </Td>
              <Td>
                <StatusPill row={r} />
              </Td>
              <Td>
                <DeleteRowButton
                  onClick={() => onDelete(r.id)}
                  title="Remove this row from the import"
                />
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CoursesTable({
  rows,
  onDelete,
}: {
  rows: PreviewCourseRow[];
  onDelete: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-[#98A2B3]">
        No programs in this file.
      </div>
    );
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="sticky top-0 z-10 bg-[#F9FAFB]">
        <tr>
          <Th width="60px">Row</Th>
          <Th width="140px">Code</Th>
          <Th>Name</Th>
          <Th width="80px">Uni xlsxId</Th>
          <Th width="100px">Status</Th>
          <Th width="50px" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            className={`border-t border-[#F2F4F7] ${
              r.status === "error" ? "bg-[#FEF3F2]" : ""
            }`}
          >
            <Td className="text-[#98A2B3]">{r.rowNum}</Td>
            <Td className="font-mono text-xs text-[#475467]">
              {r.data.code ?? "—"}
            </Td>
            <Td className="font-semibold text-[#101828]">{r.data.name || "—"}</Td>
            <Td className="font-mono text-xs text-[#667085]">
              {r.xlsxUniversityId ?? "—"}
            </Td>
            <Td>
              <StatusPill row={r} />
            </Td>
            <Td>
              <DeleteRowButton
                onClick={() => onDelete(r.id)}
                title="Remove this row from the import"
              />
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DeleteRowButton({
  onClick,
  title,
}: {
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-transparent text-[#98A2B3] transition-colors hover:border-[#FECDCA] hover:bg-[#FEF3F2] hover:text-[#F04438]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="h-4 w-4"
      >
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
  );
}

// ---- Atoms ---------------------------------------------------------------

function StatusPill({ row }: { row: { status: RowStatus; errors: string[] } }) {
  if (row.status === "error") {
    return (
      <span
        title={row.errors.join("\n")}
        className="inline-block rounded-md bg-[#FEF3F2] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#B42318]"
      >
        Error
      </span>
    );
  }
  if (row.status === "update") {
    return (
      <span className="inline-block rounded-md bg-[#EFF8FF] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#175CD3]">
        Update
      </span>
    );
  }
  return (
    <span className="inline-block rounded-md bg-[#ECFDF3] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#067647]">
      New
    </span>
  );
}

function SummaryPill({
  label,
  tone = "neutral",
  hidden,
}: {
  label: string;
  tone?: "neutral" | "green" | "blue" | "red" | "purple";
  hidden?: boolean;
}) {
  if (hidden) return null;
  const palette: Record<NonNullable<typeof tone>, string> = {
    neutral: "bg-[#F2F4F7] text-[#475467]",
    green: "bg-[#ECFDF3] text-[#067647]",
    blue: "bg-[#EFF8FF] text-[#175CD3]",
    red: "bg-[#FEF3F2] text-[#B42318]",
    purple: "bg-[#F4F3FF] text-[#5925DC]",
  };
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${palette[tone]}`}
    >
      {label}
    </span>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">
      {message}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-0.5 cursor-pointer border-b-2 bg-transparent px-4 py-2 text-sm font-semibold transition-colors ${
        active
          ? "border-[#1570EF] text-[#1570EF]"
          : "border-transparent text-[#667085] hover:text-[#1570EF]"
      }`}
    >
      {children}
    </button>
  );
}

function Th({ children, width }: { children?: React.ReactNode; width?: string }) {
  return (
    <th
      style={width ? { width } : undefined}
      className="border-b border-[#E4E7EC] bg-[#F9FAFB] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[#667085]"
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 align-middle ${className ?? ""}`}>{children}</td>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      className={className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ---- Helpers -------------------------------------------------------------

function countByStatus(rows: Array<{ status: RowStatus }>): {
  new: number;
  update: number;
  error: number;
} {
  return rows.reduce(
    (acc, r) => {
      acc[r.status]++;
      return acc;
    },
    { new: 0, update: 0, error: 0 },
  );
}
