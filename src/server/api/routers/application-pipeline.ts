import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  AdminRole,
  INACTIVE_REASON_CODES,
  InactiveReason,
  InactiveReasonLabel,
  PartnerReportStatus,
  partnerReportOption,
} from "~/server/db/enums";
import { notifyPartnerReportRejected, transitionApplication } from "~/server/application-transitions";
import { parsePendingDocs, savePendingDocs } from "~/server/pending-docs";
import {
  isCounsellingRole,
  requireStaffApplication,
  requireStaffStudent,
  type StaffUser,
} from "~/server/staff-access";

// Phase 3A pipeline actions on the Collegepond side (17 Oct 2026): ticking
// off Documents Pending items, confirming or rejecting a partner's report
// (Deposit Paid, visa outcome), and the manual Inactive on a student.
// Status changes themselves go through transitionApplication.

// Confirming a partner's report and marking a student Inactive are a
// Collegepond counsellor's call (Counsellor, Counsellor Lead) or a Super
// Admin's, within the counsellor's own students.
function requireCounsellor(user: StaffUser) {
  if (!isCounsellingRole(user.role) && user.role !== AdminRole.SUPER_ADMIN) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only a Collegepond counsellor can do this",
    });
  }
}

async function pendingReport(reportId: number) {
  const r = await db.application_partner_report.findUnique({
    where: { id: reportId },
    select: {
      id: true,
      application_id: true,
      from_status: true,
      target_status: true,
      status: true,
      reported_by_user_id: true,
      application: { select: { status: true } },
    },
  });
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
  if (r.status !== PartnerReportStatus.PENDING) {
    throw new TRPCError({ code: "CONFLICT", message: "This report has already been decided" });
  }
  return r;
}

export const applicationPipelineRouter = createTRPCRouter({
  // A counsellor ticks a Documents Pending item off (or back on) by hand,
  // e.g. a document received by email.
  setPendingDocReceived: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        received: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      const app = await db.application.findUnique({
        where: { id: input.applicationId },
        select: { pending_docs: true },
      });
      const docs = parsePendingDocs(app?.pending_docs);
      const item = docs.find((d) => d.id === input.itemId);
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Document not on the list" });
      item.receivedAt = input.received ? new Date().toISOString() : null;
      await savePendingDocs(input.applicationId, docs);
      await db.audit_log.create({
        data: {
          action: "application.pending_doc_ticked",
          entity_type: "application",
          entity_id: input.applicationId,
          metadata: { item: item.label, received: input.received, byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),

  // Confirming applies the reported status through the shared transition
  // (stage history, student status, partner notification, audit).
  confirmPartnerReport: protectedAdminProcedure
    .input(
      z.object({
        reportId: z.number().int().positive(),
        note: z.string().trim().max(500).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCounsellor(ctx.cpUser);
      const r = await pendingReport(input.reportId);
      await requireStaffApplication(ctx.cpUser, r.application_id);
      if (r.application.status !== r.from_status) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "The application has moved since the partner reported this. Reject the report, or set the stage directly.",
        });
      }
      await transitionApplication({
        actor: {
          cpUserId: ctx.cpUser.id,
          partnerReport: { id: r.id, partnerUserId: r.reported_by_user_id },
        },
        applicationId: r.application_id,
        targetStatus: r.target_status,
        reason: input.note ?? "Confirmed partner report",
      });
      await db.audit_log.create({
        data: {
          action: "application.partner_report_confirmed",
          entity_type: "application",
          entity_id: r.application_id,
          metadata: { reportId: r.id, to: r.target_status, byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),

  rejectPartnerReport: protectedAdminProcedure
    .input(
      z.object({
        reportId: z.number().int().positive(),
        reason: z.string().trim().min(1, "Give the partner a reason").max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCounsellor(ctx.cpUser);
      const r = await pendingReport(input.reportId);
      await requireStaffApplication(ctx.cpUser, r.application_id);
      await db.application_partner_report.update({
        where: { id: r.id },
        data: {
          status: PartnerReportStatus.REJECTED,
          decided_by_cp_user_id: ctx.cpUser.id,
          decided_at: new Date(),
          decision_note: input.reason,
        },
      });
      await db.audit_log.create({
        data: {
          action: "application.partner_report_rejected",
          entity_type: "application",
          entity_id: r.application_id,
          metadata: { reportId: r.id, to: r.target_status, reason: input.reason, byCpUserId: ctx.cpUser.id },
        },
      });
      const option = partnerReportOption(r.from_status, r.target_status);
      void notifyPartnerReportRejected(r.application_id, option?.label ?? "Update", input.reason);
      return { ok: true };
    }),

  // Manual Inactive: wins over the derived overall status until reactivated.
  setStudentInactive: protectedAdminProcedure
    .input(
      z
        .object({
          studentId: z.number().int().positive(),
          reason: z.enum(INACTIVE_REASON_CODES as [InactiveReason, ...InactiveReason[]]),
          note: z.string().trim().max(255).nullish(),
        })
        .refine((v) => v.reason !== InactiveReason.OTHER || !!v.note, {
          message: "Add a note for Other",
          path: ["note"],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCounsellor(ctx.cpUser);
      await requireStaffStudent(ctx.cpUser, input.studentId);
      await db.student.update({
        where: { id: input.studentId },
        data: {
          inactive_at: new Date(),
          inactive_reason: input.reason,
          inactive_note: input.note ?? null,
          inactive_by_cp_user_id: ctx.cpUser.id,
        },
      });
      await db.audit_log.create({
        data: {
          action: "student.marked_inactive",
          entity_type: "student",
          entity_id: input.studentId,
          metadata: {
            reason: InactiveReasonLabel[input.reason],
            note: input.note ?? null,
            byCpUserId: ctx.cpUser.id,
          },
        },
      });
      return { ok: true };
    }),

  reactivateStudent: protectedAdminProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireCounsellor(ctx.cpUser);
      await requireStaffStudent(ctx.cpUser, input.studentId);
      const s = await db.student.findUnique({
        where: { id: input.studentId },
        select: { inactive_at: true, inactive_reason: true },
      });
      if (!s?.inactive_at) return { ok: true };
      await db.student.update({
        where: { id: input.studentId },
        data: { inactive_at: null, inactive_reason: null, inactive_note: null, inactive_by_cp_user_id: null },
      });
      await db.audit_log.create({
        data: {
          action: "student.reactivated",
          entity_type: "student",
          entity_id: input.studentId,
          metadata: { previousReason: s.inactive_reason, byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),
});
