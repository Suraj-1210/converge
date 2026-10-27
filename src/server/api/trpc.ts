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
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { runWithImpersonation } from "~/server/auth/impersonation-context";
import { readCookie } from "~/server/auth/cookies";
import { AdminRole, UserStatus, UserType } from "~/server/db/enums";
import { type AdminSection, sectionForProcedure } from "~/lib/admin-sections";
import { partnerTabForProcedure } from "~/lib/partner-tabs";
import { type TabAccessCache, cachedAdminSections, cachedPartnerTabs } from "~/server/tab-access";
import { assertActiveStaffImpersonator } from "~/server/auth/impersonation";

// `id`/`role` are the EFFECTIVE user: while a Super Admin impersonates a staff
// user they are the impersonated user's, and `realId` is the admin's. Use
// `realId ?? id` wherever the real person matters (attribution, exports).
type CpUser = AdminSessionClaims;

// `impersonatorId` is set while a Super Admin is impersonating this partner;
// `ownerImpersonatorId` while their agency owner is viewing as this counsellor.
type CpPartner = PartnerSessionClaims;


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
    readCookie(opts.headers, PARTNER_OWNER_SESSION_COOKIE_NAME),
  );

  return {
    db,
    cpUser,
    cpPartner,
    // Effective tab access, looked up once per user per request (~/server/tab-access).
    tabAccess: new Map() as TabAccessCache,
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
export const protectedAdminProcedure = publicProcedure.use(async ({ ctx, next, path }) => {
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
  // A procedure that serves one tab's pages is refused while that tab is
  // switched off for this user (API_SECTIONS in ~/lib/admin-sections).
  const section = sectionForProcedure(path);
  if (section && !(await cachedAdminSections(ctx.tabAccess, cpUser)).includes(section)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You don't have access to this section." });
  }
  if (!cpUser.realId) return next({ ctx: { ...ctx, cpUser } });

  // Impersonating: the real admin must still be an active Super Admin, or a
  // Counsellor Lead still leading this counsellor.
  await assertActiveStaffImpersonator(cpUser.realId, cpUser.id);
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

// Access to one section of the admin portal: the user's effective tabs
// (~/server/tab-access, the same set that hides the page in the sidebar).
export const adminSectionProcedure = (section: AdminSection) =>
  protectedAdminProcedure.use(async ({ ctx, next }) => {
    if (!(await cachedAdminSections(ctx.tabAccess, ctx.cpUser)).includes(section)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You don't have access to this section.",
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
// A finance page is also refused while its tab is switched off for the user
// (checked in protectedAdminProcedure); it can't be switched on for anyone
// outside these roles (GRANTABLE_ROLES in ~/lib/admin-sections).
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
// is further limited to their own data inside each router, not here. The
// BDM Performance tab can switch it off, never on for another role.
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

// A partner request made under impersonation runs with the real person
// recorded (see impersonation-context), after checking they may still do it:
//   Super Admin  → must still be an active Super Admin.
//   Agency owner → must still be the approved owner of this counsellor's
//                  agency. Full access (decided with Suraj, 17 Oct 2026),
//                  except that a deactivated counsellor can be looked at but
//                  not acted for. Every mutation also leaves an
//                  impersonation.action audit row, so actions with no audit
//                  row of their own (chat, notes…) still trace to the owner.
type PartnerRow = {
  first_name: string;
  last_name: string;
  status: number;
  type: number;
  org_id: number | null;
};
async function runAsPartner<T extends { ok: boolean }>(
  database: typeof db,
  cpPartner: CpPartner,
  row: PartnerRow,
  op: { type: string; path: string; getRawInput: () => Promise<unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const as = { kind: "partner" as const, id: cpPartner.id, name: `${row.first_name} ${row.last_name}`.trim() };
  if (cpPartner.impersonatorId) {
    await assertActiveImpersonator(database, cpPartner.impersonatorId);
    return runWithImpersonation({ realCpUserId: cpPartner.impersonatorId, as }, run);
  }
  const ownerId = cpPartner.ownerImpersonatorId;
  if (!ownerId) return run();

  await assertOwnerOfCounsellor(database, ownerId, row);
  // Bookkeeping the portal fires on its own, which does nothing while an
  // owner is viewing (no login recorded, no read receipts used up).
  if (OWNER_VIEW_NO_OPS.has(op.path)) return runWithImpersonation({ realUserId: ownerId, as }, run);
  if (op.type === "mutation" && row.status === UserStatus.INACTIVE) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This counsellor is deactivated: you can view their portal but not act for them.",
    });
  }
  return runWithImpersonation({ realUserId: ownerId, as }, async () => {
    const result = await run();
    if (op.type === "mutation" && result.ok) {
      const raw = await op.getRawInput().catch(() => undefined);
      const studentId =
        raw && typeof raw === "object" && "studentId" in raw && typeof raw.studentId === "number"
          ? raw.studentId
          : null;
      await database.audit_log.create({
        data: {
          user_id: ownerId,
          org_id: row.org_id,
          action: "impersonation.action",
          entity_type: "user",
          entity_id: cpPartner.id,
          metadata: { procedure: op.path, ...(studentId ? { studentId } : {}) },
        },
      });
    }
    return result;
  });
}

const OWNER_VIEW_NO_OPS = new Set(["auth.recordDashboardVisit", "partnerChat.partnerMarkRead"]);

// Viewing as a counsellor is only valid while the real owner is still the
// approved owner of that counsellor's agency (checked per request).
async function assertOwnerOfCounsellor(
  database: typeof db,
  ownerId: number,
  target: PartnerRow,
): Promise<void> {
  const owner = await database.user.findUnique({
    where: { id: ownerId },
    select: { type: true, is_owner: true, org_id: true, status: true, deleted_at: true },
  });
  if (
    owner?.type !== UserType.AGENCY_OWNER ||
    owner.is_owner !== 1 ||
    owner.status !== UserStatus.APPROVED ||
    owner.deleted_at ||
    owner.org_id === null ||
    owner.org_id !== target.org_id ||
    target.type !== UserType.AGENCY_COUNSELLOR
  ) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Viewing as this counsellor is no longer permitted. Exit and sign in again.",
    });
  }
}

const PARTNER_ROW_SELECT = {
  first_name: true,
  last_name: true,
  status: true,
  type: true,
  org_id: true,
  deleted_at: true,
} as const;

// Requires a valid partner (user table) session cookie.
// Any signed-in partner, whatever their status: only for showing a partner
// their own account/application state (under review, rejected, inactive).
// Everything else uses protectedPartnerProcedure, which blocks rejected and
// deactivated accounts.
export const partnerSelfProcedure = publicProcedure.use(async ({ ctx, next, type, path, getRawInput }) => {
  if (!ctx.cpPartner) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  }
  const cpPartner = ctx.cpPartner;
  const row = await ctx.db.user.findUnique({
    where: { id: cpPartner.id },
    select: PARTNER_ROW_SELECT,
  });
  // A counsellor removed by their agency has no account left to look at.
  if (!row || row.deleted_at) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  }
  return runAsPartner(ctx.db, cpPartner, row, { type, path, getRawInput }, () =>
    next({ ctx: { ...ctx, cpPartner } }),
  );
});

export const protectedPartnerProcedure = publicProcedure.use(async ({ ctx, next, type, path, getRawInput }) => {
  if (!ctx.cpPartner) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  }
  // Block immediately if the partner was deactivated/rejected mid-session.
  // An owner viewing as a deactivated counsellor still gets in (read-only,
  // see runAsPartner); a removed one is gone for everyone.
  const row = await ctx.db.user.findUnique({
    where: { id: ctx.cpPartner.id },
    select: PARTNER_ROW_SELECT,
  });
  const ownerView = !!ctx.cpPartner.ownerImpersonatorId;
  if (
    !row ||
    row.deleted_at ||
    row.status === UserStatus.REJECTED ||
    (row.status === UserStatus.INACTIVE && !ownerView)
  ) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This account is no longer active.",
    });
  }
  // A procedure that serves one partner tab is refused while that tab is
  // switched off for this partner (API_TABS in ~/lib/partner-tabs).
  const tab = partnerTabForProcedure(path);
  if (tab && !(await cachedPartnerTabs(ctx.tabAccess, { id: ctx.cpPartner.id, type: row.type })).includes(tab)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You don't have access to this section." });
  }
  const cpPartner = ctx.cpPartner;
  return runAsPartner(ctx.db, cpPartner, row, { type, path, getRawInput }, () =>
    next({ ctx: { ...ctx, cpPartner } }),
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

// The partner who is paid commission: an agency owner for their own agency,
// or an independent counsellor for themselves. Guards everything about
// commission, claims, invoices and the payout bank account — agency
// counsellors are refused (the money is the agency's, not theirs). Adds
// ctx.payee; orgId may still be null for an independent with no org.
export const payeeProcedure = protectedPartnerProcedure.use(async ({ ctx, next }) => {
  const me = await ctx.db.user.findUnique({
    where: { id: ctx.cpPartner.id },
    select: { id: true, type: true, is_owner: true, org_id: true },
  });
  const isOwner =
    me?.type === UserType.AGENCY_OWNER && me.is_owner === 1 && me.org_id !== null;
  const isIndependent = me?.type === UserType.INDEPENDENT_COUNSELLOR;
  if (!me || !(isOwner || isIndependent)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only your agency's owner can view commission or manage payouts.",
    });
  }
  return next({ ctx: { ...ctx, payee: { id: me.id, orgId: me.org_id } } });
});
