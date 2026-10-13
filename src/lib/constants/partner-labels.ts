// The one place partner document types and profile fields get their display
// names. Wording matches the partner sign-up form (src/app/signup/page.tsx)
// exactly, so a partner sees the same name on sign-up, their account, the
// status page and emails, and an admin sees it on the review screens.
//
// Keys are the stored keys: `document.doc_type` for documents, and the
// Application / listing field names for fields. Keep an entry here even once a
// document stops being collected at sign-up (e.g. the cancelled cheque) —
// partners who already uploaded one still need it labelled.

import type { PartnerRole } from "~/lib/constants/partner-documents";

const CANCELLED_CHEQUE = "Cancelled Cheque";

export const PARTNER_DOC_LABELS: Record<string, string> = {
  companyPan: "Company PAN Card",
  pan: "PAN Card",
  aadhaar: "Aadhaar Card",
  cancelledCheque: CANCELLED_CHEQUE,
  partnershipDocs: "Company / Partnership Documents",
  gst: "GST Certificate",
  logo: "Company Logo",
  profilePhoto: "Profile Photo",
};

// Proof that goes with payout bank details: a cancelled cheque for an Indian
// (IFSC) account, a bank letter for an international one.
export const BANK_PROOF_LABELS = {
  domestic: CANCELLED_CHEQUE,
  international: "Bank Letter",
} as const;

// Where sign-up words a document differently for one partner type.
const PARTNER_DOC_LABELS_BY_ROLE: Partial<Record<PartnerRole, Record<string, string>>> = {
  agency: { aadhaar: "Aadhaar Card of Director" },
};

// doc_type → label. Pass the partner type where known (an agency's Aadhaar is
// the director's); unknown keys fall back to a readable form of the key rather
// than the raw key.
export function partnerDocLabel(key: string, role?: PartnerRole): string {
  return (
    (role && PARTNER_DOC_LABELS_BY_ROLE[role]?.[key]) ??
    PARTNER_DOC_LABELS[key] ??
    readableKey(key)
  );
}

export const PARTNER_FIELD_LABELS = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email Address",
  phone: "Phone Number",
  companyName: "Company / Agency Name",
  website: "Company Website / LinkedIn",
  country: "Country",
  state: "State / Province",
  city: "City",
  address: "Company Address",
  numCounsellors: "Number of Counselors",
  annualStudentVolume: "Annual Student Volume",
  gstRegistered: "GST Registered",
  companyPan: "Company PAN",
  pan: "PAN Number",
} as const;

// "companyPan" / "company_pan" → "Company Pan": last resort for a key with no
// entry above, so a stored key never reaches the screen verbatim.
function readableKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
