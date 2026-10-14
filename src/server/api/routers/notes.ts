import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { requireStaffNote, staffStudentScope } from "~/server/staff-access";

// student_note: one row is a note (is_task 0) or a task/reminder (is_task 1,
// with due_date / priority / is_done). priority: 0 Low · 1 Medium · 2 High.
const PRIORITY_LABEL = ["Low", "Medium", "High"];
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

export const notesRouter = createTRPCRouter({
  stats: protectedAdminProcedure.query(async ({ ctx }) => {
    const today = todayStart();
    // Notes on students this user can see (staff-access.ts).
    const student = await staffStudentScope(ctx.cpUser);
    const [overdue, upcoming, completed, notes] = await Promise.all([
      db.student_note.count({ where: { student, is_task: 1, is_done: 0, due_date: { lt: today } } }),
      db.student_note.count({ where: { student, is_task: 1, is_done: 0, due_date: { gte: today } } }),
      db.student_note.count({ where: { student, is_task: 1, is_done: 1 } }),
      db.student_note.count({ where: { student, is_task: 0 } }),
    ]);
    return { overdue, upcoming, completed, notes };
  }),

  list: protectedAdminProcedure
    .input(
      z.object({
        tab: z.enum(["reminders", "notes"]).default("reminders"),
        status: z.enum(["overdue", "upcoming", "completed"]).optional(),
        priority: z.number().int().optional(),
        search: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const today = todayStart();
      const search = input.search?.trim();
      const isTask = input.tab === "reminders" ? 1 : 0;
      const where = {
        AND: [{ student: await staffStudentScope(ctx.cpUser) }],
        is_task: isTask,
        ...(input.priority != null ? { priority: input.priority } : {}),
        ...(input.status === "completed"
          ? { is_done: 1 }
          : input.status === "overdue"
            ? { is_done: 0, due_date: { lt: today } }
            : input.status === "upcoming"
              ? { is_done: 0, due_date: { gte: today } }
              : {}),
        ...(search
          ? { OR: [{ body: { contains: search } }, { student: { OR: [{ first_name: { contains: search } }, { last_name: { contains: search } }] } }] }
          : {}),
      };
      const rows = await db.student_note.findMany({
        where,
        orderBy: isTask ? [{ is_done: "asc" }, { due_date: "asc" }] : { created_at: "desc" },
        take: 200,
        select: {
          id: true, body: true, due_date: true, priority: true, is_done: true, created_at: true, collegepond_user_id: true,
          student: { select: { id: true, first_name: true, last_name: true } },
        },
      });
      const cpIds = Array.from(new Set(rows.map((r) => r.collegepond_user_id).filter((x): x is number => x != null)));
      const cps = cpIds.length
        ? await db.collegepond_user.findMany({ where: { id: { in: cpIds } }, select: { id: true, first_name: true, last_name: true } })
        : [];
      const cpMap = new Map(cps.map((c) => [c.id, `${c.first_name} ${c.last_name}`.trim()]));

      return rows.map((r) => {
        const due = r.due_date;
        const status = r.is_done === 1 ? "completed" : !due ? "open" : due < today ? "overdue" : "upcoming";
        const p = r.priority ?? 0;
        return {
          id: r.id,
          subject: r.body,
          student: `${r.student.first_name} ${r.student.last_name}`.trim(),
          studentId: r.student.id,
          priority: p,
          priorityLabel: PRIORITY_LABEL[p] ?? "Low",
          dueDate: due ? due.toISOString().slice(0, 10) : null,
          status,
          done: r.is_done === 1,
          assignee: r.collegepond_user_id != null ? (cpMap.get(r.collegepond_user_id) ?? null) : null,
          createdAt: r.created_at.toISOString(),
        };
      });
    }),

  toggleDone: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireStaffNote(ctx.cpUser, input.id);
      const n = await db.student_note.findUnique({ where: { id: input.id }, select: { is_done: true } });
      if (!n) throw new TRPCError({ code: "NOT_FOUND", message: "Reminder not found" });
      await db.student_note.update({ where: { id: input.id }, data: { is_done: n.is_done === 1 ? 0 : 1 } });
      return { ok: true as const };
    }),
});
