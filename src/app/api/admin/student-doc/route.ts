import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { db } from "~/server/db";
import {
  parseStudentDocUpload,
  saveStudentDocument,
  storeStudentDocument,
  studentDocJson,
} from "~/server/student-docs";
import { DocumentStatus } from "~/server/db/enums";
import { applicationUploadKind } from "~/lib/application-uploads";
import { canSeeStudent } from "~/server/staff-access";

// Student profile document upload (Documents tab). Multipart fields:
// studentId, docType, file. Collegepond staff may upload for any student they
// can see (src/server/staff-access.ts); validation and storage are shared with
// the partner route.
export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  const claims = token ? await verifySessionJwt(token) : null;
  if (!claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseStudentDocUpload(req);
  if ("error" in parsed) return parsed.error;

  const student = await db.student.findUnique({
    where: { id: parsed.studentId },
    select: { id: true },
  });
  // Outside the staff user's scope looks exactly like a missing student.
  if (!student || !(await canSeeStudent(claims, student.id))) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const actor = {
    // Real admin while impersonating a staff user (see impersonation-context).
    byCpUserId: claims.realId ?? claims.id,
    ...(claims.realId ? { impersonation: { kind: "staff", id: claims.id } } : {}),
  };

  // Collegepond uploading an application document itself (e.g. the deposit
  // slip received by email): tied to the application and verified on upload,
  // since Collegepond is the verifier. Commission approval needs a verified
  // deposit slip.
  if (parsed.applicationId && !parsed.pendingItem) {
    const app = await db.application.findFirst({
      where: { id: parsed.applicationId, student_id: parsed.studentId },
      select: { id: true, status: true },
    });
    if (!app) return NextResponse.json({ error: "Application not found" }, { status: 404 });
    if (!applicationUploadKind(app.status, parsed.docType.key)) {
      return NextResponse.json(
        { error: "That document can't be added for this application at its current stage" },
        { status: 409 },
      );
    }
    const doc = await saveStudentDocument(parsed.studentId, parsed.docType, parsed.file, actor, {
      applicationId: app.id,
    });
    const verified = await db.document.update({
      where: { id: doc.id },
      data: {
        status: DocumentStatus.APPROVED,
        reviewed_at: new Date(),
        reviewed_by_cp_user_id: claims.realId ?? claims.id,
      },
    });
    await db.audit_log.create({
      data: {
        action: "application.document_verified",
        entity_type: "application",
        entity_id: app.id,
        metadata: { documentId: doc.id, docType: doc.doc_type, fileName: doc.file_name, uploadedByCollegepond: true, ...actor },
      },
    });
    return studentDocJson(verified);
  }

  return storeStudentDocument(parsed.studentId, parsed.docType, parsed.file, actor, parsed.pendingItem);
}
