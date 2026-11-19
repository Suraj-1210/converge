import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { LoanReferralSendStatus } from "~/lib/loan-sharing";
import {
  MESSAGE_MAX_FILES,
  MESSAGE_MAX_FILE_BYTES,
  MESSAGE_MAX_TEXT,
  MESSAGE_MAX_TOTAL_BYTES,
  referralScopeFor,
  sendPartnerMessage,
} from "~/server/loan-sharing";
import { loanPartnerFromCookies } from "~/server/loan-sharing-auth";
import { saveBuffer } from "~/server/storage";

export const runtime = "nodejs";
export const maxDuration = 90;

// A partner's reply on a loan lead, with up to 3 PDFs (Phase 2, contract 3b).
// Multipart fields: publicId (the referral), text, files (repeat). The reply
// and files are saved here first (the partner sees them at once), then sent
// to the Enrollment App, where they land on the lead's timeline; a send that
// doesn't land retries from /api/cron/loan-referrals.
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
  const text = field("text").trim();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  if (text.length > MESSAGE_MAX_TEXT) {
    return NextResponse.json({ error: `Keep the message under ${MESSAGE_MAX_TEXT} characters.` }, { status: 400 });
  }
  if (!text && files.length === 0) {
    return NextResponse.json({ error: "Write a message or attach a PDF." }, { status: 400 });
  }
  if (files.length > MESSAGE_MAX_FILES) {
    return NextResponse.json({ error: `Attach up to ${MESSAGE_MAX_FILES} PDFs at a time.` }, { status: 400 });
  }
  let total = 0;
  const buffers: { file: File; buf: Buffer }[] = [];
  for (const file of files) {
    if (file.size > MESSAGE_MAX_FILE_BYTES) {
      return NextResponse.json({ error: `${file.name} is over 10 MB.` }, { status: 400 });
    }
    total += file.size;
    const buf = Buffer.from(await file.arrayBuffer());
    if (!buf.subarray(0, 4).equals(Buffer.from("%PDF"))) {
      return NextResponse.json({ error: `${file.name} isn't a PDF. Only PDF files can be sent.` }, { status: 400 });
    }
    buffers.push({ file, buf });
  }
  if (total > MESSAGE_MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: "Attachments are over 20 MB in total." }, { status: 400 });
  }

  const referral = await db.loan_referral.findFirst({
    where: { AND: [{ public_id: publicId }, referralScopeFor(who.user)] },
    select: { id: true, public_id: true, send_status: true, org_id: true },
  });
  // Another agency's referral looks exactly like a missing one.
  if (!referral) return NextResponse.json({ error: "Loan referral not found" }, { status: 404 });
  if (referral.send_status !== LoanReferralSendStatus.RECEIVED) {
    return NextResponse.json({ error: "You can message the loan team once they have received this referral." }, { status: 400 });
  }

  const messageId = crypto.randomUUID();
  const stored = [];
  for (const [i, { file, buf }] of buffers.entries()) {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || `file-${i + 1}.pdf`;
    const saved = await saveBuffer(buf, `loan-messages/${referral.public_id}/${messageId}/${i + 1}-${safe}`, {
      contentType: "application/pdf",
    });
    stored.push({
      file_name: file.name.slice(0, 200),
      storage_ref: saved.url,
      size: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    });
  }

  const message = await db.loan_referral_message.create({
    data: {
      public_id: messageId,
      referral_id: referral.id,
      author_user_id: who.user.id,
      author_name: `${who.user.first_name} ${who.user.last_name}`.trim(),
      body: text,
      send_status: LoanReferralSendStatus.SENDING,
      file: { create: stored },
    },
  });
  await db.audit_log.create({
    data: {
      org_id: referral.org_id,
      user_id: who.user.id,
      action: "loan_referral.message_sent",
      entity_type: "loan_referral",
      entity_id: referral.id,
      metadata: {
        byUserId: who.user.id,
        ...(who.impersonatorId ? { impersonatorId: who.impersonatorId } : {}),
        messageId,
        files: stored.length,
      },
    },
  });
  await sendPartnerMessage(message.id);
  const after = await db.loan_referral_message.findUniqueOrThrow({ where: { id: message.id } });
  return NextResponse.json({ publicId: messageId, sendStatus: after.send_status });
}
