import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  appUrl,
  documentRejectedEmail,
  moreInfoRequestEmail,
  partnerApprovedEmail,
  partnerDeactivatedEmail,
  partnerDeclinedEmail,
  partnerReactivatedEmail,
  sendEmail,
  type EmailMessage,
} from "~/server/email";
import {
  getApplicationByEmail,
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
import { DocumentStatus, UserStatus } from "~/server/db/enums";

// Slot key (document.doc_type) → the name a partner recognises.
const DOC_LABELS: Record<string, string> = {
  companyPan: "Company PAN Card",
  pan: "PAN Card",
  aadhaar: "Aadhaar Card",
  cancelledCheque: "Cancelled Cheque",
  partnershipDocs: "Company / Partnership Documents",
  logo: "Company Logo",
  gst: "GST Certificate",
  profilePhoto: "Profile Photo",
};

// Who to tell about a rejected document: the uploader for a personal doc, the
// agency owner(s) for a company doc. Applicants are usually still under
// review here, so no "approved only" filter — just skip deactivated users.
async function documentRecipients(doc: { user_id: number | null; org_id: number | null }) {
  const users = await db.user.findMany({
    where: doc.user_id
      ? { id: doc.user_id }
      : { org_id: doc.org_id ?? -1, is_owner: 1 },
    select: { email: true, first_name: true, last_name: true, status: true, organization: { select: { name: true } } },
  });
  return users.filter((u) => u.status !== UserStatus.INACTIVE);
}

const partnerStatus = z.enum([
  "under_review",
  "approved",
  "rejected",
  "inactive",
]);

const docStatus = z.enum(["pending", "approved", "rejected"]);

// The partner email for an account-status change, or null when the change
// doesn't warrant one (e.g. back to under review).
function statusEmail(
  app: Application,
  status: string,
  reason: string | null,
  isReactivation: boolean,
): EmailMessage | null {
  const p = { name: `${app.firstName} ${app.lastName}`.trim(), company: app.companyName };
  if (isReactivation) return partnerReactivatedEmail(p, appUrl());
  switch (status) {
    case "approved":
      return partnerApprovedEmail(p, appUrl());
    case "rejected":
      return partnerDeclinedEmail(p, reason);
    case "inactive":
      return partnerDeactivatedEmail(p, reason);
    default:
      return null;
  }
}

// Notify the partner of an account-status change. Best-effort: a mail failure
// must not roll back the (already-committed) status change, so it is reported
// back to the admin as emailSent: false instead of thrown.
async function sendStatusEmail(
  app: Application,
  status: string,
  reason: string | null,
  isReactivation: boolean,
): Promise<boolean | null> {
  const msg = statusEmail(app, status, reason, isReactivation);
  if (!msg) return null;
  try {
    await sendEmail(app.email, msg);
    return true;
  } catch (e) {
    console.error("[Partners] Status email failed:", e instanceof Error ? e.message : e);
    return false;
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
      const emailSent = await sendStatusEmail(
        app,
        input.status,
        input.reason ?? null,
        input.isReactivation ?? false,
      );
      // null = no email for this change; false = it failed (status still saved).
      return { ...app, emailSent };
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
      const before = await db.document.findUnique({
        where: { id: input.documentId },
        select: { status: true, doc_type: true, user_id: true, org_id: true },
      });
      await setDocumentStatus(input.documentId, input.status);

      // Email only on the transition into "rejected", so re-clicking Reject
      // doesn't send the partner a second copy.
      let emailSent: boolean | null = null;
      if (before && input.status === "rejected" && before.status !== DocumentStatus.REJECTED) {
        const label = DOC_LABELS[before.doc_type] ?? before.doc_type;
        const recipients = await documentRecipients(before);
        emailSent = false;
        for (const u of recipients) {
          try {
            await sendEmail(
              u.email,
              documentRejectedEmail(
                { name: `${u.first_name} ${u.last_name}`.trim(), company: u.organization?.name ?? null },
                label,
              ),
            );
            emailSent = true;
          } catch (e) {
            console.error("[Partners] Document-rejected email failed:", e instanceof Error ? e.message : e);
          }
        }
      }
      return { success: true as const, emailSent };
    }),

  // Emails the partner a list of what is missing. Partner status is left
  // unchanged; the partner replies to the email (Reply-To: support).
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
      const app = await getApplicationByEmail(input.email);
      if (!app) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Partner application not found" });
      }
      try {
        await sendEmail(
          app.email,
          moreInfoRequestEmail(
            { name: `${app.firstName} ${app.lastName}`.trim(), company: app.companyName },
            { items: input.items, other: input.otherText, message: input.additionalMessage },
          ),
        );
      } catch (e) {
        console.error("[Partners] More-info email failed:", e instanceof Error ? e.message : e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to send the request email.",
        });
      }
      return { success: true as const };
    }),
});
