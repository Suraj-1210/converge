import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { encryptSecret } from "~/server/crypto";
import { optionalPanSchema } from "~/lib/utils/pan";
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

async function requireOrgId(cpPartnerId: number): Promise<number> {
  const u = await db.user.findUnique({
    where: { id: cpPartnerId },
    select: { org_id: true },
  });
  if (!u?.org_id) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Your account isn't linked to an organization, so invoices can't be raised yet.",
    });
  }
  return u.org_id;
}

const studentCode = (id: number) => `CP-${String(id).padStart(5, "0")}`;

export const partnerCommissionRouter = createTRPCRouter({
  // Every commission for the partner's org, with a derived claim status.
  listClaimable: protectedPartnerProcedure.query(async ({ ctx }) => {
    const orgId = await requireOrgId(ctx.cpPartner.id);
    const comms = await db.commission.findMany({
      where: { org_id: orgId },
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
      const partnerSharePct = c.partner_share_pct == null ? 100 : num(c.partner_share_pct);
      const share = (gross: number) => round2(gross * (partnerSharePct / 100));
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
        cpCommissionInr: round2(claimableGross - claimable),
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
        selectable: status === "claimable",
      };
    });
  }),

  // The partner's saved payout account. The raw account number / GSTIN / PAN are
  // encrypted at rest (crypto.ts); only the masked last-4 reaches the client.
  bankAccount: protectedPartnerProcedure.query(async ({ ctx }) => {
    const orgId = await requireOrgId(ctx.cpPartner.id);
    const [acct, org] = await Promise.all([
      db.partner_bank_account.findFirst({ where: { org_id: orgId }, orderBy: { id: "desc" } }),
      db.organization.findUnique({ where: { id: orgId }, select: { gst_number: true, pan: true, name: true } }),
    ]);
    return {
      hasAccount: acct != null,
      accountHolder: acct?.account_holder ?? null,
      accountNumberLast4: acct?.account_number_last4 ?? null,
      ifsc: acct?.ifsc ?? null,
      swift: acct?.swift ?? null,
      bankName: acct?.bank_name ?? null,
      branch: acct?.branch ?? null,
      accountType: acct?.account_type ?? null,
      // GSTIN/PAN are shown on the tax invoice — kept here for the wizard. (The
      // org's gst_number is the non-encrypted source; the encrypted copy on the
      // account is for the payout side.)
      gstin: org?.gst_number ?? null,
      // PAN captured at signup, to prefill the invoice.
      pan: org?.pan ?? null,
      orgName: org?.name ?? null,
    };
  }),

  saveBankAccount: protectedPartnerProcedure
    .input(
      z.object({
        accountHolder: z.string().trim().min(1).max(150),
        accountNumber: z.string().trim().min(4).max(34),
        ifsc: z.string().trim().max(15).optional(),
        swift: z.string().trim().max(15).optional(),
        bankName: z.string().trim().max(150).optional(),
        branch: z.string().trim().max(150).optional(),
        accountType: z.string().trim().max(30).optional(),
        gstin: z.string().trim().max(20).optional(),
        // Validated like signup; the org PAN rule (company / firm / proprietor).
        pan: optionalPanSchema("agency"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = await requireOrgId(ctx.cpPartner.id);
      const last4 = input.accountNumber.slice(-4);
      const data = {
        account_holder: input.accountHolder,
        account_number_enc: encryptSecret(input.accountNumber),
        account_number_last4: last4,
        ifsc: orNull(input.ifsc),
        swift: orNull(input.swift),
        bank_name: orNull(input.bankName),
        branch: orNull(input.branch),
        account_type: orNull(input.accountType),
        gstin_enc: input.gstin?.trim() ? encryptSecret(input.gstin.trim()) : null,
        pan_enc: input.pan ? encryptSecret(input.pan) : null,
      };
      const existing = await db.partner_bank_account.findFirst({
        where: { org_id: orgId },
        select: { id: true },
      });
      if (existing) {
        await db.partner_bank_account.update({ where: { id: existing.id }, data });
      } else {
        await db.partner_bank_account.create({ data: { org_id: orgId, ...data } });
      }
      return { success: true as const };
    }),

  // Generate a GST tax invoice for the selected claimable commissions.
  generateInvoice: protectedPartnerProcedure
    .input(
      z.object({
        commissionIds: z.array(z.number().int().positive()).min(1),
        invoiceNumber: z.string().trim().min(1).max(30),
        invoiceDate: z.string(),
        gstin: z.string().trim().max(20).optional(),
        // Validated like signup; the org PAN rule (company / firm / proprietor).
        pan: optionalPanSchema("agency"),
        signatoryName: z.string().trim().min(1).max(100),
        signatoryDesignation: z.string().trim().max(100).optional(),
        notes: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = await requireOrgId(ctx.cpPartner.id);
      const bank = await db.partner_bank_account.findFirst({
        where: { org_id: orgId },
        orderBy: { id: "desc" },
        select: { id: true, account_number_last4: true, ifsc: true, bank_name: true, account_holder: true },
      });

      const comms = await db.commission.findMany({
        where: { id: { in: input.commissionIds }, org_id: orgId },
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

      // One invoice line per claimed tranche (pay-as-collected).
      const lineItems = comms.flatMap((c) => {
        const sharePct = c.partner_share_pct == null ? 100 : num(c.partner_share_pct);
        return c.commission_tranche.map((t) => ({
          commissionId: c.id,
          trancheId: t.id,
          amount: round2(num(t.amount_inr) * (sharePct / 100)),
        }));
      });
      const subtotal = round2(lineItems.reduce((s, l) => s + l.amount, 0));
      const partnerGstin = orNull(input.gstin);
      const tax = computeTax(subtotal, partnerGstin);

      const created = await db.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            invoice_number: input.invoiceNumber,
            invoice_date: new Date(input.invoiceDate),
            total_amount: subtotal,
            currency: "INR",
            status: PartnerInvoiceStatus.SUBMITTED,
            org_id: orgId,
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
      });
      return { invoiceId: created.id, netPayable: tax.netPayable };
    }),

  // Tax preview for the wizard (no write).
  taxPreview: protectedPartnerProcedure
    .input(z.object({ commissionIds: z.array(z.number().int().positive()), gstin: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const orgId = await requireOrgId(ctx.cpPartner.id);
      const comms = await db.commission.findMany({
        where: { id: { in: input.commissionIds }, org_id: orgId },
        select: {
          partner_share_pct: true,
          commission_tranche: {
            where: { status: TrancheStatus.RECEIVED, invoice_item: { is: null } },
            select: { amount_inr: true },
          },
        },
      });
      const subtotal = round2(
        comms.reduce((s, c) => {
          const sharePct = c.partner_share_pct == null ? 100 : num(c.partner_share_pct);
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
  studentDetail: protectedPartnerProcedure
    .input(z.object({ commissionId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const orgId = await requireOrgId(ctx.cpPartner.id);
      const c = await db.commission.findFirst({
        where: { id: input.commissionId, org_id: orgId },
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
  // (tier is derived from the count of students in the current FY).
  yearlyStats: protectedPartnerProcedure.query(async ({ ctx }) => {
    const orgId = await requireOrgId(ctx.cpPartner.id);
    const comms = await db.commission.findMany({
      where: { org_id: orgId },
      select: {
        created_at: true,
        partner_paid_at: true,
        claimable_inr: true,
        partner_share_pct: true,
      },
    });
    const byFy = new Map<number, { students: number; earned: number; paid: number }>();
    for (const c of comms) {
      const fy = financialYearOf(c.created_at);
      const share = c.partner_share_pct == null ? 100 : num(c.partner_share_pct);
      const claimable = round2((num(c.claimable_inr) * share) / 100);
      const e = byFy.get(fy) ?? { students: 0, earned: 0, paid: 0 };
      e.students += 1;
      e.earned += claimable;
      if (c.partner_paid_at != null) e.paid += claimable;
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

  invoiceHistory: protectedPartnerProcedure.query(async ({ ctx }) => {
    const orgId = await requireOrgId(ctx.cpPartner.id);
    const invoices = await db.invoice.findMany({
      where: { org_id: orgId },
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
