import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { UserStatus } from "~/server/db/enums";
import { findVisibleStudent } from "~/server/partner-access";
import { applicationUploadKind } from "~/lib/application-uploads";
import { notifyApplicationUpload } from "~/server/application-docs";
import { parseStudentDocUpload, saveStudentDocument, studentDocJson } from "~/server/student-docs";
import { documentChange, pendingDocChanges, recordPartnerChange } from "~/server/student-changes";

// Partner-side student document upload (student panel → Documents). Same
// fields and file rules as /api/admin/student-doc; the partner may upload
// only for a student they can see — the agency owner for any student of their
// agency, a counsellor for their own, an independent for theirs.
export async function POST(req: Request) {
  const jar = await cookies();
  const partner = await resolvePartnerSession(
    jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
    jar.get(SESSION_COOKIE_NAME)?.value,
    jar.get(PARTNER_OWNER_SESSION_COOKIE_NAME)?.value,
  );
  if (!partner) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // As protectedPartnerProcedure: a rejected, deactivated or removed account
  // can't act, even with a session issued before that happened.
  const me = await db.user.findUnique({
    where: { id: partner.id },
    select: { status: true, deleted_at: true },
  });
  if (
    !me ||
    me.deleted_at ||
    me.status === UserStatus.REJECTED ||
    me.status === UserStatus.INACTIVE
  ) {
    return NextResponse.json({ error: "This account is no longer active." }, { status: 401 });
  }

  const parsed = await parseStudentDocUpload(req);
  if ("error" in parsed) return parsed.error;

  // Another agency's student is indistinguishable from a missing one.
  const student = await findVisibleStudent(partner.id, parsed.studentId);
  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  // An upload for one application after Deposit Paid (deposit slip, visa
  // documents, visa approved copy): the application must be this student's
  // and the document one its stage asks for. A Documents Pending item upload
  // also names the application, but files like any profile document.
  let forApplication: { id: number; label: string } | null = null;
  if (parsed.applicationId && !parsed.pendingItem) {
    const app = await db.application.findFirst({
      where: { id: parsed.applicationId, student_id: parsed.studentId },
      select: { id: true, status: true },
    });
    if (!app) return NextResponse.json({ error: "Application not found" }, { status: 404 });
    const kind = applicationUploadKind(app.status, parsed.docType.key);
    if (!kind) {
      return NextResponse.json(
        { error: "That document can't be uploaded for this application at its current stage" },
        { status: 409 },
      );
    }
    forApplication = { id: app.id, label: kind.label };
  }

  const doc = await saveStudentDocument(
    parsed.studentId,
    parsed.docType,
    parsed.file,
    {
      byPartnerUserId: partner.id,
      ...(partner.impersonatorId ? { impersonation: { kind: "partner", byCpUserId: partner.impersonatorId } } : {}),
      // An agency owner viewing as this counsellor: the upload is the owner's.
      ...(partner.ownerImpersonatorId
        ? { byUserId: partner.ownerImpersonatorId, impersonation: { kind: "partner", id: partner.id } }
        : {}),
    },
    { pendingItem: parsed.pendingItem, applicationId: forApplication?.id ?? null },
  );
  if (forApplication) void notifyApplicationUpload(forApplication.id, forApplication.label, parsed.file.name);
  // Collegepond's counselling team hears about partner uploads with the rest
  // of the partner's profile edits, including any Documents Pending items the
  // upload ticked off.
  await recordPartnerChange(parsed.studentId, partner.id, "documents", [
    documentChange(parsed.docType.key, parsed.file.name),
    ...pendingDocChanges(doc.ticks),
  ]);
  return studentDocJson(doc);
}
