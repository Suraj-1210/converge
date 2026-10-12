import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { UserStatus, UserType } from "~/server/db/enums";
import { createNotifications } from "~/server/notify";
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
      organization: { select: { name: true } },
    },
  });
  if (user?.type !== UserType.AGENCY_COUNSELLOR) return false;

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

  // ===== Partner side: agency owner adds + lists their own counsellors =====
  // Minimal flow (no RBAC): owner adds a counsellor → created Pending →
  // appears on the admin Counselor Approvals page. Role is implicitly
  // "Counsellor"; Team Lead and per-counsellor scoping are deferred.
  myCounsellors: protectedPartnerProcedure.query(async ({ ctx }) => {
    const me = await db.user.findUnique({
      where: { id: ctx.cpPartner.id },
      select: { org_id: true },
    });
    if (!me?.org_id) return [];
    const rows = await db.user.findMany({
      where: { type: UserType.AGENCY_COUNSELLOR, org_id: me.org_id },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        status: true,
        created_at: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`.trim(),
      email: r.email,
      phone: r.phone,
      status: r.status,
      createdAt: r.created_at,
    }));
  }),

  addCounsellor: protectedPartnerProcedure
    .input(
      z.object({
        firstName: z.string().trim().min(1).max(50),
        lastName: z.string().trim().min(1).max(50),
        email: z.string().trim().email().max(255),
        phone: z.string().trim().min(5).max(45),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const me = await db.user.findUnique({
        where: { id: ctx.cpPartner.id },
        select: { org_id: true, first_name: true, last_name: true, organization: { select: { name: true } } },
      });
      if (!me?.org_id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only agency accounts can add counsellors.",
        });
      }
      const email = input.email.toLowerCase();
      const existing = await db.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Someone with this email already exists.",
        });
      }
      const org = await db.organization.findUnique({
        where: { id: me.org_id },
        select: { city: true, state: true, country: true },
      });
      const created = await db.user.create({
        data: {
          first_name: input.firstName,
          last_name: input.lastName,
          email,
          phone: input.phone,
          type: UserType.AGENCY_COUNSELLOR,
          status: UserStatus.UNDER_REVIEW,
          org_id: me.org_id,
          // Required NOT NULL profile fields — placeholdered from the org; the
          // counsellor completes their own profile after first login.
          address: "-",
          city: org?.city ?? "-",
          state: org?.state ?? "-",
          country: org?.country ?? "IN",
        },
        select: { id: true },
      });
      await db.audit_log.create({
        data: {
          action: "counsellor.invited",
          entity_type: "user",
          entity_id: created.id,
          metadata: { byPartnerUserId: ctx.cpPartner.id, orgId: me.org_id },
        },
      });
      // Tell the new counsellor (they can sign in once approved) and the
      // Collegepond admin inbox (someone has to approve them).
      const agency = me.organization?.name ?? "your agency";
      const counsellorName = `${input.firstName} ${input.lastName}`.trim();
      await trySend(
        email,
        counsellorAddedEmail(
          { name: counsellorName, agency, addedBy: `${me.first_name} ${me.last_name}`.trim() },
          appUrl(),
        ),
        "counsellor-added",
      );
      if (env.ADMIN_EMAIL) {
        await trySend(
          env.ADMIN_EMAIL,
          adminCounsellorPendingEmail({ name: counsellorName, email, phone: input.phone, agency }, appUrl()),
          "counsellor-pending-admin",
        );
      }
      return { id: created.id };
    }),
});
