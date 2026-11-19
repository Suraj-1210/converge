"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { formatDate } from "~/components/dashboard/format";
import { LoanStatusBadge, LoanTrack, rupees } from "~/components/loans/loan-ui";
import { LoanReferralSendStatus, loanStageLabel } from "~/lib/loan-sharing";

// One loan referral: where it stands, each lender application, and the
// timeline of everything the loan team has done (stage changes, lender
// results). Read-only: the loan counsellors work the lead in the Enrollment
// App and it updates here by itself.

const dateTime = (d: Date | string) =>
  new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

export default function PartnerLoanPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const q = api.loans.partnerGet.useQuery({ publicId }, { retry: false });

  if (q.error) {
    return (
      <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
        {q.error.message}
      </div>
    );
  }
  if (!q.data) return <div className="h-40 animate-pulse rounded-2xl bg-[#F2F4F7]" />;
  const r = q.data;
  const received = r.sendStatus === LoanReferralSendStatus.RECEIVED;

  return (
    <>
      <Link href="/partner/loans" className="mb-3 inline-block text-sm font-medium text-[#1570EF] hover:underline">
        ← Loans
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">{r.studentName}</h1>
          <p className="mt-1 text-sm text-[#667085]">
            {r.studentId ? (
              <Link href={`/partner/students/${r.studentId}`} className="text-[#1570EF] hover:underline">
                CP-{r.studentId}
              </Link>
            ) : (
              "Loan-only referral"
            )}{" "}
            · Referred {formatDate(r.referredAt)} by {r.referredBy} · {r.intake}
          </p>
        </div>
        <LoanStatusBadge sendStatus={r.sendStatus} stage={r.stage} />
      </div>

      {r.sendStatus === LoanReferralSendStatus.SENDING && (
        <Notice tone="amber">
          The loan team hasn&apos;t received this referral yet. It is sent again automatically; nothing for you to do.
        </Notice>
      )}
      {r.sendStatus === LoanReferralSendStatus.DUPLICATE && (
        <Notice tone="gray">
          This student is already working with Collegepond&apos;s loan team, so progress isn&apos;t shared here.
        </Notice>
      )}
      {r.sendStatus === LoanReferralSendStatus.FAILED && (
        <Notice tone="red">
          This referral could not be sent. Check the student&apos;s details and refer them again, or contact
          Collegepond.
        </Notice>
      )}

      {received && (
        <div className="mb-4 rounded-2xl border border-[#E4E7EC] bg-white p-5">
          <LoanTrack stage={r.stage} />
          <div className="mt-5 grid grid-cols-2 gap-4 border-t border-[#F2F4F7] pt-4 md:grid-cols-4">
            <Fact label="Stage" value={loanStageLabel(r.stage)} />
            <Fact label="Loan counsellor" value={r.counsellorName ?? "Being assigned"} />
            <Fact label="Last update" value={r.lastUpdateAt ? formatDate(r.lastUpdateAt) : "—"} />
            <Fact label="Next follow-up" value={r.nextFollowUpAt ? formatDate(r.nextFollowUpAt) : "—"} />
          </div>
          {r.closureReason && (r.stage === "declined" || r.stage === "closed") && (
            <p className="mt-3 text-sm text-[#344054]">
              <span className="font-semibold">Reason:</span> {r.closureReason}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border border-[#E4E7EC] bg-white">
            <h2 className="border-b border-[#E4E7EC] px-5 py-3.5 text-sm font-semibold text-[#101828]">
              Lender applications
            </h2>
            {r.applications.length === 0 ? (
              <p className="px-5 py-6 text-sm text-[#98A2B3]">
                No lender applications yet. They appear here as the loan team files them.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-[#E4E7EC] bg-[#F9FAFB] text-xs text-[#667085]">
                      <th className="px-5 py-2.5 font-semibold">Lender</th>
                      <th className="px-3 py-2.5 font-semibold">Status</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Applied</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Sanctioned</th>
                      <th className="px-3 py-2.5 text-right font-semibold">ROI</th>
                      <th className="px-5 py-2.5 text-right font-semibold">Disbursed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.applications.map((a) => (
                      <tr key={a.id} className="border-b border-[#F2F4F7] last:border-b-0">
                        <td className="px-5 py-3 font-semibold text-[#101828]">{a.lender}</td>
                        <td className="px-3 py-3">
                          <LoanStatusBadge sendStatus={LoanReferralSendStatus.RECEIVED} stage={a.status} />
                        </td>
                        <td className="px-3 py-3 text-right">{rupees(a.loanAmount)}</td>
                        <td className="px-3 py-3 text-right">{rupees(a.sanctionedAmount)}</td>
                        <td className="px-3 py-3 text-right">{a.roi === null ? "—" : `${a.roi}%`}</td>
                        <td className="px-5 py-3 text-right">
                          {rupees(a.disbursedAmount)}
                          {a.disbursedAt && (
                            <div className="text-[11px] text-[#98A2B3]">{formatDate(a.disbursedAt)}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-[#E4E7EC] bg-white">
            <h2 className="border-b border-[#E4E7EC] px-5 py-3.5 text-sm font-semibold text-[#101828]">Timeline</h2>
            {r.timeline.length === 0 ? (
              <p className="px-5 py-6 text-sm text-[#98A2B3]">Nothing yet.</p>
            ) : (
              <ol className="px-5 py-4">
                {r.timeline.map((t, i) => (
                  <li key={t.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < r.timeline.length - 1 && (
                      <span className="absolute top-3 left-[5px] h-full w-px bg-[#E4E7EC]" aria-hidden />
                    )}
                    <span className="relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-[#1570EF] bg-white" />
                    <div>
                      <div className="text-[13px] font-semibold text-[#101828]">{t.title}</div>
                      {t.body && <div className="mt-0.5 text-[13px] text-[#475467]">{t.body}</div>}
                      <div className="mt-0.5 text-[11px] text-[#98A2B3]">
                        {dateTime(t.at)}
                        {t.actorName && ` · ${t.actorName}`}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="h-fit rounded-2xl border border-[#E4E7EC] bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold text-[#101828]">What you sent</h2>
          <dl className="flex flex-col gap-2.5 text-[13px]">
            <Row label="Email" value={r.email} />
            <Row label="Phone" value={r.phone} />
            <Row label="University" value={r.university ?? "—"} />
            <Row label="Loan amount" value={rupees(r.loanAmount)} />
            {r.note && <Row label="Note" value={r.note} />}
            <Row label="Consent" value={`Confirmed ${formatDate(r.consentAt)}`} />
          </dl>
        </aside>
      </div>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-wide text-[#98A2B3] uppercase">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-[#101828]">{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-[#98A2B3]">{label}</dt>
      <dd className="break-words text-[#344054]">{value}</dd>
    </div>
  );
}

function Notice({ tone, children }: { tone: "amber" | "gray" | "red"; children: React.ReactNode }) {
  const c = {
    amber: "border-[#FEDF89] bg-[#FFFAEB] text-[#B54708]",
    gray: "border-[#E4E7EC] bg-[#F9FAFB] text-[#475467]",
    red: "border-[#FECDCA] bg-[#FEF3F2] text-[#B42318]",
  }[tone];
  return <div className={`mb-4 rounded-lg border p-3.5 text-sm ${c}`}>{children}</div>;
}
