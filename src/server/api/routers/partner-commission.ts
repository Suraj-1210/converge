import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  payeeProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { encryptSecret } from "~/server/crypto";
import { optionalPanSchema, panError } from "~/lib/utils/pan";
import { auditBank, bankStatusOf, wholeSecondNow } from "~/server/bank-accounts";
import {
  independentIsIndiaBased,
  payeeData,
  payeeFromSession,
  payeeWhere,
  type Payee,
} from "~/server/payee";
import {
  PartnerInvoiceStatus,
  PayoutStatus,
  TrancheStatus,
  financialYearOf,
} from "~/server/db/enums";
import { FINANCE_CURRENCIES } from "~/lib/currency";

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
const round2 = (n: number) => Math.round(n * 100) / 100;
const orNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  if (!t) return null;
  return t;
};

// CollegePond is the invoice recipient. State code 27 = Maharashtra (Mumbai).
const CP = {
  name: "Collegepond Counsellors Pvt Ltd",
  address:
    "ML Spaces Unit 204, Opp. Old Jain Mandir, DS Road, Vile Parle West, Mumbai, Maharashtra 400056",
  gstin: "27AADCK1234F1Z5",
  state: "27",
  sac: "998399", // Other Professional, Technical and Business Services
};

// GST math (partner is the supplier billing CP): intra-state -> CGST+SGST,
// inter-state -> IGST; no GSTIN -> less TDS @2% u/s 194J. A claim paid out in
// a foreign currency carries no GST and no TDS (Suraj, 30 Oct 2026): any
// withholding is handled outside the app.
function computeTax(subtotal: number, partnerGstin: string | null, payoutCurrency = "INR") {
  if (payoutCurrency !== "INR") {
    return { isInterstate: null as boolean | null, cgst: 0, sgst: 0, igst: 0, tds: 0, netPayable: subtotal };
  }
  if (!partnerGstin) {
    const tds = round2(subtotal * 0.02);
    return {
      isInterstate: null as boolean | null,
      cgst: 0,
      sgst: 0,
      igst: 0,
      tds,
      netPayable: round2(subtotal - tds),
    };
  }
  const interstate = !partnerGstin.startsWith(CP.state);
  if (interstate) {
    const igst = round2(subtotal * 0.18);
    return { isInterstate: true, cgst: 0, sgst: 0, igst, tds: 0, netPayable: round2(subtotal + igst) };
  }
  const cgst = round2(subtotal * 0.09);
  const sgst = round2(subtotal * 0.09);
  return { isInterstate: false, cgst, sgst, igst: 0, tds: 0, netPayable: round2(subtotal + cgst + sgst) };
}

// Every procedure here is payeeProcedure (agency owner or independent;
// counsellors refused), so the money is the owner's agency's, or the
// independent counsellor's own (payee.ts). A suspended or deleted independent
// never gets here: protectedPartnerProcedure refuses them.

// Who the tax invoice is from. An agency: its name, GSTIN and PAN. An
// independent: their own name and personal PAN (no GSTIN on file; they enter
// one on the claim if they're registered). PAN is mandatory on an India-based
// independent's claim; agencies are unchanged (optional).
async function payeeProfile(payee: Payee) {
  if (payee.orgId != null) {
    const org = await db.organization.findUnique({
      where: { id: payee.orgId },
      select: { gst_number: true, pan: true, name: true },
    });
    return {
      kind: "agency" as const,
      name: org?.name ?? null,
      gstin: org?.gst_number ?? null,
      pan: org?.pan ?? null,
      panRequired: false,
    };
  }
  const u = await db.user.findUnique({
    where: { id: payee.userId },
    select: { first_name: true, last_name: true, pan: true, phone: true },
  });
  return {
    kind: "independent" as const,
    name: u ? `${u.first_name} ${u.last_name}`.trim() : null,
    gstin: null,
    pan: u?.pan ?? null,
    panRequired: u ? independentIsIndiaBased(u.phone) : false,
  };
}

// An independent's PAN is their personal one (4th character P).
function refuseNonPersonalPan(payee: Payee, pan: string | undefined): void {
  if (payee.userId == null || !pan) return;
  const msg = panError(pan, "individual");
  if (msg) throw new TRPCError({ code: "BAD_REQUEST", message: msg });
}

// A claim may only include commissions whose share Finance has stamped.
function refuseUnsetShare(comms: { partner_share_pct: unknown }[]): void {
  const n = comms.filter((c) => c.partner_share_pct == null).length;
  if (n > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Collegepond Finance hasn't set the commission share for ${n === 1 ? "one selected student" : `${n} selected students`} yet, so ${n === 1 ? "it" : "they"} can't be claimed. Remove ${n === 1 ? "it" : "them"} and claim the rest, or try again once it's set.`,
    });
  }
}

const studentCode = (id: number) => `CP-${String(id).padStart(5, "0")}`;

// The currency an account is paid in: INR into a domestic account; an
// international one picks it on the bank-details form (null = not picked yet,
// accounts saved before 30 Oct 2026).
const payoutCurrencyOf = (b: { region: number; payout_currency: string | null }): string | null =>
  b.region === 1 ? b.payout_currency : "INR";

// How a tranche reads to the partner. "pending" covers everything before
// Collegepond's collection is approved (a recorded-but-unapproved collection
// isn't the partner's to claim yet).
type PartnerTrancheState = "pending" | "claimable" | "claimed" | "paid";
function partnerTrancheState(status: number, onInvoice: boolean): PartnerTrancheState {
  if (status === TrancheStatus.PAID) return "paid";
  if (status === TrancheStatus.RECEIVED) return onInvoice ? "claimed" : "claimable";
  return "pending";
}

// One status for the whole student, from its tranches — the same rule the
// list pill, "Paid to partner", the timeline and the invoice history read.
type PartnerCommissionState = "pending" | "claimable" | "claimed" | "part_paid" | "paid";
function partnerCommissionState(states: PartnerTrancheState[]): PartnerCommissionState {
  if (states.length === 0) return "pending";
  if (states.every((s) => s === "paid")) return "paid";
  if (states.some((s) => s === "claimable")) return "claimable";
  if (states.some((s) => s === "claimed")) return "claimed";
  if (states.some((s) => s === "paid")) return "part_paid";
  return "pending";
}

// The payout a partner sees on their invoice history: how and when it was
// paid, and the reference to quote to their bank.
type PayoutRow = {
  status: number;
  reference_number: string | null;
  utr: string | null;
  payment_date: Date | null;
  currency: string | null;
  amount_foreign: { toNumber: () => number } | null;
  exchange_rate: { toNumber: () => number } | null;
  amount_inr: { toNumber: () => number };
};
const payoutSelect = {
  status: true,
  reference_number: true,
  utr: true,
  payment_date: true,
  currency: true,
  amount_foreign: true,
  exchange_rate: true,
  amount_inr: true,
} as const;
function partnerPayoutView(p: PayoutRow | null) {
  if (p?.status !== PayoutStatus.RELEASED) return null;
  return {
    reference: p.utr ?? p.reference_number,
    paymentDate: p.payment_date,
    amountInr: num(p.amount_inr),
    currency: p.currency ?? "INR",
    amountForeign: p.amount_foreign == null ? null : num(p.amount_foreign),
    exchangeRate: p.exchange_rate == null ? null : num(p.exchange_rate),
  };
}

// Partner invoice numbers are unique across ALL partners (a schema rule), so
// a number another partner already used is refused with a clear message
// rather than Prisma's P2002.
function prismaCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}
const invoiceNumberTaken = (n: string) =>
  new TRPCError({
    code: "CONFLICT",
    message: `Invoice number ${n} is already in use — use a different number.`,
  });

export const partnerCommissionRouter = createTRPCRouter({
  // Every commission for the partner (agency or independent), with one set of
  // figures the whole page reads (testers, 29 Oct 2026): Tuition, Commission
  // (flat or %), Your share % and amount, Received by Collegepond, Claimable
  // now, Claimed and Paid — all the partner's share, in INR once collected —
  // and a per-tranche breakdown whose states drive the list status, "Paid to
  // partner", the timeline and the invoice history alike.
  listClaimable: payeeProcedure.query(async ({ ctx }) => {
    const payee = payeeFromSession(ctx.payee);
    const comms = await db.commission.findMany({
      where: payeeWhere(payee),
      orderBy: { id: "desc" },
      include: {
        application: {
          select: {
            university_app_id: true,
            student: { select: { id: true, first_name: true, last_name: true } },
            course: {
              select: {
                name: true,
                intake_month: true,
                intake_year: true,
                university: { select: { name: true, country: true } },
              },
            },
          },
        },
        // The vendor invoice's currency: what a collected tranche's foreign
        // amount is in.
        vendor_invoice_item: { select: { vendor_invoice: { select: { currency: true } } } },
        // Legacy single-invoice rows (no tranche) — kept for pre-tranche commissions.
        invoice_item: {
          where: { commission_tranche_id: null },
          select: { invoice: { select: { invoice_number: true, status: true } } },
        },
        // Pay-as-collected: claimability is per tranche.
        commission_tranche: {
          orderBy: { seq: "asc" },
          select: {
            seq: true,
            name: true,
            status: true,
            amount: true, // planned (commission-currency) slice — used before collection
            amount_inr: true, // realised INR — set once collected from the vendor
            vendor_payment_id: true,
            disbursed_at: true,
            invoice_item: {
              select: { invoice: { select: { invoice_number: true, status: true } } },
            },
          },
        },
      },
    });
    // The rate each collected tranche was booked at.
    const paymentIds = Array.from(
      new Set(comms.flatMap((c) => c.commission_tranche.map((t) => t.vendor_payment_id)).filter((x): x is number => x != null)),
    );
    const rates = new Map(
      (paymentIds.length > 0
        ? await db.vendor_payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, exchange_rate: true } })
        : []
      ).map((p) => [p.id, num(p.exchange_rate)]),
    );

    return comms.map((c) => {
      // The share is stamped from the partner's tier when Finance confirms the
      // student. Without one the amount is unknown and it can't be claimed —
      // never treated as 100%.
      const partnerSharePct = c.partner_share_pct == null ? null : num(c.partner_share_pct);
      const share = (gross: number) =>
        partnerSharePct == null ? 0 : round2(gross * (partnerSharePct / 100));
      // On a third-party deal Collegepond gets only its CP share of the gross;
      // the partner's share is of that.
      const cpFrac = c.cp_share_pct == null ? 1 : num(c.cp_share_pct) / 100;
      const gross = num(c.commision_amount);
      const fxCurrency = c.vendor_invoice_item?.vendor_invoice.currency ?? c.currency;
      const legacyRate = c.received_fx_rate == null ? null : num(c.received_fx_rate);

      // Legacy (pre-tranche) commissions read as a single tranche.
      const legacyState: PartnerTrancheState =
        c.partner_paid_at != null
          ? "paid"
          : c.invoice_item.length > 0
            ? "claimed"
            : c.collegepond_received_at != null
              ? "claimable"
              : "pending";
      const tranches =
        c.commission_tranche.length > 0
          ? c.commission_tranche.map((t) => {
              const state = partnerTrancheState(t.status, t.invoice_item != null);
              const collected = state !== "pending";
              const rate = t.vendor_payment_id != null ? (rates.get(t.vendor_payment_id) ?? null) : legacyRate;
              const amountInr = collected ? share(num(t.amount_inr)) : 0;
              return {
                seq: t.seq,
                name: t.name ?? `Tranche ${t.seq}`,
                state,
                amountInr,
                // The foreign amount behind the INR, at the rate it was booked.
                foreign: collected && rate ? { amount: round2(amountInr / rate), currency: fxCurrency, rate } : null,
                plannedForeign: share(round2(num(t.amount) * cpFrac)),
                invoiceNumber: t.invoice_item?.invoice.invoice_number ?? null,
                invoiceStatus: t.invoice_item?.invoice.status ?? null,
                paidAt: t.disbursed_at,
              };
            })
          : [
              {
                seq: 1,
                name: "Full commission",
                state: legacyState,
                amountInr: legacyState === "pending" ? 0 : share(num(c.claimable_inr)),
                foreign:
                  legacyState !== "pending" && legacyRate
                    ? { amount: round2(share(num(c.claimable_inr)) / legacyRate), currency: fxCurrency, rate: legacyRate }
                    : null,
                plannedForeign: share(round2(gross * cpFrac)),
                invoiceNumber: c.invoice_item[0]?.invoice.invoice_number ?? null,
                invoiceStatus: c.invoice_item[0]?.invoice.status ?? null,
                paidAt: c.partner_paid_at,
              },
            ];
      const sum = (pred: (s: PartnerTrancheState) => boolean) =>
        round2(tranches.filter((t) => pred(t.state)).reduce((s, t) => s + t.amountInr, 0));
      const status = partnerCommissionState(tranches.map((t) => t.state));
      const paidCount = tranches.filter((t) => t.state === "paid").length;
      const received = tranches.filter((t) => t.state !== "pending");
      // Blended rate across the collected tranches, for the headline FX line.
      const receivedForeign = received.reduce((s, t) => s + (t.foreign?.amount ?? 0), 0);
      const intake =
        [c.application.course.intake_month, c.application.course.intake_year]
          .filter(Boolean)
          .join(" ") || null;
      const isFlat = num(c.commision_rate) === 0;
      const lastPaid = tranches.map((t) => t.paidAt).filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return {
        commissionId: c.id,
        universityStudentId: c.application.university_app_id,
        studentCode: studentCode(c.application.student.id),
        studentName:
          `${c.application.student.first_name} ${c.application.student.last_name}`.trim(),
        university: c.application.course.university.name,
        country: c.application.course.university.country,
        program: c.application.course.name,
        intake,
        currency: c.currency,
        tuitionCurrency: c.tuition_currency ?? c.currency,
        tuition: num(c.tuition_fee),
        isFlat,
        commissionRate: num(c.commision_rate),
        commissionAmount: gross,
        partnerSharePct,
        sharePending: partnerSharePct == null,
        // Your share of what Collegepond will receive, in the commission currency.
        shareAmount: share(round2(gross * cpFrac)),
        // The partner's share, INR: collected by Collegepond (approved),
        // claimable now, on a claim not yet paid, and paid.
        receivedInr: sum((s) => s !== "pending"),
        receivedFx:
          receivedForeign > 0 && received.every((t) => t.foreign)
            ? {
                amount: round2(receivedForeign),
                currency: fxCurrency,
                rate: round2((sum((s) => s !== "pending") / receivedForeign) * 100) / 100,
              }
            : null,
        claimableInr: sum((s) => s === "claimable"),
        claimedInr: sum((s) => s === "claimed"),
        paidInr: sum((s) => s === "paid"),
        receivedAt: c.collegepond_received_at,
        // Paid to partner: every tranche paid → the last payout date.
        paidAt: status === "paid" ? lastPaid : null,
        paidCount,
        trancheCount: tranches.length,
        tranches,
        status,
        selectable: status === "claimable" && partnerSharePct != null,
      };
    });
  }),

  // The partner's saved payout account. The raw account number / GSTIN / PAN are
  // encrypted at rest (crypto.ts); only the masked last-4 reaches the client.
  bankAccount: payeeProcedure.query(async ({ ctx }) => {
    const payee = payeeFromSession(ctx.payee);
    const [acct, profile] = await Promise.all([
      db.partner_bank_account.findFirst({ where: payeeWhere(payee), orderBy: { id: "desc" } }),
      payeeProfile(payee),
    ]);
    return {
      hasAccount: acct != null,
      region: acct?.region === 1 ? ("international" as const) : ("domestic" as const),
      // What claims are paid out in (INR for a domestic account).
      payoutCurrency: acct ? payoutCurrencyOf(acct) : "INR",
      accountHolder: acct?.account_holder ?? null,
      // Partners only ever see the last 4 digits.
      accountNumberLast4: acct?.account_number_last4 ?? null,
      ifsc: acct?.ifsc ?? null,
      swift: acct?.swift ?? null,
      ibanLast4: acct?.iban ? acct.iban.slice(-4) : null,
      bankName: acct?.bank_name ?? null,
      branch: acct?.branch ?? null,
      bankCountry: acct?.bank_country ?? null,
      bankAddress: acct?.bank_address ?? null,
      accountType: acct?.account_type ?? null,
      hasProof: Boolean(acct?.proof_url),
      proofFileName: acct?.proof_file_name ?? null,
      // Finance checks the proof before any payout; partners see the state
      // (pending / verified / rejected, with finance's reason).
      verified: acct?.is_verified === 1,
      status: acct ? bankStatusOf(acct) : null,
      rejectionReason: acct?.rejected_at ? acct.rejection_reason : null,
      submittedAt: acct?.submitted_at ?? null,
      // GSTIN/PAN are shown on the tax invoice — kept here for the wizard. (The
      // org's gst_number is the non-encrypted source; the encrypted copy on the
      // account is for the payout side.)
      gstin: profile.gstin,
      // PAN captured at signup, to prefill the invoice.
      pan: profile.pan,
      // The invoice's "From": the agency, or the independent counsellor.
      orgName: profile.name,
      payeeKind: profile.kind,
      panHolder: profile.kind === "agency" ? ("agency" as const) : ("individual" as const),
      panRequired: profile.panRequired,
    };
  }),

  // Domestic accounts need an IFSC and a cancelled cheque; international ones
  // a SWIFT/BIC, bank country and address, and a bank letter or statement.
  // Any save puts the account back to "pending": it joins finance's Bank
  // Verifications queue (and the admin bell), and no payout goes to it until
  // finance verifies it. Every save is audit-logged with the old and new
  // last 4 digits.
  saveBankAccount: payeeProcedure
    .input(
      z
        .object({
          region: z.enum(["domestic", "international"]).default("domestic"),
          accountHolder: z.string().trim().min(1).max(150),
          accountNumber: z.string().trim().min(4).max(34),
          ifsc: z.string().trim().toUpperCase().max(15).optional(),
          swift: z.string().trim().toUpperCase().max(15).optional(),
          iban: z.string().trim().toUpperCase().max(34).optional(),
          bankName: z.string().trim().min(1, "Bank name is required").max(150),
          branch: z.string().trim().max(150).optional(),
          bankCountry: z.string().trim().toUpperCase().length(2).optional(),
          bankAddress: z.string().trim().max(255).optional(),
          // International accounts: the currency the partner is paid in.
          payoutCurrency: z.enum(FINANCE_CURRENCIES).optional(),
          accountType: z.string().trim().max(30).optional(),
          // Key from /api/upload (folder bank-proofs).
          proofUrl: z
            .string()
            .max(500)
            .refine((u) => /^(\/uploads\/)?bank-proofs\//.test(u), "Upload the cancelled cheque / bank letter"),
          proofFileName: z.string().trim().max(255).optional(),
          gstin: z.string().trim().max(20).optional(),
          // Validated like signup; the org PAN rule (company / firm / proprietor).
          pan: optionalPanSchema("agency"),
        })
        .superRefine((v, ctx) => {
          if (v.region === "domestic") {
            if (!v.ifsc || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.ifsc)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ifsc"], message: "Enter a valid IFSC (e.g. HDFC0001234)" });
            }
          } else {
            if (!v.swift || !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.swift)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["swift"], message: "Enter a valid SWIFT/BIC (8 or 11 characters)" });
            }
            if (!v.bankCountry) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bankCountry"], message: "Select the bank's country" });
            }
            if (!v.bankAddress?.trim()) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bankAddress"], message: "Enter the bank's address" });
            }
            if (!v.payoutCurrency) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payoutCurrency"], message: "Pick the currency you want to be paid in" });
            }
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const payee = payeeFromSession(ctx.payee);
      refuseNonPersonalPan(payee, input.pan);
      const intl = input.region === "international";
      const last4 = input.accountNumber.slice(-4);
      const data = {
        region: intl ? 1 : 0,
        payout_currency: intl ? (input.payoutCurrency ?? null) : "INR",
        account_holder: input.accountHolder,
        account_number_enc: encryptSecret(input.accountNumber),
        account_number_last4: last4,
        ifsc: intl ? null : orNull(input.ifsc),
        swift: intl ? orNull(input.swift) : null,
        iban: intl ? orNull(input.iban) : null,
        bank_name: input.bankName,
        branch: orNull(input.branch),
        bank_country: intl ? (input.bankCountry ?? null) : "IN",
        bank_address: intl ? orNull(input.bankAddress) : null,
        account_type: orNull(input.accountType),
        proof_url: input.proofUrl,
        proof_file_name: orNull(input.proofFileName),
        gstin_enc: input.gstin?.trim() ? encryptSecret(input.gstin.trim()) : null,
        pan_enc: input.pan ? encryptSecret(input.pan) : null,
        // New details → pending until finance checks them again (a previous
        // rejection no longer applies), and any RazorpayX token for the old
        // account no longer applies either.
        submitted_at: wholeSecondNow(),
        is_verified: 0,
        verified_at: null,
        verified_by_cp_user_id: null,
        verification_note: null,
        rejected_at: null,
        rejected_by_cp_user_id: null,
        rejection_reason: null,
        provider_contact_id: null,
        provider_fund_account_id: null,
      };
      const existing = await db.partner_bank_account.findFirst({
        where: payeeWhere(payee),
        select: { id: true, account_number_last4: true, is_verified: true, rejected_at: true, region: true, payout_currency: true },
      });
      const savedSelect = { id: true, org_id: true, payee_user_id: true } as const;
      const saved = existing
        ? await db.partner_bank_account.update({ where: { id: existing.id }, data, select: savedSelect })
        : await db.partner_bank_account.create({ data: { ...payeeData(payee), ...data }, select: savedSelect });
      await auditBank(
        "bank.details_saved",
        saved,
        {
          hadAccount: existing != null,
          oldLast4: existing?.account_number_last4 ?? null,
          newLast4: last4,
          region: data.region === 1 ? "international" : "domestic",
          oldPayoutCurrency: existing ? payoutCurrencyOf(existing) : null,
          newPayoutCurrency: data.payout_currency,
          previousStatus: existing ? bankStatusOf(existing) : null,
        },
        ctx.cpPartner.id,
      );
      return { success: true as const };
    }),

  // Generate a GST tax invoice for the selected claimable commissions.
  generateInvoice: payeeProcedure
    .input(
      z.object({
        commissionIds: z.array(z.number().int().positive()).min(1),
        invoiceNumber: z.string().trim().min(1).max(30),
        invoiceDate: z.string(),
        // The partner ticked "these bank details are correct" in the
        // confirmation pop-up before submitting.
        bankDetailsConfirmed: z.literal(true, {
          errorMap: () => ({ message: "Please confirm your bank details before submitting." }),
        }),
        gstin: z.string().trim().max(20).optional(),
        // Validated like signup; the org PAN rule (company / firm / proprietor).
        pan: optionalPanSchema("agency"),
        signatoryName: z.string().trim().min(1).max(100),
        signatoryDesignation: z.string().trim().max(100).optional(),
        notes: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const payee = payeeFromSession(ctx.payee);
      const bank = await db.partner_bank_account.findFirst({
        where: payeeWhere(payee),
        orderBy: { id: "desc" },
        select: { id: true, account_number_last4: true, ifsc: true, swift: true, region: true, payout_currency: true, bank_name: true, account_holder: true, proof_url: true, rejected_at: true, rejection_reason: true },
      });
      // A claim is paid into the account on file, so it needs one — with the
      // cheque / bank letter finance will check before paying.
      if (!bank?.proof_url) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Add your bank details and upload a cancelled cheque (or bank letter) before submitting a claim.",
        });
      }
      // Finance rejected these details: they can't be paid into, so the claim
      // would only stall at release.
      if (bank.rejected_at) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Our finance team couldn't verify your bank details${bank.rejection_reason ? ` (${bank.rejection_reason})` : ""}. Update them in My Account before submitting a claim.`,
        });
      }
      // The claim is paid in the account's currency (a snapshot on the invoice).
      const payoutCurrency = payoutCurrencyOf(bank);
      if (!payoutCurrency) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose the currency you're paid in (My Account → Bank Details) before submitting a claim.",
        });
      }

      // An independent invoices on their personal PAN. India-based: required.
      // Elsewhere optional; a claim without one is flagged for Finance review
      // (partnerPayouts / reconciliation), not blocked.
      refuseNonPersonalPan(payee, input.pan);
      if (payee.userId != null && !input.pan && (await payeeProfile(payee)).panRequired) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter your PAN to submit a claim. It's needed for the TDS deducted on your commission.",
        });
      }

      const comms = await db.commission.findMany({
        where: { id: { in: input.commissionIds }, ...payeeWhere(payee) },
        select: {
          id: true,
          partner_share_pct: true,
          // Only RECEIVED ("available to claim") tranches not already on an invoice.
          commission_tranche: {
            where: { status: TrancheStatus.RECEIVED, invoice_item: { is: null } },
            select: { id: true, amount_inr: true },
          },
        },
      });
      if (comms.length !== input.commissionIds.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Some claims are no longer available." });
      }
      if (comms.some((c) => c.commission_tranche.length === 0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A selected student has no collected tranche to claim yet.",
        });
      }

      refuseUnsetShare(comms);

      // One invoice line per claimed tranche (pay-as-collected).
      const lineItems = comms.flatMap((c) => {
        const sharePct = num(c.partner_share_pct);
        return c.commission_tranche.map((t) => ({
          commissionId: c.id,
          trancheId: t.id,
          amount: round2(num(t.amount_inr) * (sharePct / 100)),
        }));
      });
      const subtotal = round2(lineItems.reduce((s, l) => s + l.amount, 0));
      const partnerGstin = orNull(input.gstin);
      const tax = computeTax(subtotal, partnerGstin, payoutCurrency);

      const taken = await db.invoice.findUnique({
        where: { invoice_number: input.invoiceNumber },
        select: { id: true },
      });
      if (taken) throw invoiceNumberTaken(input.invoiceNumber);
      const created = await db.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            invoice_number: input.invoiceNumber,
            invoice_date: new Date(input.invoiceDate),
            total_amount: subtotal,
            // Amounts are INR; payout_currency is what it's paid out in.
            currency: "INR",
            payout_currency: payoutCurrency,
            status: PartnerInvoiceStatus.SUBMITTED,
            ...payeeData(payee),
            gstin: partnerGstin,
            pan: orNull(input.pan),
            sac_code: CP.sac,
            is_interstate: tax.isInterstate == null ? null : tax.isInterstate ? 1 : 0,
            cgst_amount: tax.cgst,
            sgst_amount: tax.sgst,
            igst_amount: tax.igst,
            tds_amount: tax.tds,
            net_payable: tax.netPayable,
            signed_at: new Date(),
            signatory_name: input.signatoryName,
            signatory_designation: orNull(input.signatoryDesignation),
            notes: orNull(input.notes),
            bank_account_id: bank?.id ?? null,
            bank_details: bank
              ? `${bank.bank_name ?? ""} ${(bank.region === 1 ? bank.swift : bank.ifsc) ?? ""} ****${bank.account_number_last4 ?? ""}`.trim()
              : null,
          },
        });
        await tx.invoice_item.createMany({
          data: lineItems.map((l) => ({
            invoice_id: inv.id,
            commission_id: l.commissionId,
            commission_tranche_id: l.trancheId,
            amount: l.amount,
          })),
        });
        return inv;
      }).catch((e: unknown) => {
        // Lost a race for the number; a tranche claimed twice at once also
        // lands here (uq_invoice_item_tranche).
        if (prismaCode(e) === "P2002") {
          const detail = `${JSON.stringify((e as { meta?: unknown }).meta ?? null)} ${(e as Error).message}`;
          if (detail.includes("invoice_number")) throw invoiceNumberTaken(input.invoiceNumber);
          throw new TRPCError({
            code: "CONFLICT",
            message: "One of these tranches was just claimed on another invoice. Refresh and try again.",
          });
        }
        throw e;
      });
      return { invoiceId: created.id, netPayable: tax.netPayable, payoutCurrency };
    }),

  // Tax preview for the wizard (no write).
  taxPreview: payeeProcedure
    .input(z.object({ commissionIds: z.array(z.number().int().positive()), gstin: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const payee = payeeFromSession(ctx.payee);
      const [comms, bank] = await Promise.all([
        db.commission.findMany({
          where: { id: { in: input.commissionIds }, ...payeeWhere(payee) },
          select: {
            partner_share_pct: true,
            commission_tranche: {
              where: { status: TrancheStatus.RECEIVED, invoice_item: { is: null } },
              select: { amount_inr: true },
            },
          },
        }),
        db.partner_bank_account.findFirst({
          where: payeeWhere(payee),
          orderBy: { id: "desc" },
          select: { region: true, payout_currency: true },
        }),
      ]);
      refuseUnsetShare(comms);
      const payoutCurrency = bank ? payoutCurrencyOf(bank) : "INR";
      const subtotal = round2(
        comms.reduce((s, c) => {
          const sharePct = num(c.partner_share_pct);
          const gross = c.commission_tranche.reduce((a, t) => a + num(t.amount_inr), 0);
          return s + round2(gross * (sharePct / 100));
        }, 0),
      );
      return {
        subtotal,
        ...computeTax(subtotal, orNull(input.gstin), payoutCurrency ?? "INR"),
        // Non-INR: no GST / TDS; the foreign amount is fixed when it's paid.
        payoutCurrency,
        cpName: CP.name,
        cpAddress: CP.address,
        cpGstin: CP.gstin,
        sac: CP.sac,
      };
    }),

  // Per-commission detail for the student modal: the milestones and EVERY
  // invoice that claims part of it (one per claimed tranche), newest first,
  // each with this student's lines and — once paid — the payment reference,
  // date and any foreign amount. Rejected claims' lines were released, so
  // they no longer appear here (the partner sees them in Invoice History).
  studentDetail: payeeProcedure
    .input(z.object({ commissionId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const payee = payeeFromSession(ctx.payee);
      const c = await db.commission.findFirst({
        where: { id: input.commissionId, ...payeeWhere(payee) },
        include: {
          application: { select: { created_at: true } },
          invoice_item: {
            orderBy: { id: "asc" },
            select: {
              amount: true,
              commission_tranche: { select: { seq: true, name: true } },
              invoice: {
                select: {
                  id: true,
                  invoice_number: true,
                  invoice_date: true,
                  created_at: true,
                  total_amount: true,
                  net_payable: true,
                  status: true,
                  payout_currency: true,
                  partner_payout: { select: payoutSelect },
                },
              },
            },
          },
        },
      });
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Commission not found" });
      const byInvoice = new Map<
        number,
        {
          id: number;
          number: string;
          date: Date;
          submittedAt: Date;
          status: number;
          payoutCurrency: string;
          totalAmount: number;
          netPayable: number;
          studentAmount: number;
          tranches: string[];
          payout: ReturnType<typeof partnerPayoutView>;
        }
      >();
      for (const it of c.invoice_item) {
        const inv = it.invoice;
        const e = byInvoice.get(inv.id) ?? {
          id: inv.id,
          number: inv.invoice_number,
          date: inv.invoice_date,
          submittedAt: inv.created_at,
          status: inv.status,
          payoutCurrency: inv.payout_currency ?? "INR",
          totalAmount: num(inv.total_amount),
          netPayable: inv.net_payable == null ? num(inv.total_amount) : num(inv.net_payable),
          studentAmount: 0,
          tranches: [],
          payout: partnerPayoutView(inv.partner_payout),
        };
        e.studentAmount = round2(e.studentAmount + num(it.amount));
        e.tranches.push(it.commission_tranche?.name ?? (it.commission_tranche ? `Tranche ${it.commission_tranche.seq}` : "Full commission"));
        byInvoice.set(inv.id, e);
      }
      const invoices = Array.from(byInvoice.values()).sort(
        (a, b) => b.date.getTime() - a.date.getTime() || b.id - a.id,
      );
      return {
        appSubmittedAt: c.application.created_at,
        commissionCreatedAt: c.created_at,
        receivedAt: c.collegepond_received_at,
        invoices,
      };
    }),

  // Per-financial-year aggregates for the year-over-year card + the loyalty tier
  // (tier is derived from the count of students in the current FY). Earned is
  // the partner's share of every tranche CP has collected; paid, of every
  // tranche paid out. Pre-tranche rows fall back to the commission-level
  // claimable_inr and partner_paid_at.
  yearlyStats: payeeProcedure.query(async ({ ctx }) => {
    const payee = payeeFromSession(ctx.payee);
    const comms = await db.commission.findMany({
      where: payeeWhere(payee),
      select: {
        created_at: true,
        partner_paid_at: true,
        claimable_inr: true,
        partner_share_pct: true,
        commission_tranche: { select: { status: true, amount_inr: true } },
      },
    });
    const byFy = new Map<number, { students: number; earned: number; paid: number }>();
    for (const c of comms) {
      const fy = financialYearOf(c.created_at);
      // No stamped share yet: nothing is earned on it until Finance sets one.
      const share = c.partner_share_pct == null ? 0 : num(c.partner_share_pct);
      const e = byFy.get(fy) ?? { students: 0, earned: 0, paid: 0 };
      e.students += 1;
      if (c.commission_tranche.length > 0) {
        for (const t of c.commission_tranche) {
          const part = round2((num(t.amount_inr) * share) / 100);
          if (t.status === TrancheStatus.RECEIVED || t.status === TrancheStatus.PAID) e.earned += part;
          if (t.status === TrancheStatus.PAID) e.paid += part;
        }
      } else {
        const claimable = round2((num(c.claimable_inr) * share) / 100);
        e.earned += claimable;
        if (c.partner_paid_at != null) e.paid += claimable;
      }
      byFy.set(fy, e);
    }
    return Array.from(byFy.entries())
      .map(([fy, v]) => ({
        fy,
        students: v.students,
        earned: round2(v.earned),
        paid: round2(v.paid),
      }))
      .sort((a, b) => a.fy - b.fy);
  }),

  // Every claim, newest first, with how and when it was paid: the payment
  // reference / UTR to quote to the bank, the date, and — for a foreign
  // payout — the amount sent and the rate.
  invoiceHistory: payeeProcedure.query(async ({ ctx }) => {
    const payee = payeeFromSession(ctx.payee);
    const invoices = await db.invoice.findMany({
      where: payeeWhere(payee),
      orderBy: [{ invoice_date: "desc" }, { id: "desc" }],
      include: {
        invoice_item: { select: { commission_id: true } },
        partner_payout: { select: payoutSelect },
      },
    });
    return invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      students: new Set(inv.invoice_item.map((it) => it.commission_id)).size,
      totalAmount: num(inv.total_amount),
      netPayable: inv.net_payable == null ? num(inv.total_amount) : num(inv.net_payable),
      payoutCurrency: inv.payout_currency ?? "INR",
      status: inv.status,
      rejectionReason: inv.rejection_reason,
      payout: partnerPayoutView(inv.partner_payout),
    }));
  }),
});
