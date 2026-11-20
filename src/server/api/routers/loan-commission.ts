import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, financeManagerProcedure, financeProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { type Prisma } from "../../../../generated/prisma";
import {
  AdjustmentDirection,
  AdjustmentSide,
  AdjustmentStatus,
  AdminRole,
  LoanCommissionSource,
  LoanCommissionStatus,
  LoanReceiptStatus,
  UserType,
  financialYearOf,
} from "~/server/db/enums";
import { LoanReferralSendStatus } from "~/lib/loan-sharing";
import { PAYEE_LABEL_SELECT, payeeLabel, payeeOf, payeeWhere, type Payee } from "~/server/payee";
import { createNotifications } from "~/server/notify";
import { appUrl, loanCommissionClaimableEmail } from "~/server/email";
import { emailPartners, payeeRecipients } from "~/server/email/partners";
import {
  OPEN_LINE_STATES,
  dateOnly,
  lenderPctOn,
  num,
  numOrNull,
  openLine,
  priceWaitingLines,
  round2,
} from "~/server/loan-commission";

// Finance › Loan Commission (20 Nov 2026; spec "Loan Commission Flow —
// Converge", decisions by Suraj). Masters (lender rates, each partner's % of
// disbursed), the commission lines opened by disbursements, and Collegepond's
// lender receipts that make them claimable.
//   - Reads, masters and recording a receipt: any finance role (Suraj: rates
//     are set by the Super Admin or Finance).
//   - Approving / rejecting a receipt, cancelling a line, recording a
//     clawback, adding a line by hand: Super Admin / Finance Manager.
//   - Crediting a duplicate referral: Super Admin only (Suraj, 20 Nov).

const pct = z.number().min(0).max(100);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const payeeInput = z.union([
  z.object({ orgId: z.number().int().positive() }),
  z.object({ userId: z.number().int().positive() }),
]);
const toPayee = (p: z.infer<typeof payeeInput>): Payee =>
  "orgId" in p ? { orgId: p.orgId, userId: null } : { orgId: null, userId: p.userId };
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const LINE_SELECT = {
  id: true,
  referral_id: true,
  tranche_no: true,
  source: true,
  lender_id: true,
  disbursed_amount: true,
  disbursed_on: true,
  lender_pct: true,
  partner_pct: true,
  expected_cp: true,
  partner_amount: true,
  received_amount: true,
  status: true,
  attention: true,
  attention_at: true,
  note: true,
  claimable_at: true,
  paid_at: true,
  cancel_reason: true,
  cancelled_at: true,
  clawback_amount: true,
  clawback_on: true,
  clawback_reference: true,
  clawback_adjustment_id: true,
  created_at: true,
  org_id: true,
  payee_user_id: true,
  ...PAYEE_LABEL_SELECT,
  lender: { select: { name: true } },
  referral: { select: { public_id: true, student_name: true, phone: true, student_id: true } },
  allocation: { select: { receipt: { select: { id: true, reference: true, status: true, received_on: true } } } },
  invoice_item: { select: { invoice: { select: { id: true, invoice_number: true, status: true } } } },
} as const;

type LineRow = Awaited<ReturnType<typeof loadLines>>[number];
function loadLines(where: Prisma.loan_commissionWhereInput) {
  return db.loan_commission.findMany({ where, select: LINE_SELECT, orderBy: [{ disbursed_on: "desc" }, { id: "desc" }] });
}
function lineView(l: LineRow) {
  return {
    id: l.id,
    referralPublicId: l.referral.public_id,
    student: l.referral.student_name,
    studentId: l.referral.student_id,
    ...payeeLabel(l),
    payee: l.org_id != null ? { orgId: l.org_id } : { userId: l.payee_user_id! },
    lenderId: l.lender_id,
    lender: l.lender.name,
    trancheNo: l.tranche_no,
    source: l.source,
    disbursedAmount: num(l.disbursed_amount),
    disbursedOn: l.disbursed_on,
    lenderPct: numOrNull(l.lender_pct),
    partnerPct: numOrNull(l.partner_pct),
    expectedCp: numOrNull(l.expected_cp),
    partnerAmount: numOrNull(l.partner_amount),
    receivedAmount: numOrNull(l.received_amount),
    status: l.status,
    attention: l.attention,
    attentionAt: l.attention_at,
    note: l.note,
    claimableAt: l.claimable_at,
    paidAt: l.paid_at,
    cancelReason: l.cancel_reason,
    cancelledAt: l.cancelled_at,
    clawback:
      l.clawback_amount == null
        ? null
        : {
            amount: num(l.clawback_amount),
            on: l.clawback_on,
            reference: l.clawback_reference,
            adjustmentId: l.clawback_adjustment_id,
          },
    receipt: l.allocation?.receipt ?? null,
    invoice: l.invoice_item?.invoice ?? null,
  };
}

async function audit(action: string, entityType: string, entityId: number, byCpUserId: number, metadata: Record<string, unknown>, orgId: number | null = null) {
  await db.audit_log.create({
    data: { org_id: orgId, action, entity_type: entityType, entity_id: entityId, metadata: { byCpUserId, ...metadata } },
  });
}

export const loanCommissionRouter = createTRPCRouter({
  // Headline figures for the page and the Finance dashboard card.
  summary: financeProcedure.query(async () => {
    const rows = await db.loan_commission.groupBy({
      by: ["status"],
      _count: { _all: true },
      _sum: { partner_amount: true, expected_cp: true, received_amount: true, disbursed_amount: true },
    });
    const by = (s: number) => rows.find((r) => r.status === s);
    const amt = (s: number[]) => round2(s.reduce((t, x) => t + num(by(x)?._sum.partner_amount ?? null), 0));
    const cnt = (s: number[]) => s.reduce((t, x) => t + (by(x)?._count._all ?? 0), 0);
    const [attention, pendingReceipts] = await Promise.all([
      db.loan_commission.count({ where: { attention: { not: null }, status: { not: LoanCommissionStatus.CANCELLED } } }),
      db.loan_receipt.count({ where: { status: LoanReceiptStatus.PENDING } }),
    ]);
    const live = [0, 1, 2, 3, 4, 5];
    return {
      lines: cnt(live),
      disbursed: round2(live.reduce((t, x) => t + num(by(x)?._sum.disbursed_amount ?? null), 0)),
      expectedCp: round2(live.reduce((t, x) => t + num(by(x)?._sum.expected_cp ?? null), 0)),
      receivedCp: round2([3, 4, 5].reduce((t, x) => t + num(by(x)?._sum.received_amount ?? null), 0)),
      needsRate: cnt([LoanCommissionStatus.NEEDS_RATE]),
      awaiting: { count: cnt([1, 2]), partner: amt([1, 2]) },
      claimable: { count: cnt([3]), partner: amt([3]) },
      claimed: { count: cnt([4]), partner: amt([4]) },
      paid: { count: cnt([5]), partner: amt([5]) },
      attention,
      pendingReceipts,
    };
  }),

  lines: financeProcedure
    .input(
      z.object({
        status: z.number().int().min(0).max(6).optional(),
        lenderId: z.number().int().positive().optional(),
        attention: z.boolean().optional(),
        q: z.string().trim().max(100).optional(),
      }),
    )
    .query(async ({ input }) => {
      const q = input.q?.trim();
      const rows = await loadLines({
        ...(input.status != null ? { status: input.status } : {}),
        ...(input.lenderId ? { lender_id: input.lenderId } : {}),
        ...(input.attention ? { attention: { not: null }, status: { not: LoanCommissionStatus.CANCELLED } } : {}),
        ...(q
          ? {
              OR: [
                { referral: { student_name: { contains: q } } },
                { organization: { name: { contains: q } } },
                { lender: { name: { contains: q } } },
              ],
            }
          : {}),
      });
      return rows.map(lineView);
    }),

  // ---- masters ---------------------------------------------------------------

  lenders: financeProcedure.query(async () => {
    const [lenders, waiting] = await Promise.all([
      db.loan_lender.findMany({
        orderBy: { name: "asc" },
        include: { rates: { orderBy: { effective_from: "desc" } } },
      }),
      db.loan_commission.groupBy({ by: ["lender_id", "status"], _count: { _all: true } }),
    ]);
    const today = dateOnly(new Date());
    return lenders.map((l) => {
      const current = l.rates.find((r) => r.effective_from <= today) ?? null;
      const counts = waiting.filter((w) => w.lender_id === l.id);
      return {
        id: l.id,
        name: l.name,
        paysLaterTranches: l.pays_later_tranches === 1,
        isActive: l.is_active === 1,
        currentPct: current ? num(current.cp_pct) : null,
        rates: l.rates.map((r) => ({ id: r.id, pct: num(r.cp_pct), effectiveFrom: r.effective_from, note: r.note })),
        needsRate: counts.find((c) => c.status === LoanCommissionStatus.NEEDS_RATE)?._count._all ?? 0,
        awaiting: counts.find((c) => c.status === LoanCommissionStatus.AWAITING_RECEIPT)?._count._all ?? 0,
      };
    });
  }),

  saveLender: financeProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(150),
        paysLaterTranches: z.boolean(),
        isActive: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data = { name: input.name, pays_later_tranches: input.paysLaterTranches ? 1 : 0, is_active: input.isActive ? 1 : 0 };
      try {
        const row = input.id
          ? await db.loan_lender.update({ where: { id: input.id }, data })
          : await db.loan_lender.create({ data });
        await audit("loan_lender.saved", "loan_lender", row.id, ctx.cpUser.id, { ...data, created: !input.id });
        return { id: row.id };
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw bad(`A lender called "${input.name}" already exists.`);
        throw e;
      }
    }),

  // A dated rate; the same date again replaces it. NEEDS_RATE lines it now
  // covers are priced.
  setLenderRate: financeProcedure
    .input(z.object({ lenderId: z.number().int().positive(), pct, effectiveFrom: isoDay, note: z.string().trim().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      const on = dateOnly(input.effectiveFrom);
      const row = await db.loan_lender_rate.upsert({
        where: { lender_id_effective_from: { lender_id: input.lenderId, effective_from: on } },
        create: { lender_id: input.lenderId, cp_pct: input.pct, effective_from: on, note: input.note ?? null, created_by_cp_user_id: ctx.cpUser.id },
        update: { cp_pct: input.pct, note: input.note ?? null, created_by_cp_user_id: ctx.cpUser.id },
      });
      await audit("loan_lender.rate_set", "loan_lender", input.lenderId, ctx.cpUser.id, { rateId: row.id, pct: input.pct, effectiveFrom: input.effectiveFrom });
      const priced = await priceWaitingLines({ lenderId: input.lenderId });
      return { priced };
    }),

  // Every payee with a loan referral or a rate, with their current % and
  // history (one % per partner, no default: Suraj, 20 Nov).
  partners: financeProcedure.query(async () => {
    const [refs, rates, lineCounts] = await Promise.all([
      db.loan_referral.findMany({
        select: {
          org_id: true,
          partner_user_id: true,
          organization: { select: { name: true } },
          partner_user: { select: { first_name: true, last_name: true, type: true, org_id: true } },
        },
      }),
      db.loan_partner_rate.findMany({
        orderBy: [{ effective_from: "desc" }, { id: "desc" }],
        include: { organization: { select: { name: true } }, payee_user: { select: { first_name: true, last_name: true } } },
      }),
      db.loan_commission.groupBy({ by: ["org_id", "payee_user_id", "status"], _count: { _all: true } }),
    ]);
    type P = { key: string; payee: { orgId: number } | { userId: number }; name: string; type: "agency" | "independent"; referrals: number };
    const map = new Map<string, P>();
    for (const r of refs) {
      const p: P =
        r.org_id != null
          ? { key: `o:${r.org_id}`, payee: { orgId: r.org_id }, name: r.organization?.name ?? "Agency", type: "agency", referrals: 0 }
          : {
              key: `u:${r.partner_user_id}`,
              payee: { userId: r.partner_user_id },
              name: `${r.partner_user.first_name} ${r.partner_user.last_name}`.trim(),
              type: "independent",
              referrals: 0,
            };
      const cur = map.get(p.key) ?? p;
      cur.referrals++;
      map.set(p.key, cur);
    }
    for (const r of rates) {
      const key = r.org_id != null ? `o:${r.org_id}` : `u:${r.payee_user_id}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          payee: r.org_id != null ? { orgId: r.org_id } : { userId: r.payee_user_id! },
          name: r.organization?.name ?? `${r.payee_user?.first_name ?? ""} ${r.payee_user?.last_name ?? ""}`.trim(),
          type: r.org_id != null ? "agency" : "independent",
          referrals: 0,
        });
      }
    }
    const today = dateOnly(new Date());
    return Array.from(map.values())
      .map((p) => {
        const mine = rates.filter((r) => (r.org_id != null ? `o:${r.org_id}` : `u:${r.payee_user_id}`) === p.key);
        const current = mine.find((r) => r.effective_from <= today) ?? null;
        const counts = lineCounts.filter((c) => (c.org_id != null ? `o:${c.org_id}` : `u:${c.payee_user_id}`) === p.key);
        return {
          ...p,
          currentPct: current ? num(current.pct) : null,
          rates: mine.map((r) => ({ id: r.id, pct: num(r.pct), effectiveFrom: r.effective_from, note: r.note })),
          needsRate: counts.find((c) => c.status === LoanCommissionStatus.NEEDS_RATE)?._count._all ?? 0,
          lines: counts.filter((c) => c.status !== LoanCommissionStatus.CANCELLED).reduce((s, c) => s + c._count._all, 0),
        };
      })
      .sort((a, b) => (a.currentPct == null ? 0 : 1) - (b.currentPct == null ? 0 : 1) || a.name.localeCompare(b.name));
  }),

  setPartnerRate: financeProcedure
    .input(z.object({ payee: payeeInput, pct, effectiveFrom: isoDay, note: z.string().trim().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      const payee = toPayee(input.payee);
      if (payee.orgId != null) {
        if (!(await db.organization.findUnique({ where: { id: payee.orgId }, select: { id: true } }))) throw bad("Partner not found.");
      } else if (!(await db.user.findFirst({ where: { id: payee.userId, type: UserType.INDEPENDENT_COUNSELLOR }, select: { id: true } }))) {
        throw bad("Partner not found.");
      }
      const on = dateOnly(input.effectiveFrom);
      // The same date again replaces that rate.
      await db.$transaction([
        db.loan_partner_rate.deleteMany({ where: { ...payeeWhere(payee), effective_from: on } }),
        db.loan_partner_rate.create({
          data: { org_id: payee.orgId, payee_user_id: payee.userId, pct: input.pct, effective_from: on, note: input.note ?? null, created_by_cp_user_id: ctx.cpUser.id },
        }),
      ]);
      await audit("loan_partner_rate.set", "loan_partner_rate", payee.orgId ?? payee.userId, ctx.cpUser.id, { payee, pct: input.pct, effectiveFrom: input.effectiveFrom }, payee.orgId);
      const priced = await priceWaitingLines({ payee });
      return { priced };
    }),

  // ---- lender receipts ---------------------------------------------------------

  // The lender's lines a receipt can pay: priced and awaiting the payout.
  openLinesForLender: financeProcedure
    .input(z.object({ lenderId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const rows = await loadLines({ lender_id: input.lenderId, status: LoanCommissionStatus.AWAITING_RECEIPT });
      return rows.map(lineView);
    }),

  receipts: financeProcedure.query(async () => {
    const rows = await db.loan_receipt.findMany({
      orderBy: [{ status: "asc" }, { received_on: "desc" }, { id: "desc" }],
      include: {
        lender: { select: { name: true } },
        allocations: { include: { line: { select: { ...LINE_SELECT } } } },
      },
    });
    const ids = Array.from(new Set(rows.flatMap((r) => [r.recorded_by_cp_user_id, r.decided_by_cp_user_id]).filter((x): x is number => x != null)));
    const users = await db.collegepond_user.findMany({ where: { id: { in: ids } }, select: { id: true, first_name: true, last_name: true } });
    const name = (id: number | null) => {
      const u = users.find((x) => x.id === id);
      return u ? `${u.first_name} ${u.last_name}`.trim() : null;
    };
    return rows.map((r) => ({
      id: r.id,
      lenderId: r.lender_id,
      lender: r.lender.name,
      receivedOn: r.received_on,
      reference: r.reference,
      cpInvoiceNumber: r.cp_invoice_number,
      amount: num(r.amount),
      gst: num(r.gst_amount),
      tds: num(r.tds_amount),
      status: r.status,
      note: r.note,
      recordedBy: name(r.recorded_by_cp_user_id),
      recordedAt: r.created_at,
      decidedBy: name(r.decided_by_cp_user_id),
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      lines: r.allocations.map((a) => ({ ...lineView(a.line), allocated: num(a.amount) })),
    }));
  }),

  // Any finance role records it; the lines it pays wait for SA / FM approval.
  recordReceipt: financeProcedure
    .input(
      z.object({
        lenderId: z.number().int().positive(),
        receivedOn: isoDay,
        reference: z.string().trim().min(1).max(100),
        cpInvoiceNumber: z.string().trim().max(50).optional(),
        amount: z.number().positive().max(1_000_000_000),
        gst: z.number().min(0).max(1_000_000_000).default(0),
        tds: z.number().min(0).max(1_000_000_000).default(0),
        note: z.string().trim().max(500).optional(),
        allocations: z
          .array(z.object({ lineId: z.number().int().positive(), amount: z.number().positive() }))
          .min(1)
          .max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ids = input.allocations.map((a) => a.lineId);
      if (new Set(ids).size !== ids.length) throw bad("A loan is listed twice.");
      const total = round2(input.allocations.reduce((s, a) => s + a.amount, 0));
      if (Math.abs(total - round2(input.amount)) > 0.005) {
        throw bad(`The loans add up to ${inr(total)}, but the receipt is ${inr(input.amount)} (excl. GST). Make them match.`);
      }
      const receipt = await db.$transaction(async (tx) => {
        // Claim the lines atomically: only priced lines of this lender that
        // no other receipt holds.
        const claimed = await tx.loan_commission.updateMany({
          where: { id: { in: ids }, lender_id: input.lenderId, status: LoanCommissionStatus.AWAITING_RECEIPT },
          data: { status: LoanCommissionStatus.RECEIPT_PENDING },
        });
        if (claimed.count !== ids.length) {
          throw bad("Some of these loans are no longer awaiting this lender's payout. Refresh and try again.");
        }
        const r = await tx.loan_receipt.create({
          data: {
            lender_id: input.lenderId,
            received_on: dateOnly(input.receivedOn),
            reference: input.reference,
            cp_invoice_number: input.cpInvoiceNumber ?? null,
            amount: round2(input.amount),
            gst_amount: round2(input.gst),
            tds_amount: round2(input.tds),
            note: input.note ?? null,
            fy: financialYearOf(dateOnly(input.receivedOn)),
            recorded_by_cp_user_id: ctx.cpUser.id,
          },
        });
        await tx.loan_receipt_allocation.createMany({
          data: input.allocations.map((a) => ({ receipt_id: r.id, loan_commission_id: a.lineId, amount: round2(a.amount) })),
        });
        return r;
      });
      await audit("loan_receipt.recorded", "loan_receipt", receipt.id, ctx.cpUser.id, {
        lenderId: input.lenderId,
        amount: input.amount,
        reference: input.reference,
        allocations: input.allocations,
      });
      return { id: receipt.id };
    }),

  // SA / FM: the lines become claimable and each partner is told.
  approveReceipt: financeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const lines = await db.$transaction(async (tx) => {
        const moved = await tx.loan_receipt.updateMany({
          where: { id: input.id, status: LoanReceiptStatus.PENDING },
          data: { status: LoanReceiptStatus.APPROVED, decided_by_cp_user_id: ctx.cpUser.id, decided_at: now, decision_note: input.note ?? null },
        });
        if (moved.count !== 1) throw bad("This receipt has already been decided.");
        const allocs = await tx.loan_receipt_allocation.findMany({
          where: { receipt_id: input.id },
          select: { loan_commission_id: true, amount: true },
        });
        for (const a of allocs) {
          await tx.loan_commission.updateMany({
            where: { id: a.loan_commission_id, status: LoanCommissionStatus.RECEIPT_PENDING },
            data: { status: LoanCommissionStatus.CLAIMABLE, received_amount: a.amount, claimable_at: now },
          });
        }
        return tx.loan_commission.findMany({
          where: { id: { in: allocs.map((a) => a.loan_commission_id) } },
          select: { id: true, org_id: true, payee_user_id: true, partner_amount: true, received_amount: true, disbursed_amount: true, lender: { select: { name: true } }, referral: { select: { student_name: true } } },
        });
      });
      await audit("loan_receipt.approved", "loan_receipt", input.id, ctx.cpUser.id, { lineIds: lines.map((l) => l.id) });

      // Tell each partner what they can claim now (fire-and-forget; saved).
      const byPayee = new Map<string, { orgId: number | null; userId: number | null; lines: string[] }>();
      for (const l of lines) {
        const key = l.org_id != null ? `o:${l.org_id}` : `u:${l.payee_user_id}`;
        const e = byPayee.get(key) ?? { orgId: l.org_id, userId: l.payee_user_id, lines: [] };
        e.lines.push(`${l.referral.student_name} — ${l.lender.name}, ${inr(num(l.partner_amount))}`);
        byPayee.set(key, e);
      }
      for (const e of byPayee.values()) {
        void payeeRecipients({ orgId: e.orgId, userId: e.userId })
          .then(async (rs) => {
            await createNotifications(
              rs.map((r) => r.id),
              {
                type: "loan_commission.claimable",
                title: e.lines.length === 1 ? "Loan commission ready to claim" : `${e.lines.length} loan commissions ready to claim`,
                body: e.lines.slice(0, 3).join("; ") + (e.lines.length > 3 ? "…" : ""),
                link: "/partner/commission#loan-commission",
                tone: "green",
              },
            );
            await emailPartners(rs, (r) => loanCommissionClaimableEmail(r, { lines: e.lines }, appUrl()), "loan-commission-claimable", "fin.commission");
          })
          .catch((err) => console.error("[notify] loan-commission-claimable failed:", err));
      }
      // Receipt amounts below a line's partner amount: Finance should see it.
      const short = lines.filter((l) => num(l.received_amount) < num(l.partner_amount));
      return { approved: lines.length, belowPartnerAmount: short.length };
    }),

  rejectReceipt: financeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const freed = await db.$transaction(async (tx) => {
        const moved = await tx.loan_receipt.updateMany({
          where: { id: input.id, status: LoanReceiptStatus.PENDING },
          data: { status: LoanReceiptStatus.REJECTED, decided_by_cp_user_id: ctx.cpUser.id, decided_at: new Date(), decision_note: input.note },
        });
        if (moved.count !== 1) throw bad("This receipt has already been decided.");
        const allocs = await tx.loan_receipt_allocation.findMany({ where: { receipt_id: input.id }, select: { loan_commission_id: true, amount: true } });
        const ids = allocs.map((a) => a.loan_commission_id);
        await tx.loan_commission.updateMany({
          where: { id: { in: ids }, status: LoanCommissionStatus.RECEIPT_PENDING },
          data: { status: LoanCommissionStatus.AWAITING_RECEIPT },
        });
        // The split is kept in the audit log; the lines are free again.
        await tx.loan_receipt_allocation.deleteMany({ where: { receipt_id: input.id } });
        return allocs.map((a) => ({ lineId: a.loan_commission_id, amount: num(a.amount) }));
      });
      await audit("loan_receipt.rejected", "loan_receipt", input.id, ctx.cpUser.id, { note: input.note, freed });
      return { freed: freed.length };
    }),

  // ---- line actions --------------------------------------------------------------

  // Correct a line's stamped rates before it is claimed (audited).
  setLineRates: financeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), lenderPct: pct.nullable(), partnerPct: pct.nullable(), reason: z.string().trim().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const l = await db.loan_commission.findUnique({ where: { id: input.id }, select: { status: true, disbursed_amount: true, lender_pct: true, partner_pct: true } });
      if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "Line not found" });
      const editable: number[] = [...OPEN_LINE_STATES, LoanCommissionStatus.RECEIPT_PENDING, LoanCommissionStatus.CLAIMABLE];
      if (!editable.includes(l.status)) throw bad("A claimed, paid or cancelled line can't be repriced.");
      const amount = num(l.disbursed_amount);
      const ready = input.lenderPct != null && input.partnerPct != null;
      const status = OPEN_LINE_STATES.includes(l.status)
        ? ready
          ? LoanCommissionStatus.AWAITING_RECEIPT
          : LoanCommissionStatus.NEEDS_RATE
        : l.status;
      if (!OPEN_LINE_STATES.includes(l.status) && !ready) throw bad("This line is on a lender receipt: both rates are needed.");
      await db.loan_commission.update({
        where: { id: input.id },
        data: {
          lender_pct: input.lenderPct,
          partner_pct: input.partnerPct,
          expected_cp: input.lenderPct == null ? null : round2((amount * input.lenderPct) / 100),
          partner_amount: input.partnerPct == null ? null : round2((amount * input.partnerPct) / 100),
          status,
        },
      });
      await audit("loan_commission.repriced", "loan_commission", input.id, ctx.cpUser.id, {
        from: { lenderPct: numOrNull(l.lender_pct), partnerPct: numOrNull(l.partner_pct) },
        to: { lenderPct: input.lenderPct, partnerPct: input.partnerPct },
        reason: input.reason,
      });
      return { success: true as const };
    }),

  // Before the partner is paid: the line is closed, with the reason shown to
  // the partner. A claimed line needs its claim rejected first; a line on a
  // pending receipt needs that receipt decided.
  cancelLine: financeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const res = await db.loan_commission.updateMany({
        where: {
          id: input.id,
          status: { in: [LoanCommissionStatus.NEEDS_RATE, LoanCommissionStatus.AWAITING_RECEIPT, LoanCommissionStatus.CLAIMABLE] },
        },
        data: {
          status: LoanCommissionStatus.CANCELLED,
          cancel_reason: input.reason,
          cancelled_by_cp_user_id: ctx.cpUser.id,
          cancelled_at: new Date(),
          attention: null,
          attention_at: null,
        },
      });
      if (res.count !== 1) {
        throw bad("Only a line that isn't on a pending receipt, a claim or a payout can be cancelled. Reject the claim (or decide the receipt) first; after payment, record a clawback.");
      }
      await audit("loan_commission.cancelled", "loan_commission", input.id, ctx.cpUser.id, { reason: input.reason });
      return { success: true as const };
    }),

  // After the partner is paid: record what the lender clawed back and
  // pre-fill a partner deduction (a DRAFT a Super Admin approves in
  // Adjustments; netted at the next release). Never automatic.
  recordClawback: financeManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        amount: z.number().positive(),
        on: isoDay,
        reference: z.string().trim().max(100).optional(),
        partnerDeduction: z.number().min(0),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const l = await db.loan_commission.findUnique({
        where: { id: input.id },
        select: { status: true, org_id: true, payee_user_id: true, partner_amount: true, clawback_amount: true, lender: { select: { name: true } }, referral: { select: { student_name: true } } },
      });
      if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "Line not found" });
      if (l.status !== LoanCommissionStatus.PAID) throw bad("A clawback is recorded on a line the partner has been paid. Cancel an unpaid line instead.");
      if (l.clawback_amount != null) throw bad("A clawback is already recorded on this line.");
      if (round2(input.partnerDeduction) > round2(num(l.partner_amount))) throw bad(`The partner deduction can't exceed what they were paid (${inr(num(l.partner_amount))}).`);
      const reason = await db.adjustment_reason.findFirst({ where: { name: "Loan commission clawback" }, select: { id: true } })
        ?? (await db.adjustment_reason.findFirst({ where: { name: "Other", is_active: 1 }, select: { id: true } }));
      if (!reason && input.partnerDeduction > 0) throw bad("Add an adjustment reason (Settings › Adjustment Reasons) first.");
      const payee = payeeOf(l);
      const adjustmentId = await db.$transaction(async (tx) => {
        let adjId: number | null = null;
        if (input.partnerDeduction > 0 && reason) {
          const adj = await tx.adjustment.create({
            data: {
              side: AdjustmentSide.PARTNER,
              direction: AdjustmentDirection.DEDUCTION,
              status: AdjustmentStatus.DRAFT,
              reason_id: reason.id,
              amount: round2(input.partnerDeduction),
              currency: "INR",
              adjustment_date: dateOnly(input.on),
              org_id: payee.orgId,
              payee_user_id: payee.userId,
              internal_note: `Loan commission line #${input.id}: ${l.lender.name} clawed back ${inr(input.amount)}${input.reference ? ` (ref ${input.reference})` : ""}.${input.note ? ` ${input.note}` : ""}`.slice(0, 1000),
              partner_note: `Loan commission reversed: ${l.referral.student_name}, ${l.lender.name}`.slice(0, 500),
              created_by_cp_user_id: ctx.cpUser.id,
            },
            select: { id: true },
          });
          adjId = adj.id;
        }
        await tx.loan_commission.update({
          where: { id: input.id },
          data: {
            clawback_amount: round2(input.amount),
            clawback_on: dateOnly(input.on),
            clawback_reference: input.reference ?? null,
            clawback_adjustment_id: adjId,
            attention: null,
            attention_at: null,
          },
        });
        return adjId;
      });
      await audit("loan_commission.clawback", "loan_commission", input.id, ctx.cpUser.id, {
        amount: input.amount,
        partnerDeduction: input.partnerDeduction,
        adjustmentId,
      }, payee.orgId);
      return { adjustmentId };
    }),

  clearAttention: financeProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().trim().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const l = await db.loan_commission.findUnique({ where: { id: input.id }, select: { attention: true } });
      if (!l?.attention) throw bad("Nothing to clear on this line.");
      await db.loan_commission.update({ where: { id: input.id }, data: { attention: null, attention_at: null } });
      await audit("loan_commission.attention_cleared", "loan_commission", input.id, ctx.cpUser.id, { was: l.attention, note: input.note });
      return { success: true as const };
    }),

  // Referrals to pick from when adding a line by hand.
  referralSearch: financeManagerProcedure
    .input(z.object({ q: z.string().trim().min(2).max(100) }))
    .query(async ({ input }) => {
      const rows = await db.loan_referral.findMany({
        where: {
          send_status: { in: [LoanReferralSendStatus.RECEIVED, LoanReferralSendStatus.DUPLICATE] },
          OR: [{ student_name: { contains: input.q } }, { phone: { contains: input.q } }, { email: { contains: input.q } }],
        },
        take: 20,
        orderBy: { id: "desc" },
        select: {
          id: true,
          student_name: true,
          phone: true,
          send_status: true,
          organization: { select: { name: true } },
          partner_user: { select: { first_name: true, last_name: true } },
          application: { select: { id: true, external_id: true, lender: true, status: true, disbursed_amount: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        student: r.student_name,
        phone: r.phone,
        duplicate: r.send_status === LoanReferralSendStatus.DUPLICATE,
        partner: r.organization?.name ?? `${r.partner_user.first_name} ${r.partner_user.last_name}`.trim(),
        applications: r.application.map((a) => ({
          id: a.id,
          externalId: a.external_id,
          lender: a.lender,
          status: a.status,
          disbursedAmount: a.disbursed_amount == null ? null : num(a.disbursed_amount),
        })),
      }));
    }),

  // A line by hand:
  //   tranche — a later tranche of a synced lender application (SA / FM)
  //   credit  — a duplicate referral credited to the partner (Super Admin
  //             only, Suraj 20 Nov); lender, amount and date entered here.
  addLine: financeManagerProcedure
    .input(
      z.object({
        referralId: z.number().int().positive(),
        kind: z.enum(["tranche", "credit"]),
        applicationId: z.number().int().positive().optional(),
        lenderId: z.number().int().positive().optional(),
        amount: z.number().positive().max(1_000_000_000),
        on: isoDay,
        note: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const r = await db.loan_referral.findUnique({
        where: { id: input.referralId },
        select: { id: true, org_id: true, partner_user_id: true, send_status: true },
      });
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Referral not found" });
      let res: { created: boolean; id: number | null };
      if (input.kind === "credit") {
        if (ctx.cpUser.role !== AdminRole.SUPER_ADMIN) throw new TRPCError({ code: "FORBIDDEN", message: "Only a Super Admin can credit a duplicate referral." });
        if (r.send_status !== LoanReferralSendStatus.DUPLICATE) throw bad("Credit by hand is for duplicate referrals; this one is synced from the Enrollment App.");
        if (!input.lenderId) throw bad("Pick the lender.");
        const n = await db.loan_commission.count({ where: { referral_id: r.id, app_external_id: null } });
        res = await openLine({
          referral: r,
          applicationRowId: null,
          appExternalId: null,
          trancheNo: n + 1,
          source: LoanCommissionSource.CREDIT,
          lenderId: input.lenderId,
          amount: input.amount,
          on: dateOnly(input.on),
          note: input.note,
          createdBy: ctx.cpUser.id,
        });
      } else {
        const app = input.applicationId
          ? await db.loan_referral_application.findFirst({ where: { id: input.applicationId, referral_id: r.id }, select: { id: true, external_id: true, lender: true } })
          : null;
        if (!app) throw bad("Pick the lender application this tranche belongs to.");
        const existing = await db.loan_commission.findMany({
          where: { referral_id: r.id, app_external_id: app.external_id },
          select: { tranche_no: true, lender_id: true },
        });
        const lender = existing[0]?.lender_id ?? (await db.loan_lender.findUnique({ where: { name: app.lender }, select: { id: true } }))?.id;
        if (!lender) throw bad(`Add "${app.lender}" to the lender master first.`);
        res = await openLine({
          referral: r,
          applicationRowId: app.id,
          appExternalId: app.external_id,
          trancheNo: existing.length === 0 ? 1 : Math.max(...existing.map((e) => e.tranche_no)) + 1,
          source: LoanCommissionSource.MANUAL_TRANCHE,
          lenderId: lender,
          amount: input.amount,
          on: dateOnly(input.on),
          note: input.note,
          createdBy: ctx.cpUser.id,
        });
      }
      if (!res.created || res.id == null) throw bad("That line already exists. Refresh and try again.");
      await audit(input.kind === "credit" ? "loan_commission.credit_granted" : "loan_commission.tranche_added", "loan_commission", res.id, ctx.cpUser.id, {
        referralId: r.id,
        amount: input.amount,
        on: input.on,
        note: input.note,
      }, r.org_id);
      return { id: res.id };
    }),

  // The lender's rate on a date, for the add-line dialog preview.
  lenderPctOn: financeProcedure
    .input(z.object({ lenderId: z.number().int().positive(), on: isoDay }))
    .query(async ({ input }) => ({ pct: await lenderPctOn(input.lenderId, dateOnly(input.on)) })),
});
