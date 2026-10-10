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
import { isPanRequired, normalizePan, panError } from "~/lib/utils/pan";

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
      const phoneE164 = toE164(input.phone, input.countryCode);
      const results = await Promise.allSettled([
        sendEmailOtp(input.email),
        sendPhoneOtp(phoneE164),
      ]);

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
      return { verified: true as const };
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
      return { verified: true as const };
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
      })
      // A GST-registered agency must supply its certificate. The client enforces
      // this too, but the rule lives here as well so the API can't be bypassed.
      .refine((v) => !(v.gstRegistered === true) || !!v.documents?.gst, {
        message: "GST certificate is required for a GST-registered agency",
        path: ["documents"],
      })
      .superRefine((v, ctx) => {
        const pan = v.pan ? normalizePan(v.pan) : "";
        if (!pan && !isPanRequired(v.role, v)) return;
        const msg = panError(pan, v.role === "agency" ? "agency" : "individual");
        if (msg) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ["pan"] });
      }),
    )
    .mutation(async ({ input }) => {
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
        phone: input.phone,
        countryCode: input.countryCode,
        companyName: input.companyName,
        companyWebsite: input.companyWebsite,
        ...location,
        companyAddress: input.companyAddress,
        numCounselors: input.numCounselors,
        annualVolume: input.annualVolume,
        gstRegistered: input.gstRegistered,
        documents: input.documents,
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
