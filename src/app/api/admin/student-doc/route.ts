import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { db } from "~/server/db";
import { STUDENT_DOC_TYPES } from "~/server/db/enums";
import { resolveStorageUrl, saveBuffer } from "~/server/storage";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "jpg",
  "jpeg",
  "png",
]);

// Per-education-level uploads (Academic Qualification sections) and
// per-attempt score reports (Tests sub-tab). Both accumulate (multiple).
const EDU_DOC_RE =
  /^edu_(10th|12th|ug|masters|phd)_(transcript|predicted|provisional|backlog|degree|other)$/;
const TEST_DOC_RE =
  /^test_(GRE|GMAT|GMAT_Focus|SAT|ACT|IELTS|TOEFL|TOEFL2026|PTE|Duolingo)_(10|[1-9])$/;

function resolveDocType(
  key: string,
): { key: string; multiple: boolean } | null {
  const fixed = STUDENT_DOC_TYPES.find((d) => d.key === key);
  if (fixed) return { key: fixed.key, multiple: fixed.multiple };
  if (EDU_DOC_RE.test(key) || TEST_DOC_RE.test(key)) {
    return { key, multiple: true };
  }
  return null;
}

// Student profile document upload (Documents tab). Multipart fields:
// studentId, docType, file. Single-slot doc types supersede the previous
// upload (is_most_recent = 0); multi-slot types accumulate.
export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  const claims = token ? await verifySessionJwt(token) : null;
  if (!claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const studentId = Number(formData.get("studentId"));
  const docTypeRaw = formData.get("docType");
  const docTypeKey = typeof docTypeRaw === "string" ? docTypeRaw : "";
  const file = formData.get("file");

  const docType = resolveDocType(docTypeKey);
  if (!docType) {
    return NextResponse.json({ error: "Unknown document type" }, { status: 400 });
  }
  if (!Number.isInteger(studentId) || studentId <= 0) {
    return NextResponse.json({ error: "Invalid student id" }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 10 MB)" },
      { status: 413 },
    );
  }
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      { error: "Allowed file types: PDF, DOC, DOCX, JPG, PNG" },
      { status: 415 },
    );
  }

  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { id: true },
  });
  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  const buffer = Buffer.from(await file.arrayBuffer());
  // Student documents are sensitive PII → private object, served via /api/files.
  const stored = await saveBuffer(
    buffer,
    `student-docs/${studentId}/${Date.now()}-${safeName}`,
    { contentType: file.type || undefined, public: false },
  );

  // Replace semantics for single-slot types: prior uploads stay in the
  // table as history but stop being "the" file.
  if (!docType.multiple) {
    await db.document.updateMany({
      where: { student_id: studentId, doc_type: docType.key },
      data: { is_most_recent: 0 },
    });
  }

  const doc = await db.document.create({
    data: {
      student_id: studentId,
      doc_type: docType.key,
      file_name: file.name,
      file_url: stored.url,
      mime_type: file.type || null,
      size_bytes: file.size,
    },
  });
  await db.audit_log.create({
    data: {
      action: "student.document_uploaded",
      entity_type: "student",
      entity_id: studentId,
      metadata: {
        docType: docType.key,
        fileName: file.name,
        // Real admin while impersonating a staff user (see impersonation-context).
        byCpUserId: claims.realId ?? claims.id,
        ...(claims.realId ? { impersonation: { kind: "staff", id: claims.id } } : {}),
      },
    },
  });

  return NextResponse.json({
    id: doc.id,
    docType: doc.doc_type,
    fileName: doc.file_name,
    fileUrl: resolveStorageUrl(doc.file_url),
    sizeBytes: doc.size_bytes,
  });
}
