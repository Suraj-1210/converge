import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import {
  sendEmailOtp,
  sendPhoneOtp,
  toE164,
  verifyEmailOtp,
  verifyPhoneOtp,
} from "~/server/otp";
import { saveApplication } from "~/server/applications/store";
import { notifyAdminOfSignup } from "~/server/notifications";
import { checkLocation } from "~/server/geo";
import { db } from "~/server/db";
import { isPanRequired, normalizePan, panError } from "~/lib/utils/pan";
import { signSignupProof, verifySignupProof } from "~/server/auth/jwt";
import { PARTNER_DOC_SLOTS, type PartnerRole } from "~/lib/constants/partner-documents";

// Keeps only the documents sign-up collects. Banking proof (the cancelled
// cheque) belongs to Financial Details after approval, so one sent by a page
// loaded before that change is dropped rather than failing the sign-up.
function signupDocuments(
  role: PartnerRole,
  documents: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!documents) return documents;
  const allowed = new Set(PARTNER_DOC_SLOTS[role].filter((s) => s.atSignup).map((s) => s.key));
  return Object.fromEntries(Object.entries(documents).filter(([key]) => allowed.has(key)));
}

// One account per email and per phone number. A partner who signed up before
// (pending, rejected, deactivated…) must log in, not apply again — a second
// signup would otherwise overwrite their record or create a duplicate.
async function assertNotRegistered(email: string, phone: string, countryCode: string) {
  // Signup stores countryCode + the digits (older rows: spaces removed); match
  // both forms so a stray dash doesn't dodge the check.
  const phones = [
    `${countryCode}${phone.replace(/\s/g, "")}`,
    `${countryCode}${phone.replace(/\D/g, "")}`,
  ];
  const existing = await db.user.findFirst({
    where: { OR: [{ email: email.toLowerCase() }, { phone: { in: phones } }] },
    select: { email: true },
  });
  if (existing) {
    const byEmail = existing.email.toLowerCase() === email.toLowerCase();
    throw new TRPCError({
      code: "CONFLICT",
      message: byEmail
        ? "An account with this email already exists. Please log in to check your application status."
        : "An account with this phone number already exists. Please log in to check your application status.",
    });
  }
}

// The OTP verify calls return signed proofs; without both, matching the email
// and phone being submitted, an application can't be filed in someone else's
// name by calling the API directly.
async function assertVerified(
  email: string,
  phone: string,
  countryCode: string,
  proofs: { email: string; phone: string },
) {
  const [emailOk, phoneOk] = await Promise.all([
    verifySignupProof(proofs.email, "email", email.toLowerCase()),
    verifySignupProof(proofs.phone, "phone", toE164(phone, countryCode)),
  ]);
  if (!emailOk || !phoneOk) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your email and phone verification is missing or has expired. Please verify them again.",
    });
  }
}

export const signupRouter = createTRPCRouter({
  sendSignupOtp: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        phone: z.string().min(1),
        countryCode: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      // Before any codes go out: a returning applicant is sent to login.
      await assertNotRegistered(input.email, input.phone, input.countryCode);
      const phoneE164 = toE164(input.phone, input.countryCode);
      const results = await Promise.allSettled([
        sendEmailOtp(input.email, "signup"),
        sendPhoneOtp(phoneE164),
      ]);

      // One channel failing still lets signup continue, so log why — otherwise
      // a broken email or SMS setup is invisible. Reason only, never the
      // address, number or code.
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.error(`[otp] signup ${i === 0 ? "email" : "SMS"} send failed: ${reason}`);
        }
      });

      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length === results.length) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to send OTP",
        });
      }

      return {
        success: true as const,
        emailSent: results[0].status === "fulfilled",
        phoneSent: results[1].status === "fulfilled",
      };
    }),

  verifyEmailOtp: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        otp: z.string().length(5),
      }),
    )
    .mutation(async ({ input }) => {
      const ok = await verifyEmailOtp(input.email, input.otp);
      if (!ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired OTP" });
      }
      return {
        verified: true as const,
        proof: await signSignupProof("email", input.email.toLowerCase()),
      };
    }),

  verifyPhoneOtp: publicProcedure
    .input(
      z.object({
        phone: z.string().min(1),
        countryCode: z.string().min(1),
        otp: z.string().length(5),
      }),
    )
    .mutation(async ({ input }) => {
      const phoneE164 = toE164(input.phone, input.countryCode);
      const ok = await verifyPhoneOtp(phoneE164, input.otp);
      if (!ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired OTP" });
      }
      return { verified: true as const, proof: await signSignupProof("phone", phoneE164) };
    }),

  submitApplication: publicProcedure
    .input(
      z.object({
        role: z.enum(["agency", "independent"]),
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email(),
        phone: z.string().min(1),
        countryCode: z.string().min(1),
        // Agency-specific fields
        companyName: z.string().optional(),
        companyWebsite: z.string().optional(),
        country: z.string().optional(),
        state: z.string().optional(),
        city: z.string().optional(),
        companyAddress: z.string().optional(),
        numCounselors: z.string().optional(),
        annualVolume: z.string().optional(),
        gstRegistered: z.boolean().optional(),
        // Map of document key -> stored file URL (e.g. "/uploads/...")
        documents: z.record(z.string(), z.string()).optional(),
        // Company PAN for an agency, personal PAN for an independent. Required
        // for India-based partners; see ~/lib/utils/pan for the rule.
        pan: z.string().max(20).optional(),
        // No bdmId: BDMs are assigned internally after signup. Team names are
        // not exposed on the public form, and an unknown key is stripped.

        // Proofs returned by verifyEmailOtp / verifyPhoneOtp; see assertVerified.
        verification: z.object({ email: z.string().min(1), phone: z.string().min(1) }),
      })
      // Required sign-up documents (incl. the GST certificate for a
      // GST-registered agency). The client enforces these too, but the rule
      // lives here as well so the API can't be bypassed.
      .superRefine((v, ctx) => {
        const gstRegistered = v.gstRegistered ?? null;
        for (const slot of PARTNER_DOC_SLOTS[v.role]) {
          if (slot.atSignup && slot.required({ gstRegistered }) && !v.documents?.[slot.key]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${slot.label} is required`,
              path: ["documents"],
            });
          }
        }
      })
      .superRefine((v, ctx) => {
        const pan = v.pan ? normalizePan(v.pan) : "";
        if (!pan && !isPanRequired(v.role, v)) return;
        const msg = panError(pan, v.role === "agency" ? "agency" : "individual");
        if (msg) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ["pan"] });
      }),
    )
    .mutation(async ({ input }) => {
      await assertVerified(input.email, input.phone, input.countryCode, input.verification);
      // Re-checked here so the API can't be used to overwrite an account.
      await assertNotRegistered(input.email, input.phone, input.countryCode);

      // Agencies pick their location from the master list; the server checks
      // it against the same list (independents don't give a location yet).
      let location: { country?: string; state?: string; city?: string } = {};
      if (input.role === "agency") {
        const loc = await checkLocation(input);
        if (!loc.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: loc.message });
        }
        location = { country: loc.country, state: loc.state ?? undefined, city: loc.city };
      }

      const app = await saveApplication({
        email: input.email,
        role: input.role,
        firstName: input.firstName,
        lastName: input.lastName,
        // Digits only, so the stored number matches what was verified and what
        // assertNotRegistered looks up, whatever separators were sent.
        phone: input.phone.replace(/\D/g, ""),
        countryCode: input.countryCode,
        companyName: input.companyName,
        companyWebsite: input.companyWebsite,
        ...location,
        companyAddress: input.companyAddress,
        numCounselors: input.numCounselors,
        annualVolume: input.annualVolume,
        gstRegistered: input.gstRegistered,
        documents: signupDocuments(input.role, input.documents),
        pan: input.pan ? normalizePan(input.pan) : undefined,
      });

      notifyAdminOfSignup(app).catch((err) => {
        console.error("Admin notification failed:", err);
      });

      return {
        applicationId: app.applicationId,
        status: app.status,
      };
    }),
});
