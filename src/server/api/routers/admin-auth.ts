import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { env } from "~/env";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  devPeekEmailOtp,
  devPeekPhoneOtp,
  sendEmailOtp,
  sendPhoneOtp,
  toE164,
  verifyEmailOtp,
  verifyPhoneOtp,
} from "~/server/otp";
import { SESSION_COOKIE_NAME, signSessionJwt } from "~/server/auth/jwt";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8; // matches the JWT TTL

function buildSessionCookie(token: string): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

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

// Where the login code goes. SMS to the registered phone by default;
// ADMIN_LOGIN_OTP_CHANNEL=email mails it to the registered address instead.
// Either way the email AND phone must both match the account first.
function loginOtpChannel(): "sms" | "email" {
  return env.ADMIN_LOGIN_OTP_CHANNEL === "email" ? "email" : "sms";
}

// Admin login: identifies the user by email against `collegepond_user`,
// requires the registered phone to match, then verifies a one-time code sent
// over the channel above.
export const adminAuthRouter = createTRPCRouter({
  sendLoginOtp: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        phone: z.string().min(1),
        countryCode: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const user = await db.collegepond_user.findUnique({
        where: { email: input.email.toLowerCase() },
      });
      // Single generic error to avoid leaking which side mismatched.
      const mismatchError = new TRPCError({
        code: "NOT_FOUND",
        message: "Email and phone combination not found. Contact IT support.",
      });
      if (!user) throw mismatchError;
      if (user.status !== 1) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This account is deactivated. Contact IT support.",
        });
      }

      const stored = splitPhone(user.phone);
      const providedE164 = toE164(input.phone, input.countryCode);
      const storedE164 = toE164(stored.phone, stored.countryCode);
      if (providedE164 !== storedE164) throw mismatchError;

      const channel = loginOtpChannel();
      try {
        if (channel === "email") await sendEmailOtp(user.email);
        else await sendPhoneOtp(providedE164);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // Resend within the email cooldown: the code already sent stays valid.
        if (reason.startsWith("An OTP was just sent")) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "A code was just sent. Check your inbox, or wait 30 seconds and try again.",
          });
        }
        // The provider's reason (never the code, email or phone) so a failed
        // send can be diagnosed from the logs.
        console.error(`[otp] admin login ${channel} send failed for cp_user ${user.id}: ${reason}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to send OTP",
        });
      }

      // Dev autopilot fuel — always null outside dev/sandbox.
      const devOtp = channel === "email" ? devPeekEmailOtp(user.email) : devPeekPhoneOtp(providedE164);
      return { success: true as const, channel, devOtp };
    }),

  verifyLoginOtp: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        phone: z.string().min(1),
        countryCode: z.string().min(1),
        otp: z.string().length(5),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await db.collegepond_user.findUnique({
        where: { email: input.email.toLowerCase() },
      });
      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No account found" });
      }
      if (user.status !== 1) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This account is deactivated. Contact IT support.",
        });
      }

      const stored = splitPhone(user.phone);
      const providedE164 = toE164(input.phone, input.countryCode);
      const storedE164 = toE164(stored.phone, stored.countryCode);
      if (providedE164 !== storedE164) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Phone number does not match this account",
        });
      }

      const ok =
        loginOtpChannel() === "email"
          ? await verifyEmailOtp(user.email, input.otp)
          : await verifyPhoneOtp(providedE164, input.otp);
      if (!ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid or expired OTP",
        });
      }

      await db.collegepond_user.update({
        where: { id: user.id },
        data: { last_login_at: new Date() },
      });

      const token = await signSessionJwt({ id: user.id, role: user.role });
      ctx.resHeaders.append("Set-Cookie", buildSessionCookie(token));

      // The admin login page expects status === "approved" for the success
      // redirect; collegepond_user has no pending state, so an active row
      // maps to "approved" here.
      return {
        success: true as const,
        name: user.first_name,
        status: "approved" as const,
        applicationId: String(user.id),
      };
    }),
});
