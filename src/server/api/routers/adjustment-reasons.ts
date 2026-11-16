import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, superAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// Adjustment Reasons master (Settings -> Adjustment Reasons, 16 Nov 2026),
// modelled on Tranche Conditions. Super Admin only, reads included; the
// Adjustments page reads the active ones through adjustments.reasons.
//
// Retiring a reason means deactivating it: it drops out of the dropdown but
// stays on the adjustments that use it. A hard delete is refused while any
// adjustment points at it; the FK is RESTRICT as a backstop. Adjustments join
// the master, so a rename shows everywhere at once.

const nameField = z
  .string()
  .trim()
  .min(1, "Reason name is required")
  .max(150, "Reason name is too long")
  .transform((s) => s.replace(/\s+/g, " "));

function prismaCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

function duplicateName(name: string): TRPCError {
  return new TRPCError({ code: "CONFLICT", message: `A reason named "${name}" already exists.` });
}

const ORDER = [{ sort_order: "asc" as const }, { name: "asc" as const }];

export const adjustmentReasonsRouter = createTRPCRouter({
  // Every reason in display order, with how many adjustments use it (so the
  // UI can explain why delete is unavailable).
  list: superAdminProcedure.query(async () => {
    const rows = await db.adjustment_reason.findMany({
      orderBy: ORDER,
      select: { id: true, name: true, is_active: true, sort_order: true, _count: { select: { adjustment: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.is_active === 1,
      sortOrder: c.sort_order,
      useCount: c._count.adjustment,
    }));
  }),

  create: superAdminProcedure
    .input(z.object({ name: nameField }))
    .mutation(async ({ ctx, input }) => {
      // New reasons go to the end of the list.
      const max = await db.adjustment_reason.aggregate({ _max: { sort_order: true } });
      try {
        const c = await db.adjustment_reason.create({
          data: { name: input.name, sort_order: (max._max.sort_order ?? 0) + 10, is_active: 1 },
        });
        await db.audit_log.create({
          data: {
            action: "adjustment_reason.created",
            entity_type: "adjustment_reason",
            entity_id: c.id,
            metadata: { byCpUserId: ctx.cpUser.id, name: c.name },
          },
        });
        return { id: c.id };
      } catch (e) {
        if (prismaCode(e) === "P2002") throw duplicateName(input.name);
        throw e;
      }
    }),

  // Rename and/or (de)activate.
  update: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), name: nameField.optional(), active: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const before = await db.adjustment_reason.findUnique({ where: { id: input.id } });
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Reason not found." });
      try {
        const c = await db.adjustment_reason.update({
          where: { id: input.id },
          data: {
            name: input.name,
            is_active: input.active === undefined ? undefined : input.active ? 1 : 0,
          },
        });
        await db.audit_log.create({
          data: {
            action: "adjustment_reason.updated",
            entity_type: "adjustment_reason",
            entity_id: c.id,
            metadata: {
              byCpUserId: ctx.cpUser.id,
              before: { name: before.name, active: before.is_active === 1 },
              after: { name: c.name, active: c.is_active === 1 },
            },
          },
        });
        return { id: c.id };
      } catch (e) {
        if (prismaCode(e) === "P2002" && input.name) throw duplicateName(input.name);
        throw e;
      }
    }),

  // Move one place up or down. Renumbers the whole list 10, 20, 30… so gaps
  // and ties from older data can't make a move a no-op.
  move: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ input }) => {
      await db.$transaction(async (tx) => {
        const rows = await tx.adjustment_reason.findMany({ orderBy: ORDER, select: { id: true } });
        const i = rows.findIndex((r) => r.id === input.id);
        if (i < 0) throw new TRPCError({ code: "NOT_FOUND", message: "Reason not found." });
        const j = input.direction === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= rows.length) return;
        [rows[i], rows[j]] = [rows[j]!, rows[i]!];
        for (const [k, r] of rows.entries()) {
          await tx.adjustment_reason.update({ where: { id: r.id }, data: { sort_order: (k + 1) * 10 } });
        }
      });
      return { success: true as const };
    }),

  remove: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const c = await db.adjustment_reason.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, _count: { select: { adjustment: true } } },
      });
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Reason not found." });
      const n = c._count.adjustment;
      if (n > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${c.name} is used by ${n} adjustment${n === 1 ? "" : "s"}. Deactivate it instead.`,
        });
      }
      try {
        await db.adjustment_reason.delete({ where: { id: input.id } });
      } catch (e) {
        // An adjustment picked it between the count and the delete; the FK refused.
        if (prismaCode(e) === "P2003") {
          throw new TRPCError({ code: "BAD_REQUEST", message: `${c.name} was just used on an adjustment. Deactivate it instead.` });
        }
        throw e;
      }
      await db.audit_log.create({
        data: {
          action: "adjustment_reason.deleted",
          entity_type: "adjustment_reason",
          entity_id: c.id,
          metadata: { byCpUserId: ctx.cpUser.id, name: c.name },
        },
      });
      return { success: true as const };
    }),
});
