import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  financeManagerProcedure,
  financeProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  BonusKind,
  TrancheKind,
  VarianceReason,
  VendorInvoiceStatus,
  financialYearOf,
} from "~/server/db/enums";
import { FINANCE_CURRENCIES } from "~/lib/currency";
import { bonusTotals, volumeBonusBoard } from "~/server/bonus-schemes";

// Bonus Schemes (Commission Rates › Bonus Schemes; 16 Nov 2026). Gated like
// the other finance masters: every finance role reads, Super Admin / Finance
// Manager edit. A scheme is saved on its own and never overwritten: once a
// commission has used it, only its end date, notes and on/off switch change;
// to change its terms, duplicate it and close the old one. The rules for
// applying them live in ~/server/bonus-schemes.

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
const round2 = (n: number) => Math.round(n * 100) / 100;
const orNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  if (!t) return null;
  return t;
};
const dateOrNull = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00Z`) : null);
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const slabInput = z.object({
  minStudents: z.number().int().min(1).max(65535),
  maxStudents: z.number().int().min(1).max(65535).nullable(),
  amountPerStudent: z.number().positive().max(9_999_999_999),
});
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date");

const schemeInput = z.object({
  kind: z.union([z.literal(BonusKind.VOLUME), z.literal(BonusKind.INCENTIVE)]),
  name: z.string().trim().min(2).max(150),
  currency: z.enum(FINANCE_CURRENCIES),
  activeFrom: dateStr.nullable(),
  activeTo: dateStr.nullable(),
  // Volume bonus: the contract (direct or vendor). Incentive: none.
  contractId: z.number().int().positive().nullable(),
  // Scope; null = any. Country is the university's ISO code (e.g. "IE").
  country: z.string().trim().toUpperCase().length(2).nullable(),
  universityId: z.number().int().positive().nullable(),
  intakeMonth: z.number().int().min(1).max(12).nullable(),
  intakeYear: z.number().int().min(2000).max(2100).nullable(),
  retroactive: z.boolean(),
  isActive: z.boolean(),
  notes: z.string().max(500).nullable(),
  slabs: z.array(slabInput).min(1).max(20),
});
type SchemeInput = z.infer<typeof schemeInput>;

// Slabs must not overlap; only the last may be open-ended ("11+").
function slabIssue(slabs: SchemeInput["slabs"]): string | null {
  const sorted = [...slabs].sort((a, b) => a.minStudents - b.minStudents);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (s.maxStudents != null && s.maxStudents < s.minStudents) {
      return `Slab ${s.minStudents}–${s.maxStudents}: the maximum is below the minimum.`;
    }
    const next = sorted[i + 1];
    if (next) {
      if (s.maxStudents == null) return "Only the last slab can be open-ended (no maximum).";
      if (next.minStudents <= s.maxStudents) {
        return `Slabs ${s.minStudents}–${s.maxStudents} and ${next.minStudents}${next.maxStudents ? `–${next.maxStudents}` : "+"} overlap.`;
      }
    }
  }
  return null;
}

async function validate(input: SchemeInput) {
  const issue = slabIssue(input.slabs);
  if (issue) throw new TRPCError({ code: "BAD_REQUEST", message: issue });
  if (input.activeFrom && input.activeTo && input.activeTo < input.activeFrom) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The end date is before the start date." });
  }
  if (input.kind === BonusKind.VOLUME) {
    if (!input.contractId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the university contract the volume bonus belongs to." });
    }
    const c = await db.commission_contract.findUnique({
      where: { id: input.contractId },
      select: { university_id: true },
    });
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That contract no longer exists." });
    return { universityId: c.university_id, contractId: input.contractId, country: null };
  }
  if (input.universityId) {
    const u = await db.university.findUnique({ where: { id: input.universityId }, select: { id: true } });
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "That university no longer exists." });
  }
  return { universityId: input.universityId, contractId: null, country: input.country };
}

function schemeData(input: SchemeInput, scope: { universityId: number | null; contractId: number | null; country: string | null }) {
  return {
    kind: input.kind,
    name: input.name,
    currency: input.currency,
    active_from: dateOrNull(input.activeFrom),
    active_to: dateOrNull(input.activeTo),
    contract_id: scope.contractId,
    country: scope.country,
    university_id: scope.universityId,
    intake_month: input.intakeMonth,
    intake_year: input.intakeYear,
    // Retroactive is a volume-bonus rule; incentives never uplift earlier students.
    retroactive: input.kind === BonusKind.VOLUME && input.retroactive ? 1 : 0,
    is_active: input.isActive ? 1 : 0,
    notes: orNull(input.notes),
  };
}
const slabRows = (slabs: SchemeInput["slabs"]) =>
  [...slabs]
    .sort((a, b) => a.minStudents - b.minStudents)
    .map((s) => ({ min_students: s.minStudents, max_students: s.maxStudents, amount_per_student: s.amountPerStudent }));

async function audit(action: string, schemeId: number, cpUserId: number, metadata: Record<string, unknown> = {}) {
  await db.audit_log.create({
    data: { action, entity_type: "bonus_scheme", entity_id: schemeId, metadata: { byCpUserId: cpUserId, ...metadata } },
  });
}

async function usageOf(schemeId: number) {
  return db.commission_bonus.count({ where: { scheme_id: schemeId } });
}

export const bonusSchemesRouter = createTRPCRouter({
  list: financeProcedure.query(async () => {
    const rows = await db.bonus_scheme.findMany({
      orderBy: [{ kind: "asc" }, { is_active: "desc" }, { created_at: "desc" }],
      include: {
        bonus_scheme_slab: { orderBy: { min_students: "asc" } },
        university: { select: { name: true } },
        contract: {
          select: {
            id: true,
            currency: true,
            university: { select: { name: true } },
            vendor: { select: { name: true } },
          },
        },
        _count: { select: { commission_bonus: true } },
      },
    });
    const totals = await db.commission_bonus.groupBy({
      by: ["scheme_id"],
      where: { scheme_id: { not: null } },
      _sum: { amount: true },
    });
    const totalBy = new Map(totals.map((t) => [t.scheme_id, num(t._sum.amount)]));
    const today = new Date().toISOString().slice(0, 10);
    return rows.map((s) => {
      const from = ymd(s.active_from);
      const to = ymd(s.active_to);
      return {
        id: s.id,
        kind: s.kind,
        name: s.name,
        currency: s.currency,
        activeFrom: from,
        activeTo: to,
        // Running now / upcoming / ended / switched off.
        state:
          s.is_active !== 1
            ? ("off" as const)
            : to && to < today
              ? ("ended" as const)
              : from && from > today
                ? ("upcoming" as const)
                : ("live" as const),
        contractId: s.contract_id,
        contractLabel: s.contract
          ? `${s.contract.university.name} · ${s.contract.vendor?.name ?? "Direct"}`
          : null,
        country: s.country,
        universityId: s.university_id,
        university: s.university?.name ?? null,
        intakeMonth: s.intake_month,
        intakeYear: s.intake_year,
        retroactive: s.retroactive === 1,
        isActive: s.is_active === 1,
        notes: s.notes,
        importedFromTiers: s.imported_from_tiers === 1,
        slabs: s.bonus_scheme_slab.map((b) => ({
          minStudents: b.min_students,
          maxStudents: b.max_students,
          amountPerStudent: num(b.amount_per_student),
        })),
        used: s._count.commission_bonus,
        totalApplied: round2(totalBy.get(s.id) ?? 0),
        createdAt: s.created_at,
      };
    });
  }),

  // Pickers for the scheme form: contracts (volume bonus), universities and
  // their countries (incentive scope).
  options: financeProcedure.query(async () => {
    const [contracts, universities] = await Promise.all([
      db.commission_contract.findMany({
        orderBy: [{ university: { name: "asc" } }, { id: "asc" }],
        select: {
          id: true,
          currency: true,
          is_default: true,
          university: { select: { id: true, name: true, country: true } },
          vendor: { select: { name: true, currency: true } },
        },
      }),
      db.university.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, country: true } }),
    ]);
    return {
      contracts: contracts.map((c) => ({
        id: c.id,
        label: `${c.university.name} · ${c.vendor?.name ?? "Direct"}${c.is_default ? "" : " (not default)"}`,
        currency: c.currency ?? c.vendor?.currency ?? null,
        universityId: c.university.id,
      })),
      universities: universities.map((u) => ({ id: u.id, name: u.name, country: u.country })),
      countries: Array.from(new Set(universities.map((u) => u.country).filter((c): c is string => !!c))).sort(),
    };
  }),

  create: financeManagerProcedure.input(schemeInput).mutation(async ({ ctx, input }) => {
    const scope = await validate(input);
    const s = await db.bonus_scheme.create({
      data: {
        ...schemeData(input, scope),
        created_by_cp_user_id: ctx.cpUser.id,
        bonus_scheme_slab: { create: slabRows(input.slabs) },
      },
    });
    await audit("bonus_scheme.created", s.id, ctx.cpUser.id, { name: input.name, kind: input.kind });
    return { id: s.id };
  }),

  // Edit an unused scheme fully. A used one keeps its terms: only the name,
  // end date, notes and on/off switch change (anything else is refused).
  update: financeManagerProcedure
    .input(schemeInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.bonus_scheme.findUnique({
        where: { id: input.id },
        include: { bonus_scheme_slab: { orderBy: { min_students: "asc" } } },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Scheme not found" });
      if (existing.kind !== input.kind) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A scheme's kind can't change." });
      }
      const used = await usageOf(input.id);
      const scope = await validate(input);
      if (used > 0) {
        const sameSlabs =
          JSON.stringify(slabRows(input.slabs)) ===
          JSON.stringify(
            existing.bonus_scheme_slab.map((b) => ({
              min_students: b.min_students,
              max_students: b.max_students,
              amount_per_student: num(b.amount_per_student),
            })),
          );
        const termsChanged =
          !sameSlabs ||
          existing.currency !== input.currency ||
          ymd(existing.active_from) !== input.activeFrom ||
          existing.contract_id !== scope.contractId ||
          existing.country !== scope.country ||
          existing.university_id !== scope.universityId ||
          existing.intake_month !== input.intakeMonth ||
          existing.intake_year !== input.intakeYear ||
          (existing.retroactive === 1) !== (input.kind === BonusKind.VOLUME && input.retroactive);
        if (termsChanged) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `This scheme has been applied to ${used} ${used === 1 ? "student" : "students"}, so its terms are locked. Duplicate it to set new terms, then end this one.`,
          });
        }
        await db.bonus_scheme.update({
          where: { id: input.id },
          data: {
            name: input.name,
            active_to: dateOrNull(input.activeTo),
            notes: orNull(input.notes),
            is_active: input.isActive ? 1 : 0,
          },
        });
        await audit("bonus_scheme.updated", input.id, ctx.cpUser.id, {
          locked: true,
          name: input.name,
          activeTo: input.activeTo,
          isActive: input.isActive,
        });
        return { success: true as const };
      }
      await db.$transaction([
        db.bonus_scheme_slab.deleteMany({ where: { scheme_id: input.id } }),
        db.bonus_scheme.update({
          where: { id: input.id },
          data: { ...schemeData(input, scope), bonus_scheme_slab: { create: slabRows(input.slabs) } },
        }),
      ]);
      await audit("bonus_scheme.updated", input.id, ctx.cpUser.id, {
        locked: false,
        before: {
          name: existing.name,
          currency: existing.currency,
          activeFrom: ymd(existing.active_from),
          activeTo: ymd(existing.active_to),
          slabs: existing.bonus_scheme_slab.map((b) => [b.min_students, b.max_students, num(b.amount_per_student)]),
        },
        after: { name: input.name, currency: input.currency, activeFrom: input.activeFrom, activeTo: input.activeTo, slabs: input.slabs },
      });
      return { success: true as const };
    }),

  setActive: financeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db.bonus_scheme.update({ where: { id: input.id }, data: { is_active: input.isActive ? 1 : 0 } });
      await audit(input.isActive ? "bonus_scheme.activated" : "bonus_scheme.deactivated", input.id, ctx.cpUser.id);
      return { success: true as const };
    }),

  // A copy to change a used scheme's terms. Starts switched off so the two
  // never both apply by accident.
  duplicate: financeManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const s = await db.bonus_scheme.findUnique({ where: { id: input.id }, include: { bonus_scheme_slab: true } });
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Scheme not found" });
      const copy = await db.bonus_scheme.create({
        data: {
          kind: s.kind,
          currency: s.currency,
          active_from: s.active_from,
          active_to: s.active_to,
          contract_id: s.contract_id,
          country: s.country,
          university_id: s.university_id,
          intake_month: s.intake_month,
          intake_year: s.intake_year,
          retroactive: s.retroactive,
          notes: s.notes,
          name: `${s.name} (copy)`.slice(0, 150),
          is_active: 0,
          imported_from_tiers: 0,
          created_by_cp_user_id: ctx.cpUser.id,
          bonus_scheme_slab: {
            create: s.bonus_scheme_slab.map((b) => ({
              min_students: b.min_students,
              max_students: b.max_students,
              amount_per_student: b.amount_per_student,
            })),
          },
        },
      });
      await audit("bonus_scheme.duplicated", copy.id, ctx.cpUser.id, { fromSchemeId: s.id });
      return { id: copy.id };
    }),

  // Only a scheme no commission has used; a used one is ended or switched off.
  remove: financeManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const used = await usageOf(input.id);
      if (used > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This scheme has been applied to students, so it's kept on record. Switch it off or set an end date instead.",
        });
      }
      const s = await db.bonus_scheme.delete({ where: { id: input.id } });
      await audit("bonus_scheme.deleted", input.id, ctx.cpUser.id, { name: s.name });
      return { success: true as const };
    }),

  // University Billing › Vendor Billing › Volume bonus due.
  volumeBonusDue: financeProcedure.query(() => volumeBonusBoard()),

  // Invoice volume bonuses on their own vendor invoice: one line per student,
  // each billing that student's volume-bonus instalment in full (no CP share).
  // Then Record Payment → Collections approval as for any instalment.
  createVolumeBonusInvoice: financeManagerProcedure
    .input(
      z.object({
        commissionBonusIds: z.array(z.number().int().positive()).min(1).max(200),
        invoiceNumber: z.string().trim().min(1).max(40),
        invoiceDate: dateStr,
        dueDate: dateStr.optional(),
        notes: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ids = Array.from(new Set(input.commissionBonusIds));
      const taken = await db.vendor_invoice.findUnique({ where: { invoice_number: input.invoiceNumber }, select: { id: true } });
      const duplicate = () =>
        new TRPCError({ code: "CONFLICT", message: `Invoice number ${input.invoiceNumber} is already in use — use a different number.` });
      if (taken) throw duplicate();
      const inv = await db
        .$transaction(async (tx) => {
          const rows = await tx.commission_bonus.findMany({
            where: { id: { in: ids }, kind: BonusKind.VOLUME },
            select: {
              id: true,
              amount: true,
              currency: true,
              commission_tranche: {
                select: { id: true, kind: true, vendor_invoice_item_tranche: { select: { id: true } } },
              },
              commission: {
                select: {
                  id: true,
                  vendor_id: true,
                  tuition_fee: true,
                  application: {
                    select: {
                      student: { select: { first_name: true, last_name: true } },
                      course: { select: { university_id: true } },
                    },
                  },
                },
              },
            },
          });
          if (rows.length !== ids.length) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Some of these volume bonuses no longer exist. Refresh and try again." });
          }
          const vendors = new Set(rows.map((r) => r.commission.vendor_id ?? 0));
          const currencies = new Set(rows.map((r) => r.currency));
          const unis = new Set(rows.map((r) => r.commission.application.course.university_id));
          if (vendors.size > 1) throw new TRPCError({ code: "BAD_REQUEST", message: "All bonuses on an invoice must be billed to the same vendor." });
          if (currencies.size > 1) throw new TRPCError({ code: "BAD_REQUEST", message: "All bonuses on an invoice must be in the same currency." });
          for (const r of rows) {
            const who = `${r.commission.application.student.first_name} ${r.commission.application.student.last_name}`.trim();
            if (r.commission_tranche?.kind !== TrancheKind.VOLUME_BONUS) {
              throw new TRPCError({ code: "BAD_REQUEST", message: `${who}'s volume bonus has no instalment to bill.` });
            }
            if (r.commission_tranche?.vendor_invoice_item_tranche) {
              throw new TRPCError({ code: "CONFLICT", message: `${who}'s volume bonus is already invoiced.` });
            }
          }
          const total = round2(rows.reduce((s, r) => s + num(r.amount), 0));
          const created = await tx.vendor_invoice.create({
            data: {
              invoice_number: input.invoiceNumber,
              vendor_id: rows[0]!.commission.vendor_id,
              university_id: unis.size === 1 ? rows[0]!.commission.application.course.university_id : null,
              currency: rows[0]!.currency,
              invoice_date: new Date(input.invoiceDate),
              due_date: input.dueDate ? new Date(input.dueDate) : null,
              status: VendorInvoiceStatus.SENT,
              total_expected_amount: total,
              notes: orNull(input.notes) ?? "Volume bonus",
              fy: financialYearOf(new Date(input.invoiceDate)),
              created_by_cp_user_id: ctx.cpUser.id,
            },
          });
          for (const r of rows) {
            await tx.vendor_invoice_item.create({
              data: {
                vendor_invoice_id: created.id,
                commission_id: r.commission.id,
                tuition_amount: r.commission.tuition_fee,
                calculated_commission: r.amount,
                expected_amount: r.amount,
                variance: 0,
                variance_reason: VarianceReason.NONE,
                vendor_invoice_item_tranche: { create: [{ commission_tranche_id: r.commission_tranche!.id }] },
              },
            });
          }
          await tx.audit_log.create({
            data: {
              action: "vendor_invoice.volume_bonus_created",
              entity_type: "vendor_invoice",
              entity_id: created.id,
              metadata: { byCpUserId: ctx.cpUser.id, commissionBonusIds: ids, total, currency: rows[0]!.currency },
            },
          });
          return created;
        })
        .catch((e: unknown) => {
          const code = typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
          if (code === "P2002") {
            if (JSON.stringify((e as { meta?: unknown }).meta ?? "").includes("tranche")) {
              throw new TRPCError({ code: "CONFLICT", message: "One of these bonuses was just invoiced elsewhere." });
            }
            throw duplicate();
          }
          throw e;
        });
      return { vendorInvoiceId: inv.id };
    }),

  // Bonus money by financial year, kind and currency (Finance dashboard).
  totals: financeProcedure
    .input(z.object({ fy: z.number().int().optional() }).optional())
    .query(({ input }) => bonusTotals({ fy: input?.fy })),
});
