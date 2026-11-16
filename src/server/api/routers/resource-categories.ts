import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, superAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// Resource Categories master (Settings -> Resource Categories, 16 Nov 2026),
// on the Tranche Conditions pattern. Super Admin only, reads included; the
// Admin > Resources category dropdown reads them through
// resources.adminCategories instead.
//
// Retiring a category means deactivating it: it drops out of the dropdown but
// stays on the resources filed under it (partners still see them there). A
// hard delete is refused while any resource uses it; the FK is RESTRICT as a
// backstop.

const nameField = z
  .string()
  .trim()
  .min(1, "Category name is required")
  .max(100, "Category name is too long")
  .transform((s) => s.replace(/\s+/g, " "));

function prismaCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

function duplicateName(name: string): TRPCError {
  return new TRPCError({ code: "CONFLICT", message: `A category named "${name}" already exists.` });
}

const ORDER = [{ sort_order: "asc" as const }, { name: "asc" as const }];

export const resourceCategoriesRouter = createTRPCRouter({
  list: superAdminProcedure.query(async () => {
    const rows = await db.resource_category.findMany({
      orderBy: ORDER,
      select: {
        id: true,
        name: true,
        is_active: true,
        sort_order: true,
        _count: { select: { resource: true } },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.is_active === 1,
      sortOrder: c.sort_order,
      resourceCount: c._count.resource,
    }));
  }),

  create: superAdminProcedure
    .input(z.object({ name: nameField }))
    .mutation(async ({ ctx, input }) => {
      const max = await db.resource_category.aggregate({ _max: { sort_order: true } });
      try {
        const c = await db.resource_category.create({
          data: { name: input.name, sort_order: (max._max.sort_order ?? 0) + 10, is_active: 1 },
        });
        await db.audit_log.create({
          data: {
            action: "resource_category.created",
            entity_type: "resource_category",
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
    .input(
      z.object({
        id: z.number().int().positive(),
        name: nameField.optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await db.resource_category.findUnique({ where: { id: input.id } });
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Category not found." });
      try {
        const c = await db.resource_category.update({
          where: { id: input.id },
          data: {
            name: input.name,
            is_active: input.active === undefined ? undefined : input.active ? 1 : 0,
          },
        });
        await db.audit_log.create({
          data: {
            action: "resource_category.updated",
            entity_type: "resource_category",
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

  // Move one place up or down; renumbers the list 10, 20, 30…
  move: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ input }) => {
      await db.$transaction(async (tx) => {
        const rows = await tx.resource_category.findMany({ orderBy: ORDER, select: { id: true } });
        const i = rows.findIndex((r) => r.id === input.id);
        if (i < 0) throw new TRPCError({ code: "NOT_FOUND", message: "Category not found." });
        const j = input.direction === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= rows.length) return;
        [rows[i], rows[j]] = [rows[j]!, rows[i]!];
        for (const [k, r] of rows.entries()) {
          await tx.resource_category.update({ where: { id: r.id }, data: { sort_order: (k + 1) * 10 } });
        }
      });
      return { success: true as const };
    }),

  remove: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const c = await db.resource_category.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, _count: { select: { resource: true } } },
      });
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Category not found." });
      const n = c._count.resource;
      if (n > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${c.name} is used by ${n} resource${n === 1 ? "" : "s"}. Deactivate it instead.`,
        });
      }
      try {
        await db.resource_category.delete({ where: { id: input.id } });
      } catch (e) {
        if (prismaCode(e) === "P2003") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${c.name} was just used on a resource. Deactivate it instead.`,
          });
        }
        throw e;
      }
      await db.audit_log.create({
        data: {
          action: "resource_category.deleted",
          entity_type: "resource_category",
          entity_id: c.id,
          metadata: { byCpUserId: ctx.cpUser.id, name: c.name },
        },
      });
      return { success: true as const };
    }),
});
