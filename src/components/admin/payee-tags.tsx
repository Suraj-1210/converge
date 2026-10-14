// Tags shown next to a partner's name on Finance screens (commissions, billing,
// partner invoices, reconciliation, bank verifications). Money for an
// independent counsellor is paid to them personally; a suspended or deleted
// independent can't be paid until reactivated (or Finance records a decision at
// release); an independent outside India may claim without a PAN, which
// Finance reviews.
export function PayeeTags({
  partnerType,
  payeeInactive,
  panReview,
}: {
  partnerType?: "agency" | "independent";
  payeeInactive?: "deleted" | "suspended" | null;
  panReview?: boolean;
}) {
  if (partnerType !== "independent") return null;
  const tag = "ml-1.5 inline-block rounded-[10px] px-2 py-0.5 align-middle text-[10px] font-semibold";
  return (
    <>
      <span className={`${tag} bg-[#F4F3FF] text-[#5925DC]`}>Independent</span>
      {payeeInactive && (
        <span
          className={`${tag} bg-[#FEF3F2] text-[#B42318]`}
          title="Can't claim or be paid until an admin reactivates them, or Finance records a decision at release."
        >
          {payeeInactive === "deleted" ? "Deleted" : "Suspended"} · payment blocked
        </span>
      )}
      {panReview && (
        <span
          className={`${tag} bg-[#FFFAEB] text-[#B54708]`}
          title="Independent outside India who claimed without a PAN. Review before paying."
        >
          No PAN · review
        </span>
      )}
    </>
  );
}
