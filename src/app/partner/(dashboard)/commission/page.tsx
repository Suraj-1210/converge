"use client";

import { useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { normalizePan, panError } from "~/lib/utils/pan";
import {
  DashboardCard,
  StatCard,
  SkeletonTable,
  EmptyState,
} from "~/components/dashboard/widgets";
import { formatINR, formatDate, countryFlag } from "~/components/dashboard/format";
import {
  PartnerInvoiceStatus,
  PartnerInvoiceStatusLabel,
  TrancheStatus,
  TrancheStatusLabel,
  financialYearLabel,
} from "~/server/db/enums";

type RO = inferRouterOutputs<AppRouter>;
type Claim = RO["partnerCommission"]["listClaimable"][number];
type TrancheRow = Claim["tranches"][number];

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap text-[#667085]";
const TD = "px-3.5 py-3 text-sm whitespace-nowrap text-[#344054]";
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const todayInput = () => new Date().toISOString().slice(0, 10);

// ---- loyalty tiers (share % is the tier benefit; tier derived from FY students)
const TIERS = [
  { name: "Silver", icon: "🥈", max: 10, share: 70, perks: ["70% Commission Rate", "Standard Application Processing", "Email Support"] },
  { name: "Gold", icon: "🥇", max: 30, share: 75, perks: ["75% Commission Rate", "Priority Application Processing", "Dedicated Support", "Quarterly Webinars"] },
  { name: "Platinum", icon: "🏆", max: 50, share: 80, perks: ["80% Commission Rate", "Priority Processing", "Relationship Manager", "Training & Webinars", "Early University Access"] },
  { name: "Titanium", icon: "⚡", max: 75, share: 85, perks: ["85% Commission Rate", "Priority Processing", "Dedicated Relationship Manager", "Exclusive Training", "Early Access", "Sponsored Events"] },
  { name: "Diamond", icon: "💎", max: Infinity, share: 90, perks: ["90% Commission Rate", "Priority Application Processing", "Dedicated Relationship Manager", "Exclusive Training & Webinars", "Early Access to New Universities", "Sponsored Events & Fam Trips"] },
] as const;
const tierFor = (count: number) => TIERS.find((t) => count <= t.max) ?? TIERS[TIERS.length - 1]!;

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

function ClaimStatusPill({ status }: { status: Claim["status"] }) {
  const map = {
    pending: { c: "bg-[#F2F4F7] text-[#667085]", t: "Awaiting CP Payment" },
    claimable: { c: "bg-[#ECFDF3] text-[#067647]", t: "Available to Claim" },
    invoiced: { c: "bg-[#FFF6ED] text-[#B54708]", t: "Invoiced" },
    paid: { c: "bg-[#EFF8FF] text-[#1570EF]", t: "Fully Paid" },
  };
  const { c, t } = map[status];
  return <span className={`rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${c}`}>{t}</span>;
}

// ---- per-tranche display (pay-as-collected) ---------------------------------
// A tranche's display state layers the claim lifecycle on top of the raw status:
// a RECEIVED tranche is "Available to Claim" until it lands on an invoice
// ("Invoiced"), then "Paid" once the payout is released.
function trancheDisplay(t: TrancheRow): { label: string; pill: string; dot: string } {
  if (t.status === TrancheStatus.PAID)
    return { label: "Paid", pill: "bg-[#EFF8FF] text-[#1570EF]", dot: "bg-[#1570EF]" };
  if (t.status === TrancheStatus.RECEIVED)
    return t.claimed
      ? { label: "Invoiced", pill: "bg-[#FFF6ED] text-[#B54708]", dot: "bg-[#F79009]" }
      : { label: "Available to Claim", pill: "bg-[#ECFDF3] text-[#067647]", dot: "bg-[#12B76A]" };
  return {
    label: TrancheStatusLabel[t.status as TrancheStatus],
    pill: "bg-[#F2F4F7] text-[#667085]",
    dot: "bg-[#D0D5DD]",
  };
}
const isCollected = (t: TrancheRow) =>
  t.status === TrancheStatus.RECEIVED || t.status === TrancheStatus.PAID;

// Compact segmented bar for the table — one pip per tranche, coloured by state.
function TrancheProgress({ tranches }: { tranches: TrancheRow[] }) {
  const collected = tranches.filter(isCollected).length;
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-0.5">
        {tranches.map((t) => {
          const d = trancheDisplay(t);
          return (
            <span
              key={t.seq}
              className={`h-1.5 w-4 rounded-full ${d.dot}`}
              title={`${t.name}: ${d.label}`}
            />
          );
        })}
      </div>
      <div className="mt-1 text-[10px] text-[#98A2B3]">
        {collected}/{tranches.length} tranches collected
      </div>
    </div>
  );
}

// Full per-tranche list for the student-detail modal.
function TrancheBreakdown({ currency, tranches }: { currency: string; tranches: TrancheRow[] }) {
  const available = tranches
    .filter((t) => t.status === TrancheStatus.RECEIVED && !t.claimed)
    .reduce((s, t) => s + t.amountInr, 0);
  const paid = tranches
    .filter((t) => t.status === TrancheStatus.PAID)
    .reduce((s, t) => s + t.amountInr, 0);
  return (
    <div className="rounded-lg border border-[#E4E7EC] p-4">
      <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">
        Tranche Breakdown
      </div>
      <ol className="space-y-3">
        {tranches.map((t) => {
          const d = trancheDisplay(t);
          const collected = isCollected(t);
          return (
            <li key={t.seq} className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${d.dot}`} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#101828]">{t.name}</div>
                  <span className={`mt-1 inline-block rounded-[10px] px-2 py-0.5 text-[10px] font-semibold ${d.pill}`}>
                    {d.label}
                  </span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                {collected ? (
                  <div className="text-sm font-semibold text-[#101828]">{inr(t.amountInr)}</div>
                ) : (
                  <>
                    <div className="text-sm font-medium text-[#98A2B3]">
                      {currency} {t.plannedForeign.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-[#98A2B3]">planned</div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-3 space-y-1 border-t border-[#E4E7EC] pt-3 text-xs">
        <div className="flex justify-between">
          <span className="text-[#667085]">Available to claim now</span>
          <span className="font-semibold text-[#067647]">{inr(available)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#667085]">Already paid to you</span>
          <span className="font-semibold text-[#1570EF]">{inr(paid)}</span>
        </div>
      </div>
    </div>
  );
}

function InvoiceStatusPill({ status }: { status: number }) {
  const tone =
    status === PartnerInvoiceStatus.PAID
      ? "bg-[#ECFDF3] text-[#067647]"
      : status === PartnerInvoiceStatus.REJECTED
        ? "bg-[#FEF3F2] text-[#B42318]"
        : status === PartnerInvoiceStatus.APPROVED
          ? "bg-[#EFF8FF] text-[#1570EF]"
          : status === PartnerInvoiceStatus.PARTIAL_APPROVED
            ? "bg-[#F9F5FF] text-[#7F56D9]"
            : "bg-[#FFF6ED] text-[#B54708]";
  return (
    <span className={`rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}>
      {PartnerInvoiceStatusLabel[status as 0 | 1 | 2 | 3 | 4 | 5]}
    </span>
  );
}

type CardFilter = "all" | "not-invoiced" | "invoiced" | "available";

// =============================================================================
export default function PartnerCommissionPage() {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [wizard, setWizard] = useState(false);
  const [detailFor, setDetailFor] = useState<Claim | null>(null);
  const [loyaltyOpen, setLoyaltyOpen] = useState(false);

  // filters
  const [cardFilter, setCardFilter] = useState<CardFilter>("all");
  const [intake, setIntake] = useState("");
  const [country, setCountry] = useState("");
  const [currency, setCurrency] = useState("");
  const [statusF, setStatusF] = useState("");
  const [search, setSearch] = useState("");

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (m: string) => { setToastMsg(m); setToastOpen(true); };

  const claimsQ = api.partnerCommission.listClaimable.useQuery();
  const historyQ = api.partnerCommission.invoiceHistory.useQuery();
  const yearlyQ = api.partnerCommission.yearlyStats.useQuery();
  const claims = useMemo(() => claimsQ.data ?? [], [claimsQ.data]);

  // ---- loyalty tier (current-FY student count) ----
  const yearly = useMemo(() => yearlyQ.data ?? [], [yearlyQ.data]);
  const thisYearCount = yearly.length > 0 ? yearly[yearly.length - 1]!.students : 0;
  const tier = tierFor(thisYearCount);
  const tierIdx = TIERS.indexOf(tier);
  const nextTier = TIERS[tierIdx + 1] ?? null;

  // ---- KPIs ----
  const kpis = useMemo(() => {
    let receivable = 0, niAmt = 0, niCount = 0, invAmt = 0, invCount = 0, avAmt = 0, avCount = 0;
    for (const c of claims) {
      if (c.status === "pending" || c.status === "claimable") { niAmt += c.claimableInr; niCount++; receivable += c.claimableInr; }
      if (c.status === "claimable") { avAmt += c.claimableInr; avCount++; }
      if (c.status === "invoiced") { invAmt += c.claimableInr; invCount++; receivable += c.claimableInr; }
    }
    return { receivable, niAmt, niCount, invAmt, invCount, avAmt, avCount, total: claims.length };
  }, [claims]);

  // ---- filtering ----
  const filtered = useMemo(() => {
    return claims.filter((c) => {
      if (cardFilter === "not-invoiced" && !(c.status === "pending" || c.status === "claimable")) return false;
      if (cardFilter === "invoiced" && c.status !== "invoiced") return false;
      if (cardFilter === "available" && c.status !== "claimable") return false;
      if (intake && c.intake !== intake) return false;
      if (country && c.country !== country) return false;
      if (currency && c.currency !== currency) return false;
      if (statusF === "not-invoiced" && !(c.status === "pending" || c.status === "claimable")) return false;
      if (statusF === "invoiced" && c.status !== "invoiced") return false;
      if (statusF === "paid" && c.status !== "paid") return false;
      if (search.trim() && !`${c.studentName} ${c.studentCode}`.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [claims, cardFilter, intake, country, currency, statusF, search]);

  const intakes = useMemo(() => Array.from(new Set(claims.map((c) => c.intake).filter(Boolean))) as string[], [claims]);
  const countries = useMemo(() => Array.from(new Set(claims.map((c) => c.country))).sort(), [claims]);
  const currencies = useMemo(() => Array.from(new Set(claims.map((c) => c.currency))).sort(), [claims]);

  const selectedClaims = claims.filter((c) => selected.has(c.commissionId));
  const toggle = (id: number) =>
    setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectableInView = filtered.filter((c) => c.selectable).map((c) => c.commissionId);
  const allSelected = selectableInView.length > 0 && selectableInView.every((id) => selected.has(id));
  const setAll = (on: boolean) =>
    setSelected((p) => { const n = new Set(p); for (const id of selectableInView) { if (on) n.add(id); else n.delete(id); } return n; });

  const pickCard = (f: CardFilter) => { setCardFilter((c) => (c === f ? "all" : f)); setStatusF(""); };

  const exportCsv = () => {
    const rows = selectedClaims.length > 0 ? selectedClaims : filtered;
    if (rows.length === 0) { showToast("Nothing to export."); return; }
    const header = [
      "Student ID", "Name", "Programme", "University", "Start Date", "Country", "Currency", "Tuition",
      "Commission %", "Commission Amount", "% Share", "Claimable (INR)", "Invoice Status",
      "Paid to CP", "Paid to Partner", "Payment Date",
    ];
    const body = rows.map((c) => [
      c.studentCode, c.studentName, c.program, c.university, c.intake ?? "", c.country, c.currency,
      c.tuition, c.commissionRate, c.commissionAmount, c.partnerSharePct, c.claimableInr,
      c.status === "paid" ? "Fully Paid" : c.status === "invoiced" ? "Invoiced" : "Not Invoiced",
      c.receivedAt ? "Yes" : "No", c.paidAt ? "Yes" : "No", c.paidAt ? formatDate(c.paidAt) : "",
    ]);
    downloadCsv(`commission-export-${todayInput()}.csv`, [header, ...body]);
  };

  return (
    <div className="pb-16">
      {/* Loyalty banner */}
      <button
        onClick={() => setLoyaltyOpen(true)}
        className="mb-5 flex w-full items-center justify-between gap-3 rounded-2xl border border-[#E9D7FE] bg-gradient-to-r from-[#F4F3FF] to-[#FFFFFF] px-5 py-3.5 text-left"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">{tier.icon}</span>
          <div>
            <div className="text-sm font-bold text-[#101828]">Your Current Tier — {tier.name} · {tier.share}% Commission</div>
            <div className="text-xs text-[#667085]">{thisYearCount} students this year{nextTier ? ` · ${Math.max(0, nextTier.max - thisYearCount + 1)} more to reach ${nextTier.name}` : " · You've reached the top tier!"}</div>
          </div>
        </div>
        <span className="text-[13px] font-semibold text-[#6941C6]">View tiers →</span>
      </button>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">💰 Commission &amp; Payments</h1>
          <p className="mt-1 text-sm text-[#667085]">Track payments, generate invoices, and manage your commission claims.</p>
        </div>
        {selectedClaims.length === 0 && (
          <Button disabled title="Select students below to generate an invoice">Generate Invoice</Button>
        )}
      </div>

      {/* KPI cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="revenue" tone="blue" label="Total Commission Receivable" value={claimsQ.data ? formatINR(kpis.receivable) : "—"} sub={`${kpis.niCount + kpis.invCount} students to be claimed`} active={cardFilter === "all"} onClick={() => pickCard("all")} />
        <StatCard icon="clock" tone="orange" label="Not Yet Invoiced" value={claimsQ.data ? `${kpis.niCount} / ${kpis.total}` : "—"} sub={`~${formatINR(kpis.niAmt)} pending`} active={cardFilter === "not-invoiced"} onClick={() => pickCard("not-invoiced")} />
        <StatCard icon="applications" tone="purple" label="Invoiced" value={claimsQ.data ? `${kpis.invCount} / ${kpis.total}` : "—"} sub={`~${formatINR(kpis.invAmt)} invoiced`} active={cardFilter === "invoiced"} onClick={() => pickCard("invoiced")} />
        <StatCard icon="deposit" tone="green" label="Available to Claim" value={claimsQ.data ? `${kpis.avCount} / ${kpis.total}` : "—"} sub={`${formatINR(kpis.avAmt)} available`} active={cardFilter === "available"} onClick={() => pickCard("available")} />
      </div>

      {/* Year-over-Year */}
      {yearly.length > 0 && <YoYCard rows={yearly} />}

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-40"><FormSelect label="Intake" placeholder="All Intakes" options={intakes.map((i) => ({ value: i, label: i }))} value={intake} onChange={(e) => setIntake(e.target.value)} /></div>
        <div className="w-40"><FormSelect label="Country" placeholder="All Countries" options={countries.map((c) => ({ value: c, label: `${countryFlag(c)} ${c}` }))} value={country} onChange={(e) => setCountry(e.target.value)} /></div>
        <div className="w-36"><FormSelect label="Currency" placeholder="All Currencies" options={currencies.map((c) => ({ value: c, label: c }))} value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
        <div className="w-40"><FormSelect label="Status" placeholder="All Statuses" options={[{ value: "not-invoiced", label: "Not Invoiced" }, { value: "invoiced", label: "Invoiced" }, { value: "paid", label: "Fully Paid" }]} value={statusF} onChange={(e) => { setStatusF(e.target.value); setCardFilter("all"); }} /></div>
        <div className="ml-auto w-56"><FormInput label="Search" placeholder="Search by name or ID..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>

      <DashboardCard title={`Your Commissions (${filtered.length})`} bodyClassName="p-0" className="mb-6">
        {claimsQ.isLoading ? (
          <SkeletonTable rows={5} cols={8} />
        ) : claims.length === 0 ? (
          <EmptyState label="No commissions yet. They appear here once a placed student's commission is processed." />
        ) : filtered.length === 0 ? (
          <EmptyState label="No commissions match your filters." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: 2000 }}>
              <thead>
                <tr>
                  <th className={`${TH} sticky left-0 z-10 bg-[#F9FAFB] w-10`}>
                    <input type="checkbox" checked={allSelected} onChange={(e) => setAll(e.target.checked)} />
                  </th>
                  <th className={TH}>Student ID</th>
                  <th className={TH}>Student Name</th>
                  <th className={TH}>University / Programme</th>
                  <th className={TH}>Start Date</th>
                  <th className={TH}>Country</th>
                  <th className={TH}>Currency</th>
                  <th className={TH}>Tuition</th>
                  <th className={TH}>Comm %</th>
                  <th className={TH}>Commission Amt</th>
                  <th className={TH}>% Share</th>
                  <th className={TH}>Claimable (₹)</th>
                  <th className={TH}>Invoice Status</th>
                  <th className={TH}>Paid to CP</th>
                  <th className={TH}>Paid to Partner</th>
                  <th className={TH}>Payment Date</th>
                  <th className={TH}>CP Commission</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.commissionId} className={`border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD] ${c.status === "paid" ? "opacity-60" : ""}`}>
                    <td className={`${TD} sticky left-0 z-10 bg-white w-10`}>
                      <input type="checkbox" disabled={!c.selectable} checked={selected.has(c.commissionId)} onChange={() => toggle(c.commissionId)} />
                    </td>
                    <td className={`${TD} font-semibold text-[#1570EF] cursor-pointer`} onClick={() => setDetailFor(c)}>{c.studentCode}</td>
                    <td className={`${TD} font-medium text-[#101828]`}>{c.studentName}</td>
                    <td className={TD}>{c.university}<span className="block text-xs text-[#98A2B3]">{c.program}</span></td>
                    <td className={TD}>{c.intake ?? "—"}</td>
                    <td className={TD}>{countryFlag(c.country)} {c.country}</td>
                    <td className={TD}>{c.currency}</td>
                    <td className={`${TD} font-medium`}>{c.currency} {c.tuition.toLocaleString()}</td>
                    <td className={TD}>{c.commissionRate}%</td>
                    <td className={`${TD} font-medium`}>{c.currency} {c.commissionAmount.toLocaleString()}</td>
                    <td className={TD}>{c.partnerSharePct}%</td>
                    <td className={`${TD} font-semibold text-[#067647]`}>{inr(c.claimableInr)}</td>
                    <td className={TD}>
                      <ClaimStatusPill status={c.status} />
                      {c.tranches.length > 1 && <TrancheProgress tranches={c.tranches} />}
                    </td>
                    <td className={`${TD} text-center`}>{c.receivedAt ? <span className="text-[#067647]">✓</span> : "—"}</td>
                    <td className={`${TD} text-center`}>{c.paidAt ? <span className="text-[#067647]">✓</span> : "—"}</td>
                    <td className={TD}>{c.paidAt ? formatDate(c.paidAt) : "—"}</td>
                    <td className={TD}>{c.cpCommissionInr > 0 ? inr(c.cpCommissionInr) : "—"}</td>
                    <td className={`${TD} text-right`}>
                      <button className="text-[13px] font-semibold text-[#1570EF] hover:underline" onClick={() => setDetailFor(c)}>View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashboardCard>

      <DashboardCard title="Invoice History" bodyClassName="p-0">
        {historyQ.isLoading ? (
          <SkeletonTable rows={3} cols={5} />
        ) : (historyQ.data ?? []).length === 0 ? (
          <EmptyState label="No invoices raised yet." />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Invoice #</th>
                <th className={TH}>Date</th>
                <th className={TH}>Students</th>
                <th className={TH}>Amount</th>
                <th className={TH}>Net Payable</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {(historyQ.data ?? []).map((h) => (
                <tr key={h.id} className="border-b border-[#F2F4F7] last:border-0">
                  <td className={`${TD} font-medium text-[#101828]`}>{h.invoiceNumber}</td>
                  <td className={TD}>{formatDate(h.invoiceDate)}</td>
                  <td className={TD}>{h.students}</td>
                  <td className={TD}>{inr(h.totalAmount)}</td>
                  <td className={`${TD} font-semibold text-[#101828]`}>{inr(h.netPayable)}</td>
                  <td className={TD}>
                    <InvoiceStatusPill status={h.status} />
                    {h.status === PartnerInvoiceStatus.REJECTED && h.rejectionReason && (
                      <span className="block text-[11px] text-[#B42318]">{h.rejectionReason}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DashboardCard>

      {/* Bulk-actions bar */}
      {selectedClaims.length > 0 && (
        <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-[#E4E7EC] bg-white px-5 py-3 shadow-[0_8px_24px_rgba(16,24,40,0.12)]">
          <span className="text-sm font-semibold text-[#101828]">{selectedClaims.length} selected</span>
          <Button className="!h-9 !px-4 !text-[13px]" onClick={() => setWizard(true)}>Generate Invoice</Button>
          <Button variant="secondary" className="!h-9 !px-4 !text-[13px]" onClick={exportCsv}>Export CSV</Button>
          <button className="text-[13px] font-semibold text-[#667085] hover:underline" onClick={() => setSelected(new Set())}>✕ Clear</button>
        </div>
      )}

      {detailFor && <StudentDetailModal claim={detailFor} onClose={() => setDetailFor(null)} />}
      {loyaltyOpen && <LoyaltyModal current={tier.name} onClose={() => setLoyaltyOpen(false)} />}
      {wizard && (
        <InvoiceWizard
          claims={selectedClaims}
          onClose={() => setWizard(false)}
          onDone={() => { setWizard(false); setSelected(new Set()); showToast("Invoice submitted to CollegePond"); }}
        />
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}

// ---- Year-over-Year ---------------------------------------------------------
function YoYCard({ rows }: { rows: RO["partnerCommission"]["yearlyStats"] }) {
  const last2 = rows.slice(-2);
  const prior = last2.length === 2 ? last2[0]! : null;
  const cur = last2[last2.length - 1]!;
  const change = (a: number, b: number) => (a === 0 ? null : Math.round(((b - a) / a) * 1000) / 10);
  const Metric = ({ label, p, c, money }: { label: string; p: number | null; c: number; money?: boolean }) => {
    const ch = p == null ? null : change(p, c);
    return (
      <div className="rounded-lg border border-[#E4E7EC] p-3">
        <div className="text-xs text-[#667085]">{label}</div>
        <div className="mt-0.5 text-lg font-bold text-[#101828]">{money ? formatINR(c) : c}</div>
        {ch != null && <div className={`text-xs font-semibold ${ch >= 0 ? "text-[#067647]" : "text-[#B42318]"}`}>{ch >= 0 ? "↑" : "↓"} {Math.abs(ch)}% vs {financialYearLabel(prior!.fy)}</div>}
      </div>
    );
  };
  return (
    <DashboardCard title={`📊 Year-over-Year — ${financialYearLabel(cur.fy)}`} className="mb-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric label="Students" p={prior?.students ?? null} c={cur.students} />
        <Metric label="Commission Earned" p={prior?.earned ?? null} c={cur.earned} money />
        <Metric label="Paid" p={prior?.paid ?? null} c={cur.paid} money />
      </div>
    </DashboardCard>
  );
}

// ---- Loyalty modal ----------------------------------------------------------
function LoyaltyModal({ current, onClose }: { current: string; onClose: () => void }) {
  const [show, setShow] = useState(current);
  const t = TIERS.find((x) => x.name === show) ?? TIERS[0];
  return (
    <Modal open title="Loyalty Tiers" width="w-[640px]" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="grid grid-cols-5 gap-2">
        {TIERS.map((tier) => (
          <button key={tier.name} onClick={() => setShow(tier.name)} className={`rounded-lg border p-2 text-center transition ${show === tier.name ? "border-[#1570EF] bg-[#EFF8FF]" : "border-[#E4E7EC] hover:bg-[#F9FAFB]"}`}>
            <div className="text-xl">{tier.icon}</div>
            <div className="text-xs font-bold text-[#101828]">{tier.name}</div>
            <div className="text-[10px] text-[#667085]">{tier.share}%</div>
            {tier.name === current && <div className="mt-0.5 text-[9px] font-semibold text-[#1570EF]">CURRENT</div>}
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-lg border border-[#E4E7EC] p-4">
        <div className="mb-2 text-sm font-bold text-[#101828]">{t.icon} {t.name} Tier Benefits</div>
        <ul className="space-y-1.5">
          {t.perks.map((p) => (<li key={p} className="flex items-center gap-2 text-sm text-[#344054]"><span className="text-[#12B76A]">✓</span> {p}</li>))}
        </ul>
        <p className="mt-3 text-[11px] text-[#98A2B3]">Tiers are based on students enrolled per financial year; targets reset on April 1, with a one-tier grace buffer.</p>
      </div>
    </Modal>
  );
}

// ---- Student-detail modal ---------------------------------------------------
function StudentDetailModal({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const detailQ = api.partnerCommission.studentDetail.useQuery({ commissionId: claim.commissionId });
  const d = detailQ.data;
  const SummaryCard = ({ label, value }: { label: string; value: string }) => (
    <div className="rounded-lg border border-[#E4E7EC] p-3">
      <div className="text-[11px] tracking-wide text-[#98A2B3] uppercase">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-[#101828]">{value}</div>
    </div>
  );
  const timeline: { title: string; at: Date | string | null; done: boolean }[] = [
    { title: "Application submitted", at: d?.appSubmittedAt ?? null, done: !!d?.appSubmittedAt },
    { title: "Confirmed for billing", at: d?.commissionCreatedAt ?? null, done: !!d?.commissionCreatedAt },
    { title: "Paid to CollegePond", at: d?.receivedAt ?? null, done: !!d?.receivedAt },
    { title: "Invoice raised", at: d?.invoicedAt ?? null, done: !!d?.invoicedAt },
    { title: "Paid to you", at: d?.paidAt ?? null, done: !!d?.paidAt },
  ];
  return (
    <Modal open title={`${claim.studentName} · ${claim.studentCode}`} width="w-[720px]" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="text-xs text-[#667085]">{countryFlag(claim.country)} {claim.country} · {claim.university} · {claim.program}</div>
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <SummaryCard label="Tuition" value={`${claim.currency} ${claim.tuition.toLocaleString()}`} />
        <SummaryCard label="Commission %" value={`${claim.commissionRate}%`} />
        <SummaryCard label="Total Commission" value={`${claim.currency} ${claim.commissionAmount.toLocaleString()}`} />
        <SummaryCard label="% Share" value={`${claim.partnerSharePct}%`} />
        <SummaryCard label="Claimable (₹)" value={inr(claim.claimableInr)} />
        <SummaryCard label="CP Commission (₹)" value={claim.cpCommissionInr > 0 ? inr(claim.cpCommissionInr) : "—"} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {claim.tranches.length > 1 ? (
          <TrancheBreakdown currency={claim.currency} tranches={claim.tranches} />
        ) : (
          <div className="rounded-lg border border-[#E4E7EC] p-4">
            <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Payment Timeline</div>
            <ol className="relative space-y-3.5 border-l border-[#E4E7EC] pl-4">
              {timeline.map((e, i) => (
                <li key={i} className="relative">
                  <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white ${e.done ? "bg-[#12B76A]" : "bg-[#D0D5DD]"}`} />
                  <div className={`text-sm font-semibold ${e.done ? "text-[#101828]" : "text-[#98A2B3]"}`}>{e.title}</div>
                  <div className="text-xs text-[#667085]">{e.at ? formatDate(e.at) : "—"}</div>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="rounded-lg border border-[#E4E7EC] p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Invoice History</div>
          {detailQ.isLoading ? (
            <p className="text-sm text-[#98A2B3]">Loading…</p>
          ) : d?.invoice ? (
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-[#667085]">Invoice #</span><span className="font-medium text-[#101828]">{d.invoice.number}</span></div>
              <div className="flex justify-between"><span className="text-[#667085]">Date</span><span className="text-[#344054]">{d.invoice.date ? formatDate(d.invoice.date) : "—"}</span></div>
              <div className="flex justify-between"><span className="text-[#667085]">Net Payable</span><span className="font-semibold text-[#101828]">{inr(d.invoice.netPayable)}</span></div>
              <div className="flex justify-between"><span className="text-[#667085]">Status</span><InvoiceStatusPill status={d.invoice.status} /></div>
            </div>
          ) : (
            <p className="text-sm text-[#98A2B3]">No invoice raised for this commission yet.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// =============================================================================
// Invoice wizard (3 steps: review → details + signature → preview & submit)
// =============================================================================
function InvoiceWizard({ claims, onClose, onDone }: { claims: Claim[]; onClose: () => void; onDone: () => void }) {
  const utils = api.useUtils();
  const bankQ = api.partnerCommission.bankAccount.useQuery();
  const bank = bankQ.data;

  const [step, setStep] = useState(1);
  const [invoiceNumber, setInvoiceNumber] = useState(`INV/CP/${new Date().getFullYear()}/${String(Math.floor(Date.now() / 1000) % 1000).padStart(3, "0")}`);
  const [invoiceDate, setInvoiceDate] = useState(todayInput());
  const [gstin, setGstin] = useState("");
  const [pan, setPan] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [swift, setSwift] = useState("");
  const [bankName, setBankName] = useState("");
  const [branch, setBranch] = useState("");
  const [accountType, setAccountType] = useState("Current Account");
  const [signatory, setSignatory] = useState("");
  const [designation, setDesignation] = useState("Authorized Signatory");
  const [signed, setSigned] = useState(false);
  const [signedAt, setSignedAt] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!bank) return;
    setGstin((v) => v || (bank.gstin ?? ""));
    setPan((v) => v || (bank.pan ?? ""));
    setAccountHolder((v) => v || (bank.accountHolder ?? ""));
    setIfsc((v) => v || (bank.ifsc ?? ""));
    setSwift((v) => v || (bank.swift ?? ""));
    setBankName((v) => v || (bank.bankName ?? ""));
    setBranch((v) => v || (bank.branch ?? ""));
    setAccountType((v) => v || (bank.accountType ?? "Current Account"));
  }, [bank]);

  // PAN is characters 3-12 of the GSTIN.
  useEffect(() => {
    if (gstin.trim().length >= 12) setPan(gstin.trim().slice(2, 12).toUpperCase());
  }, [gstin]);

  const commissionIds = claims.map((c) => c.commissionId);
  const previewQ = api.partnerCommission.taxPreview.useQuery({ commissionIds, gstin: gstin || undefined }, { enabled: step === 3 });

  const save = api.partnerCommission.saveBankAccount.useMutation();
  const generate = api.partnerCommission.generateInvoice.useMutation();
  const busy = save.isPending || generate.isPending;

  const next = () => {
    setErr("");
    if (step === 2) {
      if (!invoiceNumber.trim()) return setErr("Invoice number is required");
      if (!signatory.trim()) return setErr("Signatory name is required");
      if (pan.trim()) {
        const panMsg = panError(pan, "agency");
        if (panMsg) return setErr(panMsg);
      }
      if (!signed) return setErr("Please apply your digital signature");
    }
    setStep((s) => Math.min(3, s + 1));
  };

  const sign = () => {
    setSigned((v) => {
      const nv = !v;
      setSignedAt(nv ? new Date().toLocaleString("en-IN") : null);
      return nv;
    });
  };

  const submit = async () => {
    setErr("");
    try {
      if (accountNumber.trim()) {
        await save.mutateAsync({
          accountHolder: accountHolder.trim() || signatory.trim() || "Account Holder",
          accountNumber: accountNumber.trim(),
          ifsc: ifsc || undefined, swift: swift || undefined, bankName: bankName || undefined,
          branch: branch || undefined, accountType: accountType || undefined,
          gstin: gstin || undefined, pan: pan || undefined,
        });
      }
      await generate.mutateAsync({
        commissionIds, invoiceNumber: invoiceNumber.trim(), invoiceDate,
        gstin: gstin || undefined, pan: pan || undefined,
        signatoryName: signatory.trim(), signatoryDesignation: designation || undefined, notes: notes || undefined,
      });
      void utils.partnerCommission.invalidate();
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to submit invoice");
    }
  };

  const downloadPdf = () => {
    const p = previewQ.data;
    if (!p) return;
    const lines = claims.map((c) => `<tr><td>${c.studentName} — ${c.university}</td><td style="text-align:right">${c.currency} ${c.commissionAmount.toLocaleString()}</td><td style="text-align:right">${c.partnerSharePct}%</td><td style="text-align:right">${inr(c.claimableInr)}</td></tr>`).join("");
    const taxRows = p.isInterstate === false
      ? `<tr><td>CGST @9%</td><td style="text-align:right">${inr(p.cgst)}</td></tr><tr><td>SGST @9%</td><td style="text-align:right">${inr(p.sgst)}</td></tr>`
      : p.isInterstate === true ? `<tr><td>IGST @18%</td><td style="text-align:right">${inr(p.igst)}</td></tr>`
        : `<tr><td>Less: TDS @2% (194J)</td><td style="text-align:right">− ${inr(p.tds)}</td></tr>`;
    const totalLabel = p.isInterstate === null ? "Net Payable" : "Grand Total";
    const w = window.open("", "_blank", "width=820,height=1000");
    if (!w) return;
    w.document.write(`<html><head><title>${invoiceNumber}</title><style>body{font-family:system-ui,sans-serif;padding:32px;color:#101828}table{width:100%;border-collapse:collapse;margin:8px 0}td,th{padding:6px 8px;border-bottom:1px solid #eee;font-size:13px}</style></head><body>
      <h2 style="text-align:center">TAX INVOICE</h2>
      <p style="text-align:center;color:#667085">${invoiceNumber} · ${formatDate(invoiceDate)}</p>
      <p><b>From:</b> ${bank?.orgName ?? "Your Agency"}<br>${gstin ? "GSTIN: " + gstin : pan ? "PAN: " + pan : "Unregistered"}</p>
      <p><b>Bill To:</b> ${p.cpName}<br>${p.cpAddress}<br>GSTIN: ${p.cpGstin} · SAC: ${p.sac}</p>
      <table><thead><tr><th>Student / University</th><th style="text-align:right">Comm Amt</th><th style="text-align:right">% Share</th><th style="text-align:right">Claimable (₹)</th></tr></thead><tbody>${lines}</tbody></table>
      <table style="width:300px;margin-left:auto"><tr><td>Subtotal</td><td style="text-align:right">${inr(p.subtotal)}</td></tr>${taxRows}<tr><td><b>${totalLabel}</b></td><td style="text-align:right"><b>${inr(p.netPayable)}</b></td></tr></table>
      <p style="margin-top:24px;font-size:12px;color:#667085">Authorised signatory: ${signatory} (${designation})${signedAt ? " · signed " + signedAt : ""}</p>
      ${notes ? `<p style="font-size:12px;color:#667085">Notes: ${notes}</p>` : ""}
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  const STEPS = ["Review", "Details", "Preview"];

  return (
    <Modal open title="Generate Tax Invoice" width="w-[820px]" onClose={onClose}
      footer={
        <>
          {step > 1 && <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>Back</Button>}
          <div className="flex-1" />
          {step === 3 && previewQ.data && <Button variant="secondary" onClick={downloadPdf}>Download PDF</Button>}
          {step < 3 ? <Button onClick={next}>Next</Button> : <Button onClick={submit} loading={busy}>Submit Invoice</Button>}
        </>
      }
    >
      <div className="mb-2 flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${step >= i + 1 ? "bg-[#1570EF] text-white" : "bg-[#F2F4F7] text-[#98A2B3]"}`}>{i + 1}</span>
            <span className={`text-sm font-semibold ${step >= i + 1 ? "text-[#101828]" : "text-[#98A2B3]"}`}>{label}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-8 bg-[#E4E7EC]" />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="overflow-hidden rounded-lg border border-[#E4E7EC]">
          <table className="w-full border-collapse">
            <thead><tr><th className={TH}>Student</th><th className={TH}>Intake</th><th className={TH}>Tuition</th><th className={TH}>% Share</th><th className={`${TH} text-right`}>Claimable (₹)</th></tr></thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.commissionId} className="border-b border-[#F2F4F7] last:border-0">
                  <td className={`${TD} font-medium text-[#101828]`}>{c.studentName}<span className="block text-xs font-normal text-[#98A2B3]">{c.studentCode}</span></td>
                  <td className={TD}>{c.intake ?? "—"}</td>
                  <td className={TD}>{c.currency} {c.tuition.toLocaleString()}</td>
                  <td className={TD}>{c.partnerSharePct}%</td>
                  <td className={`${TD} text-right font-semibold`}>{inr(c.claimableInr)}</td>
                </tr>
              ))}
              <tr className="bg-[#F9FAFB]"><td className={`${TD} font-bold`} colSpan={4}>Total</td><td className={`${TD} text-right font-bold text-[#101828]`}>{inr(claims.reduce((s, c) => s + c.claimableInr, 0))}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <FormInput label="Tax Invoice #" required value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
            <FormInput label="Invoice Date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
          <div className="flex gap-3">
            <FormInput label="Your GSTIN (blank if unregistered → TDS)" value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="27ABCDE1234F1Z5" />
            <FormInput label="PAN (auto from GSTIN chars 3–12)" value={pan} onChange={(e) => setPan(normalizePan(e.target.value))} maxLength={10} placeholder="ABCDE1234F" />
          </div>
          <div className="rounded-lg bg-[#F9FAFB] px-3 py-2 text-xs text-[#667085]">Recipient: <b className="text-[#344054]">Collegepond Counsellors Pvt Ltd</b> · GSTIN 27AADCK1234F1Z5 · SAC 998399</div>
          <div className="rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wide text-[#667085] uppercase">Bank details (for payout)</span>
              {bank?.hasAccount && bank.accountNumberLast4 && !accountNumber && <span className="text-xs text-[#98A2B3]">On file: ••••{bank.accountNumberLast4}</span>}
            </div>
            <div className="flex gap-3">
              <FormInput label="Account Holder" value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} />
              <FormInput label={bank?.hasAccount ? "Account Number (re-enter to update)" : "Account Number"} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder={bank?.accountNumberLast4 ? `••••${bank.accountNumberLast4}` : ""} />
            </div>
            <div className="mt-3 flex gap-3">
              <FormInput label="Bank Name" value={bankName} onChange={(e) => setBankName(e.target.value)} />
              <FormInput label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </div>
            <div className="mt-3 flex gap-3">
              <FormInput label="IFSC" value={ifsc} onChange={(e) => setIfsc(e.target.value)} />
              <FormInput label="SWIFT (international)" value={swift} onChange={(e) => setSwift(e.target.value)} />
              <FormSelect label="Account Type" options={[{ value: "Current Account", label: "Current Account" }, { value: "Savings Account", label: "Savings Account" }]} value={accountType} onChange={(e) => setAccountType(e.target.value)} />
            </div>
            <p className="mt-2 text-[11px] text-[#98A2B3]">🔒 Stored encrypted (AES-256-GCM). Only the last 4 digits are shown back.</p>
          </div>
          <div className="flex gap-3">
            <FormInput label="Authorized Signatory" required value={signatory} onChange={(e) => setSignatory(e.target.value)} />
            <FormInput label="Designation" value={designation} onChange={(e) => setDesignation(e.target.value)} />
          </div>
          <button type="button" onClick={sign} className={`w-full rounded-lg border-2 border-dashed py-3 text-sm font-semibold transition ${signed ? "border-[#12B76A] bg-[#ECFDF3] text-[#067647]" : "border-[#D0D5DD] text-[#667085] hover:border-[#1570EF]"}`}>
            {signed ? `✓ Digitally signed by ${signatory || "you"}${signedAt ? ` on ${signedAt}` : ""}` : "Click to apply your digital signature"}
          </button>
          <FormTextarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {err && <p className="text-xs font-medium text-[#F04438]">{err}</p>}
        </div>
      )}

      {step === 3 && (
        <div>
          {previewQ.isLoading || !previewQ.data ? (
            <SkeletonTable rows={4} cols={2} />
          ) : (
            <div className="rounded-lg border border-[#E4E7EC] p-5">
              <div className="mb-3 text-center">
                <div className="text-base font-bold text-[#101828]">TAX INVOICE</div>
                <div className="text-xs text-[#98A2B3]">{invoiceNumber} · {formatDate(invoiceDate)}</div>
              </div>
              <div className="mb-4 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <div className="font-semibold text-[#667085]">From (Supplier)</div>
                  <div className="font-medium text-[#101828]">{bank?.orgName ?? "Your Agency"}</div>
                  <div className="text-[#667085]">{gstin ? `GSTIN: ${gstin}` : pan ? `PAN: ${pan}` : "Unregistered"}</div>
                </div>
                <div>
                  <div className="font-semibold text-[#667085]">Bill To (Recipient)</div>
                  <div className="font-medium text-[#101828]">{previewQ.data.cpName}</div>
                  <div className="text-[#667085]">{previewQ.data.cpAddress}</div>
                  <div className="text-[#667085]">GSTIN: {previewQ.data.cpGstin} · SAC: {previewQ.data.sac}</div>
                </div>
              </div>
              {(bankName || ifsc || accountHolder) && (
                <div className="mb-3 rounded-lg border border-[#FEC84B] bg-[#FFFAEB] p-2.5 text-[11px] text-[#B54708]">
                  <span className="font-semibold">Bank for payment:</span> {accountHolder} · {bankName} {ifsc} {branch ? `· ${branch}` : ""} {accountType ? `· ${accountType}` : ""}
                </div>
              )}
              <table className="mb-3 w-full border-collapse">
                <thead><tr><th className={TH}>Student / University</th><th className={`${TH} text-right`}>Comm Amt</th><th className={`${TH} text-right`}>% Share</th><th className={`${TH} text-right`}>Claimable (₹)</th></tr></thead>
                <tbody>
                  {claims.map((c) => (
                    <tr key={c.commissionId} className="border-b border-[#F2F4F7]">
                      <td className={TD}>{c.studentName}<span className="block text-xs text-[#98A2B3]">{c.university}</span></td>
                      <td className={`${TD} text-right`}>{c.currency} {c.commissionAmount.toLocaleString()}</td>
                      <td className={`${TD} text-right`}>{c.partnerSharePct}%</td>
                      <td className={`${TD} text-right`}>{inr(c.claimableInr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="ml-auto w-64 space-y-1 text-sm">
                <Row label="Subtotal" value={inr(previewQ.data.subtotal)} />
                {previewQ.data.isInterstate === false && (<><Row label="CGST @9%" value={inr(previewQ.data.cgst)} /><Row label="SGST @9%" value={inr(previewQ.data.sgst)} /></>)}
                {previewQ.data.isInterstate === true && <Row label="IGST @18%" value={inr(previewQ.data.igst)} />}
                {previewQ.data.isInterstate === null && <Row label="Less: TDS @2% (194J)" value={`− ${inr(previewQ.data.tds)}`} />}
                <div className="border-t border-[#E4E7EC] pt-1"><Row label={previewQ.data.isInterstate === null ? "Net Payable" : "Grand Total"} value={inr(previewQ.data.netPayable)} bold /></div>
              </div>
              {notes && <p className="mt-3 text-[11px] text-[#667085]"><span className="font-semibold">Notes:</span> {notes}</p>}
              <p className="mt-3 text-[11px] text-[#98A2B3]">Authorized signatory: {signatory} ({designation}){signedAt ? ` · signed ${signedAt}` : ""}</p>
            </div>
          )}
          {err && <p className="mt-2 text-xs font-medium text-[#F04438]">{err}</p>}
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-bold text-[#101828]" : "text-[#344054]"}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
