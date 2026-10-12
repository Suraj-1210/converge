import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { DocumentStatus, UserType } from "~/server/db/enums";
import { resolveStorageUrl } from "~/server/storage";
import {
  DEFAULT_NOTIFICATION_PREF,
  NOTIFICATION_PREF_ROWS,
} from "~/lib/constants/notification-prefs";

// Slot key (as stored in document.doc_type) → human label for the docs tab.
const DOC_TYPE_LABELS: Record<string, string> = {
  companyPan: "Company PAN Card",
  pan: "PAN Card",
  aadhaar: "Aadhaar Card",
  cancelledCheque: "Cancelled Cheque",
  partnershipDocs: "Partnership Document",
  logo: "Company Logo",
  gst: "GST Certificate",
  profilePhoto: "Profile Photo",
};

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
        document: true,
      },
    });
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
    }

    const partnerType: "agency" | "independent" =
      user.type === UserType.AGENCY_OWNER ? "agency" : "independent";

    const phone = splitPhone(user.phone);

    const userDocs = user.document.map((d) => ({
      id: d.id,
      slot: d.doc_type,
      label: DOC_TYPE_LABELS[d.doc_type] ?? d.doc_type,
      fileName: d.file_name,
      fileUrl: resolveStorageUrl(d.file_url),
      status: docStatusLabel(d.status),
      uploadedAt: d.created_at.toISOString(),
    }));

    let orgDocs: typeof userDocs = [];
    if (user.org_id) {
      const docs = await ctx.db.document.findMany({
        where: { org_id: user.org_id },
      });
      orgDocs = docs.map((d) => ({
        id: d.id,
        slot: d.doc_type,
        label: DOC_TYPE_LABELS[d.doc_type] ?? d.doc_type,
        fileName: d.file_name,
        fileUrl: resolveStorageUrl(d.file_url),
        status: docStatusLabel(d.status),
        uploadedAt: d.created_at.toISOString(),
      }));
    }

    const documents = [...userDocs, ...orgDocs].sort((a, b) =>
      a.label.localeCompare(b.label),
    );

    // An agency's MOU is signed by its owner; counsellors see that one.
    const mouSignedAt =
      user.mou_signed_at ??
      (user.org_id
        ? (
            await ctx.db.user.findFirst({
              where: { org_id: user.org_id, is_owner: 1, mou_signed_at: { not: null } },
              select: { mou_signed_at: true },
            })
          )?.mou_signed_at
        : null) ??
      null;

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
        roleLabel:
          partnerType === "agency" ? "Agency Owner" : "Independent Counsellor",
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
      mou: {
        signed: !!mouSignedAt,
        signedAt: mouSignedAt?.toISOString() ?? null,
      },
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
  // No saved row = the default (email on). Email is the only channel.
  notificationPrefs: protectedPartnerProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.notification_preference.findMany({
      where: { user_id: ctx.cpPartner.id },
      select: { notification_type: true, via_email: true, via_sms: true },
    });
    const prefs: Record<string, { email: boolean }> = {};
    for (const r of NOTIFICATION_PREF_ROWS) {
      const saved = rows.find((x) => x.notification_type === r.code);
      prefs[r.key] = saved
        ? { email: saved.via_email === 1 }
        : { ...DEFAULT_NOTIFICATION_PREF };
    }
    return prefs;
  }),

  saveNotificationPrefs: protectedPartnerProcedure
    .input(
      z
        .array(z.object({ key: z.string(), email: z.boolean() }))
        .max(50),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.cpPartner.id;
      for (const p of input) {
        const row = NOTIFICATION_PREF_ROWS.find((r) => r.key === p.key);
        if (!row) continue; // retired / unknown keys are ignored
        const data = { via_email: p.email ? 1 : 0, via_sms: 0 };
        await ctx.db.notification_preference.upsert({
          where: { user_id_notification_type: { user_id: userId, notification_type: row.code } },
          create: { user_id: userId, notification_type: row.code, ...data },
          update: data,
        });
      }
      return { success: true as const };
    }),
});
