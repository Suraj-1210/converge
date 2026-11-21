"use client";

import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { LoanPageView } from "~/components/loans/loan-page";

// Super Admin: one partner's loan referral as the partner sees it (21 Nov
// 2026), read-only: progress, lenders, documents, the chat and the loan
// team's shared updates. Opened from Loan Referrals.

export default function AdminLoanReferralPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const q = api.loans.adminGet.useQuery({ publicId }, { retry: false, refetchInterval: 30_000 });

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
      backHref="/admin/loan-referrals"
      backLabel="Loan Referrals"
      studentHref={(id) => `/admin/students/${id}`}
      partnerName={q.data.partner}
      readOnly
    />
  );
}
