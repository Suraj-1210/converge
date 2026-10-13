import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, superAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// Department master (Settings -> Departments). Super Admin only, reads
// included. Departments are organisational labels for internal staff — they
// grant nothing; access is still decided by cp_user.role.
//
// Retiring a department means deactivating it: it drops out of the Users form
// but stays on the staff who already have it. A hard delete is refused while
// any staff account (active or not) still points at it; the FK is RESTRICT as
// a backstop.

const nameField = z
  .string()
  .trim()
  .min(1, "Department name is required")
  .max(100, "Department name is too long")
  .transform((s) => s.replace(/\s+/g, " "));

function prismaCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

function duplicateName(name: string): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: `A department named "${name}" already exists.`,
  });
}

export const departmentsRouter = createTRPCRouter({
  // Every department, active first in display order, with how many staff
  // accounts reference it (so the UI can explain why delete is unavailable).
  list: superAdminProcedure.query(async () => {
    const rows = await db.department.findMany({
      orderBy: [{ is_active: "desc" }, { sort_order: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        is_active: true,
        sort_order: true,
        updated_at: true,
        _count: { select: { cp_user: true } },
      },
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      active: d.is_active === 1,
      sortOrder: d.sort_order,
      userCount: d._count.cp_user,
      updatedAt: d.updated_at.toISOString(),
    }));
  }),

  create: superAdminProcedure
    .input(
      z.object({
        name: nameField,
        sortOrder: z.number().int().min(0).max(100000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Default to the end of the list.
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const max = await db.department.aggregate({
          where: { is_active: 1 },
          _max: { sort_order: true },
        });
        sortOrder = (max._max.sort_order ?? 0) + 10;
      }
      try {
        const d = await db.department.create({
          data: { name: input.name, sort_order: sortOrder, is_active: 1 },
        });
        await db.audit_log.create({
          data: {
            action: "department.created",
            entity_type: "department",
            entity_id: d.id,
            metadata: { byCpUserId: ctx.cpUser.id, name: d.name },
          },
        });
        return { id: d.id };
      } catch (e) {
        if (prismaCode(e) === "P2002") throw duplicateName(input.name);
        throw e;
      }
    }),

  update: superAdminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: nameField.optional(),
        sortOrder: z.number().int().min(0).max(100000).optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await db.department.findUnique({ where: { id: input.id } });
      if (!before) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Department not found." });
      }
      try {
        const d = await db.department.update({
          where: { id: input.id },
          data: {
            name: input.name,
            sort_order: input.sortOrder,
            is_active: input.active === undefined ? undefined : input.active ? 1 : 0,
          },
        });
        await db.audit_log.create({
          data: {
            action: "department.updated",
            entity_type: "department",
            entity_id: d.id,
            metadata: {
              byCpUserId: ctx.cpUser.id,
              before: {
                name: before.name,
                active: before.is_active === 1,
                sortOrder: before.sort_order,
              },
              after: { name: d.name, active: d.is_active === 1, sortOrder: d.sort_order },
            },
          },
        });
        return { id: d.id };
      } catch (e) {
        if (prismaCode(e) === "P2002" && input.name) throw duplicateName(input.name);
        throw e;
      }
    }),

  remove: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db.department.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, _count: { select: { cp_user: true } } },
      });
      if (!d) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Department not found." });
      }
      const n = d._count.cp_user;
      if (n > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${d.name} is still assigned to ${n} user${n === 1 ? "" : "s"}. Deactivate it instead, or move ${n === 1 ? "that user" : "those users"} to another department first.`,
        });
      }
      try {
        await db.department.delete({ where: { id: input.id } });
      } catch (e) {
        // A user was assigned between the count and the delete; the FK refused.
        if (prismaCode(e) === "P2003") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${d.name} was just assigned to a user. Deactivate it instead.`,
          });
        }
        throw e;
      }
      await db.audit_log.create({
        data: {
          action: "department.deleted",
          entity_type: "department",
          entity_id: d.id,
          metadata: { byCpUserId: ctx.cpUser.id, name: d.name },
        },
      });
      return { success: true as const };
    }),
});
