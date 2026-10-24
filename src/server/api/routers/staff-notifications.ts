import { z } from "zod";
import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// The persistent in-app feed for Collegepond staff (cp_notification, written
// by ~/server/staff-notify on discrete events: partner chat messages, chat
// TAT alerts, shortlist proposals and decisions, out of office). The live
// derived signals stay in routers/notifications.ts; the bell shows both, and
// the admin Notifications page adds history, read/unread and paging.
//
// While a Super Admin impersonates someone, ctx.cpUser is that person, so
// they see that person's feed; reading it there doesn't mark anything read.

type Tone = "blue" | "green" | "orange" | "red" | "gray";
const TONES = new Set<Tone>(["blue", "green", "orange", "red", "gray"]);

function relTime(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

const toItem = (r: {
  id: number;
  title: string;
  body: string | null;
  tone: string;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}) => ({
  id: `cp-${r.id}`,
  dbId: r.id,
  title: r.title,
  body: r.body ?? undefined,
  time: relTime(r.created_at),
  at: r.created_at.toISOString(),
  tone: (TONES.has(r.tone as Tone) ? r.tone : "blue") as Tone,
  unread: r.read_at == null,
  href: r.link ?? undefined,
});

export const staffNotificationsRouter = createTRPCRouter({
  // For the bell: the latest items (unread first in the UI) and the unread count.
  recent: protectedAdminProcedure.query(async ({ ctx }) => {
    const [rows, unread] = await Promise.all([
      db.cp_notification.findMany({
        where: { cp_user_id: ctx.cpUser.id },
        orderBy: { created_at: "desc" },
        take: 15,
      }),
      db.cp_notification.count({ where: { cp_user_id: ctx.cpUser.id, read_at: null } }),
    ]);
    return { unread, notifications: rows.map(toItem) };
  }),

  page: protectedAdminProcedure
    .input(
      z.object({
        filter: z.enum(["all", "unread", "read"]).default("all"),
        page: z.number().int().min(1).max(10_000).default(1),
        pageSize: z.number().int().min(5).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        cp_user_id: ctx.cpUser.id,
        ...(input.filter === "unread" ? { read_at: null } : input.filter === "read" ? { read_at: { not: null } } : {}),
      };
      const [rows, total, unread] = await Promise.all([
        db.cp_notification.findMany({
          where,
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        db.cp_notification.count({ where }),
        db.cp_notification.count({ where: { cp_user_id: ctx.cpUser.id, read_at: null } }),
      ]);
      return { items: rows.map(toItem), total, unread, page: input.page, pageSize: input.pageSize };
    }),

  setRead: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive(), read: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.cpUser.realId) return { ok: true as const, skipped: "impersonating" as const };
      await db.cp_notification.updateMany({
        where: { id: input.id, cp_user_id: ctx.cpUser.id },
        data: { read_at: input.read ? new Date() : null },
      });
      return { ok: true as const };
    }),

  markAllRead: protectedAdminProcedure.mutation(async ({ ctx }) => {
    if (ctx.cpUser.realId) return { ok: true as const, skipped: "impersonating" as const };
    await db.cp_notification.updateMany({
      where: { cp_user_id: ctx.cpUser.id, read_at: null },
      data: { read_at: new Date() },
    });
    return { ok: true as const };
  }),
});
