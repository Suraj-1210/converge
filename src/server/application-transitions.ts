import "server-only";
import { TRPCError } from "@trpc/server";
import { db } from "~/server/db";
import {
  APP_TO_STUDENT_STATUS,
  PartnerReportStatus,
  UNI_APP_STATUS_CODES,
  UniApplicationStatus,
  UniApplicationStatusLabel,
} from "~/server/db/enums";
import {
  currentStage,
  furthestOpen,
  stageAtLeast,
  stageIndex,
  stagesAfter,
} from "~/lib/application-stages";
import { appUrl, applicationStatusEmail } from "~/server/email";
import { emailPartners, studentPartnerRecipients } from "~/server/email/partners";
import { createNotifications } from "~/server/notify";
import { notifyStudentCounsellor } from "~/server/counsellor-notify";
import {
  buildPendingDocs,
  parsePendingDocs,
  type PendingDocInput,
} from "~/server/pending-docs";

// THE path for every application status change, admin and partner (a
// partner's report reaches it when a Collegepond counsellor confirms it).
// It maintains stage history, submitted/decided dates, the Documents Pending
// list, the student's mirrored status and pending partner reports, then
// tells the partner and writes the audit log. Don't write
// application.status anywhere else: gates on a transition (e.g. Phase 3B's
// university-assignment approval) belong here.
//
// The caller has already checked the actor may act on the application
// (requireStaffApplication).

export interface TransitionActor {
  cpUserId: number;
  // Set when confirming a partner's report: the report and who made it.
  partnerReport?: { id: number; partnerUserId: number | null };
}

export interface TransitionInput {
  actor: TransitionActor;
  applicationId: number;
  targetStatus: number;
  reason?: string | null;
  // Required when moving to Documents Pending (unless the application
  // already has a list); replaces the list while it is there.
  pendingDocs?: PendingDocInput[] | null;
}

const label = (s: number) =>
  (UniApplicationStatusLabel as Record<number, string | undefined>)[s] ?? "Updated";

const fail = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

// Mirrors the student's pipeline status from their furthest open
// application (by stage position); with none open, from any application.
export async function syncStudentStatusFromApplications(studentId: number) {
  const apps = await db.application.findMany({
    where: { student_id: studentId },
    orderBy: { created_at: "asc" },
    select: { status: true },
  });
  if (apps.length === 0) return;
  const primary = furthestOpen(apps) ?? apps[0]!;
  const mapped = APP_TO_STUDENT_STATUS[primary.status as UniApplicationStatus];
  if (mapped === undefined) return;
  await db.student.update({ where: { id: studentId }, data: { status: mapped } });
}

export async function transitionApplication(input: TransitionInput) {
  const target = input.targetStatus;
  if (!UNI_APP_STATUS_CODES.includes(target as UniApplicationStatus)) {
    throw fail("Invalid application status");
  }
  const app = await db.application.findUnique({
    where: { id: input.applicationId },
    select: {
      id: true,
      status: true,
      student_id: true,
      submitted_at: true,
      decided_at: true,
      pending_docs: true,
      stage_history: { select: { stage: true } },
    },
  });
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

  const stageBefore = currentStage(app.status, app.stage_history);
  const open = stageIndex(target) >= 0;
  const isRevert = open && stageIndex(target) < stageIndex(stageBefore);

  // Documents Pending names the documents. Keep the existing list when the
  // counsellor doesn't send one (e.g. reverting back into the stage).
  const previousDocs = parsePendingDocs(app.pending_docs);
  let pendingDocs = previousDocs;
  if (target === UniApplicationStatus.DOCUMENTS_PENDING) {
    if (input.pendingDocs) {
      try {
        pendingDocs = buildPendingDocs(previousDocs, input.pendingDocs);
      } catch (e) {
        throw fail(e instanceof Error ? e.message : "Invalid document list");
      }
    }
    if (pendingDocs.length === 0) throw fail("Pick at least one pending document");
  }
  const newDocItems = pendingDocs.filter(
    (d) => !d.receivedAt && !previousDocs.some((p) => p.id === d.id),
  );

  const upsertStage = (stage: number, bumpDate: boolean) =>
    db.application_stage_history.upsert({
      where: { application_id_stage: { application_id: app.id, stage } },
      create: { application_id: app.id, stage },
      update: bumpDate ? { occurred_at: new Date() } : {},
    });

  if (open) {
    if (isRevert) {
      // Undo an accidental advance: drop history past the target, keep the
      // target entry's original date.
      await db.application_stage_history.deleteMany({
        where: { application_id: app.id, stage: { in: stagesAfter(target) } },
      });
      await upsertStage(target, false);
    } else {
      // Advance (or re-confirm the current stage / clear a terminal).
      await upsertStage(target, stageIndex(target) > stageIndex(stageBefore));
    }
  } else {
    // Terminal outcome: make sure the stage position survives.
    await upsertStage(stageBefore, false);
  }

  const position = open ? target : stageBefore;
  const offerOrRejection =
    target === UniApplicationStatus.CONDITIONAL_OFFER ||
    target === UniApplicationStatus.UNCONDITIONAL_OFFER ||
    target === UniApplicationStatus.REJECTED_BY_UNIVERSITY;
  await db.application.update({
    where: { id: app.id },
    data: {
      status: target,
      submitted_at: stageAtLeast(position, UniApplicationStatus.APPLICATION_SUBMITTED)
        ? (app.submitted_at ?? new Date())
        : null,
      decided_at: offerOrRejection
        ? (app.decided_at ?? new Date())
        : open && !stageAtLeast(target, UniApplicationStatus.CONDITIONAL_OFFER)
          ? null
          : app.decided_at,
      ...(target === UniApplicationStatus.DOCUMENTS_PENDING
        ? { pending_docs: pendingDocs as unknown as object }
        : {}),
    },
  });
  await syncStudentStatusFromApplications(app.student_id);

  // Partner reports still pending: the confirmed one (or one asking for this
  // very status) is confirmed; any other is overtaken by this change.
  if (target !== app.status) {
    const pending = await db.application_partner_report.findMany({
      where: { application_id: app.id, status: PartnerReportStatus.PENDING },
      select: { id: true, target_status: true },
    });
    for (const r of pending) {
      const confirmed = r.id === input.actor.partnerReport?.id || r.target_status === target;
      await db.application_partner_report.update({
        where: { id: r.id },
        data: {
          status: confirmed ? PartnerReportStatus.CONFIRMED : PartnerReportStatus.REJECTED,
          decided_by_cp_user_id: input.actor.cpUserId,
          decided_at: new Date(),
          decision_note: confirmed
            ? (input.reason ?? null)
            : `Superseded: Collegepond moved the application to ${label(target)}`,
        },
      });
    }
  }

  // Tell the partner, but not for a revert (an admin undoing a mistake) or a
  // no-op re-save. A changed Documents Pending list is news on its own.
  const statusNews = target !== app.status && !isRevert;
  const docsNews = target === UniApplicationStatus.DOCUMENTS_PENDING && newDocItems.length > 0;
  if (statusNews || docsNews) {
    void notifyApplicationStatus(app.id, target, {
      pendingDocs:
        target === UniApplicationStatus.DOCUMENTS_PENDING
          ? pendingDocs.filter((d) => !d.receivedAt).map((d) => d.label)
          : null,
      confirmedReport: !!input.actor.partnerReport,
    });
  }

  // The student's counsellor hears about a change someone else made (a lead,
  // a Super Admin, or a partner report someone else confirmed), reverts
  // included. Skipped when the counsellor made it (counsellor-notify.ts).
  if (target !== app.status || docsNews) {
    void notifyCounsellorOfStage(app.id, app.student_id, input.actor.cpUserId, {
      from: app.status,
      to: target,
      reason: input.reason ?? null,
      reported: !!input.actor.partnerReport,
      pendingDocs:
        target === UniApplicationStatus.DOCUMENTS_PENDING
          ? pendingDocs.filter((d) => !d.receivedAt).map((d) => d.label)
          : null,
    });
  }

  await db.audit_log.create({
    data: {
      action: "application.status_updated",
      entity_type: "application",
      entity_id: app.id,
      metadata: {
        from: app.status,
        to: target,
        studentId: app.student_id,
        byCpUserId: input.actor.cpUserId,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.actor.partnerReport
          ? {
              partnerReportId: input.actor.partnerReport.id,
              reportedByUserId: input.actor.partnerReport.partnerUserId,
            }
          : {}),
        ...(target === UniApplicationStatus.DOCUMENTS_PENDING
          ? { pendingDocs: pendingDocs.map((d) => d.label) }
          : {}),
      },
    },
  });
  return { status: target, from: app.status };
}

// ---- Counsellor notification -------------------------------------------------

async function notifyCounsellorOfStage(
  applicationId: number,
  studentId: number,
  actorCpUserId: number,
  c: { from: number; to: number; reason: string | null; reported: boolean; pendingDocs: string[] | null },
) {
  const a = await applicationContext(applicationId);
  if (!a) return;
  await notifyStudentCounsellor({
    studentId,
    actorCpUserId,
    type: "application.stage_changed",
    title: (student, actor) => `${student}: ${label(c.to)} (${a.course.university.name}), by ${actor}`,
    lines: [
      `${a.course.university.name} – ${a.course.name}`,
      c.from === c.to ? label(c.to) : `${label(c.from)} → ${label(c.to)}`,
      ...(c.reported ? ["Confirmed from the partner's report"] : []),
      ...(c.pendingDocs?.length ? [`Pending: ${c.pendingDocs.join(", ")}`] : []),
      ...(c.reason ? [`Note: ${c.reason}`] : []),
    ],
    tone: c.to === UniApplicationStatus.DOCUMENTS_PENDING ? "orange" : "blue",
    tab: "application",
  });
}

// ---- Partner notifications ---------------------------------------------------

async function applicationContext(applicationId: number) {
  return db.application.findUnique({
    where: { id: applicationId },
    select: {
      student_id: true,
      student: { select: { first_name: true, last_name: true } },
      course: { select: { name: true, university: { select: { name: true } } } },
    },
  });
}

const studentLink = (studentId: number) => `/partner/students/${studentId}?tab=applications`;

// Email + in-app notification to the student's partner side for an
// application moving to `status`. Fire-and-forget: the change is saved, so a
// failure is only logged.
export async function notifyApplicationStatus(
  applicationId: number,
  status: number,
  extra: { pendingDocs?: string[] | null; confirmedReport?: boolean } = {},
): Promise<void> {
  try {
    const a = await applicationContext(applicationId);
    if (!a) return;
    const recipients = await studentPartnerRecipients(a.student_id);
    const studentName = `${a.student.first_name} ${a.student.last_name}`.trim();
    const statusLabel = label(status);
    const docs = extra.pendingDocs ?? null;
    const note = extra.confirmedReport ? "Collegepond has confirmed the update you reported." : null;

    await createNotifications(
      recipients.map((r) => r.id),
      {
        type: "application.status",
        title: docs
          ? `Documents needed for ${studentName}`
          : `${studentName}: ${statusLabel}`,
        body: docs
          ? `${a.course.university.name}: ${docs.join(", ")}`
          : `${a.course.university.name} – ${a.course.name}${note ? `. ${note}` : ""}`,
        link: studentLink(a.student_id),
        tone: docs ? "orange" : "blue",
      },
    ).catch((e: unknown) =>
      console.error("[notify] application-status failed:", e instanceof Error ? e.message : e),
    );

    await emailPartners(
      recipients,
      (r) =>
        applicationStatusEmail(
          r,
          {
            studentName,
            university: a.course.university.name,
            program: a.course.name,
            status: statusLabel,
            note,
            items: docs
              ? { title: "Please upload these documents for the application:", list: docs }
              : null,
            path: studentLink(a.student_id),
          },
          appUrl(),
        ),
      "application-status",
      // A document request is always sent (no toggle, like other document
      // requests); offers have their own toggle ("Offer Letter Received").
      docs
        ? undefined
        : status === UniApplicationStatus.CONDITIONAL_OFFER ||
            status === UniApplicationStatus.UNCONDITIONAL_OFFER
          ? "app.offer"
          : "app.status",
    );
  } catch (e) {
    console.error("[email] application-status lookup failed:", e instanceof Error ? e.message : e);
  }
}

// A partner's report that Collegepond did not accept.
export async function notifyPartnerReportRejected(
  applicationId: number,
  reported: string,
  reason: string,
): Promise<void> {
  try {
    const a = await applicationContext(applicationId);
    if (!a) return;
    const recipients = await studentPartnerRecipients(a.student_id);
    const studentName = `${a.student.first_name} ${a.student.last_name}`.trim();
    await createNotifications(
      recipients.map((r) => r.id),
      {
        type: "application.report_rejected",
        title: `${studentName}: "${reported}" not confirmed`,
        body: `${a.course.university.name}: ${reason}`,
        link: studentLink(a.student_id),
        tone: "red",
      },
    );
    await emailPartners(
      recipients,
      (r) =>
        applicationStatusEmail(
          r,
          {
            studentName,
            university: a.course.university.name,
            program: a.course.name,
            status: `${reported} not confirmed`,
            note: `Collegepond could not confirm the update you reported: ${reason}`,
            path: studentLink(a.student_id),
          },
          appUrl(),
        ),
      "application-report-rejected",
      "app.status",
    );
  } catch (e) {
    console.error("[email] report-rejected failed:", e instanceof Error ? e.message : e);
  }
}
