"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { useExportLog } from "~/lib/export-log";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { Toast } from "~/components/ui/toast";
import {
  DashboardCard,
  StatCard,
  SkeletonTable,
  EmptyState,
} from "~/components/dashboard/widgets";
import { formatINR, formatDate } from "~/components/dashboard/format";
import {
  AdminRole,
  PayoutStatus,
  PayoutStatusLabel,
  PayoutMethod,
  PayoutMethodLabel,
} from "~/server/db/enums";

type RO = inferRouterOutputs<AppRouter>;
type Payout = RO["reconciliation"]["listPending"][number];
type Completed = RO["reconciliation"]["completed"][number];

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const todayInput = () => new Date().toISOString().slice(0, 10);
// The mock's payment method is a 3-option radio (no IMPS/UPI).
const METHOD_RADIO = [PayoutMethod.NEFT, PayoutMethod.RTGS, PayoutMethod.INTERNATIONAL_WIRE];

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

function StatusPill({ status }: { status: number }) {
  const map: Record<number, string> = {
    [PayoutStatus.APPROVED]: "bg-[#FFF6ED] text-[#B54708]",
    [PayoutStatus.READY_TO_PAY]: "bg-[#EFF8FF] text-[#1570EF]",
    [PayoutStatus.RELEASED]: "bg-[#ECFDF3] text-[#067647]",
    [PayoutStatus.ON_HOLD]: "bg-[#FEF3F2] text-[#B42318]",
    [PayoutStatus.SENT_BACK]: "bg-[#F2F4F7] text-[#667085]",
  };
  return (
    <span className={`rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${map[status] ?? "bg-[#F2F4F7] text-[#667085]"}`}>
      {PayoutStatusLabel[status as 0 | 1 | 2 | 3 | 4]}
    </span>
  );
}

function CountChip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{children}</span>;
}

export default function ReconciliationPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const canVerify =
    role === AdminRole.SUPER_ADMIN ||
    role === AdminRole.FINANCE_MANAGER ||
    role === AdminRole.FINANCE_EXECUTIVE;
  const canRelease = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;
  const isSuperAdmin = role === AdminRole.SUPER_ADMIN;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [tab, setTab] = useState<"pending" | "completed">("pending");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [doneExpanded, setDoneExpanded] = useState<Set<number>>(new Set());
  const [reasonFor, setReasonFor] = useState<{ payout: Payout; kind: "hold" | "sendBack" } | null>(null);
  const [pendingSearch, setPendingSearch] = useState("");
  const [doneSearch, setDoneSearch] = useState("");

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (m: string) => { setToastMsg(m); setToastOpen(true); };

  const utils = api.useUtils();
  const logExport = useExportLog();
  const statsQ = api.reconciliation.stats.useQuery(undefined, { enabled: canVerify });
  const pendingQ = api.reconciliation.listPending.useQuery(undefined, { enabled: canVerify });
  const completedQ = api.reconciliation.completed.useQuery(undefined, { enabled: canVerify });
  const s = statsQ.data;

  const refetch = () => void utils.reconciliation.invalidate();
  const verify = api.reconciliation.verify.useMutation({
    onSuccess: (r) => { refetch(); showToast(r.readyToPay ? "Verified — ready to pay" : "Checklist saved"); },
    onError: (e) => showToast(e.message),
  });
  const release = api.reconciliation.release.useMutation({
    onSuccess: () => { refetch(); showToast("Payment released — commission disbursed"); },
    onError: (e) => showToast(e.message),
  });
  const hold = api.reconciliation.hold.useMutation({
    onSuccess: () => { refetch(); showToast("Put on hold"); setReasonFor(null); },
    onError: (e) => showToast(e.message),
  });
  const sendBack = api.reconciliation.sendBack.useMutation({
    onSuccess: () => { refetch(); showToast("Sent back"); setReasonFor(null); },
    onError: (e) => showToast(e.message),
  });
  const paymentsQ = api.reconciliation.paymentsConfig.useQuery(undefined, { enabled: canVerify });
  const payments = paymentsQ.data ?? { configured: false, mode: null };
  const verifyBank = api.reconciliation.verifyBankAccount.useMutation({
    onSuccess: (r) => { refetch(); showToast(r.verified ? `Bank verified${r.registeredName ? ` — ${r.registeredName}` : ""}` : `Verification ${r.status}: ${r.accountStatus ?? "pending"}`); },
    onError: (e) => showToast(e.message),
  });

  const markBankVerified = api.reconciliation.markBankVerified.useMutation({
    onSuccess: () => { refetch(); showToast("Bank account marked verified"); },
    onError: (e) => showToast(e.message),
  });
  const revealAccount = api.reconciliation.revealAccountNumber.useMutation({
    onError: (e) => showToast(e.message),
  });

  const allPending = useMemo(() => pendingQ.data ?? [], [pendingQ.data]);
  const allCompleted = useMemo(() => completedQ.data ?? [], [completedQ.data]);
  const pending = useMemo(() => {
    const q = pendingSearch.trim().toLowerCase();
    if (!q) return allPending;
    return allPending.filter((p) =>
      `${p.partner} ${p.invoiceNumber} ${p.students.map((st) => st.name).join(" ")}`.toLowerCase().includes(q),
    );
  }, [allPending, pendingSearch]);
  const completed = useMemo(() => {
    const q = doneSearch.trim().toLowerCase();
    if (!q) return allCompleted;
    return allCompleted.filter((p) => `${p.partner} ${p.invoiceNumber} ${p.reference ?? ""}`.toLowerCase().includes(q));
  }, [allCompleted, doneSearch]);

  const toggle = (id: number, done = false) => {
    const setFn = done ? setDoneExpanded : setExpanded;
    setFn((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const exportCompleted = () => {
    if (allCompleted.length === 0) { showToast("No completed payments to export."); return; }
    const header = [
      "Partner", "Invoice #", "Amount (INR)", "Student", "University", "Payment Method", "Reference #",
      "Payment Date", "Bank", "Account", "IFSC/SWIFT", "Approved By", "Approved Date", "Verified By",
      "Verified Date", "Released By", "Released Date", "Notes",
    ];
    const body = allCompleted.map((p) => [
      p.partner, p.invoiceNumber, p.amountInr,
      p.students.map((st) => st.name).join("; "),
      p.students.map((st) => st.university).join("; "),
      p.method == null ? "" : PayoutMethodLabel[p.method as 0 | 1 | 2 | 3 | 4],
      p.reference ?? "",
      p.paymentDate ? formatDate(p.paymentDate) : "",
      p.bankName ?? "",
      p.accountLast4 ? `****${p.accountLast4}` : "",
      p.swift ?? p.ifsc ?? "",
      p.approvedBy ?? "", p.approvedAt ? formatDate(p.approvedAt) : "",
      p.verifiedBy ?? "", p.verifiedAt ? formatDate(p.verifiedAt) : "",
      p.releasedBy ?? "", p.releasedAt ? formatDate(p.releasedAt) : "",
      p.notes ?? "",
    ]);
    downloadCsv(`completed_payments_${todayInput()}.csv`, [header, ...body]);
    logExport("Completed payments CSV", body.length);
  };

  if (!mounted || meQ.isLoading) {
    return (
      <DashboardCard title="Reconciliation & Payment Release" bodyClassName="p-0">
        <SkeletonTable rows={6} cols={6} />
      </DashboardCard>
    );
  }
  if (!canVerify) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-[#E4E7EC] bg-white px-8 py-12 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#FEF3F2] text-2xl">🔒</div>
          <h2 className="text-lg font-bold text-[#101828]">Access Restricted</h2>
          <p className="mt-2 text-sm text-[#667085]">
            Reconciliation is available to Finance Managers, Finance Executives, and Admins only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#101828]">Reconciliation &amp; Payment Release</h1>
        <p className="mt-1 text-sm text-[#667085]">Verify approved payouts and release payments to partners.</p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="clock" tone="orange" label="Pending Verification" value={s?.pendingVerification ?? "—"} />
        <StatCard icon="revenue" tone="purple" label="Total Amount Pending" value={s ? formatINR(s.amountPending) : "—"} />
        <StatCard icon="approvals" tone="blue" label="Verified Ready to Pay" value={s?.readyToPay ?? "—"} />
        <StatCard icon="check" tone="green" label="Released This Month" value={s?.releasedThisMonth ?? "—"} />
      </div>

      <div className="mb-5 flex gap-2 border-b border-[#E4E7EC]">
        {([
          { id: "pending", label: "Pending Reconciliation", count: pending.length },
          { id: "completed", label: "Completed Payments", count: completed.length },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-semibold transition ${
              tab === t.id ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"
            }`}
          >
            {t.label}
            <CountChip>{t.count}</CountChip>
          </button>
        ))}
      </div>

      {tab === "pending" ? (
        <DashboardCard
          title="Pending Verification & Release"
          bodyClassName="p-0"
          headerRight={
            <div className="w-60">
              <input
                value={pendingSearch}
                onChange={(e) => setPendingSearch(e.target.value)}
                placeholder="Search payouts..."
                className="h-9 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]"
              />
            </div>
          }
        >
          {pendingQ.isLoading ? (
            <SkeletonTable rows={4} cols={7} />
          ) : pending.length === 0 ? (
            <EmptyState label={allPending.length === 0 ? "All caught up. No pending payouts awaiting verification." : "No payouts match your search."} />
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} w-8`}></th>
                  <th className={TH}>Partner Name</th>
                  <th className={TH}>Invoice #</th>
                  <th className={TH}>Amount (₹)</th>
                  <th className={TH}>Approved By</th>
                  <th className={TH}>Approved Date</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <Fragment key={p.id}>
                    <tr className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
                      <td className={`${TD} w-8`}>
                        <button onClick={() => toggle(p.id)}>
                          <svg viewBox="0 0 24 24" className={`h-4 w-4 text-[#667085] transition-transform ${expanded.has(p.id) ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                        </button>
                      </td>
                      <td className={`${TD} font-medium text-[#101828]`}>{p.partner}</td>
                      <td className={`${TD} font-mono text-[13px] text-[#1570EF]`}>{p.invoiceNumber}</td>
                      <td className={`${TD} font-semibold text-[#101828]`}>{inr(p.amountInr)}</td>
                      <td className={TD}>{p.approvedBy ?? "—"}</td>
                      <td className={TD}>{p.opsApprovedAt ? formatDate(p.opsApprovedAt) : "—"}</td>
                      <td className={TD}><StatusPill status={p.status} /></td>
                      <td className={`${TD} text-right`}>
                        <button className="text-[13px] font-semibold text-[#1570EF] hover:underline" onClick={() => toggle(p.id)}>
                          {p.status === PayoutStatus.READY_TO_PAY ? "Release" : p.status === PayoutStatus.ON_HOLD ? "Review" : "Verify"}
                        </button>
                      </td>
                    </tr>
                    {expanded.has(p.id) && (
                      <tr className="bg-[#F9FAFB]">
                        <td colSpan={8} className="px-4 py-4">
                          <ReconPanel
                            payout={p}
                            canVerify={canVerify}
                            canRelease={canRelease}
                            payments={payments}
                            verifying={verify.isPending}
                            releasing={release.isPending}
                            verifyingBank={verifyBank.isPending}
                            onVerify={(checks) => verify.mutate({ payoutId: p.id, ...checks })}
                            onRelease={(payment) => release.mutate({ payoutId: p.id, ...payment })}
                            onVerifyBank={p.bankAccountId != null ? () => verifyBank.mutate({ bankAccountId: p.bankAccountId! }) : undefined}
                            markingBank={markBankVerified.isPending}
                            onMarkBankVerified={
                              p.bankAccountId != null
                                ? (note) => markBankVerified.mutate({ bankAccountId: p.bankAccountId!, note })
                                : undefined
                            }
                            onRevealAccount={
                              isSuperAdmin && p.bankAccountId != null
                                ? () => revealAccount.mutateAsync({ bankAccountId: p.bankAccountId! })
                                : undefined
                            }
                            onHold={() => setReasonFor({ payout: p, kind: "hold" })}
                            onSendBack={() => setReasonFor({ payout: p, kind: "sendBack" })}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </DashboardCard>
      ) : (
        <DashboardCard
          title="Released Payments"
          bodyClassName="p-0"
          headerRight={
            <div className="flex items-center gap-3">
              <div className="w-52">
                <input
                  value={doneSearch}
                  onChange={(e) => setDoneSearch(e.target.value)}
                  placeholder="Search payouts..."
                  className="h-9 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]"
                />
              </div>
              <Button variant="secondary" className="!h-9 !text-[13px]" onClick={exportCompleted}>Export CSV</Button>
            </div>
          }
        >
          {completedQ.isLoading ? (
            <SkeletonTable rows={3} cols={7} />
          ) : completed.length === 0 ? (
            <EmptyState label={allCompleted.length === 0 ? "No completed payments. Released payments appear here with a full audit trail." : "No payouts match your search."} />
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} w-8`}></th>
                  <th className={TH}>Partner</th>
                  <th className={TH}>Invoice #</th>
                  <th className={TH}>Amount (₹)</th>
                  <th className={TH}>Payment Method</th>
                  <th className={TH}>Reference #</th>
                  <th className={TH}>Payment Date</th>
                  <th className={TH}>Released By</th>
                </tr>
              </thead>
              <tbody>
                {completed.map((p) => (
                  <Fragment key={p.id}>
                    <tr className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
                      <td className={`${TD} w-8`}>
                        <button onClick={() => toggle(p.id, true)}>
                          <svg viewBox="0 0 24 24" className={`h-4 w-4 text-[#667085] transition-transform ${doneExpanded.has(p.id) ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                        </button>
                      </td>
                      <td className={`${TD} font-medium text-[#101828]`}>{p.partner}</td>
                      <td className={`${TD} font-mono text-[13px]`}>{p.invoiceNumber}</td>
                      <td className={`${TD} font-semibold text-[#101828]`}>{inr(p.amountInr)}</td>
                      <td className={TD}>{p.method == null ? "—" : PayoutMethodLabel[p.method as 0 | 1 | 2 | 3 | 4]}</td>
                      <td className={TD}>{p.reference ?? "—"}</td>
                      <td className={TD}>{p.paymentDate ? formatDate(p.paymentDate) : "—"}</td>
                      <td className={TD}>{p.releasedBy ?? "—"}</td>
                    </tr>
                    {doneExpanded.has(p.id) && (
                      <tr className="bg-[#F9FAFB]">
                        <td colSpan={8} className="px-4 py-4"><AuditTrail p={p} /></td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </DashboardCard>
      )}

      {reasonFor && (
        <ReasonModal
          title={reasonFor.kind === "hold" ? `Put Payout On Hold — ${reasonFor.payout.invoiceNumber}` : `Send Back to Finance — ${reasonFor.payout.invoiceNumber}`}
          fieldLabel={reasonFor.kind === "hold" ? "Hold Reason" : "Reason for Returning"}
          placeholder={reasonFor.kind === "hold" ? "Explain why this payout is being placed on hold..." : "Explain what needs to be re-reviewed by finance..."}
          confirmLabel={reasonFor.kind === "hold" ? "Confirm Hold" : "Send Back"}
          saving={hold.isPending || sendBack.isPending}
          onClose={() => setReasonFor(null)}
          onSubmit={(reason) =>
            reasonFor.kind === "hold"
              ? hold.mutate({ payoutId: reasonFor.payout.id, reason })
              : sendBack.mutate({ payoutId: reasonFor.payout.id, reason })
          }
        />
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}

// ---- Verify panel -----------------------------------------------------------
function ReconPanel({
  payout,
  canVerify,
  canRelease,
  payments,
  verifying,
  releasing,
  verifyingBank,
  onVerify,
  onRelease,
  onVerifyBank,
  onHold,
  onSendBack,
  markingBank,
  onMarkBankVerified,
  onRevealAccount,
}: {
  payout: Payout;
  markingBank: boolean;
  onMarkBankVerified?: (note: string) => void;
  onRevealAccount?: () => Promise<{ accountNumber: string | null; iban: string | null; note: string | null }>;
  canVerify: boolean;
  canRelease: boolean;
  payments: { configured: boolean; mode: string | null };
  verifying: boolean;
  releasing: boolean;
  verifyingBank: boolean;
  onVerify: (checks: { bankConfirmed: boolean; invoiceVerified: boolean; commissionVerified: boolean; duplicateCheck: boolean }) => void;
  onRelease: (payment: { method: number; bankName?: string; accountNumber?: string; ifsc?: string; swift?: string; referenceNumber?: string; paymentDate: string; amountInr?: number; notes?: string }) => void;
  onVerifyBank?: () => void;
  onHold: () => void;
  onSendBack: () => void;
}) {
  const [bankConfirmed, setBankConfirmed] = useState(payout.checks.bankConfirmed);
  const [invoiceVerified, setInvoiceVerified] = useState(payout.checks.invoiceVerified);
  const [commissionVerified, setCommissionVerified] = useState(payout.checks.commissionVerified);
  const [duplicateCheck, setDuplicateCheck] = useState(payout.checks.duplicateCheck);

  const [method, setMethod] = useState<number>(PayoutMethod.NEFT);
  const [bankName, setBankName] = useState(payout.bank?.bankName ?? "");
  const [accountNumber, setAccountNumber] = useState(payout.bank?.last4 ? `****${payout.bank.last4}` : "");
  const [ifscSwift, setIfscSwift] = useState(payout.bank?.ifsc ?? "");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(todayInput());
  const [amount, setAmount] = useState(String(payout.amountInr));
  const [notes, setNotes] = useState("");
  const [verifyNote, setVerifyNote] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const readyToPay = payout.status === PayoutStatus.READY_TO_PAY;
  const isWire = method === PayoutMethod.INTERNATIONAL_WIRE;
  const checksDisabled = !canVerify || readyToPay;
  const allChecked = bankConfirmed && invoiceVerified && commissionVerified && duplicateCheck;

  const CHECKS: { key: string; label: string; v: boolean; set: (b: boolean) => void }[] = [
    { key: "bank", label: "University payment confirmed in bank statement", v: bankConfirmed, set: setBankConfirmed },
    { key: "inv", label: "Partner invoice details verified (GST/PAN/bank details)", v: invoiceVerified, set: setInvoiceVerified },
    { key: "comm", label: "Commission calculation verified", v: commissionVerified, set: setCommissionVerified },
    { key: "dup", label: "No duplicate payment check passed", v: duplicateCheck, set: setDuplicateCheck },
  ];

  // Pay via RazorpayX when it's configured, the bank account is verified, and the
  // method maps to a RazorpayX mode (international wire stays manual).
  const bankVerified = payout.bank?.verified ?? false;
  const payVia = payments.configured && bankVerified && !isWire;
  const doRelease = () => {
    if (!payVia && !reference.trim()) return setErr("Enter a Payment Reference # (or verify the bank to pay via RazorpayX).");
    if (!bankVerified) return setErr("Verify the partner's bank account first.");
    onRelease({
      method,
      bankName: bankName || undefined,
      accountNumber: accountNumber || undefined,
      ifsc: isWire ? undefined : ifscSwift || undefined,
      swift: isWire ? ifscSwift || undefined : undefined,
      referenceNumber: reference.trim() || undefined,
      paymentDate: date,
      amountInr: amount.trim() === "" ? undefined : Number(amount),
      notes: notes || undefined,
    });
  };

  return (
    <div className="space-y-3">
      {payout.status === PayoutStatus.ON_HOLD && payout.holdReason && (
        <div className="rounded-lg border border-[#FEC84B] bg-[#FFFAEB] px-3.5 py-2.5 text-sm text-[#B54708]"><span className="font-semibold">On Hold:</span> {payout.holdReason}</div>
      )}
      {payout.status === PayoutStatus.SENT_BACK && payout.sentBackReason && (
        <div className="rounded-lg border border-[#E4E7EC] bg-white px-3.5 py-2.5 text-sm text-[#667085]"><span className="font-semibold">Sent Back:</span> {payout.sentBackReason}</div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Verification checklist + partner details */}
        <div className="rounded-lg border border-[#E4E7EC] bg-white p-4">
          <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Verification Checklist</div>
          <div className="space-y-2.5">
            {CHECKS.map((c) => (
              <label key={c.key} className="flex cursor-pointer items-start gap-2 text-sm text-[#344054]">
                <input type="checkbox" className="mt-0.5" checked={c.v} disabled={checksDisabled} onChange={(e) => c.set(e.target.checked)} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="mt-3 border-t border-[#F2F4F7] pt-3">
            <div className="mb-1.5 text-xs font-semibold tracking-wide text-[#98A2B3] uppercase">Partner Details</div>
            <div className="space-y-1 text-xs text-[#667085]">
              {payout.students.map((st, i) => (
                <div key={i}>
                  <span className="font-medium text-[#344054]">{st.name}</span> · {st.university}
                  {st.intake ? ` (${st.intake})` : ""} · <span className="font-medium text-[#344054]">{st.rate}%</span>
                </div>
              ))}
              <div className="pt-0.5">GST: <span className="font-medium text-[#344054]">{payout.gstin ?? "—"}</span> · PAN: <span className="font-medium text-[#344054]">{payout.pan ?? "—"}</span></div>
            </div>
          </div>
          {payout.bank ? (
            <div className="mt-3 border-t border-[#F2F4F7] pt-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold tracking-wide text-[#98A2B3] uppercase">
                Bank Account · {payout.bank.region === "international" ? "International" : "Domestic"}
                {payout.bank.verified ? (
                  <span className="rounded-full bg-[#ECFDF3] px-2 py-0.5 text-[10px] font-bold text-[#067647] normal-case">✓ Verified</span>
                ) : (
                  <span className="rounded-full bg-[#FFF6ED] px-2 py-0.5 text-[10px] font-bold text-[#B54708] normal-case">Unverified</span>
                )}
              </div>
              <div className="space-y-0.5 text-xs text-[#667085]">
                <div>
                  <span className="font-medium text-[#344054]">{payout.bank.accountHolder}</span> ·{" "}
                  {revealed ?? `••••${payout.bank.last4 ?? "—"}`}
                  {onRevealAccount && !revealed && (
                    <button
                      type="button"
                      className="ml-1.5 font-semibold text-[#1570EF] hover:underline"
                      onClick={() =>
                        void onRevealAccount().then((r) =>
                          setRevealed(r.accountNumber ?? r.note ?? "Not available"),
                        )
                      }
                    >
                      Reveal
                    </button>
                  )}
                </div>
                <div>
                  {payout.bank.bankName ?? "—"}
                  {payout.bank.branch ? ` · ${payout.bank.branch}` : ""} ·{" "}
                  {payout.bank.region === "international"
                    ? `SWIFT ${payout.bank.swift ?? "—"}${payout.bank.ibanLast4 ? ` · IBAN ••••${payout.bank.ibanLast4}` : ""}`
                    : `IFSC ${payout.bank.ifsc ?? "—"}`}
                </div>
                {payout.bank.region === "international" && (
                  <div>
                    {payout.bank.bankCountry ?? "—"} · {payout.bank.bankAddress ?? "—"}
                  </div>
                )}
                <div>
                  {payout.bank.region === "international" ? "Bank letter" : "Cancelled cheque"}:{" "}
                  {payout.bank.proofUrl ? (
                    <a href={payout.bank.proofUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#1570EF] hover:underline">
                      {payout.bank.proofFileName ?? "View"}
                    </a>
                  ) : (
                    <span className="font-semibold text-[#B42318]">not uploaded — ask the partner to re-enter bank details</span>
                  )}
                </div>
                {payout.bank.verified && (
                  <div className="text-[#067647]">
                    Verified{payout.bank.verifiedBy ? ` by ${payout.bank.verifiedBy}` : ""}
                    {payout.bank.verifiedAt ? ` on ${new Date(payout.bank.verifiedAt).toLocaleDateString("en-IN")}` : ""}
                    {payout.bank.verificationNote ? ` — ${payout.bank.verificationNote}` : ""}
                  </div>
                )}
              </div>
              {!payout.bank.verified && canVerify && (
                <div className="mt-2.5 space-y-2 rounded-lg border border-[#FEDF89] bg-[#FFFCF5] p-2.5">
                  <p className="text-[11px] text-[#B54708]">
                    Check the {payout.bank.region === "international" ? "bank letter" : "cancelled cheque"} against the
                    holder name, account number and {payout.bank.region === "international" ? "SWIFT" : "IFSC"} above. Payment can&apos;t be released until the account is verified.
                  </p>
                  {onMarkBankVerified && payout.bank.proofUrl && (
                    <>
                      <input
                        value={verifyNote}
                        onChange={(e) => setVerifyNote(e.target.value)}
                        placeholder="How you verified it (e.g. cheque matches name, a/c and IFSC)"
                        className="h-8 w-full rounded-md border border-[#D0D5DD] px-2 text-xs outline-none focus:border-[#1570EF]"
                      />
                      <Button
                        className="!h-8 !text-[12px]"
                        disabled={verifyNote.trim().length < 5}
                        loading={markingBank}
                        onClick={() => onMarkBankVerified(verifyNote.trim())}
                      >
                        Mark bank verified
                      </Button>
                    </>
                  )}
                  {payout.bank.region === "domestic" && payments.configured && onVerifyBank && (
                    <Button variant="secondary" className="!h-8 !text-[12px]" loading={verifyingBank} onClick={onVerifyBank}>
                      Or verify via RazorpayX (₹1 penny-drop)
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3 border-t border-[#F2F4F7] pt-3 text-xs font-semibold text-[#B42318]">
              No bank account on this claim — payment can&apos;t be released.
            </div>
          )}
          {!readyToPay && canVerify && (
            <>
              <Button className="!mt-3 !h-9 w-full !text-[13px]" disabled={!allChecked} loading={verifying} onClick={() => onVerify({ bankConfirmed, invoiceVerified, commissionVerified, duplicateCheck })}>
                Verify &amp; Ready to Pay
              </Button>
              {!allChecked && <p className="mt-1.5 text-center text-[11px] text-[#98A2B3]">Tick all 4 checks to mark Ready to Pay.</p>}
            </>
          )}
          {readyToPay && <div className="mt-3 rounded-md bg-[#ECFDF3] px-3 py-2 text-xs font-semibold text-[#067647]">✓ Verified — ready to release</div>}
        </div>

        {/* Payment instructions */}
        <div className="rounded-lg border border-[#E4E7EC] bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold tracking-wide text-[#667085] uppercase">Payment Instructions</span>
            {payments.configured ? (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${payments.mode === "live" ? "bg-[#FEF3F2] text-[#B42318]" : "bg-[#EFF8FF] text-[#1570EF]"}`}>RazorpayX · {payments.mode}</span>
            ) : (
              <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 text-[10px] font-semibold text-[#667085]">manual</span>
            )}
          </div>
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[#344054]">Payment Method</label>
              <div className="flex gap-2">
                {METHOD_RADIO.map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={!canRelease && readyToPay ? false : !canVerify}
                    onClick={() => setMethod(m)}
                    className={`flex-1 rounded-lg border px-2 py-2 text-[13px] font-semibold transition ${
                      method === m ? "border-[#1570EF] bg-[#EFF8FF] text-[#1570EF]" : "border-[#D0D5DD] text-[#344054] hover:bg-[#F9FAFB]"
                    }`}
                  >
                    {PayoutMethodLabel[m]}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-3">
              <FormInput label="Bank Name" value={bankName} onChange={(e) => setBankName(e.target.value)} />
              <FormInput label="Account Number" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
            </div>
            <div className="flex gap-3">
              <FormInput label={isWire ? "SWIFT Code" : "IFSC Code"} value={ifscSwift} onChange={(e) => setIfscSwift(e.target.value)} />
              <FormInput label="Payment Reference #" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={payVia ? "Auto-filled by RazorpayX" : "Enter after payment"} />
            </div>
            <div className="flex gap-3">
              <FormInput label="Payment Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <FormInput label="Amount (₹)" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <FormTextarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {!readyToPay && (
            <div className="mt-3">
              <button disabled className="h-9 w-full cursor-not-allowed rounded-lg bg-[#EAECF0] text-[13px] font-semibold text-[#98A2B3]">Release Payment</button>
              <p className="mt-1.5 text-center text-[11px] text-[#98A2B3]">Complete the 4-point verification first.</p>
            </div>
          )}
          {readyToPay && canRelease && !bankVerified && (
            <div className="mt-3">
              <button disabled className="h-9 w-full cursor-not-allowed rounded-lg bg-[#EAECF0] text-[13px] font-semibold text-[#98A2B3]">Release Payment</button>
              <p className="mt-1.5 text-center text-[11px] text-[#B54708]">Verify the partner&apos;s bank account first (left).</p>
            </div>
          )}
          {readyToPay && canRelease && bankVerified && (
            <Button className="!mt-3 !h-9 w-full !text-[13px]" loading={releasing} onClick={doRelease}>{payVia ? `Pay via RazorpayX${payments.mode === "test" ? " (test)" : ""}` : "Release Payment"}</Button>
          )}
          {readyToPay && !canRelease && (
            <p className="mt-3 rounded-md bg-[#F9FAFB] px-3 py-2 text-center text-xs font-medium text-[#667085]">Awaiting Finance Manager to release payment</p>
          )}
          {err && <p className="mt-2 text-xs font-medium text-[#F04438]">{err}</p>}
          {canVerify && (
            <div className="mt-2 flex gap-3">
              <button className="text-[12px] font-semibold text-[#B54708] hover:underline" onClick={onHold}>Hold</button>
              <button className="text-[12px] font-semibold text-[#B42318] hover:underline" onClick={onSendBack}>Send Back to Finance</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Audit trail (completed expand) ----------------------------------------
function AuditTrail({ p }: { p: Completed }) {
  const dt = (d: Date | string | null) => (d ? formatDate(d) : "—");
  const yn = (b: boolean) => (b ? "Yes" : "No");
  const events: { title: string; by: string | null; at: Date | string | null; extra?: React.ReactNode }[] = [
    { title: "Invoice Submitted", by: p.partner, at: p.submittedAt },
    { title: "Approved", by: p.approvedBy, at: p.approvedAt },
    ...(p.verifiedBy
      ? [{
          title: "Verification Completed",
          by: p.verifiedBy,
          at: p.verifiedAt,
          extra: (
            <span>Bank confirmed: {yn(p.checks.bankConfirmed)} | Invoice verified: {yn(p.checks.invoiceVerified)} | Commission verified: {yn(p.checks.commissionVerified)} | Duplicate check: {yn(p.checks.duplicateCheck)}</span>
          ),
        }]
      : []),
    { title: "Payment Released", by: p.releasedBy, at: p.releasedAt, extra: p.reference ? <span>Ref: {p.reference}</span> : null },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* Timeline */}
      <div className="rounded-lg border border-[#E4E7EC] bg-white p-4">
        <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Audit Trail</div>
        <ol className="relative space-y-4 border-l border-[#E4E7EC] pl-4">
          {events.map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-[#1570EF] ring-2 ring-white" />
              <div className="text-sm font-semibold text-[#101828]">{e.title}</div>
              <div className="text-xs text-[#667085]">By {e.by ?? "—"} on {dt(e.at)}</div>
              {e.extra && <div className="mt-0.5 text-[11px] text-[#98A2B3]">{e.extra}</div>}
            </li>
          ))}
        </ol>
      </div>

      {/* Payment + invoice details */}
      <div className="rounded-lg border border-[#E4E7EC] bg-white p-4">
        <div className="mb-3 text-xs font-semibold tracking-wide text-[#667085] uppercase">Payment Details</div>
        <dl className="space-y-1 text-xs text-[#667085]">
          <Row k="Method" v={p.method == null ? "—" : PayoutMethodLabel[p.method as 0 | 1 | 2 | 3 | 4]} />
          <Row k="Bank" v={p.bankName ?? "—"} />
          <Row k="Account" v={p.accountLast4 ? `••••${p.accountLast4}` : "—"} />
          <Row k={p.swift ? "SWIFT" : "IFSC"} v={p.swift ?? p.ifsc ?? "—"} />
          <Row k="Reference" v={p.reference ?? "—"} />
          <Row k="Payment Date" v={p.paymentDate ? formatDate(p.paymentDate) : "—"} />
          <Row k="Amount" v={inr(p.amountInr)} />
          {p.notes && <Row k="Notes" v={p.notes} />}
        </dl>
        <div className="mt-3 border-t border-[#F2F4F7] pt-3">
          <div className="mb-1.5 text-xs font-semibold tracking-wide text-[#98A2B3] uppercase">Invoice Details</div>
          <div className="space-y-1 text-xs text-[#667085]">
            {p.students.map((st, i) => (
              <div key={i}>
                <span className="font-medium text-[#344054]">{st.name}</span> · {st.university}{st.intake ? ` (${st.intake})` : ""} · <span className="font-medium text-[#344054]">{st.rate}%</span>
              </div>
            ))}
            <div className="pt-0.5">GST: <span className="font-medium text-[#344054]">{p.gstin ?? "—"}</span> · PAN: <span className="font-medium text-[#344054]">{p.pan ?? "—"}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[#98A2B3]">{k}</dt>
      <dd className="text-right font-medium text-[#344054]">{v}</dd>
    </div>
  );
}

function ReasonModal({
  title,
  fieldLabel,
  placeholder,
  confirmLabel,
  saving,
  onClose,
  onSubmit,
}: {
  title: string;
  fieldLabel: string;
  placeholder: string;
  confirmLabel: string;
  saving: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => (reason.trim() ? onSubmit(reason.trim()) : setErr("A reason is required"))} loading={saving}>{confirmLabel}</Button>
        </>
      }
    >
      <FormTextarea label={fieldLabel} required value={reason} onChange={(e) => setReason(e.target.value)} error={!!err} errorMessage={err} placeholder={placeholder} />
    </Modal>
  );
}
