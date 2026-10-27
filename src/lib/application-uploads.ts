// Documents a partner uploads for one application once the deposit is paid
// (Portal Testing Day 5, 24 Oct 2026): the deposit slip, then the visa
// application documents, then the visa approved copy. Each is tied to the
// application (document.application_id) and verified by a Collegepond
// counsellor (document.status). Shared by the partner card, the admin card
// and the upload route.
//
// 27 Oct testing: one Deposit Paid stage for every country, with separate
// slots for the deposit slip and the TT copy, any number of visa documents,
// and the full history of each slot (a rejected upload stays rejected, with
// its reason, when a new one replaces it).

import { UniApplicationStatus } from "~/server/db/enums";
import { isClosedStage, stageAtLeast } from "~/lib/application-stages";

export interface ApplicationUploadKind {
  docType: string;
  label: string;
  hint: string;
  // Offered from this stage on.
  from: UniApplicationStatus;
  // Shown as required until one is uploaded and not rejected.
  required: boolean;
  // Several files can be picked at once (the slot accumulates).
  manyFiles: boolean;
}

export const APPLICATION_UPLOAD_KINDS: ApplicationUploadKind[] = [
  {
    docType: "deposit_receipt",
    label: "Deposit slip",
    hint: "The university's receipt or confirmation of the deposit. Needed to process commission.",
    from: UniApplicationStatus.DEPOSIT_PAID,
    required: true,
    manyFiles: false,
  },
  {
    docType: "tt_copy",
    label: "TT copy",
    hint: "The bank's telegraphic transfer (TT) / wire confirmation for the deposit payment, if paid by transfer.",
    from: UniApplicationStatus.DEPOSIT_PAID,
    required: false,
    manyFiles: false,
  },
  {
    docType: "visa_documents",
    label: "Visa application documents",
    hint: "The documents for the visa application (e.g. I-20, DS-160, CAS, financials).",
    from: UniApplicationStatus.DEPOSIT_PAID,
    required: false,
    manyFiles: true,
  },
  {
    docType: "visa",
    label: "Visa approved copy",
    hint: "The visa grant letter or a copy of the visa.",
    from: UniApplicationStatus.VISA_SECURED,
    required: true,
    manyFiles: false,
  },
];

// The kinds a partner can upload for an application at `status` (none once
// it is closed).
export function applicationUploadKinds(status: number): ApplicationUploadKind[] {
  if (isClosedStage(status)) return [];
  return APPLICATION_UPLOAD_KINDS.filter((k) => stageAtLeast(status, k.from));
}

export function applicationUploadKind(status: number, docType: string): ApplicationUploadKind | null {
  return applicationUploadKinds(status).find((k) => k.docType === docType) ?? null;
}
