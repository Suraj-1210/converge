import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { db } from "~/server/db";
import { parseStudentDocUpload, storeStudentDocument } from "~/server/student-docs";

// Student profile document upload (Documents tab). Multipart fields:
// studentId, docType, file. Any Collegepond staff session may upload for any
// student; validation and storage are shared with the partner route.
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
  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  return storeStudentDocument(parsed.studentId, parsed.docType, parsed.file, {
    byCpUserId: claims.id,
  });
}
