import "server-only";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { AdminRole } from "~/server/db/enums";
import { partnerName } from "~/lib/partner-display";
import { addDays } from "~/lib/follow-ups";
import {
  ShiftStatus,
  TaskCategory,
  TaskStatus,
  calendarDaysBetween,
  delayReasonLabel,
  fmtShortDay,
  fmtWeekday,
  taskCode,
  taskState,
  type DelayReason,
  type TaskSource,
  type TaskState,
} from "~/lib/tasks";
import { dateInTimezone, dateKey } from "~/server/out-of-office";
import { coveredCounsellorIds, responderFor } from "~/server/out-of-office";
import {
  assignableCounsellorIds,
  canSeeStudent,
  isCounsellingRole,
  requireStaffStudent,
  teamMemberIds,
  type StaffUser,
} from "~/server/staff-access";
import { completeFollowUp, rescheduleFollowUp } from "~/server/follow-ups";
import { createStaffNotifications } from "~/server/staff-notify";
import { appUrl, dayCloseEmail, sendEmail } from "~/server/email";
import { taskClock, workingDayOnOrBefore, type TaskClock } from "~/server/working-days";

// Counsellor Task Management (item 8, decided with Suraj 19 Nov 2026; PDF
// pages 1, 4-7).
//
// ONE task list. cp_task holds:
//   manual     tasks a counsellor / lead creates (Create task);
//   shortlist  the shortlist follow-up stage tasks and "Begin application"
//              (src/server/shortlist-follow-up.ts);
//   note       a mirror of each student Tasks & Notes reminder
//              (student_note.is_task = 1);
//   follow_up  a mirror of each application follow-up (decision / deposit /
//              visa, src/server/follow-ups.ts).
// The mirrors are made and kept in step by syncLinkedTasks() (on read,
// throttled, after our own writes and from the morning cron). Their own
// tables and screens stay the source of truth and keep working; completing
// one here completes it there, and an approved shift moves its date there.
//
// Dates: original_due_date is set once and never changes; due_date is the
// revised one. Every move is a cp_task_event (ageing report). A task is
// overdue once its due day has closed (7 PM IST): derived on read, never
// stored, so a late or missing cron changes nothing.
//
// Who sees what:
//   My tasks        the tasks assigned to me, plus those of anyone I'm
//                   covering while they're out of office (out-of-office.ts);
//   team views      a Counsellor Lead: their own and their team's; a Super
//                   Admin: everyone's (taskScopeIds).
// Head Counsellor (carry-forward approvals) = the Counsellor Lead of the
// counsellor's counselling team; a lead's own requests, or a counsellor in
// no team, go to Super Admin. While the lead is out of office their
// alternate decides and gets the emails instead (Suraj, 19 Nov 2026); worked
// out on every read, so it ends with the out-of-office dates. Nobody decides
// their own request. A Super Admin can always decide.

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();
const toDate = (key: string) => new Date(`${key}T00:00:00Z`);
const keyOf = (d: Date | null | undefined) => (d ? dateKey(d) : null);
const fail = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
const LOG = "[tasks]";
const logError = (ctx: string, e: unknown) => console.error(`${LOG} ${ctx} failed:`, e instanceof Error ? e.message : e);

const OPEN_STATUSES = [TaskStatus.PENDING, TaskStatus.IN_PROGRESS];

// ---- Scope ------------------------------------------------------------------

// The people whose tasks are on "my" list: me, and anyone I cover today.
export async function myTaskOwnerIds(user: StaffUser): Promise<number[]> {
  return [user.id, ...(await coveredCounsellorIds(user.id))];
}

// Whose tasks a user may see in team views. null = everyone (Super Admin).
export async function taskScopeIds(user: StaffUser): Promise<number[] | null> {
  if (user.role === AdminRole.SUPER_ADMIN) return null;
  const covered = await coveredCounsellorIds(user.id);
  if (user.role === AdminRole.COUNSELLOR_LEAD) {
    return [...new Set([user.id, ...(await teamMemberIds(user.id)), ...covered])];
  }
  return [user.id, ...covered];
}

export const isHeadCounsellorRole = (role: number) =>
  role === AdminRole.SUPER_ADMIN || role === AdminRole.COUNSELLOR_LEAD;

function assigneeWhere(ids: number[] | null): Prisma.cp_taskWhereInput {
  return ids === null ? {} : { assignee_cp_user_id: { in: ids } };
}

// The Head Counsellor who approves this person's carry-forward requests: the
// lead of their counselling team. null = Super Admin (a lead's own, or no team).
export async function headCounsellorOf(cpUserId: number): Promise<number | null> {
  const m = await db.counsellor_team_member.findUnique({
    where: { cp_user_id: cpUserId },
    select: { team: { select: { lead: { select: { id: true, status: true } } } } },
  });
  const lead = m?.team.lead;
  return lead?.status === 1 && lead.id !== cpUserId ? lead.id : null;
}

// Who acts for that Head Counsellor today: their out-of-office alternate
// while they're out, else themselves. null = Super Admin, which is also
// where it goes when the acting person is the one who asked.
export async function actingApprover(approverId: number | null, requesterId: number): Promise<number | null> {
  if (approverId === null) return null;
  const acting = await responderFor(approverId);
  return acting === requesterId ? null : acting;
}

const personSelect = { id: true, email: true, first_name: true, last_name: true } as const;

// The people to email about a counsellor's requests, and whom they cover.
async function approverRecipients(approverId: number | null, requesterId: number) {
  const superAdmins = () =>
    db.collegepond_user.findMany({ where: { role: AdminRole.SUPER_ADMIN, status: 1 }, select: personSelect });
  const acting = await actingApprover(approverId, requesterId);
  if (acting === null) return { people: await superAdmins(), coveringFor: null as string | null };
  const people = await db.collegepond_user.findMany({ where: { id: acting, status: 1 }, select: personSelect });
  if (people.length === 0) return { people: await superAdmins(), coveringFor: null as string | null };
  let coveringFor: string | null = null;
  if (acting !== approverId && approverId !== null) {
    const lead = await db.collegepond_user.findUnique({ where: { id: approverId }, select: { first_name: true, last_name: true } });
    coveringFor = lead ? fullName(lead) : null;
  }
  return { people, coveringFor };
}

// May this user act on a task (complete, edit, give a reason)?
async function requireTaskAccess(user: StaffUser, taskId: number) {
  const t = await db.cp_task.findUnique({ where: { id: taskId } });
  if (!t) throw notFound();
  const ids = await taskScopeIds(user);
  if (ids !== null && (t.assignee_cp_user_id === null || !ids.includes(t.assignee_cp_user_id))) {
    // Unassigned tasks: whoever can see the student.
    if (t.assignee_cp_user_id !== null || !(await canSeeStudent(user, t.student_id))) throw notFound();
  }
  return t;
}

// ---- Events -----------------------------------------------------------------

async function addEvent(
  taskId: number,
  kind: string,
  e: { cpUserId?: number | null; from?: string | null; to?: string | null; reason?: string | null; note?: string | null } = {},
) {
  await db.cp_task_event.create({
    data: {
      task_id: taskId,
      kind,
      cp_user_id: e.cpUserId ?? null,
      from_date: e.from ? toDate(e.from) : null,
      to_date: e.to ? toDate(e.to) : null,
      reason_code: e.reason ?? null,
      note: e.note ? e.note.slice(0, 1000) : null,
    },
  });
}

// ---- Linked tasks: notes and application follow-ups ---------------------------

const SYNC_SINCE_KEY = "tasks.sync_since";
const SYNC_THROTTLE_MS = 20_000;
let lastSync = 0;
let syncing: Promise<void> | null = null;

// When the task list went live: older finished reminders / follow-ups aren't
// imported (only ones still open, or made since).
export async function tasksLiveSince(): Promise<Date> {
  const row = await db.system_config.findUnique({ where: { config_key: SYNC_SINCE_KEY } });
  if (row) {
    const d = new Date(row.value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const now = new Date();
  await db.system_config.upsert({
    where: { config_key: SYNC_SINCE_KEY },
    create: { config_key: SYNC_SINCE_KEY, value: now.toISOString() },
    update: {},
  });
  const again = await db.system_config.findUnique({ where: { config_key: SYNC_SINCE_KEY } });
  return again ? new Date(again.value) : now;
}

const FOLLOW_UP_NOUN: Record<string, string> = {
  decision: "Decision follow-up",
  deposit: "Deposit follow-up",
  visa: "Visa file follow-up",
};
const FOLLOW_UP_CATEGORY: Record<string, number> = {
  decision: TaskCategory.UNIVERSITY_FOLLOW_UP,
  deposit: TaskCategory.OFFER_LETTER,
  visa: TaskCategory.VISA,
};

type LinkedSource = {
  key: string;
  source: "note" | "follow_up";
  sourceId: number;
  studentId: number;
  title: string;
  category: number;
  priority: number;
  pendingActivity: string | null;
  assignee: number | null;
  createdBy: number | null;
  createdAt: Date;
  due: string | null;
  done: { at: Date; by: number | null } | null;
  closed: { reason: string } | null;
};

function noteSource(n: {
  id: number;
  student_id: number;
  body: string;
  priority: number | null;
  is_done: number;
  due_date: Date | null;
  created_at: Date;
  updated_at: Date;
  collegepond_user_id: number | null;
  student: { cp_counsellor_id: number | null };
}): LinkedSource {
  const body = n.body.replace(/\s+/g, " ").trim();
  return {
    key: `note:${n.id}`,
    source: "note",
    sourceId: n.id,
    studentId: n.student_id,
    title: body.length > 120 ? `${body.slice(0, 117)}…` : body || "Reminder",
    category: TaskCategory.OTHER,
    priority: n.priority ?? 1,
    pendingActivity: body.length > 120 ? body.slice(0, 500) : null,
    assignee: n.collegepond_user_id ?? n.student.cp_counsellor_id,
    createdBy: n.collegepond_user_id,
    createdAt: n.created_at,
    due: keyOf(n.due_date),
    done: n.is_done === 1 ? { at: n.updated_at, by: null } : null,
    closed: null,
  };
}

function followUpSource(f: {
  id: number;
  kind: string;
  seq: number;
  due_date: Date;
  remarks: string | null;
  completed_at: Date | null;
  completed_by_cp_user_id: number | null;
  closed_at: Date | null;
  closed_reason: string | null;
  created_by_cp_user_id: number | null;
  created_at: Date;
  application: {
    student_id: number;
    student: { cp_counsellor_id: number | null };
    course: { name: string; university: { name: string } };
  };
}): LinkedSource {
  const noun = FOLLOW_UP_NOUN[f.kind] ?? "Follow-up";
  return {
    key: `fu:${f.id}`,
    source: "follow_up",
    sourceId: f.id,
    studentId: f.application.student_id,
    title: `${noun} ${f.seq} – ${f.application.course.university.name}`.slice(0, 200),
    category: FOLLOW_UP_CATEGORY[f.kind] ?? TaskCategory.UNIVERSITY_FOLLOW_UP,
    priority: f.kind === "deposit" ? 2 : 1,
    pendingActivity: `${f.application.course.name}${f.remarks ? ` · ${f.remarks}` : ""}`.slice(0, 500),
    assignee: f.application.student.cp_counsellor_id ?? f.created_by_cp_user_id,
    createdBy: f.created_by_cp_user_id,
    createdAt: f.created_at,
    due: dateKey(f.due_date),
    done: f.completed_at ? { at: f.completed_at, by: f.completed_by_cp_user_id } : null,
    closed: !f.completed_at && f.closed_at ? { reason: f.closed_reason ?? "Closed" } : null,
  };
}

const noteSelect = {
  id: true,
  student_id: true,
  body: true,
  priority: true,
  is_done: true,
  is_task: true,
  due_date: true,
  created_at: true,
  updated_at: true,
  collegepond_user_id: true,
  student: { select: { cp_counsellor_id: true } },
} as const;

const followUpSelect = {
  id: true,
  kind: true,
  seq: true,
  due_date: true,
  remarks: true,
  completed_at: true,
  completed_by_cp_user_id: true,
  closed_at: true,
  closed_reason: true,
  created_by_cp_user_id: true,
  created_at: true,
  application: {
    select: {
      student_id: true,
      student: { select: { cp_counsellor_id: true } },
      course: { select: { name: true, university: { select: { name: true } } } },
    },
  },
} as const;

async function applyLinked(src: LinkedSource, existing: Awaited<ReturnType<typeof db.cp_task.findFirst>>) {
  if (!existing) {
    const status = src.done ? TaskStatus.COMPLETED : src.closed ? TaskStatus.CANCELLED : TaskStatus.PENDING;
    try {
      const t = await db.cp_task.create({
        data: {
          title: src.title,
          student_id: src.studentId,
          category: src.category,
          priority: src.priority,
          pending_activity: src.pendingActivity,
          status,
          assignee_cp_user_id: src.assignee,
          created_by_cp_user_id: src.createdBy,
          assigned_on: toDate(dateKey(src.createdAt)),
          original_due_date: src.due ? toDate(src.due) : null,
          due_date: src.due ? toDate(src.due) : null,
          completed_at: src.done?.at ?? null,
          completed_by_cp_user_id: src.done?.by ?? null,
          cancelled_at: src.closed ? new Date() : null,
          cancel_reason: src.closed?.reason.slice(0, 255) ?? null,
          source: src.source,
          source_id: src.sourceId,
          source_key: src.key,
          created_at: src.createdAt,
        },
      });
      await addEvent(t.id, "created", {
        cpUserId: src.createdBy,
        to: src.due,
        note: src.source === "note" ? "From the student's Tasks & Notes" : "From the application's follow-ups",
      });
    } catch (e) {
      // A concurrent sync created it (unique source_key): fine.
      if (!(e instanceof Error && e.message.includes("Unique constraint"))) throw e;
    }
    return;
  }
  const data: Prisma.cp_taskUpdateInput = {};
  const isOpen = OPEN_STATUSES.includes(existing.status as 0 | 1);
  if (src.done && isOpen) {
    Object.assign(data, {
      status: TaskStatus.COMPLETED,
      completed_at: existing.source === "note" ? new Date() : src.done.at,
      completed_by_cp_user_id: src.done.by,
    });
    await addEvent(existing.id, "completed", { cpUserId: src.done.by });
  } else if (src.closed && isOpen) {
    Object.assign(data, { status: TaskStatus.CANCELLED, cancelled_at: new Date(), cancel_reason: src.closed.reason.slice(0, 255) });
    await addEvent(existing.id, "cancelled", { note: src.closed.reason });
  } else if (!src.done && !src.closed && existing.status === TaskStatus.COMPLETED && existing.source === "note") {
    // Reminder ticked back to not done.
    Object.assign(data, { status: TaskStatus.PENDING, completed_at: null, completed_by_cp_user_id: null });
    await addEvent(existing.id, "reopened");
  }
  const curDue = keyOf(existing.due_date);
  if (src.due !== curDue && (isOpen || data.status === TaskStatus.PENDING)) {
    data.due_date = src.due ? toDate(src.due) : null;
    if (!existing.original_due_date && src.due) data.original_due_date = toDate(src.due);
    if (curDue && src.due && src.due > curDue) data.postponements = { increment: 1 };
    await addEvent(existing.id, "rescheduled", {
      from: curDue,
      to: src.due,
      note: existing.source === "note" ? "Changed in Tasks & Notes" : "Changed in the application's follow-ups",
    });
  }
  if (isOpen && src.title !== existing.title) data.title = src.title;
  if (isOpen && existing.source === "follow_up" && src.assignee !== existing.assignee_cp_user_id && src.assignee !== null) {
    data.assignee = { connect: { id: src.assignee } };
  }
  if (Object.keys(data).length > 0) await db.cp_task.update({ where: { id: existing.id }, data });
}

async function syncLinkedNow(): Promise<void> {
  const since = await tasksLiveSince();
  const [notes, followUps, openLinked] = await Promise.all([
    db.student_note.findMany({
      where: { is_task: 1, OR: [{ is_done: 0 }, { created_at: { gte: since } }] },
      select: noteSelect,
    }),
    db.application_follow_up.findMany({
      where: { OR: [{ completed_at: null, closed_at: null }, { created_at: { gte: since } }] },
      select: followUpSelect,
    }),
    db.cp_task.findMany({
      where: { source: { in: ["note", "follow_up"] }, status: { in: OPEN_STATUSES } },
      select: { id: true, source: true, source_id: true },
    }),
  ]);
  const sources = new Map<string, LinkedSource>();
  for (const n of notes) sources.set(`note:${n.id}`, noteSource(n));
  for (const f of followUps) sources.set(`fu:${f.id}`, followUpSource(f));

  // Open mirrors whose source wasn't loaded: finished long ago, untasked, or deleted.
  const missingNotes = openLinked.filter((t) => t.source === "note" && !sources.has(`note:${t.source_id}`));
  const missingFus = openLinked.filter((t) => t.source === "follow_up" && !sources.has(`fu:${t.source_id}`));
  if (missingNotes.length) {
    const rows = await db.student_note.findMany({
      where: { id: { in: missingNotes.map((t) => t.source_id!).filter(Boolean) } },
      select: noteSelect,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const t of missingNotes) {
      const n = byId.get(t.source_id!);
      if (n?.is_task === 1) sources.set(`note:${n.id}`, noteSource(n));
      else {
        await db.cp_task.update({
          where: { id: t.id },
          data: { status: TaskStatus.CANCELLED, cancelled_at: new Date(), cancel_reason: "Reminder deleted" },
        });
        await addEvent(t.id, "cancelled", { note: "The reminder was deleted from Tasks & Notes" });
      }
    }
  }
  if (missingFus.length) {
    const rows = await db.application_follow_up.findMany({
      where: { id: { in: missingFus.map((t) => t.source_id!).filter(Boolean) } },
      select: followUpSelect,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const t of missingFus) {
      const f = byId.get(t.source_id!);
      if (f) sources.set(`fu:${f.id}`, followUpSource(f));
      else {
        await db.cp_task.update({
          where: { id: t.id },
          data: { status: TaskStatus.CANCELLED, cancelled_at: new Date(), cancel_reason: "Follow-up removed" },
        });
      }
    }
  }
  if (sources.size === 0) return;
  const existing = await db.cp_task.findMany({ where: { source_key: { in: [...sources.keys()] } } });
  const byKey = new Map(existing.map((t) => [t.source_key!, t]));
  for (const [key, src] of sources) {
    const t = byKey.get(key) ?? null;
    // Nothing to do for a finished mirror of a finished source.
    if (t && !OPEN_STATUSES.includes(t.status as 0 | 1) && (src.done || src.closed)) continue;
    // Skip old finished sources never mirrored.
    if (!t && (src.done || src.closed) && src.createdAt < since) continue;
    try {
      await applyLinked(src, t);
    } catch (e) {
      logError(`sync ${key}`, e);
    }
  }
}

// A reminder or follow-up changed: the next read syncs straight away.
export function markLinkedTasksDirty(): void {
  lastSync = 0;
}

// Bring the note / follow-up mirrors up to date. Throttled unless forced
// (after our own writes, and the cron).
export async function syncLinkedTasks(force = false): Promise<void> {
  if (!force && Date.now() - lastSync < SYNC_THROTTLE_MS) return;
  if (syncing) return syncing;
  lastSync = Date.now();
  syncing = syncLinkedNow()
    .catch((e) => logError("linked sync", e))
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

// ---- Rows -------------------------------------------------------------------

export const taskRowSelect = {
  id: true,
  title: true,
  student_id: true,
  category: true,
  pending_activity: true,
  priority: true,
  status: true,
  assignee_cp_user_id: true,
  created_by_cp_user_id: true,
  assigned_on: true,
  original_due_date: true,
  due_date: true,
  follow_up_date: true,
  remarks: true,
  postponements: true,
  completed_at: true,
  cancelled_at: true,
  cancel_reason: true,
  source: true,
  source_id: true,
  source_key: true,
  created_at: true,
  student: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      organization: { select: { name: true, type: true } },
      created_by: { select: { first_name: true, last_name: true } },
    },
  },
  assignee: { select: { id: true, first_name: true, last_name: true } },
  shift_request: {
    orderBy: { day: "desc" },
    take: 1,
    select: {
      id: true,
      day: true,
      status: true,
      reason_code: true,
      details: true,
      shift_requested: true,
      new_due_date: true,
      reject_reason: true,
    },
  },
} satisfies Prisma.cp_taskSelect;

type TaskRowDb = Prisma.cp_taskGetPayload<{ select: typeof taskRowSelect }>;

// Shortlist follow-up stage tasks are done by recording the follow-up.
export const isShortlistStageTask = (t: { source: string; source_key: string | null }) =>
  t.source === "shortlist" && !!t.source_key && /:\d$/.test(t.source_key);

function taskLink(t: TaskRowDb): string {
  const base = `/admin/students/${t.student_id}`;
  if (t.source === "note") return `${base}?tab=tasks`;
  if (t.source === "shortlist" || t.source === "follow_up") return `${base}?tab=application`;
  return base;
}

export function toTaskRow(t: TaskRowDb, clock: Pick<TaskClock, "today" | "dayClosed">) {
  const due = keyOf(t.due_date);
  const state: TaskState = taskState({ status: t.status, dueDate: due }, clock.today, clock.dayClosed);
  const completedOn = t.completed_at ? dateInTimezone(t.completed_at, "Asia/Kolkata") : null;
  const last = t.shift_request[0];
  return {
    id: t.id,
    code: taskCode(t.id),
    title: t.title,
    studentId: t.student_id,
    studentName: fullName(t.student),
    partner: partnerName(t.student.organization, t.student.created_by),
    category: t.category,
    pendingActivity: t.pending_activity,
    priority: t.priority,
    status: t.status,
    state,
    assigneeId: t.assignee_cp_user_id,
    assigneeName: t.assignee ? fullName(t.assignee) : null,
    createdById: t.created_by_cp_user_id,
    assignedOn: dateKey(t.assigned_on),
    createdAt: t.created_at.toISOString(),
    originalDueDate: keyOf(t.original_due_date),
    dueDate: due,
    followUpDate: keyOf(t.follow_up_date),
    remarks: t.remarks,
    postponements: t.postponements,
    completedAt: t.completed_at?.toISOString() ?? null,
    completedOn,
    completedLate: !!(completedOn && t.original_due_date && completedOn > dateKey(t.original_due_date)),
    cancelReason: t.cancel_reason,
    source: t.source as TaskSource,
    auto: t.source !== "manual",
    stageTask: isShortlistStageTask(t),
    canComplete: !isShortlistStageTask(t),
    link: taskLink(t),
    lastShift: last
      ? {
          id: last.id,
          day: dateKey(last.day),
          status: last.status,
          reason: last.reason_code,
          reasonLabel: delayReasonLabel(last.reason_code),
          details: last.details,
          shiftRequested: last.shift_requested === 1,
          newDueDate: keyOf(last.new_due_date),
          rejectReason: last.reject_reason,
        }
      : null,
  };
}
export type TaskRow = ReturnType<typeof toTaskRow>;

// Overdue first, then by due date, then priority.
const STATE_ORDER: Record<TaskState, number> = { overdue: 0, in_progress: 1, pending: 2, completed: 3, cancelled: 4 };
export function sortTasks(rows: TaskRow[]): TaskRow[] {
  return rows.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
      b.priority - a.priority ||
      a.id - b.id,
  );
}

// ---- My day -------------------------------------------------------------------

// Today's list: open tasks due today or earlier, plus everything completed
// today. Completed today counts toward the day whatever its due date.
export async function myDay(user: StaffUser) {
  await syncLinkedTasks();
  const clock = await taskClock();
  const owners = await myTaskOwnerIds(user);
  const startOfToday = new Date(`${clock.today}T00:00:00+05:30`);
  const rows = await db.cp_task.findMany({
    where: {
      assignee_cp_user_id: { in: owners },
      OR: [
        { status: { in: OPEN_STATUSES }, due_date: { lte: toDate(clock.today) } },
        { status: TaskStatus.COMPLETED, completed_at: { gte: startOfToday } },
      ],
    },
    select: taskRowSelect,
  });
  const tasks = sortTasks(rows.map((r) => toTaskRow(r, clock)));
  const completed = tasks.filter((t) => t.state === "completed");
  const overdue = tasks.filter((t) => t.state === "overdue");
  const pending = tasks.filter((t) => t.state === "pending" || t.state === "in_progress");
  const oldestOverdue = overdue.reduce<string | null>(
    (m, t) => (t.dueDate && (!m || t.dueDate < m) ? t.dueDate : m),
    null,
  );
  const dayClose = await db.cp_day_close.findUnique({
    where: { cp_user_id_day: { cp_user_id: user.id, day: toDate(clock.today) } },
    select: { submitted_at: true },
  });
  const pendingRequests = await db.cp_task_shift_request.count({
    where: { cp_user_id: user.id, status: ShiftStatus.PENDING },
  });
  return {
    today: clock.today,
    todayLabel: fmtWeekday(clock.today),
    dayClosed: clock.dayClosed,
    minutesToClose: clock.minutesToClose,
    isWorkingDay: clock.isWorkingDay,
    nextWorkingDay: clock.nextWorkingDay,
    nextWorkingDayLabel: fmtWeekday(clock.nextWorkingDay),
    closedSubmittedAt: dayClose?.submitted_at?.toISOString() ?? null,
    pendingRequests,
    stats: {
      total: tasks.length,
      auto: tasks.filter((t) => t.auto).length,
      completed: completed.length,
      completedLate: completed.filter((t) => t.completedLate).length,
      pending: pending.length,
      inProgress: pending.filter((t) => t.state === "in_progress").length,
      overdue: overdue.length,
      oldestOverdue,
      completionPct: tasks.length ? Math.round((completed.length / tasks.length) * 100) : 0,
    },
    tasks,
  };
}

// Open tasks due by today (topbar badge).
export async function myOpenDueCount(user: StaffUser): Promise<number> {
  const clock = await taskClock();
  return db.cp_task.count({
    where: {
      assignee_cp_user_id: { in: await myTaskOwnerIds(user) },
      status: { in: OPEN_STATUSES },
      due_date: { lte: toDate(clock.today) },
    },
  });
}

// ---- All tasks ----------------------------------------------------------------

export type TaskListFilter = {
  scope: "mine" | "team";
  state?: TaskState | "open";
  category?: number;
  priority?: number;
  source?: TaskSource;
  assigneeId?: number;
  studentId?: number;
  search?: string;
};

export async function listTasks(user: StaffUser, f: TaskListFilter) {
  await syncLinkedTasks();
  const clock = await taskClock();
  const ids = f.scope === "mine" ? await myTaskOwnerIds(user) : await taskScopeIds(user);
  const today = toDate(clock.today);
  const and: Prisma.cp_taskWhereInput[] = [assigneeWhere(ids)];
  if (f.assigneeId) and.push({ assignee_cp_user_id: f.assigneeId });
  if (f.category !== undefined) and.push({ category: f.category });
  if (f.priority !== undefined) and.push({ priority: f.priority });
  if (f.source) and.push({ source: f.source });
  if (f.studentId) and.push({ student_id: f.studentId });
  const s = f.search?.trim();
  if (s) {
    const n = Number(s.replace(/^(TSK|CP)-?/i, ""));
    and.push({
      OR: [
        { title: { contains: s } },
        { student: { OR: [{ first_name: { contains: s } }, { last_name: { contains: s } }] } },
        ...(Number.isInteger(n) && n > 0 ? [{ id: n }, { student_id: n }] : []),
      ],
    });
  }
  switch (f.state) {
    case "open":
      and.push({ status: { in: OPEN_STATUSES } });
      break;
    case "completed":
      and.push({ status: TaskStatus.COMPLETED });
      break;
    case "cancelled":
      and.push({ status: TaskStatus.CANCELLED });
      break;
    case "overdue":
      and.push({
        status: { in: OPEN_STATUSES },
        due_date: clock.dayClosed ? { lte: today } : { lt: today },
      });
      break;
    case "pending":
    case "in_progress":
      and.push({
        status: f.state === "pending" ? TaskStatus.PENDING : TaskStatus.IN_PROGRESS,
        OR: [{ due_date: null }, { due_date: clock.dayClosed ? { gt: today } : { gte: today } }],
      });
      break;
    default:
      and.push({ status: { not: TaskStatus.CANCELLED } });
  }
  const rows = await db.cp_task.findMany({
    where: { AND: and },
    select: taskRowSelect,
    orderBy: [{ due_date: "asc" }, { id: "asc" }],
    take: 500,
  });
  return { today: clock.today, tasks: sortTasks(rows.map((r) => toTaskRow(r, clock))) };
}

// Every task on one student (the caller has already checked the student is
// visible): the student page's Follow-up History tab.
export async function studentTaskList(studentId: number) {
  await syncLinkedTasks();
  const clock = await taskClock();
  const rows = await db.cp_task.findMany({
    where: { student_id: studentId, status: { not: TaskStatus.CANCELLED } },
    select: taskRowSelect,
    orderBy: { id: "desc" },
    take: 200,
  });
  return { today: clock.today, tasks: sortTasks(rows.map((r) => toTaskRow(r, clock))) };
}

// ---- Create / update ----------------------------------------------------------

export type CreateTaskInput = {
  title: string;
  studentId: number;
  category: number;
  priority: number;
  pendingActivity: string;
  dueDate: string;
  followUpDate?: string | null;
  status: 0 | 1;
  assigneeId?: number | null;
  remarks?: string | null;
};

async function resolveAssignee(user: StaffUser, assigneeId: number | null | undefined, studentId: number) {
  const id = assigneeId ?? user.id;
  if (id === user.id) return id;
  const allowed = await assignableCounsellorIds(user);
  if (allowed && !allowed.includes(id)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You can only assign tasks to yourself or your counselling team." });
  }
  const c = await db.collegepond_user.findUnique({ where: { id }, select: { id: true, role: true, status: true, first_name: true, last_name: true } });
  if (c?.status !== 1 || !isCounsellingRole(c.role)) throw fail("Pick an active counsellor.");
  if (!(await canSeeStudent({ id: c.id, role: c.role }, studentId))) {
    throw fail(`${fullName(c)} can't see this student. Assign the student to them first.`);
  }
  return id;
}

export async function createTask(user: StaffUser, input: CreateTaskInput) {
  await requireStaffStudent(user, input.studentId);
  const clock = await taskClock();
  if (input.dueDate < clock.today) throw fail("The due date can't be in the past.");
  if (input.followUpDate && input.followUpDate < clock.today) throw fail("The follow-up date can't be in the past.");
  const assignee = await resolveAssignee(user, input.assigneeId, input.studentId);
  const t = await db.cp_task.create({
    data: {
      title: input.title.trim().slice(0, 200),
      student_id: input.studentId,
      category: input.category,
      priority: input.priority,
      pending_activity: input.pendingActivity.trim().slice(0, 500),
      status: input.status,
      assignee_cp_user_id: assignee,
      created_by_cp_user_id: user.id,
      assigned_on: toDate(clock.today),
      original_due_date: toDate(input.dueDate),
      due_date: toDate(input.dueDate),
      follow_up_date: input.followUpDate ? toDate(input.followUpDate) : null,
      remarks: input.remarks?.trim() ? input.remarks.trim().slice(0, 1000) : null,
      source: "manual",
    },
  });
  await addEvent(t.id, "created", { cpUserId: user.id, to: input.dueDate });
  if (assignee !== user.id) {
    const me = await db.collegepond_user.findUnique({ where: { id: user.id }, select: { first_name: true, last_name: true } });
    await createStaffNotifications([assignee], {
      type: "task.assigned",
      title: `New task: ${t.title}`,
      body: `${me ? fullName(me) : "A colleague"} assigned you ${taskCode(t.id)} · due ${fmtWeekday(input.dueDate)}`,
      link: "/admin/tasks?tab=all",
      tone: "blue",
    });
  }
  return { id: t.id, code: taskCode(t.id) };
}

// The next TSK number, for the Create task header (a preview; ids are
// assigned on save).
export async function nextTaskCode(): Promise<string> {
  const last = await db.cp_task.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
  return taskCode((last?.id ?? 0) + 1);
}

export async function updateTask(
  user: StaffUser,
  taskId: number,
  patch: {
    status?: 0 | 1;
    remarks?: string | null;
    followUpDate?: string | null;
    priority?: number;
    title?: string;
    category?: number;
    pendingActivity?: string;
    assigneeId?: number;
    dueDate?: string;
  },
) {
  const t = await requireTaskAccess(user, taskId);
  if (!OPEN_STATUSES.includes(t.status as 0 | 1)) throw fail("This task is already finished.");
  const manual = t.source === "manual";
  const data: Prisma.cp_taskUpdateInput = {};
  if (patch.status !== undefined && patch.status !== t.status) {
    data.status = patch.status;
    await addEvent(t.id, patch.status === TaskStatus.IN_PROGRESS ? "started" : "status", { cpUserId: user.id });
  }
  if (patch.remarks !== undefined) data.remarks = patch.remarks?.trim() ? patch.remarks.trim().slice(0, 1000) : null;
  if (patch.followUpDate !== undefined) data.follow_up_date = patch.followUpDate ? toDate(patch.followUpDate) : null;
  if (manual) {
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.title?.trim()) data.title = patch.title.trim().slice(0, 200);
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.pendingActivity?.trim()) {
      data.pending_activity = patch.pendingActivity.trim().slice(0, 500);
    }
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== t.assignee_cp_user_id) {
    if (!isHeadCounsellorRole(user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Only a Counsellor Lead or Super Admin can reassign a task." });
    data.assignee = { connect: { id: await resolveAssignee(user, patch.assigneeId, t.student_id) } };
    await addEvent(t.id, "reassigned", { cpUserId: user.id, note: `To cp_user ${patch.assigneeId}` });
  }
  // The due date moves only through an approved carry-forward, except a lead
  // or Super Admin correcting a manual task (logged as a reschedule).
  if (patch.dueDate !== undefined && patch.dueDate !== keyOf(t.due_date)) {
    if (!manual || !isHeadCounsellorRole(user.role)) {
      throw fail("Ask for a shift to the next working day from Close your day instead.");
    }
    const clock = await taskClock();
    if (patch.dueDate < clock.today) throw fail("The due date can't be in the past.");
    const from = keyOf(t.due_date);
    data.due_date = toDate(patch.dueDate);
    if (from && patch.dueDate > from) data.postponements = { increment: 1 };
    await addEvent(t.id, "rescheduled", { cpUserId: user.id, from, to: patch.dueDate, note: "Changed by a Head Counsellor" });
  }
  if (Object.keys(data).length) await db.cp_task.update({ where: { id: t.id }, data });
  return { ok: true as const };
}

// Pending carry-forward requests lapse once the task is finished.
async function lapseRequests(taskId: number) {
  await db.cp_task_shift_request.updateMany({
    where: { task_id: taskId, status: { in: [ShiftStatus.DRAFT, ShiftStatus.PENDING] } },
    data: { status: ShiftStatus.LAPSED },
  });
}

export async function completeTask(user: StaffUser, taskId: number, remarks?: string | null) {
  const t = await requireTaskAccess(user, taskId);
  if (!OPEN_STATUSES.includes(t.status as 0 | 1)) throw fail("This task is already finished.");
  if (isShortlistStageTask(t)) throw fail("Record the follow-up on the student's Application tab to complete this task.");
  if (t.source === "note" && t.source_id) {
    await db.student_note.updateMany({ where: { id: t.source_id }, data: { is_done: 1 } });
  } else if (t.source === "follow_up" && t.source_id) {
    try {
      await completeFollowUp(user.id, t.source_id);
    } catch (e) {
      // Already finished there: just finish the mirror.
      if (!(e instanceof TRPCError)) throw e;
    }
  }
  await db.cp_task.update({
    where: { id: t.id },
    data: {
      status: TaskStatus.COMPLETED,
      completed_at: new Date(),
      completed_by_cp_user_id: user.id,
      ...(remarks?.trim() ? { remarks: remarks.trim().slice(0, 1000) } : {}),
    },
  });
  await addEvent(t.id, "completed", { cpUserId: user.id });
  await lapseRequests(t.id);
  return { ok: true as const };
}

export async function cancelTask(user: StaffUser, taskId: number, reason: string) {
  const t = await requireTaskAccess(user, taskId);
  if (t.source !== "manual") throw fail("Automatic tasks close by themselves when their reminder or follow-up does.");
  if (!OPEN_STATUSES.includes(t.status as 0 | 1)) throw fail("This task is already finished.");
  if (t.created_by_cp_user_id !== user.id && !isHeadCounsellorRole(user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who created it or a Head Counsellor can cancel a task." });
  }
  await db.cp_task.update({
    where: { id: t.id },
    data: { status: TaskStatus.CANCELLED, cancelled_at: new Date(), cancel_reason: reason.trim().slice(0, 255) },
  });
  await addEvent(t.id, "cancelled", { cpUserId: user.id, note: reason });
  await lapseRequests(t.id);
  return { ok: true as const };
}

export async function taskHistory(user: StaffUser, taskId: number) {
  await requireTaskAccess(user, taskId);
  const events = await db.cp_task_event.findMany({ where: { task_id: taskId }, orderBy: { created_at: "asc" } });
  return historyRows(events);
}

async function historyRows(
  events: { id: number; kind: string; cp_user_id: number | null; from_date: Date | null; to_date: Date | null; reason_code: string | null; note: string | null; created_at: Date }[],
) {
  const ids = [...new Set(events.map((e) => e.cp_user_id).filter((x): x is number => x !== null))];
  const people = ids.length
    ? await db.collegepond_user.findMany({ where: { id: { in: ids } }, select: { id: true, first_name: true, last_name: true } })
    : [];
  const names = new Map(people.map((p) => [p.id, fullName(p)]));
  return events.map((e) => ({
    id: e.id,
    kind: e.kind,
    at: e.created_at.toISOString(),
    by: e.cp_user_id ? (names.get(e.cp_user_id) ?? null) : null,
    from: keyOf(e.from_date),
    to: keyOf(e.to_date),
    reason: e.reason_code ? delayReasonLabel(e.reason_code) : null,
    note: e.note,
  }));
}

// ---- Close your day -----------------------------------------------------------

// The day being closed: today, or the last working day when it's a weekend
// or holiday.
async function closingDay() {
  const clock = await taskClock();
  const day = clock.isWorkingDay ? clock.today : workingDayOnOrBefore(clock.today, clock.config);
  return { clock, day };
}

export async function closeDayView(user: StaffUser) {
  await syncLinkedTasks();
  const { clock, day } = await closingDay();
  const owners = await myTaskOwnerIds(user);
  const startOfDay = new Date(`${day}T00:00:00+05:30`);
  const [open, doneToday, dayClose] = await Promise.all([
    db.cp_task.findMany({
      where: { assignee_cp_user_id: { in: owners }, status: { in: OPEN_STATUSES }, due_date: { lte: toDate(clock.today) } },
      select: taskRowSelect,
    }),
    db.cp_task.count({
      where: { assignee_cp_user_id: { in: owners }, status: TaskStatus.COMPLETED, completed_at: { gte: startOfDay } },
    }),
    db.cp_day_close.findUnique({ where: { cp_user_id_day: { cp_user_id: user.id, day: toDate(day) } } }),
  ]);
  const requests = await db.cp_task_shift_request.findMany({
    where: { task_id: { in: open.map((t) => t.id) }, day: toDate(day) },
  });
  const byTask = new Map(requests.map((r) => [r.task_id, r]));
  const approverNames: string[] = [];
  const seenAssignees = new Set<number>();
  for (const t of open) {
    const a = t.assignee_cp_user_id ?? user.id;
    if (seenAssignees.has(a)) continue;
    seenAssignees.add(a);
    const { people, coveringFor } = await approverRecipients(await headCounsellorOf(a), user.id);
    const label =
      people.length === 1 ? `${fullName(people[0]!)}${coveringFor ? ` (covering for ${coveringFor})` : ""}` : "Super Admin";
    if (!approverNames.includes(label)) approverNames.push(label);
  }
  const tasks = sortTasks(open.map((t) => toTaskRow(t, clock))).map((t) => {
    const r = byTask.get(t.id);
    return {
      ...t,
      request: r
        ? {
            status: r.status,
            reason: r.reason_code,
            details: r.details,
            shift: r.shift_requested === 1,
            newDueDate: keyOf(r.new_due_date),
            rejectReason: r.reject_reason,
          }
        : null,
    };
  });
  const total = tasks.length + doneToday;
  return {
    day,
    dayLabel: fmtWeekday(day),
    today: clock.today,
    dayClosed: clock.dayClosed,
    newDueDate: clock.nextWorkingDay,
    newDueLabel: fmtWeekday(clock.nextWorkingDay),
    completed: doneToday,
    total,
    completionPct: total ? Math.round((doneToday / total) * 100) : 100,
    submittedAt: dayClose?.submitted_at?.toISOString() ?? null,
    approverNames,
    tasks,
  };
}

export type CloseDayItem = { taskId: number; reason: DelayReason; details: string; shift: boolean };

export async function submitCloseDay(user: StaffUser, items: CloseDayItem[], draft: boolean) {
  const { clock, day } = await closingDay();
  const owners = await myTaskOwnerIds(user);
  const tasks = await db.cp_task.findMany({
    where: { id: { in: items.map((i) => i.taskId) } },
    select: { id: true, title: true, status: true, due_date: true, original_due_date: true, postponements: true, assignee_cp_user_id: true, student_id: true, student: { select: { first_name: true, last_name: true } } },
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const i of items) {
    const t = byId.get(i.taskId);
    if (t?.assignee_cp_user_id == null || !owners.includes(t.assignee_cp_user_id)) throw notFound();
    if (!OPEN_STATUSES.includes(t.status as 0 | 1)) throw fail(`${taskCode(t.id)} is already finished.`);
    if (!draft && !i.details.trim()) throw fail(`Add details for ${taskCode(t.id)} before submitting.`);
  }
  const dayDate = toDate(day);
  const dc = await db.cp_day_close.upsert({
    where: { cp_user_id_day: { cp_user_id: user.id, day: dayDate } },
    create: { cp_user_id: user.id, day: dayDate },
    update: {},
  });
  const existing = await db.cp_task_shift_request.findMany({ where: { task_id: { in: items.map((i) => i.taskId) }, day: dayDate } });
  const prev = new Map(existing.map((r) => [r.task_id, r]));
  const newDue = clock.nextWorkingDay;
  const emailRows: { task: (typeof tasks)[number]; item: CloseDayItem; approver: number | null }[] = [];
  for (const i of items) {
    const t = byId.get(i.taskId)!;
    const old = prev.get(t.id);
    // A decided request stays decided.
    if (old && (old.status === ShiftStatus.APPROVED || old.status === ShiftStatus.REJECTED)) continue;
    const approver = await headCounsellorOf(t.assignee_cp_user_id!);
    const status = draft ? ShiftStatus.DRAFT : i.shift ? ShiftStatus.PENDING : ShiftStatus.REASON_ONLY;
    const data = {
      day_close_id: dc.id,
      cp_user_id: user.id,
      reason_code: i.reason,
      details: i.details.trim().slice(0, 500),
      shift_requested: i.shift ? 1 : 0,
      from_due_date: t.due_date,
      new_due_date: i.shift ? toDate(newDue) : null,
      status,
      approver_cp_user_id: approver,
    };
    if (old) await db.cp_task_shift_request.update({ where: { id: old.id }, data });
    else await db.cp_task_shift_request.create({ data: { task_id: t.id, day: dayDate, ...data } });
    if (!draft) {
      const changed = !old || old.status === ShiftStatus.DRAFT || old.reason_code !== i.reason || old.details !== data.details || old.shift_requested !== data.shift_requested;
      if (changed) {
        await addEvent(t.id, "not_completed", { cpUserId: user.id, reason: i.reason, note: data.details, from: keyOf(t.due_date) });
        if (i.shift) await addEvent(t.id, "shift_requested", { cpUserId: user.id, from: keyOf(t.due_date), to: newDue });
      }
      emailRows.push({ task: t, item: i, approver });
    }
  }
  if (draft) return { ok: true as const, emailed: 0 };

  const startOfDay = new Date(`${day}T00:00:00+05:30`);
  const [doneToday, openCount] = await Promise.all([
    db.cp_task.count({ where: { assignee_cp_user_id: { in: owners }, status: TaskStatus.COMPLETED, completed_at: { gte: startOfDay } } }),
    db.cp_task.count({ where: { assignee_cp_user_id: { in: owners }, status: { in: OPEN_STATUSES }, due_date: { lte: toDate(clock.today) } } }),
  ]);
  const resubmit = !!dc.submitted_at;
  await db.cp_day_close.update({
    where: { id: dc.id },
    data: { submitted_at: new Date(), total_tasks: doneToday + openCount, completed_tasks: doneToday },
  });
  const emailed = await emailHeadCounsellors(user, day, emailRows, { done: doneToday, total: doneToday + openCount, resubmit, newDue });
  if (emailed > 0) await db.cp_day_close.update({ where: { id: dc.id }, data: { emailed_at: new Date() } });
  return { ok: true as const, emailed };
}

// One email per Head Counsellor (Super Admins when there's no lead): the
// counsellor's incomplete tasks and the shifts they asked for.
async function emailHeadCounsellors(
  user: StaffUser,
  day: string,
  rows: { task: { id: number; title: string; original_due_date: Date | null; due_date: Date | null; postponements: number; student: { first_name: string; last_name: string } }; item: CloseDayItem; approver: number | null }[],
  totals: { done: number; total: number; resubmit: boolean; newDue: string },
): Promise<number> {
  const newDue = totals.newDue;
  if (rows.length === 0) return 0;
  const me = await db.collegepond_user.findUnique({ where: { id: user.id }, select: { first_name: true, last_name: true } });
  const counsellor = me ? fullName(me) : "A counsellor";
  const groups = new Map<number | null, typeof rows>();
  for (const r of rows) groups.set(r.approver, [...(groups.get(r.approver) ?? []), r]);
  let sent = 0;
  for (const [approver, list] of groups) {
    const { people: recipients, coveringFor } = await approverRecipients(approver, user.id);
    const requests = list.filter((r) => r.item.shift).length;
    const subject = `${counsellor}: ${list.length} incomplete task${list.length === 1 ? "" : "s"}, ${requests} extension request${requests === 1 ? "" : "s"} – ${fmtWeekday(day)}${totals.resubmit ? " (updated)" : ""}`;
    const lines = list.map((r) => {
      const orig = keyOf(r.task.original_due_date);
      const shift = r.item.shift
        ? `shift to ${fmtShortDay(newDue)} requested${r.task.postponements > 0 ? ` (${ordinal(r.task.postponements + 1)} postponement)` : ""}`
        : "no shift requested";
      return `${taskCode(r.task.id)} ${r.task.title} – ${fullName(r.task.student)} · original due ${fmtShortDay(orig)} · ${shift} · ${delayReasonLabel(r.item.reason)}: ${r.item.details.trim()}`;
    });
    for (const p of recipients) {
      try {
        await sendEmail(
          p.email,
          dayCloseEmail(
            { name: fullName(p) },
            {
              subject,
              heading: `${counsellor} closed their day`,
              intro: `${coveringFor ? `You're covering for ${coveringFor} while they're out of office. ` : ""}${counsellor} closed ${fmtWeekday(day)} with ${totals.done} of ${totals.total} tasks done. These were not completed:`,
              lines,
              outro: "Reasons are in Converge. Until you decide, requested tasks stay on the counsellor's list as overdue.",
              link: "/admin/tasks?tab=carry-forward",
            },
            appUrl(),
          ),
        );
        sent++;
      } catch (e) {
        logError("day close email", e);
      }
    }
    await createStaffNotifications(
      recipients.map((p) => p.id),
      {
        type: "task.carry_forward",
        title: `${counsellor}: ${requests} carry-forward request${requests === 1 ? "" : "s"}`,
        body: `${list.length} incomplete task${list.length === 1 ? "" : "s"} on ${fmtWeekday(day)}`,
        link: "/admin/tasks?tab=carry-forward",
        tone: requests ? "orange" : "blue",
      },
    );
  }
  return sent;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

// ---- Carry-forward decisions ----------------------------------------------------

// `covered`: the people this user covers today (out-of-office alternates).
function canDecide(
  user: StaffUser,
  r: { approver_cp_user_id: number | null; cp_user_id: number | null },
  covered: number[],
): boolean {
  if (user.role === AdminRole.SUPER_ADMIN) return true;
  if (r.cp_user_id === user.id || r.approver_cp_user_id === null) return false;
  return r.approver_cp_user_id === user.id || covered.includes(r.approver_cp_user_id);
}

// Whose approvals this user holds today: their own, and those of any
// Counsellor Lead they cover. null = all (Super Admin).
async function approvalScope(user: StaffUser): Promise<{ ids: number[] | null; covered: number[]; actsAsHead: boolean }> {
  const covered = await coveredCounsellorIds(user.id);
  if (user.role === AdminRole.SUPER_ADMIN) return { ids: null, covered, actsAsHead: true };
  const coversLead =
    covered.length > 0 && (await db.counsellor_team.count({ where: { lead_cp_user_id: { in: covered } } })) > 0;
  return { ids: [user.id, ...covered], covered, actsAsHead: isHeadCounsellorRole(user.role) || coversLead };
}

// Requests awaiting this Head Counsellor (all of them for a Super Admin), by
// counsellor, with each counsellor's day; plus what a counsellor asked for
// themselves (theirs).
export async function carryForwardView(user: StaffUser) {
  await syncLinkedTasks();
  const clock = await taskClock();
  const scope = await approvalScope(user);
  const isHc = scope.actsAsHead;
  const where: Prisma.cp_task_shift_requestWhereInput = !isHc
    ? { status: -1 }
    : scope.ids === null
      ? { status: { in: [ShiftStatus.PENDING, ShiftStatus.REASON_ONLY] } }
      : {
          status: { in: [ShiftStatus.PENDING, ShiftStatus.REASON_ONLY] },
          approver_cp_user_id: { in: scope.ids },
          NOT: { cp_user_id: user.id },
        };
  // Reason-only rows matter for the latest submitted day only.
  const since = toDate(addDays(clock.today, -14));
  const rows = await db.cp_task_shift_request.findMany({
    where: { AND: [where, { day: { gte: since } }] },
    orderBy: [{ day: "desc" }, { id: "asc" }],
    select: {
      id: true,
      day: true,
      status: true,
      reason_code: true,
      details: true,
      shift_requested: true,
      new_due_date: true,
      from_due_date: true,
      cp_user_id: true,
      approver_cp_user_id: true,
      task: { select: taskRowSelect },
      day_close: { select: { total_tasks: true, completed_tasks: true, submitted_at: true } },
    },
  });
  // Reason-only rows only from each counsellor's latest closed day.
  const latestDay = new Map<number, string>();
  for (const r of rows) {
    const k = r.cp_user_id ?? 0;
    const d = dateKey(r.day);
    if (!latestDay.has(k) || d > latestDay.get(k)!) latestDay.set(k, d);
  }
  const visible = rows.filter(
    (r) =>
      (r.status === ShiftStatus.PENDING || dateKey(r.day) === latestDay.get(r.cp_user_id ?? 0)) &&
      (r.status !== ShiftStatus.REASON_ONLY || r.task.status < TaskStatus.COMPLETED),
  );
  const peopleIds = [...new Set(visible.map((r) => r.cp_user_id).filter((x): x is number => x !== null))];
  const people = peopleIds.length
    ? await db.collegepond_user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, first_name: true, last_name: true } })
    : [];
  const names = new Map(people.map((p) => [p.id, fullName(p)]));
  const groups = new Map<number, { counsellorId: number; name: string; day: string; done: number; total: number; requests: ReturnType<typeof mapReq>[]; notRequested: ReturnType<typeof mapReq>[] }>();
  function mapReq(r: (typeof visible)[number]) {
    const task = toTaskRow(r.task, clock);
    return {
      id: r.id,
      day: dateKey(r.day),
      status: r.status,
      reason: delayReasonLabel(r.reason_code),
      details: r.details,
      fromDue: keyOf(r.from_due_date),
      newDue: keyOf(r.new_due_date),
      postponementNo: r.task.postponements + 1,
      canDecide: canDecide(user, r, scope.covered),
      task,
    };
  }
  for (const r of visible) {
    const k = r.cp_user_id ?? 0;
    const g = groups.get(k) ?? {
      counsellorId: k,
      name: names.get(k) ?? "Counsellor",
      day: dateKey(r.day),
      done: r.day_close.completed_tasks,
      total: r.day_close.total_tasks,
      requests: [],
      notRequested: [],
    };
    const m = mapReq(r);
    if (r.status === ShiftStatus.PENDING) g.requests.push(m);
    else g.notRequested.push(m);
    groups.set(k, g);
  }
  const list = [...groups.values()];
  const pending = list.flatMap((g) => g.requests);
  // Team numbers for the tiles.
  const ids = await taskScopeIds(user);
  const startOfToday = new Date(`${clock.today}T00:00:00+05:30`);
  const [teamIncomplete, teamDone] = isHc
    ? await Promise.all([
        db.cp_task.count({
          where: { ...assigneeWhere(ids), status: { in: OPEN_STATUSES }, due_date: clock.dayClosed ? { lte: toDate(clock.today) } : { lt: toDate(clock.today) } },
        }),
        db.cp_task.count({ where: { ...assigneeWhere(ids), status: TaskStatus.COMPLETED, completed_at: { gte: startOfToday } } }),
      ])
    : [0, 0];
  const teamDueToday = isHc
    ? await db.cp_task.count({ where: { ...assigneeWhere(ids), status: { in: OPEN_STATUSES }, due_date: { lte: toDate(clock.today) } } })
    : 0;
  // A counsellor's own requests and how they were decided.
  const mine = await db.cp_task_shift_request.findMany({
    where: { cp_user_id: user.id, day: { gte: since }, status: { in: [ShiftStatus.PENDING, ShiftStatus.APPROVED, ShiftStatus.REJECTED] } },
    orderBy: [{ day: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      day: true,
      status: true,
      reason_code: true,
      details: true,
      new_due_date: true,
      reject_reason: true,
      decided_at: true,
      task: { select: { id: true, title: true, student_id: true, student: { select: { first_name: true, last_name: true } } } },
    },
  });
  return {
    isHeadCounsellor: isHc,
    today: clock.today,
    nextWorkingDay: clock.nextWorkingDay,
    nextWorkingDayLabel: fmtWeekday(clock.nextWorkingDay),
    stats: {
      awaiting: pending.length,
      teamIncomplete,
      teamCompletionPct: teamDone + teamDueToday ? Math.round((teamDone / (teamDone + teamDueToday)) * 100) : 0,
      repeat: pending.filter((p) => p.postponementNo >= 2).length,
      firstRequests: pending.filter((p) => p.postponementNo === 1 && p.canDecide).length,
    },
    groups: list,
    mine: mine.map((r) => ({
      id: r.id,
      day: dateKey(r.day),
      status: r.status,
      reason: delayReasonLabel(r.reason_code),
      details: r.details,
      newDue: keyOf(r.new_due_date),
      rejectReason: r.reject_reason,
      decidedAt: r.decided_at?.toISOString() ?? null,
      taskCode: taskCode(r.task.id),
      taskTitle: r.task.title,
      studentName: fullName(r.task.student),
      studentId: r.task.student_id,
    })),
  };
}

// Move a linked task's own date with it.
async function moveSource(actorId: number, t: { source: string; source_id: number | null }, newDue: string) {
  if (!t.source_id) return;
  try {
    if (t.source === "note") {
      await db.student_note.updateMany({ where: { id: t.source_id }, data: { due_date: toDate(newDue) } });
    } else if (t.source === "follow_up") {
      await rescheduleFollowUp(actorId, t.source_id, newDue);
    } else if (t.source === "shortlist") {
      await db.shortlist_follow_up.updateMany({ where: { id: t.source_id, status: 0 }, data: { next_due_date: toDate(newDue) } });
    }
  } catch (e) {
    logError("move source date", e);
  }
}

export async function decideShift(user: StaffUser, requestId: number, approve: boolean, reason?: string | null) {
  const r = await db.cp_task_shift_request.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, approver_cp_user_id: true, new_due_date: true, cp_user_id: true, task_id: true, task: { select: { id: true, title: true, status: true, due_date: true, source: true, source_id: true } } },
  });
  if (!r || !canDecide(user, r, await coveredCounsellorIds(user.id))) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Request not found" });
  }
  if (r.status !== ShiftStatus.PENDING) throw new TRPCError({ code: "CONFLICT", message: "This request has already been decided." });
  if (!approve && !reason?.trim()) throw fail("Give a reason for the rejection; it's shared with the counsellor.");
  const clock = await taskClock();
  const taskOpen = OPEN_STATUSES.includes(r.task.status as 0 | 1);
  if (!taskOpen) {
    await db.cp_task_shift_request.update({ where: { id: r.id }, data: { status: ShiftStatus.LAPSED } });
    throw new TRPCError({ code: "CONFLICT", message: "The task is already finished, so the request no longer applies." });
  }
  const res = await db.cp_task_shift_request.updateMany({
    where: { id: r.id, status: ShiftStatus.PENDING },
    data: {
      status: approve ? ShiftStatus.APPROVED : ShiftStatus.REJECTED,
      decided_by_cp_user_id: user.id,
      decided_at: new Date(),
      reject_reason: approve ? null : reason!.trim().slice(0, 500),
    },
  });
  if (res.count === 0) throw new TRPCError({ code: "CONFLICT", message: "This request has already been decided." });
  const from = keyOf(r.task.due_date);
  let newDue = keyOf(r.new_due_date) ?? clock.nextWorkingDay;
  if (newDue < clock.today) newDue = clock.today;
  if (approve) {
    await db.cp_task.update({
      where: { id: r.task.id },
      data: { due_date: toDate(newDue), postponements: { increment: 1 } },
    });
    await addEvent(r.task.id, "shift_approved", { cpUserId: user.id, from, to: newDue });
    await moveSource(user.id, r.task, newDue);
  } else {
    await addEvent(r.task.id, "shift_rejected", { cpUserId: user.id, note: reason ?? null });
  }
  const me = await db.collegepond_user.findUnique({ where: { id: user.id }, select: { first_name: true, last_name: true } });
  await createStaffNotifications([r.cp_user_id], {
    type: "task.carry_forward_decision",
    title: approve
      ? `Shift approved: ${r.task.title} moves to ${fmtWeekday(newDue)}`
      : `Shift rejected: ${r.task.title}`,
    body: approve
      ? `${taskCode(r.task.id)} · approved by ${me ? fullName(me) : "your Head Counsellor"}`
      : `${me ? fullName(me) : "Your Head Counsellor"}: ${reason?.trim() ?? ""}`,
    link: "/admin/tasks?tab=carry-forward",
    tone: approve ? "green" : "red",
  });
  return { ok: true as const, newDue: approve ? newDue : null };
}

// "Approve all first requests": every pending request this user may decide
// whose task has never been postponed.
export async function approveAllFirst(user: StaffUser) {
  const scope = await approvalScope(user);
  const rows = await db.cp_task_shift_request.findMany({
    where: {
      status: ShiftStatus.PENDING,
      ...(scope.ids === null ? {} : { approver_cp_user_id: { in: scope.ids }, NOT: { cp_user_id: user.id } }),
      task: { postponements: 0, status: { in: OPEN_STATUSES } },
    },
    select: { id: true },
  });
  let approved = 0;
  for (const r of rows) {
    try {
      await decideShift(user, r.id, true);
      approved++;
    } catch (e) {
      logError(`approve ${r.id}`, e);
    }
  }
  return { approved };
}

// ---- Ageing report (Head Counsellor / Super Admin) -----------------------------

export type AgeingFilter = { from: string; to: string; counsellorId?: number; category?: number; postponedOnly?: boolean };

export async function ageingReport(user: StaffUser, f: AgeingFilter) {
  await syncLinkedTasks();
  const clock = await taskClock();
  const ids = await taskScopeIds(user);
  const where: Prisma.cp_taskWhereInput = {
    ...assigneeWhere(ids),
    ...(f.counsellorId ? { assignee_cp_user_id: f.counsellorId } : {}),
    ...(f.category !== undefined ? { category: f.category } : {}),
    status: { not: TaskStatus.CANCELLED },
    created_at: { gte: new Date(`${f.from}T00:00:00+05:30`), lt: new Date(`${addDays(f.to, 1)}T00:00:00+05:30`) },
  };
  const rows = await db.cp_task.findMany({
    where,
    select: {
      ...taskRowSelect,
      event: { orderBy: { created_at: "asc" }, select: { id: true, kind: true, cp_user_id: true, from_date: true, to_date: true, reason_code: true, note: true, created_at: true } },
    },
    orderBy: { created_at: "asc" },
    take: 2000,
  });
  const created = rows.length;
  const completed = rows.filter((r) => r.status === TaskStatus.COMPLETED);
  const tz = clock.config.timezone;
  const doneOn = (r: (typeof rows)[number]) => (r.completed_at ? dateInTimezone(r.completed_at, tz) : null);
  const createdOn = (r: (typeof rows)[number]) => dateInTimezone(r.created_at, tz);
  const onTime = completed.filter((r) => {
    const d = doneOn(r);
    const o = keyOf(r.original_due_date);
    return d && (!o || d <= o);
  });
  const days = completed.map((r) => calendarDaysBetween(createdOn(r), doneOn(r)!));
  const postponed = rows.filter((r) => r.postponements > 0);
  const pendingReq = await db.cp_task_shift_request.findMany({
    where: { task_id: { in: rows.map((r) => r.id) }, status: ShiftStatus.PENDING },
    select: { task_id: true },
  });
  const pendingSet = new Set(pendingReq.map((p) => p.task_id));
  const lastReason = await db.cp_task_shift_request.findMany({
    where: { task_id: { in: rows.map((r) => r.id) }, status: { not: ShiftStatus.DRAFT } },
    orderBy: { day: "desc" },
    select: { task_id: true, reason_code: true },
  });
  const reasonByTask = new Map<number, string>();
  for (const r of lastReason) if (!reasonByTask.has(r.task_id)) reasonByTask.set(r.task_id, delayReasonLabel(r.reason_code));

  const list = f.postponedOnly ? rows.filter((r) => r.postponements > 0 || pendingSet.has(r.id)) : rows;
  const items = [];
  for (const r of list.slice(-500).reverse()) {
    const base = toTaskRow(r, clock);
    const d = doneOn(r);
    const c = createdOn(r);
    const o = keyOf(r.original_due_date);
    const end = d ?? clock.today;
    items.push({
      ...base,
      createdOn: c,
      revisedDues: r.event.filter((e) => (e.kind === "shift_approved" || e.kind === "rescheduled") && e.to_date).map((e) => dateKey(e.to_date!)),
      pendingShift: pendingSet.has(r.id),
      totalDays: calendarDaysBetween(c, end),
      lateDays: o ? Math.max(0, calendarDaysBetween(o, end)) : 0,
      open: !d,
      delayReason: reasonByTask.get(r.id) ?? null,
      history: await historyRows(r.event),
    });
  }
  return {
    stats: {
      created,
      completed: completed.length,
      onTime: onTime.length,
      onTimePct: completed.length ? Math.round((onTime.length / completed.length) * 100) : 0,
      avgDays: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : 0,
      postponed: postponed.length,
      postponedTwice: postponed.filter((r) => r.postponements >= 2).length,
    },
    items,
  };
}

// ---- Head Counsellor monitoring dashboard ---------------------------------------

export type TeamFilter = {
  from: string;
  to: string;
  counsellorId?: number;
  departmentId?: number;
  category?: number;
  state?: TaskState;
  partner?: string; // "org:<id>" | "user:<id>"
  studentId?: number;
};

export async function teamDashboard(user: StaffUser, f: TeamFilter) {
  await syncLinkedTasks();
  const clock = await taskClock();
  let ids = await taskScopeIds(user);
  if (f.departmentId) {
    const inDept = await db.collegepond_user.findMany({ where: { department_id: f.departmentId }, select: { id: true } });
    const d = inDept.map((x) => x.id);
    ids = ids === null ? d : ids.filter((x) => d.includes(x));
  }
  if (f.counsellorId) ids = ids === null ? [f.counsellorId] : ids.filter((x) => x === f.counsellorId);
  const studentWhere: Prisma.studentWhereInput = {};
  if (f.partner?.startsWith("org:")) studentWhere.org_id = Number(f.partner.slice(4));
  if (f.partner?.startsWith("user:")) Object.assign(studentWhere, { org_id: null, created_by_user_id: Number(f.partner.slice(5)) });
  const where: Prisma.cp_taskWhereInput = {
    ...assigneeWhere(ids),
    ...(f.category !== undefined ? { category: f.category } : {}),
    ...(f.studentId ? { student_id: f.studentId } : {}),
    ...(Object.keys(studentWhere).length ? { student: studentWhere } : {}),
    status: { not: TaskStatus.CANCELLED },
    assigned_on: { gte: toDate(f.from), lte: toDate(f.to) },
  };
  const rows = await db.cp_task.findMany({
    where,
    select: {
      id: true,
      status: true,
      due_date: true,
      postponements: true,
      created_at: true,
      completed_at: true,
      source: true,
      assignee_cp_user_id: true,
      assignee: { select: { first_name: true, last_name: true } },
    },
    take: 5000,
  });
  const tz = clock.config.timezone;
  const withState = rows
    .map((r) => ({ ...r, state: taskState({ status: r.status, dueDate: keyOf(r.due_date) }, clock.today, clock.dayClosed) }))
    .filter((r) => !f.state || r.state === f.state || (f.state === "pending" && r.state === "in_progress"));
  const done = withState.filter((r) => r.state === "completed");
  const daysOf = (r: (typeof done)[number]) =>
    calendarDaysBetween(dateInTimezone(r.created_at, tz), dateInTimezone(r.completed_at!, tz));
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  const byCounsellor = new Map<number, { id: number; name: string; assigned: number; completed: number; pending: number; overdue: number; shifted: number; days: number[] }>();
  for (const r of withState) {
    const k = r.assignee_cp_user_id ?? 0;
    const g = byCounsellor.get(k) ?? { id: k, name: r.assignee ? fullName(r.assignee) : "Unassigned", assigned: 0, completed: 0, pending: 0, overdue: 0, shifted: 0, days: [] };
    g.assigned++;
    if (r.state === "completed") {
      g.completed++;
      g.days.push(daysOf(r));
    } else if (r.state === "overdue") g.overdue++;
    else g.pending++;
    if (r.postponements > 0) g.shifted++;
    byCounsellor.set(k, g);
  }
  // Follow-ups due: open automatic follow-up tasks due by today.
  const followUpsDue = await db.cp_task.count({
    where: {
      ...assigneeWhere(ids),
      source: { in: ["shortlist", "follow_up"] },
      status: { in: OPEN_STATUSES },
      due_date: { lte: toDate(clock.today) },
    },
  });
  return {
    stats: {
      assigned: withState.length,
      completed: done.length,
      pending: withState.filter((r) => r.state === "pending" || r.state === "in_progress").length,
      overdue: withState.filter((r) => r.state === "overdue").length,
      shifted: withState.filter((r) => r.postponements > 0).length,
      avgCompletionDays: avg(done.map(daysOf)),
      followUpsDue,
    },
    counsellors: [...byCounsellor.values()]
      .map((g) => ({
        id: g.id,
        name: g.name,
        assigned: g.assigned,
        completed: g.completed,
        pending: g.pending,
        overdue: g.overdue,
        shifted: g.shifted,
        completionPct: g.assigned ? Math.round((g.completed / g.assigned) * 100) : 0,
        avgDays: avg(g.days),
      }))
      .sort((a, b) => b.assigned - a.assigned),
    counsellorIds: ids,
  };
}

// Counsellors a user can filter by / assign to in the task views.
export async function taskPeople(user: StaffUser) {
  const ids = await taskScopeIds(user);
  const people = await db.collegepond_user.findMany({
    where: {
      status: 1,
      role: { in: [AdminRole.COUNSELLOR, AdminRole.COUNSELLOR_LEAD] },
      ...(ids === null ? {} : { id: { in: ids } }),
    },
    select: { id: true, first_name: true, last_name: true, role: true, department_id: true },
    orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
  });
  const assignable = await assignableCounsellorIds(user);
  return people.map((p) => ({
    id: p.id,
    name: fullName(p),
    role: p.role,
    departmentId: p.department_id,
    assignable: p.id === user.id || assignable === null || assignable.includes(p.id),
  }));
}

// ---- Evening digest (cron) ---------------------------------------------------------

// After the day closes: tell each Head Counsellor which of their counsellors
// left tasks incomplete without closing their day. Once per counsellor per
// day (cp_day_close.reminder_emailed_at). Working days only.
export async function runDayCloseDigest(now = new Date()) {
  await syncLinkedTasks(true);
  const clock = await taskClock(now);
  if (!clock.isWorkingDay) return { skipped: "not a working day" as const, emailed: 0, counsellors: 0 };
  if (!clock.dayClosed) return { skipped: "the day hasn't closed yet" as const, emailed: 0, counsellors: 0 };
  const open = await db.cp_task.groupBy({
    by: ["assignee_cp_user_id"],
    where: { status: { in: OPEN_STATUSES }, due_date: { lte: toDate(clock.today) }, assignee_cp_user_id: { not: null } },
    _count: { _all: true },
  });
  const dayDate = toDate(clock.today);
  const closes = await db.cp_day_close.findMany({ where: { day: dayDate } });
  const closeBy = new Map(closes.map((c) => [c.cp_user_id, c]));
  const offenders: { id: number; count: number }[] = [];
  for (const o of open) {
    const id = o.assignee_cp_user_id!;
    const c = closeBy.get(id);
    if (c?.submitted_at || c?.reminder_emailed_at) continue;
    offenders.push({ id, count: o._count._all });
  }
  if (offenders.length === 0) return { skipped: null, emailed: 0, counsellors: 0 };
  const people = await db.collegepond_user.findMany({
    where: { id: { in: offenders.map((o) => o.id) }, status: 1 },
    select: { id: true, first_name: true, last_name: true },
  });
  const names = new Map(people.map((p) => [p.id, fullName(p)]));
  const groups = new Map<number | null, { id: number; count: number }[]>();
  for (const o of offenders) {
    if (!names.has(o.id)) continue;
    // Out of office today: their alternate has the list; skip the nag.
    if ((await responderFor(o.id)) !== o.id) continue;
    const hc = await headCounsellorOf(o.id);
    groups.set(hc, [...(groups.get(hc) ?? []), o]);
  }
  let emailed = 0;
  let counsellors = 0;
  for (const [hc, list] of groups) {
    // Claim each counsellor first so a second run sends nothing twice.
    const claimed: { id: number; count: number }[] = [];
    for (const o of list) {
      const dc = await db.cp_day_close.upsert({
        where: { cp_user_id_day: { cp_user_id: o.id, day: dayDate } },
        create: { cp_user_id: o.id, day: dayDate },
        update: {},
      });
      const res = await db.cp_day_close.updateMany({
        where: { id: dc.id, reminder_emailed_at: null, submitted_at: null },
        data: { reminder_emailed_at: new Date() },
      });
      if (res.count > 0) claimed.push(o);
    }
    if (claimed.length === 0) continue;
    counsellors += claimed.length;
    const { people: recipients, coveringFor } = await approverRecipients(hc, -1);
    const lines = claimed.map((o) => `${names.get(o.id)}: ${o.count} incomplete task${o.count === 1 ? "" : "s"}, no reasons given`);
    for (const p of recipients) {
      try {
        await sendEmail(
          p.email,
          dayCloseEmail(
            { name: fullName(p) },
            {
              subject: `Day not closed: ${claimed.length} counsellor${claimed.length === 1 ? "" : "s"} with incomplete tasks – ${fmtWeekday(clock.today)}`,
              heading: "Counsellors who haven't closed their day",
              intro: `${coveringFor ? `You're covering for ${coveringFor} while they're out of office. ` : ""}The working day closed at 7:00 PM. These counsellors still have tasks due today or earlier and haven't given reasons:`,
              lines,
              outro: "Their tasks stay overdue on their lists until they're done or a shift is approved.",
              link: "/admin/tasks?tab=team",
              button: "Open the team dashboard",
            },
            appUrl(),
          ),
        );
        emailed++;
      } catch (e) {
        logError("day close digest email", e);
      }
    }
  }
  return { skipped: null, emailed, counsellors };
}
