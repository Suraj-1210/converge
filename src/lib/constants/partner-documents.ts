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
  // Collected by the sign-up form. Sign-up is registration and KYC only.
  atSignup: boolean;
}

const always = () => true;
const never = () => false;

// The cancelled cheque is no longer collected at sign-up: banking (account
// details plus the cheque or bank letter) is set up after approval in
// My Account → Financial Details, which payouts require. The slot stays so
// cheques uploaded at sign-up before this change still show by name.
export const PARTNER_DOC_SLOTS: Record<PartnerRole, PartnerDocSlot[]> = {
  agency: [
    { key: "companyPan", label: "Company PAN Card", orgDoc: true, required: always, atSignup: true },
    { key: "aadhaar", label: "Aadhaar Card of Director", orgDoc: false, required: always, atSignup: true },
    { key: "partnershipDocs", label: "Company / Partnership Documents", orgDoc: true, required: always, atSignup: true },
    { key: "gst", label: "GST Certificate", orgDoc: true, required: (c) => c.gstRegistered === true, atSignup: true },
    { key: "logo", label: "Company Logo", orgDoc: true, required: never, atSignup: true },
    { key: "cancelledCheque", label: "Cancelled Cheque", orgDoc: true, required: never, atSignup: false },
  ],
  independent: [
    { key: "pan", label: "PAN Card", orgDoc: false, required: always, atSignup: true },
    { key: "aadhaar", label: "Aadhaar Card", orgDoc: false, required: always, atSignup: true },
    { key: "profilePhoto", label: "Profile Photo", orgDoc: false, required: never, atSignup: true },
    { key: "cancelledCheque", label: "Cancelled Cheque", orgDoc: false, required: never, atSignup: false },
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
