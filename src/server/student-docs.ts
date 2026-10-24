import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { STUDENT_DOC_TYPES } from "~/server/db/enums";
import { resolveStorageUrl, saveBuffer } from "~/server/storage";
import { tickPendingDocs, type TickResult } from "~/server/pending-docs";

// Student profile document uploads, shared by the admin route
// (/api/admin/student-doc), the partner route (/api/partner/student-doc),
// partner chat's "Save to student documents" and the partner's application
// reports (/api/partner/application-report). The callers decide WHO may
// upload for a student; this decides WHAT may be uploaded and how it is
// stored.

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

// An upload made against one named Documents Pending item (an "Other"
// document, uploaded from the partner's application card).
export type PendingItemRef = { applicationId: number; itemId: number };

// Validates the multipart fields (studentId, docType, file, and optionally
// applicationId + pendingItemId). The caller checks it may act on
// `studentId` before storing.
export async function parseStudentDocUpload(
  req: Request,
): Promise<
  | Fail
  | {
      studentId: number;
      docType: { key: string; multiple: boolean };
      file: File;
      pendingItem: PendingItemRef | null;
      // An upload for one application (after Deposit Paid); the caller
      // checks the application belongs to the student.
      applicationId: number | null;
    }
> {
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
  const applicationId = Number(formData.get("applicationId"));
  const itemId = Number(formData.get("pendingItemId"));

  const docType = resolveDocType(docTypeKey);
  if (!docType) return bad("Unknown document type", 400);
  if (!Number.isInteger(studentId) || studentId <= 0) return bad("Invalid student id", 400);
  if (!(file instanceof File)) return bad("No file provided", 400);
  const invalid = checkStudentDocFile(file);
  if (invalid) return bad(invalid.error, invalid.status);
  const pendingItem =
    Number.isInteger(applicationId) && applicationId > 0 && Number.isInteger(itemId) && itemId > 0
      ? { applicationId, itemId }
      : null;
  return {
    studentId,
    docType,
    file,
    pendingItem,
    applicationId: Number.isInteger(applicationId) && applicationId > 0 ? applicationId : null,
  };
}

// The size and type rules for any student file (profile documents, files
// sent in partner chat, application report proofs). Null when acceptable.
export function checkStudentDocFile(file: File): { error: string; status: number } | null {
  if (file.size === 0) return { error: "No file provided", status: 400 };
  if (file.size > MAX_BYTES) return { error: "File too large (max 10 MB)", status: 413 };
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return { error: "Allowed file types: PDF, DOC, DOCX, JPG, PNG", status: 415 };
  return null;
}

// A fixed checklist document type ("passport", "sop", …) by key.
export function studentDocTypeByKey(key: string): { key: string; multiple: boolean } | null {
  const fixed = STUDENT_DOC_TYPES.find((d) => d.key === key);
  return fixed ? { key: fixed.key, multiple: fixed.multiple } : null;
}

// The upload routes' JSON response for a saved document.
export function studentDocJson(doc: {
  id: number;
  doc_type: string;
  file_name: string;
  file_url: string;
  size_bytes: number | null;
}) {
  return NextResponse.json({
    id: doc.id,
    docType: doc.doc_type,
    fileName: doc.file_name,
    fileUrl: resolveStorageUrl(doc.file_url),
    sizeBytes: doc.size_bytes,
  });
}

// saveStudentDocument as an HTTP response (the admin upload route).
export async function storeStudentDocument(
  studentId: number,
  docType: { key: string; multiple: boolean },
  file: File,
  actor: Record<string, unknown>,
  pendingItem?: PendingItemRef | null,
) {
  return studentDocJson(await saveStudentDocument(studentId, docType, file, actor, { pendingItem }));
}

// Stores the file privately and records it, for server code and the upload
// routes. Single-slot doc types supersede the previous upload
// (is_most_recent = 0); multi-slot types accumulate. `actor` goes into the
// audit log as-is (who uploaded, admin or partner). Ticks off matching
// Documents Pending items on the student's applications, whatever the path
// (profile upload, chat save, report); `ticks` on the result says which, so
// a partner's save can tell Collegepond. Returns the new row.
export async function saveStudentDocument(
  studentId: number,
  docType: { key: string; multiple: boolean },
  file: File,
  actor: Record<string, unknown>,
  opts: {
    description?: string | null;
    pendingItem?: PendingItemRef | null;
    // Ties the file to one application; a single-slot type then replaces
    // only that application's earlier upload.
    applicationId?: number | null;
  } = {},
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
      where: {
        student_id: studentId,
        doc_type: docType.key,
        ...(opts.applicationId ? { application_id: opts.applicationId } : {}),
      },
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
      description: opts.description?.slice(0, 255) ?? null,
      application_id: opts.applicationId ?? null,
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
        ...(opts.applicationId ? { applicationId: opts.applicationId } : {}),
        ...actor,
      },
    },
  });

  let ticks: TickResult[] = [];
  try {
    ticks = await tickPendingDocs(studentId, docType.key, opts.pendingItem);
  } catch (e) {
    // The document is saved; a failed tick-off only leaves the item open.
    console.error("[pending-docs] tick-off failed:", e instanceof Error ? e.message : e);
  }
  return { ...doc, ticks };
}
