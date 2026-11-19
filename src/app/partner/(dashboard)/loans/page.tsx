"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type RouterOutputs } from "~/trpc/react";
import { SkeletonTable } from "~/components/dashboard/widgets";
import { formatDate } from "~/components/dashboard/format";
import { Button } from "~/components/ui/button";
import { LoanStatusBadge, ReferLoanModal } from "~/components/loans/loan-ui";
import { LOAN_FINAL_STAGES, LoanReferralSendStatus, loanStageLabel, type LoanStage } from "~/lib/loan-sharing";
import { useUrlState } from "~/lib/url-state";

// Education-loan referrals to Collegepond's loan team and where each stands
// (Loans tab, 19 Nov 2026). The loan counsellors work the leads in the
// Enrollment App; their progress arrives here automatically. Scoped like
// students: owner = whole agency, agency counsellor = theirs, independent = own.

type Row = RouterOutputs["loans"]["partnerList"][number];

const TH = "px-4 py-3 text-xs font-semibold whitespace-nowrap text-[#667085]";
const TD = "px-4 py-3 text-[13px] text-[#344054]";

const FILTERS: { id: string; label: string; test: (r: Row) => boolean }[] = [
  {
    id: "active",
    label: "In progress",
    test: (r) =>
      r.sendStatus === LoanReferralSendStatus.SENDING ||
      (r.sendStatus === LoanReferralSendStatus.RECEIVED && !LOAN_FINAL_STAGES.includes(r.stage as LoanStage)),
  },
  { id: "sanctioned", label: "Sanctioned", test: (r) => r.stage === "sanctioned" || r.stage === "pf_paid" },
  { id: "disbursed", label: "Disbursed", test: (r) => r.stage === "disbursed" },
  {
    id: "ended",
    label: "Declined / closed",
    test: (r) => r.stage === "declined" || r.stage === "closed",
  },
  {
    id: "other",
    label: "Already with Collegepond / not sent",
    test: (r) =>
      r.sendStatus === LoanReferralSendStatus.DUPLICATE || r.sendStatus === LoanReferralSendStatus.FAILED,
  },
];

// The furthest a lender application has got, for the list.
const LENDER_ORDER = ["disbursed", "pf_paid", "sanctioned", "credit_review", "document_collection"];
function bestLender(r: Row): string | null {
  const best = [...r.lenders].sort(
    (a, b) => (LENDER_ORDER.indexOf(a.status) + 1 || 99) - (LENDER_ORDER.indexOf(b.status) + 1 || 99),
  )[0];
  if (!best) return null;
  return `${best.lender}: ${loanStageLabel(best.status)}${r.lenders.length > 1 ? ` (+${r.lenders.length - 1})` : ""}`;
}

export default function PartnerLoansPage() {
  const router = useRouter();
  const me = api.auth.me.useQuery(undefined, { retry: false });
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/partner/dashboard") router.replace(target);
  }, [me.data?.redirectUrl, router]);

  const list = api.loans.partnerList.useQuery(undefined, { retry: false });
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const [f, setF] = useUrlState({ q: "", filter: "" });
  const [referOpen, setReferOpen] = useState(false);
  const showReferrer = me.data?.kind === "agency";

  const searched = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.studentName} ${r.counsellorName ?? ""} ${r.referredBy} ${r.lenders.map((l) => l.lender).join(" ")}`
        .toLowerCase()
        .includes(q),
    );
  }, [rows, f.q]);
  const shown = useMemo(() => {
    const filter = FILTERS.find((x) => x.id === f.filter);
    return filter ? searched.filter(filter.test) : searched;
  }, [searched, f.filter]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Loans</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Students you referred to Collegepond&apos;s education-loan team, and every step the loan counsellor takes.
          </p>
        </div>
        <Button onClick={() => setReferOpen(true)}>Refer a loan lead</Button>
      </div>

      {list.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
          {list.error.message}
        </div>
      ) : (
        <>
          <div className="mb-4 rounded-2xl border border-[#E4E7EC] bg-white p-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex h-[38px] min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-[#D0D5DD] px-3 focus-within:border-[#1570EF] md:max-w-[340px]">
                <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} className="h-4 w-4 shrink-0 stroke-[#98A2B3]">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  value={f.q}
                  onChange={(e) => setF({ q: e.target.value })}
                  placeholder="Search student, counsellor or lender"
                  className="w-full border-none bg-transparent text-sm text-[#101828] outline-none placeholder:text-[#98A2B3]"
                />
              </div>
              <select
                aria-label="Status"
                value={f.filter}
                onChange={(e) => setF({ filter: e.target.value })}
                className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-sm text-[#344054] outline-none hover:border-[#1570EF] focus:border-[#1570EF]"
              >
                <option value="">All ({searched.length})</option>
                {FILTERS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label} ({searched.filter(x.test).length})
                  </option>
                ))}
              </select>
              <span className="ml-auto text-xs text-[#98A2B3]">
                {shown.length} {shown.length === 1 ? "referral" : "referrals"}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-[#E4E7EC] bg-white">
            {list.isLoading ? (
              <div className="p-4">
                <SkeletonTable rows={5} cols={6} />
              </div>
            ) : (
              <table className="w-full min-w-[900px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-[#E4E7EC] bg-[#F9FAFB]">
                    <th className={TH}>Student</th>
                    {showReferrer && <th className={TH}>Referred by</th>}
                    <th className={TH}>Status</th>
                    <th className={TH}>Lender</th>
                    <th className={TH}>Loan counsellor</th>
                    <th className={TH}>Last update</th>
                    <th className={TH}>Next follow-up</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr>
                      <td colSpan={showReferrer ? 7 : 6} className="px-4 py-12 text-center text-sm text-[#98A2B3]">
                        {rows.length === 0
                          ? "No loan referrals yet. Answer Yes to the education-loan question when adding a student, or use Refer a loan lead."
                          : "No referrals match these filters."}
                      </td>
                    </tr>
                  ) : (
                    shown.map((r) => (
                      <tr
                        key={r.publicId}
                        onClick={() => router.push(`/partner/loans/${r.publicId}`)}
                        className="cursor-pointer border-b border-[#F2F4F7] transition-colors last:border-b-0 hover:bg-[#F9FAFB]"
                      >
                        <td className={`${TD} min-w-[190px]`}>
                          <div className="font-semibold text-[#101828]">{r.studentName}</div>
                          <div className="text-[11px] text-[#98A2B3]">
                            {r.studentId ? `CP-${r.studentId}` : "Loan only"} · referred {formatDate(r.referredAt)}
                          </div>
                        </td>
                        {showReferrer && <td className={TD}>{r.referredBy}</td>}
                        <td className={TD}>
                          <LoanStatusBadge sendStatus={r.sendStatus} stage={r.stage} />
                        </td>
                        <td className={TD}>{bestLender(r) ?? <span className="text-[#98A2B3]">—</span>}</td>
                        <td className={TD}>{r.counsellorName ?? <span className="text-[#98A2B3]">—</span>}</td>
                        <td className={`${TD} whitespace-nowrap`}>
                          {r.lastUpdateAt ? formatDate(r.lastUpdateAt) : <span className="text-[#98A2B3]">—</span>}
                        </td>
                        <td className={`${TD} whitespace-nowrap`}>
                          {r.nextFollowUpAt ? formatDate(r.nextFollowUpAt) : <span className="text-[#98A2B3]">—</span>}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <ReferLoanModal
        open={referOpen}
        onClose={() => setReferOpen(false)}
        onReferred={(r) => router.push(`/partner/loans/${r.publicId}`)}
      />
    </>
  );
}
