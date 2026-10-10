import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { env } from "~/env";
import { emailConfigured, sendTemplatedEmail } from "~/server/email";
import {
  listApplications,
  setApplicationStatus,
  setDocumentStatus,
  partnerPanHolder,
  setPartnerBdm,
  setPartnerPan,
  setPartnerTier,
  type Application,
} from "~/server/applications/store";
import { normalizePan, panError } from "~/lib/utils/pan";

const partnerStatus = z.enum([
  "under_review",
  "approved",
  "rejected",
  "inactive",
]);

const docStatus = z.enum(["pending", "approved", "rejected"]);

// Account-lifecycle email per target status. Optional templates — when the id
// isn't configured we log a minimal event and never block the status change.
function statusEmailTemplateId(status: string): string | undefined {
  switch (status) {
    case "approved":
      return env.MSG91_PARTNER_APPROVED_TEMPLATE_ID;
    case "rejected":
      return env.MSG91_PARTNER_REJECTED_TEMPLATE_ID;
    case "inactive":
      return env.MSG91_PARTNER_DEACTIVATED_TEMPLATE_ID;
    default:
      return undefined;
  }
}

// Notify the partner of an account-status change. Best-effort: a mail failure
// must not roll back the (already-committed) status change, so we swallow it.
async function sendStatusEmail(
  app: Application,
  status: string,
  reason: string | null,
  isReactivation: boolean,
): Promise<void> {
  const templateId = isReactivation
    ? env.MSG91_PARTNER_REACTIVATED_TEMPLATE_ID
    : statusEmailTemplateId(status);
  if (!templateId || !emailConfigured()) {
    console.log(
      `[Partners] Status "${isReactivation ? "reactivated" : status}" email skipped (no template / email off).`,
    );
    return;
  }
  try {
    await sendTemplatedEmail({
      to: app.email,
      templateId,
      variables: {
        name: `${app.firstName} ${app.lastName}`.trim(),
        company: app.companyName ?? "",
        reason: reason ?? "",
      },
    });
  } catch (e) {
    console.error("[Partners] Status email failed:", e);
  }
}

export const partnersRouter = createTRPCRouter({
  list: protectedAdminProcedure.query(async () => {
    return listApplications();
  }),

  setStatus: protectedAdminProcedure
    .input(
      z.object({
        email: z.string().email(),
        status: partnerStatus,
        // Reason is kept for rejected/inactive; a "reactivate" is an approve of
        // a previously-deactivated partner and gets the reactivation email.
        reason: z.string().trim().max(500).optional(),
        isReactivation: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const app = await setApplicationStatus(
        input.email,
        input.status,
        input.reason ?? null,
      );
      if (!app) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Partner application not found",
        });
      }
      await sendStatusEmail(
        app,
        input.status,
        input.reason ?? null,
        input.isReactivation ?? false,
      );
      return app;
    }),

  setTier: protectedAdminProcedure
    .input(
      z.object({
        email: z.string().email(),
        tier: z.number().int().min(0).max(4),
      }),
    )
    .mutation(async ({ input }) => {
      await setPartnerTier(input.email, input.tier);
      return { success: true as const };
    }),

  setBdm: protectedAdminProcedure
    .input(
      z.object({
        email: z.string().email(),
        bdmId: z.number().int().positive().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await setPartnerBdm(input.email, input.bdmId);
      return { success: true as const };
    }),

  setPan: protectedAdminProcedure
    .input(
      z.object({
        email: z.string().email(),
        pan: z.string().trim().max(15).nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      // Clearing is allowed (partners that predate the PAN rule have none);
      // anything entered must pass the same check as signup.
      const pan = input.pan ? normalizePan(input.pan) : "";
      if (pan) {
        const holder = await partnerPanHolder(input.email);
        if (!holder) throw new TRPCError({ code: "NOT_FOUND", message: "Partner not found." });
        const msg = panError(pan, holder);
        if (msg) throw new TRPCError({ code: "BAD_REQUEST", message: msg });
      }
      const ok = await setPartnerPan(input.email, pan || null);
      if (!ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This partner has no linked organization to store a PAN on.",
        });
      }
      return { success: true as const };
    }),

  // After approval, assign a lead counsellor + counsellor (both rows from
  // collegepond_user) onto the partner's user row. Either side can be null
  // if the admin wants to skip and assign later.
  assignCounsellors: protectedAdminProcedure
    .input(
      z.object({
        email: z.string().email(),
        leadCounsellorId: z.number().int().positive().nullable(),
        counsellorId: z.number().int().positive().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      const user = await db.user.findUnique({
        where: { email: input.email.toLowerCase() },
        select: { id: true },
      });
      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Partner not found",
        });
      }
      await db.user.update({
        where: { id: user.id },
        data: {
          lead_counsellor_id: input.leadCounsellorId,
          counsellor_id: input.counsellorId,
        },
      });
      return { success: true as const };
    }),

  setDocumentStatus: protectedAdminProcedure
    .input(
      z.object({
        documentId: z.number().int().positive(),
        status: docStatus,
      }),
    )
    .mutation(async ({ input }) => {
      await setDocumentStatus(input.documentId, input.status);
      return { success: true as const };
    }),

  // Email delivery is intentionally not wired yet — the admin UI lets you
  // compose the request; we log it server-side until the email provider is
  // hooked up. Partner status is left unchanged.
  requestMoreInfo: protectedAdminProcedure
    .input(
      z
        .object({
          email: z.string().email(),
          items: z.array(z.string().min(1)).default([]),
          otherText: z.string().optional(),
          additionalMessage: z.string().optional(),
        })
        .refine(
          (v) =>
            v.items.length > 0 ||
            (v.otherText?.trim().length ?? 0) > 0 ||
            (v.additionalMessage?.trim().length ?? 0) > 0,
          { message: "Pick at least one item or add a message" },
        ),
    )
    .mutation(async ({ input }) => {
      // Email the partner via MSG91 when a template is configured; otherwise log
      // a MINIMAL, non-PII event (never the email/message body).
      if (env.MSG91_MOREINFO_TEMPLATE_ID && emailConfigured()) {
        try {
          await sendTemplatedEmail({
            to: input.email,
            templateId: env.MSG91_MOREINFO_TEMPLATE_ID,
            variables: {
              items: input.items.join(", "),
              other: input.otherText?.trim() ?? "",
              message: input.additionalMessage?.trim() ?? "",
            },
          });
          return { success: true as const };
        } catch {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to send the request email.",
          });
        }
      }
      console.log(
        `[Partners] More-info request queued (${input.items.length} item(s)); set MSG91_MOREINFO_TEMPLATE_ID to email partners.`,
      );
      return { success: true as const };
    }),
});
