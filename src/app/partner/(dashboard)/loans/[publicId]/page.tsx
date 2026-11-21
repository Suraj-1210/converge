"use client";

import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { LoanPageView } from "~/components/loans/loan-page";

// One loan referral: where it stands, each lender application, and the
// conversation — everything the loan team has done (stage changes, lender
// results, notes they share) and the partner's own replies and PDFs. The loan
// counsellors work the lead in the Enrollment App; it updates here by itself.
// The page itself: ~/components/loans/loan-page (shared with the Super Admin view).

export default function PartnerLoanPage() {
  const { publicId } = useParams<{ publicId: string }>();
  // Refreshes every 20 s so the loan team's chat replies and updates appear.
  const q = api.loans.partnerGet.useQuery({ publicId }, { retry: false, refetchInterval: 20_000 });

  if (q.error) {
    return (
      <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
        {q.error.message}
      </div>
    );
  }
  if (!q.data) return <div className="h-40 animate-pulse rounded-2xl bg-[#F2F4F7]" />;
  return (
    <LoanPageView
      loan={q.data}
      onChanged={() => void q.refetch()}
      backHref="/partner/loans"
      backLabel="Loans"
      studentHref={(id) => `/partner/students/${id}`}
    />
  );
}
