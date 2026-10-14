import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure, superAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { AdminRole } from "~/server/db/enums";
import { staffStudentScope } from "~/server/staff-access";

// Counselling teams (Settings -> Counselling Teams, Super Admin) and the
// Counsellor Lead's Auto Assign switch (lead's dashboard). One team per lead:
// the counsellors who report to them and the primary SPOC that new leads
// route to. A team drives visibility (a lead sees their team's students) and
// auto-assignment — both in src/server/staff-access.ts.

const fullName = (u: { first_name: string; last_name: string }) =>
  `${u.first_name} ${u.last_name}`.trim();

const person = { id: true, first_name: true, last_name: true, status: true } as const;

async function requireLead(id: number) {
  const lead = await db.collegepond_user.findUnique({
    where: { id },
    select: { id: true, role: true, status: true, first_name: true, last_name: true },
  });
  if (lead?.role !== AdminRole.COUNSELLOR_LEAD) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Counsellor Lead not found" });
  }
  return lead;
}

export const counsellingTeamsRouter = createTRPCRouter({
  // Every active lead with their team, plus every active counsellor with the
  // lead they currently report to.
  list: superAdminProcedure.query(async () => {
    const [leads, counsellors, teams] = await Promise.all([
      db.collegepond_user.findMany({
        where: { role: AdminRole.COUNSELLOR_LEAD, status: 1 },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
        select: person,
      }),
      db.collegepond_user.findMany({
        where: { role: AdminRole.COUNSELLOR, status: 1 },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
        select: { ...person, counsellor_team_member: { select: { team: { select: { lead_cp_user_id: true } } } } },
      }),
      db.counsellor_team.findMany({
        select: {
          lead_cp_user_id: true,
          primary_spoc_cp_user_id: true,
          auto_assign: true,
          updated_at: true,
          member: { select: { cp_user: { select: person } } },
        },
      }),
    ]);
    const teamByLead = new Map(teams.map((t) => [t.lead_cp_user_id, t]));
    return {
      leads: leads.map((l) => {
        const t = teamByLead.get(l.id);
        return {
          id: l.id,
          name: fullName(l),
          members: (t?.member ?? [])
            .map((m) => ({ id: m.cp_user.id, name: fullName(m.cp_user), active: m.cp_user.status === 1 }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          primarySpocId: t?.primary_spoc_cp_user_id ?? null,
          autoAssign: t?.auto_assign === 1,
          updatedAt: t?.updated_at.toISOString() ?? null,
        };
      }),
      counsellors: counsellors.map((c) => ({
        id: c.id,
        name: fullName(c),
        leadId: c.counsellor_team_member?.team.lead_cp_user_id ?? null,
      })),
    };
  }),

  // Replaces a lead's team. A counsellor can report to one lead only, so
  // adding someone who is in another team moves them (and clears that team's
  // SPOC if it was them). The primary SPOC must be one of the members.
  save: superAdminProcedure
    .input(
      z.object({
        leadId: z.number().int().positive(),
        memberIds: z.array(z.number().int().positive()).max(100),
        primarySpocId: z.number().int().positive().nullable(),
        autoAssign: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const lead = await requireLead(input.leadId);
      const memberIds = [...new Set(input.memberIds)];
      const members = await db.collegepond_user.findMany({
        where: { id: { in: memberIds }, role: AdminRole.COUNSELLOR, status: 1 },
        select: { id: true },
      });
      if (members.length !== memberIds.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Team members must be active Counsellors." });
      }
      if (input.primarySpocId !== null && !memberIds.includes(input.primarySpocId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The primary SPOC must be a member of the team." });
      }
      if (input.autoAssign && input.primarySpocId === null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a primary SPOC before turning Auto Assign on." });
      }

      const before = await db.counsellor_team.findUnique({
        where: { lead_cp_user_id: lead.id },
        select: { primary_spoc_cp_user_id: true, auto_assign: true, member: { select: { cp_user_id: true } } },
      });

      await db.$transaction(async (tx) => {
        const team = await tx.counsellor_team.upsert({
          where: { lead_cp_user_id: lead.id },
          create: {
            lead_cp_user_id: lead.id,
            primary_spoc_cp_user_id: input.primarySpocId,
            auto_assign: input.autoAssign ? 1 : 0,
          },
          update: {
            primary_spoc_cp_user_id: input.primarySpocId,
            auto_assign: input.autoAssign ? 1 : 0,
          },
          select: { id: true },
        });
        // Moving counsellors out of other teams: those teams lose them as SPOC.
        await tx.counsellor_team.updateMany({
          where: { id: { not: team.id }, primary_spoc_cp_user_id: { in: memberIds } },
          data: { primary_spoc_cp_user_id: null, auto_assign: 0 },
        });
        await tx.counsellor_team_member.deleteMany({
          where: { OR: [{ team_id: team.id }, { cp_user_id: { in: memberIds } }] },
        });
        if (memberIds.length) {
          await tx.counsellor_team_member.createMany({
            data: memberIds.map((cp_user_id) => ({ team_id: team.id, cp_user_id })),
          });
        }
      });

      await db.audit_log.create({
        data: {
          action: "counselling_team.updated",
          entity_type: "counselling_team",
          entity_id: lead.id,
          metadata: {
            byCpUserId: ctx.cpUser.id,
            leadName: fullName(lead),
            from: before
              ? {
                  memberIds: before.member.map((m) => m.cp_user_id),
                  primarySpocId: before.primary_spoc_cp_user_id,
                  autoAssign: before.auto_assign === 1,
                }
              : null,
            to: { memberIds, primarySpocId: input.primarySpocId, autoAssign: input.autoAssign },
          },
        },
      });
      return { ok: true as const };
    }),

  // The signed-in lead's own team for the dashboard Auto Assign card; null
  // for anyone who isn't a Counsellor Lead.
  mine: protectedAdminProcedure.query(async ({ ctx }) => {
    if (ctx.cpUser.role !== AdminRole.COUNSELLOR_LEAD) return null;
    const leadId = ctx.cpUser.id;
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [team, scope] = await Promise.all([
      db.counsellor_team.findUnique({
        where: { lead_cp_user_id: leadId },
        select: {
          auto_assign: true,
          primary_spoc: { select: person },
          member: { select: { cp_user: { select: person } } },
        },
      }),
      staffStudentScope(ctx.cpUser),
    ]);
    const memberIds = (team?.member ?? []).map((m) => m.cp_user.id);
    const [unassigned, autoAssigned30d, perMember] = await Promise.all([
      db.student.count({ where: { AND: [scope], cp_counsellor_id: null } }),
      db.student.count({ where: { AND: [scope], cp_auto_assigned_at: { gte: monthAgo } } }),
      db.student.groupBy({
        by: ["cp_counsellor_id"],
        where: { cp_counsellor_id: { in: [leadId, ...memberIds] } },
        _count: { _all: true },
      }),
    ]);
    const load = new Map(perMember.map((g) => [g.cp_counsellor_id, g._count._all]));
    const spoc = team?.primary_spoc?.status === 1 ? team.primary_spoc : null;
    return {
      autoAssign: team?.auto_assign === 1,
      primarySpoc: spoc ? { id: spoc.id, name: fullName(spoc) } : null,
      members: (team?.member ?? [])
        .map((m) => ({
          id: m.cp_user.id,
          name: fullName(m.cp_user),
          active: m.cp_user.status === 1,
          students: load.get(m.cp_user.id) ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      ownStudents: load.get(leadId) ?? 0,
      unassigned,
      autoAssigned30d,
    };
  }),

  // A lead switches their own Auto Assign on or off (a Super Admin can do it
  // for any lead from Settings via save). Needs a primary SPOC to turn on.
  setAutoAssign: protectedAdminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.cpUser.role !== AdminRole.COUNSELLOR_LEAD) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only a Counsellor Lead can change their Auto Assign." });
      }
      const team = await db.counsellor_team.findUnique({
        where: { lead_cp_user_id: ctx.cpUser.id },
        select: { id: true, auto_assign: true, primary_spoc: { select: { status: true } } },
      });
      if (input.enabled && team?.primary_spoc?.status !== 1) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No primary SPOC is set for your team. Ask a Super Admin to set one under Settings → Counselling Teams.",
        });
      }
      if (!team || (team.auto_assign === 1) === input.enabled) return { autoAssign: input.enabled };
      await db.counsellor_team.update({
        where: { id: team.id },
        data: { auto_assign: input.enabled ? 1 : 0 },
      });
      await db.audit_log.create({
        data: {
          action: input.enabled ? "counselling_team.auto_assign_on" : "counselling_team.auto_assign_off",
          entity_type: "counselling_team",
          entity_id: ctx.cpUser.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { autoAssign: input.enabled };
    }),
});
