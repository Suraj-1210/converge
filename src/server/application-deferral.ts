import "server-only";
import { TRPCError } from "@trpc/server";
import { db } from "~/server/db";
import {
  PartnerReportStatus,
  UniApplicationStatus,
  canDeferFrom,
} from "~/server/db/enums";
import { transitionApplication } from "~/server/application-transitions";
import { appUrl, applicationStatusEmail } from "~/server/email";
import { emailPartners, studentPartnerRecipients } from "~/server/email/partners";
import { createNotifications } from "~/server/notify";

// Deferral to a later intake (Portal Testing Day 5, 24 Oct 2026, with
// Suraj). Deferring no longer closes the application: the new intake is
// recorded and the application stays open, so it can't get lost. It keeps
// its stage (an offer, or Deposit Paid once the deposit is in), except a visa
// stage: the visa is filed for the new intake, so it goes back to Deposit
// Paid. Deferred applications are listed on both Students pages until they
// enrol or close.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function intakeLabel(month: number, year: number): string {
  return `${MONTHS[month - 1] ?? "?"} ${year}`;
}

// The new intake must be a real month that hasn't started yet.
export function checkNewIntake(month: number, year: number): string | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return "Pick the new intake month";
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return "Pick the new intake year";
  const now = new Date();
  if (year * 12 + month <= now.getFullYear() * 12 + now.getMonth() + 1) {
    return "The new intake must be after this month";
  }
  return null;
}

export interface DeferInput {
  cpUserId: number;
  applicationId: number;
  month: number;
  year: number;
  note?: string | null;
  // Set when confirming a partner's reported deferral.
  partnerReport?: { id: number; partnerUserId: number | null };
}

export async function deferApplication(input: DeferInput) {
  const problem = checkNewIntake(input.month, input.year);
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
  const app = await db.application.findUnique({
    where: { id: input.applicationId },
    select: {
      id: true,
      status: true,
      student_id: true,
      deferred_intake_month: true,
      deferred_intake_year: true,
      course: { select: { intake_month: true, intake_year: true } },
    },
  });
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
  if (!canDeferFrom(app.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An application can be deferred from an offer onwards, before it is enrolled",
    });
  }

  // What the application was aiming for until now: an earlier deferral's
  // intake, else the course's.
  const from =
    app.deferred_intake_month && app.deferred_intake_year
      ? intakeLabel(app.deferred_intake_month, app.deferred_intake_year)
      : [app.course.intake_month, app.course.intake_year].filter(Boolean).join(" ") || null;
  const to = intakeLabel(input.month, input.year);
  const trimmed = input.note?.trim().slice(0, 255);
  const note = trimmed?.length ? trimmed : null;

  // A filed or approved visa was for the old intake.
  const visaStage =
    app.status === UniApplicationStatus.VISA_FILED || app.status === UniApplicationStatus.VISA_SECURED;
  if (visaStage) {
    await transitionApplication({
      // Passing the report lets the transition mark it confirmed rather
      // than superseded.
      actor: { cpUserId: input.cpUserId, partnerReport: input.partnerReport },
      applicationId: app.id,
      targetStatus: UniApplicationStatus.DEPOSIT_PAID,
      reason: `Deferred to ${to}: the visa is filed again for the new intake`,
    });
  }

  await db.application.update({
    where: { id: app.id },
    data: {
      deferred_intake_month: input.month,
      deferred_intake_year: input.year,
      deferred_from_intake: from?.slice(0, 40) ?? null,
      deferred_at: new Date(),
      deferred_by_cp_user_id: input.cpUserId,
      deferred_note: note,
    },
  });

  // A pending partner report: the confirmed one (or another deferral) is
  // confirmed; anything else is overtaken.
  const pending = await db.application_partner_report.findMany({
    where: { application_id: app.id, status: PartnerReportStatus.PENDING },
    select: { id: true, target_status: true },
  });
  for (const r of pending) {
    const confirmed =
      r.id === input.partnerReport?.id ||
      r.target_status === UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE;
    await db.application_partner_report.update({
      where: { id: r.id },
      data: {
        status: confirmed ? PartnerReportStatus.CONFIRMED : PartnerReportStatus.REJECTED,
        decided_by_cp_user_id: input.cpUserId,
        decided_at: new Date(),
        decision_note: confirmed ? note : `Superseded: Collegepond deferred the application to ${to}`,
      },
    });
  }

  await db.audit_log.create({
    data: {
      action: "application.deferred",
      entity_type: "application",
      entity_id: app.id,
      metadata: {
        studentId: app.student_id,
        from,
        to,
        stage: visaStage ? UniApplicationStatus.DEPOSIT_PAID : app.status,
        byCpUserId: input.cpUserId,
        ...(note ? { note } : {}),
        ...(input.partnerReport
          ? { partnerReportId: input.partnerReport.id, reportedByUserId: input.partnerReport.partnerUserId }
          : {}),
      },
    },
  });

  void notifyDeferral(app.id, to, visaStage, !!input.partnerReport);
  return { intake: to, from };
}

// Email + in-app notification to the student's partner side. Fire-and-forget.
async function notifyDeferral(applicationId: number, to: string, visaReset: boolean, confirmed: boolean) {
  try {
    const a = await db.application.findUnique({
      where: { id: applicationId },
      select: {
        student_id: true,
        student: { select: { first_name: true, last_name: true } },
        course: { select: { name: true, university: { select: { name: true } } } },
      },
    });
    if (!a) return;
    const recipients = await studentPartnerRecipients(a.student_id);
    const studentName = `${a.student.first_name} ${a.student.last_name}`.trim();
    const path = `/partner/students/${a.student_id}?tab=applications`;
    const note = [
      confirmed ? "Collegepond has confirmed the deferral you reported." : null,
      "The application stays open for the new intake.",
      visaReset ? "The visa will need to be filed again for the new intake." : null,
    ]
      .filter(Boolean)
      .join(" ");
    await createNotifications(
      recipients.map((r) => r.id),
      {
        type: "application.status",
        title: `${studentName}: deferred to ${to}`,
        body: `${a.course.university.name} – ${a.course.name}`,
        link: path,
        tone: "blue",
      },
    ).catch((e: unknown) =>
      console.error("[notify] deferral failed:", e instanceof Error ? e.message : e),
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
            status: `Deferred to ${to}`,
            note,
            path,
          },
          appUrl(),
        ),
      "application-deferred",
      "app.status",
    );
  } catch (e) {
    console.error("[email] deferral failed:", e instanceof Error ? e.message : e);
  }
}
