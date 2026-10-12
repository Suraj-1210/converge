// The partner Memorandum of Understanding, as data. The signing screen renders
// it and the executed-MOU PDF (/api/mou) prints it, so both always show the
// same wording. Changing the text changes what every past signer downloads —
// bump MOU_VERSION when the terms change.

export const MOU_VERSION = "2026-10";

export const MOU_COLLEGEPOND_ENTITY = "Collegepond Education Services Pvt. Ltd.";

export type MouInline = string | { bold: string; text: string };
export type MouBlock = { kind: "p"; text: string } | { kind: "list"; items: MouInline[] };
export interface MouSection {
  title: string;
  blocks: MouBlock[];
}

const p = (text: string): MouBlock => ({ kind: "p", text });
const list = (...items: MouInline[]): MouBlock => ({ kind: "list", items });

export const MOU_SECTIONS: MouSection[] = [
  {
    title: "Partnership Terms",
    blocks: [
      p(
        `This Memorandum of Understanding ("MOU") is entered into between ${MOU_COLLEGEPOND_ENTITY} ("Collegepond") and the Partner ("Partner") identified in the registration, establishing a referral and student placement partnership.`,
      ),
      p(
        "The partnership shall commence from the date of digital signing of this MOU and shall remain in effect for a period of one (1) year, automatically renewable unless terminated by either party with 30 days written notice.",
      ),
    ],
  },
  {
    title: "Scope of Services",
    blocks: [
      p("Under this agreement, Collegepond shall:"),
      list(
        "Provide access to the Collegepond Partner Portal for application management",
        "Process student applications to partner universities on behalf of the Partner",
        "Provide regular updates on application status and university decisions",
        "Offer training materials and resources for counselors",
        "Maintain direct relationships with 500+ universities across 15+ countries",
      ),
      p("The Partner shall:"),
      list(
        "Submit complete and accurate student applications through the portal",
        "Ensure all student documents are authentic and verified",
        "Maintain professional standards in student counseling",
        "Respond to queries and requests within reasonable timeframes",
      ),
    ],
  },
  {
    title: "Commission Structure",
    blocks: [
      p(
        "Collegepond shall pay the Partner a commission for each successfully enrolled student as per the following tier structure:",
      ),
      list(
        { bold: "Silver Tier (1-10 students):", text: "70% of university commission received by Collegepond" },
        { bold: "Gold Tier (11-30 students):", text: "75% of university commission received by Collegepond" },
        { bold: "Platinum Tier (31-50 students):", text: "80% of university commission received by Collegepond" },
        { bold: "Titanium Tier (51-75 students):", text: "85% of university commission received by Collegepond" },
        { bold: "Diamond Tier (75+ students):", text: "90% of university commission received by Collegepond" },
      ),
      p(
        "Commission shall be payable within 30 days of Collegepond receiving payment from the respective university. All payments shall be made via bank transfer to the account specified by the Partner.",
      ),
    ],
  },
  {
    title: "Obligations & Responsibilities",
    blocks: [
      p(
        "Both parties agree to act in good faith and in the best interest of the students. The Partner acknowledges that Collegepond reserves the right to reject any application that does not meet the minimum eligibility criteria set by the partner universities.",
      ),
      p(
        "The Partner shall not make any false promises or guarantees to students regarding admission outcomes. Any misrepresentation may result in immediate termination of this partnership.",
      ),
    ],
  },
  {
    title: "Confidentiality",
    blocks: [
      p(
        "Both parties agree to maintain strict confidentiality regarding all student information, commission structures, internal processes, and proprietary systems shared during the course of this partnership. This obligation survives the termination of this MOU.",
      ),
      p(
        "Neither party shall disclose confidential information to third parties without prior written consent from the other party, except as required by law.",
      ),
    ],
  },
  {
    title: "Term & Termination",
    blocks: [
      p("This MOU may be terminated by either party with 30 days written notice. Upon termination:"),
      list(
        "All pending applications shall be processed to completion",
        "Outstanding commissions shall be paid as per the agreed schedule",
        "Access to the Partner Portal shall be revoked within 7 days",
        "Both parties shall return or destroy any confidential information",
      ),
      p(
        "Collegepond reserves the right to immediately terminate this agreement in cases of fraud, misrepresentation, or breach of confidentiality obligations without any prior notice period.",
      ),
    ],
  },
];

// Signature kinds stored in user.mou_signature_kind.
export const MouSignatureKind = { DRAWN: 0, TYPED: 1 } as const;
