import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
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
import { UserType } from "~/server/db/enums";

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
  me: protectedPartnerProcedure.query(async ({ ctx }) => {
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
