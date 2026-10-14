import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  chatIdForPhone,
  periskopeConfigured,
  sendWhatsappMessage,
} from "~/server/periskope";
import { reconcileChatMessages } from "~/server/whatsapp-sync";
import { requireStaffStudent } from "~/server/staff-access";

// Student ↔ counsellor WhatsApp thread (via Periskope). The DB is the store; the
// thread reads from it (instant load). sync() reconciles it against Periskope's
// copy (source of truth) so the thread stays correct even if a webhook event was
// missed; the webhook re-pulls into the same store on inbound events. Outbound is
// sent + stored immediately.
export const chatRouter = createTRPCRouter({
  configured: protectedAdminProcedure.query(() => ({ configured: periskopeConfigured() })),

  thread: protectedAdminProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      const rows = await db.whatsapp_message.findMany({
        where: { student_id: input.studentId },
        orderBy: { created_at: "desc" },
        take: 200,
      });
      return rows
        .map((r) => ({
          id: r.id,
          fromMe: r.from_me === 1,
          body: r.body ?? "",
          type: r.message_type ?? "text",
          status: r.status,
          at: (r.provider_ts ?? r.created_at).toISOString(),
        }))
        // Order by the real message time, not insert order — a sync inserts many
        // rows at once, so created_at doesn't reflect the conversation order.
        .sort((a, b) => a.at.localeCompare(b.at));
    }),

  // Reconcile the DB with Periskope's copy of the conversation (source-of-truth
  // sync on chat open). Idempotent: dedups on Periskope's message_id AND on the
  // short unique_id our own sent rows stored, so it never duplicates. One read +
  // one batched insert + a few status updates — cheap, and the client runs it
  // WITHOUT blocking the thread render.
  sync: protectedAdminProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      const student = await db.student.findUnique({
        where: { id: input.studentId },
        select: { id: true, phone: true },
      });
      if (!student?.phone?.trim() || !periskopeConfigured()) return { synced: 0 };

      const synced = await reconcileChatMessages(
        student.id,
        chatIdForPhone(student.phone),
      );
      return { synced };
    }),

  send: protectedAdminProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        message: z.string().trim().min(1).max(4096),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      const student = await db.student.findUnique({
        where: { id: input.studentId },
        select: { id: true, phone: true },
      });
      if (!student) throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
      if (!student.phone?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This student has no phone number on file." });
      }

      const chatId = chatIdForPhone(student.phone);
      const result = await sendWhatsappMessage(chatId, input.message);
      if (!result.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Couldn't send WhatsApp message: ${result.error}` });
      }

      const row = await db.whatsapp_message.create({
        data: {
          student_id: student.id,
          chat_id: chatId,
          provider_message_id: result.providerMessageId,
          from_me: 1,
          body: input.message,
          message_type: "text",
          sent_by_cp_user_id: ctx.cpUser.id,
          status: result.status ?? "queued",
        },
      });
      return {
        id: row.id,
        fromMe: true,
        body: input.message,
        type: "text",
        status: row.status,
        at: row.created_at.toISOString(),
      };
    }),
});
