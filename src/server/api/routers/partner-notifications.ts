import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedPartnerProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { isAgencyOwner } from "~/server/partner-access";

// Partner-facing in-app notification feed, read from the persistent
// `notification` table (unlike the admin bell, which is derived from live
// state). Written by ~/server/notify on discrete events. `page` backs the
// full Notifications page (history, read/unread, cleared, search, paging).
//
// Clearing (19 Nov) sets archived_at: the item leaves the bell but stays on
// the Notifications page, searchable, and can be restored. An agency owner
// can also search their counsellors' notifications there (read-only: only
// the recipient reads, clears or restores their own).
//
// While someone views the portal as this partner (a Super Admin, or the
// agency owner viewing as a counsellor), reading or clearing changes nothing.

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

const viewing = (p: { impersonatorId?: number | null; ownerImpersonatorId?: number | null }) =>
  !!(p.impersonatorId ?? p.ownerImpersonatorId);

// The agency's people (owner and counsellors, past ones too) when this
// partner is its owner; null otherwise.
async function agencyPeople(partnerId: number) {
  if (!(await isAgencyOwner(partnerId))) return null;
  const me = await db.user.findUnique({ where: { id: partnerId }, select: { org_id: true } });
  if (!me?.org_id) return null;
  return db.user.findMany({
    where: { org_id: me.org_id },
    orderBy: [{ is_owner: "desc" }, { first_name: "asc" }],
    select: { id: true, first_name: true, last_name: true, is_owner: true, deleted_at: true },
  });
}

export const partnerNotificationsRouter = createTRPCRouter({
  // The bell: active (not cleared) items only.
  list: protectedPartnerProcedure.query(async ({ ctx }) => {
    const [rows, unread] = await Promise.all([
      db.notification.findMany({
        where: { user_id: ctx.cpPartner.id, archived_at: null },
        orderBy: { created_at: "desc" },
        take: 30,
      }),
      db.notification.count({ where: { user_id: ctx.cpPartner.id, archived_at: null, read_at: null } }),
    ]);
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
        clearable: true,
      })),
    };
  }),

  // For the owner's "Whose" picker on the Notifications page; null = not an owner.
  agencyMembers: protectedPartnerProcedure.query(async ({ ctx }) => {
    const people = await agencyPeople(ctx.cpPartner.id);
    if (!people) return null;
    return people.map((p) => ({
      id: p.id,
      name: `${p.first_name} ${p.last_name}`.trim() + (p.id === ctx.cpPartner.id ? " (you)" : p.deleted_at ? " (removed)" : ""),
    }));
  }),

  page: protectedPartnerProcedure
    .input(
      z.object({
        filter: z.enum(["all", "unread", "read"]).default("all"),
        // inbox = not cleared; cleared = archived; everything = both.
        view: z.enum(["inbox", "cleared", "everything"]).default("inbox"),
        search: z.string().trim().max(100).default(""),
        // Agency owner only: "agency" = everyone in the agency, or one user id.
        whose: z.union([z.literal("mine"), z.literal("agency"), z.number().int().positive()]).default("mine"),
        page: z.number().int().min(1).max(10_000).default(1),
        pageSize: z.number().int().min(5).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const me = ctx.cpPartner.id;
      let userIds = [me];
      let names: Map<number, string> | null = null;
      if (input.whose !== "mine") {
        const people = await agencyPeople(me);
        if (!people) throw new TRPCError({ code: "FORBIDDEN", message: "Only the agency owner can view the agency's notifications." });
        const ids = people.map((p) => p.id);
        if (input.whose !== "agency" && !ids.includes(input.whose)) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
        }
        userIds = input.whose === "agency" ? ids : [input.whose];
        names = new Map(people.map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim()]));
      }
      const words = input.search.split(/\s+/).filter(Boolean).slice(0, 5);
      const where = {
        user_id: { in: userIds },
        ...(input.view === "inbox" ? { archived_at: null } : input.view === "cleared" ? { archived_at: { not: null } } : {}),
        ...(input.filter === "unread" ? { read_at: null } : input.filter === "read" ? { read_at: { not: null } } : {}),
        ...(words.length
          ? { AND: words.map((w) => ({ OR: [{ title: { contains: w } }, { body: { contains: w } }] })) }
          : {}),
      };
      const [rows, total, unread] = await Promise.all([
        db.notification.findMany({
          where,
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        db.notification.count({ where }),
        db.notification.count({ where: { user_id: me, archived_at: null, read_at: null } }),
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
          archived: r.archived_at != null,
          href: r.link ?? undefined,
          // Someone else's (owner's agency view): shown, not actionable.
          own: r.user_id === me,
          recipient: names && r.user_id !== me ? (names.get(r.user_id) ?? null) : null,
        })),
      };
    }),

  setRead: protectedPartnerProcedure
    .input(z.object({ id: z.number().int().positive(), read: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (viewing(ctx.cpPartner)) return { ok: true as const, skipped: "impersonating" as const };
      await db.notification.updateMany({
        where: { id: input.id, user_id: ctx.cpPartner.id },
        data: { read_at: input.read ? new Date() : null },
      });
      return { ok: true as const };
    }),

  markAllRead: protectedPartnerProcedure.mutation(async ({ ctx }) => {
    if (viewing(ctx.cpPartner)) return { ok: true as const };
    await db.notification.updateMany({
      where: { user_id: ctx.cpPartner.id, read_at: null },
      data: { read_at: new Date() },
    });
    return { ok: true as const };
  }),

  // Clear one item (or restore it). Clearing also marks it read.
  setCleared: protectedPartnerProcedure
    .input(z.object({ id: z.number().int().positive(), cleared: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (viewing(ctx.cpPartner)) return { ok: true as const, skipped: "impersonating" as const };
      const now = new Date();
      if (input.cleared) {
        await db.notification.updateMany({
          where: { id: input.id, user_id: ctx.cpPartner.id, read_at: null },
          data: { read_at: now },
        });
      }
      await db.notification.updateMany({
        where: { id: input.id, user_id: ctx.cpPartner.id },
        data: { archived_at: input.cleared ? now : null },
      });
      return { ok: true as const };
    }),

  // Clear all: everything still in the bell.
  clearAll: protectedPartnerProcedure.mutation(async ({ ctx }) => {
    if (viewing(ctx.cpPartner)) return { ok: true as const, cleared: 0 };
    const now = new Date();
    await db.notification.updateMany({
      where: { user_id: ctx.cpPartner.id, archived_at: null, read_at: null },
      data: { read_at: now },
    });
    const r = await db.notification.updateMany({
      where: { user_id: ctx.cpPartner.id, archived_at: null },
      data: { archived_at: now },
    });
    return { ok: true as const, cleared: r.count };
  }),
});
