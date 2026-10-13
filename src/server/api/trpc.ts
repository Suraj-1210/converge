/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { db } from "~/server/db";
import {
  type AdminSessionClaims,
  type PartnerSessionClaims,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { runWithImpersonation } from "~/server/auth/impersonation-context";
import { AdminRole, UserStatus, UserType } from "~/server/db/enums";

// `id`/`role` are the EFFECTIVE user: while a Super Admin impersonates a staff
// user they are the impersonated user's, and `realId` is the admin's. Use
// `realId ?? id` wherever the real person matters (attribution, exports).
type CpUser = AdminSessionClaims;

// `impersonatorId` is set while a Super Admin is impersonating this partner.
type CpPartner = PartnerSessionClaims;

function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export const createTRPCContext = async (opts: {
  headers: Headers;
  resHeaders: Headers;
}) => {
  let cpUser: CpUser | null = null;
  const adminToken = readCookie(opts.headers, SESSION_COOKIE_NAME);
  if (adminToken) {
    cpUser = await verifySessionJwt(adminToken);
  }

  const cpPartner: CpPartner | null = await resolvePartnerSession(
    readCookie(opts.headers, PARTNER_SESSION_COOKIE_NAME),
    adminToken,
  );

  return {
    db,
    cpUser,
    cpPartner,
    ...opts,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;

export const createTRPCRouter = t.router;

const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();

  if (t._config.isDev) {
    const waitMs = Math.floor(Math.random() * 400) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const result = await next();

  const end = Date.now();
  if (t._config.isDev) {
    console.log(`[TRPC] ${path} took ${end - start}ms to execute`);
  }

  return result;
});

export const publicProcedure = t.procedure.use(timingMiddleware);

// Requires a valid admin (collegepond_user) session cookie.
export const protectedAdminProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.cpUser) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  }
  // Re-check the account is still active so a deactivated admin loses access
  // immediately, not at JWT expiry (8h).
  const row = await ctx.db.collegepond_user.findUnique({
    where: { id: ctx.cpUser.id },
    select: { status: true, first_name: true, last_name: true },
  });
  if (row?.status !== 1) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This account is no longer active.",
    });
  }
  const cpUser = ctx.cpUser;
  if (!cpUser.realId) return next({ ctx: { ...ctx, cpUser } });

  // Impersonating: the real admin must still be an active Super Admin.
  await assertActiveImpersonator(ctx.db, cpUser.realId);
  return runWithImpersonation(
    {
      realCpUserId: cpUser.realId,
      as: { kind: "staff", id: cpUser.id, name: `${row.first_name} ${row.last_name}`.trim() },
    },
    () => next({ ctx: { ...ctx, cpUser } }),
  );
});

// An impersonation session is only valid while the real admin behind it is
// still an active Super Admin (checked per request, like account status).
async function assertActiveImpersonator(
  database: typeof db,
  realCpUserId: number,
): Promise<void> {
  const real = await database.collegepond_user.findUnique({
    where: { id: realCpUserId },
    select: { status: true, role: true },
  });
  if (real?.status !== 1 || real.role !== AdminRole.SUPER_ADMIN) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Impersonation is no longer permitted. Exit and sign in again.",
    });
  }
}

// Further requires the admin to have role = SUPER_ADMIN.
export const superAdminProcedure = protectedAdminProcedure.use(({ ctx, next }) => {
  if (ctx.cpUser.role !== AdminRole.SUPER_ADMIN) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only super admins can perform this action.",
    });
  }
  return next();
});

// Finance read access — Finance Manager / Executive (and Super Admin). Use for
// listing/reading commission, billing, invoice and reconciliation data, and for
// the finance_exec-level verify steps.
const FINANCE_ROLES: number[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_MANAGER,
  AdminRole.FINANCE_EXECUTIVE,
];
export const financeProcedure = protectedAdminProcedure.use(({ ctx, next }) => {
  if (!FINANCE_ROLES.includes(ctx.cpUser.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Finance access is required for this action.",
    });
  }
  return next();
});

// Privileged finance actions — approving a payout and releasing payment are
// restricted to Finance Manager / Super Admin (the checks-and-balances gate).
const FINANCE_MANAGER_ROLES: number[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_MANAGER,
];
export const financeManagerProcedure = protectedAdminProcedure.use(({ ctx, next }) => {
  if (!FINANCE_MANAGER_ROLES.includes(ctx.cpUser.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only Finance Managers can approve or release payments.",
    });
  }
  return next();
});

// Operations access — the team that reviews/approves partner invoices before
// they reach finance reconciliation (transcript: "ops approves, finance
// reconciles"). Finance roles are included so they can review too.
const OPERATIONS_ROLES: number[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.OPERATIONS_LEAD,
  AdminRole.OPERATIONS_EXECUTIVE,
  AdminRole.FINANCE_MANAGER,
  AdminRole.FINANCE_EXECUTIVE,
];
export const operationsProcedure = protectedAdminProcedure.use(({ ctx, next }) => {
  if (!OPERATIONS_ROLES.includes(ctx.cpUser.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Operations access is required for this action.",
    });
  }
  return next();
});

// BDM Performance access: the page's portfolio data (bdm.overview) and the
// CRM (prospects, activities, tasks). Super Admin and BDM only; Finance,
// Operations, Counsellors and Content are refused (business decision). A BDM
// is further limited to their own data inside each router, not here.
const BDM_PERFORMANCE_ROLES: number[] = [AdminRole.SUPER_ADMIN, AdminRole.BDM];
export const bdmPerformanceProcedure = protectedAdminProcedure.use(({ ctx, next }) => {
  if (!BDM_PERFORMANCE_ROLES.includes(ctx.cpUser.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "BDM Performance is available to BDMs and Super Admins only.",
    });
  }
  return next();
});

// Requires a valid partner (user table) session cookie.
// Any signed-in partner, whatever their status: only for showing a partner
// their own account/application state (under review, rejected, inactive).
// Everything else uses protectedPartnerProcedure, which blocks rejected and
// deactivated accounts.
export const partnerSelfProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.cpPartner) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  }
  const cpPartner = ctx.cpPartner;
  const row = await ctx.db.user.findUnique({
    where: { id: cpPartner.id },
    select: { first_name: true, last_name: true, deleted_at: true },
  });
  // A counsellor removed by their agency has no account left to look at.
  if (!row || row.deleted_at) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  }
  if (!cpPartner.impersonatorId) return next({ ctx: { ...ctx, cpPartner } });

  await assertActiveImpersonator(ctx.db, cpPartner.impersonatorId);
  return runWithImpersonation(
    {
      realCpUserId: cpPartner.impersonatorId,
      as: { kind: "partner", id: cpPartner.id, name: `${row.first_name} ${row.last_name}`.trim() },
    },
    () => next({ ctx: { ...ctx, cpPartner } }),
  );
});

export const protectedPartnerProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.cpPartner) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  }
  // Block immediately if the partner was deactivated/rejected mid-session.
  const row = await ctx.db.user.findUnique({
    where: { id: ctx.cpPartner.id },
    select: { status: true, first_name: true, last_name: true, deleted_at: true },
  });
  if (
    !row ||
    row.deleted_at ||
    row.status === UserStatus.REJECTED ||
    row.status === UserStatus.INACTIVE
  ) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This account is no longer active.",
    });
  }
  const cpPartner = ctx.cpPartner;
  if (!cpPartner.impersonatorId) return next({ ctx: { ...ctx, cpPartner } });

  await assertActiveImpersonator(ctx.db, cpPartner.impersonatorId);
  return runWithImpersonation(
    {
      realCpUserId: cpPartner.impersonatorId,
      as: { kind: "partner", id: cpPartner.id, name: `${row.first_name} ${row.last_name}`.trim() },
    },
    () => next({ ctx: { ...ctx, cpPartner } }),
  );
});

// An agency owner acting on their own agency: managing counsellors, routing
// students. Adds ctx.owner with the owner's org id, which every query in the
// procedure must scope by — counsellors and independents are refused here.
export const agencyOwnerProcedure = protectedPartnerProcedure.use(async ({ ctx, next }) => {
  const me = await ctx.db.user.findUnique({
    where: { id: ctx.cpPartner.id },
    select: { id: true, type: true, is_owner: true, org_id: true },
  });
  if (me?.type !== UserType.AGENCY_OWNER || me.is_owner !== 1 || me.org_id === null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the agency owner can do this.",
    });
  }
  return next({ ctx: { ...ctx, owner: { id: me.id, orgId: me.org_id } } });
});
