import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  financeProcedure,
  financeManagerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  VENDOR_TYPE_CODES,
  COMMISSION_TYPE_CODES,
  CommissionType,
} from "~/server/db/enums";
import { FINANCE_CURRENCIES } from "~/lib/currency";
import { trancheOvershoot, trancheScheduleIssue } from "~/server/commission-schedule";

// Prisma Decimal -> number at the API boundary (the house convention; superjson
// also handles Decimal, but routers serialise explicitly).
type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number | null => (d == null ? null : d.toNumber());
// Empty/whitespace strings collapse to null so we never persist "".
const orNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  if (!t) return null;
  return t;
};

const vendorType = z
  .number()
  .int()
  .refine((v) => (VENDOR_TYPE_CODES as number[]).includes(v), "Invalid vendor type");
const commissionType = z
  .number()
  .int()
  .refine(
    (v) => (COMMISSION_TYPE_CODES as number[]).includes(v),
    "Invalid commission type",
  );

// The agreement currency of a vendor / contract (30 Oct 2026). Flat rates,
// fixed tranche amounts and bonus tiers are recorded in it.
const currency = z.enum(FINANCE_CURRENCIES);

const idInput = z.object({ id: z.number().int().positive() });

// A contract's currency, falling back to its vendor's; null = rows made before
// contracts had one (flat amounts then followed the course currency).
const contractCurrency = (c: { currency: string | null; vendor?: { currency: string | null } | null }) =>
  c.currency ?? c.vendor?.currency ?? null;

// The contract's university-wide (headline) rate — what a FLAT tranche
// schedule must add up to.
async function headlineOf(contractId: number) {
  const r = await db.commission_rate.findFirst({
    where: { contract_id: contractId, course_id: null },
    select: { commission_type: true, rate: true },
  });
  return r ? { commissionType: r.commission_type, rate: r.rate.toNumber() } : null;
}
const parseDate = (s?: string | null): Date | null =>
  s ? new Date(s) : null;

export const commissionRatesRouter = createTRPCRouter({
  // ========================================================================
  // Vendors
  // ========================================================================
  listVendors: financeProcedure.query(async () => {
    const rows = await db.vendor.findMany({ orderBy: { name: "asc" } });
    return rows.map((v) => ({
      id: v.id,
      name: v.name,
      type: v.type,
      contactName: v.contact_name,
      contactEmail: v.contact_email,
      contactPhone: v.contact_phone,
      address: v.address,
      currency: v.currency,
      isActive: v.is_active === 1,
    }));
  }),

  createVendor: financeManagerProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(150),
        type: vendorType,
        contactName: z.string().max(100).optional(),
        contactEmail: z.string().email().max(255).optional().or(z.literal("")),
        contactPhone: z.string().max(45).optional(),
        address: z.string().max(255).optional(),
        currency,
      }),
    )
    .mutation(async ({ input }) => {
      const v = await db.vendor.create({
        data: {
          name: input.name,
          type: input.type,
          contact_name: orNull(input.contactName),
          contact_email: orNull(input.contactEmail),
          contact_phone: orNull(input.contactPhone),
          address: orNull(input.address),
          currency: input.currency,
        },
      });
      return { id: v.id };
    }),

  updateVendor: financeManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(150),
        type: vendorType,
        contactName: z.string().max(100).optional(),
        contactEmail: z.string().email().max(255).optional().or(z.literal("")),
        contactPhone: z.string().max(45).optional(),
        address: z.string().max(255).optional(),
        // The agreement currency. Existing contracts keep the currency they
        // were made with; editing a contract changes that contract's.
        currency,
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await db.vendor.update({
        where: { id: input.id },
        data: {
          name: input.name,
          type: input.type,
          contact_name: orNull(input.contactName),
          contact_email: orNull(input.contactEmail),
          contact_phone: orNull(input.contactPhone),
          address: orNull(input.address),
          currency: input.currency,
          ...(input.isActive === undefined
            ? {}
            : { is_active: input.isActive ? 1 : 0 }),
        },
      });
      return { success: true as const };
    }),

  removeVendor: financeManagerProcedure
    .input(idInput)
    .mutation(async ({ input }) => {
      const contracts = await db.commission_contract.count({
        where: { vendor_id: input.id },
      });
      if (contracts > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This vendor still has contracts. Remove them first.",
        });
      }
      await db.vendor.delete({ where: { id: input.id } });
      return { success: true as const };
    }),

  // ========================================================================
  // Lookups — universities + their courses, for the entry modals' dropdowns.
  // ========================================================================
  universitiesForPicker: financeProcedure.query(async () => {
    return db.university.findMany({
      select: { id: true, name: true, country: true },
      orderBy: { name: "asc" },
    });
  }),

  coursesForUniversity: financeProcedure
    .input(z.object({ universityId: z.number().int().positive() }))
    .query(async ({ input }) => {
      return db.course.findMany({
        where: { university_id: input.universityId },
        select: { id: true, name: true, degree_level: true },
        orderBy: { name: "asc" },
      });
    }),

  // ========================================================================
  // Contracts (+ nested rates / bonus tiers / tranche templates)
  // ========================================================================
  // Full payload for the "Commission Entry" tab. The page splits direct
  // contracts (vendorId === null) from third-party vendors.
  listContracts: financeProcedure.query(async () => {
    const rows = await db.commission_contract.findMany({
      include: {
        vendor: true,
        university: { select: { id: true, name: true, country: true } },
        commission_rate: {
          include: { course: { select: { id: true, name: true } } },
          orderBy: { id: "asc" },
        },
        commission_bonus_tier: { orderBy: { min_students: "asc" } },
        commission_tranche_template: { orderBy: { seq: "asc" } },
      },
      orderBy: { university: { name: "asc" } },
    });
    return rows.map((c) => {
      const headline = c.commission_rate.find((r) => r.course_id === null) ?? null;
      return {
      id: c.id,
      universityId: c.university_id,
      universityName: c.university.name,
      country: c.university.country,
      vendorId: c.vendor_id,
      vendorName: c.vendor?.name ?? null,
      vendorType: c.vendor?.type ?? null,
      // null = not set (older contracts): flat amounts follow the course currency.
      currency: contractCurrency(c),
      cpSharePct: num(c.cp_share_pct),
      isDefault: c.is_default === 1,
      effectiveDate: c.effective_date,
      notes: c.notes,
      rates: c.commission_rate.map((r) => ({
        id: r.id,
        courseId: r.course_id,
        courseName: r.course?.name ?? null,
        level: r.level,
        commissionType: r.commission_type,
        rate: num(r.rate),
        currency: r.currency,
      })),
      bonusTiers: c.commission_bonus_tier.map((b) => ({
        id: b.id,
        minStudents: b.min_students,
        maxStudents: b.max_students,
        amountPerStudent: num(b.amount_per_student),
        currency: b.currency,
      })),
      tranches: c.commission_tranche_template.map((t) => ({
        id: t.id,
        seq: t.seq,
        name: t.name,
        amount: num(t.amount),
        pct: num(t.pct),
        timing: t.timing,
      })),
      // Why the tranche schedule doesn't add up to the commission (null = it
      // does, or there is none). Approve commission refuses until it's fixed.
      trancheIssue: trancheScheduleIssue(
        c.commission_tranche_template.map((t) => ({ pct: num(t.pct), amount: num(t.amount) })),
        headline?.commission_type ?? null,
        headline ? num(headline.rate) : null,
      ),
      };
    });
  }),

  createContract: financeManagerProcedure
    .input(
      z.object({
        universityId: z.number().int().positive(),
        vendorId: z.number().int().positive().nullable(),
        cpSharePct: z.number().min(0).max(100).nullable().optional(),
        currency,
        effectiveDate: z.string().optional(),
        notes: z.string().max(500).optional(),
        isDefault: z.boolean().optional(),
        // Optional headline (university-wide) rate, set inline from the modal so
        // the user doesn't have to expand the row and add a rate as a 2nd step.
        commissionType: commissionType.optional(),
        rate: z.number().min(0).nullable().optional(),
        rateCourseId: z.number().int().positive().nullable().optional(),
        level: z.number().int().min(0).max(255).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const clash = await db.commission_contract.findFirst({
        where: { university_id: input.universityId, vendor_id: input.vendorId },
        select: { id: true },
      });
      if (clash) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "A commission source for this university and vendor already exists. Edit it instead.",
        });
      }
      const created = await db.$transaction(async (tx) => {
        if (input.isDefault) {
          await tx.commission_contract.updateMany({
            where: { university_id: input.universityId },
            data: { is_default: 0 },
          });
        }
        const contract = await tx.commission_contract.create({
          data: {
            university_id: input.universityId,
            vendor_id: input.vendorId,
            cp_share_pct: input.cpSharePct ?? null,
            currency: input.currency,
            effective_date: parseDate(input.effectiveDate),
            notes: orNull(input.notes),
            is_default: input.isDefault ? 1 : 0,
          },
        });
        if (input.rate != null) {
          await tx.commission_rate.create({
            data: {
              contract_id: contract.id,
              course_id: input.rateCourseId ?? null,
              level: input.level ?? null,
              commission_type: input.commissionType ?? CommissionType.PERCENTAGE,
              rate: input.rate,
              currency: input.currency,
            },
          });
        }
        return contract;
      });
      return { id: created.id };
    }),

  updateContract: financeManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        vendorId: z.number().int().positive().nullable().optional(),
        cpSharePct: z.number().min(0).max(100).nullable().optional(),
        currency: currency.optional(),
        effectiveDate: z.string().nullable().optional(),
        notes: z.string().max(500).optional(),
        isDefault: z.boolean().optional(),
        // Edit the headline (university-wide) rate inline.
        commissionType: commissionType.optional(),
        rate: z.number().min(0).nullable().optional(),
        level: z.number().int().min(0).max(255).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const current = await db.commission_contract.findUnique({
        where: { id: input.id },
        select: { university_id: true, vendor_id: true },
      });
      if (!current) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Contract not found." });
      }
      // Changing the vendor must respect the (university, vendor) uniqueness.
      if (input.vendorId !== undefined && input.vendorId !== current.vendor_id) {
        const clash = await db.commission_contract.findFirst({
          where: {
            university_id: current.university_id,
            vendor_id: input.vendorId,
            id: { not: input.id },
          },
          select: { id: true },
        });
        if (clash) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Another commission source already uses this university and vendor.",
          });
        }
      }
      await db.$transaction(async (tx) => {
        await tx.commission_contract.update({
          where: { id: input.id },
          data: {
            ...(input.vendorId === undefined ? {} : { vendor_id: input.vendorId }),
            ...(input.cpSharePct === undefined
              ? {}
              : { cp_share_pct: input.cpSharePct }),
            ...(input.currency === undefined ? {} : { currency: input.currency }),
            ...(input.effectiveDate === undefined
              ? {}
              : { effective_date: parseDate(input.effectiveDate) }),
            ...(input.notes === undefined ? {} : { notes: orNull(input.notes) }),
            ...(input.isDefault === undefined
              ? {}
              : { is_default: input.isDefault ? 1 : 0 }),
          },
        });
        // Rates and bonus tiers are recorded in the contract currency.
        if (input.currency !== undefined) {
          await tx.commission_rate.updateMany({ where: { contract_id: input.id }, data: { currency: input.currency } });
          await tx.commission_bonus_tier.updateMany({ where: { contract_id: input.id }, data: { currency: input.currency } });
        }
        // Exactly one default per university when this row is being set default.
        if (input.isDefault === true) {
          await tx.commission_contract.updateMany({
            where: { university_id: current.university_id, id: { not: input.id } },
            data: { is_default: 0 },
          });
        }
        // Upsert the headline (university-wide, course_id null) rate.
        if (input.rate != null) {
          const headline = await tx.commission_rate.findFirst({
            where: { contract_id: input.id, course_id: null },
            select: { id: true },
          });
          const rateData = {
            level: input.level ?? null,
            commission_type: input.commissionType ?? CommissionType.PERCENTAGE,
            rate: input.rate,
          };
          if (headline) {
            await tx.commission_rate.update({
              where: { id: headline.id },
              data: rateData,
            });
          } else {
            await tx.commission_rate.create({
              data: {
                contract_id: input.id,
                course_id: null,
                currency: input.currency ?? null,
                ...rateData,
              },
            });
          }
        }
      });
      return { success: true as const };
    }),

  removeContract: financeManagerProcedure
    .input(idInput)
    .mutation(async ({ input }) => {
      // rates / bonus tiers / tranche templates cascade with the contract.
      await db.commission_contract.delete({ where: { id: input.id } });
      return { success: true as const };
    }),

  // Exactly one default contract per university — clear the rest, set this one.
  setDefault: financeManagerProcedure
    .input(
      z.object({
        universityId: z.number().int().positive(),
        contractId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      await db.$transaction([
        db.commission_contract.updateMany({
          where: { university_id: input.universityId },
          data: { is_default: 0 },
        }),
        db.commission_contract.update({
          where: { id: input.contractId },
          data: { is_default: 1 },
        }),
      ]);
      return { success: true as const };
    }),

  // ========================================================================
  // Bulk CSV import — upsert commission sources keyed on (university, vendor).
  // The NEW/CHANGED/no-change diff is computed client-side; this applies the
  // rows the user chose. Each row sets the headline (university-wide) rate.
  // ========================================================================
  importContracts: financeManagerProcedure
    .input(
      z.object({
        rows: z
          .array(
            z.object({
              universityId: z.number().int().positive(),
              vendorId: z.number().int().positive().nullable(),
              commissionType: commissionType,
              rate: z.number().min(0).nullable(),
              cpSharePct: z.number().min(0).max(100).nullable(),
              isDefault: z.boolean(),
              effectiveDate: z.string().nullable(),
              notes: z.string().max(500).nullable(),
              // Optional column: absent leaves an existing contract's currency
              // as it is; a new one takes its vendor's.
              currency: currency.nullable().optional(),
            }),
          )
          .min(1)
          .max(1000),
      }),
    )
    .mutation(async ({ input }) => {
      let created = 0;
      let updated = 0;
      await db.$transaction(
        async (tx) => {
          for (const row of input.rows) {
            const existing = await tx.commission_contract.findFirst({
              where: { university_id: row.universityId, vendor_id: row.vendorId },
              select: { id: true, currency: true, vendor: { select: { currency: true } } },
            });
            let contractId: number;
            let ccy: string | null;
            if (existing) {
              ccy = row.currency ?? contractCurrency(existing);
              await tx.commission_contract.update({
                where: { id: existing.id },
                data: {
                  cp_share_pct: row.cpSharePct,
                  ...(row.currency ? { currency: row.currency } : {}),
                  effective_date: parseDate(row.effectiveDate),
                  notes: orNull(row.notes),
                },
              });
              contractId = existing.id;
              updated++;
            } else {
              const vendor =
                row.vendorId == null
                  ? null
                  : await tx.vendor.findUnique({ where: { id: row.vendorId }, select: { currency: true } });
              ccy = row.currency ?? vendor?.currency ?? null;
              const c = await tx.commission_contract.create({
                data: {
                  university_id: row.universityId,
                  vendor_id: row.vendorId,
                  cp_share_pct: row.cpSharePct,
                  currency: ccy,
                  effective_date: parseDate(row.effectiveDate),
                  notes: orNull(row.notes),
                  is_default: 0,
                },
              });
              contractId = c.id;
              created++;
            }
            // Headline (university-wide) rate.
            if (row.rate != null) {
              const headline = await tx.commission_rate.findFirst({
                where: { contract_id: contractId, course_id: null },
                select: { id: true },
              });
              if (headline) {
                await tx.commission_rate.update({
                  where: { id: headline.id },
                  data: { commission_type: row.commissionType, rate: row.rate, currency: ccy },
                });
              } else {
                await tx.commission_rate.create({
                  data: {
                    contract_id: contractId,
                    course_id: null,
                    level: null,
                    currency: ccy,
                    commission_type: row.commissionType,
                    rate: row.rate,
                  },
                });
              }
            }
            // Default flag — clear the rest for this university, set this one.
            if (row.isDefault) {
              await tx.commission_contract.updateMany({
                where: { university_id: row.universityId, id: { not: contractId } },
                data: { is_default: 0 },
              });
              await tx.commission_contract.update({
                where: { id: contractId },
                data: { is_default: 1 },
              });
            }
          }
        },
        { timeout: 30_000 },
      );
      return { created, updated };
    }),

  // ========================================================================
  // Rates (per contract; courseId null = university-wide rate)
  // ========================================================================
  upsertRate: financeManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        contractId: z.number().int().positive(),
        courseId: z.number().int().positive().nullable(),
        level: z.number().int().min(0).max(255).nullable().optional(),
        commissionType: commissionType,
        rate: z.number().min(0),
      }),
    )
    .mutation(async ({ input }) => {
      const contract = await db.commission_contract.findUnique({
        where: { id: input.contractId },
        select: { currency: true, vendor: { select: { currency: true } } },
      });
      if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contract not found." });
      // A flat rate is in the contract currency.
      const data = {
        course_id: input.courseId,
        level: input.level ?? null,
        commission_type: input.commissionType,
        rate: input.rate,
        currency: contractCurrency(contract),
      };
      if (input.id) {
        await db.commission_rate.update({ where: { id: input.id }, data });
        return { id: input.id };
      }
      const r = await db.commission_rate.create({
        data: { contract_id: input.contractId, ...data },
      });
      return { id: r.id };
    }),

  removeRate: financeManagerProcedure.input(idInput).mutation(async ({ input }) => {
    await db.commission_rate.delete({ where: { id: input.id } });
    return { success: true as const };
  }),

  // ========================================================================
  // Bonus tiers (direct contracts)
  // ========================================================================
  upsertBonusTier: financeManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        contractId: z.number().int().positive(),
        minStudents: z.number().int().min(1).max(65535),
        maxStudents: z.number().int().min(1).max(65535).nullable().optional(),
        amountPerStudent: z.number().min(0),
      }),
    )
    .mutation(async ({ input }) => {
      const contract = await db.commission_contract.findUnique({
        where: { id: input.contractId },
        select: { currency: true, vendor: { select: { currency: true } } },
      });
      if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contract not found." });
      const data = {
        min_students: input.minStudents,
        max_students: input.maxStudents ?? null,
        amount_per_student: input.amountPerStudent,
        currency: contractCurrency(contract),
      };
      if (input.id) {
        await db.commission_bonus_tier.update({ where: { id: input.id }, data });
        return { id: input.id };
      }
      const b = await db.commission_bonus_tier.create({
        data: { contract_id: input.contractId, ...data },
      });
      return { id: b.id };
    }),

  removeBonusTier: financeManagerProcedure
    .input(idInput)
    .mutation(async ({ input }) => {
      await db.commission_bonus_tier.delete({ where: { id: input.id } });
      return { success: true as const };
    }),

  // ========================================================================
  // Tranche templates — direct and vendor contracts alike (max 4). Each is a
  // % of the commission or (FLAT deals) a fixed amount in the contract
  // currency, with its condition (timing). A save that would take the
  // schedule past 100% / the flat amount is refused; Approve commission
  // refuses a schedule that doesn't add up exactly.
  // ========================================================================
  upsertTranche: financeManagerProcedure
    .input(
      z
        .object({
          id: z.number().int().positive().optional(),
          contractId: z.number().int().positive(),
          name: z.string().trim().min(1).max(100),
          amount: z.number().positive().nullable().optional(),
          pct: z.number().positive().max(100).nullable().optional(),
          timing: z.string().max(150).optional(),
        })
        .refine((v) => (v.pct != null) !== (v.amount != null), {
          message: "Enter either a percentage or an amount for the tranche.",
          path: ["pct"],
        }),
    )
    .mutation(async ({ input }) => {
      const others = await db.commission_tranche_template.findMany({
        where: { contract_id: input.contractId, ...(input.id ? { id: { not: input.id } } : {}) },
        select: { seq: true, pct: true, amount: true },
      });
      if (!input.id && others.length >= 4) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A contract can have at most 4 tranches.",
        });
      }
      const headline = await headlineOf(input.contractId);
      if (input.amount != null && headline?.commissionType !== CommissionType.FLAT) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This is a percentage deal, so each tranche must be a percentage of the commission.",
        });
      }
      const schedule = [
        ...others.map((t) => ({ pct: num(t.pct), amount: num(t.amount) })),
        { pct: input.pct ?? null, amount: input.amount ?? null },
      ];
      const over = trancheOvershoot(schedule, headline?.commissionType ?? null, headline?.rate ?? null);
      if (over) throw new TRPCError({ code: "BAD_REQUEST", message: over });
      const data = {
        name: input.name,
        amount: input.amount ?? null,
        pct: input.pct ?? null,
        timing: orNull(input.timing),
      };
      if (input.id) {
        await db.commission_tranche_template.update({
          where: { id: input.id },
          data,
        });
        return { id: input.id };
      }
      // Next free position (seqs can have gaps after a delete).
      const seq = Math.max(0, ...others.map((t) => t.seq)) + 1;
      const t = await db.commission_tranche_template.create({
        data: { contract_id: input.contractId, seq, ...data },
      });
      return { id: t.id };
    }),

  removeTranche: financeManagerProcedure
    .input(idInput)
    .mutation(async ({ input }) => {
      await db.commission_tranche_template.delete({ where: { id: input.id } });
      return { success: true as const };
    }),

  // ========================================================================
  // Commission Summary — group a university's sources, mark the default.
  // ========================================================================
  summary: financeProcedure
    .input(
      z.object({ universityId: z.number().int().positive().optional() }).optional(),
    )
    .query(async ({ input }) => {
      const rows = await db.commission_contract.findMany({
        where: input?.universityId
          ? { university_id: input.universityId }
          : undefined,
        include: {
          vendor: true,
          university: { select: { id: true, name: true, country: true } },
          // The university-wide rate (course_id null) is the headline default rate.
          commission_rate: { where: { course_id: null } },
          _count: {
            select: {
              commission_bonus_tier: true,
              commission_tranche_template: true,
            },
          },
        },
        orderBy: { university: { name: "asc" } },
      });

      const byUni = new Map<
        number,
        {
          universityId: number;
          universityName: string;
          country: string;
          sources: {
            contractId: number;
            vendorId: number | null;
            vendorName: string;
            vendorType: number | null;
            isDefault: boolean;
            cpSharePct: number | null;
            defaultRate: number | null;
            commissionType: number | null;
            currency: string | null;
            effectiveDate: Date | null;
            hasBonus: boolean;
            hasTranches: boolean;
            notes: string | null;
          }[];
        }
      >();

      for (const c of rows) {
        let entry = byUni.get(c.university_id);
        if (!entry) {
          entry = {
            universityId: c.university_id,
            universityName: c.university.name,
            country: c.university.country,
            sources: [],
          };
          byUni.set(c.university_id, entry);
        }
        const headline = c.commission_rate[0] ?? null;
        entry.sources.push({
          contractId: c.id,
          vendorId: c.vendor_id,
          vendorName: c.vendor?.name ?? "Direct",
          vendorType: c.vendor?.type ?? null,
          isDefault: c.is_default === 1,
          cpSharePct: num(c.cp_share_pct),
          defaultRate: headline ? num(headline.rate) : null,
          commissionType: headline ? headline.commission_type : null,
          currency: contractCurrency(c),
          effectiveDate: c.effective_date,
          hasBonus: c._count.commission_bonus_tier > 0,
          hasTranches: c._count.commission_tranche_template > 0,
          notes: c.notes,
        });
      }

      return Array.from(byUni.values());
    }),
});
