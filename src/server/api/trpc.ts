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
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifyPartnerSessionJwt,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { AdminRole, UserStatus } from "~/server/db/enums";

interface CpUser {
  id: number;
  role: number;
}

interface CpPartner {
  id: number;
}

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

  let cpPartner: CpPartner | null = null;
  const partnerToken = readCookie(opts.headers, PARTNER_SESSION_COOKIE_NAME);
  if (partnerToken) {
    cpPartner = await verifyPartnerSessionJwt(partnerToken);
  }

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
    select: { status: true },
  });
  if (row?.status !== 1) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This account is no longer active.",
    });
  }
  return next({ ctx: { ...ctx, cpUser: ctx.cpUser } });
});

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
export const protectedPartnerProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.cpPartner) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  }
  // Block immediately if the partner was deactivated/rejected mid-session.
  const row = await ctx.db.user.findUnique({
    where: { id: ctx.cpPartner.id },
    select: { status: true },
  });
  if (
    row?.status === UserStatus.REJECTED ||
    row?.status === UserStatus.INACTIVE
  ) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This account is no longer active.",
    });
  }
  return next({ ctx: { ...ctx, cpPartner: ctx.cpPartner } });
});
