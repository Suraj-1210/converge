import { z } from "zod";
import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// The persistent in-app feed for Collegepond staff (cp_notification, written
// by ~/server/staff-notify on discrete events: partner chat messages, chat
// TAT alerts, shortlist proposals and decisions, out of office). The live
// derived signals stay in routers/notifications.ts; the bell shows both, and
// the admin Notifications page adds history, read/unread and paging.
//
// Clearing (19 Nov) sets archived_at: the item leaves the bell but stays on
// the Notifications page, searchable, and can be restored.
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
  archived_at: Date | null;
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
  archived: r.archived_at != null,
  href: r.link ?? undefined,
  clearable: true,
  own: true,
  recipient: null as string | null,
});

export const staffNotificationsRouter = createTRPCRouter({
  // For the bell: the latest items (unread first in the UI) and the unread count.
  recent: protectedAdminProcedure.query(async ({ ctx }) => {
    const [rows, unread] = await Promise.all([
      db.cp_notification.findMany({
        where: { cp_user_id: ctx.cpUser.id, archived_at: null },
        orderBy: { created_at: "desc" },
        take: 15,
      }),
      db.cp_notification.count({ where: { cp_user_id: ctx.cpUser.id, archived_at: null, read_at: null } }),
    ]);
    return { unread, notifications: rows.map(toItem) };
  }),

  page: protectedAdminProcedure
    .input(
      z.object({
        filter: z.enum(["all", "unread", "read"]).default("all"),
        // inbox = not cleared; cleared = archived; everything = both.
        view: z.enum(["inbox", "cleared", "everything"]).default("inbox"),
        search: z.string().trim().max(100).default(""),
        page: z.number().int().min(1).max(10_000).default(1),
        pageSize: z.number().int().min(5).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const words = input.search.split(/\s+/).filter(Boolean).slice(0, 5);
      const where = {
        cp_user_id: ctx.cpUser.id,
        ...(input.view === "inbox" ? { archived_at: null } : input.view === "cleared" ? { archived_at: { not: null } } : {}),
        ...(input.filter === "unread" ? { read_at: null } : input.filter === "read" ? { read_at: { not: null } } : {}),
        ...(words.length
          ? { AND: words.map((w) => ({ OR: [{ title: { contains: w } }, { body: { contains: w } }] })) }
          : {}),
      };
      const [rows, total, unread] = await Promise.all([
        db.cp_notification.findMany({
          where,
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        db.cp_notification.count({ where }),
        db.cp_notification.count({ where: { cp_user_id: ctx.cpUser.id, archived_at: null, read_at: null } }),
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

  // Clear one item (or restore it). Clearing also marks it read.
  setCleared: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive(), cleared: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.cpUser.realId) return { ok: true as const, skipped: "impersonating" as const };
      const now = new Date();
      if (input.cleared) {
        await db.cp_notification.updateMany({
          where: { id: input.id, cp_user_id: ctx.cpUser.id, read_at: null },
          data: { read_at: now },
        });
      }
      await db.cp_notification.updateMany({
        where: { id: input.id, cp_user_id: ctx.cpUser.id },
        data: { archived_at: input.cleared ? now : null },
      });
      return { ok: true as const };
    }),

  // Clear all: every stored item still in the bell (live signals aren't stored).
  clearAll: protectedAdminProcedure.mutation(async ({ ctx }) => {
    if (ctx.cpUser.realId) return { ok: true as const, cleared: 0 };
    const now = new Date();
    await db.cp_notification.updateMany({
      where: { cp_user_id: ctx.cpUser.id, archived_at: null, read_at: null },
      data: { read_at: now },
    });
    const r = await db.cp_notification.updateMany({
      where: { cp_user_id: ctx.cpUser.id, archived_at: null },
      data: { archived_at: now },
    });
    return { ok: true as const, cleared: r.count };
  }),
});
