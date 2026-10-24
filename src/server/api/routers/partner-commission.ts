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
  TrancheStatus,
  financialYearOf,
} from "~/server/db/enums";

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
// inter-state -> IGST; no GSTIN -> less TDS @2% u/s 194J.
function computeTax(subtotal: number, partnerGstin: string | null) {
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
  // Every commission for the partner (agency or independent), with a derived
  // claim status.
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
            invoice_item: {
              select: { invoice: { select: { invoice_number: true, status: true } } },
            },
          },
        },
      },
    });

    return comms.map((c) => {
      // The share is stamped from the partner's tier when Finance confirms the
      // student. Without one the amount is unknown and it can't be claimed —
      // never treated as 100%.
      const partnerSharePct = c.partner_share_pct == null ? null : num(c.partner_share_pct);
      const share = (gross: number) =>
        partnerSharePct == null ? 0 : round2(gross * (partnerSharePct / 100));
      const tranches = c.commission_tranche;

      let claimableGross: number;
      let status: "pending" | "claimable" | "invoiced" | "paid";
      let invoice: { invoice_number: string; status: number } | null;

      if (tranches.length > 0) {
        // RECEIVED ("available to claim") tranches not yet on an invoice.
        const claimable = tranches.filter(
          (t) => t.status === TrancheStatus.RECEIVED && t.invoice_item == null,
        );
        const claimed = tranches.filter((t) => t.invoice_item != null);
        claimableGross = claimable.reduce((s, t) => s + num(t.amount_inr), 0);
        status =
          claimable.length > 0
            ? "claimable"
            : tranches.every((t) => t.status === TrancheStatus.PAID)
              ? "paid"
              : claimed.length > 0
                ? "invoiced"
                : "pending";
        invoice = claimed[claimed.length - 1]?.invoice_item?.invoice ?? null;
      } else {
        // Legacy (pre-tranche) commission — commission-level claimability.
        claimableGross = num(c.claimable_inr);
        status =
          c.partner_paid_at != null
            ? "paid"
            : c.invoice_item.length > 0
              ? "invoiced"
              : c.collegepond_received_at != null
                ? "claimable"
                : "pending";
        invoice = c.invoice_item[0]?.invoice ?? null;
      }

      const claimable = share(claimableGross);
      const intake =
        [c.application.course.intake_month, c.application.course.intake_year]
          .filter(Boolean)
          .join(" ") || null;
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
        tuition: num(c.tuition_fee),
        commissionRate: num(c.commision_rate),
        commissionAmount: num(c.commision_amount),
        partnerSharePct,
        claimableInr: claimable,
        cpCommissionInr: partnerSharePct == null ? 0 : round2(claimableGross - claimable),
        sharePending: partnerSharePct == null,
        receivedAt: c.collegepond_received_at,
        paidAt: c.partner_paid_at,
        // Per-tranche breakdown for the UI (empty for legacy commissions). Both
        // amounts are the partner's share: amountInr is the realised INR (known
        // only once collected); plannedForeign is the commission-currency slice
        // shown for not-yet-collected tranches (INR isn't locked until the FX hits).
        tranches: tranches.map((t) => ({
          seq: t.seq,
          name: t.name,
          status: t.status,
          amountInr: share(num(t.amount_inr)),
          plannedForeign: share(num(t.amount)),
          claimed: t.invoice_item != null,
        })),
        invoiceNumber: invoice?.invoice_number ?? null,
        invoiceStatus: invoice?.status ?? null,
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
        select: { id: true, account_number_last4: true, is_verified: true, rejected_at: true },
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
        select: { id: true, account_number_last4: true, ifsc: true, bank_name: true, account_holder: true, proof_url: true, rejected_at: true, rejection_reason: true },
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
      const tax = computeTax(subtotal, partnerGstin);

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
            currency: "INR",
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
              ? `${bank.bank_name ?? ""} ${bank.ifsc ?? ""} ****${bank.account_number_last4 ?? ""}`.trim()
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
      return { invoiceId: created.id, netPayable: tax.netPayable };
    }),

  // Tax preview for the wizard (no write).
  taxPreview: payeeProcedure
    .input(z.object({ commissionIds: z.array(z.number().int().positive()), gstin: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const payee = payeeFromSession(ctx.payee);
      const comms = await db.commission.findMany({
        where: { id: { in: input.commissionIds }, ...payeeWhere(payee) },
        select: {
          partner_share_pct: true,
          commission_tranche: {
            where: { status: TrancheStatus.RECEIVED, invoice_item: { is: null } },
            select: { amount_inr: true },
          },
        },
      });
      refuseUnsetShare(comms);
      const subtotal = round2(
        comms.reduce((s, c) => {
          const sharePct = num(c.partner_share_pct);
          const gross = c.commission_tranche.reduce((a, t) => a + num(t.amount_inr), 0);
          return s + round2(gross * (sharePct / 100));
        }, 0),
      );
      return {
        subtotal,
        ...computeTax(subtotal, orNull(input.gstin)),
        cpName: CP.name,
        cpAddress: CP.address,
        cpGstin: CP.gstin,
        sac: CP.sac,
      };
    }),

  // Per-commission detail for the student modal: payment timeline + its invoice.
  studentDetail: payeeProcedure
    .input(z.object({ commissionId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const payee = payeeFromSession(ctx.payee);
      const c = await db.commission.findFirst({
        where: { id: input.commissionId, ...payeeWhere(payee) },
        include: {
          application: { select: { created_at: true } },
          invoice_item: {
            select: {
              invoice: {
                select: {
                  invoice_number: true,
                  invoice_date: true,
                  total_amount: true,
                  net_payable: true,
                  status: true,
                },
              },
            },
          },
        },
      });
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Commission not found" });
      // A commission can now span several invoices (one per claimed tranche) —
      // show the most recent for the detail view.
      const inv = c.invoice_item.at(-1)?.invoice ?? null;
      return {
        appSubmittedAt: c.application.created_at,
        commissionCreatedAt: c.created_at,
        receivedAt: c.collegepond_received_at,
        invoicedAt: inv?.invoice_date ?? null,
        paidAt: c.partner_paid_at,
        invoice: inv
          ? {
              number: inv.invoice_number,
              date: inv.invoice_date,
              amount: num(inv.total_amount),
              netPayable: inv.net_payable == null ? num(inv.total_amount) : num(inv.net_payable),
              status: inv.status,
            }
          : null,
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

  invoiceHistory: payeeProcedure.query(async ({ ctx }) => {
    const payee = payeeFromSession(ctx.payee);
    const invoices = await db.invoice.findMany({
      where: payeeWhere(payee),
      orderBy: { invoice_date: "desc" },
      include: { invoice_item: { select: { id: true } } },
    });
    return invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      students: inv.invoice_item.length,
      totalAmount: num(inv.total_amount),
      netPayable: inv.net_payable == null ? num(inv.total_amount) : num(inv.net_payable),
      status: inv.status,
      rejectionReason: inv.rejection_reason,
    }));
  }),
});
