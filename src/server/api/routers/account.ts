import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
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
