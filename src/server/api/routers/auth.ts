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
import { signPartnerSessionJwt } from "~/server/auth/jwt";
import { buildPartnerSessionCookie, clearPartnerSessionCookie } from "~/server/auth/cookies";
import { endImpersonationFromLogout } from "~/server/auth/impersonation";
import { DocumentStatus, UserType, partnerKindOf } from "~/server/db/enums";
import { PARTNER_DOC_SLOTS } from "~/lib/constants/partner-documents";
import { MOU_VERSION, MouSignatureKind, mouSectionsFor } from "~/lib/constants/mou";
import { MOU_USER_SELECT, executedMouFor, renderExecutedMou } from "~/server/mou-pdf";
import { currentTierFy, ladderFor } from "~/server/partner-tiers";
import { randomUUID } from "node:crypto";
import { resolveStorageUrl, saveBuffer } from "~/server/storage";

// Decides where to send the partner after login (and on revisits).
//   under_review / rejected / inactive → /pending-verification
//   approved + MOU not signed           → /mou-signing
//   approved + MOU signed               → /partner/dashboard
// Agency counsellors never sign the MOU — only the account owner does — so
// they skip straight to the dashboard once approved.
export function partnerRedirectFor(
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
      // agency (owner) / counsellor / independent: what the portal may offer.
      kind: partnerKindOf(user.type),
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

    // An agency counsellor files no KYC of their own: Collegepond approves
    // them against their agency, which the owner has already documented.
    // Only what sign-up collects: bank proof (the cancelled cheque) lives in
    // My Account → Bank Details, so a legacy cheque isn't listed here.
    const kind = partnerKindOf(user.type);
    const slots = kind === "counsellor" ? [] : PARTNER_DOC_SLOTS[kind].filter((s) => s.atSignup);
    const docs = await ctx.db.document.findMany({
      where: {
        OR: [{ user_id: user.id }, ...(user.org_id ? [{ org_id: user.org_id }] : [])],
      },
      orderBy: { id: "desc" },
      select: { doc_type: true, status: true, created_at: true },
    });
    const gstRegistered =
      user.organization?.gst_registered == null ? null : user.organization.gst_registered === 1;

    const documents = slots
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

  // Records the signature with the signing time, signer name and IP, so the
  // executed MOU can be downloaded from /api/mou.
  signMou: protectedPartnerProcedure
    .input(
      z.discriminatedUnion("kind", [
        // A PNG data URL from the signature pad (a few KB to a few hundred).
        z.object({
          kind: z.literal("drawn"),
          data: z
            .string()
            .max(1_500_000, "Signature image is too large")
            .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Invalid signature image"),
        }),
        z.object({ kind: z.literal("typed"), data: z.string().trim().min(1).max(100) }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      // A signature has to come from the partner themselves.
      if (ctx.cpPartner.impersonatorId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "The MOU can't be signed while impersonating a partner.",
        });
      }
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.cpPartner.id },
        select: MOU_USER_SELECT,
      });
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
      if (user.mou_signed_at) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The MOU is already signed." });
      }
      const xff = ctx.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
      // Whole seconds, matching what mou_signed_at stores, so the frozen PDF
      // and the database agree on the signing time.
      const signedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const signature = {
        signedAt,
        kind: input.kind === "drawn" ? MouSignatureKind.DRAWN : MouSignatureKind.TYPED,
        data: input.data,
        signerName: `${user.first_name} ${user.last_name}`.trim(),
        ip: xff ?? ctx.headers.get("x-real-ip"),
        version: MOU_VERSION,
      };

      // The commission tier table comes from the Partner Tiers master (this
      // FY's ladder) — the same one the signing screen showed.
      const ladder = await ladderFor(currentTierFy(signedAt));
      if (ladder.steps.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The MOU's commission tiers aren't set up yet. Please contact Collegepond.",
        });
      }

      // Freeze the executed MOU as signed. It's saved before the MOU is
      // marked signed, so a partner is never signed without their copy.
      let pdfUrl: string;
      try {
        const pdf = await renderExecutedMou({
          ...executedMouFor(
            {
              ...user,
              mou_signature: signature.data,
              mou_signature_kind: signature.kind,
              mou_signer_name: signature.signerName,
              mou_signed_ip: signature.ip ?? null,
              mou_version: signature.version,
            },
            signedAt,
          ),
          sections: mouSectionsFor(ladder.steps),
        });
        const stored = await saveBuffer(
          Buffer.from(pdf),
          `partner-mou/${ctx.cpPartner.id}/${randomUUID()}.pdf`,
          { contentType: "application/pdf" },
        );
        pdfUrl = stored.url;
      } catch (err) {
        console.error("[mou] couldn't save the signed MOU", err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "We couldn't save your signed MOU. Please try again.",
        });
      }

      await markMouSigned(ctx.cpPartner.id, { ...signature, pdfUrl });
      return { success: true as const };
    }),

  // Touched by /partner/dashboard on every mount.
  // Skipped while a Super Admin is impersonating, so it isn't counted as the
  // partner's own login.
  recordDashboardVisit: protectedPartnerProcedure.mutation(async ({ ctx }) => {
    if (!ctx.cpPartner.impersonatorId) await recordPartnerLogin(ctx.cpPartner.id);
    return { success: true as const };
  }),

  // Clears the partner session cookie. Public on purpose so a stale/missing
  // cookie doesn't 401 the logout itself. Uses ctx.resHeaders so the Set-Cookie
  // actually reaches the browser.
  logout: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.cpPartner?.impersonatorId) await endImpersonationFromLogout(ctx);
    ctx.resHeaders.append("Set-Cookie", clearPartnerSessionCookie());
    return { success: true as const };
  }),
});
