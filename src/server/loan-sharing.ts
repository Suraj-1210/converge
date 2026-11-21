import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { env } from "~/env";
import { db } from "~/server/db";
import { AdminRole, CourseLevelLabel, type CourseLevel, UserStatus, UserType } from "~/server/db/enums";
import { createNotifications } from "~/server/notify";
import { createStaffNotifications } from "~/server/staff-notify";
import { appUrl } from "~/server/email";
import { emailPartners, type Recipient } from "~/server/email/partners";
import { loanChatEmail, loanMilestoneEmail } from "~/server/email/templates";
import { readStoredFile } from "~/server/storage";
import { onApplicationGone, onApplicationSynced } from "~/server/loan-commission";
import {
  LOAN_STAGES,
  LoanReferralSendStatus,
  type LoanStage,
  loanStageLabel,
} from "~/lib/loan-sharing";

// Loan lead sharing with the Collegepond Enrollment App (Phase 1, 19 Nov 2026).
//
// Partners refer education-loan leads here; we send each one to the
// Enrollment App's partnerLoanIntake function, where the loan counsellors work
// it. The Enrollment App pushes the lead's progress back to
// /api/v1/webhooks/enrollment-loan, and applyEnrollmentEvents() mirrors it
// into loan_referral* for the partner's Loans tab. The Enrollment App stays
// the only system of record: nothing here ever changes the loan lead.
//
// Wire format, signing and ids: docs/loan-sharing/CONTRACT.md (keep the two
// repos in step). Spec: Claude Doc "B2B Loan Lead Sharing".

const SIGNATURE_WINDOW_S = 300;
const SEND_TIMEOUT_MS = 10_000;
// Super Admins hear about a referral the Enrollment App still hasn't taken
// after this many tries; retrying goes on (cron) until it lands.
const ALERT_AFTER_ATTEMPTS = 6;

// ── Signing ──────────────────────────────────────────────────────────────────

export function signBody(secret: string, timestamp: string, raw: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
}

// True when the request was signed with `secret` within the last 5 minutes.
export function verifySignedRequest(
  raw: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_WINDOW_S) return false;
  const a = Buffer.from(signBody(secret, timestamp, raw));
  const b = Buffer.from(signature.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function loanSharingConfig() {
  return {
    sendConfigured: !!env.ENROLLMENT_LOAN_URL && !!env.ENROLLMENT_LOAN_SECRET,
    receiveConfigured: !!env.ENROLLMENT_WEBHOOK_SECRET,
  };
}

// ── Who sees what ──────────────────────────────────────────────────────────

// Which referrals a partner user may see — the same as students
// (~/server/partner-access): agency owner → the whole agency's; agency
// counsellor → ones they made and ones for their students; independent → own.
export function referralScopeFor(user: { id: number; type: number; org_id: number | null }) {
  if (user.org_id === null) return { partner_user_id: user.id };
  if (user.type === UserType.AGENCY_COUNSELLOR) {
    return {
      org_id: user.org_id,
      OR: [
        { partner_user_id: user.id },
        { student: { counsellor_id: user.id } },
        { student: { created_by_user_id: user.id } },
      ],
    };
  }
  return { org_id: user.org_id };
}

// ── Who is told ──────────────────────────────────────────────────────────────

// The referring user plus the agency's owner(s): stage changes and lender
// results go to both; the rest only to the referrer.
async function referralAudience(r: { partner_user_id: number; org_id: number | null }): Promise<number[]> {
  const ids = [r.partner_user_id];
  if (r.org_id !== null) {
    const owners = await db.user.findMany({
      where: { org_id: r.org_id, type: UserType.AGENCY_OWNER, is_owner: 1, deleted_at: null },
      select: { id: true },
    });
    ids.push(...owners.map((o) => o.id));
  }
  return ids;
}

const leadLink = (publicId: string) => `/partner/loans/${publicId}`;

// Converge's own timeline entries ("Referred by …", "Received …"). The event
// id is fixed per referral and step, so a retry never writes it twice.
async function addOwnEvent(
  referralId: number,
  eventId: string,
  e: { kind: string; title: string; body?: string | null; actor?: string | null; at?: Date },
): Promise<void> {
  await db.loan_referral_event
    .create({
      data: {
        referral_id: referralId,
        event_id: eventId,
        kind: e.kind,
        visible: 1,
        title: e.title.slice(0, 255),
        body: e.body ? e.body.slice(0, 1000) : null,
        actor_name: e.actor ?? null,
        occurred_at: e.at ?? new Date(),
      },
    })
    .catch((err: unknown) => {
      if (!isUniqueViolation(err)) throw err;
    });
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002";
}

// ── Creating a referral ──────────────────────────────────────────────────────

export type ReferralInput = {
  partnerUserId: number;
  studentId: number | null;
  name: string;
  phone: string; // as stored on the student ("+91 98123 45678") or typed
  email: string;
  intake: string;
  country: string | null; // ISO2
  university: string | null;
  courseLevel: number | null;
  loanAmount: number | null;
  note: string | null;
};

// A referral still open (sent, received or already with Collegepond) for this
// student. Failed ones can be referred again.
export async function activeReferralForStudent(studentId: number) {
  return db.loan_referral.findFirst({
    where: { student_id: studentId, send_status: { not: LoanReferralSendStatus.FAILED } },
    select: { id: true, public_id: true },
  });
}

// Saves the referral, then tries to hand it over at once. A failed hand-over
// leaves it queued ("Not yet received by the loan team") for the cron retry;
// the partner's save never fails because the Enrollment App is down.
export async function createLoanReferral(input: ReferralInput) {
  const partner = await db.user.findUnique({
    where: { id: input.partnerUserId },
    select: { id: true, org_id: true, first_name: true, last_name: true },
  });
  if (!partner) throw new Error("Partner not found");
  const referral = await db.loan_referral.create({
    data: {
      public_id: crypto.randomUUID(),
      org_id: partner.org_id,
      partner_user_id: partner.id,
      student_id: input.studentId,
      student_name: input.name.slice(0, 150),
      phone: input.phone.slice(0, 20),
      email: input.email.toLowerCase().slice(0, 255),
      intake: input.intake.slice(0, 20),
      country: input.country,
      university: input.university?.slice(0, 255) ?? null,
      course_level: input.courseLevel,
      loan_amount: input.loanAmount,
      note: input.note?.slice(0, 1000) ?? null,
      consent_at: new Date(),
      send_status: LoanReferralSendStatus.SENDING,
    },
  });
  await addOwnEvent(referral.id, `cv:${referral.public_id}:referred`, {
    kind: "referred",
    title: "Referred to the Collegepond loan team",
    actor: `${partner.first_name} ${partner.last_name}`.trim(),
    at: referral.created_at,
  });
  await sendLoanReferral(referral.id);
  return db.loan_referral.findUniqueOrThrow({ where: { id: referral.id } });
}

// ── Sending (Converge → Enrollment) ──────────────────────────────────────────

function e164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return `+${digits}`;
}

async function buildReferralPayload(id: number) {
  const r = await db.loan_referral.findUniqueOrThrow({
    where: { id },
    include: {
      partner_user: { select: { id: true, first_name: true, last_name: true } },
      organization: { select: { id: true, name: true } },
    },
  });
  const referrerName = `${r.partner_user.first_name} ${r.partner_user.last_name}`.trim();
  const country = r.country
    ? ((await db.geo_country.findUnique({ where: { iso2: r.country }, select: { name: true } }))?.name ?? r.country)
    : null;
  return {
    referral: r,
    payload: {
      referralId: r.public_id,
      partner: r.organization
        ? { key: `org:${r.organization.id}`, name: r.organization.name }
        : { key: `user:${r.partner_user.id}`, name: referrerName },
      referredBy: { userId: r.partner_user.id, name: referrerName },
      student: {
        convergeStudentId: r.student_id,
        name: r.student_name,
        phone: e164(r.phone),
        email: r.email,
        intake: r.intake,
        country,
        university: r.university,
        courseLevel:
          r.course_level === null ? null : (CourseLevelLabel[r.course_level as CourseLevel] ?? null),
        loanAmount: r.loan_amount === null ? null : Number(r.loan_amount),
        note: r.note,
      },
      consentAt: r.consent_at.toISOString(),
    },
  };
}

const intakeResponse = z.object({
  result: z.enum(["created", "duplicate"]),
  loanLeadId: z.string().min(1).max(64),
});

function backoffMinutes(attempts: number): number {
  return Math.min(10 * 2 ** Math.max(0, attempts - 1), 360);
}

// One hand-over attempt. Never throws: the outcome is written on the row.
export async function sendLoanReferral(id: number): Promise<void> {
  const { referral: r, payload } = await buildReferralPayload(id);
  if (r.send_status !== LoanReferralSendStatus.SENDING) return;

  const url = env.ENROLLMENT_LOAN_URL;
  const secret = env.ENROLLMENT_LOAN_SECRET;
  let outcome:
    | { ok: true; result: "created" | "duplicate"; loanLeadId: string }
    | { ok: false; permanent: boolean; error: string };

  if (!url || !secret) {
    outcome = { ok: false, permanent: false, error: "Loan sharing is not configured (ENROLLMENT_LOAN_URL / ENROLLMENT_LOAN_SECRET)" };
  } else {
    const raw = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cp-timestamp": ts,
          "x-cp-signature": signBody(secret, ts, raw),
        },
        body: raw,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok) {
        const parsed = intakeResponse.safeParse(safeJson(text));
        outcome = parsed.success
          ? { ok: true, ...parsed.data }
          : { ok: false, permanent: false, error: `Unexpected reply: ${text.slice(0, 200)}` };
      } else {
        // 400 = the Enrollment App rejected the content: retrying can't help.
        outcome = { ok: false, permanent: res.status === 400, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      }
    } catch (e) {
      outcome = { ok: false, permanent: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const audience = [r.partner_user_id];
  if (outcome.ok) {
    const received = outcome.result === "created";
    // Claim the transition so a concurrent retry can't notify twice.
    const claimed = await db.loan_referral.updateMany({
      where: { id: r.id, send_status: LoanReferralSendStatus.SENDING },
      data: {
        send_status: received ? LoanReferralSendStatus.RECEIVED : LoanReferralSendStatus.DUPLICATE,
        loan_lead_id: outcome.loanLeadId,
        received_at: new Date(),
        last_error: null,
        next_attempt_at: null,
        send_attempts: { increment: 1 },
        ...(received && !r.stage ? { stage: "open" } : {}),
      },
    });
    if (claimed.count === 0) return;
    await addOwnEvent(r.id, `cv:${r.public_id}:${outcome.result}`, {
      kind: outcome.result,
      title: received ? "Received by the loan team" : "Already in progress with Collegepond",
      body: received
        ? null
        : "This student is already working with Collegepond's loan team, so progress isn't shared here.",
    });
    await createNotifications(audience, {
      type: "loan_referral",
      title: received
        ? `Loan referral received: ${r.student_name}`
        : `${r.student_name} is already in progress with Collegepond's loan team`,
      link: leadLink(r.public_id),
      tone: received ? "green" : "gray",
    });
    return;
  }

  const attempts = r.send_attempts + 1;
  if (outcome.permanent) {
    await db.loan_referral.update({
      where: { id: r.id },
      data: {
        send_status: LoanReferralSendStatus.FAILED,
        send_attempts: attempts,
        last_error: outcome.error.slice(0, 500),
        next_attempt_at: null,
      },
    });
    await createNotifications(audience, {
      type: "loan_referral",
      title: `Loan referral for ${r.student_name} could not be sent`,
      body: "Check the details and refer the student again.",
      link: leadLink(r.public_id),
      tone: "red",
    });
    await alertSuperAdmins(r, outcome.error);
    return;
  }
  await db.loan_referral.update({
    where: { id: r.id },
    data: {
      send_attempts: attempts,
      last_error: outcome.error.slice(0, 500),
      next_attempt_at: new Date(Date.now() + backoffMinutes(attempts) * 60_000),
    },
  });
  if (attempts === ALERT_AFTER_ATTEMPTS) await alertSuperAdmins(r, outcome.error);
}

async function alertSuperAdmins(r: { student_name: string }, error: string) {
  const admins = await db.collegepond_user.findMany({
    where: { role: AdminRole.SUPER_ADMIN, status: 1 },
    select: { id: true },
  });
  await createStaffNotifications(
    admins.map((a) => a.id),
    {
      type: "loan_referral_stuck",
      title: `Loan referral not reaching the Enrollment App: ${r.student_name}`,
      body: error.slice(0, 300),
      link: "/admin/loan-referrals",
      tone: "red",
    },
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// Cron: every referral still waiting whose next try is due.
export async function retryDueLoanReferrals(
  limit = 50,
): Promise<{ tried: number; messages: number; documents: number; chatEmails: number }> {
  const due = await db.loan_referral.findMany({
    where: {
      send_status: LoanReferralSendStatus.SENDING,
      OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: new Date() } }],
    },
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const { id } of due) await sendLoanReferral(id);
  const dueMessages = await db.loan_referral_message.findMany({
    where: {
      send_status: LoanReferralSendStatus.SENDING,
      OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: new Date() } }],
    },
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const { id } of dueMessages) await sendPartnerMessage(id);
  const dueDocs = await db.loan_doc_upload.findMany({
    where: {
      send_status: LoanReferralSendStatus.SENDING,
      OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: new Date() } }],
    },
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const { id } of dueDocs) await sendLoanDocument(id);
  const chatEmails = await emailUnreadLoanChats();
  return { tried: due.length, messages: dueMessages.length, documents: dueDocs.length, chatEmails };
}

// ── Loan chat (contract 4) ──────────────────────────────────────────────────

const CHAT_EMAIL_AFTER_MS = 15 * 60_000;

// A counsellor's chat message, stored once (external_id), with a bell for the
// referrer and the agency owner. The email follows only if it stays unread.
async function applyStaffChat(
  r: { id: number; public_id: string; student_name: string; partner_user_id: number; org_id: number | null },
  chat: { messageId: string; text: string; by: string | null; at: string },
): Promise<void> {
  try {
    await db.loan_referral_message.create({
      data: {
        public_id: crypto.randomUUID(),
        referral_id: r.id,
        side: "staff",
        external_id: chat.messageId,
        author_name: (chat.by ?? "Loan team").slice(0, 150),
        body: chat.text.slice(0, 2000),
        send_status: LoanReferralSendStatus.RECEIVED,
        created_at: new Date(chat.at),
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return;
    throw e;
  }
  await createNotifications(await referralAudience(r), {
    type: "loan_chat",
    title: `${r.student_name}: new message from the loan team`,
    body: chat.text.slice(0, 200),
    link: `${leadLink(r.public_id)}#chat`,
  });
}

// Partner users' unread loan-chat messages per referral (staff messages newer
// than what that user has read).
export async function unreadLoanChats(userId: number, referralIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (referralIds.length === 0) return out;
  const [reads, msgs] = await Promise.all([
    db.loan_chat_read.findMany({ where: { user_id: userId, referral_id: { in: referralIds } } }),
    db.loan_referral_message.findMany({
      where: { side: "staff", referral_id: { in: referralIds } },
      select: { referral_id: true, created_at: true },
    }),
  ]);
  const readAt = new Map(reads.map((x) => [x.referral_id, x.read_at.getTime()]));
  for (const m of msgs) {
    if (m.created_at.getTime() > (readAt.get(m.referral_id) ?? 0)) {
      out.set(m.referral_id, (out.get(m.referral_id) ?? 0) + 1);
    }
  }
  return out;
}

// Cron: a counsellor message the referrer still hasn't read after 15 minutes
// gets one email per referral (preference "New chat messages from
// Collegepond", like the application chat). Read in time = settled, no email.
export async function emailUnreadLoanChats(): Promise<number> {
  const cutoff = new Date(Date.now() - CHAT_EMAIL_AFTER_MS);
  const due = await db.loan_referral_message.findMany({
    where: { side: "staff", emailed_at: null, created_at: { lte: cutoff, gte: new Date(Date.now() - 2 * 864e5) } },
    include: { referral: { select: { id: true, public_id: true, student_name: true, partner_user_id: true } } },
    orderBy: { created_at: "asc" },
    take: 200,
  });
  const byReferral = new Map<number, typeof due>();
  for (const m of due) byReferral.set(m.referral_id, [...(byReferral.get(m.referral_id) ?? []), m]);
  let sent = 0;
  for (const [referralId, msgs] of byReferral) {
    const r = msgs[0]!.referral;
    const read = await db.loan_chat_read.findUnique({
      where: { referral_id_user_id: { referral_id: referralId, user_id: r.partner_user_id } },
    });
    const unread = msgs.filter((m) => !read || m.created_at > read.read_at);
    if (unread.length > 0) {
      const latest = unread.at(-1)!;
      sent += await emailPartners(
        await recipientsFor([r.partner_user_id]),
        (to) =>
          loanChatEmail(to, {
            student: r.student_name,
            from: latest.author_name,
            text: latest.body,
            count: unread.length,
            url: `${appUrl()}${leadLink(r.public_id)}#chat`,
          }),
        "loan chat unread",
        "chat.message",
      );
    }
    await db.loan_referral_message.updateMany({
      where: { id: { in: msgs.map((m) => m.id) } },
      data: { emailed_at: new Date() },
    });
  }
  return sent;
}

// ── Loan documents (contract 5) ─────────────────────────────────────────────

export const DOC_MAX_FILES = 5;
export const DOC_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DOC_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

// PDF, JPEG or PNG by their first bytes; null for anything else.
export function sniffDocType(buf: Buffer): "application/pdf" | "image/jpeg" | "image/png" | null {
  if (buf.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  return null;
}

// Replaces the referral's document list with the one the Enrollment App sent
// (newest wins, claimed in the UPDATE so two deliveries can't interleave).
async function applyChecklist(referralId: number, at: Date, list: z.infer<typeof checklist>): Promise<void> {
  const claimed = await db.loan_referral.updateMany({
    where: { id: referralId, OR: [{ checklist_synced_at: null }, { checklist_synced_at: { lt: at } }] },
    data: { checklist_synced_at: at },
  });
  if (claimed.count === 0) return;
  const seen = new Set<string>();
  const rows = list
    .filter((i) => !seen.has(i.key) && seen.add(i.key))
    .map((i, sort) => ({
      referral_id: referralId,
      item_key: i.key,
      label: i.label,
      grp: i.group,
      required: i.required ? 1 : 0,
      converge_doc_type: i.convergeDocType ?? null,
      sort,
    }));
  await db.$transaction([
    db.loan_doc_item.deleteMany({ where: { referral_id: referralId } }),
    db.loan_doc_item.createMany({ data: rows }),
  ]);
}

// A counsellor accepted a document or asked for it again (newest wins). A
// re-upload request tells the referrer and the agency owner.
async function applyDocReview(
  r: { id: number; public_id: string; student_name: string; partner_user_id: number; org_id: number | null },
  review: z.infer<typeof docReview>,
): Promise<void> {
  const at = new Date(review.at);
  const upload = await db.loan_doc_upload.findFirst({ where: { public_id: review.documentId, referral_id: r.id } });
  if (!upload || (upload.reviewed_at && upload.reviewed_at >= at)) return;
  await db.loan_doc_upload.update({
    where: { id: upload.id },
    data: { review_status: review.status, review_reason: review.reason, reviewed_by: review.by, reviewed_at: at },
  });
  if (review.status === "reupload") {
    const item = await db.loan_doc_item.findUnique({
      where: { referral_id_item_key: { referral_id: r.id, item_key: upload.item_key } },
      select: { label: true },
    });
    await createNotifications(await referralAudience(r), {
      type: "loan_doc",
      title: `${r.student_name}: please upload ${item?.label ?? upload.label ?? "a document"} again`,
      body: review.reason ?? "The loan team asked for this document again.",
      link: `${leadLink(r.public_id)}#documents`,
      tone: "orange",
    });
  }
}

const docResponse = z.object({ result: z.literal("stored"), docId: z.string().min(1).max(80) });

// Sends one document upload (files inline, base64) to the Enrollment App.
// Never throws: the outcome is written on the row; failures retry from cron.
export async function sendLoanDocument(id: number): Promise<void> {
  const d = await db.loan_doc_upload.findUnique({
    where: { id },
    include: { referral: true, file: { orderBy: { id: "asc" } } },
  });
  if (d?.send_status !== LoanReferralSendStatus.SENDING) return;
  const url = env.ENROLLMENT_LOAN_URL;
  const secret = env.ENROLLMENT_LOAN_SECRET;
  let outcome: { ok: true } | { ok: false; permanent: boolean; error: string };
  if (!url || !secret) {
    outcome = { ok: false, permanent: false, error: "Loan sharing is not configured (ENROLLMENT_LOAN_URL / ENROLLMENT_LOAN_SECRET)" };
  } else if (!d.referral.loan_lead_id) {
    outcome = { ok: false, permanent: false, error: "The loan team hasn't received this referral yet" };
  } else {
    try {
      const files = await Promise.all(
        d.file.map(async (f) => ({
          name: f.file_name,
          contentType: f.content_type,
          size: f.size,
          sha256: f.sha256,
          data: (await readStoredFile(f.storage_ref)).toString("base64"),
        })),
      );
      const raw = JSON.stringify({
        type: "document",
        documentId: d.public_id,
        referralId: d.referral.public_id,
        loanLeadId: d.referral.loan_lead_id,
        typeKey: d.item_key,
        // Additional documents (typeKey "additional") carry the partner's label.
        ...(d.label ? { label: d.label } : {}),
        author: { userId: d.author_user_id ?? d.referral.partner_user_id, name: d.author_name },
        source: d.source,
        files,
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cp-timestamp": ts, "x-cp-signature": signBody(secret, ts, raw) },
        body: raw,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (res.ok) {
        outcome = docResponse.safeParse(safeJson(text)).success
          ? { ok: true }
          : { ok: false, permanent: false, error: `Unexpected reply: ${text.slice(0, 200)}` };
      } else {
        outcome = {
          ok: false,
          permanent: res.status === 400 || res.status === 404,
          error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
        };
      }
    } catch (e) {
      outcome = { ok: false, permanent: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const attempts = d.send_attempts + 1;
  if (outcome.ok) {
    await db.loan_doc_upload.update({
      where: { id: d.id },
      data: { send_status: LoanReferralSendStatus.RECEIVED, send_attempts: attempts, last_error: null, next_attempt_at: null },
    });
    return;
  }
  await db.loan_doc_upload.update({
    where: { id: d.id },
    data: outcome.permanent
      ? { send_status: LoanReferralSendStatus.FAILED, send_attempts: attempts, last_error: outcome.error.slice(0, 500), next_attempt_at: null }
      : {
          send_attempts: attempts,
          last_error: outcome.error.slice(0, 500),
          next_attempt_at: new Date(Date.now() + backoffMinutes(attempts) * 60_000),
        },
  });
  if (outcome.permanent && d.author_user_id) {
    await createNotifications([d.author_user_id], {
      type: "loan_doc",
      title: `A document for ${d.referral.student_name} could not be delivered`,
      body: "Open the loan to retry or upload it again.",
      link: `${leadLink(d.referral.public_id)}#documents`,
      tone: "red",
    });
  }
}

// ── Partner messages (Converge → Enrollment, contract 3b) ────────────────────

export const MESSAGE_MAX_TEXT = 2000;
export const MESSAGE_MAX_FILES = 3;
export const MESSAGE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MESSAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const messageResponse = z.object({ result: z.literal("stored"), activityId: z.string().min(1).max(64) });

// Sends one reply (files inline, base64) to the Enrollment App. Never throws:
// the outcome is written on the row; failures retry from the cron.
export async function sendPartnerMessage(id: number): Promise<void> {
  const m = await db.loan_referral_message.findUnique({
    where: { id },
    include: { referral: true, file: { orderBy: { id: "asc" } } },
  });
  if (m?.send_status !== LoanReferralSendStatus.SENDING) return;
  const url = env.ENROLLMENT_LOAN_URL;
  const secret = env.ENROLLMENT_LOAN_SECRET;
  let outcome: { ok: true; activityId: string } | { ok: false; permanent: boolean; error: string };
  if (!url || !secret) {
    outcome = { ok: false, permanent: false, error: "Loan sharing is not configured (ENROLLMENT_LOAN_URL / ENROLLMENT_LOAN_SECRET)" };
  } else if (!m.referral.loan_lead_id) {
    outcome = { ok: false, permanent: false, error: "The loan team hasn't received this referral yet" };
  } else {
    try {
      const files = await Promise.all(
        m.file.map(async (f) => ({
          name: f.file_name,
          contentType: "application/pdf",
          size: f.size,
          sha256: f.sha256,
          data: (await readStoredFile(f.storage_ref)).toString("base64"),
        })),
      );
      const raw = JSON.stringify({
        type: "message",
        messageId: m.public_id,
        referralId: m.referral.public_id,
        loanLeadId: m.referral.loan_lead_id,
        author: { userId: m.author_user_id ?? m.referral.partner_user_id, name: m.author_name },
        text: m.body,
        files,
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cp-timestamp": ts, "x-cp-signature": signBody(secret, ts, raw) },
        body: raw,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (res.ok) {
        const parsed = messageResponse.safeParse(safeJson(text));
        outcome = parsed.success
          ? { ok: true, activityId: parsed.data.activityId }
          : { ok: false, permanent: false, error: `Unexpected reply: ${text.slice(0, 200)}` };
      } else {
        // 400 (bad content) and 404 (lead not found) can't succeed on retry.
        outcome = {
          ok: false,
          permanent: res.status === 400 || res.status === 404,
          error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
        };
      }
    } catch (e) {
      outcome = { ok: false, permanent: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const attempts = m.send_attempts + 1;
  if (outcome.ok) {
    await db.loan_referral_message.update({
      where: { id: m.id },
      data: {
        send_status: LoanReferralSendStatus.RECEIVED,
        activity_id: outcome.activityId,
        send_attempts: attempts,
        last_error: null,
        next_attempt_at: null,
      },
    });
    return;
  }
  await db.loan_referral_message.update({
    where: { id: m.id },
    data: outcome.permanent
      ? { send_status: LoanReferralSendStatus.FAILED, send_attempts: attempts, last_error: outcome.error.slice(0, 500), next_attempt_at: null }
      : {
          send_attempts: attempts,
          last_error: outcome.error.slice(0, 500),
          next_attempt_at: new Date(Date.now() + backoffMinutes(attempts) * 60_000),
        },
  });
  if (outcome.permanent && m.author_user_id) {
    await createNotifications([m.author_user_id], {
      type: "loan_referral",
      title: `Your message about ${m.referral.student_name} could not be delivered`,
      body: "Open the loan to retry or send it again.",
      link: leadLink(m.referral.public_id),
      tone: "red",
    });
  }
}

// ── Receiving (Enrollment → Converge) ────────────────────────────────────────

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "bad date");
const stage = z.enum(LOAN_STAGES);
const money = z.number().finite().nonnegative().nullable();

const leadState = z.object({
  stage,
  counsellorName: z.string().max(150).nullable(),
  nextFollowUpAt: isoDate.nullable(),
  closureReason: z.string().max(255).nullable(),
  lastUpdateAt: isoDate.nullable(),
});

const applicationState = z.object({
  id: z.string().min(1).max(64),
  lender: z.string().min(1).max(150),
  status: stage,
  loanAmount: money,
  sanctionedAmount: money,
  roi: z.number().finite().min(0).max(100).nullable(),
  disbursedAmount: money,
  disbursedAt: isoDate.nullable(),
  // Optional per-tranche list (loan commission, 20 Nov 2026). Without it the
  // first disbursedAmount seen counts as the first tranche.
  tranches: z
    .array(z.object({ date: isoDate.nullable(), amount: money }))
    .max(50)
    .nullable()
    .optional(),
  deleted: z.boolean().optional(),
});

// Loan documents (contract 5): the lead's list and a counsellor's review.
const checklistItem = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  group: z.enum(["student", "coapplicant", "collateral"]),
  required: z.boolean(),
  convergeDocType: z.string().max(50).nullable().optional(),
});
const checklist = z.array(checklistItem).max(150);
const docReview = z.object({
  documentId: z.string().min(1).max(36),
  typeKey: z.string().min(1).max(80),
  status: z.enum(["accepted", "reupload"]),
  reason: z.string().max(500).nullable(),
  by: z.string().max(150).nullable(),
  at: isoDate,
});

// A counsellor note ticked "Share with partner" in the Enrollment App.
const sharedNote = z.object({
  type: z.literal("note"),
  noteId: z.string().min(1).max(64),
  text: z.string().max(2000),
  by: z.string().max(150).nullable(),
  at: isoDate,
});

const base = {
  eventId: z.string().min(1).max(120),
  referralId: z.string().min(1).max(36),
  loanLeadId: z.string().min(1).max(64),
  occurredAt: isoDate,
};

const enrollmentEvent = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("lead.updated"), lead: leadState }),
  z.object({
    ...base,
    kind: z.literal("timeline.added"),
    timeline: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("stage_change"),
        toStage: stage,
        by: z.string().max(150).nullable(),
        at: isoDate,
      }),
      sharedNote,
    ]),
  }),
  // A shared note edited, or un-shared / deleted (Phase 2, contract 3a).
  z.object({ ...base, kind: z.literal("timeline.updated"), timeline: sharedNote }),
  z.object({
    ...base,
    kind: z.literal("timeline.removed"),
    timeline: z.object({ type: z.literal("note"), noteId: z.string().min(1).max(64), at: isoDate }),
  }),
  z.object({ ...base, kind: z.literal("application.updated"), application: applicationState }),
  // The loan counsellor wrote in the lead's partner chat (contract 4b).
  z.object({
    ...base,
    kind: z.literal("chat.message"),
    chat: z.object({
      messageId: z.string().min(1).max(80),
      text: z.string().min(1).max(2000),
      by: z.string().max(150).nullable(),
      at: isoDate,
    }),
  }),
  z.object({
    ...base,
    kind: z.literal("snapshot"),
    lead: leadState,
    applications: z.array(applicationState).max(50),
    checklist: checklist.optional(),
  }),
  z.object({ ...base, kind: z.literal("docs.checklist"), checklist }),
  z.object({ ...base, kind: z.literal("docs.reviewed"), review: docReview }),
]);
export const enrollmentEventsBody = z.object({ events: z.array(z.unknown()).min(1).max(100) });
type EnrollmentEvent = z.infer<typeof enrollmentEvent>;
type ApplicationState = z.infer<typeof applicationState>;

// Stores and applies each event. Idempotent: an eventId already stored is
// ignored; a lead or application state older than what we hold is skipped.
// An event for a referral we don't know is ignored, not an error.
export async function applyEnrollmentEvents(rawEvents: unknown[]) {
  let accepted = 0;
  let ignored = 0;
  const invalid: string[] = [];
  for (const raw of rawEvents) {
    const parsed = enrollmentEvent.safeParse(raw);
    if (!parsed.success) {
      invalid.push(parsed.error.issues[0]?.message ?? "invalid event");
      continue;
    }
    if (await applyOne(parsed.data)) accepted++;
    else ignored++;
  }
  return { accepted, ignored, invalid };
}

async function applyOne(ev: EnrollmentEvent): Promise<boolean> {
  const r = await db.loan_referral.findUnique({ where: { public_id: ev.referralId } });
  // Only leads the Enrollment App created from our referral are mirrored;
  // duplicates (decision 2) never get progress.
  if (!r) return false;
  if (r.send_status !== LoanReferralSendStatus.RECEIVED && r.send_status !== LoanReferralSendStatus.SENDING) {
    return false;
  }
  const at = new Date(ev.occurredAt);
  let eventRowId: number;
  try {
    const row = await db.loan_referral_event.create({
      data: { referral_id: r.id, event_id: ev.eventId, kind: ev.kind, visible: 0, occurred_at: at },
    });
    eventRowId = row.id;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
  // An event can beat our own "received" reply (the intake answered, then our
  // response was lost): the lead exists, so treat the referral as received.
  if (r.send_status === LoanReferralSendStatus.SENDING) {
    await db.loan_referral.update({
      where: { id: r.id },
      data: {
        send_status: LoanReferralSendStatus.RECEIVED,
        loan_lead_id: ev.loanLeadId,
        received_at: new Date(),
        next_attempt_at: null,
        last_error: null,
      },
    });
  }

  switch (ev.kind) {
    case "lead.updated":
      await applyLeadState(r.id, at, ev.lead);
      break;
    case "snapshot": {
      // The snapshot repairs what a lost event missed; a stage it moves gets
      // its timeline entry here (no counsellor name: we don't know who).
      if ((await applyLeadState(r.id, at, ev.lead)) && r.stage !== ev.lead.stage) {
        await addOwnEvent(r.id, `cv:${r.public_id}:snapstage:${ev.lead.stage}:${at.getTime()}`, {
          kind: "stage_change",
          title: `Stage: ${loanStageLabel(ev.lead.stage)}`,
          at,
        });
      }
      for (const a of ev.applications) await applyApplication(r, at, a, null);
      if (ev.checklist) await applyChecklist(r.id, at, ev.checklist);
      const keep = ev.applications.map((a) => a.id);
      const gone = await db.loan_referral_application.findMany({
        where: { referral_id: r.id, external_id: { notIn: keep }, synced_at: { lt: at } },
        select: { external_id: true },
      });
      for (const g of gone) await commissionHook(() => onApplicationGone(r.id, g.external_id));
      await db.loan_referral_application.deleteMany({
        where: { referral_id: r.id, external_id: { notIn: keep }, synced_at: { lt: at } },
      });
      break;
    }
    case "timeline.updated":
    case "timeline.removed":
      await applySharedNote(r, at, ev.kind === "timeline.removed" ? null : ev.timeline, ev.timeline.noteId);
      break;
    case "timeline.added": {
      if (ev.timeline.type === "note") {
        await applySharedNote(r, at, ev.timeline, ev.timeline.noteId);
        break;
      }
      const label = loanStageLabel(ev.timeline.toStage);
      await db.loan_referral_event.update({
        where: { id: eventRowId },
        data: {
          visible: 1,
          title: `Stage: ${label}`,
          actor_name: ev.timeline.by,
          occurred_at: new Date(ev.timeline.at),
        },
      });
      await createNotifications(await referralAudience(r), {
        type: "loan_stage",
        title: `${r.student_name}: ${label}`,
        body: "Education loan update from Collegepond's loan team.",
        link: leadLink(r.public_id),
        tone: toneForStage(ev.timeline.toStage),
      });
      break;
    }
    case "application.updated":
      await applyApplication(r, at, ev.application, eventRowId);
      break;
    case "chat.message":
      await applyStaffChat(r, ev.chat);
      break;
    case "docs.checklist":
      await applyChecklist(r.id, at, ev.checklist);
      break;
    case "docs.reviewed":
      await applyDocReview(r, ev.review);
      break;
  }
  return true;
}

function toneForStage(s: LoanStage) {
  if (s === "sanctioned" || s === "pf_paid" || s === "disbursed") return "green" as const;
  if (s === "declined") return "red" as const;
  return "blue" as const;
}

async function applyLeadState(
  referralId: number,
  at: Date,
  lead: z.infer<typeof leadState>,
): Promise<boolean> {
  // Newer-wins, checked in the UPDATE itself so two deliveries can't race.
  const res = await db.loan_referral.updateMany({
    where: { id: referralId, OR: [{ lead_synced_at: null }, { lead_synced_at: { lt: at } }] },
    data: {
      stage: lead.stage,
      counsellor_name: lead.counsellorName,
      next_follow_up_at: lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt) : null,
      closure_reason: lead.closureReason,
      last_update_at: lead.lastUpdateAt ? new Date(lead.lastUpdateAt) : at,
      lead_synced_at: at,
    },
  });
  return res.count > 0;
}

// Upserts one lender application (newer-wins). When its status changes, the
// event row (if any) becomes a visible "<Lender>: <stage>" entry; sanction and
// disbursement also notify the referrer and the agency owner.
async function applyApplication(
  r: { id: number; public_id: string; student_name: string; partner_user_id: number; org_id: number | null },
  at: Date,
  a: ApplicationState,
  eventRowId: number | null,
): Promise<void> {
  const existing = await db.loan_referral_application.findUnique({
    where: { referral_id_external_id: { referral_id: r.id, external_id: a.id } },
  });
  if (existing && existing.synced_at >= at) return;
  if (a.deleted) {
    if (existing) {
      await commissionHook(() => onApplicationGone(r.id, a.id));
      await db.loan_referral_application.delete({ where: { id: existing.id } });
    }
    return;
  }
  const data = {
    lender: a.lender,
    status: a.status,
    loan_amount: a.loanAmount,
    sanctioned_amount: a.sanctionedAmount,
    roi: a.roi,
    disbursed_amount: a.disbursedAmount,
    disbursed_at: a.disbursedAt ? new Date(a.disbursedAt) : null,
    synced_at: at,
  };
  const row = existing
    ? await db.loan_referral_application.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.loan_referral_application.create({ data: { ...data, referral_id: r.id, external_id: a.id }, select: { id: true } });
  // Loan commission: a disbursement opens (or flags) its commission lines.
  await commissionHook(() => onApplicationSynced(r, a, row.id, at));
  if (existing?.status === a.status) return;
  const title = `${a.lender}: ${existing ? loanStageLabel(a.status) : `application added (${loanStageLabel(a.status)})`}`;
  if (eventRowId !== null) {
    await db.loan_referral_event.update({ where: { id: eventRowId }, data: { visible: 1, title } });
  } else {
    await addOwnEvent(r.id, `cv:${r.public_id}:app:${a.id}:${a.status}:${at.getTime()}`, {
      kind: "application.updated",
      title,
      at,
    });
  }
  if (a.status === "sanctioned" || a.status === "disbursed") {
    const audience = await referralAudience(r);
    await createNotifications(audience, {
      type: "loan_stage",
      title: `${r.student_name}: ${a.lender} ${a.status === "sanctioned" ? "sanctioned" : "disbursed"} the loan`,
      link: leadLink(r.public_id),
      tone: "green",
    });
    // Sanction and disbursement are the two loan updates that also go by
    // email (spec, open question 7: recommendation taken 19 Nov 2026).
    const kind = a.status;
    const amount = kind === "sanctioned" ? a.sanctionedAmount : a.disbursedAmount;
    await emailPartners(
      await recipientsFor(audience),
      (to) =>
        loanMilestoneEmail(to, {
          kind,
          student: r.student_name,
          lender: a.lender,
          amount,
          url: `${appUrl()}${leadLink(r.public_id)}`,
        }),
      `loan ${kind}`,
      "loan.milestone",
    );
  }
}

// A commission bug must never block the loan sync (the event would be retried
// forever); it is logged, and the nightly snapshot runs the hook again.
async function commissionHook(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("[loan-commission] sync hook failed:", e);
  }
}

// Active partner users among `ids`, as email recipients.
async function recipientsFor(ids: number[]): Promise<Recipient[]> {
  const users = await db.user.findMany({
    where: { id: { in: ids }, status: UserStatus.APPROVED, deleted_at: null },
    select: { id: true, email: true, first_name: true, last_name: true, organization: { select: { name: true } } },
  });
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: `${u.first_name} ${u.last_name}`.trim(),
    company: u.organization?.name ?? null,
  }));
}

// One timeline row per shared note (event_id "note:<referral>:<noteId>"),
// newest state wins. `note` null = un-shared or deleted: the row is hidden.
// The first time a note is shown, the referrer gets a bell.
async function applySharedNote(
  r: { id: number; public_id: string; student_name: string; partner_user_id: number },
  at: Date,
  note: { text: string; by: string | null; at: string } | null,
  noteId: string,
): Promise<void> {
  const eventId = `note:${r.public_id}:${noteId}`.slice(0, 120);
  const existing = await db.loan_referral_event.findUnique({ where: { event_id: eventId } });
  if (existing?.synced_at && existing.synced_at >= at) return;
  const text = note?.text.trim() ?? "";
  const visible = note && text ? 1 : 0;
  if (existing) {
    await db.loan_referral_event.update({
      where: { id: existing.id },
      data: { visible, body: visible ? text : existing.body, actor_name: note?.by ?? existing.actor_name, synced_at: at },
    });
  } else {
    await db.loan_referral_event.create({
      data: {
        referral_id: r.id,
        event_id: eventId,
        kind: "note",
        visible,
        title: "Update from the loan team",
        body: text || null,
        actor_name: note?.by ?? null,
        occurred_at: note ? new Date(note.at) : at,
        synced_at: at,
      },
    });
  }
  if (visible && !existing?.visible) {
    await createNotifications([r.partner_user_id], {
      type: "loan_note",
      title: `${r.student_name}: update from the loan team`,
      body: text.slice(0, 200),
      link: leadLink(r.public_id),
    });
  }
}
