import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { STUDENT_DOC_TYPES } from "~/server/db/enums";
import { resolveStorageUrl, saveBuffer } from "~/server/storage";

// Student profile document uploads, shared by the admin route
// (/api/admin/student-doc) and the partner route (/api/partner/student-doc).
// The routes decide WHO may upload for a student; this decides WHAT may be
// uploaded and how it is stored.

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

type Fail = { error: NextResponse };

// Validates the multipart fields (studentId, docType, file). The caller checks
// it may act on `studentId` before calling storeStudentDocument.
export async function parseStudentDocUpload(
  req: Request,
): Promise<Fail | { studentId: number; docType: { key: string; multiple: boolean }; file: File }> {
  const bad = (error: string, status: number) => ({
    error: NextResponse.json({ error }, { status }),
  });
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return bad("Invalid form data", 400);
  }

  const studentId = Number(formData.get("studentId"));
  const docTypeRaw = formData.get("docType");
  const docTypeKey = typeof docTypeRaw === "string" ? docTypeRaw : "";
  const file = formData.get("file");

  const docType = resolveDocType(docTypeKey);
  if (!docType) return bad("Unknown document type", 400);
  if (!Number.isInteger(studentId) || studentId <= 0) return bad("Invalid student id", 400);
  if (!(file instanceof File) || file.size === 0) return bad("No file provided", 400);
  if (file.size > MAX_BYTES) return bad("File too large (max 10 MB)", 413);
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return bad("Allowed file types: PDF, DOC, DOCX, JPG, PNG", 415);
  return { studentId, docType, file };
}

// Stores the file privately and records it. Single-slot doc types supersede
// the previous upload (is_most_recent = 0); multi-slot types accumulate.
// `actor` goes into the audit log as-is (who uploaded, admin or partner).
export async function storeStudentDocument(
  studentId: number,
  docType: { key: string; multiple: boolean },
  file: File,
  actor: Record<string, unknown>,
) {
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
      metadata: { docType: docType.key, fileName: file.name, ...actor },
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
