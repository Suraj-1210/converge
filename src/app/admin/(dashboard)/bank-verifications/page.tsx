"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Toast } from "~/components/ui/toast";
import { DashboardCard, EmptyState, SkeletonTable } from "~/components/dashboard/widgets";
import {
  BankAccountDetails,
  BankDecisionControls,
  BankStatusPill,
} from "~/components/admin/bank-account-review";
import { AdminRole } from "~/server/db/enums";

// Bank Verifications: every partner whose bank details are new or changed and
// not yet verified, oldest first, so finance checks them as soon as they are
// saved rather than when a payout is already waiting. Verify (by hand or via
// RazorpayX) or reject with a reason; the partner is notified either way.
// Super Admin, Finance Manager, Finance Executive (financeProcedure).

type Row = RouterOutputs["bankVerification"]["list"][number];
type Tab = "pending" | "rejected" | "verified";

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054] align-top";

const fmt = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const daysAgo = (d: Date | string) => {
  const n = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  return n <= 0 ? "today" : n === 1 ? "1 day ago" : `${n} days ago`;
};

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 text-[#667085] transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export default function BankVerificationsPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const canVerify =
    role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER || role === AdminRole.FINANCE_EXECUTIVE;
  const isSuperAdmin = role === AdminRole.SUPER_ADMIN;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [tab, setTab] = useState<Tab>("pending");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  const countsQ = api.bankVerification.counts.useQuery(undefined, { enabled: canVerify });
  const listQ = api.bankVerification.list.useQuery({ status: tab }, { enabled: canVerify });
  const paymentsQ = api.reconciliation.paymentsConfig.useQuery(undefined, { enabled: canVerify });
  const razorpay = paymentsQ.data?.configured ?? false;

  const rows = useMemo(() => {
    const all = listQ.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.partner, r.owner, r.ownerEmail, r.accountHolder, r.bankName, r.last4, r.ifsc, r.swift]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [listQ.data, search]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!mounted || meQ.isLoading) {
    return (
      <DashboardCard title="Bank Verifications" bodyClassName="p-0">
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
            Bank verification is available to Finance Managers, Finance Executives, and Super Admins only.
          </p>
        </div>
      </div>
    );
  }

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: "pending", label: "Awaiting verification", count: countsQ.data?.pending },
    { id: "rejected", label: "Rejected", count: countsQ.data?.rejected },
    { id: "verified", label: "Verified" },
  ];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#101828]">Bank Verifications</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Partners&apos; new or changed bank details, oldest first. Check each against its cancelled cheque or bank letter;
          no payout is released to an unverified account.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap gap-2 border-b border-[#E4E7EC]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setExpanded(new Set()); }}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-semibold transition ${
              tab === t.id ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"
            }`}
          >
            {t.label}
            {t.count != null && (
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      <DashboardCard
        title={tab === "pending" ? "Awaiting verification" : tab === "rejected" ? "Rejected — waiting for the partner" : "Recently verified"}
        bodyClassName="p-0"
        headerRight={
          <div className="w-60 max-w-full">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search partner, bank, last 4…"
              className="h-9 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]"
            />
          </div>
        }
      >
        {listQ.isLoading ? (
          <SkeletonTable rows={4} cols={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            label={
              (listQ.data?.length ?? 0) > 0
                ? "No bank accounts match your search."
                : tab === "pending"
                  ? "All caught up. No bank details are waiting for verification."
                  : tab === "rejected"
                    ? "No rejected bank details."
                    : "No verified bank accounts yet."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} w-8`}></th>
                  <th className={TH}>Partner</th>
                  <th className={TH}>Account</th>
                  <th className={TH}>Bank</th>
                  <th className={TH}>{tab === "pending" ? "Submitted" : tab === "rejected" ? "Rejected" : "Verified"}</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} text-right`}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <QueueRow row={r} tab={tab} open={expanded.has(r.id)} onToggle={() => toggle(r.id)} />
                    {expanded.has(r.id) && (
                      <tr className="bg-[#F9FAFB]">
                        <td colSpan={7} className="px-4 py-4">
                          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
                            <div className="rounded-lg border border-[#E4E7EC] bg-white p-4">
                              <BankAccountDetails bank={r} canReveal={isSuperAdmin} />
                            </div>
                            <div className="space-y-3">
                              <div className="rounded-lg border border-[#E4E7EC] bg-white p-4 text-xs text-[#667085]">
                                <div className="mb-1 font-semibold tracking-wide text-[#98A2B3] uppercase">Partner</div>
                                <div className="text-sm font-medium text-[#101828]">{r.partner}</div>
                                {r.owner && <div>{r.owner}{r.ownerEmail ? ` · ${r.ownerEmail}` : ""}</div>}
                                {r.payoutsWaiting > 0 && (
                                  <div className="mt-2 font-semibold text-[#B54708]">
                                    {r.payoutsWaiting} claim{r.payoutsWaiting === 1 ? "" : "s"} waiting to be paid into this account
                                  </div>
                                )}
                              </div>
                              <BankDecisionControls bank={r} razorpayConfigured={razorpay} onDone={setToast} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashboardCard>

      <Toast message={toast ?? ""} open={toast != null} onClose={() => setToast(null)} />
    </div>
  );
}

function QueueRow({ row: r, tab, open, onToggle }: { row: Row; tab: Tab; open: boolean; onToggle: () => void }) {
  const intl = r.region === "international";
  const when = tab === "pending" ? r.submittedAt : tab === "rejected" ? r.rejectedAt : r.verifiedAt;
  return (
    <tr className="cursor-pointer border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]" onClick={onToggle}>
      <td className={`${TD} w-8`}>
        <Chevron open={open} />
      </td>
      <td className={TD}>
        <div className="font-medium text-[#101828]">{r.partner}</div>
        {r.owner && <div className="text-xs text-[#98A2B3]">{r.owner}</div>}
      </td>
      <td className={TD}>
        <div className="font-medium text-[#101828]">{r.accountHolder}</div>
        <div className="text-xs text-[#667085]">
          {intl ? "International" : "Domestic"} · {r.last4 ? `••••${r.last4}` : "—"}
        </div>
        {tab === "pending" && r.submission && (
          <div className="text-[11px] font-semibold text-[#B54708]">
            {r.submission.kind === "changed"
              ? `Changed${r.submission.oldLast4 ? ` from ••••${r.submission.oldLast4}` : ""}`
              : "New"}
          </div>
        )}
      </td>
      <td className={TD}>
        <div>{r.bankName ?? "—"}</div>
        <div className="text-xs text-[#667085]">{intl ? `SWIFT ${r.swift ?? "—"}` : `IFSC ${r.ifsc ?? "—"}`}</div>
      </td>
      <td className={TD}>
        <div>{fmt(when)}</div>
        {tab === "pending" && <div className="text-xs text-[#98A2B3]">{daysAgo(r.submittedAt)}</div>}
        {tab === "rejected" && r.rejectedBy && <div className="text-xs text-[#98A2B3]">by {r.rejectedBy}</div>}
        {tab === "verified" && r.verifiedBy && <div className="text-xs text-[#98A2B3]">by {r.verifiedBy}</div>}
      </td>
      <td className={TD}>
        <BankStatusPill status={r.status} />
        {r.payoutsWaiting > 0 && r.status !== "verified" && (
          <div className="mt-1 text-[11px] font-semibold text-[#B54708]">Payout waiting</div>
        )}
        {tab === "rejected" && r.rejectionReason && (
          <div className="mt-1 max-w-[220px] truncate text-xs text-[#667085]" title={r.rejectionReason}>{r.rejectionReason}</div>
        )}
      </td>
      <td className={`${TD} text-right`}>
        <span className="text-[13px] font-semibold text-[#1570EF]">{tab === "pending" ? "Review" : "View"}</span>
      </td>
    </tr>
  );
}
