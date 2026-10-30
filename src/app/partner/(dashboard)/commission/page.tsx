"use client";

import { useEffect, useMemo, useState } from "react";
import { useUrlState } from "~/lib/url-state";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { useExportLog } from "~/lib/export-log";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { CurrentTierLine, TierLadder } from "~/components/partner/loyalty-tiers";
import { type TierStatusView } from "~/lib/partner-tiers";
import { normalizePan, panError } from "~/lib/utils/pan";
import {
  BankAccountSummary,
  BankDetailsForm,
  BankRejectionNotice,
  BankVerificationBadge,
} from "~/components/partner/bank-details";
import {
  DashboardCard,
  StatCard,
  SkeletonTable,
  EmptyState,
} from "~/components/dashboard/widgets";
import { formatINR, formatDate, countryName } from "~/components/dashboard/format";
import {
  PartnerInvoiceStatus,
  PartnerInvoiceStatusLabel,
  financialYearLabel,
} from "~/server/db/enums";
import { fxLine, money } from "~/lib/currency";

type RO = inferRouterOutputs<AppRouter>;
type Claim = RO["partnerCommission"]["listClaimable"][number];
type TrancheRow = Claim["tranches"][number];
type ClaimState = Claim["status"];
type HistoryRow = RO["partnerCommission"]["invoiceHistory"][number];

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap text-[#667085]";
const TD = "px-3.5 py-3 text-sm whitespace-nowrap text-[#344054]";
// The share Collegepond stamped from your tier when the student was confirmed
// for billing; null until then (and not claimable).
const shareText = (pct: number | null) => (pct == null ? "Pending" : `${pct}%`);
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const todayInput = () => new Date().toISOString().slice(0, 10);
// "Flat €2,000" or "12% · £3,000".
const commissionText = (c: Claim) =>
  c.isFlat ? `Flat ${money(c.commissionAmount, c.currency)}` : `${c.commissionRate}% · ${money(c.commissionAmount, c.currency)}`;

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

// One status per student, read from its tranches (server: partnerCommissionState)
// — the list pill, "Paid to Partner", the timeline and the invoice history all
// say the same thing.
const CLAIM_STATE: Record<ClaimState, { c: string; t: string }> = {
  pending: { c: "bg-[#F2F4F7] text-[#667085]", t: "Awaiting payment to Collegepond" },
  claimable: { c: "bg-[#ECFDF3] text-[#067647]", t: "Available to Claim" },
  claimed: { c: "bg-[#FFF6ED] text-[#B54708]", t: "Claimed" },
  part_paid: { c: "bg-[#F4F3FF] text-[#6941C6]", t: "Part Paid" },
  paid: { c: "bg-[#EFF8FF] text-[#1570EF]", t: "Fully Paid" },
};
function ClaimStatusPill({ status }: { status: ClaimState }) {
  const { c, t } = CLAIM_STATE[status];
  return <span className={`rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${c}`}>{t}</span>;
}

// ---- per-tranche display (pay-as-collected) ---------------------------------
const TRANCHE_STATE: Record<TrancheRow["state"], { label: string; pill: string; dot: string }> = {
  pending: { label: "Awaiting payment to Collegepond", pill: "bg-[#F2F4F7] text-[#667085]", dot: "bg-[#D0D5DD]" },
  claimable: { label: "Available to Claim", pill: "bg-[#ECFDF3] text-[#067647]", dot: "bg-[#12B76A]" },
  claimed: { label: "Claimed", pill: "bg-[#FFF6ED] text-[#B54708]", dot: "bg-[#F79009]" },
  paid: { label: "Paid", pill: "bg-[#EFF8FF] text-[#1570EF]", dot: "bg-[#1570EF]" },
};

// Compact segmented bar for the table — one pip per tranche, coloured by state.
function TrancheProgress({ tranches }: { tranches: TrancheRow[] }) {
  const received = tranches.filter((t) => t.state !== "pending").length;
  const paid = tranches.filter((t) => t.state === "paid").length;
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-0.5">
        {tranches.map((t) => (
          <span
            key={t.seq}
            className={`h-1.5 w-4 rounded-full ${TRANCHE_STATE[t.state].dot}`}
            title={`${t.name}: ${TRANCHE_STATE[t.state].label}`}
          />
        ))}
      </div>
      <div className="mt-1 text-[10px] text-[#98A2B3]">
        {received}/{tranches.length} received{paid > 0 ? ` · ${paid} paid` : ""}
      </div>
    </div>
  );
}

// "€5,342 × 92.10 = ₹4,91,998" when the money came in a foreign currency.
function FxNote({ fx, inrAmount }: { fx: { amount: number; currency: string; rate: number } | null; inrAmount: number }) {
  if (!fx || fx.currency === "INR") return null;
  return <span className="block text-[11px] font-normal text-[#98A2B3]">{fxLine(fx.amount, fx.currency, fx.rate, inrAmount)}</span>;
}

// Full per-tranche list for the student-detail modal.
function TrancheBreakdown({ claim }: { claim: Claim }) {
  return (
    <div className="rounded-lg border border-[#E4E7EC] p-4">
      <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">
        {claim.tranches.length > 1 ? `Tranches (${claim.tranches.length})` : "Payment"}
      </div>
      <ol className="space-y-3">
        {claim.tranches.map((t) => {
          const d = TRANCHE_STATE[t.state];
          return (
            <li key={t.seq} className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${d.dot}`} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#101828]">{t.name}</div>
                  <span className={`mt-1 inline-block rounded-[10px] px-2 py-0.5 text-[10px] font-semibold ${d.pill}`}>{d.label}</span>
                  {(t.invoiceNumber != null || t.paidAt != null) && (
                    <div className="mt-1 text-[11px] text-[#667085]">
                      {t.invoiceNumber ? `Invoice ${t.invoiceNumber}` : ""}
                      {t.invoiceNumber && t.paidAt ? " · " : ""}
                      {t.paidAt ? `paid ${formatDate(t.paidAt)}` : ""}
                    </div>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                {t.state !== "pending" ? (
                  <div className="text-sm font-semibold text-[#101828]">
                    {inr(t.amountInr)}
                    <FxNote fx={t.foreign} inrAmount={t.amountInr} />
                  </div>
                ) : (
                  <>
                    <div className="text-sm font-medium text-[#98A2B3]">{money(t.plannedForeign, claim.currency)}</div>
                    <div className="text-[10px] text-[#98A2B3]">expected</div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
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

// How a released payout was paid: the reference to quote to the bank, the
// date, and the foreign amount + rate for a non-INR payout.
function PayoutLine({ payout }: { payout: HistoryRow["payout"] }) {
  if (!payout) return <span className="text-[#98A2B3]">—</span>;
  return (
    <span>
      <span className="font-medium text-[#101828]">{payout.reference ?? "—"}</span>
      <span className="block text-[11px] text-[#667085]">
        {payout.paymentDate ? formatDate(payout.paymentDate) : ""}
        {payout.currency !== "INR" && payout.amountForeign != null && payout.exchangeRate != null
          ? ` · ${fxLine(payout.amountForeign, payout.currency, payout.exchangeRate, payout.amountInr)}`
          : ""}
      </span>
    </span>
  );
}

type CardFilter = "all" | "claimable" | "claimed" | "paid";
const CARD_FILTERS: CardFilter[] = ["all", "claimable", "claimed", "paid"];
const STATUS_OPTIONS: { value: ClaimState; label: string }[] = [
  { value: "pending", label: CLAIM_STATE.pending.t },
  { value: "claimable", label: CLAIM_STATE.claimable.t },
  { value: "claimed", label: CLAIM_STATE.claimed.t },
  { value: "part_paid", label: CLAIM_STATE.part_paid.t },
  { value: "paid", label: CLAIM_STATE.paid.t },
];

// "Paid to Partner": the date once every tranche is paid, else how many are.
function paidToPartner(c: Claim): string {
  if (c.paidAt) return formatDate(c.paidAt);
  if (c.paidCount > 0) return `${c.paidCount} of ${c.trancheCount} tranches`;
  return "—";
}

// =============================================================================
// Commission, claims and payouts belong to the agency, so only its owner (or
// an independent, for themselves) sees this page; the server refuses agency
// counsellors too.
export default function PartnerCommissionPage() {
  const me = api.auth.me.useQuery(undefined, { retry: false });
  if (!me.data) return null;
  if (me.data.kind === "counsellor") {
    return (
      <div className="rounded-xl border border-[#E4E7EC] bg-white p-6 text-sm text-[#475467]">
        Commission and payouts are managed by your agency&apos;s owner.
      </div>
    );
  }
  return <CommissionContent />;
}

function CommissionContent() {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [wizard, setWizard] = useState(false);
  const [detailFor, setDetailFor] = useState<Claim | null>(null);
  const [loyaltyOpen, setLoyaltyOpen] = useState(false);

  // filters
  // Filters live in the URL, so a refresh keeps them (27 Oct testing).
  const [view, setView] = useUrlState({ card: "all", intake: "", country: "", currency: "", status: "", q: "" });
  const cardFilter: CardFilter = CARD_FILTERS.includes(view.card as CardFilter) ? (view.card as CardFilter) : "all";
  const setCardFilter = (v: CardFilter | ((c: CardFilter) => CardFilter)) =>
    setView({ card: typeof v === "function" ? v(cardFilter) : v });
  const { intake, country, currency, status: statusF, q: search } = view;
  const setIntake = (v: string) => setView({ intake: v });
  const setCountry = (v: string) => setView({ country: v });
  const setCurrency = (v: string) => setView({ currency: v });
  const setStatusF = (v: string) => setView({ status: v });
  const setSearch = (v: string) => setView({ q: v });

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (m: string) => { setToastMsg(m); setToastOpen(true); };

  const claimsQ = api.partnerCommission.listClaimable.useQuery();
  const logExport = useExportLog("partner");
  const historyQ = api.partnerCommission.invoiceHistory.useQuery();
  const yearlyQ = api.partnerCommission.yearlyStats.useQuery();
  const claims = useMemo(() => claimsQ.data ?? [], [claimsQ.data]);

  // ---- loyalty tier (Partner Tiers master: this FY's students, or a set floor) ----
  const tierQ = api.dashboard.partnerTier.useQuery();
  const yearly = useMemo(() => yearlyQ.data ?? [], [yearlyQ.data]);

  // ---- KPIs: the same per-tranche figures as the table ----
  const kpis = useMemo(() => {
    const k = { received: 0, claimable: 0, claimableN: 0, claimed: 0, claimedN: 0, paid: 0, paidN: 0 };
    for (const c of claims) {
      k.received += c.receivedInr;
      k.claimable += c.claimableInr;
      k.claimed += c.claimedInr;
      k.paid += c.paidInr;
      if (c.claimableInr > 0) k.claimableN++;
      if (c.claimedInr > 0) k.claimedN++;
      if (c.paidInr > 0) k.paidN++;
    }
    return k;
  }, [claims]);

  // ---- filtering ----
  const filtered = useMemo(() => {
    return claims.filter((c) => {
      if (cardFilter === "claimable" && c.claimableInr <= 0) return false;
      if (cardFilter === "claimed" && c.claimedInr <= 0) return false;
      if (cardFilter === "paid" && c.paidInr <= 0) return false;
      if (intake && c.intake !== intake) return false;
      if (country && c.country !== country) return false;
      if (currency && c.currency !== currency) return false;
      if (statusF && c.status !== statusF) return false;
      if (search.trim() && !`${c.studentName} ${c.studentCode} ${c.universityStudentId ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())) return false;
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
      "University Student ID", "CP Student ID", "Name", "Programme", "University", "Start Date", "Country",
      "Tuition Currency", "Tuition", "Commission Type", "Commission %", "Commission Currency", "Commission Amount",
      "Your Share %", "Your Share", "Received by Collegepond (INR)", "Claimable Now (INR)", "Claimed (INR)", "Paid (INR)",
      "Status", "Paid to Partner",
    ];
    const body = rows.map((c) => [
      c.universityStudentId ?? "", c.studentCode, c.studentName, c.program, c.university, c.intake ?? "", c.country,
      c.tuitionCurrency, c.tuition, c.isFlat ? "Flat" : "Percentage", c.isFlat ? "" : c.commissionRate, c.currency, c.commissionAmount,
      shareText(c.partnerSharePct), c.shareAmount, c.receivedInr, c.claimableInr, c.claimedInr, c.paidInr,
      CLAIM_STATE[c.status].t, paidToPartner(c),
    ]);
    downloadCsv(`commission-export-${todayInput()}.csv`, [header, ...body]);
    logExport("Partner commission CSV", body.length);
  };

  return (
    <div className="pb-16">
      {/* Loyalty banner */}
      {tierQ.data && (
        <button
          onClick={() => setLoyaltyOpen(true)}
          className="mb-5 flex w-full items-center justify-between gap-3 rounded-2xl border border-[#E9D7FE] bg-gradient-to-r from-[#F4F3FF] to-[#FFFFFF] px-5 py-3.5 text-left"
        >
          <CurrentTierLine status={tierQ.data} />
          <span className="shrink-0 text-[13px] font-semibold text-[#6941C6]">View tiers →</span>
        </button>
      )}

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">💰 Commission &amp; Payments</h1>
          <p className="mt-1 text-sm text-[#667085]">Track payments, generate invoices, and manage your commission claims. Amounts in ₹ are your share.</p>
        </div>
        {selectedClaims.length === 0 && (
          <Button disabled title="Select students below to generate an invoice">Generate Invoice</Button>
        )}
      </div>

      {/* KPI cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="revenue" tone="blue" label="Received by Collegepond" value={claimsQ.data ? formatINR(kpis.received) : "—"} sub={`your share, across ${claims.length} students`} active={cardFilter === "all"} onClick={() => pickCard("all")} />
        <StatCard icon="deposit" tone="green" label="Claimable Now" value={claimsQ.data ? formatINR(kpis.claimable) : "—"} sub={`${kpis.claimableN} students`} active={cardFilter === "claimable"} onClick={() => pickCard("claimable")} />
        <StatCard icon="applications" tone="orange" label="Claimed" value={claimsQ.data ? formatINR(kpis.claimed) : "—"} sub={`${kpis.claimedN} students · awaiting payment`} active={cardFilter === "claimed"} onClick={() => pickCard("claimed")} />
        <StatCard icon="trophy" tone="purple" label="Paid to You" value={claimsQ.data ? formatINR(kpis.paid) : "—"} sub={`${kpis.paidN} students`} active={cardFilter === "paid"} onClick={() => pickCard("paid")} />
      </div>

      {/* Year-over-Year */}
      {yearly.length > 0 && <YoYCard rows={yearly} />}

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-40"><FormSelect label="Intake" placeholder="All Intakes" options={intakes.map((i) => ({ value: i, label: i }))} value={intake} onChange={(e) => setIntake(e.target.value)} /></div>
        <div className="w-40"><FormSelect label="Country" placeholder="All Countries" options={countries.map((c) => ({ value: c, label: countryName(c) }))} value={country} onChange={(e) => setCountry(e.target.value)} /></div>
        <div className="w-36"><FormSelect label="Currency" placeholder="All Currencies" options={currencies.map((c) => ({ value: c, label: c }))} value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
        <div className="w-52"><FormSelect label="Status" placeholder="All Statuses" options={STATUS_OPTIONS} value={statusF} onChange={(e) => { setStatusF(e.target.value); setCardFilter("all"); }} /></div>
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
            <table className="w-full border-collapse" style={{ minWidth: 1900 }}>
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
                  <th className={TH}>Tuition</th>
                  <th className={TH}>Commission</th>
                  <th className={TH}>Your Share %</th>
                  <th className={TH}>Your Share</th>
                  <th className={TH}>Received by CP (₹)</th>
                  <th className={TH}>Claimable Now (₹)</th>
                  <th className={TH}>Claimed (₹)</th>
                  <th className={TH}>Paid (₹)</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Paid to Partner</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.commissionId} className={`border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD] ${c.status === "paid" ? "opacity-60" : ""}`}>
                    <td className={`${TD} sticky left-0 z-10 bg-white w-10`}>
                      <input type="checkbox" disabled={!c.selectable} checked={selected.has(c.commissionId)} onChange={() => toggle(c.commissionId)} />
                    </td>
                    <td className={`${TD} cursor-pointer`} onClick={() => setDetailFor(c)}>
                      {/* The university's Student ID first; the CP-ID is ours. */}
                      <span className="font-semibold text-[#1570EF]">{c.universityStudentId ?? "Not entered"}</span>
                      <span className="block text-xs text-[#98A2B3]">{c.studentCode}</span>
                    </td>
                    <td className={`${TD} font-medium text-[#101828]`}>{c.studentName}</td>
                    <td className={TD}>{c.university}<span className="block text-xs text-[#98A2B3]">{c.program}</span></td>
                    <td className={TD}>{c.intake ?? "—"}</td>
                    <td className={TD}>{countryName(c.country)}</td>
                    <td className={`${TD} font-medium`}>{money(c.tuition, c.tuitionCurrency)}</td>
                    <td className={TD}>{commissionText(c)}</td>
                    <td className={TD} title={c.partnerSharePct == null ? "Collegepond Finance hasn't set the commission share for this student yet" : undefined}>{shareText(c.partnerSharePct)}</td>
                    <td className={TD}>{c.partnerSharePct == null ? "—" : money(c.shareAmount, c.currency)}</td>
                    <td className={TD}>
                      {c.receivedInr > 0 ? inr(c.receivedInr) : "—"}
                      <FxNote fx={c.receivedFx} inrAmount={c.receivedInr} />
                    </td>
                    <td className={`${TD} font-semibold text-[#067647]`}>{c.claimableInr > 0 ? inr(c.claimableInr) : "—"}</td>
                    <td className={TD}>{c.claimedInr > 0 ? inr(c.claimedInr) : "—"}</td>
                    <td className={TD}>{c.paidInr > 0 ? inr(c.paidInr) : "—"}</td>
                    <td className={TD}>
                      <ClaimStatusPill status={c.status} />
                      {c.sharePending && c.claimableInr > 0 && (
                        <span className="mt-1 block text-[11px] text-[#B54708]">Share being set by Collegepond</span>
                      )}
                      {c.tranches.length > 1 && <TrancheProgress tranches={c.tranches} />}
                    </td>
                    <td className={TD}>{paidToPartner(c)}</td>
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
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Invoice #</th>
                  <th className={TH}>Date</th>
                  <th className={TH}>Students</th>
                  <th className={TH}>Amount</th>
                  <th className={TH}>Net Payable</th>
                  <th className={TH}>Paid In</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Payment Ref / UTR</th>
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
                    <td className={TD}>{h.payoutCurrency}</td>
                    <td className={TD}>
                      <InvoiceStatusPill status={h.status} />
                      {h.status === PartnerInvoiceStatus.REJECTED && h.rejectionReason && (
                        <span className="block text-[11px] text-[#B42318]">{h.rejectionReason}</span>
                      )}
                    </td>
                    <td className={TD}><PayoutLine payout={h.payout} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
      {loyaltyOpen && tierQ.data && <LoyaltyModal status={tierQ.data} onClose={() => setLoyaltyOpen(false)} />}
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
function LoyaltyModal({ status, onClose }: { status: TierStatusView; onClose: () => void }) {
  return (
    <Modal open title="Loyalty Tiers" width="w-[640px]" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <TierLadder status={status} />
    </Modal>
  );
}

// ---- Student-detail modal ---------------------------------------------------
// The figures, the timeline and the invoice history all come from the same
// per-tranche states as the list row.
function StudentDetailModal({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const detailQ = api.partnerCommission.studentDetail.useQuery({ commissionId: claim.commissionId });
  const d = detailQ.data;
  const SummaryCard = ({ label, value, sub }: { label: string; value: string; sub?: string | null }) => (
    <div className="rounded-lg border border-[#E4E7EC] p-3">
      <div className="text-[11px] tracking-wide text-[#98A2B3] uppercase">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-[#101828]">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[#667085]">{sub}</div>}
    </div>
  );
  const n = claim.tranches.length;
  const received = claim.tranches.filter((t) => t.state !== "pending").length;
  const claimed = claim.tranches.filter((t) => t.state === "claimed" || t.state === "paid").length;
  const paid = claim.paidCount;
  const progress = (k: number) => (n > 1 ? ` (${k} of ${n} tranches)` : "");
  const latestInvoice = d?.invoices[0] ?? null;
  const timeline: { title: string; at: Date | string | null; done: boolean; partial?: boolean }[] = [
    { title: "Application submitted", at: d?.appSubmittedAt ?? null, done: !!d?.appSubmittedAt },
    { title: "Confirmed for billing", at: d?.commissionCreatedAt ?? null, done: !!d?.commissionCreatedAt },
    { title: `Received by Collegepond${progress(received)}`, at: received === n ? (d?.receivedAt ?? null) : null, done: received === n, partial: received > 0 && received < n },
    { title: `Claimed by you${progress(claimed)}`, at: latestInvoice?.date ?? null, done: claimed === n, partial: claimed > 0 && claimed < n },
    { title: `Paid to you${progress(paid)}`, at: claim.paidAt, done: claim.status === "paid", partial: paid > 0 && paid < n },
  ];
  const fxSub = claim.receivedFx ? fxLine(claim.receivedFx.amount, claim.receivedFx.currency, claim.receivedFx.rate, claim.receivedInr) : null;
  return (
    <Modal open title={`${claim.studentName} · ${claim.universityStudentId ?? claim.studentCode}`} width="w-[780px]" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-[#667085]">
        <span>{countryName(claim.country)} · {claim.university} · {claim.program}</span>
        <span>· {claim.universityStudentId ? `Uni ID ${claim.universityStudentId} · ` : ""}{claim.studentCode}</span>
        <ClaimStatusPill status={claim.status} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <SummaryCard label="Tuition" value={money(claim.tuition, claim.tuitionCurrency)} />
        <SummaryCard label="Commission" value={commissionText(claim)} />
        <SummaryCard label="Your Share" value={claim.partnerSharePct == null ? "Pending" : `${claim.partnerSharePct}% · ${money(claim.shareAmount, claim.currency)}`} />
        <SummaryCard label="Received by Collegepond" value={claim.receivedInr > 0 ? inr(claim.receivedInr) : "—"} sub={fxSub} />
        <SummaryCard label="Claimable Now" value={claim.claimableInr > 0 ? inr(claim.claimableInr) : "—"} />
        <SummaryCard label="Claimed" value={claim.claimedInr > 0 ? inr(claim.claimedInr) : "—"} />
        <SummaryCard label="Paid to You" value={claim.paidInr > 0 ? inr(claim.paidInr) : "—"} sub={paidToPartner(claim) !== "—" ? paidToPartner(claim) : null} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <TrancheBreakdown claim={claim} />
        <div className="rounded-lg border border-[#E4E7EC] p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Payment Timeline</div>
          <ol className="relative space-y-3.5 border-l border-[#E4E7EC] pl-4">
            {timeline.map((e, i) => (
              <li key={i} className="relative">
                <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white ${e.done ? "bg-[#12B76A]" : e.partial ? "bg-[#F79009]" : "bg-[#D0D5DD]"}`} />
                <div className={`text-sm font-semibold ${e.done || e.partial ? "text-[#101828]" : "text-[#98A2B3]"}`}>{e.title}</div>
                <div className="text-xs text-[#667085]">{e.at ? formatDate(e.at) : e.partial ? "In progress" : "—"}</div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-[#E4E7EC] p-4">
        <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Invoice History</div>
        {detailQ.isLoading ? (
          <p className="text-sm text-[#98A2B3]">Loading…</p>
        ) : !d || d.invoices.length === 0 ? (
          <p className="text-sm text-[#98A2B3]">No invoice raised for this student yet.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Invoice #</th>
                <th className={TH}>Date</th>
                <th className={TH}>Covers</th>
                <th className={TH}>This Student</th>
                <th className={TH}>Status</th>
                <th className={TH}>Payment Ref / UTR</th>
              </tr>
            </thead>
            <tbody>
              {d.invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-[#F2F4F7] last:border-0">
                  <td className={`${TD} font-medium text-[#101828]`}>{inv.number}</td>
                  <td className={TD}>{formatDate(inv.date)}</td>
                  <td className={TD}>{inv.tranches.join(", ")}</td>
                  <td className={TD}>
                    {inr(inv.studentAmount)}
                    {inv.payoutCurrency !== "INR" && <span className="block text-[11px] text-[#98A2B3]">paid in {inv.payoutCurrency}</span>}
                  </td>
                  <td className={TD}><InvoiceStatusPill status={inv.status} /></td>
                  <td className={TD}><PayoutLine payout={inv.payout} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
  const [editingBank, setEditingBank] = useState(false);
  // Mandatory "these are the right bank details" pop-up before submitting.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bankConfirmed, setBankConfirmed] = useState(false);
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
  }, [bank]);

  // PAN is characters 3-12 of the GSTIN.
  useEffect(() => {
    if (gstin.trim().length >= 12) setPan(gstin.trim().slice(2, 12).toUpperCase());
  }, [gstin]);

  const commissionIds = claims.map((c) => c.commissionId);
  const previewQ = api.partnerCommission.taxPreview.useQuery({ commissionIds, gstin: gstin || undefined }, { enabled: step === 3 });

  const generate = api.partnerCommission.generateInvoice.useMutation();
  const busy = generate.isPending;
  // Rejected details can't be paid into; the server refuses the claim too.
  const bankReady = Boolean(bank?.hasAccount && bank.hasProof && bank.status !== "rejected");

  const next = () => {
    setErr("");
    if (step === 2) {
      if (!invoiceNumber.trim()) return setErr("Invoice number is required");
      if (!signatory.trim()) return setErr("Signatory name is required");
      if (pan.trim()) {
        const panMsg = panError(pan, bank?.panHolder ?? "agency");
        if (panMsg) return setErr(panMsg);
      } else if (bank?.panRequired) {
        return setErr("Enter your PAN to submit a claim");
      }
      if (!bankReady) {
        return setErr(
          bank?.status === "rejected"
            ? "Our finance team couldn't verify your bank details. Update them to continue."
            : "Add your bank details and upload a cancelled cheque (or bank letter) to continue",
        );
      }
      if (editingBank) return setErr("Save your bank details first");
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
      await generate.mutateAsync({
        commissionIds, invoiceNumber: invoiceNumber.trim(), invoiceDate,
        bankDetailsConfirmed: true,
        gstin: gstin || undefined, pan: pan || undefined,
        signatoryName: signatory.trim(), signatoryDesignation: designation || undefined, notes: notes || undefined,
      });
      void utils.partnerCommission.invalidate();
      setConfirmOpen(false);
      onDone();
    } catch (e) {
      setConfirmOpen(false);
      setErr(e instanceof Error ? e.message : "Failed to submit invoice");
    }
  };

  // A claim paid in a foreign currency carries no GST / TDS; it's worked out
  // in INR and converted at the rate on the day it's paid.
  const foreignPayout = previewQ.data?.payoutCurrency != null && previewQ.data.payoutCurrency !== "INR";

  const downloadPdf = () => {
    const p = previewQ.data;
    if (!p) return;
    const lines = claims.map((c) => `<tr><td>${c.studentName} — ${c.university}</td><td style="text-align:right">${money(c.commissionAmount, c.currency)}</td><td style="text-align:right">${shareText(c.partnerSharePct)}</td><td style="text-align:right">${inr(c.claimableInr)}</td></tr>`).join("");
    const taxRows = foreignPayout
      ? `<tr><td>No GST / TDS — paid in ${p.payoutCurrency}</td><td style="text-align:right">—</td></tr>`
      : p.isInterstate === false
        ? `<tr><td>CGST @9%</td><td style="text-align:right">${inr(p.cgst)}</td></tr><tr><td>SGST @9%</td><td style="text-align:right">${inr(p.sgst)}</td></tr>`
        : p.isInterstate === true ? `<tr><td>IGST @18%</td><td style="text-align:right">${inr(p.igst)}</td></tr>`
          : `<tr><td>Less: TDS @2% (194J)</td><td style="text-align:right">− ${inr(p.tds)}</td></tr>`;
    const totalLabel = foreignPayout ? `Net Payable (INR equivalent, paid in ${p.payoutCurrency})` : p.isInterstate === null ? "Net Payable" : "Grand Total";
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

  const confirmDialog = confirmOpen && bank?.hasAccount && (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#101828]/50" onClick={() => !busy && setConfirmOpen(false)} aria-hidden />
      <div className="relative w-full max-w-[480px] rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-bold text-[#101828]">Confirm your bank details</h3>
        <p className="mt-1 text-sm text-[#667085]">
          This commission will be paid into the account below. Please check it carefully — payments can&apos;t be
          redirected once released.
        </p>
        <div className="mt-4 rounded-xl border border-[#E4E7EC] bg-[#F9FAFB] p-4">
          <BankAccountSummary bank={bank} />
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-[#344054]">
          <input type="checkbox" className="mt-0.5" checked={bankConfirmed} onChange={(e) => setBankConfirmed(e.target.checked)} />
          I confirm these bank details are correct and the account belongs to {bank.accountHolder ?? "us"}.
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
            Go back
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!bankConfirmed}>
            Confirm &amp; Submit
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <>
    <Modal open title="Generate Tax Invoice" width="w-[820px]" onClose={onClose}
      footer={
        <>
          {step > 1 && <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>Back</Button>}
          <div className="flex-1" />
          {step === 3 && previewQ.data && <Button variant="secondary" onClick={downloadPdf}>Download PDF</Button>}
          {step < 3 ? <Button onClick={next}>Next</Button> : <Button onClick={() => { setBankConfirmed(false); setConfirmOpen(true); }} loading={busy}>Submit Invoice</Button>}
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
                  <td className={TD}>{money(c.tuition, c.tuitionCurrency)}</td>
                  <td className={TD} title={c.partnerSharePct == null ? "Collegepond Finance hasn't set the commission share for this student yet" : undefined}>{shareText(c.partnerSharePct)}</td>
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
            <FormInput label={bank?.payoutCurrency && bank.payoutCurrency !== "INR" ? `Your GSTIN (optional — paid in ${bank.payoutCurrency}, no GST/TDS)` : "Your GSTIN (blank if unregistered → TDS)"} value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="27ABCDE1234F1Z5" />
            <FormInput label="PAN (auto from GSTIN chars 3–12)" required={bank?.panRequired} value={pan} onChange={(e) => setPan(normalizePan(e.target.value))} maxLength={10} placeholder="ABCDE1234F" />
          </div>
          <div className="rounded-lg bg-[#F9FAFB] px-3 py-2 text-xs text-[#667085]">Recipient: <b className="text-[#344054]">Collegepond Counsellors Pvt Ltd</b> · GSTIN 27AADCK1234F1Z5 · SAC 998399</div>
          <div className="rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs font-semibold tracking-wide text-[#667085] uppercase">
                Bank details (for payout)
                {bank?.hasAccount && !editingBank && <BankVerificationBadge status={bank.status} />}
              </span>
              {!editingBank && (
                <button type="button" onClick={() => setEditingBank(true)} className="text-xs font-semibold text-[#1570EF] hover:underline">
                  {bank?.hasAccount ? "Update" : "Add bank account"}
                </button>
              )}
            </div>
            {editingBank ? (
              <BankDetailsForm
                bank={bank}
                gstin={gstin}
                pan={pan}
                onSaved={() => setEditingBank(false)}
                onCancel={() => setEditingBank(false)}
              />
            ) : bank?.hasAccount ? (
              <>
                <BankRejectionNotice bank={bank} />
                <BankAccountSummary bank={bank} />
                {!bank.hasProof && (
                  <p className="mt-2 text-xs font-medium text-[#B54708]">
                    Please update your bank details and upload a cancelled cheque (or bank letter) to continue.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-[#667085]">Add the bank account we should pay this commission into.</p>
            )}
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
              {bank?.hasAccount && (
                <div className="mb-3 rounded-lg border border-[#FEC84B] bg-[#FFFAEB] p-2.5 text-[11px] text-[#B54708]">
                  <span className="font-semibold">Bank for payment:</span> {bank.accountHolder} · {bank.bankName} ••••{bank.accountNumberLast4}{" "}
                  {bank.region === "international" ? bank.swift : bank.ifsc} {bank.branch ? `· ${bank.branch}` : ""}
                </div>
              )}
              <table className="mb-3 w-full border-collapse">
                <thead><tr><th className={TH}>Student / University</th><th className={`${TH} text-right`}>Comm Amt</th><th className={`${TH} text-right`}>% Share</th><th className={`${TH} text-right`}>Claimable (₹)</th></tr></thead>
                <tbody>
                  {claims.map((c) => (
                    <tr key={c.commissionId} className="border-b border-[#F2F4F7]">
                      <td className={TD}>{c.studentName}<span className="block text-xs text-[#98A2B3]">{c.university}</span></td>
                      <td className={`${TD} text-right`}>{money(c.commissionAmount, c.currency)}</td>
                      <td className={`${TD} text-right`}>{shareText(c.partnerSharePct)}</td>
                      <td className={`${TD} text-right`}>{inr(c.claimableInr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="ml-auto w-64 space-y-1 text-sm">
                <Row label="Subtotal" value={inr(previewQ.data.subtotal)} />
                {foreignPayout ? (
                  <Row label="GST / TDS" value="None" />
                ) : (
                  <>
                    {previewQ.data.isInterstate === false && (<><Row label="CGST @9%" value={inr(previewQ.data.cgst)} /><Row label="SGST @9%" value={inr(previewQ.data.sgst)} /></>)}
                    {previewQ.data.isInterstate === true && <Row label="IGST @18%" value={inr(previewQ.data.igst)} />}
                    {previewQ.data.isInterstate === null && <Row label="Less: TDS @2% (194J)" value={`− ${inr(previewQ.data.tds)}`} />}
                  </>
                )}
                <div className="border-t border-[#E4E7EC] pt-1"><Row label={foreignPayout || previewQ.data.isInterstate === null ? "Net Payable" : "Grand Total"} value={inr(previewQ.data.netPayable)} bold /></div>
              </div>
              {foreignPayout && (
                <p className="mt-2 rounded-lg bg-[#EFF8FF] px-3 py-2 text-[11px] text-[#175CD3]">
                  You&apos;re paid in {previewQ.data.payoutCurrency}: no GST or TDS applies. The amount above is in INR; it&apos;s converted to {previewQ.data.payoutCurrency} at the exchange rate on the day the payment is sent, and you&apos;ll see the {previewQ.data.payoutCurrency} amount and rate in your invoice history.
                </p>
              )}
              {notes && <p className="mt-3 text-[11px] text-[#667085]"><span className="font-semibold">Notes:</span> {notes}</p>}
              <p className="mt-3 text-[11px] text-[#98A2B3]">Authorized signatory: {signatory} ({designation}){signedAt ? ` · signed ${signedAt}` : ""}</p>
            </div>
          )}
          {err && <p className="mt-2 text-xs font-medium text-[#F04438]">{err}</p>}
        </div>
      )}
    </Modal>
    {confirmDialog}
    </>
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
