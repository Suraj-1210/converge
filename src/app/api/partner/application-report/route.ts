import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import {
  PartnerReportStatus,
  UniApplicationStatusLabel,
  UserStatus,
  partnerReportOption,
  type UniApplicationStatus,
} from "~/server/db/enums";
import { findVisibleStudent } from "~/server/partner-access";
import { checkStudentDocFile, saveStudentDocument, studentDocTypeByKey } from "~/server/student-docs";
import { documentChange, pendingDocChanges, recordPartnerChange } from "~/server/student-changes";

// A partner reports Deposit Paid (from Unconditional Offer) or a visa outcome
// (from Visa Filed) on an application, with the supporting document. The
// file is filed into the student's documents straight away; the stage itself
// changes only when a Collegepond counsellor confirms the report
// (applicationPipeline.confirmPartnerReport). Who may report: anyone who can
// see the student (agency owner, the assigned agency counsellor, the
// independent counsellor). Collegepond hears through the partner-change
// alerts (student-changes.ts).
//
// multipart fields: applicationId, targetStatus, note (optional), file.
export async function POST(req: Request) {
  const jar = await cookies();
  const partner = await resolvePartnerSession(
    jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
    jar.get(SESSION_COOKIE_NAME)?.value,
  );
  if (!partner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // As protectedPartnerProcedure: an inactive account can't act.
  const me = await db.user.findUnique({
    where: { id: partner.id },
    select: { status: true, deleted_at: true },
  });
  if (!me || me.deleted_at || me.status === UserStatus.REJECTED || me.status === UserStatus.INACTIVE) {
    return NextResponse.json({ error: "This account is no longer active." }, { status: 401 });
  }

  const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Invalid form data");
  }
  const applicationId = Number(form.get("applicationId"));
  const targetStatus = Number(form.get("targetStatus"));
  const noteRaw = form.get("note");
  const note = typeof noteRaw === "string" ? noteRaw.trim().slice(0, 500) || null : null;
  const fileRaw = form.get("file");
  const file = fileRaw instanceof File && fileRaw.size > 0 ? fileRaw : null;
  if (!Number.isInteger(applicationId) || applicationId <= 0) return bad("Invalid application");

  const app = await db.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      status: true,
      student_id: true,
      course: { select: { name: true, university: { select: { name: true } } } },
    },
  });
  // Another partner's application is indistinguishable from a missing one.
  if (!app || !(await findVisibleStudent(partner.id, app.student_id))) {
    return bad("Application not found", 404);
  }

  const option = partnerReportOption(app.status, targetStatus);
  if (!option) return bad("That update can't be reported at this stage", 409);
  const open = await db.application_partner_report.count({
    where: { application_id: app.id, status: PartnerReportStatus.PENDING },
  });
  if (open > 0) return bad("An update for this application is already awaiting Collegepond", 409);

  if (!file && option.docRequired) return bad("Attach the supporting document");
  if (file) {
    const problem = checkStudentDocFile(file);
    if (problem) return bad(problem.error, problem.status);
  }

  const actor = {
    byPartnerUserId: partner.id,
    ...(partner.impersonatorId ? { impersonation: { kind: "partner", byCpUserId: partner.impersonatorId } } : {}),
  };
  const docType = studentDocTypeByKey(option.docType)!;
  const saved = file
    ? await saveStudentDocument(app.student_id, docType, file, actor, {
        description: `${option.label} – ${app.course.university.name}`,
      })
    : null;

  const report = await db.application_partner_report.create({
    data: {
      application_id: app.id,
      from_status: app.status,
      target_status: option.to,
      document_id: saved?.id ?? null,
      note,
      reported_by_user_id: partner.id,
    },
  });
  await db.audit_log.create({
    data: {
      action: "application.partner_report_created",
      entity_type: "application",
      entity_id: app.id,
      metadata: { reportId: report.id, from: app.status, to: option.to, note, documentId: saved?.id ?? null, ...actor },
    },
  });

  const where = `${app.course.university.name} – ${app.course.name}`;
  const from = UniApplicationStatusLabel[app.status as UniApplicationStatus] ?? null;
  await recordPartnerChange(app.student_id, partner.id, "applications", [
    { field: where, from, to: `${option.label} reported, awaiting Collegepond confirmation${note ? ` (“${note}”)` : ""}` },
  ]);
  if (file) {
    await recordPartnerChange(app.student_id, partner.id, "documents", [
      documentChange(docType.key, file.name),
      ...pendingDocChanges(saved?.ticks ?? []),
    ]);
  }
  return NextResponse.json({ reportId: report.id });
}
