import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  financeProcedure,
  superAdminProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { PayoutStatus, UserType } from "~/server/db/enums";
import { decryptSecret } from "~/server/crypto";
import {
  razorpayConfigured,
  createContact,
  createBankFundAccount,
  createValidation,
  getValidation,
} from "~/server/razorpayx";
import { PAYEE_LABEL_SELECT, payeeLabel } from "~/server/payee";
import {
  PENDING_BANK_WHERE,
  adminBankSelect,
  auditBank,
  bankActorNames,
  notifyPartnerOfBankDecision,
  toAdminBankView,
} from "~/server/bank-accounts";

// Partner bank-detail verification (Super Admin, Finance Manager, Finance
// Executive). Used by the Bank Verifications queue, the partner profile on
// the Partners page and the Reconciliation verify panel, so there is one
// verify path and one reject path.
//
// Verify and reject only act on a pending account, and only if the partner
// hasn't saved new details since finance loaded it (`submittedAt`), so nobody
// approves details they haven't seen.

// Payout states still waiting on finance (everything not yet released).
const OPEN_PAYOUT_STATES = [
  PayoutStatus.APPROVED,
  PayoutStatus.READY_TO_PAY,
  PayoutStatus.ON_HOLD,
  PayoutStatus.SENT_BACK,
];

const decisionInput = z.object({
  bankAccountId: z.number().int().positive(),
  // The account's submittedAt as finance saw it.
  submittedAt: z.date(),
});

const STALE_MESSAGE =
  "The partner changed these bank details after you opened them. Reload and check the new details.";

async function loadPending(bankAccountId: number, seenSubmittedAt: Date) {
  const bank = await db.partner_bank_account.findUnique({ where: { id: bankAccountId } });
  if (!bank) throw new TRPCError({ code: "NOT_FOUND", message: "Bank account not found" });
  if (bank.submitted_at.getTime() !== seenSubmittedAt.getTime()) {
    throw new TRPCError({ code: "CONFLICT", message: STALE_MESSAGE });
  }
  if (bank.is_verified === 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This bank account is already verified." });
  }
  if (bank.rejected_at) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "These details were rejected. The partner needs to save new bank details first.",
    });
  }
  return bank;
}

// Apply a decision only if the row is still the pending one finance checked.
async function updateIfUnchanged(
  bankAccountId: number,
  seenSubmittedAt: Date,
  data: Parameters<typeof db.partner_bank_account.updateMany>[0]["data"],
) {
  const res = await db.partner_bank_account.updateMany({
    where: { id: bankAccountId, submitted_at: seenSubmittedAt, ...PENDING_BANK_WHERE },
    data,
  });
  if (res.count === 0) throw new TRPCError({ code: "CONFLICT", message: STALE_MESSAGE });
}

// Org display name + the owner(s) to contact, for a set of orgs.
async function orgSummaries(orgIds: number[]) {
  if (orgIds.length === 0) return new Map<number, { name: string; owner: string | null; ownerEmail: string | null }>();
  const orgs = await db.organization.findMany({
    where: { id: { in: orgIds } },
    select: {
      id: true,
      name: true,
      user: {
        where: { is_owner: 1 },
        orderBy: { id: "asc" },
        take: 1,
        select: { first_name: true, last_name: true, email: true },
      },
    },
  });
  return new Map(
    orgs.map((o) => {
      const owner = o.user[0];
      return [
        o.id,
        {
          name: o.name,
          owner: owner ? `${owner.first_name} ${owner.last_name}`.trim() : null,
          ownerEmail: owner?.email ?? null,
        },
      ];
    }),
  );
}

export const bankVerificationRouter = createTRPCRouter({
  // The queue. Pending: oldest submission first. Rejected / verified: the most
  // recent decisions (capped), for reference.
  list: financeProcedure
    .input(z.object({ status: z.enum(["pending", "rejected", "verified"]).default("pending") }))
    .query(async ({ input }) => {
      const rows = await db.partner_bank_account.findMany({
        where:
          input.status === "pending"
            ? PENDING_BANK_WHERE
            : input.status === "rejected"
              ? { is_verified: 0, rejected_at: { not: null } }
              : { is_verified: 1 },
        orderBy:
          input.status === "pending"
            ? { submitted_at: "asc" }
            : input.status === "rejected"
              ? { rejected_at: "desc" }
              : { verified_at: "desc" },
        take: input.status === "pending" ? undefined : 200,
        select: {
          ...adminBankSelect,
          // An independent's own name / email (they have no org).
          payee_user: { select: { ...PAYEE_LABEL_SELECT.payee_user.select, email: true } },
        },
      });
      const ids = rows.map((r) => r.id);
      const [names, orgs, lastSaves, payouts] = await Promise.all([
        bankActorNames(rows),
        orgSummaries(Array.from(new Set(rows.flatMap((r) => (r.org_id != null ? [r.org_id] : []))))),
        // The latest save per account says whether it is a first submission or
        // a change (and from which last 4). Rows saved before this audit
        // existed have none.
        ids.length
          ? db.audit_log.findMany({
              where: { action: "bank.details_saved", entity_type: "partner_bank_account", entity_id: { in: ids } },
              orderBy: { id: "desc" },
              select: { entity_id: true, metadata: true },
            })
          : Promise.resolve([]),
        // Claims already waiting to be paid into these accounts.
        ids.length
          ? db.partner_payout.findMany({
              where: {
                status: { in: OPEN_PAYOUT_STATES },
                OR: [{ bank_account_id: { in: ids } }, { invoice: { bank_account_id: { in: ids } } }],
              },
              select: { bank_account_id: true, invoice: { select: { bank_account_id: true } } },
            })
          : Promise.resolve([]),
      ]);
      const previous = new Map<number, { kind: "new" | "changed"; oldLast4: string | null }>();
      for (const s of lastSaves) {
        if (s.entity_id == null || previous.has(s.entity_id)) continue;
        const meta = (s.metadata ?? {}) as Record<string, unknown>;
        const oldLast4 = typeof meta.oldLast4 === "string" ? meta.oldLast4 : null;
        const hadAccount = meta.hadAccount === true;
        previous.set(s.entity_id, { kind: hadAccount ? "changed" : "new", oldLast4 });
      }
      const waiting = new Map<number, number>();
      for (const p of payouts) {
        const id = p.bank_account_id ?? p.invoice.bank_account_id;
        if (id != null) waiting.set(id, (waiting.get(id) ?? 0) + 1);
      }
      return rows.map((r) => {
        if (r.org_id == null) {
          // Independent counsellor: they are both the partner and the contact.
          const label = payeeLabel({ organization: null, payee_user: r.payee_user });
          return {
            ...toAdminBankView(r, names),
            ...label,
            owner: label.partner,
            ownerEmail: r.payee_user?.email ?? null,
            submission: previous.get(r.id) ?? null,
            payoutsWaiting: waiting.get(r.id) ?? 0,
          };
        }
        const org = orgs.get(r.org_id);
        return {
          ...toAdminBankView(r, names),
          partner: org?.name ?? `Org #${r.org_id}`,
          partnerType: "agency" as const,
          payeeInactive: null,
          owner: org?.owner ?? null,
          ownerEmail: org?.ownerEmail ?? null,
          submission: previous.get(r.id) ?? null,
          payoutsWaiting: waiting.get(r.id) ?? 0,
        };
      });
    }),

  counts: financeProcedure.query(async () => {
    const [pending, rejected] = await Promise.all([
      db.partner_bank_account.count({ where: PENDING_BANK_WHERE }),
      db.partner_bank_account.count({ where: { is_verified: 0, rejected_at: { not: null } } }),
    ]);
    return { pending, rejected };
  }),

  // A partner's account for their profile on the Partners page (by the
  // partner's email, which is how that page identifies partners).
  forPartner: financeProcedure
    .input(z.object({ email: z.string().email() }))
    .query(async ({ input }) => {
      const user = await db.user.findUnique({
        where: { email: input.email },
        select: { id: true, type: true, org_id: true },
      });
      if (!user) return null;
      // An agency's account is the org's; an independent's is their own.
      const owner =
        user.org_id != null
          ? { org_id: user.org_id }
          : user.type === UserType.INDEPENDENT_COUNSELLOR
            ? { payee_user_id: user.id }
            : null;
      if (!owner) return null;
      const bank = await db.partner_bank_account.findFirst({
        where: owner,
        orderBy: { id: "desc" },
        select: adminBankSelect,
      });
      if (!bank) return null;
      return toAdminBankView(bank, await bankActorNames([bank]));
    }),

  // Finance checked the cancelled cheque / bank letter against the details by
  // hand and confirms the account.
  verifyManually: financeProcedure
    .input(
      decisionInput.extend({
        note: z.string().trim().min(5, "Note how you verified the account").max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const bank = await loadPending(input.bankAccountId, input.submittedAt);
      if (!bank.proof_url) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No cancelled cheque / bank letter on file. Reject the details so the partner re-enters them with the proof.",
        });
      }
      await updateIfUnchanged(bank.id, input.submittedAt, {
        is_verified: 1,
        verified_at: new Date(),
        verified_by_cp_user_id: ctx.cpUser.id,
        verification_note: input.note,
      });
      await auditBank("bank.verified_manually", bank, {
        byCpUserId: ctx.cpUser.id,
        last4: bank.account_number_last4,
        note: input.note,
      });
      notifyPartnerOfBankDecision(bank, { kind: "verified" });
      return { success: true as const };
    }),

  // RazorpayX penny-drop. Creates the contact + fund account (storing their
  // ids, and dropping our copy of the number: RazorpayX becomes the vault),
  // runs a ₹1 validation and verifies the account if it comes back active.
  verifyViaRazorpay: financeProcedure.input(decisionInput).mutation(async ({ ctx, input }) => {
    if (!razorpayConfigured()) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "RazorpayX is not configured — verify the bank manually." });
    }
    const bank = await loadPending(input.bankAccountId, input.submittedAt);
    if (bank.region === 1) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "International accounts can't be checked by RazorpayX — verify the bank letter by hand." });
    }
    if (!bank.ifsc) throw new TRPCError({ code: "BAD_REQUEST", message: "Bank account is missing its IFSC." });
    try {
      let contactId = bank.provider_contact_id;
      let fundAccountId = bank.provider_fund_account_id;
      if (!fundAccountId) {
        if (!bank.account_number_enc) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Account number is missing — reject the details so the partner re-enters them." });
        }
        const accountNumber = decryptSecret(bank.account_number_enc);
        contactId ??= (await createContact({ name: bank.account_holder, referenceId: `bank_${bank.id}` })).id;
        fundAccountId = (await createBankFundAccount({ contactId, name: bank.account_holder, ifsc: bank.ifsc, accountNumber })).id;
        await updateIfUnchanged(bank.id, input.submittedAt, {
          provider_contact_id: contactId,
          provider_fund_account_id: fundAccountId,
          account_number_enc: null,
        });
      }
      let validation = await createValidation(fundAccountId);
      for (let i = 0; i < 4 && validation.status !== "completed"; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        validation = await getValidation(validation.id);
      }
      const active = validation.results?.account_status === "active";
      const registeredName = validation.results?.registered_name ?? null;
      if (active) {
        await updateIfUnchanged(bank.id, input.submittedAt, {
          is_verified: 1,
          verified_at: new Date(),
          verified_by_cp_user_id: ctx.cpUser.id,
          verification_note: `RazorpayX penny-drop: account active${registeredName ? ` (${registeredName})` : ""}`,
        });
      }
      // A failed check leaves the account pending: finance can retry, check
      // the proof by hand, or reject it.
      await auditBank(active ? "bank.verified_razorpayx" : "bank.razorpayx_check_failed", bank, {
        byCpUserId: ctx.cpUser.id,
        last4: bank.account_number_last4,
        fundAccountId,
        validationStatus: validation.status,
        accountStatus: validation.results?.account_status ?? null,
        registeredName,
      });
      if (active) notifyPartnerOfBankDecision(bank, { kind: "verified" });
      return {
        verified: active,
        status: validation.status,
        accountStatus: validation.results?.account_status ?? null,
        registeredName,
      };
    } catch (e) {
      if (e instanceof TRPCError) throw e;
      throw new TRPCError({ code: "BAD_GATEWAY", message: e instanceof Error ? e.message : "Bank verification failed" });
    }
  }),

  // The details are wrong or the proof doesn't match. The account stays
  // unverified (no payouts) until the partner saves new details, which puts
  // it back in the queue. The partner sees the reason.
  reject: financeProcedure
    .input(
      decisionInput.extend({
        reason: z.string().trim().min(5, "Tell the partner what to fix").max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const bank = await loadPending(input.bankAccountId, input.submittedAt);
      await updateIfUnchanged(bank.id, input.submittedAt, {
        rejected_at: new Date(),
        rejected_by_cp_user_id: ctx.cpUser.id,
        rejection_reason: input.reason,
      });
      await auditBank("bank.rejected", bank, {
        byCpUserId: ctx.cpUser.id,
        last4: bank.account_number_last4,
        reason: input.reason,
      });
      notifyPartnerOfBankDecision(bank, { kind: "rejected", reason: input.reason });
      return { success: true as const };
    }),

  // Super Admin only: the full account number, for checking against the
  // cheque or a bank enquiry. Every reveal is logged.
  revealAccountNumber: superAdminProcedure
    .input(z.object({ bankAccountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const bank = await db.partner_bank_account.findUnique({
        where: { id: input.bankAccountId },
        select: { id: true, org_id: true, payee_user_id: true, account_number_enc: true, account_number_last4: true, iban: true, provider_fund_account_id: true },
      });
      if (!bank) throw new TRPCError({ code: "NOT_FOUND", message: "Bank account not found" });
      await auditBank("bank.account_number_revealed", bank, {
        byCpUserId: ctx.cpUser.id,
        last4: bank.account_number_last4,
      });
      if (!bank.account_number_enc) {
        // After RazorpayX tokenization the number lives only with RazorpayX.
        return {
          accountNumber: null,
          iban: bank.iban,
          note: bank.provider_fund_account_id
            ? "Held by RazorpayX after verification — not stored by Collegepond."
            : "No account number on file.",
        };
      }
      return { accountNumber: decryptSecret(bank.account_number_enc), iban: bank.iban, note: null };
    }),
});
