import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { DocumentStatus, PartnerKindLabel, partnerKindOf } from "~/server/db/enums";
import { resolveStorageUrl } from "~/server/storage";

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

    const partnerType = partnerKindOf(user.type);

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

    // The agency's KYC documents (cancelled cheque, company PAN...) are the
    // owner's business, not every counsellor's.
    let orgDocs: typeof userDocs = [];
    if (user.org_id && partnerType === "agency") {
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
      mou: {
        signed: !!user.mou_signed_at,
        signedAt: user.mou_signed_at?.toISOString() ?? null,
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
});
