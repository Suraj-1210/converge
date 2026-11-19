import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedAdminProcedure, superAdminProcedure } from "~/server/api/trpc";
import { isDateKey } from "~/lib/follow-ups";
import { DELAY_REASON_CODES, SHORTLIST_CLOSURE_CODES, TASK_CATEGORY_CODES, type TaskCategory } from "~/lib/tasks";
import {
  ageingReport,
  approveAllFirst,
  cancelTask,
  carryForwardView,
  closeDayView,
  completeTask,
  createTask,
  decideShift,
  isHeadCounsellorRole,
  listTasks,
  myDay,
  myOpenDueCount,
  nextTaskCode,
  runDayCloseDigest,
  studentTaskList,
  submitCloseDay,
  syncLinkedTasks,
  taskHistory,
  taskPeople,
  teamDashboard,
  updateTask,
} from "~/server/tasks";
import {
  followUpBoard,
  markPartnerConfirmed,
  recordFollowUp,
  reopenCase,
  studentPanel,
  syncShortlistCases,
} from "~/server/shortlist-follow-up";
import { MANUAL_MILESTONES, markMilestone, shortlistingSummary, studentMilestones } from "~/server/shortlisting-tat";
import { db } from "~/server/db";
import { requireStaffStudent, staffStudentScope } from "~/server/staff-access";
import { partnerName } from "~/lib/partner-display";

// My Tasks (src/server/tasks.ts) and the shortlist follow-up board
// (src/server/shortlist-follow-up.ts). The whole router is the "tasks" tab
// (~/lib/admin-sections API_SECTIONS), so switching the tab off refuses it.
// The student page's follow-up panel lives in shortlistFollowUpRouter below,
// which follows the student's visibility instead.

const dateKey = z.string().refine(isDateKey, { message: "Invalid date" });
const id = z.number().int().positive();
const category = z
  .number()
  .int()
  .refine((v) => TASK_CATEGORY_CODES.includes(v as TaskCategory), { message: "Invalid category" });
const priority = z.number().int().min(0).max(2);
const state = z.enum(["pending", "in_progress", "completed", "overdue", "cancelled"]);

// Shortlist follow-up stage tasks are created on their due day; make sure
// today's exist before listing (throttled inside).
const synced = protectedAdminProcedure.use(async ({ next }) => {
  await syncShortlistCases();
  return next();
});

const headOnly = protectedAdminProcedure.use(({ ctx, next }) => {
  if (!isHeadCounsellorRole(ctx.cpUser.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "For Head Counsellors (Counsellor Leads) and Super Admins." });
  }
  return next();
});

export const tasksRouter = createTRPCRouter({
  myDay: synced.query(({ ctx }) => myDay(ctx.cpUser)),

  // Topbar badge: open tasks due by today.
  badge: synced.query(async ({ ctx }) => {
    await syncLinkedTasks();
    return { count: await myOpenDueCount(ctx.cpUser) };
  }),

  list: synced
    .input(
      z.object({
        scope: z.enum(["mine", "team"]).default("mine"),
        state: z.union([state, z.literal("open")]).optional(),
        category: category.optional(),
        priority: priority.optional(),
        source: z.enum(["manual", "note", "follow_up", "shortlist"]).optional(),
        assigneeId: id.optional(),
        studentId: id.optional(),
        search: z.string().trim().max(100).optional(),
      }),
    )
    .query(({ ctx, input }) => listTasks(ctx.cpUser, input)),

  people: protectedAdminProcedure.query(({ ctx }) => taskPeople(ctx.cpUser)),

  nextCode: protectedAdminProcedure.query(() => nextTaskCode()),

  // Student picker for Create task: visible students, with their partner.
  students: protectedAdminProcedure
    .input(z.object({ search: z.string().trim().max(100).default("") }))
    .query(async ({ ctx, input }) => {
      const s = input.search;
      const n = Number(s.replace(/^CP-?/i, ""));
      const rows = await db.student.findMany({
        where: {
          AND: [
            await staffStudentScope(ctx.cpUser),
            s
              ? {
                  OR: [
                    { first_name: { contains: s } },
                    { last_name: { contains: s } },
                    ...(Number.isInteger(n) && n > 0 ? [{ id: n }] : []),
                  ],
                }
              : {},
          ],
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          organization: { select: { name: true, type: true } },
          created_by: { select: { first_name: true, last_name: true } },
        },
        orderBy: { updated_at: "desc" },
        take: 20,
      });
      return rows.map((r) => ({
        id: r.id,
        name: `${r.first_name} ${r.last_name}`.trim(),
        partner: partnerName(r.organization, r.created_by),
      }));
    }),

  create: protectedAdminProcedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(200),
        studentId: id,
        category,
        priority,
        pendingActivity: z.string().trim().min(1).max(500),
        dueDate: dateKey,
        followUpDate: dateKey.nullish(),
        status: z.union([z.literal(0), z.literal(1)]).default(0),
        assigneeId: id.nullish(),
        remarks: z.string().trim().max(1000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createTask(ctx.cpUser, input)),

  update: protectedAdminProcedure
    .input(
      z.object({
        id,
        status: z.union([z.literal(0), z.literal(1)]).optional(),
        remarks: z.string().trim().max(1000).nullish(),
        followUpDate: dateKey.nullish(),
        priority: priority.optional(),
        title: z.string().trim().min(1).max(200).optional(),
        category: category.optional(),
        pendingActivity: z.string().trim().min(1).max(500).optional(),
        assigneeId: id.optional(),
        dueDate: dateKey.optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { id: taskId, ...patch } = input;
      return updateTask(ctx.cpUser, taskId, patch);
    }),

  complete: protectedAdminProcedure
    .input(z.object({ id, remarks: z.string().trim().max(1000).nullish() }))
    .mutation(({ ctx, input }) => completeTask(ctx.cpUser, input.id, input.remarks)),

  cancel: protectedAdminProcedure
    .input(z.object({ id, reason: z.string().trim().min(1).max(255) }))
    .mutation(({ ctx, input }) => cancelTask(ctx.cpUser, input.id, input.reason)),

  history: protectedAdminProcedure.input(z.object({ id })).query(({ ctx, input }) => taskHistory(ctx.cpUser, input.id)),

  // ---- Close your day / carry-forward ----

  closeDay: synced.query(({ ctx }) => closeDayView(ctx.cpUser)),

  submitCloseDay: protectedAdminProcedure
    .input(
      z.object({
        draft: z.boolean().default(false),
        items: z
          .array(
            z.object({
              taskId: id,
              reason: z.enum(DELAY_REASON_CODES),
              details: z.string().max(500),
              shift: z.boolean(),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .mutation(({ ctx, input }) => submitCloseDay(ctx.cpUser, input.items, input.draft)),

  carryForward: protectedAdminProcedure.query(({ ctx }) => carryForwardView(ctx.cpUser)),

  decideShift: headOnly
    .input(z.object({ id, approve: z.boolean(), reason: z.string().trim().max(500).nullish() }))
    .mutation(({ ctx, input }) => decideShift(ctx.cpUser, input.id, input.approve, input.reason)),

  approveAllFirst: headOnly.mutation(({ ctx }) => approveAllFirst(ctx.cpUser)),

  // ---- Shortlist follow-ups board ----

  followUps: protectedAdminProcedure
    .input(z.object({ scope: z.enum(["mine", "team"]).default("mine") }))
    .query(({ ctx, input }) => followUpBoard(ctx.cpUser, input.scope)),

  // ---- Head Counsellor / Super Admin ----

  ageing: headOnly
    .input(
      z.object({
        from: dateKey,
        to: dateKey,
        counsellorId: id.optional(),
        category: category.optional(),
        postponedOnly: z.boolean().default(false),
      }),
    )
    .query(({ ctx, input }) => ageingReport(ctx.cpUser, input)),

  team: headOnly
    .input(
      z.object({
        from: dateKey,
        to: dateKey,
        counsellorId: id.optional(),
        departmentId: id.optional(),
        category: category.optional(),
        state: state.optional(),
        partner: z.string().regex(/^(org|user):\d+$/).optional(),
        studentId: id.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [dash, shortlisting] = await Promise.all([
        teamDashboard(ctx.cpUser, input),
        shortlistingSummary(ctx.cpUser, { from: input.from, to: input.to, counsellorId: input.counsellorId }),
      ]);
      return { ...dash, shortlisting };
    }),

  // Filter options for the team dashboard: departments and partners in view.
  teamFilters: headOnly.query(async ({ ctx }) => {
    const [departments, students] = await Promise.all([
      db.department.findMany({ where: { is_active: 1 }, select: { id: true, name: true }, orderBy: { sort_order: "asc" } }),
      db.student.findMany({
        where: await staffStudentScope(ctx.cpUser),
        select: {
          org_id: true,
          created_by_user_id: true,
          organization: { select: { name: true, type: true } },
          created_by: { select: { first_name: true, last_name: true } },
        },
        distinct: ["org_id", "created_by_user_id"],
        take: 2000,
      }),
    ]);
    const partners = new Map<string, string>();
    for (const s of students) {
      if (s.org_id) partners.set(`org:${s.org_id}`, partnerName(s.organization, null));
      else if (s.created_by_user_id) partners.set(`user:${s.created_by_user_id}`, partnerName(null, s.created_by));
    }
    return {
      departments,
      partners: [...partners.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    };
  }),

  // Super Admin: send the evening "day not closed" digest now (idempotent).
  runDigestNow: superAdminProcedure.mutation(async () => {
    await syncShortlistCases({ force: true });
    return runDayCloseDigest();
  }),
});

// The student page: partner-confirmation panel, follow-up history and
// shortlisting milestones. Open to any staff user who can see the student
// (like the shortlist actions beside it); recording is for counselling roles
// and Super Admin, reopening for a Counsellor Lead or Super Admin.
const counsellingOnly = protectedAdminProcedure.use(({ ctx, next }) => {
  if (![0, 3, 4].includes(ctx.cpUser.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the counselling team records shortlist follow-ups." });
  }
  return next();
});

export const shortlistFollowUpRouter = createTRPCRouter({
  panel: protectedAdminProcedure.input(z.object({ studentId: id })).query(({ ctx, input }) => studentPanel(ctx.cpUser, input.studentId)),

  milestones: protectedAdminProcedure
    .input(z.object({ studentId: id }))
    .query(({ ctx, input }) => studentMilestones(ctx.cpUser, input.studentId)),

  markMilestone: counsellingOnly
    .input(z.object({ studentId: id, field: z.enum(MANUAL_MILESTONES), clear: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => markMilestone(ctx.cpUser, input.studentId, input.field, input.clear)),

  record: counsellingOnly
    .input(
      z.object({
        caseId: id,
        stage: z.union([z.literal(2), z.literal(3), z.literal(4)]),
        response: z.enum(["confirmed", "changes", "pending"]).optional(),
        channels: z.array(z.enum(["call", "email", "whatsapp"])).max(3).optional(),
        callTime: z.string().trim().max(10).nullish(),
        callOutcome: z.string().trim().max(30).nullish(),
        comments: z.string().trim().max(1000).nullish(),
        decision: z.enum(["proceed", "close"]).optional(),
        closureReason: z.enum(SHORTLIST_CLOSURE_CODES).optional(),
      }),
    )
    .mutation(({ ctx, input }) => recordFollowUp(ctx.cpUser, input)),

  confirm: counsellingOnly
    .input(z.object({ caseId: id, comments: z.string().trim().max(1000).nullish() }))
    .mutation(({ ctx, input }) => markPartnerConfirmed(ctx.cpUser, input.caseId, input.comments)),

  reopen: protectedAdminProcedure
    .input(z.object({ caseId: id, comments: z.string().trim().max(1000).nullish() }))
    .mutation(({ ctx, input }) => reopenCase(ctx.cpUser, input.caseId, input.comments)),

  // A student's tasks (all sources), for the Follow-up History tab.
  studentTasks: protectedAdminProcedure.input(z.object({ studentId: id })).query(async ({ ctx, input }) => {
    await requireStaffStudent(ctx.cpUser, input.studentId);
    return studentTaskList(input.studentId);
  }),
});
