"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Icon, SkeletonTable } from "~/components/dashboard/widgets";
import { countryName, formatDate } from "~/components/dashboard/format";
import { StudentStatusBadge } from "~/components/students/status";
import { stageTone } from "~/lib/application-stages";
import { stageLabel } from "~/components/dashboard/format";
import { useExportLog } from "~/lib/export-log";
import { drillLabel, periodLabel, type DrillSort } from "~/lib/reports";
import { type Drill, fmtN } from "./ui";
import { downloadCsv, drillTable, fileStamp, filterSummary, type FilterNames } from "./export";

const PAGE_SIZE = 25;

export function StageBadge({ status }: { status: number }) {
  const t = stageTone(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
      style={{ background: t.bg, color: t.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color }} />
      {stageLabel(status)}
    </span>
  );
}

const d = (v: string | null) => (v ? formatDate(v) : "—");

export function DrillModal({ drill, names, onClose }: { drill: Drill | null; names: FilterNames; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: DrillSort; dir: "asc" | "desc" } | null>(null);
  const [exporting, setExporting] = useState(false);
  const utils = api.useUtils();
  const logExport = useExportLog();

  // Reset when a different count is opened.
  useEffect(() => {
    setSearch("");
    setQ("");
    setPage(1);
    setSort(null);
  }, [drill]);
  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const input = drill
    ? {
        filters: drill.filters,
        metric: drill.metric,
        search: q || undefined,
        sort: sort?.key,
        dir: sort?.dir,
        page,
        pageSize: PAGE_SIZE,
      }
    : null;
  const res = api.reports.drilldown.useQuery(input!, { enabled: !!input, placeholderData: (p) => p });
  const data = res.data;
  const kind = data?.kind ?? "app";
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  if (!drill) return null;

  const sortBy = (key: DrillSort) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "student" ? "asc" : "desc" }));
  const Th = ({ k, children, className }: { k?: DrillSort; children: React.ReactNode; className?: string }) => (
    <th className={`border-b border-[#E4E7EC] px-3 py-2.5 whitespace-nowrap ${className ?? ""}`}>
      {k ? (
        <button type="button" onClick={() => sortBy(k)} className="inline-flex items-center gap-1 uppercase hover:text-[#1570EF]">
          {children}
          {sort?.key === k && <span aria-hidden>{sort.dir === "desc" ? "↓" : "↑"}</span>}
        </button>
      ) : (
        children
      )}
    </th>
  );

  async function exportCsv() {
    if (!drill) return;
    setExporting(true);
    try {
      const all = await utils.reports.drilldown.fetch({
        filters: drill.filters,
        metric: drill.metric,
        search: q || undefined,
        sort: sort?.key,
        dir: sort?.dir,
        page: 1,
        pageSize: 5000,
      });
      const t = drillTable(all.kind, all.rows);
      const file = `report-${drillLabel(drill.metric).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${fileStamp()}.csv`;
      downloadCsv(file, [[drill.title], [filterSummary(drill.filters, names)], [], t.head, ...t.rows]);
      logExport(`Reports & Analytics drill-down CSV (${drill.title})`, t.rows.length);
    } finally {
      setExporting(false);
    }
  }

  const appKind = kind === "app" || kind === "student";
  return (
    <Modal open title={drill.title} onClose={onClose} width="w-[1320px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-[#667085]">
          <span className="font-semibold text-[#101828]">{data ? fmtN(data.total) : "…"}</span>{" "}
          {kind === "app"
            ? "applications"
            : kind === "student"
              ? "students (their furthest application shown)"
              : kind === "lead"
                ? "students added"
                : "students (latest programme shown)"}{" "}
          · {periodLabel(drill.filters.from, drill.filters.to)}
          <span className="block text-[12px] text-[#98A2B3]">{filterSummary(drill.filters, names, true)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search student, ID, university, partner…"
              className="h-9 w-[280px] rounded-lg border border-[#D0D5DD] pr-3 pl-8 text-[13px] outline-none focus:border-[#1570EF]"
            />
            <svg viewBox="0 0 24 24" className="absolute top-2.5 left-2.5 h-4 w-4 text-[#98A2B3]" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </div>
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={exporting || !data?.total}
            className="h-9 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] font-medium text-[#344054] hover:bg-[#F9FAFB] disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[#E4E7EC]">
        {!data ? (
          <SkeletonTable rows={8} cols={8} />
        ) : data.rows.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[#667085]">No records{q ? " match this search" : ""}.</div>
        ) : (
          <table className={`w-full border-collapse text-[12.5px] ${res.isFetching ? "opacity-60" : ""}`}>
            <thead>
              <tr className="bg-[#F9FAFB] text-left text-[11px] font-semibold tracking-[0.3px] text-[#667085] uppercase">
                <Th k="student">Student</Th>
                <Th k="partner">Partner</Th>
                {kind !== "lead" && <Th k="university">University · Course</Th>}
                <Th k="intake">Intake</Th>
                <Th k="country">Country</Th>
                <Th k="counsellor">{kind === "shortlist" ? "Shortlisted by" : "Counsellor"}</Th>
                <Th k="rm">RM</Th>
                {appKind && <Th k="vendor">Vendor</Th>}
                <Th k="lead">Lead date</Th>
                {appKind && <Th k="submitted">Submitted</Th>}
                {kind === "shortlist" && <Th k="stageAt">Shortlisted</Th>}
                <Th k="stage">{appKind ? "Stage" : "Student status"}</Th>
                <Th>Latest remark</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.studentId}-${r.appId ?? 0}`} className="border-b border-[#F2F4F7] align-top last:border-0 hover:bg-[#FCFCFD]">
                  <td className="min-w-[150px] px-3 py-2">
                    <Link
                      href={`/admin/students/${r.studentId}${appKind ? "?tab=application" : ""}`}
                      className="font-semibold text-[#101828] hover:text-[#1570EF] hover:underline"
                      target="_blank"
                    >
                      {r.studentName}
                    </Link>
                    <div className="text-[11px] text-[#98A2B3]">
                      CP-{r.studentId}
                      {r.appId ? ` · App #${r.appId}` : ""}
                      {kind === "student" && r.count > 1 ? ` · ${r.count} active apps` : ""}
                      {kind === "lead" ? ` · ${r.count} app${r.count === 1 ? "" : "s"}` : ""}
                      {kind === "shortlist" && r.count > 1 ? ` · ${r.count} programmes` : ""}
                    </div>
                  </td>
                  <td className="max-w-[160px] px-3 py-2 text-[#344054]">{r.partner ?? "—"}</td>
                  {kind !== "lead" && (
                    <td className="max-w-[240px] px-3 py-2">
                      <div className="font-medium text-[#344054]">{r.university ?? "—"}</div>
                      <div className="text-[11px] text-[#667085]">{r.course}</div>
                    </td>
                  )}
                  <td className="px-3 py-2 whitespace-nowrap text-[#344054]">{r.intake ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-[#344054]">{r.country ? countryName(r.country) : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-[#344054]">{r.counsellor ?? <span className="text-[#98A2B3]">Not assigned</span>}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-[#344054]">{r.rm ?? <span className="text-[#98A2B3]">—</span>}</td>
                  {appKind && <td className="px-3 py-2 whitespace-nowrap text-[#344054]">{r.vendor}</td>}
                  <td className="px-3 py-2 whitespace-nowrap text-[#667085]">{d(r.leadAt)}</td>
                  {appKind && <td className="px-3 py-2 whitespace-nowrap text-[#667085]">{d(r.submittedAt)}</td>}
                  {kind === "shortlist" && <td className="px-3 py-2 whitespace-nowrap text-[#667085]">{d(r.stageAt)}</td>}
                  <td className="px-3 py-2">
                    {appKind ? <StageBadge status={r.status} /> : <StudentStatusBadge status={r.status} />}
                    {appKind && r.stageAt && <div className="mt-0.5 text-[11px] text-[#98A2B3]">since {d(r.stageAt)}</div>}
                  </td>
                  <td className="max-w-[260px] px-3 py-2 text-[12px] text-[#475467]">
                    {r.remark ? (
                      <span className="line-clamp-2" title={r.remark}>
                        {r.remark}
                      </span>
                    ) : (
                      <span className="text-[#D0D5DD]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-[13px] text-[#667085]">
          <span>
            {fmtN((page - 1) * PAGE_SIZE + 1)}–{fmtN(Math.min(page * PAGE_SIZE, data.total))} of {fmtN(data.total)}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="flex h-8 items-center gap-1 rounded-lg border border-[#D0D5DD] bg-white px-2.5 font-medium hover:bg-[#F9FAFB] disabled:opacity-40"
            >
              <Icon name="chevron-down" size={14} className="rotate-90" /> Prev
            </button>
            <span className="px-2">
              Page {page} of {pages}
            </span>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="flex h-8 items-center gap-1 rounded-lg border border-[#D0D5DD] bg-white px-2.5 font-medium hover:bg-[#F9FAFB] disabled:opacity-40"
            >
              Next <Icon name="chevron-down" size={14} className="-rotate-90" />
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
