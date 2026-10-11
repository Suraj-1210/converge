"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import { useExportLog } from "~/lib/export-log";
import { Button } from "~/components/ui/button";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { StatCard } from "~/components/dashboard/widgets";
import { SkeletonTable } from "~/components/dashboard/widgets";
import { AdminRole } from "~/server/db/enums";

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-[13px] whitespace-nowrap text-[#344054]";

const ACTION_TONE: Record<string, string> = {
  "Status Change": "bg-[#FFFAEB] text-[#B54708]",
  Approval: "bg-[#FDF2FA] text-[#C11574]",
  Rejection: "bg-[#FEF3F2] text-[#B42318]",
  Invite: "bg-[#EFF8FF] text-[#175CD3]",
  Delete: "bg-[#FEF3F2] text-[#B42318]",
  View: "bg-[#F2F4F7] text-[#667085]",
  Create: "bg-[#ECFDF3] text-[#067647]",
  Update: "bg-[#F5F3FF] text-[#6941C6]",
  Action: "bg-[#F2F4F7] text-[#667085]",
};

const fmtKey = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const str = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
};
const pad = (n: number) => String(n).padStart(2, "0");
const fmtTs = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export default function AuditLogsPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const canView = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER || role === AdminRole.FINANCE_EXECUTIVE;
  const canExport = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;

  const [user, setUser] = useState("");
  const [action, setAction] = useState("");
  const [module, setModule] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);

  const utils = api.useUtils();
  const logExport = useExportLog();
  const filtersQ = api.audit.filters.useQuery(undefined, { enabled: canView });
  const queryInput = useMemo(
    () => ({ page, module: module || undefined, category: action || undefined, actorId: user ? Number(user) : undefined, from: from || undefined, to: to || undefined, search: search || undefined }),
    [page, module, action, user, from, to, search],
  );
  const listQ = api.audit.list.useQuery(queryInput, { enabled: canView, placeholderData: keepPreviousData });

  const data = listQ.data;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? { today: 0, week: 0, month: 0, total: 0 };
  const pageSize = data?.pageSize ?? 15;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const reset = () => { setUser(""); setAction(""); setModule(""); setFrom(""); setTo(""); setSearch(""); setPage(1); };
  const toggle = (id: number) => setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const exportCsv = async () => {
    const all = await utils.audit.export.fetch({ module: module || undefined, category: action || undefined, actorId: user ? Number(user) : undefined, from: from || undefined, to: to || undefined, search: search || undefined });
    const header = ["Audit ID", "Timestamp", "User", "User ID", "Action Type", "Module", "Description"];
    const body = all.map((l) => [String(l.id), fmtTs(l.timestamp), l.actor, l.actorId != null ? String(l.actorId) : "", l.category, l.module, l.description]);
    const csv = [header, ...body].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `audit_log_export_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    logExport("Audit log CSV", all.length);
    setToastMsg(`Exported ${all.length} audit ${all.length === 1 ? "entry" : "entries"} as CSV`); setToastOpen(true);
  };

  if (mounted && !canView) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-[#E4E7EC] bg-white px-8 py-12 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#FEF3F2] text-2xl">🔒</div>
          <h2 className="text-lg font-bold text-[#101828]">Access Restricted</h2>
          <p className="mt-2 text-sm text-[#667085]">Audit Logs are available to Super Admins, Finance Managers, and Finance Executives only.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Audit Logs</h1>
          <p className="mt-1 text-sm text-[#667085]">Track all system activities and changes for compliance</p>
        </div>
        {mounted && canExport && <Button variant="secondary" onClick={exportCsv}>Export CSV</Button>}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="bolt" tone="blue" label="Actions Today" value={stats.today} sub="Recorded today" />
        <StatCard icon="applications" tone="orange" label="Last 7 Days" value={stats.week} sub="Past week" />
        <StatCard icon="clock" tone="purple" label="Last 30 Days" value={stats.month} sub="Past month" />
        <StatCard icon="check" tone="green" label="Total Logged" value={stats.total} sub="All time" />
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="w-44"><FormSelect label="User" placeholder="All Users" options={(filtersQ.data?.admins ?? []).map((a) => ({ value: String(a.id), label: a.name }))} value={user} onChange={(e) => { setUser(e.target.value); setPage(1); }} /></div>
        <div className="w-44"><FormSelect label="Action" placeholder="All Actions" options={(filtersQ.data?.categories ?? []).map((a) => ({ value: a, label: a }))} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} /></div>
        <div className="w-44"><FormSelect label="Module" placeholder="All Modules" options={(filtersQ.data?.modules ?? []).map((m) => ({ value: m, label: m }))} value={module} onChange={(e) => { setModule(e.target.value); setPage(1); }} /></div>
        <div className="w-36"><label className="mb-1.5 block text-sm font-medium text-[#344054]">From</label><input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-10 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]" /></div>
        <div className="w-36"><label className="mb-1.5 block text-sm font-medium text-[#344054]">To</label><input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-10 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]" /></div>
        <div className="w-52"><label className="mb-1.5 block text-sm font-medium text-[#344054]">Search</label><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search action…" className="h-10 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]" /></div>
        <Button variant="secondary" onClick={reset}>Reset</Button>
        <span className="ml-auto self-center text-xs text-[#98A2B3]">{total} {total === 1 ? "entry" : "entries"}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
        <div className="flex items-center gap-2 border-b border-[#E4E7EC] px-5 py-3.5">
          <h3 className="text-[15px] font-semibold text-[#101828]">Audit Log</h3>
          <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{total}</span>
        </div>
        <div className="overflow-x-auto">
          {!mounted || listQ.isLoading ? (
            <div className="p-4"><SkeletonTable rows={8} cols={5} /></div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Timestamp</th>
                  <th className={TH}>User</th>
                  <th className={TH}>Action Type</th>
                  <th className={TH}>Module</th>
                  <th className={`${TH} normal-case`}>Description</th>
                  <th className={`${TH} w-10`}></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-[#98A2B3]">No audit entries found</td></tr>
                ) : rows.map((l) => {
                  const isOpen = open.has(l.id);
                  const before = l.metadata.before, after = l.metadata.after;
                  return (
                    <Fragment key={l.id}>
                      <tr className="cursor-pointer border-b border-[#F2F4F7] last:border-0 hover:bg-[#F0F7FF]" onClick={() => toggle(l.id)}>
                        <td className={TD}>{fmtTs(l.timestamp)}</td>
                        <td className={`${TD} font-semibold text-[#101828]`}>{l.actor}</td>
                        <td className={TD}><span className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${ACTION_TONE[l.category] ?? "bg-[#F2F4F7] text-[#667085]"}`}>{l.category}</span></td>
                        <td className={TD}>{l.module}</td>
                        <td className="max-w-[360px] px-3.5 py-3 text-[13px] text-[#344054]">{l.description}</td>
                        <td className={`${TD} text-center`}>
                          <svg viewBox="0 0 24 24" className={`mx-auto h-4 w-4 text-[#667085] transition-transform ${isOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-[#F9FAFB]">
                          <td colSpan={6} className="px-5 py-4">
                            <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs sm:grid-cols-4">
                              <Detail k="Audit ID" v={`#${l.id}`} /><Detail k="Action" v={l.action} />
                              <Detail k="Timestamp" v={fmtTs(l.timestamp)} />{l.entityId != null && <Detail k="Entity ID" v={`#${l.entityId}`} />}
                              {Object.entries(l.metadata).filter(([k]) => !["before", "after", "byCpUserId"].includes(k)).map(([k, v]) => (
                                <Detail key={k} k={fmtKey(k)} v={str(v)} />
                              ))}
                            </div>
                            {before != null && after != null && (
                              <div className="mt-3">
                                <div className="mb-1.5 text-xs font-semibold text-[#475467]">Changes Made</div>
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                  <span className="rounded-md bg-[#FEF3F2] px-2 py-1 text-[#912018]">{str(before)}</span>
                                  <span className="text-[#98A2B3]">→</span>
                                  <span className="rounded-md bg-[#ECFDF3] px-2 py-1 text-[#067647]">{str(after)}</span>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-[#E4E7EC] px-5 py-3">
            <span className="text-[13px] text-[#667085]">Page {page} of {totalPages} ({total} entries)</span>
            <div className="flex items-center gap-1.5">
              <button disabled={page === 1} onClick={() => setPage((p) => p - 1)} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-[13px] disabled:opacity-40">Prev</button>
              <span className="px-2 text-[13px] text-[#344054]">{page}</span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-[13px] disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return <div><span className="text-[#98A2B3]">{k}:</span> <span className="font-medium text-[#344054]">{v}</span></div>;
}
