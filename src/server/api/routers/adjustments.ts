import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  financeManagerProcedure,
  financeProcedure,
  superAdminProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  AdjustmentDirection,
  AdjustmentSide,
  AdjustmentStatus,
  UserType,
  financialYearOf,
} from "~/server/db/enums";
import { FINANCE_CURRENCIES } from "~/lib/currency";
import {
  PAYEE_LABEL_SELECT,
  independentPayee,
  orgPayee,
  payeeData,
  payeeLabel,
  payeeOf,
  type Payee,
} from "~/server/payee";
import {
  activeHold,
  adjustmentTotals,
  applyUniversityAdjustment,
  partnerAdjustmentBalances,
  payeeKey,
  activeHolds,
  standingUniversityBalances,
} from "~/server/adjustments";
import { assignNoteNumber, sendAdjustmentNote } from "~/server/adjustment-note";

// Finance › Adjustments (16 Nov 2026). See ~/server/adjustments for the model.
// Any finance role drafts and adds evidence; ONLY a Super Admin approves or
// rejects (Suraj). Payout holds: Finance Manager / Super Admin. Everything here
// is staff-only: the partner sees "Adjustment" + the partner note through
// partnerCommission.adjustments, never the reason, internal note or evidence.

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
const round2 = (n: number) => Math.round(n * 100) / 100;
const orNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  if (!t) return null;
  return t;
};

const evidenceUrl = z
  .string()
  .max(500)
  .refine((u) => /^(\/uploads\/)?adjustment-evidence\//.test(u), "Upload the evidence file first");

const payeeInput = z.union([
  z.object({ orgId: z.number().int().positive() }),
  z.object({ userId: z.number().int().positive() }),
]);
const toPayee = (p: z.infer<typeof payeeInput>): Payee => ("orgId" in p ? orgPayee(p.orgId) : independentPayee(p.userId));

async function staffNames(ids: (number | null | undefined)[]): Promise<Map<number, string>> {
  const unique = Array.from(new Set(ids.filter((x): x is number => x != null)));
  if (unique.length === 0) return new Map();
  const rows = await db.collegepond_user.findMany({
    where: { id: { in: unique } },
    select: { id: true, first_name: true, last_name: true },
  });
  return new Map(rows.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]));
}

async function audit(action: string, adjustmentId: number, orgId: number | null, metadata: Record<string, unknown>) {
  await db.audit_log.create({
    data: { org_id: orgId, action, entity_type: "adjustment", entity_id: adjustmentId, metadata: metadata as object },
  });
}

const studentName = (s: { first_name: string; last_name: string }) => `${s.first_name} ${s.last_name}`.trim();

export const adjustmentsRouter = createTRPCRouter({
  // Reasons for the dropdown: active ones in master order (Settings ›
  // Adjustment Reasons, Super Admin).
  reasons: financeProcedure.query(async () => {
    const rows = await db.adjustment_reason.findMany({
      where: { is_active: 1 },
      orderBy: [{ sort_order: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    });
    return rows;
  }),

  // Vendors and universities for a university-side adjustment without a
  // commission (a direct contract's counterparty is the university).
  counterparties: financeProcedure.query(async () => {
    const [vendors, universities] = await Promise.all([
      db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, currency: true } }),
      db.university.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    return { vendors, universities };
  }),

  // Commission picker: by student name, CP id or university (or one
  // commission by id, to pre-fill "Raise matching partner deduction").
  commissionSearch: financeProcedure
    .input(z.object({ q: z.string().trim().max(100), id: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      const q = input.q;
      if (input.id == null && q.length < 2) return [];
      const cpId = /^cp-?0*(\d+)$/i.exec(q)?.[1];
      const words = q.split(/\s+/).filter(Boolean).slice(0, 3);
      const rows = await db.commission.findMany({
        where: input.id != null
          ? { id: input.id }
          : cpId
          ? { application: { student_id: Number(cpId) } }
          : {
              OR: [
                {
                  AND: words.map((w) => ({
                    application: {
                      student: { OR: [{ first_name: { contains: w } }, { last_name: { contains: w } }] },
                    },
                  })),
                },
                { application: { course: { university: { name: { contains: q } } } } },
              ],
            },
        take: 20,
        orderBy: { id: "desc" },
        select: {
          id: true,
          currency: true,
          vendor_id: true,
          vendor: { select: { name: true } },
          ...PAYEE_LABEL_SELECT,
          org_id: true,
          payee_user_id: true,
          application: {
            select: {
              student: { select: { id: true, first_name: true, last_name: true } },
              course: { select: { name: true, university: { select: { id: true, name: true } } } },
            },
          },
          commission_tranche: { orderBy: { seq: "asc" }, select: { id: true, seq: true, name: true, status: true, amount: true } },
          vendor_invoice_item: {
            select: {
              vendor_invoice: { select: { id: true, invoice_number: true, currency: true } },
              vendor_invoice_item_tranche: { select: { commission_tranche_id: true } },
            },
          },
        },
      });
      return rows.map((c) => ({
        commissionId: c.id,
        student: studentName(c.application.student),
        cpStudentId: `CP-${String(c.application.student.id).padStart(5, "0")}`,
        university: c.application.course.university.name,
        universityId: c.application.course.university.id,
        program: c.application.course.name,
        vendorId: c.vendor_id,
        vendorName: c.vendor?.name ?? "Direct",
        currency: c.currency,
        payee: c.org_id != null ? { orgId: c.org_id } : { userId: c.payee_user_id! },
        ...payeeLabel(c),
        tranches: c.commission_tranche.map((t) => ({
          id: t.id,
          seq: t.seq,
          name: t.name ?? `Instalment ${t.seq}`,
          status: t.status,
          amount: num(t.amount),
        })),
        invoices: Array.from(
          new Map(
            c.vendor_invoice_item.map((l) => [
              l.vendor_invoice.id,
              { id: l.vendor_invoice.id, number: l.vendor_invoice.invoice_number, currency: l.vendor_invoice.currency },
            ]),
          ).values(),
        ),
      }));
    }),

  // Payee picker: agencies by name, independents by name.
  payeeSearch: financeProcedure
    .input(z.object({ q: z.string().trim().max(100) }))
    .query(async ({ input }) => {
      if (input.q.length < 2) return [];
      const [orgs, users] = await Promise.all([
        db.organization.findMany({
          where: { name: { contains: input.q } },
          take: 10,
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
        db.user.findMany({
          where: {
            type: UserType.INDEPENDENT_COUNSELLOR,
            OR: [{ first_name: { contains: input.q } }, { last_name: { contains: input.q } }, { email: { contains: input.q } }],
          },
          take: 10,
          orderBy: { first_name: "asc" },
          select: { id: true, first_name: true, last_name: true },
        }),
      ]);
      return [
        ...orgs.map((o) => ({ key: `o${o.id}`, payee: { orgId: o.id }, name: o.name, type: "agency" as const })),
        ...users.map((u) => ({
          key: `u${u.id}`,
          payee: { userId: u.id },
          name: `${u.first_name} ${u.last_name}`.trim(),
          type: "independent" as const,
        })),
      ];
    }),

  // Every adjustment (newest first), or one side / status.
  list: financeProcedure
    .input(
      z
        .object({
          status: z.enum(["draft", "approved", "rejected", "all"]).default("all"),
          side: z.enum(["university", "partner", "all"]).default("all"),
          commissionId: z.number().int().positive().optional(),
          vendorInvoiceId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const status =
        input?.status === "draft"
          ? AdjustmentStatus.DRAFT
          : input?.status === "approved"
            ? AdjustmentStatus.APPROVED
            : input?.status === "rejected"
              ? AdjustmentStatus.REJECTED
              : undefined;
      const side =
        input?.side === "university" ? AdjustmentSide.UNIVERSITY : input?.side === "partner" ? AdjustmentSide.PARTNER : undefined;
      const rows = await db.adjustment.findMany({
        where: {
          ...(status !== undefined ? { status } : {}),
          ...(side !== undefined ? { side } : {}),
          ...(input?.commissionId ? { commission_id: input.commissionId } : {}),
          ...(input?.vendorInvoiceId
            ? { OR: [{ vendor_invoice_id: input.vendorInvoiceId }, { adjustment_allocation: { some: { vendor_invoice_id: input.vendorInvoiceId } } }] }
            : {}),
        },
        orderBy: [{ status: "asc" }, { id: "desc" }],
        take: 500,
        include: {
          reason: { select: { name: true } },
          vendor: { select: { name: true } },
          university: { select: { name: true } },
          ...PAYEE_LABEL_SELECT,
          commission: {
            select: {
              application: {
                select: {
                  student: { select: { id: true, first_name: true, last_name: true } },
                  course: { select: { university: { select: { name: true } } } },
                },
              },
            },
          },
          commission_tranche: { select: { seq: true, name: true } },
          vendor_invoice: { select: { invoice_number: true } },
          adjustment_evidence: { orderBy: { id: "asc" } },
          adjustment_allocation: {
            orderBy: { id: "asc" },
            include: {
              vendor_invoice: { select: { invoice_number: true } },
              partner_payout: { select: { id: true, released_at: true, invoice: { select: { invoice_number: true } } } },
            },
          },
          source_adjustment: { select: { id: true } },
          derived_adjustments: { select: { id: true, status: true } },
        },
      });
      const names = await staffNames(
        rows.flatMap((r) => [
          r.created_by_cp_user_id,
          r.decided_by_cp_user_id,
          ...r.adjustment_evidence.map((e) => e.uploaded_by_cp_user_id),
        ]),
      );
      const [holds] = await Promise.all([activeHolds()]);
      return rows.map((r) => {
        const allocated = round2(r.adjustment_allocation.reduce((s, a) => s + num(a.amount), 0));
        const partner = r.side === AdjustmentSide.PARTNER;
        return {
          id: r.id,
          side: partner ? ("partner" as const) : ("university" as const),
          direction: r.direction === AdjustmentDirection.CREDIT ? ("credit" as const) : ("deduction" as const),
          status: r.status,
          reason: r.reason.name,
          reasonId: r.reason_id,
          amount: num(r.amount),
          currency: r.currency,
          date: r.adjustment_date,
          vendorId: r.vendor_id,
          universityId: r.university_id,
          counterparty: r.vendor?.name ?? (r.university ? `${r.university.name} (direct)` : null),
          payee: r.org_id != null || r.payee_user_id != null ? { ...payeeLabel(r), key: payeeKey(r) } : null,
          payeeRef: r.org_id != null ? { orgId: r.org_id } : r.payee_user_id != null ? { userId: r.payee_user_id } : null,
          payeeOnHold: partner && holds.has(payeeKey(r)),
          commissionId: r.commission_id,
          student: r.commission
            ? {
                name: studentName(r.commission.application.student),
                cpStudentId: `CP-${String(r.commission.application.student.id).padStart(5, "0")}`,
                university: r.commission.application.course.university.name,
              }
            : null,
          tranche: r.commission_tranche ? (r.commission_tranche.name ?? `Instalment ${r.commission_tranche.seq}`) : null,
          trancheId: r.commission_tranche_id,
          vendorInvoiceId: r.vendor_invoice_id,
          vendorInvoice: r.vendor_invoice?.invoice_number ?? null,
          internalNote: r.internal_note,
          partnerNote: r.partner_note,
          noteNumber: r.note_number,
          createdBy: names.get(r.created_by_cp_user_id) ?? `Staff #${r.created_by_cp_user_id}`,
          createdAt: r.created_at,
          decidedBy: r.decided_by_cp_user_id != null ? (names.get(r.decided_by_cp_user_id) ?? `Staff #${r.decided_by_cp_user_id}`) : null,
          decidedAt: r.decided_at,
          decisionNote: r.decision_note,
          evidence: r.adjustment_evidence.map((e) => ({
            id: e.id,
            url: e.file_url,
            name: e.file_name ?? e.file_url.split("/").pop() ?? "file",
            by: names.get(e.uploaded_by_cp_user_id) ?? null,
            at: e.created_at,
          })),
          allocations: r.adjustment_allocation.map((a) => ({
            id: a.id,
            amount: num(a.amount),
            at: a.created_at,
            vendorInvoice: a.vendor_invoice?.invoice_number ?? null,
            payoutInvoice: a.partner_payout?.invoice.invoice_number ?? null,
          })),
          applied: allocated,
          balance: r.status === AdjustmentStatus.APPROVED ? round2(num(r.amount) - allocated) : null,
          sourceAdjustmentId: r.source_adjustment?.id ?? null,
          derived: r.derived_adjustments.map((d) => ({ id: d.id, status: d.status })),
        };
      });
    }),

  // Header numbers for the page (and the Finance dashboard): drafts awaiting a
  // Super Admin, standing university balances, partner balances to recover,
  // totals for an FY.
  summary: financeProcedure
    .input(z.object({ fy: z.number().int().optional() }).optional())
    .query(async ({ input }) => {
      const [drafts, standing, partner, totals] = await Promise.all([
        db.adjustment.count({ where: { status: AdjustmentStatus.DRAFT } }),
        standingUniversityBalances(),
        partnerAdjustmentBalances(),
        adjustmentTotals(input?.fy),
      ]);
      const partnerToRecoverInr = round2(Array.from(partner.values()).reduce((s, v) => s + v.deductionInr, 0));
      const partnerCreditsDueInr = round2(Array.from(partner.values()).reduce((s, v) => s + v.creditInr, 0));
      return { drafts, standingUniversity: standing, partnerToRecoverInr, partnerCreditsDueInr, totals };
    }),

  // Raise a draft. UNIVERSITY side: a commission (its vendor / university is
  // the counterparty) or a vendor invoice, or just a vendor / university.
  // PARTNER side: a payee (or a commission, whose payee it is), INR only.
  create: financeProcedure
    .input(
      z.object({
        side: z.enum(["university", "partner"]),
        direction: z.enum(["deduction", "credit"]).default("deduction"),
        reasonId: z.number().int().positive(),
        amount: z.number().positive().max(1_000_000_000),
        currency: z.enum(FINANCE_CURRENCIES),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        commissionId: z.number().int().positive().optional(),
        trancheId: z.number().int().positive().optional(),
        vendorInvoiceId: z.number().int().positive().optional(),
        vendorId: z.number().int().positive().optional(),
        universityId: z.number().int().positive().optional(),
        payee: payeeInput.optional(),
        internalNote: z.string().trim().max(1000).optional(),
        partnerNote: z.string().trim().max(500).optional(),
        sourceAdjustmentId: z.number().int().positive().optional(),
        evidence: z.array(z.object({ url: evidenceUrl, name: z.string().trim().max(255).optional() })).max(10).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const partner = input.side === "partner";
      const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
      const reason = await db.adjustment_reason.findUnique({ where: { id: input.reasonId }, select: { is_active: true } });
      if (reason?.is_active !== 1) throw bad("Pick an active reason.");
      if (round2(input.amount) !== input.amount) {
        throw bad("Amounts have at most two decimals.");
      }

      const comm = input.commissionId
        ? await db.commission.findUnique({
            where: { id: input.commissionId },
            select: {
              id: true,
              org_id: true,
              payee_user_id: true,
              vendor_id: true,
              application: { select: { course: { select: { university_id: true } } } },
              commission_tranche: { select: { id: true } },
              vendor_invoice_item: { select: { vendor_invoice_id: true } },
            },
          })
        : null;
      if (input.commissionId && !comm) throw bad("That commission no longer exists.");
      if (input.trancheId && !comm?.commission_tranche.some((t) => t.id === input.trancheId)) {
        throw bad("That instalment isn't part of the chosen commission.");
      }
      const source = input.sourceAdjustmentId
        ? await db.adjustment.findUnique({ where: { id: input.sourceAdjustmentId }, select: { id: true, side: true } })
        : null;
      if (input.sourceAdjustmentId && source?.side !== AdjustmentSide.UNIVERSITY) {
        throw bad("A partner deduction can only be linked to a university adjustment.");
      }

      let data: {
        vendor_id: number | null;
        university_id: number | null;
        org_id: number | null;
        payee_user_id: number | null;
        vendor_invoice_id: number | null;
        currency: string;
      };
      if (partner) {
        if (input.currency !== "INR") throw bad("Partner adjustments are in INR, like claims and payouts.");
        const fromComm = comm ? payeeOf(comm) : null;
        const given = input.payee ? toPayee(input.payee) : null;
        const payee = given ?? fromComm;
        if (!payee) throw bad("Pick the partner (or a commission) this adjustment is for.");
        if (fromComm && given && (fromComm.orgId !== given.orgId || fromComm.userId !== given.userId)) {
          throw bad("That commission belongs to a different partner.");
        }
        if (payee.orgId != null) {
          if (!(await db.organization.findUnique({ where: { id: payee.orgId }, select: { id: true } }))) throw bad("Partner not found.");
        } else if (
          !(await db.user.findFirst({ where: { id: payee.userId, type: UserType.INDEPENDENT_COUNSELLOR }, select: { id: true } }))
        ) {
          throw bad("Partner not found.");
        }
        if (input.vendorInvoiceId) throw bad("A partner adjustment isn't linked to a vendor invoice.");
        data = {
          vendor_id: comm?.vendor_id ?? null,
          university_id: comm?.application.course.university_id ?? null,
          ...payeeData(payee),
          vendor_invoice_id: null,
          currency: "INR",
        };
      } else {
        if (input.payee) throw bad("A university adjustment doesn't name a partner; raise a partner deduction separately.");
        const inv = input.vendorInvoiceId
          ? await db.vendor_invoice.findUnique({
              where: { id: input.vendorInvoiceId },
              select: { id: true, vendor_id: true, currency: true, vendor_invoice_item: { select: { commission_id: true, commission: { select: { application: { select: { course: { select: { university_id: true } } } } } } } } },
            })
          : null;
        if (input.vendorInvoiceId && !inv) throw bad("That vendor invoice no longer exists.");
        if (inv && comm && !inv.vendor_invoice_item.some((l) => l.commission_id === comm.id)) {
          throw bad("That commission isn't on the chosen invoice.");
        }
        if (inv && inv.currency !== input.currency) {
          throw bad(`Invoice is in ${inv.currency}; the adjustment must be in the same currency.`);
        }
        const vendorId = comm ? comm.vendor_id : inv ? inv.vendor_id : (input.vendorId ?? null);
        const universityId =
          comm?.application.course.university_id ??
          (inv && inv.vendor_id == null ? (inv.vendor_invoice_item[0]?.commission.application.course.university_id ?? null) : null) ??
          input.universityId ??
          null;
        if (vendorId == null && universityId == null) {
          throw bad("Pick the vendor or university this adjustment is with (or a commission / invoice).");
        }
        data = { vendor_id: vendorId, university_id: universityId, org_id: null, payee_user_id: null, vendor_invoice_id: inv?.id ?? null, currency: input.currency };
      }

      const created = await db.$transaction(async (tx) => {
        const a = await tx.adjustment.create({
          data: {
            side: partner ? AdjustmentSide.PARTNER : AdjustmentSide.UNIVERSITY,
            direction: input.direction === "credit" ? AdjustmentDirection.CREDIT : AdjustmentDirection.DEDUCTION,
            status: AdjustmentStatus.DRAFT,
            reason_id: input.reasonId,
            amount: input.amount,
            adjustment_date: new Date(`${input.date}T00:00:00Z`),
            commission_id: comm?.id ?? null,
            commission_tranche_id: input.trancheId ?? null,
            source_adjustment_id: source?.id ?? null,
            internal_note: orNull(input.internalNote),
            // The partner never sees a university adjustment.
            partner_note: partner ? orNull(input.partnerNote) : null,
            created_by_cp_user_id: ctx.cpUser.id,
            ...data,
          },
        });
        if (input.evidence.length > 0) {
          await tx.adjustment_evidence.createMany({
            data: input.evidence.map((e) => ({
              adjustment_id: a.id,
              file_url: e.url,
              file_name: orNull(e.name),
              uploaded_by_cp_user_id: ctx.cpUser.id,
            })),
          });
        }
        return a;
      });
      await audit("adjustment.drafted", created.id, created.org_id, {
        byCpUserId: ctx.cpUser.id,
        side: input.side,
        direction: input.direction,
        amount: input.amount,
        currency: data.currency,
        reasonId: input.reasonId,
        commissionId: comm?.id ?? null,
        payeeUserId: created.payee_user_id,
        vendorId: created.vendor_id,
        universityId: created.university_id,
        vendorInvoiceId: created.vendor_invoice_id,
        sourceAdjustmentId: created.source_adjustment_id,
        evidence: input.evidence.length,
      });
      return { id: created.id };
    }),

  // More evidence on an existing adjustment (any status; append-only).
  addEvidence: financeProcedure
    .input(z.object({ adjustmentId: z.number().int().positive(), url: evidenceUrl, name: z.string().trim().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      const a = await db.adjustment.findUnique({ where: { id: input.adjustmentId }, select: { id: true, org_id: true } });
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Adjustment not found." });
      const e = await db.adjustment_evidence.create({
        data: { adjustment_id: a.id, file_url: input.url, file_name: orNull(input.name), uploaded_by_cp_user_id: ctx.cpUser.id },
      });
      await audit("adjustment.evidence_added", a.id, a.org_id, { byCpUserId: ctx.cpUser.id, evidenceId: e.id, fileName: e.file_name });
      return { id: e.id };
    }),

  // Approve (Super Admin only). University side: applied to invoices now.
  // Partner side: numbered Adjustment Note, emailed; netted at the next release.
  approve: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const result = await db.$transaction(async (tx) => {
        const locked = await tx.$queryRawUnsafe<{ status: number }[]>(
          "SELECT status FROM adjustment WHERE id = ? FOR UPDATE",
          input.id,
        );
        if (locked.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Adjustment not found." });
        if (Number(locked[0]!.status) !== AdjustmentStatus.DRAFT) {
          throw new TRPCError({ code: "CONFLICT", message: "This adjustment has already been decided." });
        }
        const a = await tx.adjustment.update({
          where: { id: input.id },
          data: {
            status: AdjustmentStatus.APPROVED,
            decided_by_cp_user_id: ctx.cpUser.id,
            decided_at: now,
            decision_note: orNull(input.note),
          },
          select: { id: true, side: true, org_id: true, payee_user_id: true, amount: true, currency: true },
        });
        let noteNumber: string | null = null;
        let standing: number | null = null;
        if (a.side === AdjustmentSide.PARTNER) {
          noteNumber = await assignNoteNumber(tx, a.id, financialYearOf(now));
        } else {
          standing = await applyUniversityAdjustment(tx, a.id, ctx.cpUser.id);
        }
        return { a, noteNumber, standing };
      });
      await audit("adjustment.approved", input.id, result.a.org_id, {
        byCpUserId: ctx.cpUser.id,
        note: orNull(input.note),
        noteNumber: result.noteNumber,
        payeeUserId: result.a.payee_user_id,
        standingCredit: result.standing,
      });
      if (result.a.side === AdjustmentSide.PARTNER) void sendAdjustmentNote(input.id);
      return { noteNumber: result.noteNumber, standingCredit: result.standing };
    }),

  reject: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().trim().min(1, "Give a reason").max(500) }))
    .mutation(async ({ ctx, input }) => {
      const res = await db.adjustment.updateMany({
        where: { id: input.id, status: AdjustmentStatus.DRAFT },
        data: {
          status: AdjustmentStatus.REJECTED,
          decided_by_cp_user_id: ctx.cpUser.id,
          decided_at: new Date(),
          decision_note: input.note,
        },
      });
      if (res.count === 0) throw new TRPCError({ code: "CONFLICT", message: "This adjustment has already been decided." });
      const a = await db.adjustment.findUniqueOrThrow({ where: { id: input.id }, select: { org_id: true, payee_user_id: true } });
      await audit("adjustment.rejected", input.id, a.org_id, { byCpUserId: ctx.cpUser.id, note: input.note, payeeUserId: a.payee_user_id });
      return { success: true as const };
    }),

  // ---- payout holds ----------------------------------------------------------

  holds: financeProcedure.query(async () => {
    const rows = await db.payout_hold.findMany({
      orderBy: [{ id: "desc" }],
      take: 300,
      include: { ...PAYEE_LABEL_SELECT },
    });
    const names = await staffNames(rows.flatMap((r) => [r.placed_by_cp_user_id, r.lifted_by_cp_user_id]));
    return rows.map((r) => ({
      id: r.id,
      ...payeeLabel(r),
      payeeRef: r.org_id != null ? { orgId: r.org_id } : { userId: r.payee_user_id! },
      active: r.lifted_at == null,
      reason: r.reason,
      placedBy: names.get(r.placed_by_cp_user_id) ?? null,
      placedAt: r.placed_at,
      liftedBy: r.lifted_by_cp_user_id != null ? (names.get(r.lifted_by_cp_user_id) ?? null) : null,
      liftedAt: r.lifted_at,
      liftNote: r.lift_note,
    }));
  }),

  placeHold: financeManagerProcedure
    .input(z.object({ payee: payeeInput, reason: z.string().trim().min(3, "Give a reason").max(500) }))
    .mutation(async ({ ctx, input }) => {
      const payee = toPayee(input.payee);
      const h = await db.$transaction(async (tx) => {
        // Serialise holds per payee so two can't be active at once.
        if (payee.orgId != null) {
          await tx.$queryRawUnsafe("SELECT id FROM organization WHERE id = ? FOR UPDATE", payee.orgId);
        } else {
          await tx.$queryRawUnsafe("SELECT id FROM user WHERE id = ? FOR UPDATE", payee.userId);
        }
        if (await activeHold(payee, tx)) {
          throw new TRPCError({ code: "CONFLICT", message: "This partner is already on payout hold." });
        }
        return tx.payout_hold.create({
          data: { ...payeeData(payee), reason: input.reason, placed_by_cp_user_id: ctx.cpUser.id },
        });
      });
      await db.audit_log.create({
        data: {
          org_id: payee.orgId,
          action: "payout_hold.placed",
          entity_type: "payout_hold",
          entity_id: h.id,
          metadata: { byCpUserId: ctx.cpUser.id, payeeUserId: payee.userId, reason: input.reason },
        },
      });
      return { id: h.id };
    }),

  liftHold: financeManagerProcedure
    .input(z.object({ holdId: z.number().int().positive(), note: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const res = await db.payout_hold.updateMany({
        where: { id: input.holdId, lifted_at: null },
        data: { lifted_at: new Date(), lifted_by_cp_user_id: ctx.cpUser.id, lift_note: orNull(input.note) },
      });
      if (res.count === 0) throw new TRPCError({ code: "CONFLICT", message: "That hold was already lifted." });
      const h = await db.payout_hold.findUniqueOrThrow({ where: { id: input.holdId }, select: { org_id: true, payee_user_id: true } });
      await db.audit_log.create({
        data: {
          org_id: h.org_id,
          action: "payout_hold.lifted",
          entity_type: "payout_hold",
          entity_id: input.holdId,
          metadata: { byCpUserId: ctx.cpUser.id, payeeUserId: h.payee_user_id, note: orNull(input.note) },
        },
      });
      return { success: true as const };
    }),
});
