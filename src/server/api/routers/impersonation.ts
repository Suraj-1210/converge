import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  agencyOwnerProcedure,
  createTRPCRouter,
  protectedAdminProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  signPartnerSessionJwt,
  signSessionJwt,
  verifyPartnerSessionJwt,
} from "~/server/auth/jwt";
import {
  buildPartnerOwnerSessionCookie,
  buildPartnerSessionCookie,
  buildSessionCookie,
  clearPartnerSessionCookie,
  maxAgeUntil,
  readCookie,
} from "~/server/auth/cookies";
import {
  PARTNER_TYPE_LABEL,
  PARTNER_USER_TYPES,
  describeTarget,
  endOwnerImpersonation,
  endPartnerImpersonation,
  endStaffImpersonation,
  staffRoleLabel,
  writeImpersonationAudit,
  writeOwnerImpersonationAudit,
} from "~/server/auth/impersonation";
import { partnerRedirectFor } from "~/server/api/routers/auth";
import { AdminRole, UserStatus, UserType, statusLabelFromCode } from "~/server/db/enums";

// Impersonation is Super Admin only, and only from the admin's OWN session: an
// impersonated staff session (realId set) can never start another one, even if
// the target is itself a Super Admin.
const impersonatorProcedure = protectedAdminProcedure.use(({ ctx, next }) => {
  if (ctx.cpUser.realId || ctx.cpUser.role !== AdminRole.SUPER_ADMIN) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only Super Admins can impersonate users.",
    });
  }
  return next();
});

// Partners who can sign in: approved, or still under review (they land on the
// pending-verification screen). Rejected / inactive accounts are locked out.
const SIGN_IN_STATUSES: number[] = [UserStatus.APPROVED, UserStatus.UNDER_REVIEW];

// Counsellors an agency owner may view as: their own agency's, active or
// deactivated. Removed (soft-deleted), pending and rejected ones are not.
const OWNER_VIEWABLE_STATUSES: number[] = [UserStatus.APPROVED, UserStatus.INACTIVE];

export const impersonationRouter = createTRPCRouter({
  // Drives the amber banner. Public so the banner query never errors; returns
  // null unless the caller's session on that side is an impersonation.
  current: publicProcedure
    .input(z.object({ side: z.enum(["admin", "partner"]) }))
    .query(async ({ ctx, input }) => {
      const partner = ctx.cpPartner;
      // An agency owner viewing as one of their counsellors.
      if (input.side === "partner" && partner?.ownerImpersonatorId) {
        const t = await ctx.db.user.findUnique({
          where: { id: partner.id },
          select: { first_name: true, last_name: true, status: true },
        });
        if (!t) return null;
        return {
          kind: "partner" as const,
          by: "owner" as const,
          name: `${t.first_name} ${t.last_name}`.trim(),
          roleLabel: PARTNER_TYPE_LABEL[UserType.AGENCY_COUNSELLOR] ?? "Agency Counsellor",
          // A deactivated counsellor can be looked at, not acted for.
          readOnly: t.status === UserStatus.INACTIVE,
        };
      }
      const realId =
        input.side === "admin" ? ctx.cpUser?.realId : partner?.impersonatorId;
      const targetId = input.side === "admin" ? ctx.cpUser?.id : partner?.id;
      if (!realId || !targetId) return null;
      const target = await describeTarget(input.side === "admin" ? "staff" : "partner", targetId);
      if (!target) return null;
      return {
        kind: input.side === "admin" ? ("staff" as const) : ("partner" as const),
        by: "admin" as const,
        readOnly: false,
        ...target,
      };
    }),

  // Everyone the Super Admin can impersonate, for the header dropdown.
  targets: impersonatorProcedure.query(async ({ ctx }) => {
    const [staff, partners] = await Promise.all([
      ctx.db.collegepond_user.findMany({
        where: { status: 1, id: { not: ctx.cpUser.id } },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
        select: { id: true, first_name: true, last_name: true, email: true, role: true },
      }),
      ctx.db.user.findMany({
        where: { status: { in: SIGN_IN_STATUSES }, type: { in: PARTNER_USER_TYPES } },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          type: true,
          status: true,
          organization: { select: { name: true } },
        },
      }),
    ]);
    return {
      staff: staff.map((u) => ({
        id: u.id,
        name: `${u.first_name} ${u.last_name}`.trim(),
        email: u.email,
        roleLabel: staffRoleLabel(u.role),
      })),
      partners: partners.map((u) => ({
        id: u.id,
        name: `${u.first_name} ${u.last_name}`.trim(),
        email: u.email,
        roleLabel: PARTNER_TYPE_LABEL[u.type] ?? "Partner",
        orgName: u.organization?.name ?? null,
        underReview: u.status === UserStatus.UNDER_REVIEW,
      })),
    };
  }),

  // Starts impersonating. Never contacts the target (no OTP, no email).
  start: impersonatorProcedure
    .input(z.object({ kind: z.enum(["staff", "partner"]), id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const real = ctx.cpUser;

      // A partner impersonation left open from this admin session is closed
      // first so its end is recorded rather than silently orphaned. So is an
      // agency owner's view-as in this browser: the new partner session
      // replaces it anyway.
      if (ctx.cpPartner?.impersonatorId) {
        await endPartnerImpersonation({
          ...ctx,
          cpPartner: { ...ctx.cpPartner, impersonatorId: ctx.cpPartner.impersonatorId },
        });
      } else if (ctx.cpPartner?.ownerImpersonatorId) {
        await endOwnerImpersonation(ctx, { restore: false });
      }

      if (input.kind === "staff") {
        if (input.id === real.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You can't impersonate yourself." });
        }
        const target = await ctx.db.collegepond_user.findUnique({
          where: { id: input.id },
          select: { id: true, role: true, status: true },
        });
        if (target?.status !== 1) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That user isn't active." });
        }
        // Same expiry as the admin's own login: impersonating never extends it.
        const token = await signSessionJwt({ id: target.id, role: target.role, realId: real.id }, real.exp);
        ctx.resHeaders.append("Set-Cookie", buildSessionCookie(token, maxAgeUntil(real.exp)));
        await writeImpersonationAudit("started", real.id, "staff", target.id);
        return { redirectUrl: "/admin/dashboard" };
      }

      const target = await ctx.db.user.findUnique({
        where: { id: input.id },
        select: { id: true, type: true, status: true, mou_signed_at: true },
      });
      if (!target || !PARTNER_USER_TYPES.includes(target.type) || !SIGN_IN_STATUSES.includes(target.status)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "That partner can't sign in." });
      }
      const token = await signPartnerSessionJwt({ id: target.id, impersonatorId: real.id }, real.exp);
      ctx.resHeaders.append("Set-Cookie", buildPartnerSessionCookie(token, maxAgeUntil(real.exp)));
      await writeImpersonationAudit("started", real.id, "partner", target.id);
      return {
        redirectUrl: partnerRedirectFor(
          statusLabelFromCode(target.status),
          target.mou_signed_at?.toISOString() ?? null,
          target.type === UserType.AGENCY_COUNSELLOR,
        ),
      };
    }),

  // Agency owner: "View as" one of their own counsellors, from the
  // Counsellors page. Never contacts the counsellor (no OTP, no email).
  // Not available to a Super Admin who is impersonating the owner: they
  // impersonate the counsellor directly instead, so there is only ever one
  // level of "viewing as" to exit from.
  startAsCounsellor: agencyOwnerProcedure
    .input(z.object({ counsellorId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.cpPartner.impersonatorId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You are impersonating this agency owner. Exit, then impersonate the counsellor directly from the admin portal.",
        });
      }
      const ownerToken = readCookie(ctx.headers, PARTNER_SESSION_COOKIE_NAME);
      const own = ownerToken ? await verifyPartnerSessionJwt(ownerToken) : null;
      if (
        !ownerToken ||
        own?.id !== ctx.owner.id ||
        own.impersonatorId ||
        own.ownerImpersonatorId ||
        !own.exp
      ) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Please sign in again." });
      }
      const target = await ctx.db.user.findFirst({
        where: {
          id: input.counsellorId,
          org_id: ctx.owner.orgId,
          type: UserType.AGENCY_COUNSELLOR,
          deleted_at: null,
          status: { in: OWNER_VIEWABLE_STATUSES },
        },
        select: { id: true },
      });
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "That counsellor isn't in your agency." });
      }
      // The owner's session is parked unchanged; the counsellor session
      // expires with it, so viewing as never extends the owner's login.
      const token = await signPartnerSessionJwt(
        { id: target.id, ownerImpersonatorId: ctx.owner.id },
        own.exp,
      );
      ctx.resHeaders.append("Set-Cookie", buildPartnerOwnerSessionCookie(ownerToken, maxAgeUntil(own.exp)));
      ctx.resHeaders.append("Set-Cookie", buildPartnerSessionCookie(token, maxAgeUntil(own.exp)));
      await writeOwnerImpersonationAudit("started", ctx.owner.id, target.id);
      return { redirectUrl: "/partner/dashboard" };
    }),

  // "Exit Impersonation". Public so it still works when the impersonated
  // account was deactivated mid-session (its procedures would 401).
  stop: publicProcedure
    .input(z.object({ side: z.enum(["admin", "partner"]) }))
    .mutation(async ({ ctx, input }) => {
      const { cpUser, cpPartner } = ctx;
      if (input.side === "admin") {
        if (!cpUser?.realId) return { redirectUrl: cpUser ? "/admin/dashboard" : "/admin/login" };
        const redirectUrl = await endStaffImpersonation({ ...ctx, cpUser: { ...cpUser, realId: cpUser.realId } });
        return { redirectUrl };
      }
      if (cpPartner?.impersonatorId) {
        await endPartnerImpersonation({ ...ctx, cpPartner: { ...cpPartner, impersonatorId: cpPartner.impersonatorId } });
        return { redirectUrl: "/admin/dashboard" };
      }
      // An owner viewing as a counsellor goes back to their own session (also
      // when the counsellor session no longer resolves, e.g. they were removed
      // mid-view, as long as the parked owner session is still good).
      if (
        cpPartner?.ownerImpersonatorId ||
        (!cpPartner && readCookie(ctx.headers, PARTNER_OWNER_SESSION_COOKIE_NAME))
      ) {
        const restored = await endOwnerImpersonation(ctx);
        return { redirectUrl: restored ? "/partner/counsellors" : "/login" };
      }
      // No live impersonation (e.g. the admin session already expired): just
      // drop whatever partner cookie is left.
      ctx.resHeaders.append("Set-Cookie", clearPartnerSessionCookie());
      return { redirectUrl: cpUser ? "/admin/dashboard" : "/admin/login" };
    }),
});
