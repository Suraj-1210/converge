import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, superAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// Tranche Conditions master (Settings -> Tranche Conditions, 16 Nov 2026).
// Super Admin only, reads included; the Commission Rates tranche dropdown reads
// the active ones through commissionRates.trancheConditions instead.
//
// A tranche stores condition_id plus a snapshot of the name in `timing`, which
// every screen that shows a tranche's condition reads. Renaming a condition
// rewrites that snapshot on its tranches in the same transaction.
//
// Retiring a condition means deactivating it: it drops out of the dropdown but
// stays on the tranches that use it. A hard delete is refused while any
// tranche points at it; the FK is RESTRICT as a backstop.

const nameField = z
  .string()
  .trim()
  .min(1, "Condition name is required")
  .max(150, "Condition name is too long")
  .transform((s) => s.replace(/\s+/g, " "));

function prismaCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

function duplicateName(name: string): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: `A condition named "${name}" already exists.`,
  });
}

const ORDER = [{ sort_order: "asc" as const }, { name: "asc" as const }];

export const trancheConditionsRouter = createTRPCRouter({
  // Every condition in display order, with how many tranches use it (so the
  // UI can explain why delete is unavailable).
  list: superAdminProcedure.query(async () => {
    const rows = await db.tranche_condition.findMany({
      orderBy: ORDER,
      select: {
        id: true,
        name: true,
        is_active: true,
        sort_order: true,
        _count: { select: { commission_tranche_template: true } },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.is_active === 1,
      sortOrder: c.sort_order,
      trancheCount: c._count.commission_tranche_template,
    }));
  }),

  create: superAdminProcedure
    .input(z.object({ name: nameField }))
    .mutation(async ({ ctx, input }) => {
      // New conditions go to the end of the list.
      const max = await db.tranche_condition.aggregate({ _max: { sort_order: true } });
      const sortOrder = (max._max.sort_order ?? 0) + 10;
      try {
        const c = await db.tranche_condition.create({
          data: { name: input.name, sort_order: sortOrder, is_active: 1 },
        });
        await db.audit_log.create({
          data: {
            action: "tranche_condition.created",
            entity_type: "tranche_condition",
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

  // Rename and/or (de)activate. A rename flows to every tranche using it.
  update: superAdminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: nameField.optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await db.tranche_condition.findUnique({ where: { id: input.id } });
      if (!before) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Condition not found." });
      }
      try {
        const { c, retimed } = await db.$transaction(async (tx) => {
          const c = await tx.tranche_condition.update({
            where: { id: input.id },
            data: {
              name: input.name,
              is_active: input.active === undefined ? undefined : input.active ? 1 : 0,
            },
          });
          // Rewrite unconditionally (not only when the name changed) so a
          // case-only rename, or a snapshot that drifted, is brought in line.
          const r =
            input.name === undefined
              ? { count: 0 }
              : await tx.commission_tranche_template.updateMany({
                  where: { condition_id: c.id },
                  data: { timing: c.name },
                });
          return { c, retimed: r.count };
        });
        await db.audit_log.create({
          data: {
            action: "tranche_condition.updated",
            entity_type: "tranche_condition",
            entity_id: c.id,
            metadata: {
              byCpUserId: ctx.cpUser.id,
              before: { name: before.name, active: before.is_active === 1 },
              after: { name: c.name, active: c.is_active === 1 },
              tranchesRenamed: retimed,
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
    .input(
      z.object({
        id: z.number().int().positive(),
        direction: z.enum(["up", "down"]),
      }),
    )
    .mutation(async ({ input }) => {
      await db.$transaction(async (tx) => {
        const rows = await tx.tranche_condition.findMany({ orderBy: ORDER, select: { id: true } });
        const i = rows.findIndex((r) => r.id === input.id);
        if (i < 0) throw new TRPCError({ code: "NOT_FOUND", message: "Condition not found." });
        const j = input.direction === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= rows.length) return;
        [rows[i], rows[j]] = [rows[j]!, rows[i]!];
        for (const [k, r] of rows.entries()) {
          await tx.tranche_condition.update({
            where: { id: r.id },
            data: { sort_order: (k + 1) * 10 },
          });
        }
      });
      return { success: true as const };
    }),

  remove: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const c = await db.tranche_condition.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          _count: { select: { commission_tranche_template: true } },
        },
      });
      if (!c) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Condition not found." });
      }
      const n = c._count.commission_tranche_template;
      if (n > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${c.name} is used by ${n} tranche${n === 1 ? "" : "s"}. Deactivate it instead.`,
        });
      }
      try {
        await db.tranche_condition.delete({ where: { id: input.id } });
      } catch (e) {
        // A tranche picked it between the count and the delete; the FK refused.
        if (prismaCode(e) === "P2003") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${c.name} was just used on a tranche. Deactivate it instead.`,
          });
        }
        throw e;
      }
      await db.audit_log.create({
        data: {
          action: "tranche_condition.deleted",
          entity_type: "tranche_condition",
          entity_id: c.id,
          metadata: { byCpUserId: ctx.cpUser.id, name: c.name },
        },
      });
      return { success: true as const };
    }),
});
