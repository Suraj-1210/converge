"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { useExportLog } from "~/lib/export-log";
import { Modal } from "~/components/ui/modal";
import { UnsetSharesModal } from "./unset-shares-modal";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import {
  DashboardCard,
  StatCard,
  SkeletonTable,
  EmptyState,
} from "~/components/dashboard/widgets";
import { formatINR, formatDate, countryFlag } from "~/components/dashboard/format";
import {
  AdminRole,
  CommissionStatus,
  CommissionStatusLabel,
  TrancheStatus,
  TrancheStatusLabel,
  financialYearLabel,
} from "~/server/db/enums";

type RO = inferRouterOutputs<AppRouter>;
type Row = RO["commissions"]["list"][number];
type TrancheRow = Row["tranches"][number];

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap text-[#667085]";
const TD = "px-3.5 py-3 text-sm whitespace-nowrap text-[#344054]";
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// The 5 lifecycle stages in order, with the card icon/tone for the pipeline.
const STAGES = [
  { s: CommissionStatus.NOT_INVOICED, icon: "clock", tone: "red" },
  { s: CommissionStatus.INVOICED, icon: "applications", tone: "blue" },
  { s: CommissionStatus.RECEIVED, icon: "deposit", tone: "green" },
  { s: CommissionStatus.READY_TO_DISBURSE, icon: "revenue", tone: "orange" },
  { s: CommissionStatus.DISBURSED, icon: "trophy", tone: "purple" },
] as const;

const STATUS_TONE: Record<number, string> = {
  [CommissionStatus.NOT_INVOICED]: "bg-[#FEF3F2] text-[#B42318]",
  [CommissionStatus.INVOICED]: "bg-[#EFF8FF] text-[#1570EF]",
  [CommissionStatus.RECEIVED]: "bg-[#ECFDF3] text-[#067647]",
  [CommissionStatus.READY_TO_DISBURSE]: "bg-[#FFF6ED] text-[#B54708]",
  [CommissionStatus.DISBURSED]: "bg-[#F4F3FF] text-[#6941C6]",
  [CommissionStatus.CANCELLED]: "bg-[#F2F4F7] text-[#667085]",
};

function StatusPill({ status }: { status: number }) {
  return (
    <span className={`rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status] ?? STATUS_TONE[CommissionStatus.CANCELLED]}`}>
      {CommissionStatusLabel[status as CommissionStatus] ?? "—"}
    </span>
  );
}

// Feather-style stroke icons matching the app's icon language.
const ICON = "h-3.5 w-3.5 shrink-0";
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
);

// Next-step hint: a link into the relevant screen (CP's move), muted text with a
// clock for a partner's move (awaiting claim), or a green check for "Done".
function NextStep({ next }: { next: Row["next"] }) {
  if (!next)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#12B76A]">
        <CheckIcon /> Done
      </span>
    );
  if (next.href)
    return (
      <Link href={next.href} className="text-[13px] font-semibold text-[#1570EF] hover:underline">
        {next.label} →
      </Link>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#B54708]">
      <ClockIcon /> {next.label}
    </span>
  );
}

// Compact tranche pip bar — paid (blue) / collected-unpaid (green) / pending (grey).
function TrancheBar({ t }: { t: Row["tranche"] }) {
  if (t.total <= 1) return <span className="text-[#98A2B3]">—</span>;
  return (
    <div>
      <div className="flex items-center gap-0.5">
        {Array.from({ length: t.total }, (_, i) => {
          const cls = i < t.paid ? "bg-[#1570EF]" : i < t.collected ? "bg-[#12B76A]" : "bg-[#EAECF0]";
          return <span key={i} className={`h-1.5 w-4 rounded-full ${cls}`} />;
        })}
      </div>
      <div className="mt-1 text-[10px] text-[#98A2B3]">{t.collected}/{t.total} collected{t.paid > 0 ? ` · ${t.paid} paid` : ""}</div>
    </div>
  );
}

// ---- CSV --------------------------------------------------------------------
const csvCell = (v: string | number | null | undefined): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const content = rows.map((r) => r.map(csvCell).join(",")).join("\n");
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
const stamp = () => new Date().toISOString().slice(0, 10);

// =============================================================================
export default function AdminCommissionsPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const canView =
    role === AdminRole.SUPER_ADMIN ||
    role === AdminRole.FINANCE_MANAGER ||
    role === AdminRole.FINANCE_EXECUTIVE;
  const canEdit = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [tab, setTab] = useState<"commissions" | "partners">("commissions");
  const [statusF, setStatusF] = useState<number | null>(null);
  const [partner, setPartner] = useState("");
  const [intake, setIntake] = useState("");
  const [country, setCountry] = useState("");
  const [fy, setFy] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detailFor, setDetailFor] = useState<Row | null>(null);

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (m: string) => { setToastMsg(m); setToastOpen(true); };

  const utils = api.useUtils();
  const logExport = useExportLog();
  const listQ = api.commissions.list.useQuery(undefined, { enabled: canView && mounted });
  const rows = useMemo(() => listQ.data ?? [], [listQ.data]);
  // Rows confirmed before Partner Tiers: no stamped share, so unclaimable.
  const unsetShareCount = useMemo(() => rows.filter((r) => r.partnerSharePct == null).length, [rows]);
  const [unsetOpen, setUnsetOpen] = useState(false);

  const bulkApprove = api.commissions.bulkApprove.useMutation({
    onSuccess: (r) => {
      void utils.commissions.invalidate();
      setSelected(new Set());
      showToast(`${r.approved} invoice(s) approved for disbursement${r.skipped ? ` · ${r.skipped} skipped` : ""}`);
    },
    onError: (e) => showToast(e.message),
  });

  // ---- pipeline aggregates ----
  const pipeline = useMemo(() => {
    const m = new Map<number, { count: number; inr: number }>();
    for (const r of rows) {
      const e = m.get(r.status) ?? { count: 0, inr: 0 };
      e.count += 1;
      e.inr += r.commissionInr;
      m.set(r.status, e);
    }
    return m;
  }, [rows]);

  // ---- filter dropdown options ----
  const partners = useMemo(() => Array.from(new Set(rows.map((r) => r.partner))).sort(), [rows]);
  const intakes = useMemo(() => Array.from(new Set(rows.map((r) => r.intake).filter(Boolean))) as string[], [rows]);
  const countries = useMemo(() => Array.from(new Set(rows.map((r) => r.country))).sort(), [rows]);
  const fys = useMemo(() => Array.from(new Set(rows.map((r) => r.fy))).sort((a, b) => b - a), [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusF != null && r.status !== statusF) return false;
      if (partner && r.partner !== partner) return false;
      if (intake && r.intake !== intake) return false;
      if (country && r.country !== country) return false;
      if (fy != null && r.fy !== fy) return false;
      if (search.trim() && !`${r.studentName} ${r.cpStudentId} ${r.partner} ${r.university}`.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [rows, statusF, partner, intake, country, fy, search]);

  const selectedRows = rows.filter((r) => selected.has(r.commissionId));
  // Only RECEIVED commissions with a partner invoice are bulk-approvable.
  const approvable = (r: Row) => r.status === CommissionStatus.RECEIVED && r.partnerInvoice != null;
  const selectableInView = filtered.filter(approvable).map((r) => r.commissionId);
  const allSelected = selectableInView.length > 0 && selectableInView.every((id) => selected.has(id));
  const toggle = (id: number) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setAll = (on: boolean) => setSelected((p) => { const n = new Set(p); for (const id of selectableInView) { if (on) n.add(id); else n.delete(id); } return n; });

  const pickStage = (s: number) => { setStatusF((c) => (c === s ? null : s)); };

  const exportCsv = () => {
    const src = selectedRows.length > 0 ? selectedRows : filtered;
    if (src.length === 0) { showToast("Nothing to export."); return; }
    const header = ["CP Student ID", "Student", "Partner", "University", "Country", "Program", "Intake", "Vendor", "Currency", "Tuition", "Rate %", "Commission", "INR Value", "Partner Share %", "Partner Share (INR)", "Status", "Tranches Collected", "Tranches Paid", "Vendor Invoice", "Partner Invoice"];
    const body = src.map((r) => [
      r.cpStudentId, r.studentName, r.partner, r.university, r.country, r.program, r.intake ?? "", r.vendorName,
      r.currency, r.tuition, r.rate, r.commissionAmount, r.commissionInr, r.partnerSharePct ?? "Not set", r.partnerShareInr,
      CommissionStatusLabel[r.status as CommissionStatus] ?? "", `${r.tranche.collected}/${r.tranche.total}`, `${r.tranche.paid}/${r.tranche.total}`,
      r.vendorInvoice?.number ?? "", r.partnerInvoice?.number ?? "",
    ]);
    downloadCsv(`commission-ledger-${stamp()}.csv`, [header, ...body]);
    logExport("Commission ledger CSV", body.length);
  };

  // ---- partner summary (tab 2) ----
  const byPartner = useMemo(() => {
    const m = new Map<string, { partner: string; records: Row[]; inr: number; counts: Map<number, number> }>();
    for (const r of filtered) {
      let g = m.get(r.partner);
      if (!g) { g = { partner: r.partner, records: [], inr: 0, counts: new Map() }; m.set(r.partner, g); }
      g.records.push(r);
      g.inr += r.commissionInr;
      g.counts.set(r.status, (g.counts.get(r.status) ?? 0) + 1);
    }
    return Array.from(m.values()).sort((a, b) => b.inr - a.inr);
  }, [filtered]);

  if (!mounted || meQ.isLoading) {
    return (
      <DashboardCard title="Commission Ledger" bodyClassName="p-0">
        <SkeletonTable rows={6} cols={6} />
      </DashboardCard>
    );
  }
  if (!canView) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-[#E4E7EC] bg-white px-8 py-12 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#FEF3F2] text-2xl">🔒</div>
          <h2 className="text-lg font-bold text-[#101828]">Access Restricted</h2>
          <p className="mt-2 text-sm text-[#667085]">Finance modules are available to Finance Managers and Admins only.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-16">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#101828]">Commission Ledger</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Every commission across all partners, end-to-end. The money-moving steps open the screens that record the real exchange rate and payment reference.
        </p>
      </div>

      {canEdit && unsetShareCount > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3">
          <div className="text-sm text-[#93370D]">
            <b>{unsetShareCount} commission{unsetShareCount === 1 ? "" : "s"}</b> confirmed before Partner Tiers {unsetShareCount === 1 ? "has" : "have"} no partner share, so partners can&apos;t claim {unsetShareCount === 1 ? "it" : "them"}.
          </div>
          <Button className="!h-9 !px-4 !text-[13px]" onClick={() => setUnsetOpen(true)}>Review and set shares</Button>
        </div>
      )}

      {/* Pipeline stat cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {STAGES.map(({ s, icon, tone }) => {
          const agg = pipeline.get(s) ?? { count: 0, inr: 0 };
          return (
            <StatCard
              key={s}
              icon={icon}
              tone={tone}
              label={CommissionStatusLabel[s]}
              value={listQ.data ? agg.count : "—"}
              sub={formatINR(agg.inr)}
              active={statusF === s}
              onClick={() => pickStage(s)}
            />
          );
        })}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-44"><FormSelect label="Partner" placeholder="All Partners" options={partners.map((p) => ({ value: p, label: p }))} value={partner} onChange={(e) => setPartner(e.target.value)} /></div>
        <div className="w-36"><FormSelect label="Intake" placeholder="All Intakes" options={intakes.map((i) => ({ value: i, label: i }))} value={intake} onChange={(e) => setIntake(e.target.value)} /></div>
        <div className="w-40"><FormSelect label="Country" placeholder="All Countries" options={countries.map((c) => ({ value: c, label: `${countryFlag(c)} ${c}` }))} value={country} onChange={(e) => setCountry(e.target.value)} /></div>
        <div className="w-44"><FormSelect label="Status" placeholder="All Statuses" options={STAGES.map(({ s }) => ({ value: String(s), label: CommissionStatusLabel[s] }))} value={statusF == null ? "" : String(statusF)} onChange={(e) => setStatusF(e.target.value ? Number(e.target.value) : null)} /></div>
        <div className="w-36"><FormSelect label="Financial Year" placeholder="All Years" options={fys.map((y) => ({ value: String(y), label: financialYearLabel(y) }))} value={fy == null ? "" : String(fy)} onChange={(e) => setFy(e.target.value ? Number(e.target.value) : null)} /></div>
        <div className="ml-auto w-56"><FormInput label="Search" placeholder="Student, partner, university..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b border-[#E4E7EC]">
        {([
          { id: "commissions", label: "Commissions", count: filtered.length },
          { id: "partners", label: "By Partner", count: byPartner.length },
        ] as const).map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-semibold transition ${tab === t.id ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}>
            {t.label}
            <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === "commissions" ? (
        <DashboardCard title={`Commissions (${filtered.length})`} bodyClassName="p-0" headerRight={<Button variant="secondary" className="!h-9 !px-4 !text-[13px]" onClick={exportCsv}>Export CSV</Button>}>
          {listQ.isLoading ? (
            <SkeletonTable rows={6} cols={9} />
          ) : rows.length === 0 ? (
            <EmptyState label="No commissions yet. They appear once an enrolled student is confirmed for billing." />
          ) : filtered.length === 0 ? (
            <EmptyState label="No commissions match your filters." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" style={{ minWidth: 1400 }}>
                <thead>
                  <tr>
                    <th className={`${TH} w-10`}>
                      {canEdit && <input type="checkbox" aria-label="Select all approvable" checked={allSelected} disabled={selectableInView.length === 0} onChange={(e) => setAll(e.target.checked)} />}
                    </th>
                    <th className={TH}>Student</th>
                    <th className={TH}>Partner</th>
                    <th className={TH}>University</th>
                    <th className={TH}>Country</th>
                    <th className={TH}>Tuition</th>
                    <th className={TH}>Rate</th>
                    <th className={TH}>Commission</th>
                    <th className={TH}>INR Value</th>
                    <th className={TH}>Partner Share</th>
                    <th className={TH}>Status</th>
                    <th className={TH}>Tranche</th>
                    <th className={`${TH} text-right`}>Next Step</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.commissionId} className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
                      <td className={`${TD} w-10`}>
                        {canEdit && <input type="checkbox" disabled={!approvable(r)} checked={selected.has(r.commissionId)} onChange={() => toggle(r.commissionId)} />}
                      </td>
                      <td className={`${TD} cursor-pointer`} onClick={() => setDetailFor(r)}>
                        <span className="font-semibold text-[#1570EF]">{r.studentName}</span>
                        <span className="block text-xs text-[#98A2B3]">{r.cpStudentId}</span>
                      </td>
                      <td className={TD}>{r.partner}</td>
                      <td className={TD}>{r.university}<span className="block text-xs text-[#98A2B3]">{r.program}</span></td>
                      <td className={TD}>{countryFlag(r.country)} {r.country}</td>
                      <td className={TD}>{r.currency} {r.tuition.toLocaleString()}</td>
                      <td className={TD}>{r.rate}%</td>
                      <td className={`${TD} font-medium`}>{r.currency} {r.commissionAmount.toLocaleString()}</td>
                      <td className={`${TD} font-semibold text-[#101828]`}>{inr(r.commissionInr)}</td>
                      <td className={TD}>
                        {r.partnerSharePct == null ? (
                          <span className="font-semibold text-[#B54708]" title="Confirmed before Partner Tiers — not claimable until a share is set">Not set</span>
                        ) : (
                          <>{r.partnerSharePct}%{r.partnerTier && <span className="block text-xs text-[#98A2B3]">{r.partnerTier}</span>}</>
                        )}
                      </td>
                      <td className={TD}><StatusPill status={r.status} /></td>
                      <td className={TD}><TrancheBar t={r.tranche} /></td>
                      <td className={`${TD} text-right`}><NextStep next={r.next} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashboardCard>
      ) : (
        <PartnersTab groups={byPartner} onOpen={setDetailFor} />
      )}

      {/* Bulk bar */}
      {canEdit && selectedRows.length > 0 && (
        <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-[#E4E7EC] bg-white px-5 py-3 shadow-[0_8px_24px_rgba(16,24,40,0.12)]">
          <span className="text-sm font-semibold text-[#101828]">{selectedRows.length} selected</span>
          <Button className="!h-9 !px-4 !text-[13px]" loading={bulkApprove.isPending} onClick={() => bulkApprove.mutate({ commissionIds: selectedRows.map((r) => r.commissionId) })}>Approve for Disbursement</Button>
          <Button variant="secondary" className="!h-9 !px-4 !text-[13px]" onClick={exportCsv}>Export CSV</Button>
          <button className="text-[13px] font-semibold text-[#667085] hover:underline" onClick={() => setSelected(new Set())}>✕ Clear</button>
        </div>
      )}

      {detailFor && <CommissionDetailModal row={detailFor} onClose={() => setDetailFor(null)} />}
      {unsetOpen && <UnsetSharesModal onClose={() => setUnsetOpen(false)} onDone={showToast} />}
      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}

// ---- Partners tab -----------------------------------------------------------
function PartnersTab({
  groups,
  onOpen,
}: {
  groups: { partner: string; records: Row[]; inr: number; counts: Map<number, number> }[];
  onOpen: (r: Row) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  if (groups.length === 0) return <DashboardCard title="By Partner" bodyClassName="p-0"><EmptyState label="No commissions match your filters." /></DashboardCard>;
  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const isOpen = open.has(g.partner);
        return (
          <div key={g.partner} className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
            <button onClick={() => toggle(g.partner)} className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left">
              <div className="flex items-center gap-2.5">
                <svg viewBox="0 0 24 24" className={`h-4 w-4 text-[#667085] transition-transform ${isOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                <span className="text-[15px] font-semibold text-[#101828]">{g.partner}</span>
                <span className="text-xs text-[#98A2B3]">{g.records.length} {g.records.length === 1 ? "commission" : "commissions"}</span>
              </div>
              <div className="flex items-center gap-2">
                {STAGES.map(({ s }) => { const c = g.counts.get(s) ?? 0; return c > 0 ? <span key={s} className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[s]}`}>{c} {CommissionStatusLabel[s]}</span> : null; })}
                <span className="ml-1 text-sm font-bold text-[#101828]">{formatINR(g.inr)}</span>
              </div>
            </button>
            {isOpen && (
              <div className="border-t border-[#E4E7EC]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr><th className={TH}>Student</th><th className={TH}>University</th><th className={TH}>Commission</th><th className={TH}>INR</th><th className={TH}>Status</th><th className={`${TH} text-right`}>Next Step</th></tr>
                  </thead>
                  <tbody>
                    {g.records.map((r) => (
                      <tr key={r.commissionId} className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
                        <td className={`${TD} cursor-pointer font-medium text-[#1570EF]`} onClick={() => onOpen(r)}>{r.studentName}<span className="block text-xs font-normal text-[#98A2B3]">{r.cpStudentId}</span></td>
                        <td className={TD}>{r.university}</td>
                        <td className={TD}>{r.currency} {r.commissionAmount.toLocaleString()}</td>
                        <td className={`${TD} font-semibold text-[#101828]`}>{inr(r.commissionInr)}</td>
                        <td className={TD}><StatusPill status={r.status} /></td>
                        <td className={`${TD} text-right`}><NextStep next={r.next} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- per-tranche detail -----------------------------------------------------
function trancheDisplay(t: TrancheRow): { label: string; pill: string; dot: string } {
  if (t.status === TrancheStatus.PAID) return { label: "Paid", pill: "bg-[#EFF8FF] text-[#1570EF]", dot: "bg-[#1570EF]" };
  if (t.status === TrancheStatus.RECEIVED) return t.claimed ? { label: "Invoiced", pill: "bg-[#FFF6ED] text-[#B54708]", dot: "bg-[#F79009]" } : { label: "Available to Claim", pill: "bg-[#ECFDF3] text-[#067647]", dot: "bg-[#12B76A]" };
  return { label: TrancheStatusLabel[t.status as TrancheStatus], pill: "bg-[#F2F4F7] text-[#667085]", dot: "bg-[#D0D5DD]" };
}

function CommissionDetailModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const SummaryCard = ({ label, value }: { label: string; value: string }) => (
    <div className="rounded-lg border border-[#E4E7EC] p-3">
      <div className="text-[11px] tracking-wide text-[#98A2B3] uppercase">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-[#101828]">{value}</div>
    </div>
  );
  return (
    <Modal open title={`${row.studentName} · ${row.cpStudentId}`} width="w-[760px]" onClose={onClose} footer={
      <>
        {row.next?.href && <Link href={row.next.href}><Button>{row.next.label} →</Button></Link>}
        <div className="flex-1" />
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </>
    }>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#667085]">
        <span>{countryFlag(row.country)} {row.country}</span><span>·</span>
        <span>{row.university} — {row.program}</span><span>·</span>
        <span className="font-medium text-[#344054]">{row.partner}</span><span>·</span>
        <span>{row.isDirect ? "Direct" : row.vendorName}</span>
        <StatusPill status={row.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <SummaryCard label="Tuition" value={`${row.currency} ${row.tuition.toLocaleString()}`} />
        <SummaryCard label="Commission" value={`${row.currency} ${row.commissionAmount.toLocaleString()} (${row.rate}%)`} />
        <SummaryCard label="INR Value" value={inr(row.commissionInr)} />
        <SummaryCard label="Partner Share" value={row.partnerSharePct == null ? "Not set — not claimable" : `${row.partnerSharePct}%${row.partnerTier ? ` (${row.partnerTier})` : ""} · ${inr(row.partnerShareInr)}`} />
        <SummaryCard label="Available to Claim" value={row.claimableInr > 0 ? inr(row.claimableInr) : "—"} />
        <SummaryCard label="Financial Year" value={financialYearLabel(row.fy)} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Tranche breakdown (or single-payment note) */}
        <div className="rounded-lg border border-[#E4E7EC] p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Tranche Breakdown</div>
          {row.tranches.length > 0 ? (
            <ol className="space-y-3">
              {row.tranches.map((t) => {
                const d = trancheDisplay(t);
                const known = t.status === TrancheStatus.RECEIVED || t.status === TrancheStatus.PAID;
                return (
                  <li key={t.seq} className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${d.dot}`} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#101828]">{t.name}</div>
                        <span className={`mt-1 inline-block rounded-[10px] px-2 py-0.5 text-[10px] font-semibold ${d.pill}`}>{d.label}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {known ? <div className="text-sm font-semibold text-[#101828]">{inr(t.amountInr)}</div> : <><div className="text-sm font-medium text-[#98A2B3]">{row.currency} {t.plannedForeign.toLocaleString()}</div><div className="text-[10px] text-[#98A2B3]">planned</div></>}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm text-[#98A2B3]">Single-payment commission (no tranche schedule).</p>
          )}
        </div>

        {/* Linked documents */}
        <div className="rounded-lg border border-[#E4E7EC] p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Linked Documents</div>
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-3"><span className="text-[#667085]">Vendor invoice</span><span className="font-medium text-[#101828]">{row.vendorInvoice?.number ?? "—"}</span></div>
            <div className="flex justify-between gap-3"><span className="text-[#667085]">Partner invoice</span><span className="font-medium text-[#101828]">{row.partnerInvoice?.number ?? "—"}</span></div>
            <div className="flex justify-between gap-3"><span className="text-[#667085]">Fully collected (CP)</span><span className="text-[#344054]">{row.receivedAt ? formatDate(row.receivedAt) : "—"}</span></div>
            <div className="flex justify-between gap-3"><span className="text-[#667085]">Paid to partner</span><span className="text-[#344054]">{row.paidAt ? formatDate(row.paidAt) : "—"}</span></div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
