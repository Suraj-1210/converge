import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { bdmCrmProcedure, createTRPCRouter } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  AdminRole,
  BDM_ACTIVITY_TYPE_CODES,
  BDM_TASK_CATEGORY_CODES,
  BDM_TASK_PRIORITY_CODES,
  type BdmActivityType,
  BdmActivityTypeLabel,
  type BdmTaskCategory,
  BdmTaskCategoryLabel,
  BdmTaskPriority,
  BdmTaskPriorityLabel,
  PROSPECT_SOURCE_CODES,
  PROSPECT_STAGE_CODES,
  PROSPECT_TEMPERATURE_CODES,
  type ProspectSource,
  ProspectSourceLabel,
  ProspectStage,
  ProspectStageLabel,
  type ProspectTemperature,
  ProspectTemperatureLabel,
} from "~/server/db/enums";

// BDM CRM: prospects (with stage history), the activity log, and tasks.
// Backs the Prospect Pipeline / Activity Log / My Tasks sections of BDM
// Performance. Tables: prisma/sql/migrations/20261002120000_bdm_crm.sql.
//
// Access: bdmCrmProcedure admits Super Admin and BDM only. On top of that, a
// BDM is pinned to their own records here: lists are filtered to them, and any
// read or write of someone else's record answers NOT_FOUND (not FORBIDDEN) so
// ids can't be probed. Super Admin sees and edits everyone's.
//
// Ownership: a prospect belongs to bdm_id; an activity belongs to whoever
// performed it (bdm_id); a task belongs to its assignee. A partner belongs to
// the bdm_id on its representative user (owner first), the same rule the
// BDM Performance overview uses.

const LIST_CAP = 500;

// Due dates are business-calendar dates. Deriving "today" from the server clock
// would use UTC on App Platform and put Due Today / Overdue on the wrong day
// between 00:00 and 05:30 IST, so it is computed in IST and expressed as the
// UTC-midnight Date that Prisma uses for DATE columns.
const BUSINESS_TZ = "Asia/Kolkata";
const istYmd = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const businessToday = () => new Date(`${istYmd.format(new Date())}T00:00:00.000Z`);
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const MS_DAY = 86_400_000;

// --- input helpers ----------------------------------------------------------

const id = z.number().int().positive();

function codeOf<T extends number>(codes: readonly T[], label: string) {
  return z
    .number()
    .int()
    .refine((v): v is T => (codes as readonly number[]).includes(v), { message: `Invalid ${label}` });
}
const sourceCode = codeOf<ProspectSource>(PROSPECT_SOURCE_CODES, "source");
const stageCode = codeOf<ProspectStage>(PROSPECT_STAGE_CODES, "stage");
const temperatureCode = codeOf<ProspectTemperature>(PROSPECT_TEMPERATURE_CODES, "temperature");
const activityTypeCode = codeOf<BdmActivityType>(BDM_ACTIVITY_TYPE_CODES, "activity type");
const priorityCode = codeOf<BdmTaskPriority>(BDM_TASK_PRIORITY_CODES, "priority");
const categoryCode = codeOf<BdmTaskCategory>(BDM_TASK_CATEGORY_CODES, "category");

// "YYYY-MM-DD" -> UTC-midnight Date. Rejects impossible dates (2026-02-30)
// rather than letting them roll over into the next month.
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .transform((s, ctx) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a real date" });
      return z.NEVER;
    }
    return d;
  });

// Optional free text: absent = leave unchanged, "" = clear to NULL.
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .optional();
const email = z
  .union([z.literal(""), z.string().trim().email().max(255)])
  .transform((v) => v || null)
  .optional();

// Activities and tasks target exactly one of a partner or a prospect. .strict()
// makes an object carrying both keys fail both branches instead of silently
// dropping one, which mirrors the database CHECK.
const target = z.union([
  z.object({ organizationId: id }).strict(),
  z.object({ prospectId: id }).strict(),
]);

// --- access helpers ---------------------------------------------------------

type Actor = { id: number; role: number };
const isBdm = (a: Actor) => a.role === AdminRole.BDM;
const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found.` });

// Which BDM a list covers. A BDM is always pinned to themselves, and asking for
// anyone else is refused rather than silently ignored. Super Admin gets the
// requested BDM, or everyone when none is given.
function listScope(actor: Actor, requested?: number): number | undefined {
  if (isBdm(actor)) {
    if (requested != null && requested !== actor.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "You can only view your own records." });
    }
    return actor.id;
  }
  return requested;
}

function assertOwns(actor: Actor, ownerId: number, what: string) {
  if (isBdm(actor) && ownerId !== actor.id) throw notFound(what);
}

async function assertActiveBdm(userId: number) {
  const u = await db.collegepond_user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
  if (u?.role !== AdminRole.BDM || u.status !== 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That user is not an active BDM." });
  }
}

// Prospects always belong to a BDM. A BDM creates their own; Super Admin must
// say which BDM.
async function prospectOwner(actor: Actor, requested?: number): Promise<number> {
  if (isBdm(actor)) {
    if (requested != null && requested !== actor.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "You can only create records for yourself." });
    }
    return actor.id;
  }
  if (requested == null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Choose the BDM this prospect belongs to." });
  }
  await assertActiveBdm(requested);
  return requested;
}

// Activities and tasks default to the actor. Super Admin may act for a BDM.
async function actorOrBdm(actor: Actor, requested?: number): Promise<number> {
  if (requested == null || requested === actor.id) return actor.id;
  if (isBdm(actor)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You can only create records for yourself." });
  }
  await assertActiveBdm(requested);
  return requested;
}

async function partnerBdmId(orgId: number): Promise<number | null | undefined> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return undefined;
  const rep = await db.user.findFirst({
    where: { org_id: orgId },
    orderBy: [{ is_owner: "desc" }, { id: "asc" }],
    select: { bdm_id: true },
  });
  return rep?.bdm_id ?? null;
}

async function resolveTarget(
  actor: Actor,
  t: z.infer<typeof target>,
): Promise<{ organization_id: number | null; prospect_id: number | null }> {
  if ("prospectId" in t) {
    const p = await db.bdm_prospect.findUnique({ where: { id: t.prospectId }, select: { bdm_id: true } });
    if (!p) throw notFound("Prospect");
    assertOwns(actor, p.bdm_id, "Prospect");
    return { organization_id: null, prospect_id: t.prospectId };
  }
  const owner = await partnerBdmId(t.organizationId);
  if (owner === undefined || (isBdm(actor) && owner !== actor.id)) throw notFound("Partner");
  return { organization_id: t.organizationId, prospect_id: null };
}

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();

function targetOf(r: {
  organization: { id: number; name: string } | null;
  prospect: { id: number; agency_name: string } | null;
}) {
  if (r.organization) return { kind: "partner" as const, id: r.organization.id, name: r.organization.name };
  if (r.prospect) return { kind: "prospect" as const, id: r.prospect.id, name: r.prospect.agency_name };
  return null; // unreachable while the CHECK constraint holds
}

async function audit(action: string, entityType: string, entityId: number, metadata: Record<string, string | number | null>) {
  await db.audit_log.create({ data: { action, entity_type: entityType, entity_id: entityId, metadata } });
}

// --- prospects --------------------------------------------------------------

const prospectRouter = createTRPCRouter({
  // Pipeline rows, grouped by stage and stalest-first within each stage.
  list: bdmCrmProcedure
    .input(
      z
        .object({
          bdmId: id.optional(),
          stage: stageCode.optional(),
          search: z.string().trim().max(100).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const bdm = listScope(ctx.cpUser, input?.bdmId);
      const search = input?.search;
      const rows = await db.bdm_prospect.findMany({
        where: {
          ...(bdm != null ? { bdm_id: bdm } : {}),
          ...(input?.stage != null ? { stage: input.stage } : {}),
          ...(search
            ? { OR: [{ agency_name: { contains: search } }, { contact_name: { contains: search } }, { city: { contains: search } }] }
            : {}),
        },
        orderBy: [{ stage: "asc" }, { stage_changed_at: "asc" }],
        take: LIST_CAP,
        include: {
          bdm: { select: { first_name: true, last_name: true } },
          converted_org: { select: { id: true, name: true } },
          _count: { select: { tasks: { where: { is_done: 0 } } } },
        },
      });
      const today = businessToday();
      const closed: number[] = [ProspectStage.ONBOARDING, ProspectStage.LOST];
      return rows.map((p) => ({
        id: p.id,
        agencyName: p.agency_name,
        contactName: p.contact_name,
        email: p.email,
        phone: p.phone,
        city: p.city,
        source: p.source,
        sourceLabel: ProspectSourceLabel[p.source as ProspectSource] ?? "Unknown",
        stage: p.stage,
        stageLabel: ProspectStageLabel[p.stage as ProspectStage] ?? "Unknown",
        temperature: p.temperature,
        temperatureLabel: p.temperature != null ? (ProspectTemperatureLabel[p.temperature as ProspectTemperature] ?? null) : null,
        daysInStage: Math.max(0, Math.floor((Date.now() - p.stage_changed_at.getTime()) / MS_DAY)),
        nextFollowUp: ymd(p.next_follow_up),
        followUpDue: p.next_follow_up != null && p.next_follow_up <= today && !closed.includes(p.stage),
        notes: p.notes,
        bdmId: p.bdm_id,
        bdmName: fullName(p.bdm),
        convertedOrg: p.converted_org,
        openTasks: p._count.tasks,
        createdAt: p.created_at.toISOString(),
      }));
    }),

  create: bdmCrmProcedure
    .input(
      z.object({
        agencyName: z.string().trim().min(1).max(255),
        contactName: text(255),
        email,
        phone: text(20),
        city: text(120),
        source: sourceCode,
        temperature: temperatureCode.optional(),
        nextFollowUp: dateOnly.optional(),
        notes: text(1000),
        bdmId: id.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const bdmId = await prospectOwner(ctx.cpUser, input.bdmId);
      const created = await db.$transaction(async (tx) => {
        const p = await tx.bdm_prospect.create({
          data: {
            agency_name: input.agencyName,
            contact_name: input.contactName,
            email: input.email,
            phone: input.phone,
            city: input.city,
            source: input.source,
            temperature: input.temperature,
            next_follow_up: input.nextFollowUp,
            notes: input.notes,
            stage: ProspectStage.LEAD,
            bdm_id: bdmId,
          },
        });
        await tx.bdm_prospect_stage_history.create({
          data: { prospect_id: p.id, from_stage: null, to_stage: ProspectStage.LEAD, note: "Prospect created", changed_by: ctx.cpUser.id },
        });
        return p;
      });
      await audit("bdm_prospect.created", "bdm_prospect", created.id, { byCpUserId: ctx.cpUser.id, bdmId });
      return { id: created.id };
    }),

  // Edit details. Stage changes go through advanceStage so they are recorded.
  update: bdmCrmProcedure
    .input(
      z.object({
        id,
        agencyName: z.string().trim().min(1).max(255).optional(),
        contactName: text(255),
        email,
        phone: text(20),
        city: text(120),
        source: sourceCode.optional(),
        temperature: temperatureCode.nullable().optional(),
        nextFollowUp: dateOnly.nullable().optional(),
        notes: text(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const p = await db.bdm_prospect.findUnique({ where: { id: input.id }, select: { bdm_id: true } });
      if (!p) throw notFound("Prospect");
      assertOwns(ctx.cpUser, p.bdm_id, "Prospect");
      await db.bdm_prospect.update({
        where: { id: input.id },
        data: {
          agency_name: input.agencyName,
          contact_name: input.contactName,
          email: input.email,
          phone: input.phone,
          city: input.city,
          source: input.source,
          temperature: input.temperature,
          next_follow_up: input.nextFollowUp,
          notes: input.notes,
        },
      });
      return { id: input.id };
    }),

  // Moves a prospect to another stage (forwards, backwards, or to Lost) and
  // records the change with its note. The update is conditional on the stage
  // it read, so two people advancing the same prospect at once can't both
  // succeed against a stale stage.
  advanceStage: bdmCrmProcedure
    .input(z.object({ id, toStage: stageCode, note: text(1000), temperature: temperatureCode.optional() }))
    .mutation(async ({ ctx, input }) => {
      return db.$transaction(async (tx) => {
        const p = await tx.bdm_prospect.findUnique({ where: { id: input.id }, select: { stage: true, bdm_id: true } });
        if (!p) throw notFound("Prospect");
        assertOwns(ctx.cpUser, p.bdm_id, "Prospect");
        if (p.stage === input.toStage) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "The prospect is already in that stage." });
        }
        const moved = await tx.bdm_prospect.updateMany({
          where: { id: input.id, stage: p.stage },
          data: {
            stage: input.toStage,
            stage_changed_at: new Date(),
            ...(input.temperature != null ? { temperature: input.temperature } : {}),
          },
        });
        if (moved.count !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "This prospect was just updated by someone else. Refresh and try again." });
        }
        await tx.bdm_prospect_stage_history.create({
          data: { prospect_id: input.id, from_stage: p.stage, to_stage: input.toStage, note: input.note, changed_by: ctx.cpUser.id },
        });
        return { id: input.id, stage: input.toStage };
      });
    }),

  // Links a prospect to the partner organization it became. The prospect row
  // is kept so its history survives; if it wasn't already at Onboarding, the
  // move is recorded.
  convert: bdmCrmProcedure
    .input(z.object({ id, organizationId: id }))
    .mutation(async ({ ctx, input }) => {
      const org = await db.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
      if (!org) throw notFound("Partner");
      await db.$transaction(async (tx) => {
        const p = await tx.bdm_prospect.findUnique({
          where: { id: input.id },
          select: { stage: true, bdm_id: true, converted_org_id: true },
        });
        if (!p) throw notFound("Prospect");
        assertOwns(ctx.cpUser, p.bdm_id, "Prospect");
        if (p.converted_org_id != null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This prospect is already linked to a partner." });
        }
        const toOnboarding = p.stage !== ProspectStage.ONBOARDING;
        await tx.bdm_prospect.update({
          where: { id: input.id },
          data: {
            converted_org_id: input.organizationId,
            ...(toOnboarding ? { stage: ProspectStage.ONBOARDING, stage_changed_at: new Date() } : {}),
          },
        });
        if (toOnboarding) {
          await tx.bdm_prospect_stage_history.create({
            data: { prospect_id: input.id, from_stage: p.stage, to_stage: ProspectStage.ONBOARDING, note: "Converted to partner", changed_by: ctx.cpUser.id },
          });
        }
      });
      await audit("bdm_prospect.converted", "bdm_prospect", input.id, { byCpUserId: ctx.cpUser.id, organizationId: input.organizationId });
      return { id: input.id };
    }),

  history: bdmCrmProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const p = await db.bdm_prospect.findUnique({ where: { id: input.id }, select: { bdm_id: true } });
    if (!p) throw notFound("Prospect");
    assertOwns(ctx.cpUser, p.bdm_id, "Prospect");
    const rows = await db.bdm_prospect_stage_history.findMany({
      where: { prospect_id: input.id },
      orderBy: [{ changed_at: "asc" }, { id: "asc" }],
      include: { changed_by_user: { select: { first_name: true, last_name: true } } },
    });
    return rows.map((h) => ({
      id: h.id,
      fromStage: h.from_stage,
      fromLabel: h.from_stage != null ? (ProspectStageLabel[h.from_stage as ProspectStage] ?? "Unknown") : null,
      toStage: h.to_stage,
      toLabel: ProspectStageLabel[h.to_stage as ProspectStage] ?? "Unknown",
      note: h.note,
      changedBy: h.changed_by_user ? fullName(h.changed_by_user) : null,
      changedAt: h.changed_at.toISOString(),
    }));
  }),
});

// --- activities -------------------------------------------------------------

const activityRouter = createTRPCRouter({
  // The log of what each person did. Scoped by who performed the activity.
  list: bdmCrmProcedure
    .input(
      z
        .object({
          bdmId: id.optional(),
          type: activityTypeCode.optional(),
          organizationId: id.optional(),
          prospectId: id.optional(),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const bdm = listScope(ctx.cpUser, input?.bdmId);
      const rows = await db.bdm_activity.findMany({
        where: {
          ...(bdm != null ? { bdm_id: bdm } : {}),
          ...(input?.type != null ? { type: input.type } : {}),
          ...(input?.organizationId != null ? { organization_id: input.organizationId } : {}),
          ...(input?.prospectId != null ? { prospect_id: input.prospectId } : {}),
        },
        orderBy: [{ occurred_on: "desc" }, { id: "desc" }],
        take: input?.limit ?? 100,
        include: {
          organization: { select: { id: true, name: true } },
          prospect: { select: { id: true, agency_name: true } },
          bdm: { select: { first_name: true, last_name: true } },
        },
      });
      return rows.map((a) => ({
        id: a.id,
        type: a.type,
        typeLabel: BdmActivityTypeLabel[a.type as BdmActivityType] ?? "Unknown",
        target: targetOf(a),
        occurredOn: ymd(a.occurred_on),
        durationMins: a.duration_mins,
        summary: a.summary,
        followUpDate: ymd(a.follow_up_date),
        bdmId: a.bdm_id,
        bdmName: fullName(a.bdm),
        createdAt: a.created_at.toISOString(),
      }));
    }),

  log: bdmCrmProcedure
    .input(
      z.object({
        type: activityTypeCode,
        target,
        occurredOn: dateOnly,
        durationMins: z.number().int().min(0).max(1440).optional(),
        summary: z.string().trim().min(1).max(1000),
        followUpDate: dateOnly.optional(),
        bdmId: id.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.occurredOn > businessToday()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "An activity can't be logged for a future date." });
      }
      if (input.followUpDate && input.followUpDate < input.occurredOn) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The follow-up date can't be before the activity." });
      }
      const performer = await actorOrBdm(ctx.cpUser, input.bdmId);
      const t = await resolveTarget(ctx.cpUser, input.target);
      const a = await db.bdm_activity.create({
        data: {
          type: input.type,
          ...t,
          occurred_on: input.occurredOn,
          duration_mins: input.durationMins,
          summary: input.summary,
          follow_up_date: input.followUpDate,
          bdm_id: performer,
        },
      });
      return { id: a.id };
    }),
});

// --- tasks ------------------------------------------------------------------

const taskStatus = z.enum(["open", "dueToday", "overdue", "upcoming", "completed", "all"]);

const taskRouter = createTRPCRouter({
  // Counts behind the Open Tasks / Due Today / Overdue cards.
  summary: bdmCrmProcedure
    .input(z.object({ bdmId: id.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const who = listScope(ctx.cpUser, input?.bdmId);
      const base = who != null ? { assigned_to: who } : {};
      const today = businessToday();
      const [open, dueToday, overdue, urgent, completed] = await Promise.all([
        db.bdm_task.count({ where: { ...base, is_done: 0 } }),
        db.bdm_task.count({ where: { ...base, is_done: 0, due_date: today } }),
        db.bdm_task.count({ where: { ...base, is_done: 0, due_date: { lt: today } } }),
        db.bdm_task.count({ where: { ...base, is_done: 0, priority: BdmTaskPriority.URGENT } }),
        db.bdm_task.count({ where: { ...base, is_done: 1 } }),
      ]);
      return { open, dueToday, overdue, urgent, completed };
    }),

  list: bdmCrmProcedure
    .input(
      z
        .object({
          bdmId: id.optional(),
          status: taskStatus.default("open"),
          priority: priorityCode.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const who = listScope(ctx.cpUser, input?.bdmId);
      const today = businessToday();
      const status = input?.status ?? "open";
      const byStatus = {
        open: { is_done: 0 },
        dueToday: { is_done: 0, due_date: today },
        overdue: { is_done: 0, due_date: { lt: today } },
        upcoming: { is_done: 0, due_date: { gt: today } },
        completed: { is_done: 1 },
        all: {},
      }[status];
      const rows = await db.bdm_task.findMany({
        where: {
          ...(who != null ? { assigned_to: who } : {}),
          ...byStatus,
          ...(input?.priority != null ? { priority: input.priority } : {}),
        },
        orderBy: [{ is_done: "asc" }, { due_date: "asc" }, { priority: "desc" }, { id: "asc" }],
        take: LIST_CAP,
        include: {
          organization: { select: { id: true, name: true } },
          prospect: { select: { id: true, agency_name: true } },
          assignee: { select: { first_name: true, last_name: true } },
          creator: { select: { first_name: true, last_name: true } },
        },
      });
      return rows.map((t) => {
        const done = t.is_done === 1;
        const due = t.due_date.getTime();
        return {
          id: t.id,
          title: t.title,
          description: t.description,
          target: targetOf(t),
          dueDate: ymd(t.due_date),
          status: done ? "completed" : due < today.getTime() ? "overdue" : due === today.getTime() ? "dueToday" : "upcoming",
          priority: t.priority,
          priorityLabel: BdmTaskPriorityLabel[t.priority as BdmTaskPriority] ?? "Normal",
          category: t.category,
          categoryLabel: BdmTaskCategoryLabel[t.category as BdmTaskCategory] ?? "Other",
          done,
          completedAt: t.completed_at ? t.completed_at.toISOString() : null,
          assignedTo: t.assigned_to,
          assigneeName: fullName(t.assignee),
          creatorName: t.creator ? fullName(t.creator) : null,
          createdAt: t.created_at.toISOString(),
        };
      });
    }),

  create: bdmCrmProcedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(255),
        description: text(1000),
        target,
        dueDate: dateOnly,
        priority: priorityCode.default(BdmTaskPriority.NORMAL),
        category: categoryCode,
        assignedTo: id.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.dueDate < businessToday()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A new task can't be due in the past." });
      }
      const assignee = await actorOrBdm(ctx.cpUser, input.assignedTo);
      const t = await resolveTarget(ctx.cpUser, input.target);
      const task = await db.bdm_task.create({
        data: {
          title: input.title,
          description: input.description,
          ...t,
          due_date: input.dueDate,
          priority: input.priority,
          category: input.category,
          assigned_to: assignee,
          created_by: ctx.cpUser.id,
        },
      });
      return { id: task.id };
    }),

  complete: bdmCrmProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const t = await db.bdm_task.findUnique({ where: { id: input.id }, select: { assigned_to: true } });
    if (!t) throw notFound("Task");
    assertOwns(ctx.cpUser, t.assigned_to, "Task");
    await db.bdm_task.update({ where: { id: input.id }, data: { is_done: 1, completed_at: new Date() } });
    return { id: input.id };
  }),

  reopen: bdmCrmProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const t = await db.bdm_task.findUnique({ where: { id: input.id }, select: { assigned_to: true } });
    if (!t) throw notFound("Task");
    assertOwns(ctx.cpUser, t.assigned_to, "Task");
    await db.bdm_task.update({ where: { id: input.id }, data: { is_done: 0, completed_at: null } });
    return { id: input.id };
  }),

  // bdm_task keeps no reschedule history, so the old date and the reason go to
  // audit_log.
  reschedule: bdmCrmProcedure
    .input(z.object({ id, dueDate: dateOnly, reason: text(500) }))
    .mutation(async ({ ctx, input }) => {
      if (input.dueDate < businessToday()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A task can't be rescheduled into the past." });
      }
      const t = await db.bdm_task.findUnique({ where: { id: input.id }, select: { assigned_to: true, is_done: true, due_date: true } });
      if (!t) throw notFound("Task");
      assertOwns(ctx.cpUser, t.assigned_to, "Task");
      if (t.is_done === 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Reopen the task before rescheduling it." });
      }
      await db.bdm_task.update({ where: { id: input.id }, data: { due_date: input.dueDate } });
      await audit("bdm_task.rescheduled", "bdm_task", input.id, {
        byCpUserId: ctx.cpUser.id,
        from: ymd(t.due_date),
        to: ymd(input.dueDate),
        reason: input.reason ?? null,
      });
      return { id: input.id };
    }),
});

export const bdmCrmRouter = createTRPCRouter({
  prospect: prospectRouter,
  activity: activityRouter,
  task: taskRouter,
});
