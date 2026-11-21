// Loan lead sharing with the Collegepond Enrollment App: the client-safe parts
// (stage wording, send status). Server side: ~/server/loan-sharing. Wire
// format: docs/loan-sharing/CONTRACT.md.
//
// Partners refer education-loan leads from Converge; the loan counsellors work
// them in the Enrollment App, which pushes progress back. Partners see the
// Enrollment stage in their own wording (agreed in the spec, 19 Nov 2026).

// Enrollment LOAN_STAGES values, in pipeline order.
export const LOAN_STAGES = [
  "open",
  "not_connected",
  "follow_up",
  "deferred",
  "document_collection",
  "credit_review",
  "sanctioned",
  "pf_paid",
  "disbursed",
  "declined",
  "closed",
] as const;
export type LoanStage = (typeof LOAN_STAGES)[number];

export function isLoanStage(v: unknown): v is LoanStage {
  return typeof v === "string" && (LOAN_STAGES as readonly string[]).includes(v);
}

// What the partner reads for each stage.
export const LoanStagePartnerLabel: Record<LoanStage, string> = {
  open: "Received by loan team",
  not_connected: "Trying to reach student",
  follow_up: "In discussion",
  deferred: "On hold",
  document_collection: "Collecting documents",
  credit_review: "With lender for review",
  sanctioned: "Sanctioned",
  pf_paid: "Processing fee paid",
  disbursed: "Disbursed",
  declined: "Declined",
  closed: "Closed",
};

export function loanStageLabel(stage: string | null | undefined): string {
  return stage && isLoanStage(stage) ? LoanStagePartnerLabel[stage] : "Awaiting loan team";
}

// Badge tone per stage (Badge colours used across the partner portal).
export function loanStageTone(stage: string | null | undefined): "blue" | "amber" | "green" | "red" | "gray" {
  switch (stage) {
    case "sanctioned":
    case "pf_paid":
    case "disbursed":
      return "green";
    case "declined":
      return "red";
    case "closed":
    case "deferred":
      return "gray";
    case "document_collection":
    case "credit_review":
      return "amber";
    default:
      return "blue";
  }
}

// The stages shown on the partner's progress tracker (the happy path);
// not_connected / follow_up / deferred sit at "In discussion", declined and
// closed end it.
export const LOAN_TRACK: { stage: LoanStage; label: string }[] = [
  { stage: "open", label: "Received" },
  { stage: "follow_up", label: "In discussion" },
  { stage: "document_collection", label: "Documents" },
  { stage: "credit_review", label: "With lender" },
  { stage: "sanctioned", label: "Sanctioned" },
  { stage: "disbursed", label: "Disbursed" },
];

// Index on LOAN_TRACK reached by a stage (-1 when nothing reported yet).
export function loanTrackIndex(stage: string | null | undefined): number {
  switch (stage) {
    case "open":
      return 0;
    case "not_connected":
    case "follow_up":
    case "deferred":
      return 1;
    case "document_collection":
      return 2;
    case "credit_review":
      return 3;
    case "sanctioned":
    case "pf_paid":
      return 4;
    case "disbursed":
      return 5;
    default:
      return -1;
  }
}

export const LOAN_FINAL_STAGES: LoanStage[] = ["disbursed", "declined", "closed"];

// loan_referral.send_status: has the Enrollment App got it yet?
export const LoanReferralSendStatus = {
  SENDING: 0,
  RECEIVED: 1,
  // The student was already a loan lead with Collegepond: no progress is
  // shared and credit is decided by hand (decision 2, 19 Nov 2026).
  DUPLICATE: 2,
  FAILED: 3,
} as const;
export type LoanReferralSendStatus =
  (typeof LoanReferralSendStatus)[keyof typeof LoanReferralSendStatus];

export const LoanReferralSendStatusLabel: Record<LoanReferralSendStatus, string> = {
  [LoanReferralSendStatus.SENDING]: "Not yet received by the loan team",
  [LoanReferralSendStatus.RECEIVED]: "Received",
  [LoanReferralSendStatus.DUPLICATE]: "Already in progress with Collegepond",
  [LoanReferralSendStatus.FAILED]: "Could not be sent",
};

// One line for the partner's list: the stage once received, else the send state.
export function loanReferralStatusLabel(sendStatus: number, stage: string | null): string {
  if (sendStatus === LoanReferralSendStatus.RECEIVED) return loanStageLabel(stage);
  return LoanReferralSendStatusLabel[sendStatus as LoanReferralSendStatus] ?? "Unknown";
}

// Loan documents (contract 5c): the type key of an "Additional document", one
// the partner uploads outside the loan team's list under a label they choose
// (21 Nov 2026). Never a key on the list (those start with their group).
export const ADDITIONAL_DOC_KEY = "additional";
export const ADDITIONAL_DOC_LABEL_MAX = 160;

export const LOAN_CONSENT_TEXT =
  "The student has agreed to be contacted by Collegepond's loan team about an education loan.";
