import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  AdminRole,
  DocumentStatus,
  INACTIVE_REASON_CODES,
  InactiveReason,
  InactiveReasonLabel,
  PartnerReportStatus,
  UniApplicationStatus,
  UniApplicationStatusLabel,
  partnerReportOption,
} from "~/server/db/enums";
import { notifyPartnerReportRejected, transitionApplication } from "~/server/application-transitions";
import { deferApplication, intakeLabel } from "~/server/application-deferral";
import { notifyApplicationDocRejected } from "~/server/application-docs";
import { APPLICATION_UPLOAD_KINDS } from "~/lib/application-uploads";
import { isClosedStage } from "~/lib/application-stages";
import { partnerScope } from "~/server/partner-access";
import { parsePendingDocs, savePendingDocs } from "~/server/pending-docs";
import { notifyColleagueAction, notifyColleagueApplicationAction } from "~/server/counsellor-notify";
import {
  isCounsellingRole,
  requireStaffApplication,
  requireStaffStudent,
  staffApplicationScope,
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

const deferredSelect = {
  id: true,
  status: true,
  student_id: true,
  deferred_intake_month: true,
  deferred_intake_year: true,
  deferred_from_intake: true,
  deferred_at: true,
  student: { select: { first_name: true, last_name: true } },
  course: { select: { name: true, university: { select: { name: true } } } },
} as const;

type DeferredRow = {
  id: number;
  status: number;
  student_id: number;
  deferred_intake_month: number | null;
  deferred_intake_year: number | null;
  deferred_from_intake: string | null;
  deferred_at: Date | null;
  student: { first_name: string; last_name: string };
  course: { name: string; university: { name: string } };
};

// Listed until it enrols or closes.
const isOpenDeferral = (r: DeferredRow) =>
  !isClosedStage(r.status) && r.status !== UniApplicationStatus.ENROLLED;

function toDeferredRow(r: DeferredRow) {
  return {
    applicationId: r.id,
    studentId: r.student_id,
    studentName: `${r.student.first_name} ${r.student.last_name}`.trim(),
    university: r.course.university.name,
    program: r.course.name,
    stage: (UniApplicationStatusLabel as Record<number, string | undefined>)[r.status] ?? "—",
    newIntake:
      r.deferred_intake_month && r.deferred_intake_year
        ? intakeLabel(r.deferred_intake_month, r.deferred_intake_year)
        : "—",
    fromIntake: r.deferred_from_intake,
    deferredAt: r.deferred_at?.toISOString() ?? null,
  };
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
      deferred_intake_month: true,
      deferred_intake_year: true,
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
      void notifyColleagueApplicationAction(
        input.applicationId,
        ctx.cpUser.id,
        `${input.received ? "Ticked off" : "Un-ticked"} “${item.label}”`,
      );
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
      const partnerReport = { id: r.id, partnerUserId: r.reported_by_user_id };
      if (r.target_status === UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE) {
        // A reported deferral keeps the application open at the new intake.
        if (!r.deferred_intake_month || !r.deferred_intake_year) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This report names no new intake. Reject it, or defer the application directly.",
          });
        }
        await deferApplication({
          cpUserId: ctx.cpUser.id,
          applicationId: r.application_id,
          month: r.deferred_intake_month,
          year: r.deferred_intake_year,
          note: input.note ?? "Confirmed partner report",
          partnerReport,
        });
      } else {
        await transitionApplication({
          actor: { cpUserId: ctx.cpUser.id, partnerReport },
          applicationId: r.application_id,
          targetStatus: r.target_status,
          reason: input.note ?? "Confirmed partner report",
        });
      }
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
      const reported =
        r.target_status === UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE
          ? r.deferred_intake_month && r.deferred_intake_year
            ? `Deferred to ${intakeLabel(r.deferred_intake_month, r.deferred_intake_year)}`
            : "Deferral"
          : (option?.label ?? "Update");
      void notifyPartnerReportRejected(r.application_id, reported, input.reason);
      return { ok: true };
    }),

  // Defer to a later intake: the application stays open (see
  // src/server/application-deferral.ts). Re-deferring changes the intake.
  deferApplication: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
        note: z.string().trim().max(255).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      return deferApplication({
        cpUserId: ctx.cpUser.id,
        applicationId: input.applicationId,
        month: input.month,
        year: input.year,
        note: input.note,
      });
    }),

  // Verify or reject a document a partner uploaded for an application
  // (deposit slip, visa documents, visa approved copy). A rejection goes back
  // to the partner with the reason so they can upload it again.
  reviewApplicationDocument: protectedAdminProcedure
    .input(
      z
        .object({
          documentId: z.number().int().positive(),
          approve: z.boolean(),
          note: z.string().trim().max(255).nullish(),
        })
        .refine((v) => v.approve || !!v.note, { message: "Give the partner a reason", path: ["note"] }),
    )
    .mutation(async ({ ctx, input }) => {
      const doc = await db.document.findUnique({
        where: { id: input.documentId },
        select: { id: true, application_id: true, doc_type: true, file_name: true },
      });
      if (!doc?.application_id) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
      await requireStaffApplication(ctx.cpUser, doc.application_id);
      await db.document.update({
        where: { id: doc.id },
        data: {
          status: input.approve ? DocumentStatus.APPROVED : DocumentStatus.REJECTED,
          review_note: input.approve ? null : (input.note ?? null),
          reviewed_at: new Date(),
          reviewed_by_cp_user_id: ctx.cpUser.id,
        },
      });
      await db.audit_log.create({
        data: {
          action: input.approve ? "application.document_verified" : "application.document_rejected",
          entity_type: "application",
          entity_id: doc.application_id,
          metadata: {
            documentId: doc.id,
            docType: doc.doc_type,
            fileName: doc.file_name,
            ...(input.approve ? {} : { reason: input.note }),
            byCpUserId: ctx.cpUser.id,
          },
        },
      });
      if (!input.approve) {
        const label = APPLICATION_UPLOAD_KINDS.find((k) => k.docType === doc.doc_type)?.label ?? "Document";
        void notifyApplicationDocRejected(doc.application_id, label, input.note ?? "");
      }
      return { ok: true };
    }),

  // Deferred applications still open, for the Students page, within the
  // staff member's own students.
  deferredList: protectedAdminProcedure.query(async ({ ctx }) => {
    const scope = await staffApplicationScope(ctx.cpUser);
    const rows = await db.application.findMany({
      where: { AND: [scope, { deferred_at: { not: null } }] },
      orderBy: [{ deferred_intake_year: "asc" }, { deferred_intake_month: "asc" }],
      take: 200,
      select: deferredSelect,
    });
    return rows.filter(isOpenDeferral).map(toDeferredRow);
  }),

  partnerDeferredList: protectedPartnerProcedure.query(async ({ ctx }) => {
    const { where } = await partnerScope(ctx.cpPartner.id);
    const rows = await db.application.findMany({
      where: { deferred_at: { not: null }, student: where },
      orderBy: [{ deferred_intake_year: "asc" }, { deferred_intake_month: "asc" }],
      take: 200,
      select: deferredSelect,
    });
    return rows.filter(isOpenDeferral).map(toDeferredRow);
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
      void notifyColleagueAction(
        input.studentId,
        ctx.cpUser.id,
        `Marked inactive: ${InactiveReasonLabel[input.reason]}${input.note ? ` (${input.note})` : ""}`,
      );
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
      void notifyColleagueAction(input.studentId, ctx.cpUser.id, "Reactivated the student");
      return { ok: true };
    }),
});
