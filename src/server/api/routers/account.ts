import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  agencyOwnerProcedure,
  createTRPCRouter,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { DocumentStatus, PartnerKindLabel, partnerKindOf } from "~/server/db/enums";
import { resolveStorageUrl } from "~/server/storage";
import {
  DEFAULT_NOTIFICATION_PREF,
  NOTIFICATION_PREF_ROWS,
  type NotificationPref,
} from "~/lib/constants/notification-prefs";
import { isAgencyOwner } from "~/server/partner-access";
import { partnerDocLabel } from "~/lib/constants/partner-labels";
import { PARTNER_DOC_SLOTS } from "~/lib/constants/partner-documents";
import { gstinError, gstinWarnings, normalizeGstin } from "~/lib/utils/gstin";
import { env } from "~/env";
import { adminGstChangedEmail, appUrl, sendEmail } from "~/server/email";

// Document types kept only so older uploads keep their label (atSignup: false).
const NOT_SIGNUP_DOC_TYPES = new Set(
  Object.values(PARTNER_DOC_SLOTS)
    .flat()
    .filter((s) => !s.atSignup)
    .map((s) => s.key),
);

type DocStatusLabel = "pending" | "approved" | "rejected";
function docStatusLabel(code: number): DocStatusLabel {
  if (code === DocumentStatus.APPROVED) return "approved";
  if (code === DocumentStatus.REJECTED) return "rejected";
  return "pending";
}

// Phones are stored as a single string with country code prefixed in signup.
// Country codes vary in length, so we use a best-effort split: assume the last
// 10 digits are the local number when the string starts with "+".
function splitPhone(raw: string): { countryCode: string; number: string } {
  if (raw.startsWith("+") && raw.length > 10) {
    return {
      countryCode: raw.slice(0, raw.length - 10),
      number: raw.slice(raw.length - 10),
    };
  }
  return { countryCode: "", number: raw };
}

export const accountRouter = createTRPCRouter({
  get: protectedPartnerProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.cpPartner.id },
      include: {
        organization: true,
        // Current documents only; a file an admin replaced isn't listed.
        document: { where: { is_most_recent: 1 } },
      },
    });
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
    }

    const partnerType = partnerKindOf(user.type);
    // Role-specific document wording exists for owners and independents only.
    const docRole = partnerType === "counsellor" ? undefined : partnerType;

    const phone = splitPhone(user.phone);
    // Only the agency owner edits the GST number (and sees the company PAN it
    // is checked against).
    const canEditGst = partnerType === "agency" && (await isAgencyOwner(user.id));

    const userDocs = user.document.map((d) => ({
      id: d.id,
      slot: d.doc_type,
      label: partnerDocLabel(d.doc_type, docRole),
      fileName: d.file_name,
      fileUrl: resolveStorageUrl(d.file_url),
      status: docStatusLabel(d.status),
      uploadedAt: d.created_at.toISOString(),
    }));

    // The agency's KYC documents (cancelled cheque, company PAN…) are the
    // owner's business, not every counsellor's.
    let orgDocs: typeof userDocs = [];
    if (user.org_id && partnerType === "agency") {
      const docs = await ctx.db.document.findMany({
        where: { org_id: user.org_id, is_most_recent: 1 },
      });
      orgDocs = docs.map((d) => ({
        id: d.id,
        slot: d.doc_type,
        label: partnerDocLabel(d.doc_type, docRole),
        fileName: d.file_name,
        fileUrl: resolveStorageUrl(d.file_url),
        status: docStatusLabel(d.status),
        uploadedAt: d.created_at.toISOString(),
      }));
    }

    // Bank proof (the cancelled cheque) belongs to Bank Details only, so a
    // cheque uploaded at sign-up before it moved there isn't listed here.
    const documents = [...userDocs, ...orgDocs]
      .filter((d) => !NOT_SIGNUP_DOC_TYPES.has(d.slot))
      .sort((a, b) => a.label.localeCompare(b.label));

    // The MOU is the partner owner's business (signed by the agency owner or
    // the independent). Agency counsellors don't get its status at all.
    // (An agency with more than one owner shares the one signed MOU.)
    const mouSignedAt =
      partnerType === "counsellor"
        ? null
        : (user.mou_signed_at ??
          (user.org_id
            ? (
                await ctx.db.user.findFirst({
                  where: { org_id: user.org_id, is_owner: 1, mou_signed_at: { not: null } },
                  select: { mou_signed_at: true },
                })
              )?.mou_signed_at
            : null) ??
          null);

    return {
      partnerType,
      profile: {
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        countryCode: phone.countryCode,
        phone: phone.number,
        avatarUrl: resolveStorageUrl(user.avatar_url),
        isEmailVerified: user.is_email_verified === 1,
        isPhoneVerified: user.is_phone_verified === 1,
        roleLabel: PartnerKindLabel[partnerType],
        joinedAt: user.created_at.toISOString(),
      },
      business: user.organization
        ? {
            name: user.organization.name,
            website: user.organization.website,
            address: user.organization.address,
            city: user.organization.city,
            state: user.organization.state,
            country: user.organization.country,
            gstNumber: user.organization.gst_number,
            canEditGst,
            companyPan: canEditGst ? user.organization.pan : null,
          }
        : null,
      mou:
        partnerType === "counsellor"
          ? null
          : { signed: !!mouSignedAt, signedAt: mouSignedAt?.toISOString() ?? null },
      documents,
    };
  }),

  updateProfile: protectedPartnerProcedure
    .input(
      z.object({
        firstName: z.string().trim().min(1, "First name is required").max(50),
        lastName: z.string().trim().min(1, "Last name is required").max(50),
        // null = explicit clear, undefined = leave alone.
        avatarUrl: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.user.update({
        where: { id: ctx.cpPartner.id },
        data: {
          first_name: input.firstName,
          last_name: input.lastName,
          ...(input.avatarUrl !== undefined
            ? { avatar_url: input.avatarUrl }
            : {}),
        },
      });
      return { success: true as const };
    }),

  // The agency owner corrects or replaces the agency's GSTIN (manual entry
  // only; nothing is read from the certificate). Decided with Suraj, 17 Oct
  // 2026: the GST certificate on file was issued for the old number, so it
  // goes back to Pending for Collegepond to re-verify. Every change is an
  // audit row (old → new) and an email to the admin inbox.
  updateGstNumber: agencyOwnerProcedure
    .input(z.object({ gstNumber: z.string().max(30) }))
    .mutation(async ({ ctx, input }) => {
      const to = normalizeGstin(input.gstNumber);
      const err = gstinError(to);
      if (err) throw new TRPCError({ code: "BAD_REQUEST", message: err });

      const org = await ctx.db.organization.findUnique({
        where: { id: ctx.owner.orgId },
        select: { name: true, gst_number: true, pan: true, state: true, country: true },
      });
      if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Agency not found" });
      const from = org.gst_number ? normalizeGstin(org.gst_number) : null;
      if (from === to) return { changed: false as const, warnings: [] as string[], certificateReverify: false };

      const warnings = gstinWarnings(to, org);
      const { certificateId } = await ctx.db.$transaction(async (tx) => {
        await tx.organization.update({
          where: { id: ctx.owner.orgId },
          data: { gst_number: to, gst_registered: 1 },
        });
        const cert = await tx.document.findFirst({
          where: { org_id: ctx.owner.orgId, doc_type: "gst", is_most_recent: 1, student_id: null },
          select: { id: true, status: true },
        });
        if (cert && cert.status !== DocumentStatus.PENDING) {
          await tx.document.update({ where: { id: cert.id }, data: { status: DocumentStatus.PENDING } });
        }
        await tx.audit_log.create({
          data: {
            user_id: ctx.owner.id,
            org_id: ctx.owner.orgId,
            action: "partner.gst_number_changed",
            entity_type: "organization",
            entity_id: ctx.owner.orgId,
            metadata: {
              from,
              to,
              warnings,
              certificateId: cert?.id ?? null,
              certificateStatusBefore: cert ? docStatusLabel(cert.status) : null,
            },
          },
        });
        return { certificateId: cert?.id ?? null };
      });

      // Fire-and-forget: a mail failure must not undo the change.
      if (env.ADMIN_EMAIL) {
        const owner = await ctx.db.user.findUnique({
          where: { id: ctx.owner.id },
          select: { first_name: true, last_name: true },
        });
        void sendEmail(
          env.ADMIN_EMAIL,
          adminGstChangedEmail(
            {
              company: org.name,
              ownerName: owner ? `${owner.first_name} ${owner.last_name}`.trim() : "The agency owner",
              from,
              to,
              warnings,
              certificateReverify: certificateId !== null,
            },
            appUrl(),
          ),
        ).catch((e: unknown) =>
          console.error("[account] GST change email failed:", e instanceof Error ? e.message : e),
        );
      }
      return { changed: true as const, warnings, certificateReverify: certificateId !== null };
    }),

  // The partner's notification preferences, keyed like the toggle screen.
  // No saved row = the default (every channel on). Owner-only settings are
  // returned to agency owners only.
  notificationPrefs: protectedPartnerProcedure.query(async ({ ctx }) => {
    const isOwner = await isAgencyOwner(ctx.cpPartner.id);
    const rows = await ctx.db.notification_preference.findMany({
      where: { user_id: ctx.cpPartner.id },
      select: { notification_type: true, via_email: true, via_in_app: true },
    });
    const prefs: Record<string, NotificationPref> = {};
    for (const r of NOTIFICATION_PREF_ROWS) {
      if (r.ownerOnly && !isOwner) continue;
      const saved = rows.find((x) => x.notification_type === r.code);
      prefs[r.key] = saved
        ? { email: saved.via_email === 1, inApp: saved.via_in_app === 1 }
        : { ...DEFAULT_NOTIFICATION_PREF };
    }
    return prefs;
  }),

  saveNotificationPrefs: protectedPartnerProcedure
    .input(
      z
        .array(z.object({ key: z.string(), email: z.boolean(), inApp: z.boolean().optional() }))
        .max(50),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.cpPartner.id;
      const ownerOnly = input.some(
        (p) => NOTIFICATION_PREF_ROWS.find((r) => r.key === p.key)?.ownerOnly,
      );
      if (ownerOnly && !(await isAgencyOwner(userId))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the agency owner can change this." });
      }
      for (const p of input) {
        const row = NOTIFICATION_PREF_ROWS.find((r) => r.key === p.key);
        if (!row) continue; // retired / unknown keys are ignored
        const data = {
          via_email: p.email ? 1 : 0,
          // Types without an in-app toggle keep the default.
          via_in_app: row.inApp && p.inApp === false ? 0 : 1,
          via_sms: 0,
        };
        await ctx.db.notification_preference.upsert({
          where: { user_id_notification_type: { user_id: userId, notification_type: row.code } },
          create: { user_id: userId, notification_type: row.code, ...data },
          update: data,
        });
      }
      return { success: true as const };
    }),
});
