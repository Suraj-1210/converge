import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  financeProcedure,
  financeManagerProcedure,
  superAdminProcedure,
} from "~/server/api/trpc";
import { resolveStorageUrl } from "~/server/storage";
import { db } from "~/server/db";
import {
  PartnerInvoiceStatus,
  PayoutStatus,
  PayoutMethodLabel,
  TrancheStatus,
  PAYOUT_METHOD_CODES,
  financialYearOf,
  type PayoutMethod,
} from "~/server/db/enums";
import { appUrl, payoutSentEmail } from "~/server/email";
import { emailPartners, orgOwnerRecipients } from "~/server/email/partners";
import {
  razorpayConfigured,
  razorpayMode,
  createContact,
  createBankFundAccount,
  createValidation,
  getValidation,
  createPayout,
} from "~/server/razorpayx";
import { decryptSecret } from "~/server/crypto";

// PayoutMethod code → RazorpayX payout mode (INTERNATIONAL_WIRE has no RazorpayX mode).
const RZP_MODE: Record<number, string | undefined> = { 0: "NEFT", 1: "RTGS", 2: undefined, 3: "IMPS", 4: "UPI" };

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
const orNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  if (!t) return null;
  return t;
};
const payoutMethod = z
  .number()
  .int()
  .refine((v) => (PAYOUT_METHOD_CODES as number[]).includes(v), "Invalid method");

// The open states finance acts on (everything not yet released).
const PENDING_STATES = [
  PayoutStatus.APPROVED,
  PayoutStatus.READY_TO_PAY,
  PayoutStatus.ON_HOLD,
  PayoutStatus.SENT_BACK,
];

// partner_payout stores who-acted as plain FK ids (no relation) — resolve the
// distinct ids to display names in one query for the audit trail.
async function userNameMap(
  ids: (number | null | undefined)[],
): Promise<Map<number, string>> {
  const unique = Array.from(new Set(ids.filter((x): x is number => x != null)));
  if (unique.length === 0) return new Map();
  const users = await db.collegepond_user.findMany({
    where: { id: { in: unique } },
    select: { id: true, first_name: true, last_name: true },
  });
  return new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]));
}
const intakeOf = (
  m: string | number | null,
  y: string | number | null,
): string | null => [m, y].filter(Boolean).join(" ") || null;

export const reconciliationRouter = createTRPCRouter({
  listPending: financeProcedure.query(async () => {
    const payouts = await db.partner_payout.findMany({
      where: { status: { in: PENDING_STATES } },
      orderBy: { ops_approved_at: "asc" },
      include: {
        invoice: {
          select: {
            invoice_number: true,
            created_at: true,
            gstin: true,
            pan: true,
            net_payable: true,
            total_amount: true,
            organization: { select: { name: true } },
            bank_account: {
              select: {
                id: true,
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
                proof_url: true,
                proof_file_name: true,
                is_verified: true,
                verified_at: true,
                verification_note: true,
                verified_by_cp_user_id: true,
              },
            },
            invoice_item: {
              select: {
                amount: true,
                commission: {
                  select: {
                    commision_rate: true,
                    application: {
                      select: {
                        student: { select: { first_name: true, last_name: true } },
                        course: {
                          select: {
                            name: true,
                            intake_month: true,
                            intake_year: true,
                            university: { select: { name: true } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const names = await userNameMap([
      ...payouts.map((p) => p.ops_approved_by_cp_user_id),
      ...payouts.map((p) => p.invoice.bank_account?.verified_by_cp_user_id ?? null),
    ]);
    return payouts.map((p) => ({
      id: p.id,
      partner: p.invoice.organization.name,
      invoiceNumber: p.invoice.invoice_number,
      amountInr: num(p.amount_inr),
      status: p.status,
      opsApprovedAt: p.ops_approved_at,
      approvedBy:
        p.ops_approved_by_cp_user_id != null
          ? (names.get(p.ops_approved_by_cp_user_id) ?? null)
          : null,
      gstin: p.invoice.gstin,
      pan: p.invoice.pan,
      bankAccountId: p.bank_account_id ?? p.invoice.bank_account?.id ?? null,
      bank: p.invoice.bank_account
        ? {
            region: p.invoice.bank_account.region === 1 ? ("international" as const) : ("domestic" as const),
            accountHolder: p.invoice.bank_account.account_holder,
            // Masked for everyone; Super Admin can reveal via revealAccountNumber.
            last4: p.invoice.bank_account.account_number_last4,
            ifsc: p.invoice.bank_account.ifsc,
            swift: p.invoice.bank_account.swift,
            ibanLast4: p.invoice.bank_account.iban ? p.invoice.bank_account.iban.slice(-4) : null,
            bankName: p.invoice.bank_account.bank_name,
            branch: p.invoice.bank_account.branch,
            bankCountry: p.invoice.bank_account.bank_country,
            bankAddress: p.invoice.bank_account.bank_address,
            proofUrl: resolveStorageUrl(p.invoice.bank_account.proof_url),
            proofFileName: p.invoice.bank_account.proof_file_name,
            verified: p.invoice.bank_account.is_verified === 1,
            verifiedAt: p.invoice.bank_account.verified_at?.toISOString() ?? null,
            verifiedBy:
              p.invoice.bank_account.verified_by_cp_user_id != null
                ? (names.get(p.invoice.bank_account.verified_by_cp_user_id) ?? null)
                : null,
            verificationNote: p.invoice.bank_account.verification_note,
          }
        : null,
      checks: {
        bankConfirmed: p.verify_bank_confirmed === 1,
        invoiceVerified: p.verify_invoice_verified === 1,
        commissionVerified: p.verify_commission_verified === 1,
        duplicateCheck: p.verify_duplicate_check === 1,
      },
      holdReason: p.hold_reason,
      sentBackReason: p.sent_back_reason,
      students: p.invoice.invoice_item.map((it) => ({
        name: `${it.commission.application.student.first_name} ${it.commission.application.student.last_name}`.trim(),
        university: it.commission.application.course.university.name,
        intake: intakeOf(
          it.commission.application.course.intake_month,
          it.commission.application.course.intake_year,
        ),
        rate: num(it.commission.commision_rate),
      })),
    }));
  }),

  // Save the 4-point checklist; all four ticked promotes it to Ready to Pay.
  verify: financeProcedure
    .input(
      z.object({
        payoutId: z.number().int().positive(),
        bankConfirmed: z.boolean(),
        invoiceVerified: z.boolean(),
        commissionVerified: z.boolean(),
        duplicateCheck: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const all =
        input.bankConfirmed && input.invoiceVerified && input.commissionVerified && input.duplicateCheck;
      await db.partner_payout.update({
        where: { id: input.payoutId },
        data: {
          verify_bank_confirmed: input.bankConfirmed ? 1 : 0,
          verify_invoice_verified: input.invoiceVerified ? 1 : 0,
          verify_commission_verified: input.commissionVerified ? 1 : 0,
          verify_duplicate_check: input.duplicateCheck ? 1 : 0,
          verified_by_cp_user_id: ctx.cpUser.id,
          verified_at: all ? new Date() : null,
          status: all ? PayoutStatus.READY_TO_PAY : PayoutStatus.APPROVED,
        },
      });
      return { readyToPay: all };
    }),

  // Release the payment (Finance Manager only). Marks the invoice PAID and every
  // student on it partner-paid -> the commission spine reaches DISBURSED.
  release: financeManagerProcedure
    .input(
      z.object({
        payoutId: z.number().int().positive(),
        method: payoutMethod,
        bankName: z.string().max(150).optional(),
        accountNumber: z.string().max(34).optional(),
        ifsc: z.string().max(15).optional(),
        swift: z.string().max(15).optional(),
        // Optional: when paying via RazorpayX the reference comes from the provider.
        referenceNumber: z.string().trim().max(100).optional(),
        paymentDate: z.string(),
        amountInr: z.number().positive().optional(),
        notes: z.string().max(500).optional(),
        // Required only when releasing MANUALLY to a domestic bank that isn't
        // RazorpayX-verified — a written justification of how the account was
        // confirmed (since the penny-drop account check is being bypassed).
        manualVerifyReason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const payout = await db.partner_payout.findUnique({
        where: { id: input.payoutId },
        include: { invoice: { include: { invoice_item: { select: { commission_id: true, commission_tranche_id: true } } } } },
      });
      if (!payout) throw new TRPCError({ code: "NOT_FOUND", message: "Payout not found" });
      if (payout.status !== PayoutStatus.READY_TO_PAY) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Complete the verification checklist before releasing payment.",
        });
      }

      // Execute a real RazorpayX payout when configured + the linked bank account is
      // verified + the method maps to a RazorpayX mode. Otherwise fall back to manual
      // recording (the operator enters the bank's reference/UTR).
      const bankAccountId = payout.bank_account_id ?? payout.invoice.bank_account_id;
      const mode = RZP_MODE[input.method]; // undefined for International Wire (no RazorpayX mode)
      const amountInr = input.amountInr ?? num(payout.amount_inr);
      const bank = bankAccountId
        ? await db.partner_bank_account.findUnique({ where: { id: bankAccountId } })
        : null;
      // Payouts go only to an account finance has verified (cheque / bank
      // letter checked by hand, or RazorpayX penny-drop).
      if (!bank) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This claim has no bank account to pay into." });
      }
      if (bank.is_verified !== 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Verify the partner's bank account (check the cancelled cheque / bank letter) before releasing payment.",
        });
      }
      const bankVerified = bank.is_verified === 1 && Boolean(bank.provider_fund_account_id);
      let provider: { id: string; status: string; utr?: string | null } | null = null;

      if (razorpayConfigured() && mode && bankAccountId && bankVerified && bank?.provider_fund_account_id) {
        try {
          provider = await createPayout({
            fundAccountId: bank.provider_fund_account_id,
            amountInr,
            mode,
            referenceId: `payout_${payout.id}`,
            narration: `CP payout ${payout.id}`,
          });
        } catch (e) {
          throw new TRPCError({ code: "BAD_GATEWAY", message: e instanceof Error ? `RazorpayX payout failed: ${e.message}` : "RazorpayX payout failed" });
        }
      }

      const reference = provider ? (provider.utr ?? provider.id) : input.referenceNumber?.trim();
      if (!reference) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a payment reference, or verify the bank account to pay via RazorpayX." });
      }

      const now = new Date();
      const releaseNotes = orNull(input.notes);

      await db.$transaction([
        db.partner_payout.update({
          where: { id: payout.id },
          data: {
            status: PayoutStatus.RELEASED,
            method: input.method,
            bank_name: orNull(input.bankName),
            account_number_last4: input.accountNumber
              ? input.accountNumber.replace(/\D/g, "").slice(-4) || null
              : undefined,
            ifsc: orNull(input.ifsc),
            swift: orNull(input.swift),
            reference_number: reference,
            provider_payout_id: provider?.id ?? null,
            utr: provider?.utr ?? null,
            provider_status: provider?.status ?? null,
            payment_date: new Date(input.paymentDate),
            notes: releaseNotes,
            released_by_cp_user_id: ctx.cpUser.id,
            released_at: now,
            fy: financialYearOf(new Date(input.paymentDate)),
            ...(input.amountInr != null ? { amount_inr: input.amountInr } : {}),
          },
        }),
        db.invoice.update({
          where: { id: payout.invoice_id },
          data: { status: PartnerInvoiceStatus.PAID },
        }),
        // Pay-as-collected: mark the claimed tranches PAID + disbursed.
        db.commission_tranche.updateMany({
          where: {
            id: {
              in: payout.invoice.invoice_item
                .map((it) => it.commission_tranche_id)
                .filter((x): x is number => x != null),
            },
          },
          data: { status: TrancheStatus.PAID, disbursed_at: now },
        }),
        // Legacy (pre-tranche) lines mark the commission paid directly.
        db.commission.updateMany({
          where: {
            id: {
              in: payout.invoice.invoice_item
                .filter((it) => it.commission_tranche_id == null)
                .map((it) => it.commission_id),
            },
          },
          data: { partner_paid_at: now },
        }),
      ]);
      // A commission is fully disbursed once ALL its tranches are PAID — stamp
      // partner_paid_at then so downstream "disbursed" derivations stay correct.
      const trancheCommissionIds = [
        ...new Set(
          payout.invoice.invoice_item
            .filter((it) => it.commission_tranche_id != null)
            .map((it) => it.commission_id),
        ),
      ];
      for (const cid of trancheCommissionIds) {
        const pending = await db.commission_tranche.count({
          where: { commission_id: cid, status: { not: TrancheStatus.PAID } },
        });
        if (pending === 0) {
          await db.commission.update({ where: { id: cid }, data: { partner_paid_at: now } });
        }
      }
      // Tell the agency the money is on its way (fire-and-forget; already saved).
      void orgOwnerRecipients(payout.invoice.org_id)
        .then((rs) =>
          emailPartners(
            rs,
            (r) =>
              payoutSentEmail(
                r,
                {
                  invoiceNumber: payout.invoice.invoice_number,
                  amountInr,
                  method: PayoutMethodLabel[input.method as PayoutMethod] ?? "Bank transfer",
                  reference,
                  paymentDate: new Date(input.paymentDate).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  }),
                },
                appUrl(),
              ),
            "payout-sent",
          ),
        )
        .catch((e) => console.error("[email] payout-sent lookup failed:", e));
      return { success: true as const, provider: provider ? { id: provider.id, status: provider.status } : null };
    }),

  // Finance has checked the cancelled cheque / bank letter against the details
  // and confirms the account. Required before any payout to it.
  markBankVerified: financeProcedure
    .input(
      z.object({
        bankAccountId: z.number().int().positive(),
        note: z.string().trim().min(5, "Note how you verified the account").max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const bank = await db.partner_bank_account.findUnique({
        where: { id: input.bankAccountId },
        select: { id: true, org_id: true, proof_url: true },
      });
      if (!bank) throw new TRPCError({ code: "NOT_FOUND", message: "Bank account not found" });
      if (!bank.proof_url) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No cancelled cheque / bank letter on file. Ask the partner to re-enter their bank details with the proof.",
        });
      }
      await db.partner_bank_account.update({
        where: { id: bank.id },
        data: {
          is_verified: 1,
          verified_at: new Date(),
          verified_by_cp_user_id: ctx.cpUser.id,
          verification_note: input.note,
        },
      });
      await db.audit_log.create({
        data: {
          org_id: bank.org_id,
          action: "bank.verified_manually",
          entity_type: "partner_bank_account",
          entity_id: bank.id,
          metadata: { byCpUserId: ctx.cpUser.id, note: input.note },
        },
      });
      return { success: true as const };
    }),

  // Super Admin only: the full account number, for checking against the
  // cheque or a bank enquiry. Every reveal is logged.
  revealAccountNumber: superAdminProcedure
    .input(z.object({ bankAccountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const bank = await db.partner_bank_account.findUnique({
        where: { id: input.bankAccountId },
        select: { id: true, org_id: true, account_number_enc: true, iban: true, provider_fund_account_id: true },
      });
      if (!bank) throw new TRPCError({ code: "NOT_FOUND", message: "Bank account not found" });
      await db.audit_log.create({
        data: {
          org_id: bank.org_id,
          action: "bank.account_number_revealed",
          entity_type: "partner_bank_account",
          entity_id: bank.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
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

  // Payments config for the UI (is RazorpayX wired, and is it test/live?).
  paymentsConfig: financeProcedure.query(() => ({ configured: razorpayConfigured(), mode: razorpayMode() })),

  // RazorpayX bank-account verification (penny-drop). Creates the contact + fund
  // account (storing their ids) and runs a ₹1 validation; sets is_verified on success.
  verifyBankAccount: financeProcedure
    .input(z.object({ bankAccountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      if (!razorpayConfigured()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "RazorpayX is not configured — verify the bank manually." });
      }
      const bank = await db.partner_bank_account.findUnique({ where: { id: input.bankAccountId } });
      if (!bank) throw new TRPCError({ code: "NOT_FOUND", message: "Bank account not found" });
      if (bank.region === 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "International accounts can't be checked by RazorpayX — verify the bank letter by hand." });
      }
      if (!bank.ifsc) throw new TRPCError({ code: "BAD_REQUEST", message: "Bank account is missing its IFSC." });
      try {
        let contactId = bank.provider_contact_id;
        let fundAccountId = bank.provider_fund_account_id;
        // First time: create the RazorpayX contact + fund account from the raw
        // (decrypted) number, then TOKENIZE — null our stored copy so RazorpayX
        // becomes the vault (payouts go to the fund-account token, not the number).
        if (!fundAccountId) {
          if (!bank.account_number_enc) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Account number is missing — re-enter the bank details." });
          }
          const accountNumber = decryptSecret(bank.account_number_enc);
          contactId ??= (await createContact({ name: bank.account_holder, referenceId: `bank_${bank.id}` })).id;
          fundAccountId = (await createBankFundAccount({ contactId, name: bank.account_holder, ifsc: bank.ifsc, accountNumber })).id;
          await db.partner_bank_account.update({
            where: { id: bank.id },
            data: { provider_contact_id: contactId, provider_fund_account_id: fundAccountId, account_number_enc: null },
          });
        }
        // Penny-drop validation on the (tokenized) fund account.
        let validation = await createValidation(fundAccountId);
        for (let i = 0; i < 4 && validation.status !== "completed"; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          validation = await getValidation(validation.id);
        }
        const active = validation.results?.account_status === "active";
        await db.partner_bank_account.update({
          where: { id: bank.id },
          data: {
            is_verified: active ? 1 : 0,
            verified_at: active ? new Date() : null,
            verified_by_cp_user_id: active ? ctx.cpUser.id : null,
            verification_note: active ? "RazorpayX penny-drop: account active" : null,
          },
        });
        await db.audit_log.create({
          data: {
            action: "partner.bank_verified",
            entity_type: "user",
            entity_id: bank.org_id,
            metadata: {
              byCpUserId: ctx.cpUser.id,
              bankAccountId: bank.id,
              verified: active,
              fundAccountId,
              registeredName: validation.results?.registered_name ?? null,
            },
          },
        });
        return {
          verified: active,
          status: validation.status,
          accountStatus: validation.results?.account_status ?? null,
          registeredName: validation.results?.registered_name ?? null,
        };
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({ code: "BAD_GATEWAY", message: e instanceof Error ? e.message : "Bank verification failed" });
      }
    }),

  hold: financeProcedure
    .input(z.object({ payoutId: z.number().int().positive(), reason: z.string().trim().min(1).max(500) }))
    .mutation(async ({ input }) => {
      await db.partner_payout.update({
        where: { id: input.payoutId },
        data: { status: PayoutStatus.ON_HOLD, hold_reason: input.reason },
      });
      return { success: true as const };
    }),

  sendBack: financeProcedure
    .input(z.object({ payoutId: z.number().int().positive(), reason: z.string().trim().min(1).max(500) }))
    .mutation(async ({ input }) => {
      await db.partner_payout.update({
        where: { id: input.payoutId },
        data: { status: PayoutStatus.SENT_BACK, sent_back_reason: input.reason },
      });
      return { success: true as const };
    }),

  completed: financeProcedure.query(async () => {
    const payouts = await db.partner_payout.findMany({
      where: { status: PayoutStatus.RELEASED },
      orderBy: { released_at: "desc" },
      include: {
        invoice: {
          select: {
            invoice_number: true,
            created_at: true,
            gstin: true,
            pan: true,
            organization: { select: { name: true } },
            invoice_item: {
              select: {
                commission: {
                  select: {
                    commision_rate: true,
                    application: {
                      select: {
                        student: { select: { first_name: true, last_name: true } },
                        course: {
                          select: {
                            intake_month: true,
                            intake_year: true,
                            university: { select: { name: true } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const names = await userNameMap(
      payouts.flatMap((p) => [
        p.ops_approved_by_cp_user_id,
        p.verified_by_cp_user_id,
        p.released_by_cp_user_id,
      ]),
    );
    const nameOf = (id: number | null) => (id != null ? (names.get(id) ?? null) : null);
    return payouts.map((p) => ({
      id: p.id,
      partner: p.invoice.organization.name,
      invoiceNumber: p.invoice.invoice_number,
      amountInr: num(p.amount_inr),
      method: p.method,
      reference: p.reference_number,
      paymentDate: p.payment_date,
      releasedAt: p.released_at,
      submittedAt: p.invoice.created_at,
      approvedBy: nameOf(p.ops_approved_by_cp_user_id),
      approvedAt: p.ops_approved_at,
      verifiedBy: nameOf(p.verified_by_cp_user_id),
      verifiedAt: p.verified_at,
      releasedBy: nameOf(p.released_by_cp_user_id),
      checks: {
        bankConfirmed: p.verify_bank_confirmed === 1,
        invoiceVerified: p.verify_invoice_verified === 1,
        commissionVerified: p.verify_commission_verified === 1,
        duplicateCheck: p.verify_duplicate_check === 1,
      },
      bankName: p.bank_name,
      accountLast4: p.account_number_last4,
      ifsc: p.ifsc,
      swift: p.swift,
      notes: p.notes,
      gstin: p.invoice.gstin,
      pan: p.invoice.pan,
      students: p.invoice.invoice_item.map((it) => ({
        name: `${it.commission.application.student.first_name} ${it.commission.application.student.last_name}`.trim(),
        university: it.commission.application.course.university.name,
        intake: intakeOf(
          it.commission.application.course.intake_month,
          it.commission.application.course.intake_year,
        ),
        rate: num(it.commission.commision_rate),
      })),
    }));
  }),

  stats: financeProcedure.query(async () => {
    const pending = await db.partner_payout.findMany({
      where: { status: { in: PENDING_STATES } },
      select: { status: true, amount_inr: true },
    });
    // "Pending Verification" = approved + on-hold (excludes ready-to-pay & sent-back).
    const pendingSet = pending.filter(
      (p) => p.status === PayoutStatus.APPROVED || p.status === PayoutStatus.ON_HOLD,
    );
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const releasedThisMonth = await db.partner_payout.count({
      where: { status: PayoutStatus.RELEASED, released_at: { gte: monthStart } },
    });
    return {
      pendingVerification: pendingSet.length,
      readyToPay: pending.filter((p) => p.status === PayoutStatus.READY_TO_PAY).length,
      amountPending:
        Math.round(pendingSet.reduce((s, p) => s + num(p.amount_inr), 0) * 100) / 100,
      releasedThisMonth,
    };
  }),
});
