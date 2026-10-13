// The partner (agency / independent) KYC document slots, in one place so the
// signup form, the partner status page, admin uploads and emails agree on
// which documents are required. `document.doc_type` stores the slot key; the
// display names come from the label dictionary (partner-labels.ts).

import { partnerDocLabel } from "~/lib/constants/partner-labels";

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
    { key: "companyPan", label: partnerDocLabel("companyPan", "agency"), orgDoc: true, required: always, atSignup: true },
    { key: "aadhaar", label: partnerDocLabel("aadhaar", "agency"), orgDoc: false, required: always, atSignup: true },
    { key: "partnershipDocs", label: partnerDocLabel("partnershipDocs", "agency"), orgDoc: true, required: always, atSignup: true },
    { key: "gst", label: partnerDocLabel("gst", "agency"), orgDoc: true, required: (c) => c.gstRegistered === true, atSignup: true },
    { key: "logo", label: partnerDocLabel("logo", "agency"), orgDoc: true, required: never, atSignup: true },
    { key: "cancelledCheque", label: partnerDocLabel("cancelledCheque", "agency"), orgDoc: true, required: never, atSignup: false },
  ],
  independent: [
    { key: "pan", label: partnerDocLabel("pan", "independent"), orgDoc: false, required: always, atSignup: true },
    { key: "aadhaar", label: partnerDocLabel("aadhaar", "independent"), orgDoc: false, required: always, atSignup: true },
    { key: "profilePhoto", label: partnerDocLabel("profilePhoto", "independent"), orgDoc: false, required: never, atSignup: true },
    { key: "cancelledCheque", label: partnerDocLabel("cancelledCheque", "independent"), orgDoc: false, required: never, atSignup: false },
  ],
};
