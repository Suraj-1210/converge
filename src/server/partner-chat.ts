import "server-only";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { AdminRole, AdminRoleLabel, STUDENT_DOC_TYPES, UserType, isAdminRole } from "~/server/db/enums";
import {
  appUrl,
  partnerChatTatAlertEmail,
  partnerChatUnreadEmail,
  sendEmail,
} from "~/server/email";
import { createNotifications } from "~/server/notify";
import { activeOutOfOffice, responderFor } from "~/server/out-of-office";
import { notifyColleagueAction } from "~/server/counsellor-notify";
import { createStaffNotifications, markStaffNotificationsRead, upsertStaffNotification } from "~/server/staff-notify";
import {
  type ChatSide,
  type Person,
  isChatStaffRole,
  partnerParticipants,
  staffParticipants,
} from "~/server/partner-chat-access";
import { type StaffUser } from "~/server/staff-access";
import { documentChange, pendingDocChanges, recordPartnerChange } from "~/server/student-changes";
import { checkStudentDocFile, saveStudentDocument, studentDocTypeByKey } from "~/server/student-docs";
import { readStoredFile, resolveStorageUrl, saveBuffer } from "~/server/storage";
import {
  CHAT_RESPONSE,
  businessMinutesBetween,
  getChatAckRules,
  getTatConfig,
  getTatTarget,
  tatClock,
} from "~/server/tat";
import { fmtMinutes, type TatStatus } from "~/lib/tat";
import { type AckRules, isAcknowledgement } from "~/lib/partner-chat-rules";
import {
  DEFAULT_NOTIFICATION_PREF,
  type NotificationPref,
  notificationPrefCode,
} from "~/lib/constants/notification-prefs";

// Partner ↔ Collegepond chat, one thread per student (decided with Suraj,
// 14 and 17 Oct 2026). It's separate from the student WhatsApp chat
// (routers/chat.ts, Periskope). Who may take part is decided in
// partner-chat-access.ts; this module trusts that its caller checked.
//
//  - Delivery: the browser polls while a thread is open (no websockets).
//  - Messages: no deletes. The sender may edit within 5 minutes, and every
//    edit is audit-logged with the old text.
//  - System messages (e.g. "saved to Documents") are neutral. They aren't
//    unread, and they never start or stop the TAT clock.
//  - TAT ("chat_response", src/server/tat.ts): the clock starts at the first
//    partner message without a Collegepond reply and stops at the next
//    Collegepond message. Only business hours count. Short acknowledgements
//    ("thanks", 👍; src/lib/partner-chat-rules.ts) don't start it, and a
//    message a Collegepond user marked "No reply needed" doesn't hold it
//    (24 Oct 2026).
//  - Out of office (out-of-office.ts): while the student's counsellor is out,
//    their alternate is the one waited on: bell, emails, TAT alerts and the
//    reply's TAT attribution go to the alternate.
//  - Notifications: a partner bell item per thread (respecting the "chat.message"
//    preference); a staff in-app item per thread for whoever answers it
//    (cp_notification); admin bell items derived from state (staffChatSignals); an
//    email when a message has stayed unread for 15 minutes; TAT warning and
//    breach emails. These run from runChatJobs (a timer, plus polling).

export type ChatActor =
  | { side: "partner"; id: number; impersonatorId: number | null }
  | { side: "staff"; id: number; role: number; impersonatorId: number | null };

export const EDIT_WINDOW_MS = 5 * 60 * 1000;
export const UNREAD_EMAIL_AFTER_MS = 15 * 60 * 1000;
const MAX_BODY = 4000;
const THREAD_LIMIT = 500;
const NOTIFICATION_TYPE = "chat.message";

const other = (side: ChatSide): ChatSide => (side === "partner" ? "staff" : "partner");
const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

export const partnerChatLink = (studentId: number) => `/partner/students/${studentId}?tab=chat`;
export const staffChatLink = (studentId: number) => `/admin/students/${studentId}?tab=partner-chat`;

function preview(body: string | null, fileNames: string[]): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 180 ? `${text.slice(0, 179)}…` : text;
  if (fileNames.length) return `Attachment: ${fileNames.join(", ")}`.slice(0, 180);
  return "";
}

async function ensureThread(studentId: number) {
  return db.partner_chat_thread.upsert({
    where: { student_id: studentId },
    create: { student_id: studentId },
    update: {},
  });
}

// ---- Names ---------------------------------------------------------------------

const PARTNER_KIND: Record<number, string> = {
  [UserType.AGENCY_OWNER]: "Agency owner",
  [UserType.AGENCY_COUNSELLOR]: "Agency counsellor",
  [UserType.INDEPENDENT_COUNSELLOR]: "Independent counsellor",
};

async function senderNames(msgs: { sender_user_id: number | null; sender_cp_user_id: number | null }[]) {
  const uIds = [...new Set(msgs.map((m) => m.sender_user_id).filter((x): x is number => x !== null))];
  const cIds = [...new Set(msgs.map((m) => m.sender_cp_user_id).filter((x): x is number => x !== null))];
  const [users, cps] = await Promise.all([
    uIds.length
      ? db.user.findMany({ where: { id: { in: uIds } }, select: { id: true, first_name: true, last_name: true, type: true } })
      : Promise.resolve([]),
    cIds.length
      ? db.collegepond_user.findMany({ where: { id: { in: cIds } }, select: { id: true, first_name: true, last_name: true, role: true } })
      : Promise.resolve([]),
  ]);
  return {
    partner: new Map(users.map((u) => [u.id, { name: fullName(u), role: PARTNER_KIND[u.type] ?? "Partner" }])),
    staff: new Map(
      cps.map((c) => [c.id, { name: fullName(c), role: `Collegepond · ${isAdminRole(c.role) ? AdminRoleLabel[c.role] : "Staff"}` }]),
    ),
  };
}

// ---- Thread view ---------------------------------------------------------------

export async function getThread(actor: ChatActor, studentId: number) {
  const thread = await db.partner_chat_thread.findUnique({ where: { student_id: studentId } });
  const [pp, sp] = await Promise.all([partnerParticipants(studentId), staffParticipants(studentId)]);
  const participants = {
    partner: pp.all.map((p) => fullName(p)),
    collegepond: [
      ...(sp.counsellor ? [`${fullName(sp.counsellor)} (counsellor)`] : []),
      ...(sp.lead ? [`${fullName(sp.lead)} (Counselling Lead)`] : []),
    ],
  };
  // Shown to both sides: "<Name> is out of office <dates>. Contact <Alternate>".
  const outOfOffice = sp.outOfOffice.map((o) => ({
    name: o.name,
    dates: o.dates,
    alternate: { name: o.alternate.name, email: o.alternate.email, phone: o.alternate.phone },
  }));
  if (!thread) {
    return { messages: [], participants, outOfOffice, tat: null, myLastReadId: 0, otherSideReadId: 0, lastMessageId: 0 };
  }

  const rows = (
    await db.partner_chat_message.findMany({
      where: { thread_id: thread.id },
      orderBy: { id: "desc" },
      take: THREAD_LIMIT,
      include: { attachment: { orderBy: { id: "asc" } } },
    })
  ).reverse();
  const names = await senderNames(rows);
  const reads = await db.partner_chat_read.findMany({ where: { thread_id: thread.id } });
  const myLastReadId = reads.find((r) => r.side === actor.side && r.reader_id === actor.id)?.last_read_message_id ?? 0;
  const otherSideReadId = Math.max(0, ...reads.filter((r) => r.side === other(actor.side)).map((r) => r.last_read_message_id));
  const docLabel = new Map(STUDENT_DOC_TYPES.map((d) => [d.key, d.label]));
  const savedIds = rows.flatMap((m) => m.attachment.map((a) => a.saved_document_id)).filter((x): x is number => x !== null);
  const savedDocs = savedIds.length
    ? await db.document.findMany({ where: { id: { in: savedIds } }, select: { id: true, doc_type: true } })
    : [];

  const now = Date.now();
  // Reply-time markers, for the Collegepond side only.
  const ackRules = actor.side === "staff" ? await getChatAckRules() : null;
  const lastStaffId = Math.max(0, ...rows.filter((m) => m.kind === "user" && m.sender_side === "staff").map((m) => m.id));
  const markers = rows.flatMap((m) => (m.no_reply_needed_by_cp_user_id !== null ? [m.no_reply_needed_by_cp_user_id] : []));
  const markerNames = markers.length
    ? new Map(
        (
          await db.collegepond_user.findMany({
            where: { id: { in: [...new Set(markers)] } },
            select: { id: true, first_name: true, last_name: true },
          })
        ).map((c) => [c.id, fullName(c)]),
      )
    : new Map<number, string>();
  const messages = rows.map((m) => {
    const side = m.sender_side as ChatSide | "system";
    const who =
      side === "partner" && m.sender_user_id !== null
        ? names.partner.get(m.sender_user_id)
        : side === "staff" && m.sender_cp_user_id !== null
          ? names.staff.get(m.sender_cp_user_id)
          : undefined;
    const mine =
      m.kind === "user" &&
      side === actor.side &&
      (actor.side === "partner" ? m.sender_user_id === actor.id : m.sender_cp_user_id === actor.id);
    return {
      id: m.id,
      kind: m.kind as "user" | "system",
      side,
      senderName: who?.name ?? (side === "system" ? "System" : "Former user"),
      senderRole: who?.role ?? null,
      mine,
      body: m.body,
      createdAt: m.created_at.toISOString(),
      editedAt: m.edited_at?.toISOString() ?? null,
      canEdit: mine && now - m.created_at.getTime() < EDIT_WINDOW_MS,
      // For my side's messages: has anyone on the other side read it?
      seen: m.kind === "user" && side === actor.side && otherSideReadId >= m.id,
      replyMinutes: actor.side === "staff" ? m.tat_business_minutes : null,
      // A partner message that doesn't start the reply clock (staff only).
      ack:
        ackRules !== null && m.kind === "user" && side === "partner" && isAcknowledgement(m.body, m.attachment.length > 0, ackRules),
      noReplyNeeded:
        actor.side === "staff" && m.no_reply_needed_at
          ? {
              at: m.no_reply_needed_at.toISOString(),
              by:
                m.no_reply_needed_by_cp_user_id !== null
                  ? (markerNames.get(m.no_reply_needed_by_cp_user_id) ?? "Former user")
                  : "Former user",
            }
          : null,
      // Partner messages after the last Collegepond reply can be marked
      // "No reply needed" (or unmarked).
      canMarkNoReply: actor.side === "staff" && m.kind === "user" && side === "partner" && m.id > lastStaffId,
      attachments: m.attachment.map((a) => {
        const saved = savedDocs.find((d) => d.id === a.saved_document_id);
        return {
          id: a.id,
          fileName: a.file_name,
          url: resolveStorageUrl(a.file_url),
          sizeBytes: a.size_bytes,
          mimeType: a.mime_type,
          savedAs: saved ? (docLabel.get(saved.doc_type) ?? saved.doc_type) : a.saved_at ? "Documents" : null,
        };
      }),
    };
  });

  // The Collegepond side sees the TAT clock on a waiting thread.
  let tat: { since: string; elapsedMinutes: number; thresholdMinutes: number; status: TatStatus; dueAt: string | null } | null = null;
  if (actor.side === "staff" && thread.awaiting_since) {
    const target = await getTatTarget(CHAT_RESPONSE);
    if (target) {
      const c = tatClock(thread.awaiting_since, new Date(), target, await getTatConfig());
      tat = {
        since: thread.awaiting_since.toISOString(),
        elapsedMinutes: c.elapsedMinutes,
        thresholdMinutes: target.thresholdMinutes,
        status: c.status,
        dueAt: c.dueAt?.toISOString() ?? null,
      };
    }
  }

  void runChatJobs();
  return { messages, participants, outOfOffice, tat, myLastReadId, otherSideReadId, lastMessageId: thread.last_message_id ?? 0 };
}

// ---- Sending ---------------------------------------------------------------------

export async function sendMessage(
  actor: ChatActor,
  studentId: number,
  input: { body?: string; attachmentIds?: number[]; fileAs?: { attachmentId: number; docType: string }[] },
) {
  const body = (input.body ?? "").trim();
  if (body.length > MAX_BODY) throw bad(`Messages can be up to ${MAX_BODY} characters.`);
  const attIds = [...new Set(input.attachmentIds ?? [])];
  if (!body && attIds.length === 0) throw bad("Type a message or attach a file.");
  // "Send and save to documents": a type per attachment ("" = chat only),
  // checked before anything is sent.
  const fileAs: { attachmentId: number; docType: { key: string; multiple: boolean } }[] = [];
  for (const f of input.fileAs ?? []) {
    if (!f.docType) continue;
    const docType = studentDocTypeByKey(f.docType);
    if (!docType) throw bad("Unknown document type.");
    if (!attIds.includes(f.attachmentId)) throw bad("A file to save isn't attached to this message.");
    fileAs.push({ attachmentId: f.attachmentId, docType });
  }

  const thread = await ensureThread(studentId);
  const atts = attIds.length
    ? await db.partner_chat_attachment.findMany({
        where: {
          id: { in: attIds },
          thread_id: thread.id,
          message_id: null,
          uploaded_side: actor.side,
          ...(actor.side === "partner" ? { uploaded_by_user_id: actor.id } : { uploaded_by_cp_user_id: actor.id }),
        },
        select: { id: true, file_name: true },
      })
    : [];
  if (atts.length !== attIds.length) throw bad("An attachment is missing or was already sent. Attach it again.");

  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { cp_counsellor_id: true },
  });
  // The reply's TAT counts against whoever answers for the counsellor today
  // (their alternate while they're out of office).
  const tatOwner = await responderFor(student?.cp_counsellor_id ?? null);
  // A short acknowledgement from the partner doesn't start the clock.
  const ack = actor.side === "partner" && isAcknowledgement(body, atts.length > 0, await getChatAckRules());
  const now = new Date();
  const msg = await db.$transaction(async (tx) => {
    const t = await tx.partner_chat_thread.findUniqueOrThrow({ where: { id: thread.id } });
    const m = await tx.partner_chat_message.create({
      data: {
        thread_id: thread.id,
        kind: "user",
        sender_side: actor.side,
        sender_user_id: actor.side === "partner" ? actor.id : null,
        sender_cp_user_id: actor.side === "staff" ? actor.id : null,
        impersonator_cp_user_id: actor.impersonatorId,
        body: body || null,
        created_at: now,
      },
    });
    if (atts.length) {
      await tx.partner_chat_attachment.updateMany({
        where: { id: { in: atts.map((a) => a.id) }, message_id: null },
        data: { message_id: m.id },
      });
    }
    await tx.partner_chat_thread.update({
      where: { id: thread.id },
      data: {
        last_message_id: m.id,
        last_message_at: now,
        last_sender_side: actor.side,
        last_preview: preview(body, atts.map((a) => a.file_name)),
      },
    });
    if (actor.side === "partner") {
      // Starts the clock unless it's already running, or this is only an
      // acknowledgement.
      if (!ack) {
        await tx.partner_chat_thread.updateMany({
          where: { id: thread.id, awaiting_since: null },
          data: { awaiting_since: now, awaiting_message_id: m.id },
        });
      }
    } else if (t.awaiting_since) {
      // A Collegepond reply stops it. Conditional, so two replies racing
      // record the wait only once.
      const closed = await tx.partner_chat_thread.updateMany({
        where: { id: thread.id, awaiting_since: t.awaiting_since },
        data: { awaiting_since: null, awaiting_message_id: null, tat_warned_at: null, tat_breached_at: null },
      });
      if (closed.count === 1) {
        await tx.partner_chat_message.update({
          where: { id: m.id },
          data: {
            tat_started_at: t.awaiting_since,
            tat_business_minutes: businessMinutesBetween(t.awaiting_since, now, await getTatConfig()),
            tat_counsellor_cp_user_id: tatOwner,
          },
        });
      }
    }
    return m;
  });

  // Replying means you've seen what came before. Not while impersonating, so
  // a Super Admin's look never shows up as the user's read receipt.
  if (!actor.impersonatorId) await advanceRead(thread.id, actor, msg.id);
  if (actor.side === "staff") {
    await notifyPartnersInApp(studentId, thread.id);
    if (!actor.impersonatorId) await markStaffNotificationsRead(actor.id, NOTIFICATION_TYPE, staffChatLink(studentId));
    // A lead or Super Admin replying on a counsellor's student: the
    // counsellor hears (rolling, once a day per colleague).
    void notifyColleagueAction(studentId, actor.id, "Replied in partner chat", { tab: "partner-chat" });
  } else {
    await notifyStaffInApp(studentId);
  }
  const filed = fileAs.length ? await fileAttachments(actor, fileAs) : [];
  void runChatJobs();
  return { id: msg.id, filed };
}

// A neutral line in the thread ("X saved file.pdf to Documents"). Not
// unread, and no effect on TAT.
export async function addSystemMessage(threadId: number, text: string) {
  const now = new Date();
  const m = await db.partner_chat_message.create({
    data: { thread_id: threadId, kind: "system", sender_side: "system", body: text.slice(0, MAX_BODY), created_at: now },
  });
  await db.partner_chat_thread.update({
    where: { id: threadId },
    data: { last_message_id: m.id, last_message_at: now, last_sender_side: "system", last_preview: preview(text, []) },
  });
  return m;
}

// ---- Editing -----------------------------------------------------------------------

export async function messageStudentId(messageId: number): Promise<number> {
  const m = await db.partner_chat_message.findUnique({
    where: { id: messageId },
    select: { thread: { select: { student_id: true } } },
  });
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });
  return m.thread.student_id;
}

export async function editMessage(actor: ChatActor, messageId: number, newBody: string) {
  const body = newBody.trim();
  if (body.length > MAX_BODY) throw bad(`Messages can be up to ${MAX_BODY} characters.`);
  const m = await db.partner_chat_message.findUnique({
    where: { id: messageId },
    include: { thread: { select: { id: true, student_id: true, last_message_id: true } }, attachment: { select: { id: true } } },
  });
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });
  const mine =
    m.kind === "user" &&
    m.sender_side === actor.side &&
    (actor.side === "partner" ? m.sender_user_id === actor.id : m.sender_cp_user_id === actor.id);
  if (!mine) throw new TRPCError({ code: "FORBIDDEN", message: "You can only edit your own messages." });
  if (Date.now() - m.created_at.getTime() >= EDIT_WINDOW_MS) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Messages can only be edited within 5 minutes of sending." });
  }
  if (!body && m.attachment.length === 0) throw bad("A message can't be empty. Messages can't be deleted.");
  if (body === (m.body ?? "")) return { ok: true as const };

  const now = new Date();
  await db.partner_chat_message.update({ where: { id: m.id }, data: { body: body || null, edited_at: now } });
  // An edit can turn "thanks" into a question, or the other way round.
  if (m.sender_side === "partner") await recomputeAwaiting(m.thread.id);
  await db.partner_chat_thread.update({
    where: { id: m.thread.id },
    data: {
      updated_at: now,
      ...(m.thread.last_message_id === m.id ? { last_preview: preview(body, []) } : {}),
    },
  });
  await db.audit_log.create({
    data: {
      action: "partner_chat.message_edited",
      entity_type: "student",
      entity_id: m.thread.student_id,
      ...(actor.side === "partner" ? { user_id: actor.id } : {}),
      metadata: {
        messageId: m.id,
        side: actor.side,
        ...(actor.side === "partner" ? { byPartnerUserId: actor.id } : { byCpUserId: actor.id }),
        before: m.body,
        after: body,
      },
    },
  });
  return { ok: true as const };
}

// ---- Reading -----------------------------------------------------------------------

async function advanceRead(threadId: number, actor: ChatActor, upTo: number) {
  await db.partner_chat_read.upsert({
    where: { thread_id_side_reader_id: { thread_id: threadId, side: actor.side, reader_id: actor.id } },
    create: { thread_id: threadId, side: actor.side, reader_id: actor.id, last_read_message_id: upTo, read_at: new Date() },
    update: {},
  });
  await db.partner_chat_read.updateMany({
    where: { thread_id: threadId, side: actor.side, reader_id: actor.id, last_read_message_id: { lt: upTo } },
    data: { last_read_message_id: upTo, read_at: new Date() },
  });
}

export async function markRead(actor: ChatActor, studentId: number, upToId: number) {
  if (actor.impersonatorId) return { ok: true as const, skipped: "impersonating" as const };
  const thread = await db.partner_chat_thread.findUnique({
    where: { student_id: studentId },
    select: { id: true, last_message_id: true },
  });
  if (!thread?.last_message_id) return { ok: true as const };
  await advanceRead(thread.id, actor, Math.min(upToId, thread.last_message_id));
  if (actor.side === "partner") {
    await db.notification.updateMany({
      where: { user_id: actor.id, type: NOTIFICATION_TYPE, link: partnerChatLink(studentId), read_at: null },
      data: { read_at: new Date() },
    });
  } else {
    await markStaffNotificationsRead(actor.id, NOTIFICATION_TYPE, staffChatLink(studentId));
  }
  return { ok: true as const };
}

// ---- Reply clock -------------------------------------------------------------------

// Puts the thread's reply clock where the rules say it should be: at the
// first partner message after the last Collegepond reply that is neither an
// acknowledgement nor marked "No reply needed"; stopped if there's none. A
// clock that moves starts its warning and breach alerts afresh.
export async function recomputeAwaiting(threadId: number, rules?: AckRules) {
  const ackRules = rules ?? (await getChatAckRules());
  const lastStaff = await db.partner_chat_message.findFirst({
    where: { thread_id: threadId, kind: "user", sender_side: "staff" },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  const candidates = await db.partner_chat_message.findMany({
    where: {
      thread_id: threadId,
      kind: "user",
      sender_side: "partner",
      id: { gt: lastStaff?.id ?? 0 },
      no_reply_needed_at: null,
    },
    orderBy: { id: "asc" },
    select: { id: true, body: true, created_at: true, _count: { select: { attachment: true } } },
  });
  const first = candidates.find((c) => !isAcknowledgement(c.body, c._count.attachment > 0, ackRules)) ?? null;
  const t = await db.partner_chat_thread.findUnique({
    where: { id: threadId },
    select: { awaiting_message_id: true },
  });
  if (!t || t.awaiting_message_id === (first?.id ?? null)) return;
  await db.partner_chat_thread.update({
    where: { id: threadId },
    data: {
      awaiting_since: first?.created_at ?? null,
      awaiting_message_id: first?.id ?? null,
      tat_warned_at: null,
      tat_breached_at: null,
    },
  });
}

// "No reply needed" on a partner message (Collegepond only): it stops holding
// the reply clock. `on: false` undoes it. Audit-logged.
export async function setNoReplyNeeded(actor: ChatActor, messageId: number, on: boolean) {
  if (actor.side !== "staff") throw new TRPCError({ code: "FORBIDDEN", message: "Only Collegepond can do this." });
  const m = await db.partner_chat_message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      kind: true,
      sender_side: true,
      no_reply_needed_at: true,
      thread: { select: { id: true, student_id: true } },
    },
  });
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });
  if (m.kind !== "user" || m.sender_side !== "partner") {
    throw bad("Only partner messages can be marked “No reply needed”.");
  }
  if (on === (m.no_reply_needed_at !== null)) return { ok: true as const };
  const by = actor.impersonatorId ?? actor.id;
  await db.partner_chat_message.update({
    where: { id: m.id },
    data: on
      ? { no_reply_needed_at: new Date(), no_reply_needed_by_cp_user_id: by }
      : { no_reply_needed_at: null, no_reply_needed_by_cp_user_id: null },
  });
  await recomputeAwaiting(m.thread.id);
  await db.audit_log.create({
    data: {
      action: on ? "partner_chat.no_reply_needed" : "partner_chat.no_reply_needed_undone",
      entity_type: "student",
      entity_id: m.thread.student_id,
      metadata: { messageId: m.id, byCpUserId: by, ...(by !== actor.id ? { asCpUserId: actor.id } : {}) },
    },
  });
  return { ok: true as const };
}

// Unread messages (from the other side, user messages after this person's
// read position) per thread.
async function unreadByThread(actor: ChatActor, threadIds: number[]): Promise<Map<number, number>> {
  const ids = threadIds.filter((x) => Number.isInteger(x));
  if (ids.length === 0) return new Map();
  // Positional placeholders rather than Prisma.join: in the Next bundle the
  // generated client didn't recognise Prisma.join's fragment, and IN (...)
  // silently matched nothing. All values are bound, never interpolated.
  const rows = await db.$queryRawUnsafe<{ thread_id: number; n: bigint }[]>(
    `SELECT m.thread_id, COUNT(*) AS n
     FROM partner_chat_message m
     LEFT JOIN partner_chat_read r
       ON r.thread_id = m.thread_id AND r.side = ? AND r.reader_id = ?
     WHERE m.thread_id IN (${ids.map(() => "?").join(", ")})
       AND m.kind = 'user'
       AND m.sender_side = ?
       AND m.id > COALESCE(r.last_read_message_id, 0)
     GROUP BY m.thread_id`,
    actor.side,
    actor.id,
    ...ids,
    other(actor.side),
  );
  return new Map(rows.map((r) => [Number(r.thread_id), Number(r.n)]));
}

export async function unreadThreadCount(actor: ChatActor, scope: Prisma.studentWhereInput): Promise<number> {
  const threads = await db.partner_chat_thread.findMany({
    where: { student: scope, last_message_id: { not: null } },
    select: { id: true },
  });
  const unread = await unreadByThread(actor, threads.map((t) => t.id));
  return [...unread.values()].filter((n) => n > 0).length;
}

// ---- Inbox -----------------------------------------------------------------------

export type InboxFilter = "all" | "unread" | "awaiting" | "overdue";

export async function inbox(
  actor: ChatActor,
  scope: Prisma.studentWhereInput,
  opts: { filter: InboxFilter; q?: string },
) {
  const q = opts.q?.trim();
  const studentWhere: Prisma.studentWhereInput = q
    ? {
        AND: [
          scope,
          {
            OR: [
              { first_name: { contains: q } },
              { last_name: { contains: q } },
              ...(/^(cp-?)?\d+$/i.test(q) ? [{ id: Number(q.replace(/\D/g, "")) }] : []),
            ],
          },
        ],
      }
    : scope;
  const threads = await db.partner_chat_thread.findMany({
    where: {
      student: studentWhere,
      last_message_id: { not: null },
      ...(opts.filter === "awaiting" || opts.filter === "overdue" ? { awaiting_since: { not: null } } : {}),
    },
    orderBy: { last_message_at: "desc" },
    take: 300,
    select: {
      id: true,
      student_id: true,
      last_message_at: true,
      last_preview: true,
      last_sender_side: true,
      awaiting_since: true,
      student: {
        select: {
          first_name: true,
          last_name: true,
          organization: { select: { name: true } },
          user: { select: { first_name: true, last_name: true } },
          cp_counsellor: { select: { id: true, first_name: true, last_name: true } },
          created_by: { select: { first_name: true, last_name: true } },
        },
      },
    },
  });
  const unread = await unreadByThread(actor, threads.map((t) => t.id));
  // "Priya (out of office → Rahul)" on the Collegepond side.
  const ooo = actor.side === "staff" ? await activeOutOfOffice() : new Map<number, unknown>();
  const coverIds = new Map<number, number>();
  for (const t of threads) {
    const c = t.student.cp_counsellor;
    if (c && ooo.has(c.id)) coverIds.set(c.id, await responderFor(c.id));
  }
  const coverNames = coverIds.size
    ? new Map(
        (
          await db.collegepond_user.findMany({
            where: { id: { in: [...new Set(coverIds.values())] } },
            select: { id: true, first_name: true, last_name: true },
          })
        ).map((c) => [c.id, fullName(c)]),
      )
    : new Map<number, string>();
  const counsellorLabel = (c: { id: number; first_name: string; last_name: string } | null) => {
    if (!c) return null;
    const cover = coverIds.get(c.id);
    const coverName = cover !== undefined && cover !== c.id ? coverNames.get(cover) : undefined;
    return coverName ? `${fullName(c)} (out of office → ${coverName})` : fullName(c);
  };
  const target = actor.side === "staff" ? await getTatTarget(CHAT_RESPONSE) : null;
  const cfg = target ? await getTatConfig() : null;
  const now = new Date();

  const rows = threads.map((t) => {
    const clock = target && cfg && t.awaiting_since ? tatClock(t.awaiting_since, now, target, cfg) : null;
    const s = t.student;
    return {
      studentId: t.student_id,
      studentName: fullName(s),
      partnerName: s.organization?.name ?? (s.created_by ? fullName(s.created_by) : "—"),
      partnerCounsellor: s.user ? fullName(s.user) : null,
      cpCounsellor: counsellorLabel(s.cp_counsellor),
      lastAt: t.last_message_at?.toISOString() ?? null,
      lastPreview: t.last_preview ?? "",
      lastSide: t.last_sender_side,
      unread: unread.get(t.id) ?? 0,
      awaiting: clock
        ? {
            since: t.awaiting_since!.toISOString(),
            elapsedMinutes: clock.elapsedMinutes,
            label: fmtMinutes(clock.elapsedMinutes),
            status: clock.status,
          }
        : null,
    };
  });
  if (opts.filter === "unread") return rows.filter((r) => r.unread > 0);
  if (opts.filter === "overdue") return rows.filter((r) => r.awaiting?.status === "Breached");
  return rows;
}

// ---- Attachments -----------------------------------------------------------------

export async function createAttachment(actor: ChatActor, studentId: number, file: File) {
  const invalid = checkStudentDocFile(file);
  if (invalid) return { error: invalid.error, status: invalid.status } as const;
  const thread = await ensureThread(studentId);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  const buffer = Buffer.from(await file.arrayBuffer());
  // Student files are private: served through /api/files with a chat check.
  const stored = await saveBuffer(buffer, `chat/${studentId}/${Date.now()}-${safeName}`, {
    contentType: file.type || undefined,
    public: false,
  });
  const a = await db.partner_chat_attachment.create({
    data: {
      thread_id: thread.id,
      uploaded_side: actor.side,
      uploaded_by_user_id: actor.side === "partner" ? actor.id : null,
      uploaded_by_cp_user_id: actor.side === "staff" ? actor.id : null,
      file_name: file.name.slice(0, 255),
      file_url: stored.url,
      mime_type: file.type || null,
      size_bytes: file.size,
    },
  });
  return { id: a.id, fileName: a.file_name, sizeBytes: a.size_bytes, mimeType: a.mime_type } as const;
}

export async function attachmentStudentId(attachmentId: number): Promise<number> {
  const a = await db.partner_chat_attachment.findUnique({
    where: { id: attachmentId },
    select: { thread: { select: { student_id: true } } },
  });
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
  return a.thread.student_id;
}

// The student a private chat file (storage key "chat/…") belongs to, for the
// /api/files access check; null if no attachment has that key.
export async function chatFileStudentId(key: string): Promise<number | null> {
  const a = await db.partner_chat_attachment.findFirst({
    where: { file_url: key },
    select: { thread: { select: { student_id: true } } },
  });
  return a?.thread.student_id ?? null;
}

// "Save to student documents": copies sent chat files into the student's
// document checklist under fixed document types, through the same path as a
// profile upload (audit log; a partner's save also reaches Collegepond's
// counselling team like any partner upload). Each file is saved once. One
// system line in the thread lists everything filed. Per file, a failure is
// reported rather than thrown, so one bad file doesn't undo the others.
export type FiledResult = { attachmentId: number; fileName: string; label: string | null; error: string | null };

async function fileAttachments(
  actor: ChatActor,
  items: { attachmentId: number; docType: { key: string; multiple: boolean } }[],
): Promise<FiledResult[]> {
  const results: FiledResult[] = [];
  const changes: { studentId: number; change: ReturnType<typeof documentChange> }[] = [];
  let threadId: number | null = null;
  for (const it of items) {
    const label = STUDENT_DOC_TYPES.find((d) => d.key === it.docType.key)?.label ?? it.docType.key;
    const a = await db.partner_chat_attachment.findUnique({
      where: { id: it.attachmentId },
      include: { thread: { select: { id: true, student_id: true } } },
    });
    if (!a?.message_id) {
      results.push({ attachmentId: it.attachmentId, fileName: a?.file_name ?? "File", label: null, error: "File not found" });
      continue;
    }
    threadId = a.thread.id;
    const claim = await db.partner_chat_attachment.updateMany({
      where: { id: a.id, saved_at: null },
      data: { saved_at: new Date() },
    });
    if (claim.count === 0) {
      results.push({ attachmentId: a.id, fileName: a.file_name, label: null, error: "Already saved to the student's documents" });
      continue;
    }
    try {
      const bytes = new Uint8Array(await readStoredFile(a.file_url));
      const file = new File([bytes], a.file_name, { type: a.mime_type ?? "" });
      const doc = await saveStudentDocument(a.thread.student_id, it.docType, file, {
        via: "partner_chat",
        chatAttachmentId: a.id,
        ...(actor.side === "partner" ? { byPartnerUserId: actor.id } : { byCpUserId: actor.id }),
      });
      await db.partner_chat_attachment.update({ where: { id: a.id }, data: { saved_document_id: doc.id } });
      changes.push({ studentId: a.thread.student_id, change: documentChange(it.docType.key, a.file_name) });
      // Documents Pending items this save ticked off (saveStudentDocument).
      for (const change of pendingDocChanges(doc.ticks)) changes.push({ studentId: a.thread.student_id, change });
      results.push({ attachmentId: a.id, fileName: a.file_name, label, error: null });
    } catch (e) {
      await db.partner_chat_attachment.update({ where: { id: a.id }, data: { saved_at: null } });
      console.error("[partner-chat] save to documents failed:", e instanceof Error ? e.message : e);
      results.push({ attachmentId: a.id, fileName: a.file_name, label: null, error: "Couldn't save the file. Try again." });
    }
  }

  const saved = results.filter((r) => r.label);
  if (saved.length && threadId !== null) {
    if (actor.side === "partner") {
      const studentId = changes[0]!.studentId;
      await recordPartnerChange(studentId, actor.id, "documents", changes.map((c) => c.change));
    }
    const who =
      actor.side === "partner"
        ? await db.user.findUnique({ where: { id: actor.id }, select: { first_name: true, last_name: true } })
        : await db.collegepond_user.findUnique({ where: { id: actor.id }, select: { first_name: true, last_name: true } });
    const name = who ? fullName(who) : "Someone";
    await addSystemMessage(
      threadId,
      saved.length === 1
        ? `${name} saved “${saved[0]!.fileName}” to Documents → ${saved[0]!.label}`
        : `${name} saved ${saved.length} files to Documents: ${saved.map((r) => `“${r.fileName}” → ${r.label}`).join(", ")}`,
    );
  }
  return results;
}

// The per-file "Save to student documents" button on a sent attachment.
export async function saveAttachmentToDocuments(actor: ChatActor, attachmentId: number, docTypeKey: string) {
  const docType = studentDocTypeByKey(docTypeKey);
  if (!docType) throw bad("Pick a document type.");
  const [r] = await fileAttachments(actor, [{ attachmentId, docType }]);
  if (!r?.label) throw bad(r?.error ?? "Couldn't save the file.");
  return { label: r.label };
}

// ---- Notifications ---------------------------------------------------------------

async function chatPref(userId: number): Promise<NotificationPref> {
  const row = await db.notification_preference.findUnique({
    where: { user_id_notification_type: { user_id: userId, notification_type: notificationPrefCode("chat.message") } },
    select: { via_email: true, via_in_app: true },
  });
  return row ? { email: row.via_email === 1, inApp: row.via_in_app === 1 } : { ...DEFAULT_NOTIFICATION_PREF };
}

// One bell item per partner per thread: while it's unread, a new message
// updates it rather than adding another. Never throws.
async function notifyPartnersInApp(studentId: number, threadId: number) {
  try {
    const [{ all }, student, thread] = await Promise.all([
      partnerParticipants(studentId),
      db.student.findUnique({ where: { id: studentId }, select: { first_name: true, last_name: true } }),
      db.partner_chat_thread.findUnique({ where: { id: threadId }, select: { last_preview: true } }),
    ]);
    if (!student) return;
    const link = partnerChatLink(studentId);
    for (const p of all) {
      if (!(await chatPref(p.id)).inApp) continue;
      const n = (await unreadByThread({ side: "partner", id: p.id, impersonatorId: null }, [threadId])).get(threadId) ?? 0;
      if (n === 0) continue;
      const title =
        n === 1
          ? `New message from Collegepond about ${fullName(student)}`
          : `${n} new messages from Collegepond about ${fullName(student)}`;
      const body = thread?.last_preview ?? null;
      const existing = await db.notification.findFirst({
        where: { user_id: p.id, type: NOTIFICATION_TYPE, link, read_at: null },
        select: { id: true },
      });
      if (existing) {
        await db.notification.update({ where: { id: existing.id }, data: { title, body, created_at: new Date() } });
      } else {
        await createNotifications([p.id], { type: NOTIFICATION_TYPE, title, body, link, tone: "blue" });
      }
    }
  } catch (e) {
    console.error("[partner-chat] in-app notification failed:", e instanceof Error ? e.message : e);
  }
}

// The Collegepond side's in-app item: one per thread for whoever answers it
// today (the counsellor, their alternate while out of office, or the lead
// when nobody is assigned), updated rather than repeated while it's unread.
// Never throws.
async function notifyStaffInApp(studentId: number) {
  try {
    const [sp, student, thread] = await Promise.all([
      staffParticipants(studentId),
      db.student.findUnique({
        where: { id: studentId },
        select: { first_name: true, last_name: true, organization: { select: { name: true } } },
      }),
      db.partner_chat_thread.findUnique({ where: { student_id: studentId }, select: { id: true, last_preview: true } }),
    ]);
    const to = sp.responder;
    if (!to || !student || !thread) return;
    const n =
      (await unreadByThread({ side: "staff", id: to.id, role: 0, impersonatorId: null }, [thread.id])).get(thread.id) ?? 0;
    if (n === 0) return;
    const from = student.organization?.name ? ` (${student.organization.name})` : "";
    const covering = sp.counsellor && to.id !== sp.counsellor.id ? ` · covering for ${fullName(sp.counsellor)}` : "";
    await upsertStaffNotification(to.id, {
      type: NOTIFICATION_TYPE,
      title:
        n === 1
          ? `New partner message about ${fullName(student)}${from}`
          : `${n} new partner messages about ${fullName(student)}${from}`,
      body: `${thread.last_preview ?? ""}${covering}`.trim() || null,
      link: staffChatLink(studentId),
      tone: "blue",
    });
  } catch (e) {
    console.error("[partner-chat] staff in-app notification failed:", e instanceof Error ? e.message : e);
  }
}

type BellItem = {
  id: string;
  title: string;
  time: string;
  tone: "blue" | "green" | "orange" | "red" | "gray";
  unread: boolean;
  href: string;
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// Admin-bell items for partner chat, within the staff user's student scope.
// Counsellors see the threads waiting on them; leads and Super Admins see
// overdue replies across their scope.
export async function staffChatSignals(
  user: StaffUser,
  scope: Prisma.studentWhereInput,
): Promise<{ items: BellItem[]; unreadThreads: number }> {
  if (!isChatStaffRole(user.role)) return { items: [], unreadThreads: 0 };
  void runChatJobs();
  const actor: ChatActor = { side: "staff", id: user.id, role: user.role, impersonatorId: null };
  const [unreadThreads, waiting, target] = await Promise.all([
    unreadThreadCount(actor, scope),
    db.partner_chat_thread.findMany({
      where: { student: scope, awaiting_since: { not: null } },
      select: { awaiting_since: true, student: { select: { cp_counsellor_id: true } } },
    }),
    getTatTarget(CHAT_RESPONSE),
  ]);
  const items: BellItem[] = [];
  if (unreadThreads > 0) {
    items.push({
      id: "partner-chat-unread",
      title: `${plural(unreadThreads, "partner chat")} with unread messages`,
      time: "Partner chat",
      tone: "blue",
      unread: true,
      href: "/admin/partner-chat?filter=unread",
    });
  }
  if (target && waiting.length) {
    const cfg = await getTatConfig();
    const now = new Date();
    // "Mine" = I answer for the student's counsellor today: mine, or a
    // colleague's I'm covering while they're out of office.
    const status = await Promise.all(
      waiting.map(async (w) => ({
        mine: (await responderFor(w.student.cp_counsellor_id)) === user.id,
        status: tatClock(w.awaiting_since!, now, target, cfg).status,
      })),
    );
    const mine = status.filter((s) => s.mine && s.status !== "On Track");
    if (mine.length) {
      const overdue = mine.filter((s) => s.status === "Breached").length;
      items.push({
        id: "partner-chat-mine",
        title: `${plural(mine.length, "partner chat")} awaiting your reply${overdue ? ` (${overdue} overdue)` : ""}`,
        time: "TAT",
        tone: overdue ? "red" : "orange",
        unread: true,
        href: "/admin/partner-chat?filter=awaiting",
      });
    }
    // A counsellor hears only about their own students (above).
    if (user.role !== AdminRole.COUNSELLOR) {
      const overdue = status.filter((s) => !s.mine && s.status === "Breached").length;
      if (overdue) {
        items.push({
          id: "partner-chat-overdue",
          title: `${overdue} partner chat ${overdue === 1 ? "reply" : "replies"} overdue`,
          time: "TAT",
          tone: "red",
          unread: true,
          href: "/admin/partner-chat?filter=overdue",
        });
      }
    }
  }
  return { items, unreadThreads };
}

// ---- Background jobs: unread emails and TAT alerts --------------------------------

const JOB_INTERVAL_MS = 60_000;
const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const g = globalThis as unknown as { __partnerChatJobs?: { last: number; running: boolean; timer?: ReturnType<typeof setInterval> } };

// Safe to call often: runs at most once a minute per process, and every
// email is claimed in the database first, so several instances never send
// twice. Also scheduled on a timer once this module is loaded.
export async function runChatJobs(): Promise<void> {
  const state = (g.__partnerChatJobs ??= { last: 0, running: false });
  if (!state.timer) {
    state.timer = setInterval(() => void runChatJobs(), JOB_INTERVAL_MS);
    state.timer.unref?.();
  }
  if (state.running || Date.now() - state.last < JOB_INTERVAL_MS - 1000) return;
  state.running = true;
  state.last = Date.now();
  try {
    await sendUnreadEmails();
    await sendTatAlerts();
  } catch (e) {
    console.error("[partner-chat] jobs failed:", e instanceof Error ? e.message : e);
  } finally {
    state.running = false;
  }
}

export async function sendUnreadEmails(now = new Date()): Promise<number> {
  let sent = 0;
  const threads = await db.partner_chat_thread.findMany({
    where: { last_message_at: { gte: new Date(now.getTime() - RECENT_MS) } },
    select: { id: true, student_id: true, student: { select: { first_name: true, last_name: true, organization: { select: { name: true } } } } },
  });
  for (const t of threads) {
    const reads = await db.partner_chat_read.findMany({ where: { thread_id: t.id } });
    for (const to of ["partner", "staff"] as const) {
      try {
        const sideRead = Math.max(0, ...reads.filter((r) => r.side === to).map((r) => r.last_read_message_id));
        const unread = await db.partner_chat_message.findMany({
          where: { thread_id: t.id, kind: "user", sender_side: other(to), id: { gt: sideRead } },
          orderBy: { id: "asc" },
          select: { id: true, body: true, created_at: true, sender_user_id: true },
          take: 50,
        });
        const first = unread[0];
        if (!first || now.getTime() - first.created_at.getTime() < UNREAD_EMAIL_AFTER_MS) continue;
        const maxId = unread[unread.length - 1]!.id;

        let recipient: Person | null;
        if (to === "partner") {
          recipient = (await partnerParticipants(t.student_id)).primary;
          if (recipient && !(await chatPref(recipient.id)).email) continue;
        } else {
          // The counsellor, or their alternate while out of office.
          recipient = (await staffParticipants(t.student_id)).responder;
        }
        if (!recipient) continue;

        await db.partner_chat_read.upsert({
          where: { thread_id_side_reader_id: { thread_id: t.id, side: to, reader_id: recipient.id } },
          create: { thread_id: t.id, side: to, reader_id: recipient.id },
          update: {},
        });
        const claim = await db.partner_chat_read.updateMany({
          where: { thread_id: t.id, side: to, reader_id: recipient.id, emailed_through_message_id: { lt: maxId } },
          data: { emailed_through_message_id: maxId },
        });
        if (claim.count === 0) continue;

        const studentName = fullName(t.student);
        let from = "Collegepond";
        if (to === "staff") {
          const senders = await db.user.findMany({
            where: { id: { in: unread.map((u) => u.sender_user_id).filter((x): x is number => x !== null) } },
            select: { first_name: true, last_name: true },
          });
          const names = [...new Set(senders.map(fullName))].join(", ");
          from = t.student.organization?.name ? `${names} (${t.student.organization.name})` : names || "The partner";
        }
        await sendEmail(
          recipient.email,
          partnerChatUnreadEmail(
            { name: fullName(recipient) },
            {
              studentName,
              from,
              count: unread.length,
              preview: preview(unread[unread.length - 1]!.body, []) || "(attachment)",
              link: to === "partner" ? partnerChatLink(t.student_id) : staffChatLink(t.student_id),
              toPartner: to === "partner",
            },
            appUrl(),
          ),
        );
        sent++;
      } catch (e) {
        console.error("[partner-chat] unread email failed:", e instanceof Error ? e.message : e);
      }
    }
  }
  return sent;
}

// Warning → the student's Collegepond counsellor (or the lead if there's no
// counsellor). Breach → their Counselling Lead (or Super Admins if there's
// no lead). Once per wait each; a reply resets both. Whoever is out of office
// is replaced by their alternate (staffParticipants). Each email also lands
// in the recipient's in-app feed.
export async function sendTatAlerts(now = new Date()): Promise<number> {
  const target = await getTatTarget(CHAT_RESPONSE);
  if (!target) return 0;
  const cfg = await getTatConfig();
  let sent = 0;
  const threads = await db.partner_chat_thread.findMany({
    where: { awaiting_since: { not: null }, tat_breached_at: null },
    select: {
      id: true,
      student_id: true,
      awaiting_since: true,
      tat_warned_at: true,
      student: { select: { first_name: true, last_name: true, organization: { select: { name: true } }, created_by: { select: { first_name: true, last_name: true } } } },
    },
  });
  for (const t of threads) {
    try {
      const clock = tatClock(t.awaiting_since!, now, target, cfg);
      if (clock.status === "On Track") continue;
      const sp = await staffParticipants(t.student_id);
      const base = {
        studentName: fullName(t.student),
        partnerName: t.student.organization?.name ?? (t.student.created_by ? fullName(t.student.created_by) : "A partner"),
        waiting: fmtMinutes(clock.elapsedMinutes),
        target: fmtMinutes(target.thresholdMinutes),
        counsellor: sp.counsellor ? fullName(sp.counsellor) : null,
        link: staffChatLink(t.student_id),
      };

      if (!t.tat_warned_at) {
        const claim = await db.partner_chat_thread.updateMany({
          where: { id: t.id, awaiting_since: t.awaiting_since, tat_warned_at: null },
          data: { tat_warned_at: now },
        });
        const to = sp.responder;
        if (claim.count === 1 && to) {
          await createStaffNotifications([to.id], {
            type: "chat.tat",
            title: `${clock.status === "Breached" ? "Overdue" : "Reply due soon"}: partner chat about ${base.studentName}`,
            body: `${base.partnerName} has waited ${base.waiting} (target ${base.target}).`,
            link: base.link,
            tone: clock.status === "Breached" ? "red" : "orange",
          });
          await sendEmail(
            to.email,
            partnerChatTatAlertEmail({ name: fullName(to) }, { ...base, overdue: clock.status === "Breached", escalation: false }, appUrl()),
          );
          sent++;
        }
      }
      if (clock.status === "Breached") {
        const claim = await db.partner_chat_thread.updateMany({
          where: { id: t.id, awaiting_since: t.awaiting_since, tat_breached_at: null },
          data: { tat_breached_at: now },
        });
        if (claim.count === 1) {
          const leads: Person[] = sp.leadResponder
            ? [sp.leadResponder]
            : await db.collegepond_user.findMany({
                where: { role: AdminRole.SUPER_ADMIN, status: 1 },
                select: { id: true, first_name: true, last_name: true, email: true },
              });
          const escalate = leads.filter((l) => l.id !== sp.responder?.id);
          await createStaffNotifications(
            escalate.map((l) => l.id),
            {
              type: "chat.tat",
              title: `Overdue partner chat reply: ${base.studentName}`,
              body: `${base.partnerName} has waited ${base.waiting} (target ${base.target})${base.counsellor ? `. Counsellor: ${base.counsellor}` : ""}.`,
              link: base.link,
              tone: "red",
            },
          );
          for (const l of escalate) {
            await sendEmail(
              l.email,
              partnerChatTatAlertEmail({ name: fullName(l) }, { ...base, overdue: true, escalation: true }, appUrl()),
            );
            sent++;
          }
        }
      }
    } catch (e) {
      console.error("[partner-chat] TAT alert failed:", e instanceof Error ? e.message : e);
    }
  }
  return sent;
}
