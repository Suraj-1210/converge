import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  financeManagerProcedure,
  financeProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  appUrl,
  commissionClaimApprovedEmail,
  commissionClaimRejectedEmail,
} from "~/server/email";
import { emailPartners, payeeRecipients } from "~/server/email/partners";
import { PAYEE_LABEL_SELECT, payeeLabel } from "~/server/payee";
import {
  PartnerInvoiceStatus,
  PayoutStatus,
  TrancheStatus,
  VendorInvoiceStatus,
  toINR,
} from "~/server/db/enums";

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());

// Partner email once a claim is approved (fire-and-forget; already saved).
function notifyClaimApproved(
  inv: { org_id: number | null; payee_user_id: number | null; payout_currency: string | null },
  invoiceNumber: string,
  amountInr: number,
  partial: boolean,
) {
  return payeeRecipients({ orgId: inv.org_id, userId: inv.payee_user_id })
    .then((rs) =>
      emailPartners(
        rs,
        (r) =>
          commissionClaimApprovedEmail(
            r,
            { invoiceNumber, amountInr, partial, payoutCurrency: inv.payout_currency },
            appUrl(),
          ),
        "claim-approved",
        "fin.invoice",
      ),
    )
    .catch((e) => console.error("[email] claim-approved lookup failed:", e));
}
// Net the partner is owed (incl. GST / less TDS); falls back to the subtotal.
const netOf = (inv: { net_payable: Decimalish; total_amount: Decimalish }) =>
  inv.net_payable == null ? num(inv.total_amount) : num(inv.net_payable);

export const partnerPayoutsRouter = createTRPCRouter({
  // Partner invoices with a per-student cross-reference (claim vs whether CP has
  // actually collected the vendor payment for that student).
  list: financeProcedure.query(async () => {
    const invoices = await db.invoice.findMany({
      orderBy: { invoice_date: "desc" },
      include: {
        ...PAYEE_LABEL_SELECT,
        partner_payout: { select: { id: true, status: true } },
        invoice_item: {
          include: {
            // The tranche this line claims (pay-as-collected); null on
            // pre-tranche lines.
            commission_tranche: { select: { name: true, status: true, amount_inr: true } },
            commission: {
              select: {
                claimable_inr: true,
                application: {
                  select: {
                    course: { select: { name: true, university: { select: { name: true } } } },
                    student: { select: { first_name: true, last_name: true } },
                  },
                },
                // The vendor invoice CP raised to collect for this student — the
                // "source ref" the partner's claim is cross-referenced against,
                // plus what's needed to compute the collected ratio.
                vendor_invoice_item: {
                  select: {
                    expected_amount: true,
                    vendor_invoice: {
                      select: {
                        invoice_number: true,
                        status: true,
                        currency: true,
                        total_expected_amount: true,
                        vendor_payment: { select: { amount_inr: true } },
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

    return invoices.map((inv) => {
      const items = inv.invoice_item.map((it) => {
        const c = it.commission;
        const claimed = num(it.amount);
        const vii = c.vendor_invoice_item;
        const vInv = vii?.vendor_invoice ?? null;
        // A tranche line is verified once CP has collected that tranche (the
        // same rule approve() enforces). A pre-tranche line goes by how much
        // the VENDOR paid CP for this student (paid ratio of the source vendor
        // invoice) — NOT by claimed vs received.
        let match: "verified" | "partial" | "no-payment" = "no-payment";
        let amountReceived = 0;
        const paymentStatus: number | null = vInv?.status ?? null;
        const tranche = it.commission_tranche;
        if (tranche) {
          if (tranche.status === TrancheStatus.RECEIVED || tranche.status === TrancheStatus.PAID) {
            match = "verified";
            amountReceived = num(tranche.amount_inr);
          }
        } else if (vInv && vii) {
          const expectedInr = toINR(num(vInv.total_expected_amount), vInv.currency);
          const paidInr = vInv.vendor_payment.reduce((s, p) => s + num(p.amount_inr), 0);
          const ratio = expectedInr > 0 ? paidInr / expectedInr : 0;
          const studentExpectedInr = toINR(num(vii.expected_amount), vInv.currency);
          if (vInv.status === VendorInvoiceStatus.FULLY_PAID || ratio >= 0.99) {
            match = "verified";
            amountReceived =
              num(c.claimable_inr) > 0 ? num(c.claimable_inr) : studentExpectedInr;
          } else if (ratio > 0) {
            match = "partial";
            amountReceived = Math.round(studentExpectedInr * ratio * 100) / 100;
          }
        }
        return {
          student:
            `${c.application.student.first_name} ${c.application.student.last_name}`.trim(),
          university: c.application.course.university.name,
          program: c.application.course.name,
          tranche: tranche?.name ?? null,
          claimed,
          amountReceived,
          paymentStatus,
          invoiceRef: vInv?.invoice_number ?? null,
          match,
        };
      });
      const verifiedCount = items.filter((i) => i.match === "verified").length;
      const partialCount = items.filter((i) => i.match === "partial").length;
      const noneCount = items.filter((i) => i.match === "no-payment").length;
      const allVerified = items.length > 0 && verifiedCount === items.length;
      const payee = payeeLabel(inv);
      return {
        id: inv.id,
        invoiceNumber: inv.invoice_number,
        ...payee,
        // An independent outside India may claim without a PAN; Finance
        // reviews those instead of the claim being blocked.
        panReview: payee.partnerType === "independent" && !inv.pan,
        invoiceDate: inv.invoice_date,
        students: inv.invoice_item.length,
        totalAmount: num(inv.total_amount),
        netPayable: netOf(inv),
        // Amounts are INR; a non-INR claim is paid out in this currency at
        // the rate on the day (no GST / TDS on it).
        payoutCurrency: inv.payout_currency ?? "INR",
        status: inv.status,
        gstin: inv.gstin,
        pan: inv.pan,
        rejectionReason: inv.rejection_reason,
        allVerified,
        verifiedCount,
        partialCount,
        noneCount,
        hasPayout: inv.partner_payout != null,
        items,
      };
    });
  }),

  // Reviewing and deciding a claim is Super Admin / Finance Manager only;
  // Finance Executives see the queue read-only (decided 24 Oct 2026).
  review: financeManagerProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.invoice.updateMany({
        where: { id: input.invoiceId, status: PartnerInvoiceStatus.SUBMITTED },
        data: { status: PartnerInvoiceStatus.UNDER_REVIEW },
      });
      return { success: true as const };
    }),

  // Approve for payment — only when every student is verified (CP has collected).
  // Creates the payout that Reconciliation (P6) will release.
  approve: financeManagerProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const inv = await db.invoice.findUnique({
        where: { id: input.invoiceId },
        include: {
          partner_payout: { select: { id: true } },
          invoice_item: {
            include: {
              commission: { select: { collegepond_received_at: true } },
              commission_tranche: { select: { status: true } },
            },
          },
        },
      });
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      if (inv.partner_payout) {
        throw new TRPCError({ code: "CONFLICT", message: "This invoice is already approved." });
      }
      if (inv.status === PartnerInvoiceStatus.REJECTED || inv.status === PartnerInvoiceStatus.PAID) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice can't be approved." });
      }
      // Every claimed line must be collected from the vendor: tranche-based lines
      // need their tranche RECEIVED; legacy (pre-tranche) lines need the commission's
      // collegepond_received_at stamp.
      const allVerified =
        inv.invoice_item.length > 0 &&
        inv.invoice_item.every((it) =>
          it.commission_tranche != null
            ? it.commission_tranche.status === TrancheStatus.RECEIVED
            : it.commission.collegepond_received_at != null,
        );
      if (!allVerified) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Every claimed tranche must be collected from the vendor before approving.",
        });
      }
      await db.$transaction([
        db.invoice.update({
          where: { id: inv.id },
          data: { status: PartnerInvoiceStatus.APPROVED },
        }),
        db.partner_payout.create({
          data: {
            invoice_id: inv.id,
            amount_inr: netOf(inv),
            // The foreign amount and rate are set at release.
            currency: inv.payout_currency ?? "INR",
            status: PayoutStatus.APPROVED,
            ops_approved_by_cp_user_id: ctx.cpUser.id,
            ops_approved_at: new Date(),
          },
        }),
      ]);
      void notifyClaimApproved(inv, inv.invoice_number, netOf(inv), false);
      return { success: true as const };
    }),

  // Partial approve — pay only the students CP has collected for; the payout is
  // the net prorated to the collected share. No longer offered in the UI: a
  // claim only ever contains collected tranches, so Approve covers it.
  partialApprove: financeManagerProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const inv = await db.invoice.findUnique({
        where: { id: input.invoiceId },
        include: {
          partner_payout: { select: { id: true } },
          invoice_item: {
            include: { commission: { select: { collegepond_received_at: true } } },
          },
        },
      });
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      if (inv.partner_payout) {
        throw new TRPCError({ code: "CONFLICT", message: "This invoice is already approved." });
      }
      if (inv.status === PartnerInvoiceStatus.REJECTED || inv.status === PartnerInvoiceStatus.PAID) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice can't be approved." });
      }
      const verified = inv.invoice_item.filter(
        (it) => it.commission.collegepond_received_at != null,
      );
      if (verified.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No collected students yet — nothing to partially approve.",
        });
      }
      if (verified.length === inv.invoice_item.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Every student is collected — use Approve for the full amount.",
        });
      }
      const totalClaimed = inv.invoice_item.reduce((s, it) => s + num(it.amount), 0);
      const verifiedClaimed = verified.reduce((s, it) => s + num(it.amount), 0);
      const net = netOf(inv);
      const partialNet =
        totalClaimed > 0
          ? Math.round(net * (verifiedClaimed / totalClaimed) * 100) / 100
          : net;
      await db.$transaction([
        db.invoice.update({
          where: { id: inv.id },
          data: { status: PartnerInvoiceStatus.PARTIAL_APPROVED },
        }),
        db.partner_payout.create({
          data: {
            invoice_id: inv.id,
            amount_inr: partialNet,
            currency: inv.payout_currency ?? "INR",
            status: PayoutStatus.APPROVED,
            ops_approved_by_cp_user_id: ctx.cpUser.id,
            ops_approved_at: new Date(),
          },
        }),
      ]);
      void notifyClaimApproved(inv, inv.invoice_number, partialNet, true);
      return { success: true as const };
    }),

  // Reject a claim. Its lines are detached from their tranches (the
  // invoice_item rows are deleted; the invoice and its reason stay) so the
  // partner can claim the same tranches again on a new invoice number.
  reject: financeManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db.invoice.findUnique({
        where: { id: input.invoiceId },
        select: {
          status: true,
          partner_payout: { select: { id: true } },
          invoice_item: { select: { id: true, commission_id: true, commission_tranche_id: true, amount: true } },
        },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      if (
        existing.partner_payout ||
        (existing.status !== PartnerInvoiceStatus.SUBMITTED &&
          existing.status !== PartnerInvoiceStatus.UNDER_REVIEW)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only a claim that's still awaiting approval can be rejected.",
        });
      }
      const inv = await db.$transaction(async (tx) => {
        const updated = await tx.invoice.update({
          where: { id: input.invoiceId },
          data: { status: PartnerInvoiceStatus.REJECTED, rejection_reason: input.reason },
          select: { org_id: true, payee_user_id: true, invoice_number: true },
        });
        await tx.invoice_item.deleteMany({ where: { invoice_id: input.invoiceId } });
        // The deleted lines, for the record.
        await tx.audit_log.create({
          data: {
            org_id: updated.org_id,
            action: "partner_invoice.rejected",
            entity_type: "invoice",
            entity_id: input.invoiceId,
            metadata: {
              byCpUserId: ctx.cpUser.id,
              payeeUserId: updated.payee_user_id,
              invoiceNumber: updated.invoice_number,
              reason: input.reason,
              releasedLines: existing.invoice_item.map((it) => ({
                commissionId: it.commission_id,
                trancheId: it.commission_tranche_id,
                amount: num(it.amount),
              })),
            },
          },
        });
        return updated;
      });
      void payeeRecipients({ orgId: inv.org_id, userId: inv.payee_user_id })
        .then((rs) =>
          emailPartners(
            rs,
            (r) =>
              commissionClaimRejectedEmail(
                r,
                { invoiceNumber: inv.invoice_number, reason: input.reason },
                appUrl(),
              ),
            "claim-rejected",
            "fin.invoice",
          ),
        )
        .catch((e) => console.error("[email] claim-rejected lookup failed:", e));
      return { success: true as const };
    }),

  paymentHistory: financeProcedure.query(async () => {
    const payouts = await db.partner_payout.findMany({
      where: { status: PayoutStatus.RELEASED },
      orderBy: { released_at: "desc" },
      include: { invoice: { select: { invoice_number: true, ...PAYEE_LABEL_SELECT } } },
    });
    return payouts.map((p) => ({
      id: p.id,
      ...payeeLabel(p.invoice),
      invoiceNumber: p.invoice.invoice_number,
      amountInr: num(p.amount_inr),
      currency: p.currency ?? "INR",
      amountForeign: p.amount_foreign == null ? null : num(p.amount_foreign),
      exchangeRate: p.exchange_rate == null ? null : num(p.exchange_rate),
      method: p.method,
      reference: p.reference_number,
      paymentDate: p.payment_date,
    }));
  }),

  stats: financeProcedure.query(async () => {
    const invoices = await db.invoice.findMany({ select: { status: true, total_amount: true, net_payable: true } });
    const total = invoices.length;
    const pendingReview = invoices.filter(
      (i) => i.status === PartnerInvoiceStatus.SUBMITTED || i.status === PartnerInvoiceStatus.UNDER_REVIEW,
    ).length;
    const approved = invoices.filter(
      (i) =>
        i.status === PartnerInvoiceStatus.APPROVED ||
        i.status === PartnerInvoiceStatus.PARTIAL_APPROVED,
    ).length;
    const amountPending = invoices
      .filter((i) => i.status !== PartnerInvoiceStatus.PAID && i.status !== PartnerInvoiceStatus.REJECTED)
      .reduce((s, i) => s + netOf(i), 0);
    return { total, pendingReview, approved, amountPending: Math.round(amountPending * 100) / 100 };
  }),
});
