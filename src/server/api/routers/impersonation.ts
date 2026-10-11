import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { signPartnerSessionJwt, signSessionJwt } from "~/server/auth/jwt";
import {
  buildPartnerSessionCookie,
  buildSessionCookie,
  clearPartnerSessionCookie,
  maxAgeUntil,
} from "~/server/auth/cookies";
import {
  PARTNER_TYPE_LABEL,
  PARTNER_USER_TYPES,
  describeTarget,
  endPartnerImpersonation,
  endStaffImpersonation,
  staffRoleLabel,
  writeImpersonationAudit,
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

export const impersonationRouter = createTRPCRouter({
  // Drives the amber banner. Public so the banner query never errors; returns
  // null unless the caller's session on that side is an impersonation.
  current: publicProcedure
    .input(z.object({ side: z.enum(["admin", "partner"]) }))
    .query(async ({ ctx, input }) => {
      const realId =
        input.side === "admin" ? ctx.cpUser?.realId : ctx.cpPartner?.impersonatorId;
      const targetId = input.side === "admin" ? ctx.cpUser?.id : ctx.cpPartner?.id;
      if (!realId || !targetId) return null;
      const target = await describeTarget(input.side === "admin" ? "staff" : "partner", targetId);
      return target ? { kind: input.side === "admin" ? "staff" : "partner", ...target } : null;
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
      // first so its end is recorded rather than silently orphaned.
      if (ctx.cpPartner?.impersonatorId) {
        await endPartnerImpersonation({
          ...ctx,
          cpPartner: { ...ctx.cpPartner, impersonatorId: ctx.cpPartner.impersonatorId },
        });
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
      // No live impersonation (e.g. the admin session already expired): just
      // drop whatever partner cookie is left.
      ctx.resHeaders.append("Set-Cookie", clearPartnerSessionCookie());
      return { redirectUrl: cpUser ? "/admin/dashboard" : "/admin/login" };
    }),
});
