import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedPartnerProcedure, superAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { COURSE_LEVEL_CODES, type CourseLevel } from "~/server/db/enums";
import { LoanReferralSendStatus } from "~/lib/loan-sharing";
import {
  activeReferralForStudent,
  createLoanReferral,
  loanSharingConfig,
  referralScopeFor,
  sendLoanReferral,
  sendPartnerMessage,
} from "~/server/loan-sharing";
import { partnerScope, requireVisibleStudent } from "~/server/partner-access";

// Education-loan referrals to Collegepond's loan team (Enrollment App) and
// the progress mirrored back. Partner side = the Loans tab and the loan card
// on a student (gated by the "loans" tab, ~/lib/partner-tabs); admin side =
// Super Admin "Loan Referrals" support page. Logic: ~/server/loan-sharing.

const consent = z.literal(true, {
  errorMap: () => ({ message: "Confirm the student agreed to be contacted by the loan team" }),
});
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined || v === null || v === "" ? null : v));
const loanAmount = z.number().finite().positive().max(1e10).nullish().transform((v) => v ?? null);

const num = (d: { toNumber(): number } | null) => (d === null ? null : d.toNumber());

function toListItem(r: {
  public_id: string;
  student_id: number | null;
  student_name: string;
  send_status: number;
  stage: string | null;
  counsellor_name: string | null;
  next_follow_up_at: Date | null;
  last_update_at: Date | null;
  created_at: Date;
  partner_user: { first_name: string; last_name: string };
  application: { lender: string; status: string }[];
}) {
  return {
    publicId: r.public_id,
    studentId: r.student_id,
    studentName: r.student_name,
    sendStatus: r.send_status,
    stage: r.stage,
    counsellorName: r.counsellor_name,
    nextFollowUpAt: r.next_follow_up_at,
    lastUpdateAt: r.last_update_at,
    referredAt: r.created_at,
    referredBy: `${r.partner_user.first_name} ${r.partner_user.last_name}`.trim(),
    lenders: r.application.map((a) => ({ lender: a.lender, status: a.status })),
  };
}

const listInclude = {
  partner_user: { select: { first_name: true, last_name: true } },
  application: { select: { lender: true, status: true }, orderBy: { id: "asc" as const } },
};

async function auditPartner(userId: number, orgId: number | null, action: string, referralId: number, extra: object) {
  await db.audit_log.create({
    data: {
      org_id: orgId,
      user_id: userId,
      action,
      entity_type: "loan_referral",
      entity_id: referralId,
      metadata: { byUserId: userId, ...extra },
    },
  });
}

export const loansRouter = createTRPCRouter({
  // ── Partner: Loans tab ──────────────────────────────────────────────────────
  partnerList: protectedPartnerProcedure.query(async ({ ctx }) => {
    const { user } = await partnerScope(ctx.cpPartner.id);
    const rows = await db.loan_referral.findMany({
      where: referralScopeFor(user),
      include: listInclude,
      orderBy: { created_at: "desc" },
      take: 500,
    });
    return rows.map(toListItem);
  }),

  partnerGet: protectedPartnerProcedure
    .input(z.object({ publicId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { user } = await partnerScope(ctx.cpPartner.id);
      const r = await db.loan_referral.findFirst({
        where: { AND: [{ public_id: input.publicId }, referralScopeFor(user)] },
        include: {
          ...listInclude,
          application: { orderBy: { id: "asc" } },
          event: { where: { visible: 1 }, orderBy: [{ occurred_at: "desc" }, { id: "desc" }], take: 200 },
          message: {
            include: { file: { orderBy: { id: "asc" } } },
            orderBy: { created_at: "desc" },
            take: 200,
          },
        },
      });
      // Another agency's referral looks exactly like a missing one.
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Loan referral not found" });
      return {
        ...toListItem({ ...r, application: r.application }),
        email: r.email,
        phone: r.phone,
        intake: r.intake,
        university: r.university,
        loanAmount: num(r.loan_amount),
        note: r.note,
        closureReason: r.closure_reason,
        consentAt: r.consent_at,
        applications: r.application.map((a) => ({
          id: a.id,
          lender: a.lender,
          status: a.status,
          loanAmount: num(a.loan_amount),
          sanctionedAmount: num(a.sanctioned_amount),
          roi: num(a.roi),
          disbursedAmount: num(a.disbursed_amount),
          disbursedAt: a.disbursed_at,
        })),
        // The partner's replies (Phase 2); the page merges them into the timeline.
        messages: r.message.map((m) => ({
          publicId: m.public_id,
          authorName: m.author_name,
          mine: m.author_user_id === ctx.cpPartner.id,
          body: m.body,
          sendStatus: m.send_status,
          at: m.created_at,
          files: m.file.map((f) => ({ id: f.id, name: f.file_name, size: f.size })),
        })),
        canMessage: r.send_status === LoanReferralSendStatus.RECEIVED,
        timeline: r.event.map((e) => ({
          id: e.id,
          kind: e.kind,
          title: e.title ?? "",
          body: e.body,
          actorName: e.actor_name,
          at: e.occurred_at,
        })),
      };
    }),

  // The loan card on a student's profile: their latest referral, if any.
  partnerForStudent: protectedPartnerProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      const r = await db.loan_referral.findFirst({
        where: { student_id: input.studentId },
        include: listInclude,
        orderBy: { id: "desc" },
      });
      return r ? toListItem(r) : null;
    }),

  // "Refer for education loan" on a student the partner can see.
  partnerReferStudent: protectedPartnerProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        consent,
        university: optionalText(255),
        loanAmount,
        note: optionalText(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      return referStudent(ctx.cpPartner.id, input);
    }),

  // "Refer a loan lead": a loan-only referral (decision 3, 19 Nov 2026) for
  // someone who isn't applying through Converge.
  partnerReferLead: protectedPartnerProcedure
    .input(
      z.object({
        firstName: z.string().trim().min(1).max(60),
        lastName: z.string().trim().min(1).max(60),
        countryCode: z.string().trim().regex(/^\+\d{1,4}$/, "Country code like +91"),
        phone: z.string().trim().regex(/^[0-9 ]{7,15}$/, "Phone must be 7–15 digits"),
        email: z.string().trim().email().max(255),
        intake: z.string().trim().min(1).max(20),
        country: z.string().trim().length(2).transform((v) => v.toUpperCase()).nullish().transform((v) => v ?? null),
        university: optionalText(255),
        courseLevel: z
          .number()
          .int()
          .refine((v) => COURSE_LEVEL_CODES.includes(v as CourseLevel), { message: "Invalid course level" })
          .nullish()
          .transform((v) => v ?? null),
        loanAmount,
        note: optionalText(1000),
        consent,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { user } = await partnerScope(ctx.cpPartner.id);
      const r = await createLoanReferral({
        partnerUserId: user.id,
        studentId: null,
        name: `${input.firstName} ${input.lastName}`,
        phone: `${input.countryCode} ${input.phone.replace(/\s+/g, " ")}`,
        email: input.email,
        intake: input.intake,
        country: input.country,
        university: input.university,
        courseLevel: input.courseLevel,
        loanAmount: input.loanAmount,
        note: input.note,
      });
      await auditPartner(user.id, user.org_id, "loan_referral.created", r.id, { loanOnly: true });
      return { publicId: r.public_id, sendStatus: r.send_status };
    }),

  // A reply that couldn't be delivered: send it again.
  partnerRetryMessage: protectedPartnerProcedure
    .input(z.object({ publicId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { user } = await partnerScope(ctx.cpPartner.id);
      const m = await db.loan_referral_message.findFirst({
        where: { public_id: input.publicId, referral: referralScopeFor(user) },
        select: { id: true, send_status: true },
      });
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });
      if (m.send_status === LoanReferralSendStatus.RECEIVED) return { sendStatus: m.send_status };
      await db.loan_referral_message.update({
        where: { id: m.id },
        data: { send_status: LoanReferralSendStatus.SENDING, next_attempt_at: null },
      });
      await sendPartnerMessage(m.id);
      const after = await db.loan_referral_message.findUniqueOrThrow({ where: { id: m.id } });
      return { sendStatus: after.send_status };
    }),

  // ── Super Admin: Loan Referrals support page ────────────────────────────────
  adminList: superAdminProcedure
    .input(z.object({ status: z.number().int().min(0).max(3).nullish() }).optional())
    .query(async ({ input }) => {
      const rows = await db.loan_referral.findMany({
        where: input?.status == null ? {} : { send_status: input.status },
        include: {
          partner_user: { select: { first_name: true, last_name: true } },
          organization: { select: { name: true } },
        },
        orderBy: { created_at: "desc" },
        take: 500,
      });
      return {
        config: loanSharingConfig(),
        rows: rows.map((r) => ({
          id: r.id,
          publicId: r.public_id,
          studentName: r.student_name,
          partner: r.organization?.name ?? `${r.partner_user.first_name} ${r.partner_user.last_name}`.trim(),
          referredBy: `${r.partner_user.first_name} ${r.partner_user.last_name}`.trim(),
          loanOnly: r.student_id === null,
          sendStatus: r.send_status,
          attempts: r.send_attempts,
          lastError: r.last_error,
          nextAttemptAt: r.next_attempt_at,
          loanLeadId: r.loan_lead_id,
          stage: r.stage,
          referredAt: r.created_at,
          lastUpdateAt: r.last_update_at,
        })),
      };
    }),

  // Try the hand-over now. A failed one (rejected content) is re-queued too:
  // use after fixing whatever the Enrollment App objected to.
  adminRetry: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const r = await db.loan_referral.findUnique({ where: { id: input.id } });
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Loan referral not found" });
      if (r.send_status !== LoanReferralSendStatus.SENDING && r.send_status !== LoanReferralSendStatus.FAILED) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This referral has already reached the loan team." });
      }
      await db.loan_referral.update({
        where: { id: r.id },
        data: { send_status: LoanReferralSendStatus.SENDING, next_attempt_at: null },
      });
      await sendLoanReferral(r.id);
      await db.audit_log.create({
        data: {
          action: "loan_referral.retried",
          entity_type: "loan_referral",
          entity_id: r.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      const after = await db.loan_referral.findUniqueOrThrow({ where: { id: r.id } });
      return { sendStatus: after.send_status, lastError: after.last_error };
    }),
});

// Shared by the profile button and Add Student (students.partnerCreate).
export async function referStudent(
  partnerUserId: number,
  input: { studentId: number; university: string | null; loanAmount: number | null; note: string | null },
) {
  const active = await activeReferralForStudent(input.studentId);
  if (active) {
    throw new TRPCError({ code: "CONFLICT", message: "This student has already been referred to the loan team." });
  }
  const s = await db.student.findUniqueOrThrow({
    where: { id: input.studentId },
    select: { id: true, first_name: true, last_name: true, phone: true, email: true, intake: true, country: true, course_level: true },
  });
  const r = await createLoanReferral({
    partnerUserId,
    studentId: s.id,
    name: `${s.first_name} ${s.last_name}`,
    phone: s.phone,
    email: s.email,
    intake: s.intake,
    country: s.country,
    university: input.university,
    courseLevel: s.course_level,
    loanAmount: input.loanAmount,
    note: input.note,
  });
  const partner = await db.user.findUnique({ where: { id: partnerUserId }, select: { org_id: true } });
  await auditPartner(partnerUserId, partner?.org_id ?? null, "loan_referral.created", r.id, { studentId: s.id });
  return { publicId: r.public_id, sendStatus: r.send_status };
}
