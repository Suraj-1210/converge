import { db } from "~/server/db";
import { createNotifications } from "~/server/notify";
import { resolveStorageUrl } from "~/server/storage";
import { appUrl, bankDetailsRejectedEmail, bankDetailsVerifiedEmail } from "~/server/email";
import { emailPartners, orgOwnerRecipients } from "~/server/email/partners";

// Partner payout bank accounts (partner_bank_account): verification status,
// the masked admin view, audit rows and partner notifications. Shared by the
// partner's save (partner-commission), the Bank Verifications queue and the
// Reconciliation verify panel (bank-verification router).
//
// Status is derived from the row: verified (is_verified = 1), rejected
// (rejected_at set), otherwise pending. Payouts need verified.

export type BankStatus = "pending" | "verified" | "rejected";

export function bankStatusOf(b: { is_verified: number; rejected_at: Date | null }): BankStatus {
  if (b.is_verified === 1) return "verified";
  if (b.rejected_at) return "rejected";
  return "pending";
}

// Rows waiting for finance: unverified and not rejected.
export const PENDING_BANK_WHERE = { is_verified: 0, rejected_at: null } as const;

// TIMESTAMP(0) columns round to the second; storing a whole second keeps the
// value finance loads identical to the one compared on verify/reject.
export const wholeSecondNow = () => new Date(Math.floor(Date.now() / 1000) * 1000);

// Columns behind the admin view. Never the encrypted number, GSTIN or PAN.
export const adminBankSelect = {
  id: true,
  org_id: true,
  region: true,
  account_holder: true,
  account_number_last4: true,
  ifsc: true,
  swift: true,
  iban: true,
  bank_name: true,
  branch: true,
  bank_country: true,
  bank_address: true,
  account_type: true,
  proof_url: true,
  proof_file_name: true,
  submitted_at: true,
  is_verified: true,
  verified_at: true,
  verified_by_cp_user_id: true,
  verification_note: true,
  rejected_at: true,
  rejected_by_cp_user_id: true,
  rejection_reason: true,
} as const;

type AdminBankRow = {
  id: number;
  org_id: number;
  region: number;
  account_holder: string;
  account_number_last4: string | null;
  ifsc: string | null;
  swift: string | null;
  iban: string | null;
  bank_name: string | null;
  branch: string | null;
  bank_country: string | null;
  bank_address: string | null;
  account_type: string | null;
  proof_url: string | null;
  proof_file_name: string | null;
  submitted_at: Date;
  is_verified: number;
  verified_at: Date | null;
  verified_by_cp_user_id: number | null;
  verification_note: string | null;
  rejected_at: Date | null;
  rejected_by_cp_user_id: number | null;
  rejection_reason: string | null;
};

// Masked for everyone (last 4 only); Super Admin can reveal the full number
// through bankVerification.revealAccountNumber, which is audit-logged.
export function toAdminBankView(b: AdminBankRow, names: Map<number, string>) {
  const nameOf = (id: number | null) => (id != null ? (names.get(id) ?? null) : null);
  return {
    id: b.id,
    orgId: b.org_id,
    status: bankStatusOf(b),
    region: b.region === 1 ? ("international" as const) : ("domestic" as const),
    accountHolder: b.account_holder,
    last4: b.account_number_last4,
    ifsc: b.ifsc,
    swift: b.swift,
    ibanLast4: b.iban ? b.iban.slice(-4) : null,
    bankName: b.bank_name,
    branch: b.branch,
    bankCountry: b.bank_country,
    bankAddress: b.bank_address,
    accountType: b.account_type,
    proofUrl: resolveStorageUrl(b.proof_url),
    proofFileName: b.proof_file_name,
    // Sent back on verify/reject so a change made since loading is caught.
    submittedAt: b.submitted_at,
    verified: b.is_verified === 1,
    verifiedAt: b.verified_at,
    verifiedBy: nameOf(b.verified_by_cp_user_id),
    verificationNote: b.verification_note,
    rejectedAt: b.rejected_at,
    rejectedBy: nameOf(b.rejected_by_cp_user_id),
    rejectionReason: b.rejection_reason,
  };
}
export type AdminBankView = ReturnType<typeof toAdminBankView>;

// Staff display names for the verifier / rejecter ids on a set of rows.
export async function bankActorNames(
  rows: { verified_by_cp_user_id: number | null; rejected_by_cp_user_id: number | null }[],
): Promise<Map<number, string>> {
  const ids = Array.from(
    new Set(
      rows
        .flatMap((r) => [r.verified_by_cp_user_id, r.rejected_by_cp_user_id])
        .filter((x): x is number => x != null),
    ),
  );
  if (ids.length === 0) return new Map();
  const users = await db.collegepond_user.findMany({
    where: { id: { in: ids } },
    select: { id: true, first_name: true, last_name: true },
  });
  return new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]));
}

// Audit actions for bank details. Metadata carries last-4 digits only, never a
// full account number. Staff actions put the admin in byCpUserId; a partner's
// own save sets user_id instead.
export const BANK_AUDIT_ACTIONS = [
  "bank.details_saved",
  "bank.verified_manually",
  "bank.verified_razorpayx",
  "bank.razorpayx_check_failed",
  "bank.rejected",
  "bank.account_number_revealed",
] as const;
export type BankAuditAction = (typeof BANK_AUDIT_ACTIONS)[number];

export async function auditBank(
  action: BankAuditAction,
  bank: { id: number; org_id: number },
  metadata: Record<string, string | number | boolean | null>,
  partnerUserId?: number,
): Promise<void> {
  await db.audit_log.create({
    data: {
      org_id: bank.org_id,
      user_id: partnerUserId ?? null,
      action,
      entity_type: "partner_bank_account",
      entity_id: bank.id,
      metadata,
    },
  });
}

// Tell the agency owner(s) finance verified or rejected their bank details:
// in-app (linking to My Account → Bank Details) and by email. Account-critical,
// so there is no preference toggle. Fire-and-forget: the decision is already
// saved, and a failed send is logged, never thrown.
export function notifyPartnerOfBankDecision(
  bank: { org_id: number; account_number_last4: string | null; bank_name: string | null },
  decision: { kind: "verified" } | { kind: "rejected"; reason: string },
): void {
  const link = "/partner/account?tab=bank";
  const last4 = bank.account_number_last4;
  const ending = last4 ? ` ending ${last4}` : "";
  void (async () => {
    const recipients = await orgOwnerRecipients(bank.org_id);
    try {
      await createNotifications(
        recipients.map((r) => r.id),
        decision.kind === "verified"
          ? {
              type: "bank.verified",
              title: `Your bank account${ending} is verified`,
              body: "Commission payments will be made to this account.",
              link,
              tone: "green",
            }
          : {
              type: "bank.rejected",
              title: "Your bank details need updating",
              body: `Reason: ${decision.reason}`.slice(0, 500),
              link,
              tone: "red",
            },
      );
    } catch (e) {
      console.error("[notify] bank decision in-app failed:", e instanceof Error ? e.message : e);
    }
    const sent = await emailPartners(
      recipients,
      (r) =>
        decision.kind === "verified"
          ? bankDetailsVerifiedEmail(r, { accountLast4: last4, bankName: bank.bank_name }, appUrl())
          : bankDetailsRejectedEmail(r, { accountLast4: last4, reason: decision.reason }, appUrl()),
      `bank-${decision.kind}`,
    );
    console.log(`[notify] bank-${decision.kind} for org ${bank.org_id}: in-app + ${sent} email(s)`);
  })().catch((e) =>
    console.error("[notify] bank decision lookup failed:", e instanceof Error ? e.message : e),
  );
}
