"use client";

import { api } from "~/trpc/react";
import { DashboardCard } from "~/components/dashboard/widgets";

// The partner's side of Finance › Adjustments (16 Nov 2026). Every approved
// adjustment on their account, labelled "Adjustment" with Collegepond's note
// and its Adjustment Note (PDF), what has been recovered / paid so far and
// what's left. Never the reason category, Finance's internal note or the
// evidence (the server doesn't send them). Plus a notice while payouts are
// paused (payout hold), without the reason.

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054] align-top";
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

export function PayoutsPausedBanner() {
  const q = api.partnerCommission.adjustments.useQuery();
  if (!q.data?.payoutsPaused) return null;
  return (
    <div className="mb-5 rounded-xl border border-[#FECDCA] bg-[#FEF3F2] px-4 py-3 text-sm text-[#B42318]">
      <span className="font-semibold">Payouts are paused on your account.</span> You can still submit claims; they&apos;ll be paid once
      payouts resume. Our finance team will be in touch, or reply to any Collegepond email if you have questions.
    </div>
  );
}

// For the claim wizard: what will be netted when this claim is paid.
export function ClaimAdjustmentNotice() {
  const q = api.partnerCommission.adjustments.useQuery();
  const d = q.data;
  if (!d || (d.toRecoverInr <= 0 && d.toAddInr <= 0 && !d.payoutsPaused)) return null;
  return (
    <p className="mt-3 rounded-lg bg-[#FFFAEB] px-3 py-2 text-[11px] text-[#B54708]">
      {d.toRecoverInr > 0 && (
        <>
          You have adjustments of {inr(d.toRecoverInr)} on your account. Invoice the full amount as usual: the adjustment is deducted when
          Collegepond pays this claim (anything this payout doesn&apos;t cover carries forward).{" "}
        </>
      )}
      {d.toAddInr > 0 && <>A credit of {inr(d.toAddInr)} will be added to the payment. </>}
      {d.payoutsPaused && <>Payouts are currently paused on your account; this claim will be paid once they resume.</>}
    </p>
  );
}

export function AdjustmentsCard() {
  const q = api.partnerCommission.adjustments.useQuery();
  const d = q.data;
  if (!d || d.items.length === 0) return null;
  return (
    <DashboardCard title="Adjustments" bodyClassName="p-0">
      <p className="px-4 pt-3 text-sm text-[#667085]">
        Adjustments made by Collegepond to your commission account. A deduction is taken from your next payout (any balance carries
        forward); a credit is added to it.
        {d.toRecoverInr > 0 && <span className="font-semibold text-[#B42318]"> Still to be deducted: {inr(d.toRecoverInr)}.</span>}
        {d.toAddInr > 0 && <span className="font-semibold text-[#027A48]"> Still to be added: {inr(d.toAddInr)}.</span>}
      </p>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full min-w-[760px] border-collapse">
          <thead>
            <tr>
              <th className={TH}>Date</th>
              <th className={TH}>Description</th>
              <th className={`${TH} text-right`}>Amount</th>
              <th className={`${TH} text-right`}>Applied</th>
              <th className={`${TH} text-right`}>Balance</th>
              <th className={TH}>Adjustment Note</th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((a) => (
              <tr key={a.id} className="border-b border-[#F2F4F7] last:border-0">
                <td className={TD}>{fmtDate(a.date)}</td>
                <td className={TD}>
                  <span className="font-medium text-[#101828]">{a.label}</span>
                  {a.student && <span className="text-[#667085]"> · {a.student}</span>}
                  {a.note && <span className="block text-xs text-[#667085]">{a.note}</span>}
                  {a.appliedTo.map((x, i) => (
                    <span key={i} className="block text-[11px] text-[#98A2B3]">
                      {inr(x.amountInr)} {a.kind === "deduction" ? "deducted from" : "added to"} the payment for {x.claim ?? "a claim"}
                      {x.date ? ` (${fmtDate(x.date)})` : ""}
                    </span>
                  ))}
                </td>
                <td className={`${TD} text-right font-semibold ${a.kind === "deduction" ? "text-[#B42318]" : "text-[#027A48]"}`}>
                  {a.kind === "deduction" ? "−" : "+"}{inr(a.amountInr)}
                </td>
                <td className={`${TD} text-right`}>{inr(a.appliedInr)}</td>
                <td className={`${TD} text-right font-semibold`}>{inr(a.balanceInr)}</td>
                <td className={TD}>
                  {a.noteNumber ? (
                    <a className="font-medium text-[#1570EF] hover:underline" href={`/api/adjustment-note/${a.id}?download=1`}>
                      {a.noteNumber}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}
