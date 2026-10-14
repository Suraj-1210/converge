import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
  superAdminProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { UserType } from "~/server/db/enums";
import {
  benefitsOf,
  currentTierFy,
  fyLabel,
  ladderFor,
  partnerRefForUser,
  partnerTierStatus,
  serializeStatus,
  todayIst,
  validateSchedule,
} from "~/server/partner-tiers";

// Partner Tiers master (Settings -> Partner Tiers) and tier overrides.
// Super Admin only for every write and for the master itself. See
// src/server/partner-tiers.ts for how a partner's tier is worked out.
//
// - Tier details (name, order, colour, icon, benefits) apply immediately.
// - Ranges and commission share are a per-FY schedule. Edits are saved for the
//   NEXT financial year; the current year's ladder never changes mid-way.
// - A tier is deactivated rather than deleted while anything references it.

const nameField = z
  .string()
  .trim()
  .min(1, "Tier name is required")
  .max(50, "Tier name is too long")
  .transform((s) => s.replace(/\s+/g, " "));

const tierFields = {
  name: nameField,
  displayOrder: z.number().int().min(0).max(100000).optional(),
  badgeColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Badge colour must be a hex colour like #1570EF"),
  icon: z.string().trim().max(16).nullable().optional(),
  benefits: z.array(z.string().trim().min(1).max(200)).max(20),
};

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2027-03-31");

// Optional text fields: an empty string is stored as NULL.
const blankToNull = (s: string | null | undefined): string | null => (s?.length ? s : null);

function prismaCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

function duplicateName(name: string): TRPCError {
  return new TRPCError({ code: "CONFLICT", message: `A tier named "${name}" already exists.` });
}

const ruleShape = (s: { minStudents: number; maxStudents: number | null; sharePct: number }) => ({
  min: s.minStudents,
  max: s.maxStudents,
  share: s.sharePct,
});

export const partnerTiersRouter = createTRPCRouter({
  // The whole master: every tier with what references it, this FY's ladder,
  // next FY's schedule (null = this year's carries forward) and the overrides.
  master: superAdminProcedure.query(async () => {
    const fy = currentTierFy();
    const [tiers, current, nextRows, overrides] = await Promise.all([
      db.partner_tier.findMany({
        orderBy: [{ is_active: "desc" }, { display_order: "asc" }, { name: "asc" }],
        include: { _count: { select: { overrides: true, commissions: true, rules: true } } },
      }),
      ladderFor(fy),
      db.partner_tier_rule.findMany({
        where: { fy: fy + 1 },
        orderBy: { min_students: "asc" },
        include: { created_by: { select: { first_name: true, last_name: true } } },
      }),
      db.partner_tier_override.findMany({
        orderBy: { set_at: "desc" },
        include: {
          tier: { select: { name: true } },
          set_by: { select: { first_name: true, last_name: true } },
          user: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
              type: true,
              organization: { select: { name: true } },
            },
          },
        },
      }),
    ]);
    const today = todayIst();
    return {
      fy,
      fyLabel: fyLabel(fy),
      nextFy: fy + 1,
      nextFyLabel: fyLabel(fy + 1),
      tiers: tiers.map((t) => ({
        id: t.id,
        name: t.name,
        displayOrder: t.display_order,
        badgeColor: t.badge_color,
        icon: t.icon,
        benefits: benefitsOf(t.benefits),
        active: t.is_active === 1,
        overrideCount: t._count.overrides,
        commissionCount: t._count.commissions,
        ruleCount: t._count.rules,
      })),
      current: current.steps.map((s) => ({ tierId: s.id, ...ruleShape(s) })),
      currentRuleFy: current.ruleFy,
      next:
        nextRows.length === 0
          ? null
          : {
              steps: nextRows.map((r) => ({
                tierId: r.tier_id,
                min: r.min_students,
                max: r.max_students,
                share: Number(r.share_pct),
              })),
              savedAt: nextRows[0]!.created_at.toISOString(),
              savedBy: nextRows[0]!.created_by
                ? `${nextRows[0]!.created_by.first_name} ${nextRows[0]!.created_by.last_name}`.trim()
                : null,
            },
      overrides: overrides.map((o) => {
        const endsOn = o.ends_on ? o.ends_on.toISOString().slice(0, 10) : null;
        return {
          userId: o.user_id,
          partner: o.user.organization?.name ?? `${o.user.first_name} ${o.user.last_name}`.trim(),
          email: o.user.email,
          independent: o.user.type === UserType.INDEPENDENT_COUNSELLOR,
          tier: o.tier.name,
          endsOn,
          active: endsOn == null || endsOn >= today,
          reason: o.reason,
          isMigrated: o.is_migrated === 1,
          setAt: o.set_at.toISOString(),
          setBy: o.set_by ? `${o.set_by.first_name} ${o.set_by.last_name}`.trim() : null,
        };
      }),
    };
  }),

  createTier: superAdminProcedure.input(z.object(tierFields)).mutation(async ({ ctx, input }) => {
    let displayOrder = input.displayOrder;
    if (displayOrder === undefined) {
      const max = await db.partner_tier.aggregate({ _max: { display_order: true } });
      displayOrder = (max._max.display_order ?? 0) + 10;
    }
    try {
      const t = await db.partner_tier.create({
        data: {
          name: input.name,
          display_order: displayOrder,
          badge_color: input.badgeColor.toUpperCase(),
          icon: blankToNull(input.icon),
          benefits: input.benefits,
          is_active: 1,
        },
      });
      await db.audit_log.create({
        data: {
          action: "partner_tier.created",
          entity_type: "partner_tier",
          entity_id: t.id,
          metadata: { byCpUserId: ctx.cpUser.id, name: t.name, benefits: input.benefits },
        },
      });
      return { id: t.id };
    } catch (e) {
      if (prismaCode(e) === "P2002") throw duplicateName(input.name);
      throw e;
    }
  }),

  // Display details only — they apply immediately, everywhere.
  updateTier: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), ...tierFields }))
    .mutation(async ({ ctx, input }) => {
      const before = await db.partner_tier.findUnique({ where: { id: input.id } });
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Tier not found." });
      try {
        const t = await db.partner_tier.update({
          where: { id: input.id },
          data: {
            name: input.name,
            display_order: input.displayOrder,
            badge_color: input.badgeColor.toUpperCase(),
            icon: blankToNull(input.icon),
            benefits: input.benefits,
          },
        });
        await db.audit_log.create({
          data: {
            action: "partner_tier.updated",
            entity_type: "partner_tier",
            entity_id: t.id,
            metadata: {
              byCpUserId: ctx.cpUser.id,
              before: {
                name: before.name,
                displayOrder: before.display_order,
                badgeColor: before.badge_color,
                icon: before.icon,
                benefits: benefitsOf(before.benefits),
              },
              after: {
                name: t.name,
                displayOrder: t.display_order,
                badgeColor: t.badge_color,
                icon: t.icon,
                benefits: input.benefits,
              },
            },
          },
        });
        return { id: t.id };
      } catch (e) {
        if (prismaCode(e) === "P2002") throw duplicateName(input.name);
        throw e;
      }
    }),

  // Deactivating is refused while the tier is on this or next FY's ladder or an
  // override still points at it — take it out of the schedule first.
  setTierActive: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const t = await db.partner_tier.findUnique({ where: { id: input.id } });
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tier not found." });
      if (!input.active) {
        const fy = currentTierFy();
        const [current, next, overrides] = await Promise.all([
          ladderFor(fy),
          ladderFor(fy + 1),
          db.partner_tier_override.count({ where: { tier_id: t.id } }),
        ]);
        if (current.steps.some((s) => s.id === t.id) || next.steps.some((s) => s.id === t.id)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${t.name} is on the ${fyLabel(fy)} or ${fyLabel(fy + 1)} ladder. Remove it from next year's ranges first; it can be deactivated once it's on neither.`,
          });
        }
        if (overrides > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${overrides} partner override${overrides === 1 ? "" : "s"} still use ${t.name}. Change or remove ${overrides === 1 ? "it" : "them"} first.`,
          });
        }
      }
      await db.partner_tier.update({ where: { id: t.id }, data: { is_active: input.active ? 1 : 0 } });
      await db.audit_log.create({
        data: {
          action: input.active ? "partner_tier.activated" : "partner_tier.deactivated",
          entity_type: "partner_tier",
          entity_id: t.id,
          metadata: { byCpUserId: ctx.cpUser.id, name: t.name },
        },
      });
      return { success: true as const };
    }),

  // Hard delete only for a tier nothing has ever referenced (a mistake).
  removeTier: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const t = await db.partner_tier.findUnique({
        where: { id: input.id },
        include: { _count: { select: { overrides: true, commissions: true, rules: true } } },
      });
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tier not found." });
      const { overrides, commissions, rules } = t._count;
      if (overrides + commissions + rules > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${t.name} has been used (ladders, overrides or confirmed commissions), so it can't be deleted. Deactivate it instead.`,
        });
      }
      try {
        await db.partner_tier.delete({ where: { id: t.id } });
      } catch (e) {
        if (prismaCode(e) === "P2003") {
          throw new TRPCError({ code: "BAD_REQUEST", message: `${t.name} was just used. Deactivate it instead.` });
        }
        throw e;
      }
      await db.audit_log.create({
        data: {
          action: "partner_tier.deleted",
          entity_type: "partner_tier",
          entity_id: t.id,
          metadata: { byCpUserId: ctx.cpUser.id, name: t.name },
        },
      });
      return { success: true as const };
    }),

  // Save the NEXT financial year's ladder (ranges + commission share) as a
  // whole. The current year is never edited: changes apply from 1 April.
  saveNextSchedule: superAdminProcedure
    .input(
      z.object({
        steps: z
          .array(
            z.object({
              tierId: z.number().int().positive(),
              minStudents: z.number().int().min(0).max(65535),
              maxStudents: z.number().int().min(0).max(65535).nullable(),
              sharePct: z.number().min(0).max(100).multipleOf(0.01),
            }),
          )
          .min(1)
          .max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const nextFy = currentTierFy() + 1;
      const ids = input.steps.map((s) => s.tierId);
      if (new Set(ids).size !== ids.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A tier can appear only once on the ladder." });
      }
      const tiers = await db.partner_tier.findMany({ where: { id: { in: ids } } });
      const byId = new Map(tiers.map((t) => [t.id, t]));
      for (const id of ids) {
        const t = byId.get(id);
        if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "A tier on the ladder no longer exists." });
        if (t.is_active !== 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `${t.name} is inactive. Activate it before adding it to the ladder.` });
        }
      }
      const problem = validateSchedule(input.steps.map((s) => ({ ...s, name: byId.get(s.tierId)!.name })));
      if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });

      const before = await ladderFor(nextFy);
      await db.$transaction(async (tx) => {
        await tx.partner_tier_rule.deleteMany({ where: { fy: nextFy } });
        await tx.partner_tier_rule.createMany({
          data: input.steps.map((s) => ({
            fy: nextFy,
            tier_id: s.tierId,
            min_students: s.minStudents,
            max_students: s.maxStudents,
            share_pct: s.sharePct,
            created_by_cp_user_id: ctx.cpUser.id,
          })),
        });
        await tx.audit_log.create({
          data: {
            action: "partner_tier.schedule_saved",
            entity_type: "partner_tier_rule",
            entity_id: nextFy,
            metadata: {
              byCpUserId: ctx.cpUser.id,
              fy: nextFy,
              before: before.steps.map((s) => ({ tier: s.name, ...ruleShape(s) })),
              after: input.steps.map((s) => ({
                tier: byId.get(s.tierId)!.name,
                min: s.minStudents,
                max: s.maxStudents,
                share: s.sharePct,
              })),
            },
          },
        });
      });
      return { fy: nextFy };
    }),

  // Drop next FY's saved schedule, so this year's ladder carries forward.
  clearNextSchedule: superAdminProcedure.mutation(async ({ ctx }) => {
    const nextFy = currentTierFy() + 1;
    const removed = await db.partner_tier_rule.deleteMany({ where: { fy: nextFy } });
    if (removed.count > 0) {
      await db.audit_log.create({
        data: {
          action: "partner_tier.schedule_cleared",
          entity_type: "partner_tier_rule",
          entity_id: nextFy,
          metadata: { byCpUserId: ctx.cpUser.id, fy: nextFy },
        },
      });
    }
    return { removed: removed.count };
  }),

  // A partner's tier for admin screens (any admin who can see partners).
  partnerStatus: protectedAdminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const ref = await partnerRefForUser(input.userId);
      if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "Partner not found." });
      const status = await partnerTierStatus(ref);
      return { holderUserId: ref.userId, status: status ? serializeStatus(status) : null };
    }),

  // Set (or replace) a Super Admin floor on a partner's tier.
  setOverride: superAdminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        tierId: z.number().int().positive(),
        endsOn: ymd.nullable(),
        reason: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ref = await partnerRefForUser(input.userId);
      if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "Partner not found." });
      const fy = currentTierFy();
      const ladder = await ladderFor(fy);
      const step = ladder.steps.find((s) => s.id === input.tierId);
      if (!step) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `That tier isn't on the ${fyLabel(fy)} ladder.` });
      }
      if (input.endsOn != null && input.endsOn < todayIst()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The end date can't be in the past." });
      }
      const before = await db.partner_tier_override.findUnique({
        where: { user_id: ref.userId },
        include: { tier: { select: { name: true } } },
      });
      const partner = await db.user.findUnique({ where: { id: ref.userId }, select: { org_id: true } });
      const data = {
        tier_id: step.id,
        ends_on: input.endsOn ? new Date(`${input.endsOn}T00:00:00Z`) : null,
        reason: blankToNull(input.reason),
        is_migrated: 0,
        set_by_cp_user_id: ctx.cpUser.id,
        set_at: new Date(),
      };
      await db.$transaction([
        db.partner_tier_override.upsert({
          where: { user_id: ref.userId },
          create: { user_id: ref.userId, ...data },
          update: data,
        }),
        db.audit_log.create({
          data: {
            user_id: ref.userId,
            org_id: partner?.org_id ?? null,
            action: "partner.tier_updated",
            entity_type: "user",
            entity_id: ref.userId,
            metadata: {
              change: "override_set",
              byCpUserId: ctx.cpUser.id,
              from: before ? { tier: before.tier.name, endsOn: before.ends_on?.toISOString().slice(0, 10) ?? null } : null,
              to: { tier: step.name, endsOn: input.endsOn },
              reason: blankToNull(input.reason),
            },
          },
        }),
      ]);
      return { success: true as const };
    }),

  removeOverride: superAdminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const ref = await partnerRefForUser(input.userId);
      if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "Partner not found." });
      const before = await db.partner_tier_override.findUnique({
        where: { user_id: ref.userId },
        include: { tier: { select: { name: true } } },
      });
      if (!before) return { success: true as const };
      const partner = await db.user.findUnique({ where: { id: ref.userId }, select: { org_id: true } });
      await db.$transaction([
        db.partner_tier_override.delete({ where: { user_id: ref.userId } }),
        db.audit_log.create({
          data: {
            user_id: ref.userId,
            org_id: partner?.org_id ?? null,
            action: "partner.tier_updated",
            entity_type: "user",
            entity_id: ref.userId,
            metadata: {
              change: "override_removed",
              byCpUserId: ctx.cpUser.id,
              from: {
                tier: before.tier.name,
                endsOn: before.ends_on?.toISOString().slice(0, 10) ?? null,
                isMigrated: before.is_migrated === 1,
              },
              to: null,
            },
          },
        }),
      ]);
      return { success: true as const };
    }),

  // This FY's ladder for the MOU's commission table (new signings) and any
  // partner screen that shows the ladder without a status.
  ladder: protectedPartnerProcedure.query(async () => {
    const fy = currentTierFy();
    const l = await ladderFor(fy);
    return { fy, fyLabel: fyLabel(fy), steps: l.steps };
  }),
});
