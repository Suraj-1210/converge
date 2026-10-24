import { db } from "~/server/db";

// application.counsellor_vendor stores the vendor's name; a direct university
// contract (commission_contract.vendor_id NULL) is stored as this.
export const DIRECT_VENDOR = "Direct";

// The university's default commission source (Commission Rates →
// is_default), used to prefill a new application's Counsellor Choice. Null
// when the university has no default contract.
export async function defaultVendorFor(
  universityId: number,
): Promise<{ name: string; contractId: number } | null> {
  const contract = await db.commission_contract.findFirst({
    where: { university_id: universityId, is_default: 1 },
    select: { id: true, vendor: { select: { name: true } } },
  });
  if (!contract) return null;
  return { name: contract.vendor?.name ?? DIRECT_VENDOR, contractId: contract.id };
}

// The contract behind a Counsellor Choice name for this university, if any.
export async function contractForVendor(
  universityId: number,
  vendorName: string,
): Promise<number | null> {
  const contract = await db.commission_contract.findFirst({
    where:
      vendorName === DIRECT_VENDOR
        ? { university_id: universityId, vendor_id: null }
        : { university_id: universityId, vendor: { name: vendorName } },
    select: { id: true },
  });
  return contract?.id ?? null;
}
