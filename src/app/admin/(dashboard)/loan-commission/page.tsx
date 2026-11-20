"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Toast } from "~/components/ui/toast";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { DashboardCard, EmptyState, SkeletonTable, StatCard } from "~/components/dashboard/widgets";
import {
  AdminRole,
  LoanCommissionSource,
  LoanCommissionStatus,
  LoanCommissionStatusLabel,
  LoanReceiptStatus,
} from "~/server/db/enums";

// Finance › Loan Commission (20 Nov 2026; spec "Loan Commission Flow —
// Converge", decisions by Suraj). Kept apart from university commission.
//   Lines           one per disbursement tranche (normally the first only)
//   Lender receipts Collegepond's payout from a lender, split across lines;
//                   any finance role records, SA / FM approve → claimable
//   Lenders         what each lender pays CP (% of disbursed, dated)
//   Partner %       each partner's % of disbursed (no default)

type Line = RouterOutputs["loanCommission"]["lines"][number];
type Receipt = RouterOutputs["loanCommission"]["receipts"][number];
type Lender = RouterOutputs["loanCommission"]["lenders"][number];
type PartnerRow = RouterOutputs["loanCommission"]["partners"][number];
type Tab = "lines" | "attention" | "receipts" | "lenders" | "partners";

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054] align-top";
const LABEL = "mb-1.5 block text-[13px] font-medium text-[#344054]";
const TEXTAREA = "w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-sm text-[#101828] outline-none focus:border-[#84CAFF] focus:ring-4 focus:ring-[#D1E9FF]";

const inr = (n: number | null | undefined) =>
  n == null ? "—" : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const pctText = (n: number | null | undefined) => (n == null ? "Not set" : `${n}%`);
const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
const today = () => new Date().toISOString().slice(0, 10);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

const STATUS_TONE: Record<number, string> = {
  [LoanCommissionStatus.NEEDS_RATE]: "bg-[#FEF3F2] text-[#B42318]",
  [LoanCommissionStatus.AWAITING_RECEIPT]: "bg-[#F2F4F7] text-[#344054]",
  [LoanCommissionStatus.RECEIPT_PENDING]: "bg-[#FFFAEB] text-[#B54708]",
  [LoanCommissionStatus.CLAIMABLE]: "bg-[#ECFDF3] text-[#067647]",
  [LoanCommissionStatus.CLAIMED]: "bg-[#FFF6ED] text-[#B54708]",
  [LoanCommissionStatus.PAID]: "bg-[#EFF8FF] text-[#1570EF]",
  [LoanCommissionStatus.CANCELLED]: "bg-[#F2F4F7] text-[#98A2B3]",
};
function LineStatus({ status }: { status: number }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[status] ?? ""}`}>
      {LoanCommissionStatusLabel[status as LoanCommissionStatus] ?? "—"}
    </span>
  );
}
const SOURCE_TEXT: Record<number, string> = {
  [LoanCommissionSource.SYNC]: "",
  [LoanCommissionSource.MANUAL_TRANCHE]: "Added by hand",
  [LoanCommissionSource.CREDIT]: "Credit (duplicate referral)",
};

export default function LoanCommissionPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const isFinance = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER || role === AdminRole.FINANCE_EXECUTIVE;
  const isManager = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;
  const isSuperAdmin = role === AdminRole.SUPER_ADMIN;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [tab, setTab] = useState<Tab>("lines");
  const [status, setStatus] = useState("");
  const [lenderF, setLenderF] = useState("");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [deciding, setDeciding] = useState<{ r: Receipt; kind: "approve" | "reject" } | null>(null);
  const [lineAction, setLineAction] = useState<{ line: Line; kind: "cancel" | "clawback" | "clear" | "reprice" } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editLender, setEditLender] = useState<Lender | "new" | null>(null);
  const [rateFor, setRateFor] = useState<Lender | null>(null);
  const [partnerRateFor, setPartnerRateFor] = useState<PartnerRow | null>(null);

  const utils = api.useUtils();
  const refresh = () => utils.loanCommission.invalidate();
  const summaryQ = api.loanCommission.summary.useQuery(undefined, { enabled: isFinance });
  const linesQ = api.loanCommission.lines.useQuery(
    {
      status: tab === "lines" && status !== "" ? Number(status) : undefined,
      lenderId: lenderF ? Number(lenderF) : undefined,
      attention: tab === "attention" ? true : undefined,
    },
    { enabled: isFinance && (tab === "lines" || tab === "attention") },
  );
  const receiptsQ = api.loanCommission.receipts.useQuery(undefined, { enabled: isFinance && tab === "receipts" });
  const lendersQ = api.loanCommission.lenders.useQuery(undefined, { enabled: isFinance });
  const partnersQ = api.loanCommission.partners.useQuery(undefined, { enabled: isFinance && tab === "partners" });

  const lines = useMemo(() => {
    const all = linesQ.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((l) => [l.student, l.partner, l.lender, l.invoice?.invoice_number].filter(Boolean).join(" ").toLowerCase().includes(q));
  }, [linesQ.data, search]);

  if (!mounted || meQ.isLoading) {
    return (
      <DashboardCard title="Loan Commission" bodyClassName="p-0">
        <SkeletonTable rows={6} cols={7} />
      </DashboardCard>
    );
  }
  if (!isFinance) {
    return <div className="rounded-xl border border-[#E4E7EC] bg-white p-6 text-sm text-[#475467]">Loan Commission is for the finance team.</div>;
  }

  const s = summaryQ.data;
  const TABS: { key: Tab; label: string }[] = [
    { key: "lines", label: "Lines" },
    { key: "attention", label: `Needs attention${s ? ` (${s.attention + s.needsRate})` : ""}` },
    { key: "receipts", label: `Lender receipts${s?.pendingReceipts ? ` (${s.pendingReceipts} to approve)` : ""}` },
    { key: "lenders", label: "Lenders" },
    { key: "partners", label: "Partner %" },
  ];

  return (
    <div className="pb-16">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Loan Commission</h1>
          <p className="mt-1 max-w-3xl text-sm text-[#667085]">
            Commission on partner-referred education loans, kept apart from university commission. A line opens when a
            loan is disbursed, is priced at the partner&apos;s % of the amount disbursed, and becomes claimable once
            Collegepond&apos;s payout from the lender is recorded and approved.
          </p>
        </div>
        <div className="flex gap-2">
          {isManager && <Button variant="secondary" onClick={() => setAdding(true)}>Add line</Button>}
          <Button onClick={() => setRecording(true)}>Record lender receipt</Button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="revenue" tone="blue" label="Expected from lenders" value={s ? inr(s.expectedCp) : "—"} sub={s ? `${inr(s.receivedCp)} received · ${s.lines} lines` : undefined} />
        <StatCard icon="clock" tone="orange" label="Awaiting lender payout" value={s ? inr(s.awaiting.partner) : "—"} sub={s ? `partner share · ${s.awaiting.count} lines${s.needsRate ? ` · ${s.needsRate} need a rate` : ""}` : undefined} />
        <StatCard icon="deposit" tone="green" label="Owed to partners" value={s ? inr(s.claimable.partner + s.claimed.partner) : "—"} sub={s ? `${s.claimable.count} claimable · ${s.claimed.count} claimed` : undefined} />
        <StatCard icon="trophy" tone="purple" label="Paid to partners" value={s ? inr(s.paid.partner) : "—"} sub={s ? `${s.paid.count} line${s.paid.count === 1 ? "" : "s"}` : undefined} />
      </div>

      <div className="mb-4 flex flex-wrap gap-1 border-b border-[#E4E7EC]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold ${tab === t.key ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(tab === "lines" || tab === "attention") && (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            {tab === "lines" && (
              <div className="w-56">
                <FormSelect
                  label="Status"
                  placeholder="All statuses"
                  options={Object.entries(LoanCommissionStatusLabel).map(([v, l]) => ({ value: v, label: l }))}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                />
              </div>
            )}
            <div className="w-56">
              <FormSelect
                label="Lender"
                placeholder="All lenders"
                options={(lendersQ.data ?? []).map((l) => ({ value: String(l.id), label: l.name }))}
                value={lenderF}
                onChange={(e) => setLenderF(e.target.value)}
              />
            </div>
            <div className="ml-auto w-64">
              <FormInput label="Search" placeholder="Student, partner, lender, invoice" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          {tab === "attention" && (s?.needsRate ?? 0) > 0 && (
            <p className="mb-3 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">
              {s!.needsRate} line{s!.needsRate === 1 ? "" : "s"} can&apos;t be priced until a lender rate or partner % is set (Lenders / Partner % tabs; filter Lines by &quot;Needs rate&quot;).
            </p>
          )}
          <DashboardCard title={tab === "attention" ? "Changed upstream: check these" : `Lines (${lines.length})`} bodyClassName="p-0">
            {linesQ.isLoading ? (
              <SkeletonTable rows={5} cols={8} />
            ) : lines.length === 0 ? (
              <EmptyState label={tab === "attention" ? "Nothing needs attention." : "No loan commission lines yet. They open when a referred loan is disbursed."} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse" style={{ minWidth: 1250 }}>
                  <thead>
                    <tr>
                      <th className={TH}>Student / Partner</th>
                      <th className={TH}>Lender</th>
                      <th className={TH}>Disbursed</th>
                      <th className={TH}>Lender %</th>
                      <th className={TH}>Expected / Received</th>
                      <th className={TH}>Partner %</th>
                      <th className={TH}>Partner amount</th>
                      <th className={TH}>Status</th>
                      <th className={`${TH} text-right`}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id} className="border-b border-[#F2F4F7] last:border-0">
                        <td className={TD}>
                          <span className="font-medium text-[#101828]">{l.student}</span>
                          <span className="block text-xs text-[#667085]">
                            {l.partner}
                            {l.partnerType === "independent" ? " · Independent" : ""}
                          </span>
                          {SOURCE_TEXT[l.source] && <span className="block text-[11px] text-[#6941C6]">{SOURCE_TEXT[l.source]}</span>}
                        </td>
                        <td className={TD}>
                          {l.lender}
                          <span className="block text-xs text-[#98A2B3]">Tranche {l.trancheNo}</span>
                        </td>
                        <td className={TD}>
                          {inr(l.disbursedAmount)}
                          <span className="block text-xs text-[#98A2B3]">{fmtDate(l.disbursedOn)}</span>
                        </td>
                        <td className={TD}>{pctText(l.lenderPct)}</td>
                        <td className={TD}>
                          {inr(l.expectedCp)}
                          <span className="block text-xs text-[#667085]">{l.receivedAmount == null ? "not received" : `received ${inr(l.receivedAmount)}`}</span>
                        </td>
                        <td className={TD}>{pctText(l.partnerPct)}</td>
                        <td className={`${TD} font-semibold text-[#101828]`}>
                          {inr(l.partnerAmount)}
                          {l.receivedAmount != null && l.partnerAmount != null && l.receivedAmount < l.partnerAmount && (
                            <span className="block text-[11px] font-medium text-[#B42318]">more than CP received</span>
                          )}
                        </td>
                        <td className={TD}>
                          <LineStatus status={l.status} />
                          {l.receipt && <span className="mt-1 block text-[11px] text-[#667085]">Receipt {l.receipt.reference}</span>}
                          {l.invoice && <span className="block text-[11px] text-[#667085]">Claim {l.invoice.invoice_number}</span>}
                          {l.cancelReason && <span className="mt-1 block max-w-[220px] text-[11px] text-[#667085]">{l.cancelReason}</span>}
                          {l.clawback && (
                            <span className="mt-1 block text-[11px] text-[#B42318]">
                              Clawback {inr(l.clawback.amount)}
                              {l.clawback.adjustmentId ? ` · deduction draft #${l.clawback.adjustmentId}` : ""}
                            </span>
                          )}
                          {l.attention && (
                            <span className="mt-1 block max-w-[240px] rounded bg-[#FFFAEB] px-1.5 py-1 text-[11px] font-medium text-[#B54708]">⚠ {l.attention}</span>
                          )}
                        </td>
                        <td className={`${TD} whitespace-nowrap text-right`}>
                          <div className="flex flex-col items-end gap-1 text-[13px] font-semibold">
                            {isManager && [0, 1, 2, 3].includes(l.status) && (
                              <button className="text-[#1570EF] hover:underline" onClick={() => setLineAction({ line: l, kind: "reprice" })}>Change rates</button>
                            )}
                            {isManager && [0, 1, 3].includes(l.status) && (
                              <button className="text-[#B42318] hover:underline" onClick={() => setLineAction({ line: l, kind: "cancel" })}>Cancel</button>
                            )}
                            {isManager && l.status === LoanCommissionStatus.PAID && !l.clawback && (
                              <button className="text-[#B42318] hover:underline" onClick={() => setLineAction({ line: l, kind: "clawback" })}>Record clawback</button>
                            )}
                            {l.attention && (
                              <button className="text-[#667085] hover:underline" onClick={() => setLineAction({ line: l, kind: "clear" })}>Mark checked</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DashboardCard>
        </>
      )}

      {tab === "receipts" && (
        <DashboardCard title="Lender receipts" bodyClassName="p-0">
          {receiptsQ.isLoading ? (
            <SkeletonTable rows={4} cols={7} />
          ) : (receiptsQ.data ?? []).length === 0 ? (
            <EmptyState label="No lender receipts yet. Record one when a lender pays Collegepond its payout." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" style={{ minWidth: 1100 }}>
                <thead>
                  <tr>
                    <th className={TH}>Lender</th>
                    <th className={TH}>Received</th>
                    <th className={TH}>Reference / CP invoice</th>
                    <th className={TH}>Amount (excl. GST)</th>
                    <th className={TH}>Loans</th>
                    <th className={TH}>Status</th>
                    <th className={`${TH} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(receiptsQ.data ?? []).map((r) => (
                    <tr key={r.id} className="border-b border-[#F2F4F7] last:border-0">
                      <td className={`${TD} font-medium text-[#101828]`}>{r.lender}</td>
                      <td className={TD}>{fmtDate(r.receivedOn)}</td>
                      <td className={TD}>
                        {r.reference}
                        {r.cpInvoiceNumber && <span className="block text-xs text-[#98A2B3]">CP invoice {r.cpInvoiceNumber}</span>}
                      </td>
                      <td className={TD}>
                        <span className="font-semibold text-[#101828]">{inr(r.amount)}</span>
                        <span className="block text-xs text-[#98A2B3]">GST {inr(r.gst)} · TDS {inr(r.tds)}</span>
                      </td>
                      <td className={TD}>
                        {r.lines.length === 0 ? (
                          <span className="text-[#98A2B3]">Released (rejected)</span>
                        ) : (
                          <ul className="space-y-0.5 text-xs">
                            {r.lines.map((l) => (
                              <li key={l.id}>
                                {l.student} · {inr(l.allocated)} <span className="text-[#98A2B3]">(partner {inr(l.partnerAmount)})</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className={TD}>
                        <span
                          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                            r.status === LoanReceiptStatus.APPROVED
                              ? "bg-[#ECFDF3] text-[#067647]"
                              : r.status === LoanReceiptStatus.REJECTED
                                ? "bg-[#FEF3F2] text-[#B42318]"
                                : "bg-[#FFFAEB] text-[#B54708]"
                          }`}
                        >
                          {r.status === LoanReceiptStatus.APPROVED ? "Approved" : r.status === LoanReceiptStatus.REJECTED ? "Rejected" : "Awaiting approval"}
                        </span>
                        <span className="mt-1 block text-[11px] text-[#667085]">
                          Recorded by {r.recordedBy ?? "—"}
                          {r.decidedBy ? ` · ${r.status === LoanReceiptStatus.APPROVED ? "approved" : "rejected"} by ${r.decidedBy}` : ""}
                        </span>
                        {r.decisionNote && <span className="block text-[11px] text-[#667085]">{r.decisionNote}</span>}
                      </td>
                      <td className={`${TD} whitespace-nowrap text-right`}>
                        {isManager && r.status === LoanReceiptStatus.PENDING ? (
                          <div className="flex justify-end gap-2">
                            <Button variant="secondary" className="!h-8 !px-3 !text-[13px]" onClick={() => setDeciding({ r, kind: "reject" })}>Reject</Button>
                            <Button className="!h-8 !px-3 !text-[13px]" onClick={() => setDeciding({ r, kind: "approve" })}>Approve</Button>
                          </div>
                        ) : r.status === LoanReceiptStatus.PENDING ? (
                          <span className="text-xs text-[#98A2B3]">SA / FM approve</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashboardCard>
      )}

      {tab === "lenders" && (
        <DashboardCard title="Lenders: what each pays Collegepond" headerRight={<Button className="!h-8 !px-3 !text-[13px]" onClick={() => setEditLender("new")}>Add lender</Button>} bodyClassName="p-0">
          {lendersQ.isLoading ? (
            <SkeletonTable rows={4} cols={5} />
          ) : (lendersQ.data ?? []).length === 0 ? (
            <EmptyState label="No lenders yet. They appear automatically when the loan team records an application, or add one here." />
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Lender</th>
                  <th className={TH}>CP payout (% of disbursed)</th>
                  <th className={TH}>Rate history</th>
                  <th className={TH}>Later tranches</th>
                  <th className={TH}>Lines waiting</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(lendersQ.data ?? []).map((l) => (
                  <tr key={l.id} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={`${TD} font-medium text-[#101828]`}>
                      {l.name}
                      {!l.isActive && <span className="ml-1.5 text-xs font-normal text-[#98A2B3]">(inactive)</span>}
                    </td>
                    <td className={TD}>{l.currentPct == null ? <span className="font-semibold text-[#B42318]">Rate not set</span> : `${l.currentPct}%`}</td>
                    <td className={`${TD} text-xs`}>
                      {l.rates.length === 0 ? "—" : l.rates.slice(0, 4).map((r) => <div key={r.id}>{r.pct}% from {fmtDate(r.effectiveFrom)}</div>)}
                    </td>
                    <td className={TD}>{l.paysLaterTranches ? "Pays on later tranches" : "First tranche only"}</td>
                    <td className={TD}>
                      {l.needsRate > 0 && <span className="block text-[#B42318]">{l.needsRate} need a rate</span>}
                      {l.awaiting > 0 && <span className="block">{l.awaiting} awaiting payout</span>}
                      {l.needsRate === 0 && l.awaiting === 0 && "—"}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <div className="flex justify-end gap-3 text-[13px] font-semibold">
                        <button className="text-[#1570EF] hover:underline" onClick={() => setRateFor(l)}>Set rate</button>
                        <button className="text-[#667085] hover:underline" onClick={() => setEditLender(l)}>Edit</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DashboardCard>
      )}

      {tab === "partners" && (
        <DashboardCard title="Partner loan commission: % of the amount disbursed" bodyClassName="p-0">
          <p className="border-b border-[#F2F4F7] px-5 py-3 text-[13px] text-[#667085]">
            One % per partner, for every lender. There is no default: a partner without a % has their loans wait as &quot;Needs rate&quot; until it is set.
          </p>
          {partnersQ.isLoading ? (
            <SkeletonTable rows={4} cols={4} />
          ) : (partnersQ.data ?? []).length === 0 ? (
            <EmptyState label="No partner has referred a loan yet." />
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Partner</th>
                  <th className={TH}>Loan commission</th>
                  <th className={TH}>History</th>
                  <th className={TH}>Referrals / lines</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(partnersQ.data ?? []).map((p) => (
                  <tr key={p.key} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={`${TD} font-medium text-[#101828]`}>
                      {p.name}
                      <span className="block text-xs font-normal text-[#98A2B3]">{p.type === "independent" ? "Independent counsellor" : "Agency"}</span>
                    </td>
                    <td className={TD}>
                      {p.currentPct == null ? <span className="font-semibold text-[#B42318]">Not set</span> : `${p.currentPct}% of disbursed`}
                      {p.needsRate > 0 && <span className="block text-xs text-[#B42318]">{p.needsRate} line{p.needsRate === 1 ? "" : "s"} waiting</span>}
                    </td>
                    <td className={`${TD} text-xs`}>{p.rates.length === 0 ? "—" : p.rates.slice(0, 4).map((r) => <div key={r.id}>{r.pct}% from {fmtDate(r.effectiveFrom)}</div>)}</td>
                    <td className={TD}>
                      {p.referrals} / {p.lines}
                    </td>
                    <td className={`${TD} text-right`}>
                      <button className="text-[13px] font-semibold text-[#1570EF] hover:underline" onClick={() => setPartnerRateFor(p)}>Set %</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DashboardCard>
      )}

      {recording && (
        <RecordReceiptModal
          lenders={lendersQ.data ?? []}
          onClose={() => setRecording(false)}
          onDone={() => {
            setRecording(false);
            void refresh();
            setToast("Receipt recorded. A Super Admin or Finance Manager approves it.");
            setTab("receipts");
          }}
        />
      )}
      {deciding && (
        <DecideReceiptModal
          receipt={deciding.r}
          kind={deciding.kind}
          onClose={() => setDeciding(null)}
          onDone={(msg) => {
            setDeciding(null);
            void refresh();
            setToast(msg);
          }}
        />
      )}
      {lineAction && (
        <LineActionModal
          line={lineAction.line}
          kind={lineAction.kind}
          onClose={() => setLineAction(null)}
          onDone={(msg) => {
            setLineAction(null);
            void refresh();
            setToast(msg);
          }}
        />
      )}
      {adding && (
        <AddLineModal
          lenders={lendersQ.data ?? []}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void refresh();
            setToast("Line added.");
          }}
        />
      )}
      {editLender && (
        <LenderModal
          lender={editLender === "new" ? null : editLender}
          onClose={() => setEditLender(null)}
          onDone={() => {
            setEditLender(null);
            void refresh();
            setToast("Lender saved.");
          }}
        />
      )}
      {rateFor && (
        <RateModal
          title={`Rate: ${rateFor.name}`}
          hint="What this lender pays Collegepond, as a % of the amount disbursed. Lines disbursed on or after the date use it."
          onClose={() => setRateFor(null)}
          onSave={async (pct, effectiveFrom, note) => {
            const r = await utils.client.loanCommission.setLenderRate.mutate({ lenderId: rateFor.id, pct, effectiveFrom, note });
            setRateFor(null);
            void refresh();
            setToast(r.priced > 0 ? `Rate saved. ${r.priced} waiting line${r.priced === 1 ? "" : "s"} priced.` : "Rate saved.");
          }}
        />
      )}
      {partnerRateFor && (
        <RateModal
          title={`Loan commission: ${partnerRateFor.name}`}
          hint="The partner's commission as a % of the amount disbursed, for every lender. Lines disbursed on or after the date use it; backdate it to cover lines already waiting."
          onClose={() => setPartnerRateFor(null)}
          onSave={async (pct, effectiveFrom, note) => {
            const r = await utils.client.loanCommission.setPartnerRate.mutate({ payee: partnerRateFor.payee, pct, effectiveFrom, note });
            setPartnerRateFor(null);
            void refresh();
            setToast(r.priced > 0 ? `Saved. ${r.priced} waiting line${r.priced === 1 ? "" : "s"} priced.` : "Saved.");
          }}
        />
      )}
      <Toast message={toast ?? ""} open={toast != null} onClose={() => setToast(null)} />
    </div>
  );
}

// ---- modals ------------------------------------------------------------------

function ErrorLine({ msg }: { msg: string }) {
  return msg ? <p className="mt-2 text-xs font-medium text-[#F04438]">{msg}</p> : null;
}

function RateModal({
  title,
  hint,
  onClose,
  onSave,
}: {
  title: string;
  hint: string;
  onClose: () => void;
  onSave: (pct: number, effectiveFrom: string, note?: string) => Promise<void>;
}) {
  const [pct, setPct] = useState("");
  const [from, setFrom] = useState(today());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    const n = Number(pct);
    if (!pct || !Number.isFinite(n) || n < 0 || n > 100) return setErr("Enter a % between 0 and 100.");
    setBusy(true);
    setErr("");
    try {
      await onSave(n, from, note.trim() || undefined);
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Modal open title={title} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><div className="flex-1" /><Button onClick={() => void save()} loading={busy}>Save</Button></>}>
      <p className="mb-4 text-[13px] text-[#667085]">{hint}</p>
      <div className="flex gap-3">
        <FormInput label="% of disbursed" type="number" step="0.001" min="0" max="100" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="e.g. 1" required />
        <FormInput label="Effective from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="mt-3">
        <FormInput label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} />
      </div>
      <ErrorLine msg={err} />
    </Modal>
  );
}

function LenderModal({ lender, onClose, onDone }: { lender: Lender | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(lender?.name ?? "");
  const [later, setLater] = useState(lender?.paysLaterTranches ?? false);
  const [active, setActive] = useState(lender?.isActive ?? true);
  const [err, setErr] = useState("");
  const save = api.loanCommission.saveLender.useMutation();
  const submit = async () => {
    setErr("");
    try {
      await save.mutateAsync({ id: lender?.id, name: name.trim(), paysLaterTranches: later, isActive: active });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <Modal open title={lender ? `Edit ${lender.name}` : "Add lender"} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><div className="flex-1" /><Button onClick={() => void submit()} loading={save.isPending} disabled={!name.trim()}>Save</Button></>}>
      <FormInput label="Lender name (exactly as the loan team's Enrollment App spells it)" value={name} onChange={(e) => setName(e.target.value)} required />
      <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-[#344054]">
        <input type="checkbox" className="mt-0.5" checked={later} onChange={(e) => setLater(e.target.checked)} />
        <span>
          Pays on later tranches
          <span className="block text-xs text-[#667085]">Normally only the first disbursement tranche earns commission. Tick this when this lender pays on every tranche.</span>
        </span>
      </label>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-[#344054]">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
      </label>
      <ErrorLine msg={err} />
    </Modal>
  );
}

function RecordReceiptModal({ lenders, onClose, onDone }: { lenders: Lender[]; onClose: () => void; onDone: () => void }) {
  const [lenderId, setLenderId] = useState("");
  const [receivedOn, setReceivedOn] = useState(today());
  const [reference, setReference] = useState("");
  const [cpInvoice, setCpInvoice] = useState("");
  const [amount, setAmount] = useState("");
  const [gst, setGst] = useState("");
  const [tds, setTds] = useState("");
  const [note, setNote] = useState("");
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [err, setErr] = useState("");
  const openQ = api.loanCommission.openLinesForLender.useQuery({ lenderId: Number(lenderId) }, { enabled: !!lenderId });
  const record = api.loanCommission.recordReceipt.useMutation();

  const picked = Object.entries(alloc).filter(([, v]) => v !== "" && Number(v) > 0);
  const total = Math.round(picked.reduce((s, [, v]) => s + Number(v), 0) * 100) / 100;
  const toggle = (l: Line, on: boolean) =>
    setAlloc((a) => {
      const n = { ...a };
      if (on) n[l.id] = String(l.expectedCp ?? "");
      else delete n[l.id];
      return n;
    });

  const submit = async () => {
    setErr("");
    if (!lenderId) return setErr("Pick the lender.");
    if (!reference.trim()) return setErr("Enter the UTR / payment reference.");
    const amt = Number(amount);
    if (!amt || amt <= 0) return setErr("Enter the amount received, excluding GST.");
    if (picked.length === 0) return setErr("Tick the loans this payment covers.");
    if (Math.abs(total - amt) > 0.005) return setErr(`The loans add up to ${inr(total)}; the receipt is ${inr(amt)}.`);
    try {
      await record.mutateAsync({
        lenderId: Number(lenderId),
        receivedOn,
        reference: reference.trim(),
        cpInvoiceNumber: cpInvoice.trim() || undefined,
        amount: amt,
        gst: Number(gst) || 0,
        tds: Number(tds) || 0,
        note: note.trim() || undefined,
        allocations: picked.map(([id, v]) => ({ lineId: Number(id), amount: Number(v) })),
      });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <Modal
      open
      title="Record lender receipt"
      width="w-[880px]"
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><div className="flex-1" /><span className="mr-3 text-sm text-[#667085]">Ticked loans: <b className="text-[#101828]">{inr(total)}</b></span><Button onClick={() => void submit()} loading={record.isPending}>Record receipt</Button></>}
    >
      <p className="mb-4 text-[13px] text-[#667085]">
        Collegepond&apos;s payout from the lender. A Super Admin or Finance Manager approves it; the loans it covers then become claimable by the partners.
      </p>
      <div className="grid grid-cols-3 gap-3">
        <FormSelect label="Lender" required placeholder="Pick a lender" options={lenders.map((l) => ({ value: String(l.id), label: l.name }))} value={lenderId} onChange={(e) => { setLenderId(e.target.value); setAlloc({}); }} />
        <FormInput label="Received on" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        <FormInput label="UTR / reference" required value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        <FormInput label="Amount (excl. GST, before TDS)" type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        <FormInput label="GST received" type="number" step="0.01" value={gst} onChange={(e) => setGst(e.target.value)} />
        <FormInput label="TDS deducted by lender" type="number" step="0.01" value={tds} onChange={(e) => setTds(e.target.value)} />
        <FormInput label="CP's invoice no. to the lender" value={cpInvoice} onChange={(e) => setCpInvoice(e.target.value)} maxLength={50} />
        <div className="col-span-2">
          <FormInput label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-[#E4E7EC]">
        {!lenderId ? (
          <p className="p-4 text-sm text-[#667085]">Pick the lender to see the loans awaiting its payout.</p>
        ) : openQ.isLoading ? (
          <SkeletonTable rows={3} cols={5} />
        ) : (openQ.data ?? []).length === 0 ? (
          <p className="p-4 text-sm text-[#667085]">No priced loans are awaiting this lender&apos;s payout. Lines that need a rate must be priced first.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} w-10`} />
                <th className={TH}>Student / Partner</th>
                <th className={TH}>Disbursed</th>
                <th className={TH}>Expected</th>
                <th className={TH}>Partner amount</th>
                <th className={TH}>Amount in this receipt</th>
              </tr>
            </thead>
            <tbody>
              {(openQ.data ?? []).map((l) => {
                const on = alloc[l.id] !== undefined;
                return (
                  <tr key={l.id} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={TD}><input type="checkbox" checked={on} onChange={(e) => toggle(l, e.target.checked)} /></td>
                    <td className={TD}>{l.student}<span className="block text-xs text-[#98A2B3]">{l.partner} · tranche {l.trancheNo}</span></td>
                    <td className={TD}>{inr(l.disbursedAmount)}<span className="block text-xs text-[#98A2B3]">{fmtDate(l.disbursedOn)}</span></td>
                    <td className={TD}>{inr(l.expectedCp)}<span className="block text-xs text-[#98A2B3]">{pctText(l.lenderPct)}</span></td>
                    <td className={TD}>{inr(l.partnerAmount)}</td>
                    <td className={TD}>
                      <input
                        type="number"
                        step="0.01"
                        disabled={!on}
                        className="h-9 w-36 rounded-lg border border-[#D0D5DD] px-2 text-sm disabled:bg-[#F9FAFB]"
                        value={alloc[l.id] ?? ""}
                        onChange={(e) => setAlloc((a) => ({ ...a, [l.id]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <ErrorLine msg={err} />
    </Modal>
  );
}

function DecideReceiptModal({ receipt, kind, onClose, onDone }: { receipt: Receipt; kind: "approve" | "reject"; onClose: () => void; onDone: (msg: string) => void }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const approve = api.loanCommission.approveReceipt.useMutation();
  const reject = api.loanCommission.rejectReceipt.useMutation();
  const short = receipt.lines.filter((l) => l.partnerAmount != null && l.allocated < l.partnerAmount);
  const submit = async () => {
    setErr("");
    try {
      if (kind === "approve") {
        const r = await approve.mutateAsync({ id: receipt.id, note: note.trim() || undefined });
        onDone(`Approved. ${r.approved} loan${r.approved === 1 ? " is" : "s are"} now claimable by the partner.`);
      } else {
        if (!note.trim()) return setErr("Say why it's rejected.");
        await reject.mutateAsync({ id: receipt.id, note: note.trim() });
        onDone("Rejected. Its loans are awaiting the lender's payout again.");
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <Modal
      open
      title={`${kind === "approve" ? "Approve" : "Reject"} receipt ${receipt.reference}`}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><div className="flex-1" /><Button onClick={() => void submit()} loading={approve.isPending || reject.isPending}>{kind === "approve" ? "Approve" : "Reject"}</Button></>}
    >
      <p className="text-sm text-[#344054]">
        {receipt.lender} · {inr(receipt.amount)} excl. GST · received {fmtDate(receipt.receivedOn)} · {receipt.lines.length} loan{receipt.lines.length === 1 ? "" : "s"}
      </p>
      {kind === "approve" && (
        <p className="mt-2 text-[13px] text-[#667085]">The partners are told by bell and email that these loans are ready to claim.</p>
      )}
      {kind === "approve" && short.length > 0 && (
        <p className="mt-3 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">
          On {short.length} loan{short.length === 1 ? "" : "s"} the partner&apos;s amount is more than Collegepond received ({short.map((l) => l.student).join(", ")}).
        </p>
      )}
      <div className="mt-4">
        <label className={LABEL}>{kind === "approve" ? "Note (optional)" : "Reason"}</label>
        <textarea className={TEXTAREA} rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
      <ErrorLine msg={err} />
    </Modal>
  );
}

function LineActionModal({ line, kind, onClose, onDone }: { line: Line; kind: "cancel" | "clawback" | "clear" | "reprice"; onClose: () => void; onDone: (msg: string) => void }) {
  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [on, setOn] = useState(today());
  const [reference, setReference] = useState("");
  const [deduction, setDeduction] = useState(String(line.partnerAmount ?? ""));
  const [lenderPct, setLenderPct] = useState(line.lenderPct == null ? "" : String(line.lenderPct));
  const [partnerPct, setPartnerPct] = useState(line.partnerPct == null ? "" : String(line.partnerPct));
  const [err, setErr] = useState("");
  const cancel = api.loanCommission.cancelLine.useMutation();
  const clawback = api.loanCommission.recordClawback.useMutation();
  const clear = api.loanCommission.clearAttention.useMutation();
  const reprice = api.loanCommission.setLineRates.useMutation();
  const busy = cancel.isPending || clawback.isPending || clear.isPending || reprice.isPending;
  const title = { cancel: "Cancel loan commission", clawback: "Record lender clawback", clear: "Mark as checked", reprice: "Change rates" }[kind];
  const submit = async () => {
    setErr("");
    try {
      if (kind === "cancel") {
        await cancel.mutateAsync({ id: line.id, reason: text.trim() });
        onDone("Line cancelled.");
      } else if (kind === "clear") {
        await clear.mutateAsync({ id: line.id, note: text.trim() });
        onDone("Marked as checked.");
      } else if (kind === "reprice") {
        await reprice.mutateAsync({
          id: line.id,
          lenderPct: lenderPct === "" ? null : Number(lenderPct),
          partnerPct: partnerPct === "" ? null : Number(partnerPct),
          reason: text.trim(),
        });
        onDone("Rates changed.");
      } else {
        const r = await clawback.mutateAsync({
          id: line.id,
          amount: Number(amount),
          on,
          reference: reference.trim() || undefined,
          partnerDeduction: Number(deduction) || 0,
          note: text.trim() || undefined,
        });
        onDone(r.adjustmentId ? `Clawback recorded. Partner deduction draft #${r.adjustmentId} is in Adjustments for a Super Admin to approve.` : "Clawback recorded.");
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <Modal open title={title} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><div className="flex-1" /><Button onClick={() => void submit()} loading={busy}>Save</Button></>}>
      <p className="mb-4 text-sm text-[#344054]">
        {line.student} · {line.partner} · {line.lender} tranche {line.trancheNo} · {inr(line.disbursedAmount)} disbursed
      </p>
      {kind === "clear" && line.attention && <p className="mb-3 rounded bg-[#FFFAEB] px-3 py-2 text-[13px] text-[#B54708]">{line.attention}</p>}
      {kind === "cancel" && <p className="mb-3 text-[13px] text-[#667085]">The partner sees &quot;Cancelled&quot; with this reason. It can&apos;t be undone.</p>}
      {kind === "reprice" && (
        <div className="mb-3 flex gap-3">
          <FormInput label="Lender % (CP's payout)" type="number" step="0.001" value={lenderPct} onChange={(e) => setLenderPct(e.target.value)} />
          <FormInput label="Partner % of disbursed" type="number" step="0.001" value={partnerPct} onChange={(e) => setPartnerPct(e.target.value)} />
        </div>
      )}
      {kind === "clawback" && (
        <>
          <p className="mb-3 text-[13px] text-[#667085]">
            The partner was paid {inr(line.partnerAmount)} on this loan. Saving pre-fills a partner deduction in Adjustments; a Super Admin approves it and it is netted from their next payout.
          </p>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <FormInput label="Amount the lender clawed back" type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
            <FormInput label="Date" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
            <FormInput label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
            <FormInput label="Deduct from partner (₹, 0 for none)" type="number" step="0.01" value={deduction} onChange={(e) => setDeduction(e.target.value)} />
          </div>
        </>
      )}
      <label className={LABEL}>{kind === "cancel" ? "Reason (shown to the partner)" : kind === "clawback" ? "Note (optional)" : "Note"}</label>
      <textarea className={TEXTAREA} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      <ErrorLine msg={err} />
    </Modal>
  );
}

function AddLineModal({ lenders, isSuperAdmin, onClose, onDone }: { lenders: Lender[]; isSuperAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [referralId, setReferralId] = useState<number | null>(null);
  const [applicationId, setApplicationId] = useState("");
  const [lenderId, setLenderId] = useState("");
  const [amount, setAmount] = useState("");
  const [on, setOn] = useState(today());
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const searchQ = api.loanCommission.referralSearch.useQuery({ q: q.trim() }, { enabled: q.trim().length >= 2 });
  const add = api.loanCommission.addLine.useMutation();
  const ref = (searchQ.data ?? []).find((r) => r.id === referralId) ?? null;
  const kind: "tranche" | "credit" = ref?.duplicate ? "credit" : "tranche";
  const submit = async () => {
    setErr("");
    if (!ref) return setErr("Pick the referral.");
    if (kind === "credit" && !isSuperAdmin) return setErr("Only a Super Admin can credit a duplicate referral.");
    try {
      await add.mutateAsync({
        referralId: ref.id,
        kind,
        applicationId: kind === "tranche" && applicationId ? Number(applicationId) : undefined,
        lenderId: kind === "credit" && lenderId ? Number(lenderId) : undefined,
        amount: Number(amount),
        on,
        note: note.trim(),
      });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <Modal open title="Add a loan commission line" width="w-[720px]" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><div className="flex-1" /><Button onClick={() => void submit()} loading={add.isPending} disabled={!ref}>Add line</Button></>}>
      <p className="mb-4 text-[13px] text-[#667085]">
        For a later disbursement tranche the lender pays on, or (Super Admin) to credit a partner for a duplicate &quot;Already in progress with Collegepond&quot; referral. Lines from the Enrollment App open by themselves.
      </p>
      <FormInput label="Find the referral (student name, phone or email)" value={q} onChange={(e) => { setQ(e.target.value); setReferralId(null); }} />
      {q.trim().length >= 2 && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-[#E4E7EC]">
          {(searchQ.data ?? []).length === 0 ? (
            <p className="p-3 text-sm text-[#667085]">{searchQ.isLoading ? "Searching…" : "No referral found."}</p>
          ) : (
            (searchQ.data ?? []).map((r) => (
              <button key={r.id} onClick={() => setReferralId(r.id)} className={`block w-full border-b border-[#F2F4F7] px-3 py-2 text-left text-sm last:border-0 ${referralId === r.id ? "bg-[#EFF8FF]" : "hover:bg-[#F9FAFB]"}`}>
                <b className="text-[#101828]">{r.student}</b> · {r.partner}
                {r.duplicate ? <span className="ml-1.5 text-xs text-[#6941C6]">Duplicate referral</span> : <span className="ml-1.5 text-xs text-[#98A2B3]">{r.applications.length} lender application{r.applications.length === 1 ? "" : "s"}</span>}
              </button>
            ))
          )}
        </div>
      )}
      {ref && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {kind === "tranche" ? (
            <div className="col-span-2">
              <FormSelect
                label="Lender application"
                required
                placeholder="Pick one"
                options={ref.applications.map((a) => ({ value: String(a.id), label: `${a.lender} · ${a.status}${a.disbursedAmount != null ? ` · ${inr(a.disbursedAmount)} disbursed` : ""}` }))}
                value={applicationId}
                onChange={(e) => setApplicationId(e.target.value)}
              />
            </div>
          ) : (
            <div className="col-span-2">
              <FormSelect label="Lender" required placeholder="Pick a lender" options={lenders.map((l) => ({ value: String(l.id), label: l.name }))} value={lenderId} onChange={(e) => setLenderId(e.target.value)} />
            </div>
          )}
          <FormInput label="Amount disbursed (this tranche)" type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <FormInput label="Disbursed on" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
          <div className="col-span-2">
            <label className={LABEL}>Why (kept in the audit log)</label>
            <textarea className={TEXTAREA} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </div>
        </div>
      )}
      <ErrorLine msg={err} />
    </Modal>
  );
}
