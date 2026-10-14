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
import { db } from "~/server/db";
import { findPartnerByContact } from "~/server/partner-contact";
import { AdminRole } from "~/server/db/enums";

// One account per email and per phone number, across every agency and
// independent. A partner who signed up before, or a counsellor an agency
// already added, must log in, not apply again.
async function assertNotRegistered(email: string, phone: string, countryCode: string) {
  const existing = await findPartnerByContact(email, countryCode, phone);
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        existing.matchedOn === "email"
          ? "An account with this email already exists. Please log in to check your application status."
          : "An account with this phone number already exists. Please log in to check your application status.",
    });
  }
}

export const signupRouter = createTRPCRouter({
  // Public BDM list for the signup form. Returns only id + display name —
  // narrow on purpose since this endpoint is reachable without auth.
  listBdms: publicProcedure.query(async () => {
    const rows = await db.collegepond_user.findMany({
      where: { role: AdminRole.BDM, status: 1 },
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      select: { id: true, first_name: true, last_name: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`.trim(),
    }));
  }),

  sendSignupOtp: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        phone: z.string().min(1),
        countryCode: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      // Before any codes go out: a returning partner (or a counsellor an
      // agency already added) is sent to login.
      await assertNotRegistered(input.email, input.phone, input.countryCode);
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
        bdmId: z.number().int().positive().nullable().optional(),
      })
      // A GST-registered agency must supply its certificate. The client enforces
      // this too, but the rule lives here as well so the API can't be bypassed.
      .refine((v) => !(v.gstRegistered === true) || !!v.documents?.gst, {
        message: "GST certificate is required for a GST-registered agency",
        path: ["documents"],
      }),
    )
    .mutation(async ({ input }) => {
      // Re-checked here: this endpoint is public and can be called directly.
      await assertNotRegistered(input.email, input.phone, input.countryCode);
      const app = await saveApplication({
        email: input.email,
        role: input.role,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        countryCode: input.countryCode,
        companyName: input.companyName,
        companyWebsite: input.companyWebsite,
        country: input.country,
        state: input.state,
        city: input.city,
        companyAddress: input.companyAddress,
        numCounselors: input.numCounselors,
        annualVolume: input.annualVolume,
        gstRegistered: input.gstRegistered,
        documents: input.documents,
        bdmId: input.bdmId ?? null,
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
