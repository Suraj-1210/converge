import { z } from "zod";
import { createTRPCRouter, protectedAdminProcedure, protectedPartnerProcedure } from "~/server/api/trpc";
import {
  partnerChatScope,
  requirePartnerChatStudent,
  requireStaffChatStudent,
  staffChatScope,
} from "~/server/partner-chat-access";
import {
  type ChatActor,
  attachmentStudentId,
  editMessage,
  getThread,
  inbox,
  markRead,
  messageStudentId,
  saveAttachmentToDocuments,
  sendMessage,
  unreadThreadCount,
} from "~/server/partner-chat";

// Partner ↔ Collegepond chat (src/server/partner-chat.ts). Every procedure
// checks, on the server, that the caller takes part in the student's chat
// (src/server/partner-chat-access.ts): partner* for the partner portal,
// staff* for the admin portal. Not the student WhatsApp chat (routers/chat.ts).

const studentInput = z.object({ studentId: z.number().int().positive() });
const sendInput = studentInput.extend({
  body: z.string().max(4000).optional(),
  attachmentIds: z.array(z.number().int().positive()).max(10).optional(),
  // "Send and save to documents": the checklist type per attachment ("" = chat only).
  fileAs: z
    .array(z.object({ attachmentId: z.number().int().positive(), docType: z.string().max(50) }))
    .max(10)
    .optional(),
});
const editInput = z.object({ messageId: z.number().int().positive(), body: z.string().max(4000) });
const readInput = studentInput.extend({ upToId: z.number().int().nonnegative() });
const saveInput = z.object({ attachmentId: z.number().int().positive(), docType: z.string().min(1).max(50) });
const inboxInput = z.object({
  filter: z.enum(["all", "unread", "awaiting", "overdue"]).default("all"),
  q: z.string().max(100).optional(),
});

type PartnerCtx = { cpPartner: { id: number; impersonatorId?: number } };
type StaffCtx = { cpUser: { id: number; role: number; realId?: number } };

const partnerActor = (ctx: PartnerCtx): ChatActor => ({
  side: "partner",
  id: ctx.cpPartner.id,
  impersonatorId: ctx.cpPartner.impersonatorId ?? null,
});
const staffActor = (ctx: StaffCtx): ChatActor => ({
  side: "staff",
  id: ctx.cpUser.id,
  role: ctx.cpUser.role,
  impersonatorId: ctx.cpUser.realId ?? null,
});

export const partnerChatRouter = createTRPCRouter({
  // ---- Partner portal ----------------------------------------------------------
  partnerInbox: protectedPartnerProcedure.input(inboxInput).query(async ({ ctx, input }) => {
    const scope = await partnerChatScope(ctx.cpPartner.id);
    // The TAT filters are Collegepond-side only.
    const filter = input.filter === "unread" ? "unread" : "all";
    return inbox(partnerActor(ctx), scope, { filter, q: input.q });
  }),

  partnerUnreadCount: protectedPartnerProcedure.query(async ({ ctx }) => {
    return unreadThreadCount(partnerActor(ctx), await partnerChatScope(ctx.cpPartner.id));
  }),

  partnerThread: protectedPartnerProcedure.input(studentInput).query(async ({ ctx, input }) => {
    await requirePartnerChatStudent(ctx.cpPartner.id, input.studentId);
    return getThread(partnerActor(ctx), input.studentId);
  }),

  partnerSend: protectedPartnerProcedure.input(sendInput).mutation(async ({ ctx, input }) => {
    await requirePartnerChatStudent(ctx.cpPartner.id, input.studentId);
    return sendMessage(partnerActor(ctx), input.studentId, input);
  }),

  partnerEdit: protectedPartnerProcedure.input(editInput).mutation(async ({ ctx, input }) => {
    await requirePartnerChatStudent(ctx.cpPartner.id, await messageStudentId(input.messageId));
    return editMessage(partnerActor(ctx), input.messageId, input.body);
  }),

  partnerMarkRead: protectedPartnerProcedure.input(readInput).mutation(async ({ ctx, input }) => {
    await requirePartnerChatStudent(ctx.cpPartner.id, input.studentId);
    // An agency owner viewing as this counsellor doesn't use up their unread.
    if (ctx.cpPartner.ownerImpersonatorId) return { ok: true as const, skipped: "impersonating" as const };
    return markRead(partnerActor(ctx), input.studentId, input.upToId);
  }),

  partnerSaveAttachment: protectedPartnerProcedure.input(saveInput).mutation(async ({ ctx, input }) => {
    await requirePartnerChatStudent(ctx.cpPartner.id, await attachmentStudentId(input.attachmentId));
    return saveAttachmentToDocuments(partnerActor(ctx), input.attachmentId, input.docType);
  }),

  // ---- Admin portal -------------------------------------------------------------
  staffInbox: protectedAdminProcedure.input(inboxInput).query(async ({ ctx, input }) => {
    const scope = await staffChatScope(ctx.cpUser);
    return inbox(staffActor(ctx), scope, { filter: input.filter, q: input.q });
  }),

  staffThread: protectedAdminProcedure.input(studentInput).query(async ({ ctx, input }) => {
    await requireStaffChatStudent(ctx.cpUser, input.studentId);
    return getThread(staffActor(ctx), input.studentId);
  }),

  staffSend: protectedAdminProcedure.input(sendInput).mutation(async ({ ctx, input }) => {
    await requireStaffChatStudent(ctx.cpUser, input.studentId);
    return sendMessage(staffActor(ctx), input.studentId, input);
  }),

  staffEdit: protectedAdminProcedure.input(editInput).mutation(async ({ ctx, input }) => {
    await requireStaffChatStudent(ctx.cpUser, await messageStudentId(input.messageId));
    return editMessage(staffActor(ctx), input.messageId, input.body);
  }),

  staffMarkRead: protectedAdminProcedure.input(readInput).mutation(async ({ ctx, input }) => {
    await requireStaffChatStudent(ctx.cpUser, input.studentId);
    return markRead(staffActor(ctx), input.studentId, input.upToId);
  }),

  staffSaveAttachment: protectedAdminProcedure.input(saveInput).mutation(async ({ ctx, input }) => {
    await requireStaffChatStudent(ctx.cpUser, await attachmentStudentId(input.attachmentId));
    return saveAttachmentToDocuments(staffActor(ctx), input.attachmentId, input.docType);
  }),
});
