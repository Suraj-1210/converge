import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminSectionProcedure, createTRPCRouter, superAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { staffStudentScope } from "~/server/staff-access";
import {
  CHAT_RESPONSE,
  getTatConfig,
  invalidateTatCache,
  isValidTimezone,
  parseWorkDays,
  tatClock,
} from "~/server/tat";
import { describeHours, tatStatus } from "~/lib/tat";

// TAT master (Settings -> TAT Settings, Super Admin) and the real data behind
// the TAT Management page. "Chat Response" (Collegepond replying in partner
// chat) is the first measured action. See src/server/tat.ts.

// Who may open TAT Management: the "tat" section in ~/lib/admin-sections
// (Super Admin, Counsellor Lead, Operations Lead). Its rows follow the admin
// Students list's visibility (staff-access.ts), so a lead sees their team's.
const tatViewProcedure = adminSectionProcedure("tat");

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();
const DAY_MS = 24 * 60 * 60 * 1000;

async function readMaster() {
  const [row, holidays, targets] = await Promise.all([
    db.tat_setting.findUnique({ where: { id: 1 } }),
    db.tat_holiday.findMany({ orderBy: { holiday_date: "asc" } }),
    db.tat_action_target.findMany({ orderBy: { id: "asc" } }),
  ]);
  const cfg = await getTatConfig();
  const hours = {
    timezone: row?.timezone ?? cfg.timezone,
    workDays: row ? parseWorkDays(row.work_days) : cfg.workDays,
    dayStartMinute: row?.day_start_minute ?? cfg.dayStartMinute,
    dayEndMinute: row?.day_end_minute ?? cfg.dayEndMinute,
  };
  return {
    hours,
    description: describeHours(hours),
    holidays: holidays.map((h) => ({ id: h.id, date: h.holiday_date.toISOString().slice(0, 10), name: h.name })),
    targets: targets.map((t) => ({
      key: t.action_key,
      label: t.label,
      thresholdMinutes: t.threshold_minutes,
      warningPct: t.warning_pct,
      active: t.active === 1,
    })),
  };
}

export const tatRouter = createTRPCRouter({
  config: tatViewProcedure.query(() => readMaster()),

  // Super Admin only (Settings -> TAT Settings).
  master: superAdminProcedure.query(() => readMaster()),

  updateHours: superAdminProcedure
    .input(
      z.object({
        timezone: z.string().min(1).max(64),
        workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        dayStartMinute: z.number().int().min(0).max(1439),
        dayEndMinute: z.number().int().min(1).max(1440),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isValidTimezone(input.timezone)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown timezone." });
      }
      if (input.dayEndMinute <= input.dayStartMinute) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The working day must end after it starts." });
      }
      const before = await db.tat_setting.findUnique({ where: { id: 1 } });
      const data = {
        timezone: input.timezone,
        work_days: [...new Set(input.workDays)].sort().join(","),
        day_start_minute: input.dayStartMinute,
        day_end_minute: input.dayEndMinute,
        updated_by_cp_user_id: ctx.cpUser.realId ?? ctx.cpUser.id,
      };
      await db.tat_setting.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      await db.audit_log.create({
        data: {
          action: "tat.hours_updated",
          entity_type: "tat_setting",
          entity_id: 1,
          metadata: {
            byCpUserId: ctx.cpUser.realId ?? ctx.cpUser.id,
            before: before
              ? { timezone: before.timezone, workDays: before.work_days, start: before.day_start_minute, end: before.day_end_minute }
              : null,
            after: { timezone: data.timezone, workDays: data.work_days, start: data.day_start_minute, end: data.day_end_minute },
          },
        },
      });
      invalidateTatCache();
      return { ok: true as const };
    }),

  addHoliday: superAdminProcedure
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const d = new Date(`${input.date}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid date." });
      const exists = await db.tat_holiday.findUnique({ where: { holiday_date: d } });
      if (exists) throw new TRPCError({ code: "CONFLICT", message: "That date is already a holiday." });
      const h = await db.tat_holiday.create({ data: { holiday_date: d, name: input.name } });
      await db.audit_log.create({
        data: {
          action: "tat.holiday_added",
          entity_type: "tat_holiday",
          entity_id: h.id,
          metadata: { byCpUserId: ctx.cpUser.realId ?? ctx.cpUser.id, date: input.date, name: input.name },
        },
      });
      invalidateTatCache();
      return { id: h.id };
    }),

  removeHoliday: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const h = await db.tat_holiday.findUnique({ where: { id: input.id } });
      if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "Holiday not found" });
      await db.tat_holiday.delete({ where: { id: h.id } });
      await db.audit_log.create({
        data: {
          action: "tat.holiday_removed",
          entity_type: "tat_holiday",
          entity_id: h.id,
          metadata: { byCpUserId: ctx.cpUser.realId ?? ctx.cpUser.id, date: h.holiday_date.toISOString().slice(0, 10), name: h.name },
        },
      });
      invalidateTatCache();
      return { ok: true as const };
    }),

  updateTarget: superAdminProcedure
    .input(
      z.object({
        key: z.string().min(1).max(50),
        thresholdMinutes: z.number().int().min(5).max(30 * 24 * 60),
        warningPct: z.number().int().min(1).max(99),
        active: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const t = await db.tat_action_target.findUnique({ where: { action_key: input.key } });
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "TAT action not found" });
      await db.tat_action_target.update({
        where: { id: t.id },
        data: {
          threshold_minutes: input.thresholdMinutes,
          warning_pct: input.warningPct,
          active: input.active ? 1 : 0,
          updated_by_cp_user_id: ctx.cpUser.realId ?? ctx.cpUser.id,
        },
      });
      await db.audit_log.create({
        data: {
          action: "tat.target_updated",
          entity_type: "tat_action_target",
          entity_id: t.id,
          metadata: {
            byCpUserId: ctx.cpUser.realId ?? ctx.cpUser.id,
            key: t.action_key,
            before: { thresholdMinutes: t.threshold_minutes, warningPct: t.warning_pct, active: t.active === 1 },
            after: { thresholdMinutes: input.thresholdMinutes, warningPct: input.warningPct, active: input.active },
          },
        },
      });
      invalidateTatCache();
      return { ok: true as const };
    }),

  // Chat Response on TAT Management: waits open now, and the last 30 days of
  // replies, within the viewer's student scope.
  chatOverview: tatViewProcedure.query(async ({ ctx }) => {
    const scope = await staffStudentScope(ctx.cpUser);
    const targetRow = await db.tat_action_target.findUnique({ where: { action_key: CHAT_RESPONSE } });
    const target = targetRow
      ? { key: targetRow.action_key, label: targetRow.label, thresholdMinutes: targetRow.threshold_minutes, warningPct: targetRow.warning_pct, active: targetRow.active === 1 }
      : null;
    const cfg = await getTatConfig();
    const now = new Date();

    const [waiting, replies] = await Promise.all([
      db.partner_chat_thread.findMany({
        where: { student: scope, awaiting_since: { not: null } },
        orderBy: { awaiting_since: "asc" },
        take: 500,
        select: {
          student_id: true,
          awaiting_since: true,
          student: {
            select: {
              first_name: true,
              last_name: true,
              cp_counsellor_id: true,
              cp_counsellor: { select: { first_name: true, last_name: true } },
              organization: { select: { name: true } },
              created_by: { select: { first_name: true, last_name: true } },
            },
          },
        },
      }),
      db.partner_chat_message.findMany({
        where: {
          tat_started_at: { not: null },
          created_at: { gte: new Date(now.getTime() - 30 * DAY_MS) },
          thread: { student: scope },
        },
        select: { tat_business_minutes: true, tat_counsellor_cp_user_id: true },
      }),
    ]);

    const pending = target
      ? waiting.map((w) => {
          const c = tatClock(w.awaiting_since!, now, target, cfg);
          const s = w.student;
          return {
            studentId: w.student_id,
            studentName: fullName(s),
            partnerName: s.organization?.name ?? (s.created_by ? fullName(s.created_by) : "—"),
            counsellorId: s.cp_counsellor_id,
            counsellor: s.cp_counsellor ? fullName(s.cp_counsellor) : null,
            since: w.awaiting_since!.toISOString(),
            elapsedMinutes: c.elapsedMinutes,
            remainingMinutes: c.remainingMinutes,
            dueAt: c.dueAt?.toISOString() ?? null,
            status: c.status,
          };
        })
      : [];
    pending.sort((a, b) => b.elapsedMinutes - a.elapsedMinutes);

    const mins = replies.map((r) => r.tat_business_minutes ?? 0);
    const within = target ? mins.filter((m) => tatStatus(m, target) !== "Breached").length : 0;

    // Per counsellor: the student's counsellor when the reply was sent.
    const ids = [
      ...new Set([
        ...replies.map((r) => r.tat_counsellor_cp_user_id),
        ...pending.map((p) => p.counsellorId),
      ]),
    ];
    const people = await db.collegepond_user.findMany({
      where: { id: { in: ids.filter((x): x is number => x !== null) } },
      select: { id: true, first_name: true, last_name: true },
    });
    const byCounsellor = ids.map((id) => {
      const rs = replies.filter((r) => r.tat_counsellor_cp_user_id === id).map((r) => r.tat_business_minutes ?? 0);
      const open = pending.filter((p) => p.counsellorId === id);
      const p = people.find((x) => x.id === id);
      return {
        counsellorId: id,
        name: p ? fullName(p) : "Unassigned",
        replies: rs.length,
        withinTarget: target ? rs.filter((m) => tatStatus(m, target) !== "Breached").length : 0,
        avgMinutes: rs.length ? Math.round(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
        waiting: open.length,
        overdue: open.filter((o) => o.status === "Breached").length,
      };
    });
    byCounsellor.sort((a, b) => b.overdue - a.overdue || b.waiting - a.waiting || b.replies - a.replies);

    return {
      target,
      hours: describeHours(cfg),
      pending,
      stats: {
        waiting: pending.length,
        warning: pending.filter((p) => p.status === "Warning").length,
        breached: pending.filter((p) => p.status === "Breached").length,
        replies30d: replies.length,
        avgMinutes30d: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
        compliancePct30d: mins.length ? Math.round((within / mins.length) * 100) : null,
      },
      byCounsellor,
    };
  }),
});
