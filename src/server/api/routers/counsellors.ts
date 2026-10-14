import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  agencyOwnerProcedure,
  createTRPCRouter,
  protectedAdminProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { UserStatus, UserType } from "~/server/db/enums";
import { createNotifications } from "~/server/notify";
import { signSignupProof, verifySignupProof } from "~/server/auth/jwt";
import {
  devPeekEmailOtp,
  devPeekPhoneOtp,
  sendEmailOtp,
  sendPhoneOtp,
  toE164,
  verifyEmailOtp,
  verifyPhoneOtp,
} from "~/server/otp";
import { requireOrgCounsellor } from "~/server/partner-access";
import { notifyStudentsAssigned } from "~/server/student-assignment";
import { findPartnerByContact, splitStoredPhone } from "~/server/partner-contact";
import { countryCodes } from "~/lib/constants/location-data";
import { getExpectedPhoneDigits, isValidEmail, isValidPhone } from "~/lib/utils/validation";
import { env } from "~/env";
import {
  adminCounsellorPendingEmail,
  appUrl,
  counsellorAddedEmail,
  counsellorApprovedEmail,
  counsellorDecisionOwnerEmail,
  sendEmail,
} from "~/server/email";
import { emailPartners, orgOwnerRecipients } from "~/server/email/partners";

// Best-effort email: the counsellor change is already saved, so a mail
// failure is logged (never the address) and never fails the action.
async function trySend(to: string, msg: Parameters<typeof sendEmail>[1], context: string) {
  try {
    await sendEmail(to, msg);
  } catch (e) {
    console.error(`[email] ${context} failed:`, e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Counsellor approvals — agency counsellors (user.type = AGENCY_COUNSELLOR)
// added by partner owners. Admin approves (status → APPROVED, stamping
// approved_by) or rejects (status → REJECTED). The reject reason is captured
// in the audit log (no column for it on user yet).
// ---------------------------------------------------------------------------

// organization.num_counsellors is a declared range bucket (1–5); upper bound
// gives the "X / Y counsellors" cap shown under the partner. Code 5 (25+) =
// no fixed cap.
const CAP_UPPER: Record<number, number | null> = {
  1: 5,
  2: 10,
  3: 15,
  4: 25,
  5: null,
};

// Approve/reject one agency counsellor: flip status, stamp the approver,
// write an audit-log entry, and notify the org owner(s) in-app. Returns false
// if the id isn't an agency counsellor (so batch callers can skip it).
async function decideCounsellor(
  cpUserId: number,
  userId: number,
  approved: boolean,
  reason: string | undefined,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      type: true,
      org_id: true,
      email: true,
      first_name: true,
      last_name: true,
      deleted_at: true,
      organization: { select: { name: true } },
    },
  });
  // Removed by their agency: restore first (restoreRemoved), don't approve.
  if (user?.type !== UserType.AGENCY_COUNSELLOR || user.deleted_at) return false;

  await db.user.update({
    where: { id: user.id },
    data: {
      status: approved ? UserStatus.APPROVED : UserStatus.REJECTED,
      approved_by_collegepond_user_id: approved ? cpUserId : null,
    },
  });
  await db.audit_log.create({
    data: {
      action: approved ? "counsellor.approved" : "counsellor.rejected",
      entity_type: "user",
      entity_id: user.id,
      metadata: { byCpUserId: cpUserId, reason: reason ?? null },
    },
  });

  // Notify the partner (org owner[s]) of the decision — in-app, not email.
  if (user.org_id != null) {
    const owners = await db.user.findMany({
      where: { org_id: user.org_id, is_owner: 1 },
      select: { id: true },
    });
    const name = `${user.first_name} ${user.last_name}`.trim();
    const trimmed = reason?.trim();
    await createNotifications(
      owners.map((o) => o.id),
      approved
        ? {
            type: "counsellor.approved",
            title: `${name} was approved as a counsellor`,
            link: "/partner/counsellors",
            tone: "green",
          }
        : {
            type: "counsellor.rejected",
            title: `${name}'s counsellor request was declined`,
            body: trimmed ? `Reason: ${trimmed}` : null,
            link: "/partner/counsellors",
            tone: "red",
          },
    );

    // Email the owner(s) too, and welcome an approved counsellor.
    const counsellorName = `${user.first_name} ${user.last_name}`.trim();
    await emailPartners(
      await orgOwnerRecipients(user.org_id),
      (r) => counsellorDecisionOwnerEmail(r, { counsellorName, approved, reason }, appUrl()),
      approved ? "counsellor-approved-owner" : "counsellor-declined-owner",
    );
  }
  if (approved) {
    await trySend(
      user.email,
      counsellorApprovedEmail(
        { name: `${user.first_name} ${user.last_name}`.trim(), agency: user.organization?.name ?? "your agency" },
        appUrl(),
      ),
      "counsellor-approved",
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Partner-side helpers (agency owner managing counsellors)
// ---------------------------------------------------------------------------

// Letters (any script), spaces, apostrophes, dots and hyphens.
const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const nameField = z
  .string()
  .trim()
  .min(1, "Required")
  .max(50, "50 characters at most")
  .regex(NAME_RE, "Use letters, spaces, apostrophes or hyphens only");

// Strict contact rules, the same as the form's: a valid email, a known
// country code and the exact digit count for it. `contactInput(extra)` builds
// a procedure input from these plus `extra`.
const contactFields = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(255)
    .refine(isValidEmail, "Enter a valid email address"),
  countryCode: z
    .string()
    .trim()
    .refine((c) => countryCodes.some((k) => k.value === c), "Choose a country code"),
  phone: z.string().trim(),
});

function contactInput<T extends z.ZodRawShape>(extra: T) {
  return contactFields.extend(extra).superRefine((input, ctx) => {
    const v = input as z.infer<typeof contactFields>;
    if (!/^[0-9 ]+$/.test(v.phone) || !isValidPhone(v.phone, v.countryCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: `Enter a ${getExpectedPhoneDigits(v.countryCode)}-digit mobile number`,
      });
    }
  });
}

const lifecycleInput = z.object({
  counsellorId: z.number().int().positive(),
  // Where their students go: another active counsellor, or null = the owner.
  reassignTo: z.number().int().positive().nullable(),
});

// Stored like signup does: country code + digits ("+919876543210").
function storedPhone(countryCode: string, phone: string): string {
  return `${countryCode}${phone.replace(/\D/g, "")}`;
}

async function assertContactFree(
  email: string,
  countryCode: string,
  phone: string,
  excludeUserId?: number,
) {
  const hit = await findPartnerByContact(email, countryCode, phone, excludeUserId);
  if (hit) {
    // Deliberately doesn't say which agency: that would leak another
    // partner's team to whoever types the address in.
    throw new TRPCError({
      code: "CONFLICT",
      message:
        hit.matchedOn === "email"
          ? "This email is already registered on Collegepond. Each person can have only one account."
          : "This phone number is already registered on Collegepond. Each person can have only one account.",
    });
  }
}

// Each provided proof must be a counsellor-verification proof for exactly this
// email / number. `undefined` = that channel didn't change, nothing to check.
async function assertProofs(
  contact: { email: string; countryCode: string; phone: string },
  proofs: { email?: string; phone?: string },
) {
  const [emailOk, phoneOk] = await Promise.all([
    proofs.email === undefined ||
      verifySignupProof(proofs.email, "email", contact.email, "counsellor"),
    proofs.phone === undefined ||
      verifySignupProof(proofs.phone, "phone", toE164(contact.phone, contact.countryCode), "counsellor"),
  ]);
  if (!emailOk || !phoneOk) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Please verify the counsellor's ${!emailOk ? "email" : "phone number"} first (the code may have expired).`,
    });
  }
}

function rethrowEmailTaken(e: unknown): never {
  // email is UNIQUE: lost a race with a simultaneous signup or add.
  if ((e as { code?: string } | null)?.code === "P2002") {
    throw new TRPCError({ code: "CONFLICT", message: "This email is already registered on Collegepond." });
  }
  throw e;
}

// Takes a counsellor off duty (deactivate / remove) and hands their students
// to `reassignTo` (an active counsellor of the same org) or, when null, back
// to the owner (stored as the owner's id: "You", not "Unassigned"). One
// transaction: nobody is left holding students they can no longer see.
// Returns how many students moved.
async function releaseCounsellor(
  owner: { id: number; orgId: number },
  counsellorId: number,
  reassignTo: number | null,
  data: { status: number; deleted_at?: Date },
): Promise<number> {
  const orgId = owner.orgId;
  if (reassignTo === counsellorId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Choose someone else to take over their students." });
  }
  const taker =
    reassignTo === null ? null : await requireOrgCounsellor(orgId, reassignTo, { assignable: true });
  const moving = await db.student.findMany({
    where: { org_id: orgId, counsellor_id: counsellorId },
    select: { id: true },
  });
  const ids = moving.map((m) => m.id);
  const [moved] = await db.$transaction([
    db.student.updateMany({
      where: { id: { in: ids }, org_id: orgId, counsellor_id: counsellorId },
      data: { counsellor_id: taker?.id ?? owner.id },
    }),
    db.user.update({ where: { id: counsellorId }, data }),
  ]);
  if (taker && moved.count > 0) {
    void notifyStudentsAssigned({ ownerId: owner.id, counsellor: taker, studentIds: ids });
  }
  return moved.count;
}

async function logLifecycle(
  action: string,
  ownerId: number,
  counsellorId: number,
  reassignTo: number | null,
  movedStudents: number,
) {
  await db.audit_log.create({
    data: {
      action,
      entity_type: "user",
      entity_id: counsellorId,
      metadata: { byPartnerUserId: ownerId, reassignTo, movedStudents },
    },
  });
}

export const counsellorsRouter = createTRPCRouter({
  list: protectedAdminProcedure.query(async () => {
    const rows = await db.user.findMany({
      where: { type: UserType.AGENCY_COUNSELLOR },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        status: true,
        is_email_verified: true,
        is_phone_verified: true,
        created_at: true,
        org_id: true,
        approved_by_collegepond_user_id: true,
        deleted_at: true,
        organization: { select: { name: true, num_counsellors: true } },
      },
    });

    const approverIds = [
      ...new Set(
        rows
          .map((r) => r.approved_by_collegepond_user_id)
          .filter((v): v is number => v !== null),
      ),
    ];
    const approvers = approverIds.length
      ? await db.collegepond_user.findMany({
          where: { id: { in: approverIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : [];
    const approverName = new Map(
      approvers.map((a) => [a.id, `${a.first_name} ${a.last_name}`.trim()]),
    );

    return rows.map((r) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`.trim(),
      email: r.email,
      phone: r.phone,
      status: r.status,
      orgId: r.org_id,
      partner: r.organization?.name ?? "—",
      partnerCap:
        r.organization?.num_counsellors != null
          ? (CAP_UPPER[r.organization.num_counsellors] ?? null)
          : null,
      emailVerified: r.is_email_verified === 1,
      phoneVerified: r.is_phone_verified === 1,
      createdAt: r.created_at,
      // Soft-deleted by their agency (they left); restorable below.
      removedAt: r.deleted_at,
      decidedBy:
        r.approved_by_collegepond_user_id !== null
          ? (approverName.get(r.approved_by_collegepond_user_id) ?? null)
          : null,
    }));
  }),

  setStatus: protectedAdminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        status: z.enum(["approved", "rejected"]),
        reason: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ok = await decideCounsellor(
        ctx.cpUser.id,
        input.userId,
        input.status === "approved",
        input.reason,
      );
      if (!ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Counsellor not found",
        });
      }
      return { success: true as const };
    }),

  // Approve several pending counsellors at once (the list's "Approve Selected"
  // action). Non-counsellor ids are silently skipped; returns the count applied.
  batchApprove: protectedAdminProcedure
    .input(
      z.object({
        userIds: z.array(z.number().int().positive()).min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Dedupe to avoid double-processing if the client sends repeats.
      const ids = [...new Set(input.userIds)];
      let approved = 0;
      for (const id of ids) {
        if (await decideCounsellor(ctx.cpUser.id, id, true, undefined)) {
          approved += 1;
        }
      }
      return { approved };
    }),

  // Undo an agency's soft delete of a counsellor. They come back deactivated:
  // the owner (or an approval here) decides when they work again.
  restoreRemoved: protectedAdminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findFirst({
        where: { id: input.userId, type: UserType.AGENCY_COUNSELLOR, deleted_at: { not: null } },
        select: { id: true },
      });
      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Removed counsellor not found" });
      }
      await db.user.update({
        where: { id: user.id },
        data: { deleted_at: null, status: UserStatus.INACTIVE },
      });
      await db.audit_log.create({
        data: {
          action: "counsellor.restored",
          entity_type: "user",
          entity_id: user.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { success: true as const };
    }),

  // ===== Partner side: the agency owner manages their own counsellors =====
  // Every procedure below is agencyOwnerProcedure and scopes by ctx.owner.orgId,
  // so an owner can only ever see or change their own agency's counsellors.
  // New counsellors are created Pending and approved on Counselor Approvals.
  myCounsellors: agencyOwnerProcedure.query(async ({ ctx }) => {
    const rows = await db.user.findMany({
      where: { type: UserType.AGENCY_COUNSELLOR, org_id: ctx.owner.orgId, deleted_at: null },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        status: true,
        is_email_verified: true,
        is_phone_verified: true,
        created_at: true,
      },
    });
    const counts = await db.student.groupBy({
      by: ["counsellor_id"],
      where: { org_id: ctx.owner.orgId, counsellor_id: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const studentCount = new Map(counts.map((c) => [c.counsellor_id, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      name: `${r.first_name} ${r.last_name}`.trim(),
      email: r.email,
      phone: r.phone,
      // For the edit form's country-code picker + number field.
      phoneParts: splitStoredPhone(r.phone),
      status: r.status,
      verified: r.is_email_verified === 1 && r.is_phone_verified === 1,
      studentCount: studentCount.get(r.id) ?? 0,
      createdAt: r.created_at,
    }));
  }),

  // Step 1 of adding (or changing the contact of) a counsellor: send codes to
  // the email and/or phone being entered. The counsellor reads them out.
  sendContactOtp: agencyOwnerProcedure
    .input(
      contactInput({
        channels: z.array(z.enum(["email", "phone"])).min(1).max(2),
        // Set when editing: that counsellor's own email/phone isn't a duplicate.
        counsellorId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.counsellorId) await requireOrgCounsellor(ctx.owner.orgId, input.counsellorId);
      await assertContactFree(input.email, input.countryCode, input.phone, input.counsellorId);

      const channels = [...new Set(input.channels)];
      const phoneE164 = toE164(input.phone, input.countryCode);
      const results = await Promise.allSettled(
        channels.map((c) =>
          c === "email" ? sendEmailOtp(input.email, "counsellor_verify") : sendPhoneOtp(phoneE164),
        ),
      );
      const sent = { email: false, phone: false };
      let error: string | null = null;
      results.forEach((r, i) => {
        const ch = channels[i]!;
        if (r.status === "fulfilled") {
          sent[ch] = true;
          return;
        }
        // Reason only, never the address, number or code.
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error(`[otp] counsellor ${ch} send failed: ${reason}`);
        error ??= reason.includes("wait")
          ? reason
          : `Couldn't send the ${ch === "email" ? "email" : "SMS"} code. Please try again.`;
      });
      if (!sent.email && !sent.phone) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error ?? "Failed to send codes" });
      }
      return {
        sent,
        error,
        // Dev autopilot only; always null outside `next dev` with sandbox OTP.
        devOtp: {
          email: sent.email ? devPeekEmailOtp(input.email) : null,
          phone: sent.phone ? devPeekPhoneOtp(phoneE164) : null,
        },
      };
    }),

  // Step 2: check one code. Returns a short-lived proof bound to that exact
  // email or number, which addCounsellor / updateCounsellor require.
  verifyContactOtp: agencyOwnerProcedure
    .input(
      contactInput({
        channel: z.enum(["email", "phone"]),
        otp: z.string().trim().length(5),
      }),
    )
    .mutation(async ({ input }) => {
      const subject =
        input.channel === "email" ? input.email : toE164(input.phone, input.countryCode);
      const ok =
        input.channel === "email"
          ? await verifyEmailOtp(subject, input.otp)
          : await verifyPhoneOtp(subject, input.otp);
      if (!ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired code" });
      }
      return { proof: await signSignupProof(input.channel, subject, "counsellor") };
    }),

  addCounsellor: agencyOwnerProcedure
    .input(
      contactInput({
        firstName: nameField,
        lastName: nameField,
        proofs: z.object({ email: z.string().min(1), phone: z.string().min(1) }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProofs(input, input.proofs);
      await assertContactFree(input.email, input.countryCode, input.phone);

      const me = await db.user.findUniqueOrThrow({
        where: { id: ctx.owner.id },
        select: {
          first_name: true,
          last_name: true,
          organization: { select: { name: true, city: true, state: true, country: true } },
        },
      });
      const org = me.organization;
      const phone = storedPhone(input.countryCode, input.phone);
      const created = await db.user
        .create({
          data: {
            first_name: input.firstName,
            last_name: input.lastName,
            email: input.email,
            phone,
            type: UserType.AGENCY_COUNSELLOR,
            status: UserStatus.UNDER_REVIEW,
            org_id: ctx.owner.orgId,
            // Verified just now, by the codes sent to them.
            is_email_verified: 1,
            is_phone_verified: 1,
            // Required NOT NULL profile fields — placeholdered from the org; the
            // counsellor completes their own profile after first login.
            address: "-",
            city: org?.city ?? "-",
            state: org?.state ?? "-",
            country: org?.country ?? "IN",
          },
          select: { id: true },
        })
        .catch(rethrowEmailTaken);
      await db.audit_log.create({
        data: {
          action: "counsellor.invited",
          entity_type: "user",
          entity_id: created.id,
          metadata: { byPartnerUserId: ctx.owner.id, orgId: ctx.owner.orgId, contactVerified: true },
        },
      });
      // Tell the new counsellor (they can sign in once approved) and the
      // Collegepond admin inbox (someone has to approve them).
      const agency = org?.name ?? "your agency";
      const counsellorName = `${input.firstName} ${input.lastName}`.trim();
      await trySend(
        input.email,
        counsellorAddedEmail(
          { name: counsellorName, agency, addedBy: `${me.first_name} ${me.last_name}`.trim() },
          appUrl(),
        ),
        "counsellor-added",
      );
      if (env.ADMIN_EMAIL) {
        await trySend(
          env.ADMIN_EMAIL,
          adminCounsellorPendingEmail({ name: counsellorName, email: input.email, phone, agency }, appUrl()),
          "counsellor-pending-admin",
        );
      }
      return { id: created.id };
    }),

  // Edit a counsellor's name and contact details. A changed email or phone
  // must be re-verified (a proof for the new value), same as when adding.
  updateCounsellor: agencyOwnerProcedure
    .input(
      contactInput({
        counsellorId: z.number().int().positive(),
        firstName: nameField,
        lastName: nameField,
        proofs: z.object({ email: z.string().optional(), phone: z.string().optional() }).default({}),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = await requireOrgCounsellor(ctx.owner.orgId, input.counsellorId);
      const phone = storedPhone(input.countryCode, input.phone);
      const emailChanged = c.email.toLowerCase() !== input.email;
      const phoneChanged = c.phone.replace(/\D/g, "") !== phone.replace(/\D/g, "");
      await assertProofs(input, {
        email: emailChanged ? (input.proofs.email ?? "") : undefined,
        phone: phoneChanged ? (input.proofs.phone ?? "") : undefined,
      });
      if (emailChanged || phoneChanged) {
        await assertContactFree(input.email, input.countryCode, input.phone, c.id);
      }
      await db.user
        .update({
          where: { id: c.id },
          data: {
            first_name: input.firstName,
            last_name: input.lastName,
            ...(emailChanged ? { email: input.email, is_email_verified: 1 } : {}),
            ...(phoneChanged ? { phone, is_phone_verified: 1 } : {}),
          },
        })
        .catch(rethrowEmailTaken);
      const nameChanged = c.first_name !== input.firstName || c.last_name !== input.lastName;
      await db.audit_log.create({
        data: {
          action: "counsellor.updated",
          entity_type: "user",
          entity_id: c.id,
          metadata: {
            byPartnerUserId: ctx.owner.id,
            // Which fields, never the old or new values.
            changed: [
              ...(nameChanged ? ["name"] : []),
              ...(emailChanged ? ["email"] : []),
              ...(phoneChanged ? ["phone"] : []),
            ],
          },
        },
      });
      return { success: true as const };
    }),

  // A counsellor who left or is on leave: they can't sign in, and their
  // students move to `reassignTo` (another active counsellor) or, when null,
  // back to the owner. Reversible with reactivateCounsellor.
  deactivateCounsellor: agencyOwnerProcedure
    .input(lifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const c = await requireOrgCounsellor(ctx.owner.orgId, input.counsellorId);
      if (c.status === UserStatus.INACTIVE) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This counsellor is already deactivated." });
      }
      const moved = await releaseCounsellor(ctx.owner, c.id, input.reassignTo, {
        status: UserStatus.INACTIVE,
      });
      await logLifecycle("counsellor.deactivated", ctx.owner.id, c.id, input.reassignTo, moved);
      return { movedStudents: moved };
    }),

  reactivateCounsellor: agencyOwnerProcedure
    .input(z.object({ counsellorId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const c = await requireOrgCounsellor(ctx.owner.orgId, input.counsellorId);
      if (c.status !== UserStatus.INACTIVE) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only a deactivated counsellor can be reactivated." });
      }
      // Back to where they were: active if Collegepond had approved them,
      // otherwise still awaiting approval.
      const status =
        c.approved_by_collegepond_user_id !== null ? UserStatus.APPROVED : UserStatus.UNDER_REVIEW;
      await db.user.update({ where: { id: c.id }, data: { status } });
      await logLifecycle("counsellor.reactivated", ctx.owner.id, c.id, null, 0);
      return { status };
    }),

  // Soft delete: as deactivation, and the counsellor disappears from the
  // agency's team list. The row (and so its email and phone) is kept, and
  // Collegepond can restore it from Counselor Approvals.
  removeCounsellor: agencyOwnerProcedure
    .input(lifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const c = await requireOrgCounsellor(ctx.owner.orgId, input.counsellorId);
      const moved = await releaseCounsellor(ctx.owner, c.id, input.reassignTo, {
        status: UserStatus.INACTIVE,
        deleted_at: new Date(),
      });
      await logLifecycle("counsellor.removed", ctx.owner.id, c.id, input.reassignTo, moved);
      return { movedStudents: moved };
    }),
});
