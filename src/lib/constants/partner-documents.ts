// The partner (agency / independent) KYC document slots, in one place so the
// signup form, the partner status page, admin uploads and emails agree on
// names and on which documents are required. `document.doc_type` stores the
// slot key.

export type PartnerRole = "agency" | "independent";

export interface PartnerDocSlot {
  key: string;
  label: string;
  // Stored against the organization (company docs) rather than the person.
  orgDoc: boolean;
  // Required for this role; `gst` is required only for a GST-registered agency.
  required: (ctx: { gstRegistered: boolean | null }) => boolean;
}

const always = () => true;
const never = () => false;

export const PARTNER_DOC_SLOTS: Record<PartnerRole, PartnerDocSlot[]> = {
  agency: [
    { key: "companyPan", label: "Company PAN Card", orgDoc: true, required: always },
    { key: "aadhaar", label: "Aadhaar Card of Director", orgDoc: false, required: always },
    { key: "cancelledCheque", label: "Cancelled Cheque", orgDoc: true, required: always },
    { key: "partnershipDocs", label: "Company / Partnership Documents", orgDoc: true, required: always },
    { key: "gst", label: "GST Certificate", orgDoc: true, required: (c) => c.gstRegistered === true },
    { key: "logo", label: "Company Logo", orgDoc: true, required: never },
  ],
  independent: [
    { key: "pan", label: "PAN Card", orgDoc: false, required: always },
    { key: "aadhaar", label: "Aadhaar Card", orgDoc: false, required: always },
    { key: "cancelledCheque", label: "Cancelled Cheque", orgDoc: false, required: always },
    { key: "profilePhoto", label: "Profile Photo", orgDoc: false, required: never },
  ],
};

// Any slot key → a label a partner recognises (falls back to the key).
export function partnerDocLabel(key: string): string {
  for (const slots of Object.values(PARTNER_DOC_SLOTS)) {
    const hit = slots.find((s) => s.key === key);
    if (hit) return hit.label;
  }
  return key;
}
