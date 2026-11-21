import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { ADDITIONAL_DOC_KEY, ADDITIONAL_DOC_LABEL_MAX, LoanReferralSendStatus } from "~/lib/loan-sharing";
import {
  DOC_MAX_FILES,
  DOC_MAX_FILE_BYTES,
  DOC_MAX_TOTAL_BYTES,
  referralScopeFor,
  sendLoanDocument,
  sniffDocType,
} from "~/server/loan-sharing";
import { loanPartnerFromCookies } from "~/server/loan-sharing-auth";
import { findVisibleStudent } from "~/server/partner-access";
import { readStoredFile, saveBuffer } from "~/server/storage";

export const runtime = "nodejs";
export const maxDuration = 90;

// A partner's document for one item on a loan lead's document list (contract
// section 5). Multipart fields: publicId (the referral), typeKey (the item),
// and either files (1–5 PDF / JPG / PNG, 10 MB each, 20 MB total) or
// profileDocIds: documents already on the student's Converge profile for the
// item's matching type, sent as they are ("Use the one on file").
// typeKey "additional" is an Additional document: any document outside the
// list, with the partner's own label (field: label, 2–160 characters); files only.
// Saved here first, then sent to the Enrollment App, where the loan counsellor
// reviews it; a send that doesn't land retries from /api/cron/loan-referrals.
export async function POST(req: Request) {
  const who = await loanPartnerFromCookies();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const publicId = field("publicId");
  const typeKey = field("typeKey");
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const profileDocIds = form
    .getAll("profileDocIds")
    .map((v) => (typeof v === "string" ? Number(v) : NaN))
    .filter((n) => Number.isInteger(n) && n > 0);

  const referral = await db.loan_referral.findFirst({
    where: { AND: [{ public_id: publicId }, referralScopeFor(who.user)] },
    select: { id: true, public_id: true, send_status: true, org_id: true, student_id: true },
  });
  if (!referral) return NextResponse.json({ error: "Loan referral not found" }, { status: 404 });
  if (referral.send_status !== LoanReferralSendStatus.RECEIVED) {
    return NextResponse.json(
      { error: "You can send documents once the loan team has received this referral." },
      { status: 400 },
    );
  }
  const additional = typeKey === ADDITIONAL_DOC_KEY;
  const label = field("label").replace(/\s+/g, " ").trim();
  if (additional && (label.length < 2 || label.length > ADDITIONAL_DOC_LABEL_MAX)) {
    return NextResponse.json({ error: "Name the document (2 to 160 characters)." }, { status: 400 });
  }
  if (additional && profileDocIds.length > 0) {
    return NextResponse.json({ error: "Upload the file for an additional document." }, { status: 400 });
  }
  const item = additional
    ? { item_key: ADDITIONAL_DOC_KEY, converge_doc_type: null }
    : await db.loan_doc_item.findUnique({
        where: { referral_id_item_key: { referral_id: referral.id, item_key: typeKey } },
        select: { item_key: true, converge_doc_type: true },
      });
  if (!item) return NextResponse.json({ error: "That document isn't on this loan's list." }, { status: 400 });

  const uploadId = crypto.randomUUID();
  const rows: { file_name: string; storage_ref: string; content_type: string; size: number; sha256: string }[] = [];
  let source: "upload" | "converge_profile" = "upload";

  if (profileDocIds.length > 0) {
    // "Use the one on file": only the student's own documents of the item's
    // matching type, for a student this partner can see.
    if (!item.converge_doc_type || referral.student_id === null) {
      return NextResponse.json({ error: "There is no matching document on the student's profile." }, { status: 400 });
    }
    if (!(await findVisibleStudent(who.user.id, referral.student_id))) {
      return NextResponse.json({ error: "Loan referral not found" }, { status: 404 });
    }
    const docs = await db.document.findMany({
      where: { id: { in: profileDocIds.slice(0, DOC_MAX_FILES) }, student_id: referral.student_id, doc_type: item.converge_doc_type },
      select: { id: true, file_name: true, file_url: true },
    });
    if (docs.length === 0) {
      return NextResponse.json({ error: "Those documents aren't on the student's profile." }, { status: 400 });
    }
    let total = 0;
    for (const d of docs) {
      const buf = await readStoredFile(d.file_url);
      const type = sniffDocType(buf);
      if (!type) {
        return NextResponse.json({ error: `${d.file_name} isn't a PDF, JPG or PNG; upload it instead.` }, { status: 400 });
      }
      total += buf.length;
      if (buf.length > DOC_MAX_FILE_BYTES || total > DOC_MAX_TOTAL_BYTES) {
        return NextResponse.json({ error: `${d.file_name} is too large to send; upload a smaller copy.` }, { status: 400 });
      }
      rows.push({
        file_name: d.file_name.slice(0, 200),
        storage_ref: d.file_url,
        content_type: type,
        size: buf.length,
        sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      });
    }
    source = "converge_profile";
  } else {
    if (files.length === 0) return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });
    if (files.length > DOC_MAX_FILES) {
      return NextResponse.json({ error: `Upload up to ${DOC_MAX_FILES} files at a time.` }, { status: 400 });
    }
    let total = 0;
    for (const [i, file] of files.entries()) {
      if (file.size > DOC_MAX_FILE_BYTES) return NextResponse.json({ error: `${file.name} is over 10 MB.` }, { status: 400 });
      total += file.size;
      if (total > DOC_MAX_TOTAL_BYTES) return NextResponse.json({ error: "Files are over 20 MB in total." }, { status: 400 });
      const buf = Buffer.from(await file.arrayBuffer());
      const type = sniffDocType(buf);
      if (!type) return NextResponse.json({ error: `${file.name} isn't a PDF, JPG or PNG.` }, { status: 400 });
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || `file-${i + 1}`;
      const saved = await saveBuffer(buf, `loan-docs/${referral.public_id}/${uploadId}/${i + 1}-${safe}`, {
        contentType: type,
      });
      rows.push({
        file_name: file.name.slice(0, 200),
        storage_ref: saved.url,
        content_type: type,
        size: buf.length,
        sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      });
    }
  }

  const upload = await db.loan_doc_upload.create({
    data: {
      public_id: uploadId,
      referral_id: referral.id,
      item_key: item.item_key,
      label: additional ? label : null,
      author_user_id: who.user.id,
      author_name: `${who.user.first_name} ${who.user.last_name}`.trim(),
      source,
      send_status: LoanReferralSendStatus.SENDING,
      file: { create: rows },
    },
  });
  await db.audit_log.create({
    data: {
      org_id: referral.org_id,
      user_id: who.user.id,
      action: "loan_referral.document_sent",
      entity_type: "loan_referral",
      entity_id: referral.id,
      metadata: {
        byUserId: who.user.id,
        ...(who.impersonatorId ? { impersonatorId: who.impersonatorId } : {}),
        uploadId,
        typeKey: item.item_key,
        ...(additional ? { label } : {}),
        source,
        files: rows.length,
      },
    },
  });
  await sendLoanDocument(upload.id);
  const after = await db.loan_doc_upload.findUniqueOrThrow({ where: { id: upload.id } });
  return NextResponse.json({ publicId: uploadId, sendStatus: after.send_status });
}
