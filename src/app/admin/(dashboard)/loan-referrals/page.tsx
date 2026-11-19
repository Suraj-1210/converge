"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { SkeletonTable } from "~/components/dashboard/widgets";
import { formatDate } from "~/components/dashboard/format";
import { Toast } from "~/components/ui/toast";
import { LoanStatusBadge } from "~/components/loans/loan-ui";
import { LoanReferralSendStatus, LoanReferralSendStatusLabel } from "~/lib/loan-sharing";

// Super Admin support view of partner education-loan referrals to the
// Enrollment App (~/server/loan-sharing): whether each one reached the loan
// team, the last hand-over error, and a Retry. Loan work itself happens in the
// Enrollment App; this page is for when the hand-over doesn't land.

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold tracking-wider text-[#667085] uppercase";
const TD = "px-3.5 py-3 text-[13px] text-[#344054] align-top";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  ...Object.entries(LoanReferralSendStatusLabel).map(([value, label]) => ({ value, label })),
];

export default function LoanReferralsPage() {
  const [status, setStatus] = useState("");
  const q = api.loans.adminList.useQuery(
    { status: status === "" ? null : Number(status) },
    { retry: false },
  );
  const retry = api.loans.adminRetry.useMutation();
  const [toast, setToast] = useState("");

  const doRetry = async (id: number) => {
    try {
      const r = await retry.mutateAsync({ id });
      setToast(
        r.sendStatus === LoanReferralSendStatus.SENDING || r.sendStatus === LoanReferralSendStatus.FAILED
          ? `Still not received: ${r.lastError ?? "unknown error"}`
          : "Received by the Enrollment App.",
      );
      await q.refetch();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Retry failed");
    }
  };

  const config = q.data?.config;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Loan Referrals</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Education-loan leads partners referred to the loan team in the Enrollment App, and whether each one arrived.
          Loan counsellors work the leads in the Enrollment App.
        </p>
      </div>

      {config && (!config.sendConfigured || !config.receiveConfigured) && (
        <div className="mb-4 rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-3.5 text-sm text-[#B42318]">
          <span className="font-semibold">Loan sharing is not fully configured.</span>{" "}
          {!config.sendConfigured &&
            "ENROLLMENT_LOAN_URL / ENROLLMENT_LOAN_SECRET are unset: referrals are queued, not sent. "}
          {!config.receiveConfigured &&
            "ENROLLMENT_WEBHOOK_SECRET is unset: progress from the Enrollment App is refused."}
        </div>
      )}

      {q.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">{q.error.message}</div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-sm text-[#344054] outline-none hover:border-[#1570EF] focus:border-[#1570EF]"
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="ml-auto text-xs text-[#98A2B3]">{q.data?.rows.length ?? 0} referrals</span>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-[#E4E7EC] bg-white">
            {q.isLoading ? (
              <div className="p-4">
                <SkeletonTable rows={5} cols={6} />
              </div>
            ) : (
              <table className="w-full min-w-[1000px] border-collapse">
                <thead>
                  <tr>
                    <th className={TH}>Student</th>
                    <th className={TH}>Partner</th>
                    <th className={TH}>Status</th>
                    <th className={TH}>Hand-over</th>
                    <th className={TH}>Loan lead</th>
                    <th className={TH} />
                  </tr>
                </thead>
                <tbody>
                  {q.data?.rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-sm text-[#98A2B3]">
                        No loan referrals.
                      </td>
                    </tr>
                  ) : (
                    q.data?.rows.map((r) => {
                      const waiting =
                        r.sendStatus === LoanReferralSendStatus.SENDING || r.sendStatus === LoanReferralSendStatus.FAILED;
                      return (
                        <tr key={r.id} className="border-b border-[#F2F4F7] last:border-b-0">
                          <td className={TD}>
                            <div className="font-semibold text-[#101828]">{r.studentName}</div>
                            <div className="text-[11px] text-[#98A2B3]">
                              {r.loanOnly ? "Loan only" : "Converge student"} · {formatDate(r.referredAt)}
                            </div>
                          </td>
                          <td className={TD}>
                            <div>{r.partner}</div>
                            <div className="text-[11px] text-[#98A2B3]">by {r.referredBy}</div>
                          </td>
                          <td className={TD}>
                            <LoanStatusBadge sendStatus={r.sendStatus} stage={r.stage} />
                          </td>
                          <td className={TD}>
                            <div>
                              {r.attempts} {r.attempts === 1 ? "attempt" : "attempts"}
                            </div>
                            {waiting && r.lastError && (
                              <div className="mt-0.5 max-w-[320px] text-[12px] break-words text-[#B42318]">
                                {r.lastError}
                              </div>
                            )}
                            {r.sendStatus === LoanReferralSendStatus.SENDING && r.nextAttemptAt && (
                              <div className="text-[11px] text-[#98A2B3]">
                                Next try {new Date(r.nextAttemptAt).toLocaleString("en-IN")}
                              </div>
                            )}
                          </td>
                          <td className={`${TD} font-mono text-[12px]`}>{r.loanLeadId ?? "—"}</td>
                          <td className={`${TD} text-right`}>
                            {waiting && (
                              <button
                                type="button"
                                disabled={retry.isPending}
                                onClick={() => void doRetry(r.id)}
                                className="h-8 cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:opacity-50"
                              >
                                Retry
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
      <Toast message={toast} open={!!toast} onClose={() => setToast("")} />
    </>
  );
}
