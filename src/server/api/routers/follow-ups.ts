import { z } from "zod";
import {
  adminSectionProcedure,
  createTRPCRouter,
  protectedAdminProcedure,
  superAdminProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { requireStaffApplication } from "~/server/staff-access";
import { isDateKey, MAX_DECISION_WEEKS } from "~/lib/follow-ups";
import {
  completeFollowUp,
  followUpPanel,
  overdueFollowUps,
  rescheduleFollowUp,
  runFollowUpReminders,
  scheduleFollowUp,
  setDecisionWeeks,
} from "~/server/follow-ups";

// Application follow-ups (src/server/follow-ups.ts). The Application tab
// actions are open to any staff user who can see the application, like the
// stage changes beside them; the overdue list lives on TAT Management.

const dateKey = z.string().refine(isDateKey, { message: "Invalid date" });
const id = z.number().int().positive();

// The follow-up's application, if this staff user may see it.
async function requireFollowUp(user: { id: number; role: number }, followUpId: number) {
  const f = await db.application_follow_up.findUnique({
    where: { id: followUpId },
    select: { application_id: true },
  });
  // requireStaffApplication answers NOT_FOUND for a missing or hidden one.
  await requireStaffApplication(user, f?.application_id ?? 0);
}

export const followUpsRouter = createTRPCRouter({
  forApplication: protectedAdminProcedure
    .input(z.object({ applicationId: id }))
    .query(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      return followUpPanel(input.applicationId);
    }),

  schedule: protectedAdminProcedure
    .input(z.object({ applicationId: id, dueDate: dateKey }))
    .mutation(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      return scheduleFollowUp(ctx.cpUser.id, input.applicationId, input.dueDate);
    }),

  reschedule: protectedAdminProcedure
    .input(z.object({ followUpId: id, dueDate: dateKey }))
    .mutation(async ({ ctx, input }) => {
      await requireFollowUp(ctx.cpUser, input.followUpId);
      return rescheduleFollowUp(ctx.cpUser.id, input.followUpId, input.dueDate);
    }),

  complete: protectedAdminProcedure
    .input(z.object({ followUpId: id }))
    .mutation(async ({ ctx, input }) => {
      await requireFollowUp(ctx.cpUser, input.followUpId);
      return completeFollowUp(ctx.cpUser.id, input.followUpId);
    }),

  setDecisionWeeks: protectedAdminProcedure
    .input(z.object({ applicationId: id, weeks: z.number().int().min(1).max(MAX_DECISION_WEEKS) }))
    .mutation(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      await setDecisionWeeks(ctx.cpUser.id, input.applicationId, input.weeks);
      return { ok: true };
    }),

  // TAT Management → Overdue follow-ups, in the viewer's application scope.
  overdue: adminSectionProcedure("tat").query(({ ctx }) => overdueFollowUps(ctx.cpUser)),

  // The daily run, on demand (testing, or a missed scheduled run). Idempotent.
  runNow: superAdminProcedure.mutation(async ({ ctx }) => {
    const result = await runFollowUpReminders();
    await db.audit_log.create({
      data: {
        action: "follow_ups.run_manual",
        entity_type: "follow_up_run",
        entity_id: null,
        metadata: { ...result, byCpUserId: ctx.cpUser.id },
      },
    });
    return result;
  }),
});
