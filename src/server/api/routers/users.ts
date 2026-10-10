import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  superAdminProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { ADMIN_ROLE_CODES, type AdminRole } from "~/server/db/enums";

// Phone is stored as `${countryCode}${phone}` (e.g. "+919876543210"). When the
// country code starts with "+", we treat the trailing 10 chars as the local
// number and everything before as the country code.
function splitPhone(stored: string): { phone: string; countryCode: string } {
  if (stored.startsWith("+") && stored.length > 10) {
    const cc = stored.slice(0, stored.length - 10);
    return { countryCode: cc, phone: stored.slice(cc.length) };
  }
  return { countryCode: "", phone: stored };
}

const cpUserSelect = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  phone: true,
  role: true,
  department: true,
  status: true,
  last_login_at: true,
  created_at: true,
} as const;

interface DbCpUser {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  role: number;
  department: string | null;
  status: number;
  last_login_at: Date | null;
  created_at: Date;
}

function toApi(u: DbCpUser) {
  const { phone, countryCode } = splitPhone(u.phone);
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    email: u.email,
    phone,
    countryCode,
    role: u.role as AdminRole,
    department: u.department,
    status: u.status === 1 ? ("active" as const) : ("inactive" as const),
    lastLogin: u.last_login_at?.toISOString() ?? null,
    createdAt: u.created_at.toISOString(),
  };
}

function normDepartment(value: string | undefined): string | null {
  const t = value?.trim();
  return t && t.length > 0 ? t : null;
}

const personFields = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email(),
  phone: z.string().min(1),
  countryCode: z.string().min(1),
  role: z
    .number()
    .int()
    .refine((v) => ADMIN_ROLE_CODES.includes(v as AdminRole), { message: "Invalid role" }),
  department: z.string().trim().max(100).optional(),
});

export const usersRouter = createTRPCRouter({
  list: protectedAdminProcedure.query(async () => {
    const rows = await db.collegepond_user.findMany({
      orderBy: { created_at: "desc" },
      select: cpUserSelect,
    });
    return rows.map(toApi);
  }),

  // Used by the partner-approval modal to pick a counsellor lead / counsellor.
  // Admin-only: team names must never reach the public signup form.
  listByRole: protectedAdminProcedure
    .input(z.object({ role: z.number().int() }))
    .query(async ({ input }) => {
      const rows = await db.collegepond_user.findMany({
        where: { role: input.role, status: 1 },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
        select: cpUserSelect,
      });
      return rows.map(toApi);
    }),

  create: superAdminProcedure.input(personFields).mutation(async ({ input }) => {
    const email = input.email.toLowerCase();

    const existing = await db.collegepond_user.findUnique({ where: { email } });
    if (existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "An account with this email already exists.",
      });
    }

    const phoneStored = `${input.countryCode}${input.phone.replace(/\s/g, "")}`;

    const user = await db.collegepond_user.create({
      data: {
        first_name: input.firstName,
        last_name: input.lastName,
        email,
        phone: phoneStored,
        role: input.role,
        department: normDepartment(input.department),
        status: 1,
      },
      select: cpUserSelect,
    });

    return toApi(user);
  }),

  update: superAdminProcedure
    .input(personFields.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const email = input.email.toLowerCase();

      const dup = await db.collegepond_user.findUnique({ where: { email } });
      if (dup && dup.id !== input.id) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An account with this email already exists.",
        });
      }

      const phoneStored = `${input.countryCode}${input.phone.replace(/\s/g, "")}`;

      const user = await db.collegepond_user.update({
        where: { id: input.id },
        data: {
          first_name: input.firstName,
          last_name: input.lastName,
          email,
          phone: phoneStored,
          role: input.role,
          department: normDepartment(input.department),
        },
        select: cpUserSelect,
      });

      return toApi(user);
    }),

  // Hard-delete a staff account. Blocked when the user still owns partner or
  // student relationships (those FKs would silently null out) — the admin must
  // reassign or deactivate first. Deleting yourself is disallowed.
  remove: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === ctx.cpUser.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You can't delete your own account.",
        });
      }

      const existing = await db.collegepond_user.findUnique({
        where: { id: input.id },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      }

      const [partnerCount, studentCount] = await Promise.all([
        db.user.count({
          where: {
            OR: [
              { bdm_id: input.id },
              { counsellor_id: input.id },
              { lead_counsellor_id: input.id },
            ],
          },
        }),
        db.student.count({ where: { cp_counsellor_id: input.id } }),
      ]);

      if (partnerCount > 0 || studentCount > 0) {
        const parts: string[] = [];
        if (partnerCount > 0)
          parts.push(`${partnerCount} partner${partnerCount === 1 ? "" : "s"}`);
        if (studentCount > 0)
          parts.push(`${studentCount} student${studentCount === 1 ? "" : "s"}`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `This user is still assigned to ${parts.join(" and ")}. Reassign them (or deactivate this user) before deleting.`,
        });
      }

      await db.collegepond_user.delete({ where: { id: input.id } });
      return { success: true as const };
    }),

  setStatus: superAdminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        active: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const user = await db.collegepond_user.update({
        where: { id: input.id },
        data: { status: input.active ? 1 : 0 },
        select: cpUserSelect,
      });
      return toApi(user);
    }),
});
