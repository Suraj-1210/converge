"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { PayeeTags } from "~/components/admin/payee-tags";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import {
  DashboardCard,
  StatCard,
  SkeletonTable,
  EmptyState,
} from "~/components/dashboard/widgets";
import { formatINR, formatDate } from "~/components/dashboard/format";
import { fxLine } from "~/lib/currency";
import {
  AdminRole,
  PartnerInvoiceStatus,
  PartnerInvoiceStatusLabel,
  PARTNER_INVOICE_STATUS_CODES,
  PayoutMethodLabel,
  VendorInvoiceStatusLabel,
} from "~/server/db/enums";

type RO = inferRouterOutputs<AppRouter>;
type Invoice = RO["partnerPayouts"]["list"][number];
type Item = Invoice["items"][number];

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const toInputDate = (d: Date | string) =>
  (typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);

function StatusPill({ status }: { status: number }) {
  const tone =
    status === PartnerInvoiceStatus.PAID
      ? "bg-[#ECFDF3] text-[#067647]"
      : status === PartnerInvoiceStatus.REJECTED
        ? "bg-[#FEF3F2] text-[#B42318]"
        : status === PartnerInvoiceStatus.APPROVED
          ? "bg-[#EFF8FF] text-[#1570EF]"
          : status === PartnerInvoiceStatus.PARTIAL_APPROVED
            ? "bg-[#F9F5FF] text-[#7F56D9]"
            : status === PartnerInvoiceStatus.UNDER_REVIEW
              ? "bg-[#FFF6ED] text-[#B54708]"
              : "bg-[#F2F4F7] text-[#667085]";
  return (
    <span className={`rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}>
      {PartnerInvoiceStatusLabel[status as 0 | 1 | 2 | 3 | 4 | 5]}
    </span>
  );
}

function MatchBadge({ match }: { match: Item["match"] }) {
  if (match === "verified")
    return <span className="rounded-[10px] bg-[#ECFDF3] px-2.5 py-0.5 text-[11px] font-semibold text-[#067647]">✓ Verified</span>;
  if (match === "partial")
    return <span className="rounded-[10px] bg-[#FFF6ED] px-2.5 py-0.5 text-[11px] font-semibold text-[#B54708]">⚠ Partial</span>;
  return <span className="rounded-[10px] bg-[#FEF3F2] px-2.5 py-0.5 text-[11px] font-semibold text-[#B42318]">✗ No Payment</span>;
}

const GH = "border-b border-[#E4E7EC] px-3.5 py-2 text-left text-[11px] font-bold uppercase tracking-wider";

export default function InvoicesPayoutsPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const canView =
    role === AdminRole.SUPER_ADMIN ||
    role === AdminRole.FINANCE_MANAGER ||
    role === AdminRole.FINANCE_EXECUTIVE;
  const canApprove =
    role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;
  const reviewOnly = canView && !canApprove;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [tab, setTab] = useState<"invoices" | "history">("invoices");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [rejectFor, setRejectFor] = useState<Invoice | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [partner, setPartner] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (m: string) => {
    setToastMsg(m);
    setToastOpen(true);
  };

  const utils = api.useUtils();
  const statsQ = api.partnerPayouts.stats.useQuery(undefined, { enabled: canView });
  const listQ = api.partnerPayouts.list.useQuery(undefined, { enabled: canView });
  const historyQ = api.partnerPayouts.paymentHistory.useQuery(undefined, { enabled: canView });
  const s = statsQ.data;

  const onOk = (msg: string) => () => {
    void utils.partnerPayouts.invalidate();
    showToast(msg);
  };
  const review = api.partnerPayouts.review.useMutation({ onSuccess: onOk("Moved to under review"), onError: (e) => showToast(e.message) });
  const approve = api.partnerPayouts.approve.useMutation({ onSuccess: onOk("Approved for payment"), onError: (e) => showToast(e.message) });
  const reject = api.partnerPayouts.reject.useMutation({
    onSuccess: () => { void utils.partnerPayouts.invalidate(); showToast("Invoice rejected"); setRejectFor(null); },
    onError: (e) => showToast(e.message),
  });

  const allInvoices = useMemo(() => listQ.data ?? [], [listQ.data]);
  const partners = useMemo(() => Array.from(new Set(allInvoices.map((i) => i.partner))).sort(), [allInvoices]);
  const invoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allInvoices.filter((inv) => {
      if (q && !`${inv.invoiceNumber} ${inv.partner} ${inv.id}`.toLowerCase().includes(q)) return false;
      if (partner && inv.partner !== partner) return false;
      if (status !== "" && inv.status !== Number(status)) return false;
      const d = toInputDate(inv.invoiceDate);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }, [allInvoices, search, partner, status, from, to]);

  const toggle = (id: number) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const resetFilters = () => {
    setSearch(""); setPartner(""); setStatus(""); setFrom(""); setTo("");
  };

  if (!mounted || meQ.isLoading) {
    return (
      <DashboardCard title="Invoices & Payouts" bodyClassName="p-0">
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
          <p className="mt-2 text-sm text-[#667085]">
            Finance modules are available to Super Admin, Finance Managers, and Finance Executives only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#101828]">Invoices &amp; Payouts</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Review partner invoices, cross-reference university payments, and approve for payout.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="applications" tone="blue" label="Total Invoices Received" value={s?.total ?? "—"} />
        <StatCard icon="clock" tone="orange" label="Pending Review" value={s?.pendingReview ?? "—"} />
        <StatCard icon="approvals" tone="cyan" label="Approved (Awaiting Payment)" value={s?.approved ?? "—"} />
        <StatCard icon="revenue" tone="purple" label="Total Amount Pending" value={s ? formatINR(s.amountPending) : "—"} />
      </div>

      <div className="mb-5 flex gap-2 border-b border-[#E4E7EC]">
        {([
          { id: "invoices", label: "Partner Invoices", count: allInvoices.length },
          { id: "history", label: "Payment History", count: historyQ.data?.length ?? 0 },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-semibold transition ${
              tab === t.id ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"
            }`}
          >
            {t.label}
            <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === "invoices" ? (
        <>
          {/* Filter bar */}
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="w-64">
              <FormInput label="Search" placeholder="Search by partner, invoice #..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="w-44">
              <FormSelect label="Partner" placeholder="All Partners" options={partners.map((p) => ({ value: p, label: p }))} value={partner} onChange={(e) => setPartner(e.target.value)} />
            </div>
            <div className="w-44">
              <FormSelect
                label="Status"
                placeholder="All Statuses"
                options={PARTNER_INVOICE_STATUS_CODES.filter((c) => c !== PartnerInvoiceStatus.PAID).map((c) => ({ value: String(c), label: PartnerInvoiceStatusLabel[c] }))}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              />
            </div>
            <div className="w-40">
              <FormInput label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="w-40">
              <FormInput label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button variant="secondary" onClick={resetFilters}>Reset</Button>
            {reviewOnly && (
              <span className="ml-auto self-center rounded-lg bg-[#FFF6ED] px-3 py-1.5 text-xs font-medium text-[#B54708]">
                Review only — approval requires Finance Manager
              </span>
            )}
          </div>

          <DashboardCard
            title="Partner Invoices"
            bodyClassName="p-0"
            headerRight={<span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{invoices.length} of {allInvoices.length}</span>}
          >
            {listQ.isLoading ? (
              <SkeletonTable rows={5} cols={7} />
            ) : invoices.length === 0 ? (
              <EmptyState label={allInvoices.length === 0 ? "No partner invoices yet." : "No invoices match your filters."} />
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={`${TH} w-8`}></th>
                    <th className={TH}>Partner</th>
                    <th className={TH}>Invoice #</th>
                    <th className={TH}>Date</th>
                    <th className={TH}># Students</th>
                    <th className={TH}>Total Amount</th>
                    <th className={TH}>Status</th>
                    <th className={`${TH} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const open = expanded.has(inv.id);
                    const reviewable =
                      inv.status === PartnerInvoiceStatus.SUBMITTED ||
                      inv.status === PartnerInvoiceStatus.UNDER_REVIEW;
                    const actionable = reviewable && !inv.hasPayout;
                    return (
                      <Fragment key={inv.id}>
                        <tr className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
                          <td className={`${TD} w-8`}>
                            <button onClick={() => toggle(inv.id)}>
                              <svg viewBox="0 0 24 24" className={`h-4 w-4 text-[#667085] transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                            </button>
                          </td>
                          <td className={`${TD} font-medium text-[#101828]`}>
                            {inv.partner}
                            <PayeeTags partnerType={inv.partnerType} payeeInactive={inv.payeeInactive} panReview={inv.panReview} />
                          </td>
                          <td className={`${TD} font-mono text-[13px]`}>{inv.invoiceNumber}</td>
                          <td className={TD}>{formatDate(inv.invoiceDate)}</td>
                          <td className={TD}>{inv.students}</td>
                          <td className={`${TD} font-semibold text-[#101828]`}>
                            {inr(inv.totalAmount)}
                            {inv.payoutCurrency !== "INR" && <span className="block text-[11px] font-medium text-[#B54708]">Paid in {inv.payoutCurrency}</span>}
                          </td>
                          <td className={TD}><StatusPill status={inv.status} /></td>
                          <td className={`${TD} text-right whitespace-nowrap`}>
                            {inv.status === PartnerInvoiceStatus.SUBMITTED && canApprove ? (
                              <button className="text-[13px] font-semibold text-[#1570EF] hover:underline" onClick={() => review.mutate({ invoiceId: inv.id })}>Review</button>
                            ) : (
                              <button className="text-[13px] font-semibold text-[#667085] hover:underline" onClick={() => toggle(inv.id)}>View</button>
                            )}
                            {inv.hasPayout && (inv.status === PartnerInvoiceStatus.APPROVED || inv.status === PartnerInvoiceStatus.PARTIAL_APPROVED) && (
                              <span className="ml-3 text-xs text-[#98A2B3]">→ Reconciliation</span>
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-[#F9FAFB]">
                            <td colSpan={8} className="px-4 py-3">
                              <CrossRef
                                inv={inv}
                                canApprove={canApprove}
                                reviewOnly={reviewOnly}
                                actionable={actionable}
                                onApprove={() => approve.mutate({ invoiceId: inv.id })}
                                onReject={() => setRejectFor(inv)}
                                busy={approve.isPending}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </DashboardCard>
        </>
      ) : (
        <DashboardCard title="Released Payments" bodyClassName="p-0">
          {historyQ.isLoading ? (
            <SkeletonTable rows={3} cols={6} />
          ) : (historyQ.data ?? []).length === 0 ? (
            <EmptyState label="No payments released yet. Approved payouts appear here once released via Reconciliation." />
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Partner</th>
                  <th className={TH}>Invoice #</th>
                  <th className={TH}>Amount (₹)</th>
                  <th className={TH}>Payment Method</th>
                  <th className={TH}>Payment Date</th>
                  <th className={TH}>Reference #</th>
                </tr>
              </thead>
              <tbody>
                {(historyQ.data ?? []).map((p) => (
                  <tr key={p.id} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={`${TD} font-medium text-[#101828]`}>
                      {p.partner}
                      <PayeeTags partnerType={p.partnerType} />
                    </td>
                    <td className={`${TD} font-mono text-[13px]`}>{p.invoiceNumber}</td>
                    <td className={`${TD} font-semibold text-[#101828]`}>
                      {inr(p.amountInr)}
                      {p.currency !== "INR" && p.amountForeign != null && p.exchangeRate != null && (
                        <span className="block text-[11px] font-normal text-[#667085]">{fxLine(p.amountForeign, p.currency, p.exchangeRate, p.amountInr)}</span>
                      )}
                    </td>
                    <td className={TD}>{p.method == null ? "—" : PayoutMethodLabel[p.method as 0 | 1 | 2 | 3 | 4]}</td>
                    <td className={TD}>{p.paymentDate ? formatDate(p.paymentDate) : "—"}</td>
                    <td className={TD}>{p.reference ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DashboardCard>
      )}

      {rejectFor && (
        <RejectModal
          invoice={rejectFor}
          onClose={() => setRejectFor(null)}
          onReject={(reason) => reject.mutate({ invoiceId: rejectFor.id, reason })}
          saving={reject.isPending}
        />
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}

// ---- Cross-reference (expanded row) ----------------------------------------
function CrossRef({
  inv,
  canApprove,
  reviewOnly,
  actionable,
  onApprove,
  onReject,
  busy,
}: {
  inv: Invoice;
  canApprove: boolean;
  reviewOnly: boolean;
  actionable: boolean;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-[#475467]">
          Cross-Reference: Partner Claim vs University Payment Records
          <span className="ml-2 font-normal text-[#667085]">
            {inv.verifiedCount} of {inv.students} students verified
            {inv.noneCount > 0 && ` — ${inv.noneCount} pending university payment`}
            {inv.partialCount > 0 && ` — ${inv.partialCount} partial payment received`}
          </span>
        </div>
        <div className="text-xs text-[#98A2B3]">
          Net payable <span className="font-semibold text-[#101828]">{inr(inv.netPayable)}</span>
          {inv.payoutCurrency !== "INR" && (
            <span className="ml-2 font-medium text-[#B54708]">· paid in {inv.payoutCurrency} at the rate on release (no GST / TDS)</span>
          )}
          {inv.gstin && <span className="ml-2">· GSTIN {inv.gstin}</span>}
        </div>
      </div>

      {inv.status === PartnerInvoiceStatus.REJECTED && inv.rejectionReason && (
        <div className="mb-3 rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3.5 py-2.5 text-sm text-[#B42318]">
          <span className="font-semibold">Rejection Reason:</span> {inv.rejectionReason}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-[#E4E7EC]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th colSpan={4} className={`${GH} bg-[#EFF8FF] text-[#1570EF]`}>Partner&apos;s Claim</th>
              <th colSpan={3} className={`${GH} border-l-2 border-l-[#E4E7EC] bg-[#ECFDF3] text-[#027A48]`}>University Payment Record</th>
              <th className={`${GH} border-l-2 border-l-[#E4E7EC] bg-[#F9FAFB] text-[#667085]`}>Match</th>
            </tr>
            <tr>
              <th className={TH}>Student Name</th>
              <th className={TH}>University</th>
              <th className={TH}>Program</th>
              <th className={TH}>Claimed Amount</th>
              <th className={`${TH} border-l-2 border-l-[#E4E7EC]`}>Payment Status</th>
              <th className={TH}>Amount Received</th>
              <th className={TH}>Invoice Ref</th>
              <th className={`${TH} border-l-2 border-l-[#E4E7EC]`}>Status</th>
            </tr>
          </thead>
          <tbody>
            {inv.items.map((it, i) => (
              <tr key={i} className="border-b border-[#F2F4F7] last:border-0">
                <td className={`${TD} font-medium text-[#101828]`}>
                  {it.student}
                  {it.tranche && <span className="block text-xs font-normal text-[#98A2B3]">{it.tranche}</span>}
                </td>
                <td className={TD}>{it.university}</td>
                <td className={TD}>{it.program}</td>
                <td className={`${TD} font-semibold text-[#101828]`}>{inr(it.claimed)}</td>
                <td className={`${TD} border-l-2 border-l-[#E4E7EC]`}>
                  {it.paymentStatus == null ? (
                    <span className="text-[#98A2B3]">No record found</span>
                  ) : (
                    <span className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${it.match === "verified" ? "bg-[#EFF8FF] text-[#1570EF]" : it.match === "partial" ? "bg-[#FFF6ED] text-[#B54708]" : "bg-[#FEF3F2] text-[#B42318]"}`}>
                      {VendorInvoiceStatusLabel[it.paymentStatus as 0 | 1 | 2 | 3]}
                    </span>
                  )}
                </td>
                <td className={`${TD} font-semibold text-[#101828]`}>{it.amountReceived > 0 ? inr(it.amountReceived) : "—"}</td>
                <td className={`${TD} font-mono text-[13px]`}>{it.invoiceRef ?? "—"}</td>
                <td className={`${TD} border-l-2 border-l-[#E4E7EC]`}><MatchBadge match={it.match} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Action bar */}
      {actionable && canApprove && (
        <div className="mt-3 flex items-center gap-2">
          <button
            className={`rounded-lg px-4 py-2 text-[13px] font-semibold ${inv.allVerified ? "bg-[#12B76A] text-white hover:bg-[#039855]" : "cursor-not-allowed bg-[#EAECF0] text-[#98A2B3]"}`}
            disabled={!inv.allVerified || busy}
            title={inv.allVerified ? "All students verified" : "Cannot approve — not all students have verified university payments"}
            onClick={onApprove}
          >
            Approve for Payment
          </button>
          <button className="rounded-lg border border-[#FDA29B] px-4 py-2 text-[13px] font-semibold text-[#B42318] hover:bg-[#FEF3F2]" onClick={onReject}>
            Reject
          </button>
        </div>
      )}
      {actionable && reviewOnly && (
        <p className="mt-3 text-xs font-medium text-[#B54708]">Approval requires Finance Manager or Super Admin.</p>
      )}
    </div>
  );
}

function RejectModal({
  invoice,
  onClose,
  onReject,
  saving,
}: {
  invoice: Invoice;
  onClose: () => void;
  onReject: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  return (
    <Modal
      open
      title={`Reject ${invoice.invoiceNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => (reason.trim() ? onReject(reason.trim()) : setErr("Please provide a rejection reason"))} loading={saving}>
            Reject Invoice
          </Button>
        </>
      }
    >
      <FormTextarea label="Reason for rejection" required value={reason} onChange={(e) => setReason(e.target.value)} error={!!err} errorMessage={err} placeholder="Explain why this invoice is being rejected..." />
    </Modal>
  );
}
