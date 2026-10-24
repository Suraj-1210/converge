import { z } from "zod";
import { createTRPCRouter, protectedPartnerProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// Partner-facing in-app notification feed, read from the persistent
// `notification` table (unlike the admin bell, which is derived from live
// state). Written by ~/server/notify on discrete events. `page` backs the
// full Notifications page (history, read/unread, paging).
//
// While someone views the portal as this partner (a Super Admin, or the
// agency owner viewing as a counsellor), reading doesn't mark anything read.

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

export const partnerNotificationsRouter = createTRPCRouter({
  list: protectedPartnerProcedure.query(async ({ ctx }) => {
    const rows = await db.notification.findMany({
      where: { user_id: ctx.cpPartner.id },
      orderBy: { created_at: "desc" },
      take: 30,
    });
    const unread = rows.reduce((n, r) => n + (r.read_at == null ? 1 : 0), 0);
    return {
      unread,
      notifications: rows.map((r) => ({
        id: String(r.id),
        title: r.title,
        body: r.body ?? undefined,
        time: relTime(r.created_at),
        tone: (TONES.has(r.tone as Tone) ? r.tone : "blue") as Tone,
        unread: r.read_at == null,
        href: r.link ?? undefined,
      })),
    };
  }),

  page: protectedPartnerProcedure
    .input(
      z.object({
        filter: z.enum(["all", "unread", "read"]).default("all"),
        page: z.number().int().min(1).max(10_000).default(1),
        pageSize: z.number().int().min(5).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        user_id: ctx.cpPartner.id,
        ...(input.filter === "unread" ? { read_at: null } : input.filter === "read" ? { read_at: { not: null } } : {}),
      };
      const [rows, total, unread] = await Promise.all([
        db.notification.findMany({
          where,
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        db.notification.count({ where }),
        db.notification.count({ where: { user_id: ctx.cpPartner.id, read_at: null } }),
      ]);
      return {
        total,
        unread,
        page: input.page,
        pageSize: input.pageSize,
        items: rows.map((r) => ({
          id: String(r.id),
          dbId: r.id,
          title: r.title,
          body: r.body ?? undefined,
          time: relTime(r.created_at),
          at: r.created_at.toISOString(),
          tone: (TONES.has(r.tone as Tone) ? r.tone : "blue") as Tone,
          unread: r.read_at == null,
          href: r.link ?? undefined,
        })),
      };
    }),

  setRead: protectedPartnerProcedure
    .input(z.object({ id: z.number().int().positive(), read: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.cpPartner.impersonatorId || ctx.cpPartner.ownerImpersonatorId) {
        return { ok: true as const, skipped: "impersonating" as const };
      }
      await db.notification.updateMany({
        where: { id: input.id, user_id: ctx.cpPartner.id },
        data: { read_at: input.read ? new Date() : null },
      });
      return { ok: true as const };
    }),

  markAllRead: protectedPartnerProcedure.mutation(async ({ ctx }) => {
    if (ctx.cpPartner.impersonatorId || ctx.cpPartner.ownerImpersonatorId) {
      return { ok: true as const };
    }
    await db.notification.updateMany({
      where: { user_id: ctx.cpPartner.id, read_at: null },
      data: { read_at: new Date() },
    });
    return { ok: true as const };
  }),
});
