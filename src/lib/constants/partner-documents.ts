// The partner (agency / institution / independent) KYC document slots, in one
// place so the signup form, the partner status page, admin uploads and emails
// agree on which documents are required. `document.doc_type` stores the slot
// key; the display names come from the label dictionary (partner-labels.ts).

import { partnerDocLabel } from "~/lib/constants/partner-labels";

// The account shape: an organization (agency or institution) or a person.
export type PartnerRole = "agency" | "independent";

// The sign-up category, which picks the document list. An institution (a
// school or college) files the same documents as an agency under the same
// keys; only the wording differs.
export type PartnerDocCategory = "agency" | "institution" | "independent";

export function partnerDocCategory(
  role: PartnerRole,
  orgKind: "agency" | "institution" | null | undefined,
): PartnerDocCategory {
  if (role === "independent") return "independent";
  return orgKind === "institution" ? "institution" : "agency";
}

export interface PartnerDocSlot {
  key: string;
  label: string;
  // Stored against the organization (company docs) rather than the person.
  orgDoc: boolean;
  // Required for this category; `gst` is required only for a GST-registered
  // organization. Sign-up records every Indian agency / institution as
  // GST-registered (its GSTIN is mandatory, 16 Nov 2026), so for new partners
  // this means "required in India". Older agencies that answered "No" keep it
  // optional: they are not made to re-file.
  required: (ctx: { gstRegistered: boolean | null }) => boolean;
  // Collected by the sign-up form. Sign-up is registration and KYC only.
  atSignup: boolean;
}

const always = () => true;
const never = () => false;
const gstRegistered = (c: { gstRegistered: boolean | null }) => c.gstRegistered === true;

function orgSlots(category: "agency" | "institution"): PartnerDocSlot[] {
  const label = (key: string) => partnerDocLabel(key, category);
  return [
    { key: "companyPan", label: label("companyPan"), orgDoc: true, required: always, atSignup: true },
    { key: "aadhaar", label: label("aadhaar"), orgDoc: false, required: always, atSignup: true },
    { key: "partnershipDocs", label: label("partnershipDocs"), orgDoc: true, required: always, atSignup: true },
    { key: "gst", label: label("gst"), orgDoc: true, required: gstRegistered, atSignup: true },
    { key: "logo", label: label("logo"), orgDoc: true, required: never, atSignup: true },
    { key: "cancelledCheque", label: label("cancelledCheque"), orgDoc: true, required: never, atSignup: false },
  ];
}

// The cancelled cheque is no longer collected at sign-up: banking (account
// details plus the cheque or bank letter) is set up after approval in
// My Account → Financial Details, which payouts require. The slot stays so
// cheques uploaded at sign-up before this change still show by name.
export const PARTNER_DOC_SLOTS: Record<PartnerDocCategory, PartnerDocSlot[]> = {
  agency: orgSlots("agency"),
  institution: orgSlots("institution"),
  independent: [
    { key: "pan", label: partnerDocLabel("pan", "independent"), orgDoc: false, required: always, atSignup: true },
    { key: "aadhaar", label: partnerDocLabel("aadhaar", "independent"), orgDoc: false, required: always, atSignup: true },
    { key: "profilePhoto", label: partnerDocLabel("profilePhoto", "independent"), orgDoc: false, required: never, atSignup: true },
    { key: "cancelledCheque", label: partnerDocLabel("cancelledCheque", "independent"), orgDoc: false, required: never, atSignup: false },
  ],
};
