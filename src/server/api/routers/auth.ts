import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  partnerSelfProcedure,
  protectedPartnerProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import {
  devPeekEmailOtp,
  sendEmailOtp,
  verifyEmailOtp,
} from "~/server/otp";
import {
  getApplicationByEmail,
  markMouSigned,
  recordPartnerLogin,
} from "~/server/applications/store";
import {
  PARTNER_SESSION_COOKIE_NAME,
  signPartnerSessionJwt,
} from "~/server/auth/jwt";
import { DocumentStatus, UserType } from "~/server/db/enums";
import { PARTNER_DOC_SLOTS } from "~/lib/constants/partner-documents";
import { resolveStorageUrl } from "~/server/storage";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

function buildPartnerSessionCookie(token: string): string {
  const attrs = [
    `${PARTNER_SESSION_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

// Expire the partner session cookie (same name + Path as the login cookie).
// Emitted via ctx.resHeaders — next/headers cookies().delete() is dropped by the
// tRPC fetch handler and never reaches the browser, so the session would survive.
function clearPartnerSessionCookie(): string {
  const attrs = [
    `${PARTNER_SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

// Decides where to send the partner after login (and on revisits).
//   under_review / rejected / inactive → /pending-verification
//   approved + MOU not signed           → /mou-signing
//   approved + MOU signed               → /partner/dashboard
// Agency counsellors never sign the MOU — only the account owner does — so
// they skip straight to the dashboard once approved.
function partnerRedirectFor(
  status: "under_review" | "approved" | "rejected" | "inactive",
  mouSignedAt: string | null | undefined,
  mouExempt = false,
): string {
  if (status !== "approved") return "/pending-verification";
  if (!mouSignedAt && !mouExempt) return "/mou-signing";
  return "/partner/dashboard";
}

export const authRouter = createTRPCRouter({
  sendLoginOtp: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        phone: z.string().min(1),
        countryCode: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const app = await getApplicationByEmail(input.email);
      if (!app) {
        // Product decision (account enumeration accepted for this B2B portal):
        // tell the user the email isn't registered rather than silently
        // advancing to an OTP screen that will never receive a code.
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No account found with this email.",
        });
      }

      // Login OTP is email-only — verification checks the email code. Phone/SMS
      // OTP is a signup-time concern (phone verification); firing a second SMS
      // code at login just produced a non-verifiable code that read as "invalid".
      try {
        await sendEmailOtp(input.email, "partner_login");
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to send OTP",
        });
      }

      // devOtp is always null outside dev/sandbox.
      return { success: true as const, devOtp: devPeekEmailOtp(input.email) };
    }),

  verifyLoginOtp: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        phone: z.string().min(1),
        otp: z.string().length(5),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ok = await verifyEmailOtp(input.email, input.otp);
      if (!ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired OTP" });
      }

      const app = await getApplicationByEmail(input.email);
      if (!app) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No account found for this email",
        });
      }

      // Look up the row again to grab the user id for the JWT subject.
      const row = await ctx.db.user.findUnique({
        where: { email: input.email.toLowerCase() },
        select: { id: true, type: true },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No account found" });
      }

      // last_login_at is intentionally not set here — that happens once the
      // partner actually lands on /partner/dashboard (see recordDashboardVisit).
      const token = await signPartnerSessionJwt({ id: row.id });
      ctx.resHeaders.append("Set-Cookie", buildPartnerSessionCookie(token));

      return {
        success: true as const,
        name: app.firstName,
        status: app.status,
        applicationId: app.applicationId,
        mouSigned: !!app.mouSignedAt,
        redirectUrl: partnerRedirectFor(
          app.status,
          app.mouSignedAt,
          row.type === UserType.AGENCY_COUNSELLOR,
        ),
      };
    }),

  // Returns the signed-in partner's current state. Pages call this on mount
  // and use redirectUrl to bounce to the right screen if state has shifted.
  // Readable at any status: a rejected or deactivated partner still needs to
  // see their own state (the status page), just nothing else.
  me: partnerSelfProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.cpPartner.id },
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        status: true,
        type: true,
        mou_signed_at: true,
        tracking_id: true,
        avatar_url: true,
      },
    });
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
    }
    const status =
      user.status === 1
        ? "approved"
        : user.status === 2
          ? "rejected"
          : user.status === 3
            ? "inactive"
            : "under_review";
    const mouSignedAt = user.mou_signed_at?.toISOString() ?? null;
    return {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      avatarUrl: resolveStorageUrl(user.avatar_url),
      applicationId: user.tracking_id ?? "",
      status,
      mouSigned: !!mouSignedAt,
      redirectUrl: partnerRedirectFor(
        status,
        mouSignedAt,
        user.type === UserType.AGENCY_COUNSELLOR,
      ),
    };
  }),

  // Status page for a partner who isn't approved yet (or was rejected /
  // deactivated): each required document and its review state, the latest
  // "more information" request from the team, and the decision reason.
  applicationProgress: partnerSelfProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.cpPartner.id },
      select: {
        id: true,
        type: true,
        org_id: true,
        status: true,
        status_reason: true,
        is_email_verified: true,
        is_phone_verified: true,
        created_at: true,
        organization: { select: { gst_registered: true } },
      },
    });
    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });

    const role = user.type === UserType.AGENCY_OWNER ? "agency" : "independent";
    const docs = await ctx.db.document.findMany({
      where: {
        OR: [{ user_id: user.id }, ...(user.org_id ? [{ org_id: user.org_id }] : [])],
      },
      orderBy: { id: "desc" },
      select: { doc_type: true, status: true, created_at: true },
    });
    const gstRegistered =
      user.organization?.gst_registered == null ? null : user.organization.gst_registered === 1;

    const documents = PARTNER_DOC_SLOTS[role]
      .map((slot) => {
        const latest = docs.find((d) => d.doc_type === slot.key); // newest first
        const required = slot.required({ gstRegistered });
        const state = !latest
          ? ("missing" as const)
          : latest.status === DocumentStatus.APPROVED
            ? ("verified" as const)
            : latest.status === DocumentStatus.REJECTED
              ? ("rejected" as const)
              : ("in_review" as const);
        return { key: slot.key, label: slot.label, required, state };
      })
      // Optional slots only matter once something was uploaded.
      .filter((d) => d.required || d.state !== "missing");

    const moreInfo = await ctx.db.audit_log.findFirst({
      where: { user_id: user.id, action: "partner.more_info_requested" },
      orderBy: { created_at: "desc" },
      select: { metadata: true, created_at: true },
    });
    const m = (moreInfo?.metadata ?? null) as
      | { items?: string[]; other?: string | null; message?: string | null }
      | null;

    return {
      submittedAt: user.created_at.toISOString(),
      contactVerified: user.is_email_verified === 1 && user.is_phone_verified === 1,
      documents,
      reason: user.status_reason,
      moreInfo: moreInfo
        ? {
            at: moreInfo.created_at.toISOString(),
            items: [...(m?.items ?? []), ...(m?.other ? [m.other] : [])],
            message: m?.message ?? null,
          }
        : null,
    };
  }),

  // Marks mou_signed_at = NOW(). Signature payload is currently discarded —
  // when Digio/Leegality is wired in, the document URL would be stored too.
  signMou: protectedPartnerProcedure
    .input(
      z.object({
        kind: z.enum(["drawn", "typed"]),
        // Drawn: a base64-encoded PNG data URL. Typed: the typed name. We
        // accept both to satisfy validation but don't persist either yet.
        data: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx }) => {
      await markMouSigned(ctx.cpPartner.id);
      return { success: true as const };
    }),

  // Touched by /partner/dashboard on every mount.
  recordDashboardVisit: protectedPartnerProcedure.mutation(async ({ ctx }) => {
    await recordPartnerLogin(ctx.cpPartner.id);
    return { success: true as const };
  }),

  // Clears the partner session cookie. Public on purpose so a stale/missing
  // cookie doesn't 401 the logout itself. Uses ctx.resHeaders so the Set-Cookie
  // actually reaches the browser.
  logout: publicProcedure.mutation(({ ctx }) => {
    ctx.resHeaders.append("Set-Cookie", clearPartnerSessionCookie());
    return { success: true as const };
  }),
});
