import "server-only";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { AdminRole, InactiveReason, ShortlistApproval, ShortlistSource } from "~/server/db/enums";
import { partnerName } from "~/lib/partner-display";
import {
  CASE_END_REASON_LABEL,
  FOLLOW_UP_CHANNELS,
  STAGE_GAP_WORKING_DAYS,
  ShortlistCaseStatus,
  ShortlistPhaseLabel,
  TaskCategory,
  TaskStatus,
  followUpStageLabel,
  fmtWeekday,
  partnerResponseLabel,
  shortlistClosureLabel,
  taskCode,
  type FollowUpStage,
  type PartnerResponse,
  type ShortlistClosureReason,
  type ShortlistPhase,
} from "~/lib/tasks";
import { dateInTimezone, dateKey } from "~/server/out-of-office";
import { requireStaffStudent, staffStudentScope, type StaffUser } from "~/server/staff-access";
import { myTaskOwnerIds, tasksLiveSince } from "~/server/tasks";

// Who may reopen a closed case / reactivate a student closed at shortlisting:
// the counselling team and Super Admin (Suraj, 19 Nov 2026).
const canReopenRole = (role: number) =>
  role === AdminRole.SUPER_ADMIN || role === AdminRole.COUNSELLOR_LEAD || role === AdminRole.COUNSELLOR;
import { addWorkingDays, taskClock, workingDaysBetween, type TaskClock } from "~/server/working-days";
import { stampMilestone } from "~/server/shortlisting-tat";

// Shortlist follow-up & escalation (item 7, decided with Suraj 19 Nov 2026;
// PDF pages 1-3). Supersedes Phase 3B's "no timeout and no reminders" for
// Collegepond-proposed universities awaiting the partner's approval.
//
//   Stage 1  Shortlist shared: a Collegepond proposal is pending with the
//            partner (Uni Assist "Shortlist", or a re-proposal). The case
//            opens and the partner-response timer starts (shared_at).
//   Stage 2  The next working day: a follow-up task. The counsellor records
//            the partner's response, or why confirmation is pending.
//   Stage 3  3 working days later: another task. The counsellor must log a
//            call, email and/or WhatsApp (at least one) and comments.
//   Stage 4  3 working days later: Proceed further (partner confirmed →
//            the application process) or Close case (closed at the
//            shortlisting stage, reason required).
// A stage is never due earlier than the working day after the previous one
// was recorded. Working days: Mon-Fri, TAT holidays skipped
// (src/server/working-days.ts). Stage tasks are cp_task rows (source
// "shortlist"), created on their due day by syncShortlistCases (on read,
// after every shortlist action and from the morning cron), so a late cron
// changes nothing.
//
// The workflow stops when the partner confirms:
//   - in the portal: the partner's first approval of any Collegepond
//     proposal made after the case opened (decided by Suraj);
//   - recorded by the counsellor ("Partner confirmed" / "Proceed further"):
//     the pending proposals are approved on the partner's behalf
//     (audit-logged), so Apply unlocks.
// Either way open follow-up tasks are cancelled and a "Begin application"
// task is created for the counsellor.
// It also stops (ended) when the partner asks for changes, rejects every
// proposal, the proposals are withdrawn, or the student is marked inactive;
// sharing again opens a new case. "Close case" sets the student Inactive
// (reason Closed – Shortlisting); the counselling team (Counsellor,
// Counsellor Lead, Super Admin) can reopen it later, or reactivate the
// student, which reopens it too (Suraj, 19 Nov 2026: so they can act fast),
// and that restarts the schedule.

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();
const toDate = (key: string) => new Date(`${key}T00:00:00Z`);
const keyOf = (d: Date | null | undefined) => (d ? dateKey(d) : null);
const fail = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const LOG = "[shortlist-follow-up]";
const logError = (ctx: string, e: unknown) => console.error(`${LOG} ${ctx} failed:`, e instanceof Error ? e.message : e);

const OPEN_TASK = [TaskStatus.PENDING, TaskStatus.IN_PROGRESS];

const STAGE_TASK: Record<FollowUpStage, { title: string; activity: string }> = {
  2: { title: "Follow up for shortlist confirmation", activity: "Record the partner's response, or why confirmation is pending" },
  3: { title: "Second follow-up for shortlist", activity: "Call, email and/or WhatsApp the partner and log what you did" },
  4: { title: "Final follow-up: proceed or close", activity: "Proceed further (partner confirmed) or close the case with a reason" },
};

const stageKey = (c: { id: number; cycle: number }, stage: number) => `sl:${c.id}:${c.cycle}:${stage}`;
const beginKey = (c: { id: number; cycle: number }) => `sl:${c.id}:${c.cycle}:begin`;

type CaseRow = Prisma.shortlist_follow_upGetPayload<object>;

const studentSelect = {
  id: true,
  first_name: true,
  last_name: true,
  inactive_at: true,
  inactive_reason: true,
  cp_counsellor_id: true,
  org_id: true,
  created_by_user_id: true,
} as const;

const proposalSelect = {
  id: true,
  course_id: true,
  approval_status: true,
  proposed_at: true,
  decided_at: true,
  decided_by_user_id: true,
  collegepond_user_id: true,
  course: { select: { name: true, university: { select: { name: true } } } },
} as const;

async function event(
  c: { id: number; student_id: number },
  kind: string,
  e: Partial<{
    stage: number;
    cpUserId: number | null;
    partnerUserId: number | null;
    response: string | null;
    channels: string | null;
    callTime: string | null;
    callOutcome: string | null;
    comments: string | null;
    taskId: number | null;
    detail: string | null;
    at: Date;
  }> = {},
) {
  await db.shortlist_follow_up_event.create({
    data: {
      case_id: c.id,
      student_id: c.student_id,
      kind,
      stage: e.stage ?? null,
      cp_user_id: e.cpUserId ?? null,
      partner_user_id: e.partnerUserId ?? null,
      response: e.response ?? null,
      channels: e.channels ?? null,
      call_time: e.callTime ?? null,
      call_outcome: e.callOutcome ?? null,
      comments: e.comments ? e.comments.slice(0, 1000) : null,
      task_id: e.taskId ?? null,
      detail: e.detail ? e.detail.slice(0, 500) : null,
      ...(e.at ? { created_at: e.at } : {}),
    },
  });
}

async function taskEvent(taskId: number, kind: string, cpUserId: number | null, note?: string | null, to?: string | null) {
  await db.cp_task_event.create({
    data: { task_id: taskId, kind, cp_user_id: cpUserId, note: note?.slice(0, 1000) ?? null, to_date: to ? toDate(to) : null },
  });
}

const uniList = (rows: { course: { name: string; university: { name: string } } }[]) =>
  [...new Set(rows.map((r) => r.course.university.name))].join(", ");

// ---- Sync -------------------------------------------------------------------

let lastFullSync = 0;

// Open, advance and stop cases from the shortlist rows; create stage tasks
// that have fallen due. With no ids: every student with a pending
// Collegepond proposal or an open case (throttled unless forced).
export async function syncShortlistCases(
  opts: { studentIds?: number[]; force?: boolean; sharedCourseIds?: number[]; actorCpUserId?: number | null } = {},
): Promise<void> {
  try {
    let ids = opts.studentIds;
    if (!ids) {
      if (!opts.force && Date.now() - lastFullSync < 20_000) return;
      lastFullSync = Date.now();
      const [pending, open] = await Promise.all([
        db.shortlist.findMany({
          where: { added_by: ShortlistSource.COLLEGEPOND, approval_status: ShortlistApproval.PENDING },
          select: { student_id: true },
          distinct: ["student_id"],
        }),
        db.shortlist_follow_up.findMany({ where: { status: ShortlistCaseStatus.OPEN }, select: { student_id: true } }),
      ]);
      ids = [...new Set([...pending.map((r) => r.student_id), ...open.map((r) => r.student_id)])];
    }
    if (ids.length === 0) return;
    const clock = await taskClock();
    const since = await tasksLiveSince();
    for (const id of ids) {
      try {
        await syncStudent(id, clock, since, opts);
      } catch (e) {
        logError(`sync student ${id}`, e);
      }
    }
  } catch (e) {
    logError("sync", e);
  }
}

async function syncStudent(
  studentId: number,
  clock: TaskClock,
  since: Date,
  opts: { sharedCourseIds?: number[]; actorCpUserId?: number | null },
) {
  const [student, open, proposals, latest] = await Promise.all([
    db.student.findUnique({ where: { id: studentId }, select: studentSelect }),
    db.shortlist_follow_up.findUnique({ where: { open_student_id: studentId } }),
    db.shortlist.findMany({
      where: { student_id: studentId, added_by: ShortlistSource.COLLEGEPOND },
      select: proposalSelect,
    }),
    db.shortlist_follow_up.findFirst({ where: { student_id: studentId }, orderBy: { id: "desc" } }),
  ]);
  if (!student) return;
  const pending = proposals.filter((p) => p.approval_status === ShortlistApproval.PENDING);

  if (open) {
    const approval = proposals.find(
      (p) =>
        p.approval_status === ShortlistApproval.APPROVED &&
        p.decided_by_user_id !== null &&
        p.decided_at !== null &&
        p.decided_at >= open.cycle_started_at,
    );
    if (approval) {
      await confirmCase(open, student, { via: "portal", partnerUserId: approval.decided_by_user_id, clock });
      return;
    }
    if (student.inactive_at) {
      await finishCase(open, ShortlistCaseStatus.ENDED, { end_reason: "student_inactive" }, null, "Student marked inactive");
      await event(open, "ended", { detail: CASE_END_REASON_LABEL.student_inactive });
      return;
    }
    if (pending.length === 0) {
      const rejected = proposals.some(
        (p) => p.approval_status === ShortlistApproval.REJECTED && p.decided_at && p.decided_at >= open.cycle_started_at,
      );
      const reason = rejected ? "all_rejected" : "withdrawn";
      await finishCase(open, ShortlistCaseStatus.ENDED, { end_reason: reason }, null, CASE_END_REASON_LABEL[reason]!);
      await event(open, "ended", { detail: CASE_END_REASON_LABEL[reason] });
      return;
    }
    if (opts.sharedCourseIds?.length) {
      // The case was already open before this share (it was loaded above).
      const added = pending.filter((p) => opts.sharedCourseIds!.includes(p.course_id));
      if (added.length) await event(open, "schools_added", { cpUserId: opts.actorCpUserId ?? null, detail: uniList(added) });
    }
    await ensureStageTask(open, student, clock);
    return;
  }

  if (pending.length === 0 || student.inactive_at) return;
  const lastEnd = latest ? (latest.outcome_at ?? latest.updated_at) : null;
  const fresh = lastEnd ? pending.filter((p) => p.proposed_at > lastEnd) : pending;
  if (fresh.length === 0) return;
  fresh.sort((a, b) => a.proposed_at.getTime() - b.proposed_at.getTime());
  const sharedAt = fresh[0]!.proposed_at;
  const sharedKey = dateInTimezone(sharedAt, clock.config.timezone);
  // Proposals already waiting when this went live get their first follow-up
  // the next working day, not a backlog of overdue ones.
  const base = sharedAt >= since ? sharedKey : clock.today;
  const nextDue = addWorkingDays(base, STAGE_GAP_WORKING_DAYS[2], clock.config);
  let created: CaseRow;
  try {
    created = await db.shortlist_follow_up.create({
      data: {
        student_id: studentId,
        open_student_id: studentId,
        shared_at: sharedAt,
        shared_by_cp_user_id: fresh[0]!.collegepond_user_id,
        cycle_started_at: sharedAt,
        next_stage: 2,
        next_due_date: toDate(nextDue),
      },
    });
  } catch (e) {
    // Another sync opened it first (unique open_student_id).
    if (e instanceof Error && e.message.includes("Unique constraint")) return;
    throw e;
  }
  await event(created, "shared", {
    cpUserId: fresh[0]!.collegepond_user_id,
    detail: uniList(fresh),
    at: sharedAt,
  });
  await stampMilestone(studentId, "shared_at", sharedAt);
  await ensureStageTask(created, student, clock);
}

async function ensureStageTask(
  c: CaseRow,
  student: { cp_counsellor_id: number | null },
  clock: Pick<TaskClock, "today">,
) {
  if (c.status !== ShortlistCaseStatus.OPEN || !c.next_due_date) return;
  const due = dateKey(c.next_due_date);
  const key = stageKey(c, c.next_stage);
  const assignee = student.cp_counsellor_id ?? c.shared_by_cp_user_id;
  const existing = await db.cp_task.findUnique({ where: { source_key: key } });
  if (existing) {
    if (OPEN_TASK.includes(existing.status as 0 | 1)) {
      const data: Prisma.cp_taskUpdateInput = {};
      if (assignee !== null && existing.assignee_cp_user_id !== assignee) data.assignee = { connect: { id: assignee } };
      if (Object.keys(data).length) await db.cp_task.update({ where: { id: existing.id }, data });
    }
    return;
  }
  if (due > clock.today) return;
  const stage = c.next_stage as FollowUpStage;
  const meta = STAGE_TASK[stage];
  if (!meta) return;
  try {
    const t = await db.cp_task.create({
      data: {
        title: meta.title,
        student_id: c.student_id,
        category: TaskCategory.PARTNER_FOLLOW_UP,
        priority: 2,
        pending_activity: meta.activity,
        status: TaskStatus.PENDING,
        assignee_cp_user_id: assignee,
        assigned_on: toDate(clock.today),
        original_due_date: toDate(due),
        due_date: toDate(due),
        source: "shortlist",
        source_id: c.id,
        source_key: key,
      },
    });
    await taskEvent(t.id, "created", null, `${followUpStageLabel(stage)} for the shortlist shared ${fmtWeekday(dateInTimezone(c.shared_at, "Asia/Kolkata"))}`, due);
    await event(c, "task_created", { stage, taskId: t.id, detail: `${taskCode(t.id)} · due ${fmtWeekday(due)}` });
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("Unique constraint"))) throw e;
  }
}

// Close the case (confirmed / closed / ended) and cancel its open stage tasks.
async function finishCase(
  c: CaseRow,
  status: number,
  data: Prisma.shortlist_follow_upUpdateInput,
  actorId: number | null,
  cancelNote: string,
  completeOpenStageTask = false,
) {
  const res = await db.shortlist_follow_up.updateMany({
    where: { id: c.id, status: ShortlistCaseStatus.OPEN },
    data: {
      status,
      open_student_id: null,
      outcome_at: new Date(),
      ...(actorId ? { outcome_by_cp_user_id: actorId } : {}),
      ...(data as Prisma.shortlist_follow_upUpdateManyMutationInput),
    },
  });
  if (res.count === 0) throw new TRPCError({ code: "CONFLICT", message: "This follow-up has already been closed." });
  const open = await db.cp_task.findMany({
    where: { source: "shortlist", source_id: c.id, status: { in: OPEN_TASK } },
    select: { id: true, source_key: true },
  });
  for (const t of open) {
    if (t.source_key?.endsWith(":begin")) continue;
    if (completeOpenStageTask) {
      await db.cp_task.update({
        where: { id: t.id },
        data: { status: TaskStatus.COMPLETED, completed_at: new Date(), completed_by_cp_user_id: actorId },
      });
      await taskEvent(t.id, "completed", actorId, cancelNote);
    } else {
      await db.cp_task.update({
        where: { id: t.id },
        data: { status: TaskStatus.CANCELLED, cancelled_at: new Date(), cancel_reason: cancelNote.slice(0, 255) },
      });
      await taskEvent(t.id, "cancelled", actorId, cancelNote);
    }
    await db.cp_task_shift_request.updateMany({ where: { task_id: t.id, status: { in: [0, 1] } }, data: { status: 5 } });
  }
}

async function confirmCase(
  c: CaseRow,
  student: { id: number; cp_counsellor_id: number | null },
  o: { via: "portal" | "counsellor" | "proceed"; partnerUserId?: number | null; actorId?: number | null; comments?: string | null; clock: TaskClock },
) {
  const actor = o.actorId ?? null;
  let approved: { course: { name: string; university: { name: string } } }[] = [];
  if (o.via !== "portal") {
    // The partner confirmed outside the portal: approve the pending
    // proposals on their behalf so Apply unlocks (decided with Suraj).
    const pending = await db.shortlist.findMany({
      where: { student_id: student.id, added_by: ShortlistSource.COLLEGEPOND, approval_status: ShortlistApproval.PENDING },
      select: { id: true, course_id: true, course: { select: { name: true, university: { select: { name: true } } } } },
    });
    if (pending.length) {
      await db.shortlist.updateMany({
        where: { id: { in: pending.map((p) => p.id) }, approval_status: ShortlistApproval.PENDING },
        data: {
          approval_status: ShortlistApproval.APPROVED,
          decided_at: new Date(),
          decided_by_cp_user_id: actor,
          decided_by_user_id: null,
          reject_reason: null,
          reject_reason_code: null,
        },
      });
      await db.audit_log.createMany({
        data: pending.map((p) => ({
          action: "student.shortlist_approved",
          entity_type: "student",
          entity_id: student.id,
          metadata: { courseId: p.course_id, byCpUserId: actor, via: "partner_confirmed_offline" },
        })),
      });
    }
    approved = pending;
  } else {
    approved = await db.shortlist.findMany({
      where: { student_id: student.id, added_by: ShortlistSource.COLLEGEPOND, approval_status: ShortlistApproval.APPROVED, decided_at: { gte: c.cycle_started_at } },
      select: { course: { select: { name: true, university: { select: { name: true } } } } },
    });
  }
  await finishCase(
    c,
    ShortlistCaseStatus.CONFIRMED,
    { confirmed_via: o.via, ...(o.partnerUserId ? { outcome_by_user_id: o.partnerUserId } : {}) },
    actor,
    "Partner confirmed",
    o.via !== "portal",
  );
  await event(c, "confirmed", {
    cpUserId: actor,
    partnerUserId: o.partnerUserId ?? null,
    comments: o.comments ?? null,
    detail:
      o.via === "portal"
        ? `Partner approved in the portal${approved.length ? ` · ${uniList(approved)}` : ""}`
        : o.via === "proceed"
          ? `Proceed further${approved.length ? ` · approved on the partner's behalf: ${uniList(approved)}` : ""}`
          : `Confirmation recorded by the counsellor${approved.length ? ` · approved on the partner's behalf: ${uniList(approved)}` : ""}`,
  });
  await stampMilestone(student.id, "confirmed_at", new Date());
  // The student moves into the application process: a task to start it.
  const assignee = student.cp_counsellor_id ?? actor ?? c.shared_by_cp_user_id;
  const due = addWorkingDays(o.clock.today, 1, o.clock.config);
  try {
    const t = await db.cp_task.create({
      data: {
        title: `Begin application${approved.length ? ` – ${uniList(approved)}` : ""}`.slice(0, 200),
        student_id: student.id,
        category: TaskCategory.APPLICATION_PROCESSING,
        priority: 2,
        pending_activity: "The partner confirmed the shortlist: click Apply on the approved universities",
        status: TaskStatus.PENDING,
        assignee_cp_user_id: assignee,
        created_by_cp_user_id: actor,
        assigned_on: toDate(o.clock.today),
        original_due_date: toDate(due),
        due_date: toDate(due),
        source: "shortlist",
        source_id: c.id,
        source_key: beginKey(c),
      },
    });
    await taskEvent(t.id, "created", actor, "Partner confirmed the shortlist", due);
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("Unique constraint"))) logError("begin application task", e);
  }
}

// An application was created for the student: the "Begin application" task
// is done.
export async function completeBeginApplicationTasks(studentId: number, actorId: number | null) {
  try {
    const open = await db.cp_task.findMany({
      where: { student_id: studentId, source: "shortlist", source_key: { endsWith: ":begin" }, status: { in: OPEN_TASK } },
      select: { id: true },
    });
    for (const t of open) {
      await db.cp_task.update({
        where: { id: t.id },
        data: { status: TaskStatus.COMPLETED, completed_at: new Date(), completed_by_cp_user_id: actorId },
      });
      await taskEvent(t.id, "completed", actorId, "Application created");
    }
  } catch (e) {
    logError("complete begin-application task", e);
  }
}

// ---- Counsellor actions ------------------------------------------------------

async function requireOpenCase(user: StaffUser, caseId: number) {
  const c = await db.shortlist_follow_up.findUnique({ where: { id: caseId } });
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Follow-up not found" });
  await requireStaffStudent(user, c.student_id);
  if (c.status !== ShortlistCaseStatus.OPEN) throw new TRPCError({ code: "CONFLICT", message: "This follow-up has already been closed." });
  const student = await db.student.findUnique({ where: { id: c.student_id }, select: studentSelect });
  if (!student) throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
  return { c, student };
}

export type RecordInput = {
  caseId: number;
  stage: FollowUpStage;
  response?: PartnerResponse;
  channels?: string[];
  callTime?: string | null;
  callOutcome?: string | null;
  comments?: string | null;
  decision?: "proceed" | "close";
  closureReason?: ShortlistClosureReason;
};

async function completeStageTask(c: CaseRow, stage: number, actorId: number, note: string) {
  const t = await db.cp_task.findUnique({ where: { source_key: stageKey(c, stage) } });
  if (!t || !OPEN_TASK.includes(t.status as 0 | 1)) return null;
  await db.cp_task.update({
    where: { id: t.id },
    data: { status: TaskStatus.COMPLETED, completed_at: new Date(), completed_by_cp_user_id: actorId, remarks: note.slice(0, 1000) },
  });
  await taskEvent(t.id, "completed", actorId, note);
  await db.cp_task_shift_request.updateMany({ where: { task_id: t.id, status: { in: [0, 1] } }, data: { status: 5 } });
  return t.id;
}

export async function recordFollowUp(user: StaffUser, input: RecordInput) {
  const { c, student } = await requireOpenCase(user, input.caseId);
  if (input.stage !== c.next_stage) {
    throw fail(`The ${followUpStageLabel(c.next_stage).toLowerCase()} is the one to record now.`);
  }
  const comments = input.comments?.trim() ?? "";
  const channels = [...new Set((input.channels ?? []).filter((ch) => FOLLOW_UP_CHANNELS.some((x) => x.code === ch)))];
  const clock = await taskClock();

  if (input.stage === 4) {
    if (!input.decision) throw fail("Choose Proceed further or Close case.");
    if (input.decision === "close") {
      if (!input.closureReason) throw fail("Choose a closure reason.");
      if (input.closureReason === "other" && !comments) throw fail("Add a comment for Other.");
      await event(c, "stage_recorded", { stage: 4, cpUserId: user.id, response: "close", comments, detail: `Close case: ${shortlistClosureLabel(input.closureReason)}` });
      await completeStageTask(c, 4, user.id, `Closed: ${shortlistClosureLabel(input.closureReason)}${comments ? ` · ${comments}` : ""}`);
      await closeCase(user, c, student, input.closureReason, comments);
      return { outcome: "closed" as const };
    }
    await event(c, "stage_recorded", { stage: 4, cpUserId: user.id, response: "confirmed", comments, detail: "Proceed further" });
    await confirmCase(c, student, { via: "proceed", actorId: user.id, comments, clock });
    return { outcome: "confirmed" as const };
  }

  const response = input.response ?? "pending";
  if (input.stage === 3 && channels.length === 0) throw fail("Pick at least one: call, email or WhatsApp.");
  if (input.stage === 3 && !comments) throw fail("Add comments on the follow-up.");
  if (response === "pending" && !comments) throw fail("Say why confirmation is pending.");
  const summary = [
    partnerResponseLabel(response),
    channels.length ? channels.map((ch) => FOLLOW_UP_CHANNELS.find((x) => x.code === ch)?.label ?? ch).join(", ") : null,
    comments || null,
  ]
    .filter(Boolean)
    .join(" · ");
  const taskId = await completeStageTask(c, input.stage, user.id, summary);
  await event(c, "stage_recorded", {
    stage: input.stage,
    cpUserId: user.id,
    response,
    channels: channels.join(",") || null,
    callTime: channels.includes("call") ? (input.callTime?.trim().slice(0, 10) ?? null) : null,
    callOutcome: channels.includes("call") ? (input.callOutcome?.trim().slice(0, 30) ?? null) : null,
    comments: comments || null,
    taskId,
  });
  if (response === "confirmed") {
    // The stage task is already completed; confirmCase cancels nothing else.
    await confirmCase(c, student, { via: "counsellor", actorId: user.id, comments, clock });
    return { outcome: "confirmed" as const };
  }
  if (response === "changes") {
    await finishCase(c, ShortlistCaseStatus.ENDED, { end_reason: "changes_requested" }, user.id, "Partner asked for changes");
    await event(c, "ended", { cpUserId: user.id, detail: CASE_END_REASON_LABEL.changes_requested, comments: comments || null });
    return { outcome: "ended" as const };
  }
  // Still pending: schedule the next stage.
  const next = (input.stage + 1) as FollowUpStage;
  const prevDue = keyOf(c.next_due_date) ?? clock.today;
  const fromSchedule = addWorkingDays(prevDue, STAGE_GAP_WORKING_DAYS[next], clock.config);
  const earliest = addWorkingDays(clock.today, 1, clock.config);
  const nextDue = fromSchedule > earliest ? fromSchedule : earliest;
  await db.shortlist_follow_up.update({
    where: { id: c.id },
    data: { next_stage: next, next_due_date: toDate(nextDue), last_recorded_at: new Date() },
  });
  return { outcome: "scheduled" as const, nextStage: next, nextDue };
}

// "Partner confirmed" at any stage (by phone, email …).
export async function markPartnerConfirmed(user: StaffUser, caseId: number, comments?: string | null) {
  const { c, student } = await requireOpenCase(user, caseId);
  const clock = await taskClock();
  await confirmCase(c, student, { via: "counsellor", actorId: user.id, comments: comments?.trim() ? comments.trim() : null, clock });
  return { ok: true as const };
}

async function closeCase(
  user: StaffUser,
  c: CaseRow,
  student: { id: number; inactive_at: Date | null },
  reason: ShortlistClosureReason,
  comments: string,
) {
  await finishCase(
    c,
    ShortlistCaseStatus.CLOSED,
    { closure_reason: reason, closure_note: comments || null },
    user.id,
    "Case closed at shortlisting",
    true,
  );
  await event(c, "closed", { cpUserId: user.id, comments: comments || null, detail: shortlistClosureLabel(reason) });
  if (!student.inactive_at) {
    const note = `${shortlistClosureLabel(reason)}${comments ? `: ${comments}` : ""}`.slice(0, 255);
    await db.student.update({
      where: { id: student.id },
      data: { inactive_at: new Date(), inactive_reason: InactiveReason.SHORTLIST_CLOSED, inactive_note: note, inactive_by_cp_user_id: user.id },
    });
  }
  await db.audit_log.create({
    data: {
      action: "student.shortlist_case_closed",
      entity_type: "student",
      entity_id: student.id,
      metadata: { caseId: c.id, reason: shortlistClosureLabel(reason), note: comments || null, byCpUserId: user.id },
    },
  });
}

// Reopen a closed (or stopped) case: anyone in the counselling team. The
// student is reactivated if the closure made them inactive.
export async function reopenCase(user: StaffUser, caseId: number, comments?: string | null) {
  if (!canReopenRole(user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the counselling team can reopen a case." });
  }
  const c = await db.shortlist_follow_up.findUnique({ where: { id: caseId } });
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Follow-up not found" });
  await requireStaffStudent(user, c.student_id);
  if (c.status !== ShortlistCaseStatus.CLOSED && c.status !== ShortlistCaseStatus.ENDED) {
    throw fail("Only a closed follow-up can be reopened.");
  }
  const latest = await db.shortlist_follow_up.findFirst({ where: { student_id: c.student_id }, orderBy: { id: "desc" }, select: { id: true } });
  if (latest?.id !== c.id) throw fail("A newer follow-up exists for this student.");
  const pending = await db.shortlist.count({
    where: { student_id: c.student_id, added_by: ShortlistSource.COLLEGEPOND, approval_status: ShortlistApproval.PENDING },
  });
  if (pending === 0) {
    throw fail("No universities are awaiting the partner's approval. Re-propose or add universities instead; that starts a new follow-up.");
  }
  const clock = await taskClock();
  const nextDue = addWorkingDays(clock.today, 1, clock.config);
  const now = new Date();
  try {
    await db.shortlist_follow_up.update({
      where: { id: c.id },
      data: {
        status: ShortlistCaseStatus.OPEN,
        open_student_id: c.student_id,
        cycle: { increment: 1 },
        cycle_started_at: now,
        next_stage: 2,
        next_due_date: toDate(nextDue),
        outcome_at: null,
        outcome_by_cp_user_id: null,
        outcome_by_user_id: null,
        confirmed_via: null,
        end_reason: null,
        closure_reason: null,
        closure_note: null,
        reopened_at: now,
        reopened_by_cp_user_id: user.id,
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("Unique constraint")) throw fail("This student already has an open follow-up.");
    throw e;
  }
  await event(c, "reopened", { cpUserId: user.id, comments: comments?.trim() ? comments.trim() : null, detail: `Next follow-up ${fmtWeekday(nextDue)}` });
  const s = await db.student.findUnique({ where: { id: c.student_id }, select: { inactive_at: true, inactive_reason: true } });
  if (s?.inactive_at && s.inactive_reason === InactiveReason.SHORTLIST_CLOSED) {
    await db.student.update({
      where: { id: c.student_id },
      data: { inactive_at: null, inactive_reason: null, inactive_note: null, inactive_by_cp_user_id: null },
    });
    await db.audit_log.create({
      data: { action: "student.reactivated", entity_type: "student", entity_id: c.student_id, metadata: { previousReason: s.inactive_reason, byCpUserId: user.id, via: "shortlist_case_reopened" } },
    });
  }
  await db.audit_log.create({
    data: { action: "student.shortlist_case_reopened", entity_type: "student", entity_id: c.student_id, metadata: { caseId: c.id, byCpUserId: user.id } },
  });
  return { ok: true as const, nextDue };
}

// Reactivate a student who is Inactive because their case was closed at
// shortlisting (decided with Suraj, 19 Nov 2026): anyone in the counselling
// team, so they can act quickly, and it reopens the follow-up too. With
// no university still awaiting the partner there is nothing to follow up,
// so the student is reactivated and the case stays closed.
export async function reactivateShortlistClosed(user: StaffUser, studentId: number) {
  if (!canReopenRole(user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the counselling team can reactivate this student." });
  }
  await requireStaffStudent(user, studentId);
  const latest = await db.shortlist_follow_up.findFirst({
    where: { student_id: studentId },
    orderBy: { id: "desc" },
    select: { id: true, status: true },
  });
  if (latest?.status === ShortlistCaseStatus.CLOSED) {
    const pending = await db.shortlist.count({
      where: { student_id: studentId, added_by: ShortlistSource.COLLEGEPOND, approval_status: ShortlistApproval.PENDING },
    });
    if (pending > 0) {
      // Reopening reactivates the student as well.
      const r = await reopenCase(user, latest.id, "Reactivated from the student page");
      return { reopened: true as const, nextDue: r.nextDue };
    }
  }
  const s = await db.student.findUnique({ where: { id: studentId }, select: { inactive_reason: true } });
  await db.student.update({
    where: { id: studentId },
    data: { inactive_at: null, inactive_reason: null, inactive_note: null, inactive_by_cp_user_id: null },
  });
  await db.audit_log.create({
    data: {
      action: "student.reactivated",
      entity_type: "student",
      entity_id: studentId,
      metadata: { previousReason: s?.inactive_reason ?? null, byCpUserId: user.id, caseReopened: false },
    },
  });
  return { reopened: false as const, nextDue: null };
}

// ---- Reads -----------------------------------------------------------------------

export function phaseOf(c: { status: number; next_stage: number; next_due_date: Date | null }, today: string): ShortlistPhase {
  if (c.status === ShortlistCaseStatus.CONFIRMED) return "confirmed";
  if (c.status === ShortlistCaseStatus.CLOSED) return "closed";
  if (c.status === ShortlistCaseStatus.ENDED) return "ended";
  const due = keyOf(c.next_due_date);
  if (due && due <= today) return c.next_stage === 2 ? "first" : c.next_stage === 3 ? "second" : "final";
  return c.next_stage === 2 ? "shared" : "awaiting";
}

// The schedule from the next stage on, if the partner stays silent.
function projectedSchedule(c: { next_stage: number; next_due_date: Date | null }, clock: TaskClock) {
  const out: { stage: FollowUpStage; label: string; due: string }[] = [];
  let due = keyOf(c.next_due_date);
  for (let s = c.next_stage; s <= 4 && due; s++) {
    out.push({ stage: s as FollowUpStage, label: followUpStageLabel(s), due });
    if (s < 4) due = addWorkingDays(due, STAGE_GAP_WORKING_DAYS[(s + 1) as FollowUpStage], clock.config);
  }
  return out;
}

const caseSelect = {
  id: true,
  student_id: true,
  status: true,
  cycle: true,
  shared_at: true,
  cycle_started_at: true,
  next_stage: true,
  next_due_date: true,
  outcome_at: true,
  confirmed_via: true,
  end_reason: true,
  closure_reason: true,
  closure_note: true,
  reopened_at: true,
  created_at: true,
} as const;

// The student's Application tab panel and Follow-up History tab.
export async function studentPanel(user: StaffUser, studentId: number) {
  await requireStaffStudent(user, studentId);
  await syncShortlistCases({ studentIds: [studentId] });
  const clock = await taskClock();
  const [cases, events, pending, student] = await Promise.all([
    db.shortlist_follow_up.findMany({ where: { student_id: studentId }, orderBy: { id: "desc" }, select: caseSelect }),
    db.shortlist_follow_up_event.findMany({ where: { student_id: studentId }, orderBy: [{ created_at: "desc" }, { id: "desc" }], take: 200 }),
    db.shortlist.findMany({
      where: { student_id: studentId, added_by: ShortlistSource.COLLEGEPOND, approval_status: ShortlistApproval.PENDING },
      select: proposalSelect,
    }),
    db.student.findUnique({
      where: { id: studentId },
      select: { ...studentSelect, organization: { select: { name: true, type: true } }, created_by: { select: { first_name: true, last_name: true } } },
    }),
  ]);
  const current = cases[0] ?? null;
  const cpIds = [...new Set(events.map((e) => e.cp_user_id).filter((x): x is number => x !== null))];
  const partnerIds = [...new Set(events.map((e) => e.partner_user_id).filter((x): x is number => x !== null))];
  const [cps, partners] = await Promise.all([
    cpIds.length ? db.collegepond_user.findMany({ where: { id: { in: cpIds } }, select: { id: true, first_name: true, last_name: true } }) : [],
    partnerIds.length ? db.user.findMany({ where: { id: { in: partnerIds } }, select: { id: true, first_name: true, last_name: true } }) : [],
  ]);
  const cpName = new Map(cps.map((p) => [p.id, fullName(p)]));
  const partnerNameById = new Map(partners.map((p) => [p.id, fullName(p)]));
  const caseEvents = current ? events.filter((e) => e.case_id === current.id) : [];
  // This round only: a reopened case starts its stages again.
  const recorded = (stage: number) =>
    caseEvents.find((e) => e.kind === "stage_recorded" && e.stage === stage && current && e.created_at >= current.cycle_started_at);
  const phase = current ? phaseOf(current, clock.today) : null;
  const canAct = user.role === AdminRole.SUPER_ADMIN || user.role === AdminRole.COUNSELLOR || user.role === AdminRole.COUNSELLOR_LEAD;
  return {
    today: clock.today,
    partnerName: student ? partnerName(student.organization, student.created_by) : "",
    current: current
      ? {
          id: current.id,
          status: current.status,
          open: current.status === ShortlistCaseStatus.OPEN,
          phase: phase!,
          phaseLabel: ShortlistPhaseLabel[phase!],
          sharedAt: current.shared_at.toISOString(),
          waitingWorkingDays: workingDaysBetween(dateInTimezone(current.shared_at, clock.config.timezone), clock.today, clock.config),
          nextStage: current.next_stage,
          nextStageLabel: followUpStageLabel(current.next_stage),
          nextDue: keyOf(current.next_due_date),
          outcomeAt: current.outcome_at?.toISOString() ?? null,
          outcomeLabel:
            current.status === ShortlistCaseStatus.CONFIRMED
              ? current.confirmed_via === "portal"
                ? "Partner approved in the portal"
                : current.confirmed_via === "proceed"
                  ? "Proceed further"
                  : "Partner confirmed (recorded by the counsellor)"
              : current.status === ShortlistCaseStatus.CLOSED
                ? `Closed: ${shortlistClosureLabel(current.closure_reason)}`
                : current.status === ShortlistCaseStatus.ENDED
                  ? (CASE_END_REASON_LABEL[current.end_reason ?? ""] ?? "Stopped")
                  : null,
          closureNote: current.closure_note,
          stages: ([2, 3, 4] as FollowUpStage[]).map((s) => {
            const r = recorded(s);
            return {
              stage: s,
              label: followUpStageLabel(s),
              recordedAt: r?.created_at.toISOString() ?? null,
              response: r?.response ?? null,
              responseLabel: r ? (r.response === "close" ? "Closed" : partnerResponseLabel(r.response)) : null,
              channels: r?.channels ? r.channels.split(",") : [],
            };
          }),
          schedule: current.status === ShortlistCaseStatus.OPEN ? projectedSchedule(current, clock) : [],
          canReopen:
            canReopenRole(user.role) &&
            (current.status === ShortlistCaseStatus.CLOSED || current.status === ShortlistCaseStatus.ENDED) &&
            pending.length > 0,
        }
      : null,
    canAct,
    pendingSchools: pending.map((p) => ({ courseId: p.course_id, university: p.course.university.name, program: p.course.name, proposedAt: p.proposed_at.toISOString() })),
    history: events.map((e) => ({
      id: e.id,
      caseId: e.case_id,
      kind: e.kind,
      stage: e.stage,
      stageLabel: e.stage ? followUpStageLabel(e.stage) : null,
      at: e.created_at.toISOString(),
      by: e.cp_user_id ? (cpName.get(e.cp_user_id) ?? null) : e.partner_user_id ? (partnerNameById.get(e.partner_user_id) ?? "Partner") : null,
      response: e.response,
      responseLabel: e.response ? (e.response === "close" ? "Close case" : partnerResponseLabel(e.response)) : null,
      channels: e.channels ? e.channels.split(",") : [],
      callTime: e.call_time,
      callOutcome: e.call_outcome,
      comments: e.comments,
      detail: e.detail,
      taskCode: e.task_id ? taskCode(e.task_id) : null,
    })),
  };
}

// Open cases for the My Tasks "Shortlist follow-ups" card and Partner
// follow-ups tab, and the pipeline counts. scope "mine" = students assigned
// to me (or someone I cover); "team" = the Students list's visibility.
export async function followUpBoard(user: StaffUser, scope: "mine" | "team") {
  await syncShortlistCases();
  const clock = await taskClock();
  const studentWhere: Prisma.studentWhereInput =
    scope === "mine" ? { cp_counsellor_id: { in: await myTaskOwnerIds(user) } } : await staffStudentScope(user);
  // Monday of this week (IST).
  const dow = new Date(`${clock.today}T00:00:00Z`).getUTCDay();
  const monday = new Date(`${clock.today}T00:00:00+05:30`);
  monday.setUTCDate(monday.getUTCDate() - ((dow + 6) % 7));
  const [open, confirmedWeek, closedWeek] = await Promise.all([
    db.shortlist_follow_up.findMany({
      where: { status: ShortlistCaseStatus.OPEN, student: studentWhere },
      select: {
        ...caseSelect,
        student: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            cp_counsellor: { select: { first_name: true, last_name: true } },
            organization: { select: { name: true, type: true } },
            created_by: { select: { first_name: true, last_name: true } },
          },
        },
        event: { where: { kind: "stage_recorded" }, orderBy: { created_at: "desc" }, select: { stage: true, created_at: true, response: true, comments: true } },
      },
      orderBy: { next_due_date: "asc" },
    }),
    db.shortlist_follow_up.count({ where: { status: ShortlistCaseStatus.CONFIRMED, outcome_at: { gte: monday }, student: studentWhere } }),
    db.shortlist_follow_up.count({ where: { status: ShortlistCaseStatus.CLOSED, outcome_at: { gte: monday }, student: studentWhere } }),
  ]);
  const rows = open.map((c) => {
    const phase = phaseOf(c, clock.today);
    const due = keyOf(c.next_due_date);
    const overdueDays = due && due < clock.today ? workingDaysBetween(due, clock.today, clock.config) : 0;
    const dueState: "overdue" | "today" | "scheduled" = !due ? "scheduled" : due < clock.today || (due === clock.today && clock.dayClosed) ? "overdue" : due === clock.today ? "today" : "scheduled";
    const round = c.event.filter((e) => e.created_at >= c.cycle_started_at);
    const last = round[0];
    return {
      caseId: c.id,
      studentId: c.student.id,
      studentName: fullName(c.student),
      counsellor: c.student.cp_counsellor ? fullName(c.student.cp_counsellor) : null,
      partner: partnerName(c.student.organization, c.student.created_by),
      sharedAt: c.shared_at.toISOString(),
      waitingWorkingDays: workingDaysBetween(dateInTimezone(c.shared_at, clock.config.timezone), clock.today, clock.config),
      phase,
      phaseLabel: ShortlistPhaseLabel[phase],
      nextStage: c.next_stage,
      nextStageLabel: followUpStageLabel(c.next_stage),
      nextDue: due,
      thenDue:
        due && c.next_stage < 4
          ? addWorkingDays(due, STAGE_GAP_WORKING_DAYS[(c.next_stage + 1) as FollowUpStage], clock.config)
          : null,
      dueState,
      overdueDays,
      followUpsDone: round.length,
      lastRecorded: last ? { stage: last.stage, at: last.created_at.toISOString(), response: last.response, comments: last.comments } : null,
    };
  });
  const order = { overdue: 0, today: 1, scheduled: 2 };
  rows.sort((a, b) => order[a.dueState] - order[b.dueState] || (a.nextDue ?? "").localeCompare(b.nextDue ?? ""));
  const counts: Record<string, number> = { shared: 0, awaiting: 0, first: 0, second: 0, final: 0 };
  for (const r of rows) counts[r.phase] = (counts[r.phase] ?? 0) + 1;
  return {
    today: clock.today,
    rows,
    pipeline: { counts, confirmedThisWeek: confirmedWeek, closedThisWeek: closedWeek },
    dueCount: rows.filter((r) => r.dueState !== "scheduled").length,
  };
}
