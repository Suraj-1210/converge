import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { db } from "~/server/db";
import { parseStudentDocUpload, storeStudentDocument } from "~/server/student-docs";
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

  return storeStudentDocument(parsed.studentId, parsed.docType, parsed.file, {
    // Real admin while impersonating a staff user (see impersonation-context).
    byCpUserId: claims.realId ?? claims.id,
    ...(claims.realId ? { impersonation: { kind: "staff", id: claims.id } } : {}),
  });
}
