import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedAdminProcedure, protectedPartnerProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { AdminRole, AdminRoleLabel, isAdminRole } from "~/server/db/enums";
import {
  coveredCounsellorIds,
  dateKey,
  formatOooDates,
  invalidateOutOfOfficeCache,
  oooNotices,
  oooToday,
} from "~/server/out-of-office";
import { assignableCounsellorIds, isCounsellingRole, teamMemberIds, type StaffUser } from "~/server/staff-access";
import { createStaffNotifications } from "~/server/staff-notify";

// Out of office (src/server/out-of-office.ts), set from the admin user menu.
// Who may set it for whom (decided with Suraj, 24 Oct 2026):
//   a counsellor or Counselling Lead → themselves, picking the alternate from
//                                      their team (a counsellor: their lead
//                                      and teammates; a lead: their team);
//   a Counselling Lead               → also any counsellor in their team
//                                      (set or override);
//   a Super Admin                    → anyone in counselling, with any active
//                                      counselling user as the alternate.
// Partners only read it (partnerNotices).

const MAX_DAYS = 180;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });

async function counsellingUser(id: number) {
  const u = await db.collegepond_user.findUnique({
    where: { id },
    select: { id: true, first_name: true, last_name: true, role: true, status: true },
  });
  return u?.status === 1 && isCounsellingRole(u.role) ? u : null;
}

async function canManage(actor: StaffUser, targetId: number): Promise<boolean> {
  if (actor.role === AdminRole.SUPER_ADMIN) return true;
  if (actor.id === targetId) return isCounsellingRole(actor.role);
  if (actor.role === AdminRole.COUNSELLOR_LEAD) return (await teamMemberIds(actor.id)).includes(targetId);
  return false;
}

// Who can cover for the target, from this actor's point of view.
async function alternateOptions(actor: StaffUser, target: { id: number; role: number }) {
  let ids: number[] | null;
  if (actor.role === AdminRole.SUPER_ADMIN) ids = null;
  else if (target.role === AdminRole.COUNSELLOR_LEAD) ids = await teamMemberIds(target.id);
  else ids = (await assignableCounsellorIds(target)) ?? [];
  const rows = await db.collegepond_user.findMany({
    where: {
      status: 1,
      role: { in: [AdminRole.COUNSELLOR, AdminRole.COUNSELLOR_LEAD] },
      id: { not: target.id, ...(ids ? { in: ids } : {}) },
    },
    select: { id: true, first_name: true, last_name: true, role: true },
    orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
  });
  return rows.map((r) => ({ id: r.id, name: fullName(r), role: isAdminRole(r.role) ? AdminRoleLabel[r.role] : "" }));
}

async function settingFor(cpUserId: number) {
  const row = await db.cp_out_of_office.findUnique({
    where: { cp_user_id: cpUserId },
    select: {
      from_date: true,
      to_date: true,
      updated_at: true,
      alternate: { select: { id: true, first_name: true, last_name: true } },
    },
  });
  if (!row) return null;
  const today = await oooToday();
  const from = dateKey(row.from_date);
  const to = dateKey(row.to_date);
  // A finished period counts as none: it ended by itself.
  if (to < today) return null;
  return {
    from,
    to,
    dates: formatOooDates(from, to),
    status: from <= today ? ("active" as const) : ("upcoming" as const),
    alternate: { id: row.alternate.id, name: fullName(row.alternate) },
  };
}

export const outOfOfficeRouter = createTRPCRouter({
  // The user menu: my own status, who I'm covering, and whether I can set it
  // for others.
  mine: protectedAdminProcedure.query(async ({ ctx }) => {
    const me = ctx.cpUser;
    const counselling = isCounsellingRole(me.role);
    const canManageOthers =
      me.role === AdminRole.SUPER_ADMIN || (me.role === AdminRole.COUNSELLOR_LEAD && (await teamMemberIds(me.id)).length > 0);
    const coveringIds = counselling ? await coveredCounsellorIds(me.id) : [];
    const coveringRows = coveringIds.length
      ? await db.cp_out_of_office.findMany({
          where: { cp_user_id: { in: coveringIds } },
          select: { from_date: true, to_date: true, cp_user: { select: { first_name: true, last_name: true } } },
        })
      : [];
    return {
      eligible: counselling || me.role === AdminRole.SUPER_ADMIN,
      canSetOwn: counselling,
      canManageOthers,
      setting: counselling ? await settingFor(me.id) : null,
      covering: coveringRows.map((r) => ({
        name: fullName(r.cp_user),
        dates: formatOooDates(dateKey(r.from_date), dateKey(r.to_date)),
      })),
    };
  }),

  // People this user may set out of office for (themselves first).
  manageable: protectedAdminProcedure.query(async ({ ctx }) => {
    const me = ctx.cpUser;
    let ids: number[] | null;
    if (me.role === AdminRole.SUPER_ADMIN) ids = null;
    else if (me.role === AdminRole.COUNSELLOR_LEAD) ids = [me.id, ...(await teamMemberIds(me.id))];
    else if (me.role === AdminRole.COUNSELLOR) ids = [me.id];
    else ids = [];
    const rows = await db.collegepond_user.findMany({
      where: {
        status: 1,
        role: { in: [AdminRole.COUNSELLOR, AdminRole.COUNSELLOR_LEAD] },
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: { id: true, first_name: true, last_name: true, role: true },
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
    });
    return rows
      .map((r) => ({
        id: r.id,
        name: r.id === me.id ? `${fullName(r)} (me)` : fullName(r),
        role: isAdminRole(r.role) ? AdminRoleLabel[r.role] : "",
      }))
      .sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0));
  }),

  get: protectedAdminProcedure.input(z.object({ cpUserId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const target = await counsellingUser(input.cpUserId);
    if (!target || !(await canManage(ctx.cpUser, target.id))) {
      throw forbidden("You can't set out of office for this person.");
    }
    return {
      target: { id: target.id, name: fullName(target) },
      setting: await settingFor(target.id),
      alternates: await alternateOptions(ctx.cpUser, target),
      today: await oooToday(),
    };
  }),

  set: protectedAdminProcedure
    .input(
      z.object({
        cpUserId: z.number().int().positive(),
        from: dateStr,
        to: dateStr,
        alternateId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const target = await counsellingUser(input.cpUserId);
      if (!target || !(await canManage(ctx.cpUser, target.id))) {
        throw forbidden("You can't set out of office for this person.");
      }
      const today = await oooToday();
      const from = new Date(`${input.from}T00:00:00Z`);
      const to = new Date(`${input.to}T00:00:00Z`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick valid dates." });
      }
      if (input.to < input.from) throw new TRPCError({ code: "BAD_REQUEST", message: "The To date can't be before the From date." });
      if (input.to < today) throw new TRPCError({ code: "BAD_REQUEST", message: "The To date has already passed." });
      if ((to.getTime() - from.getTime()) / 86_400_000 + 1 > MAX_DAYS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Out of office can be at most ${MAX_DAYS} days.` });
      }
      const options = await alternateOptions(ctx.cpUser, target);
      const alternate = options.find((o) => o.id === input.alternateId);
      if (!alternate) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick an alternate from the team." });

      const by = ctx.cpUser.realId ?? ctx.cpUser.id;
      const before = await db.cp_out_of_office.findUnique({ where: { cp_user_id: target.id } });
      const data = { from_date: from, to_date: to, alternate_cp_user_id: alternate.id, set_by_cp_user_id: by };
      await db.cp_out_of_office.upsert({
        where: { cp_user_id: target.id },
        create: { cp_user_id: target.id, ...data },
        update: data,
      });
      invalidateOutOfOfficeCache();
      await db.audit_log.create({
        data: {
          action: "cp_user.out_of_office_set",
          entity_type: "cp_user",
          entity_id: target.id,
          metadata: {
            byCpUserId: by,
            from: input.from,
            to: input.to,
            alternateCpUserId: alternate.id,
            before: before
              ? { from: dateKey(before.from_date), to: dateKey(before.to_date), alternateCpUserId: before.alternate_cp_user_id }
              : null,
          },
        },
      });

      const dates = formatOooDates(input.from, input.to);
      const setter = await db.collegepond_user.findUnique({ where: { id: by }, select: { first_name: true, last_name: true } });
      const setterName = setter ? fullName(setter) : "Someone";
      await createStaffNotifications([alternate.id], {
        type: "ooo.alternate",
        title: `You're covering for ${fullName(target)} (${dates})`,
        body: "Their partner chats, chat reply TAT and new auto-assigned students come to you while they're out of office.",
        link: "/admin/partner-chat",
        tone: "blue",
      });
      if (by !== target.id) {
        await createStaffNotifications([target.id], {
          type: "ooo.set",
          title: `${setterName} set you out of office (${dates})`,
          body: `${alternate.name} covers for you.`,
          tone: "gray",
        });
      }
      return { ok: true as const, dates };
    }),

  clear: protectedAdminProcedure.input(z.object({ cpUserId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const target = await counsellingUser(input.cpUserId);
    if (!target || !(await canManage(ctx.cpUser, target.id))) {
      throw forbidden("You can't change out of office for this person.");
    }
    const before = await db.cp_out_of_office.findUnique({ where: { cp_user_id: target.id } });
    if (!before) return { ok: true as const };
    await db.cp_out_of_office.delete({ where: { id: before.id } });
    invalidateOutOfOfficeCache();
    const by = ctx.cpUser.realId ?? ctx.cpUser.id;
    await db.audit_log.create({
      data: {
        action: "cp_user.out_of_office_cleared",
        entity_type: "cp_user",
        entity_id: target.id,
        metadata: {
          byCpUserId: by,
          before: { from: dateKey(before.from_date), to: dateKey(before.to_date), alternateCpUserId: before.alternate_cp_user_id },
        },
      },
    });
    if (before.to_date.toISOString().slice(0, 10) >= (await oooToday())) {
      await createStaffNotifications([before.alternate_cp_user_id], {
        type: "ooo.alternate",
        title: `${fullName(target)} is no longer out of office`,
        body: "You're not covering for them any more.",
        tone: "gray",
      });
    }
    return { ok: true as const };
  }),

  // Partner dashboard: their Collegepond counsellor or lead out of office
  // today, with who to contact instead.
  partnerNotices: protectedPartnerProcedure.query(async ({ ctx }) => {
    const me = await db.user.findUnique({
      where: { id: ctx.cpPartner.id },
      select: { org_id: true, is_owner: true, counsellor_id: true, lead_counsellor_id: true },
    });
    if (!me) return [];
    // Collegepond assigns the team on the agency owner (as on the dashboard).
    const team =
      me.org_id && !me.is_owner
        ? ((await db.user.findFirst({
            where: { org_id: me.org_id, is_owner: 1 },
            select: { counsellor_id: true, lead_counsellor_id: true },
          })) ?? me)
        : me;
    return oooNotices([team.counsellor_id, team.lead_counsellor_id]);
  }),
});
