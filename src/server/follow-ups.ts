import "server-only";
import { TRPCError } from "@trpc/server";
import { db } from "~/server/db";
import { UniApplicationStatusLabel } from "~/server/db/enums";
import {
  DEFAULT_DECISION_WEEKS,
  FASTER_TAT_DECISION_WEEKS,
  FOLLOW_UP_STAGES,
  MAX_FOLLOW_UP_DAYS_AHEAD,
  addDays,
  daysBetween,
  fmtDay,
  isFollowUpStage,
} from "~/lib/follow-ups";
import { dateInTimezone, dateKey, oooToday } from "~/server/out-of-office";
import { getTatConfig } from "~/server/tat";
import { notifyCounsellorFollowUp } from "~/server/counsellor-notify";
import { staffApplicationScope, type StaffUser } from "~/server/staff-access";

// Application follow-ups (tester doc 29 Oct 2026, decided with Suraj 30 Oct).
// While an application is with the university (Application Submitted /
// Under Review) its counsellor schedules follow-ups: one open at a time,
// as many as needed (complete one, schedule the next). Each follow-up is
// open until it is ticked done, or until the application moves to any other
// stage (an offer, a rejection, any closed outcome, or back before
// submission), when transitionApplication closes it (closed, never deleted).
//
// Reminders, sent by the daily /api/cron/follow-ups run (or a Super Admin's
// "Run reminders now"), to the student's counsellor (the follow-up's
// creator when the student has none), routed through responderFor() for
// out of office (counsellor-notify.ts):
//   - due date: in-app + email ("Follow-up due: <University>");
//   - first overdue day: in-app + email ("Follow-up overdue");
//   - every later overdue day: an in-app reminder only (one rolling item per
//     application, refreshed daily), no more email.
// Each send is claimed first with a conditional update of its timestamp, so
// a second run the same day (or two at once) sends nothing twice.
// Rescheduling clears the timestamps.
//
// Who sees overdue follow-ups (TAT Management): staffApplicationScope, so a
// counsellor sees their own, a Counsellor Lead their team's and their own,
// a Super Admin all of them.
//
// Every change is audit-logged: schedule, reschedule, complete, auto-close,
// and the expected decision time.

const label = (s: number) => (UniApplicationStatusLabel as Record<number, string | undefined>)[s] ?? "Updated";
const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();
const studentLink = (studentId: number) => `/admin/students/${studentId}?tab=application`;
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Follow-up not found" });
const fail = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

const NOTIFICATION_TYPES = ["application.follow_up_due", "application.follow_up_overdue"];
const openWhere = { completed_at: null, closed_at: null } as const;

async function tz() {
  return (await getTatConfig()).timezone;
}

// When the application reached Application Submitted, as a date key: the
// submitted_at stamp, else its stage-history entry (older/seeded rows).
async function submittedOn(
  a: { id: number; submitted_at: Date | null },
  timezone: string,
): Promise<string | null> {
  if (a.submitted_at) return dateInTimezone(a.submitted_at, timezone);
  const h = await db.application_stage_history.findFirst({
    where: { application_id: a.id, stage: { in: FOLLOW_UP_STAGES } },
    orderBy: { occurred_at: "asc" },
    select: { occurred_at: true },
  });
  return h ? dateInTimezone(h.occurred_at, timezone) : null;
}

function decisionWeeks(a: { decision_expected_weeks: number | null; course: { faster_tat: number | null } }) {
  if (a.decision_expected_weeks) return { weeks: a.decision_expected_weeks, isDefault: false };
  return { weeks: a.course.faster_tat ? FASTER_TAT_DECISION_WEEKS : DEFAULT_DECISION_WEEKS, isDefault: true };
}

const appSelect = {
  id: true,
  status: true,
  student_id: true,
  submitted_at: true,
  decision_expected_weeks: true,
  course: { select: { name: true, faster_tat: true, university: { select: { name: true } } } },
} as const;

// ---- Panel (admin Application tab) -------------------------------------------

export async function followUpPanel(applicationId: number) {
  const a = await db.application.findUnique({ where: { id: applicationId }, select: appSelect });
  if (!a) throw notFound();
  const timezone = await tz();
  const today = dateInTimezone(new Date(), timezone);
  const rows = await db.application_follow_up.findMany({
    where: { application_id: applicationId },
    orderBy: { seq: "asc" },
  });
  const people = await db.collegepond_user.findMany({
    where: {
      id: {
        in: [
          ...new Set(
            rows.flatMap((r) => [r.completed_by_cp_user_id, r.created_by_cp_user_id]).filter((x): x is number => !!x),
          ),
        ],
      },
    },
    select: { id: true, first_name: true, last_name: true },
  });
  const nameOf = (id: number | null) => {
    const p = id ? people.find((x) => x.id === id) : null;
    return p ? fullName(p) : null;
  };
  const submitted = await submittedOn(a, timezone);
  const { weeks, isDefault } = decisionWeeks(a);
  const active = isFollowUpStage(a.status);
  return {
    active,
    stage: label(a.status),
    today,
    submittedOn: submitted,
    decisionWeeks: weeks,
    decisionWeeksIsDefault: isDefault,
    expectedBy: submitted ? addDays(submitted, weeks * 7) : null,
    canSchedule: active && !rows.some((r) => !r.completed_at && !r.closed_at),
    rows: rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      dueDate: dateKey(r.due_date),
      completedOn: r.completed_at ? dateInTimezone(r.completed_at, timezone) : null,
      completedBy: nameOf(r.completed_by_cp_user_id),
      closedOn: r.closed_at ? dateInTimezone(r.closed_at, timezone) : null,
      closedReason: r.closed_reason,
      createdBy: nameOf(r.created_by_cp_user_id),
    })),
  };
}

// ---- Changes -------------------------------------------------------------------

async function requireFollowUpStage(applicationId: number) {
  const a = await db.application.findUnique({ where: { id: applicationId }, select: { status: true } });
  if (!a) throw notFound();
  if (!isFollowUpStage(a.status)) {
    throw fail("Follow-ups are only for applications at Application Submitted or Under Review.");
  }
}

async function validDueDate(dueDate: string) {
  const today = await oooToday();
  if (dueDate < today) throw fail("Pick today or a later date.");
  if (daysBetween(today, dueDate) > MAX_FOLLOW_UP_DAYS_AHEAD) throw fail("Pick a date within a year.");
  return new Date(`${dueDate}T00:00:00Z`);
}

// The open follow-up with this id, and its application id.
async function openFollowUp(followUpId: number) {
  const f = await db.application_follow_up.findUnique({
    where: { id: followUpId },
    select: { id: true, application_id: true, seq: true, due_date: true, completed_at: true, closed_at: true },
  });
  if (!f) throw notFound();
  if (f.completed_at || f.closed_at) throw fail("This follow-up is already finished.");
  return f;
}

// Bell items about an application's follow-ups are done with once it is
// completed or closed.
async function clearReminders(applicationId: number) {
  const a = await db.application.findUnique({ where: { id: applicationId }, select: { student_id: true } });
  if (!a) return;
  await db.cp_notification.updateMany({
    where: { type: { in: NOTIFICATION_TYPES }, link: followUpLink(a.student_id, applicationId), read_at: null },
    data: { read_at: new Date() },
  });
}

const followUpLink = (studentId: number, applicationId: number) => `${studentLink(studentId)}&app=${applicationId}`;

export async function scheduleFollowUp(actorCpUserId: number, applicationId: number, dueDate: string) {
  await requireFollowUpStage(applicationId);
  const due = await validDueDate(dueDate);
  const open = await db.application_follow_up.count({ where: { application_id: applicationId, ...openWhere } });
  if (open > 0) throw fail("Complete the open follow-up first, or change its date.");
  const last = await db.application_follow_up.findFirst({
    where: { application_id: applicationId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const seq = (last?.seq ?? 0) + 1;
  const row = await db.application_follow_up.create({
    data: { application_id: applicationId, seq, due_date: due, created_by_cp_user_id: actorCpUserId },
  });
  await db.audit_log.create({
    data: {
      action: "application.follow_up_scheduled",
      entity_type: "application",
      entity_id: applicationId,
      metadata: { followUpId: row.id, seq, dueDate, byCpUserId: actorCpUserId },
    },
  });
  return { id: row.id, seq };
}

export async function rescheduleFollowUp(actorCpUserId: number, followUpId: number, dueDate: string) {
  const f = await openFollowUp(followUpId);
  await requireFollowUpStage(f.application_id);
  const due = await validDueDate(dueDate);
  const from = dateKey(f.due_date);
  if (from === dueDate) return { seq: f.seq };
  // A new date is a new reminder schedule.
  await db.application_follow_up.update({
    where: { id: f.id },
    data: { due_date: due, due_notified_at: null, overdue_emailed_at: null, overdue_reminded_on: null },
  });
  await clearReminders(f.application_id);
  await db.audit_log.create({
    data: {
      action: "application.follow_up_rescheduled",
      entity_type: "application",
      entity_id: f.application_id,
      metadata: { followUpId: f.id, seq: f.seq, from, to: dueDate, byCpUserId: actorCpUserId },
    },
  });
  return { seq: f.seq };
}

export async function completeFollowUp(actorCpUserId: number, followUpId: number) {
  const f = await openFollowUp(followUpId);
  // Conditional: a double click (or an auto-close racing it) completes once.
  const res = await db.application_follow_up.updateMany({
    where: { id: f.id, ...openWhere },
    data: { completed_at: new Date(), completed_by_cp_user_id: actorCpUserId },
  });
  if (res.count === 0) throw fail("This follow-up is already finished.");
  await clearReminders(f.application_id);
  await db.audit_log.create({
    data: {
      action: "application.follow_up_completed",
      entity_type: "application",
      entity_id: f.application_id,
      metadata: { followUpId: f.id, seq: f.seq, dueDate: dateKey(f.due_date), byCpUserId: actorCpUserId },
    },
  });
  return { seq: f.seq };
}

export async function setDecisionWeeks(actorCpUserId: number, applicationId: number, weeks: number) {
  const a = await db.application.findUnique({
    where: { id: applicationId },
    select: { decision_expected_weeks: true },
  });
  if (!a) throw notFound();
  if (a.decision_expected_weeks === weeks) return;
  await db.application.update({ where: { id: applicationId }, data: { decision_expected_weeks: weeks } });
  await db.audit_log.create({
    data: {
      action: "application.decision_weeks_set",
      entity_type: "application",
      entity_id: applicationId,
      metadata: { from: a.decision_expected_weeks, to: weeks, byCpUserId: actorCpUserId },
    },
  });
}

// The application left Submitted / Under Review: its open follow-ups end.
// Called by transitionApplication (actor = who moved it) and by the daily
// run as a safety net (actor null). Never throws: the stage change is saved.
export async function closeOpenFollowUps(
  applicationId: number,
  newStatus: number,
  actorCpUserId: number | null,
): Promise<number> {
  if (isFollowUpStage(newStatus)) return 0;
  try {
    const open = await db.application_follow_up.findMany({
      where: { application_id: applicationId, ...openWhere },
      select: { id: true, seq: true },
    });
    if (open.length === 0) return 0;
    const res = await db.application_follow_up.updateMany({
      where: { id: { in: open.map((f) => f.id) }, ...openWhere },
      data: { closed_at: new Date(), closed_reason: `Moved to ${label(newStatus)}`.slice(0, 100) },
    });
    await clearReminders(applicationId);
    await db.audit_log.create({
      data: {
        action: "application.follow_ups_auto_closed",
        entity_type: "application",
        entity_id: applicationId,
        metadata: {
          followUpIds: open.map((f) => f.id),
          seqs: open.map((f) => f.seq),
          toStatus: newStatus,
          ...(actorCpUserId ? { byCpUserId: actorCpUserId } : { via: "follow-up run" }),
        },
      },
    });
    return res.count;
  } catch (e) {
    console.error("[follow-ups] auto-close failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

// ---- Overdue list (TAT Management) --------------------------------------------

export async function overdueFollowUps(user: StaffUser) {
  const today = await oooToday();
  const rows = await db.application_follow_up.findMany({
    where: {
      ...openWhere,
      due_date: { lt: new Date(`${today}T00:00:00Z`) },
      application: { AND: [{ status: { in: FOLLOW_UP_STAGES } }, await staffApplicationScope(user)] },
    },
    orderBy: [{ due_date: "asc" }, { id: "asc" }],
    take: 500,
    select: {
      id: true,
      seq: true,
      due_date: true,
      created_by_cp_user_id: true,
      application: {
        select: {
          id: true,
          status: true,
          student: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              cp_counsellor: { select: { first_name: true, last_name: true } },
            },
          },
          course: { select: { name: true, university: { select: { name: true } } } },
        },
      },
    },
  });
  return {
    today,
    rows: rows.map((r) => {
      const due = dateKey(r.due_date);
      const s = r.application.student;
      return {
        id: r.id,
        seq: r.seq,
        applicationId: r.application.id,
        studentId: s.id,
        studentName: fullName(s),
        university: r.application.course.university.name,
        program: r.application.course.name,
        stage: label(r.application.status),
        counsellor: s.cp_counsellor ? fullName(s.cp_counsellor) : null,
        dueDate: due,
        daysOverdue: daysBetween(due, today),
        link: followUpLink(s.id, r.application.id),
      };
    }),
  };
}

// ---- Daily run -------------------------------------------------------------------

export type FollowUpRunResult = {
  today: string;
  due: number; // due-day in-app + email
  overdueFirst: number; // first overdue day in-app + email
  overdueDaily: number; // later overdue days, in-app only
  closed: number; // open follow-ups on applications that had moved on
  noRecipient: number; // claimed, but the student has no active counsellor
};

// Sends today's follow-up reminders. Safe to run any number of times a day.
export async function runFollowUpReminders(now = new Date()): Promise<FollowUpRunResult> {
  const timezone = await tz();
  const today = dateInTimezone(now, timezone);
  const todayDate = new Date(`${today}T00:00:00Z`);
  const result: FollowUpRunResult = { today, due: 0, overdueFirst: 0, overdueDaily: 0, closed: 0, noRecipient: 0 };

  // Safety net: open follow-ups on applications that are no longer with the
  // university (every stage change goes through transitionApplication, which
  // closes them; this catches anything that didn't).
  const stale = await db.application_follow_up.findMany({
    where: { ...openWhere, application: { status: { notIn: FOLLOW_UP_STAGES } } },
    select: { application_id: true, application: { select: { status: true } } },
  });
  for (const id of new Set(stale.map((s) => s.application_id))) {
    const status = stale.find((s) => s.application_id === id)!.application.status;
    result.closed += await closeOpenFollowUps(id, status, null);
  }

  const rows = await db.application_follow_up.findMany({
    where: { ...openWhere, due_date: { lte: todayDate }, application: { status: { in: FOLLOW_UP_STAGES } } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      seq: true,
      due_date: true,
      due_notified_at: true,
      overdue_emailed_at: true,
      overdue_reminded_on: true,
      created_by_cp_user_id: true,
      application: { select: appSelect },
    },
  });

  for (const f of rows) {
    const due = dateKey(f.due_date);
    const overdueDays = daysBetween(due, today);
    let kind: "due" | "overdueFirst" | "overdueDaily" | null = null;
    // Claim the send before making it: only the run whose update lands sends.
    if (overdueDays === 0) {
      if (f.due_notified_at) continue;
      const res = await db.application_follow_up.updateMany({
        where: { id: f.id, ...openWhere, due_notified_at: null },
        data: { due_notified_at: now },
      });
      if (res.count === 1) kind = "due";
    } else if (!f.overdue_emailed_at) {
      const res = await db.application_follow_up.updateMany({
        where: { id: f.id, ...openWhere, overdue_emailed_at: null },
        data: { overdue_emailed_at: now, overdue_reminded_on: todayDate },
      });
      if (res.count === 1) kind = "overdueFirst";
    } else if (!f.overdue_reminded_on || dateKey(f.overdue_reminded_on) < today) {
      const res = await db.application_follow_up.updateMany({
        where: {
          id: f.id,
          ...openWhere,
          OR: [{ overdue_reminded_on: null }, { overdue_reminded_on: { lt: todayDate } }],
        },
        data: { overdue_reminded_on: todayDate },
      });
      if (res.count === 1) kind = "overdueDaily";
    }
    if (!kind) continue;

    const a = f.application;
    const student = await db.student.findUnique({
      where: { id: a.student_id },
      select: { first_name: true, last_name: true, cp_counsellor_id: true },
    });
    const ownerId = student?.cp_counsellor_id ?? f.created_by_cp_user_id;
    const submitted = await submittedOn(a, timezone);
    const uni = a.course.university.name;
    const lines = [
      `Student: ${student ? fullName(student) : `CP-${a.student_id}`}`,
      `University: ${uni}`,
      `Program: ${a.course.name}`,
      `Stage: ${label(a.status)}`,
      `Submitted: ${submitted ? fmtDay(submitted) : "not recorded"}`,
      `Follow-up ${f.seq} due: ${fmtDay(due)}${overdueDays > 0 ? ` (overdue ${overdueDays} day${overdueDays === 1 ? "" : "s"})` : ""}`,
    ];
    const link = followUpLink(a.student_id, a.id);
    const who = student ? fullName(student) : "a student";
    // The overdue item replaces yesterday's "due" one.
    if (kind === "overdueFirst") {
      await db.cp_notification.updateMany({
        where: { type: "application.follow_up_due", link, read_at: null },
        data: { read_at: now },
      });
    }
    const sent = ownerId
      ? await notifyCounsellorFollowUp(
          ownerId,
          kind === "due"
            ? {
                type: "application.follow_up_due",
                title: `Follow-up due: ${uni} (${who})`,
                lines,
                link,
                tone: "orange",
                email: {
                  subject: `Follow-up due: ${uni}`,
                  intro: `Follow-up ${f.seq} with the university is due today. Check on the decision, then tick it done in the Application tab and schedule the next one if needed.`,
                },
              }
            : {
                type: "application.follow_up_overdue",
                title: `Follow-up overdue ${overdueDays} day${overdueDays === 1 ? "" : "s"}: ${uni} (${who})`,
                lines,
                link,
                tone: "red",
                rolling: kind === "overdueDaily",
                email:
                  kind === "overdueFirst"
                    ? {
                        subject: `Follow-up overdue: ${uni}`,
                        intro: `Follow-up ${f.seq} with the university was due on ${fmtDay(due)} and hasn't been marked done. Follow up, then tick it done in the Application tab, or change its date.`,
                      }
                    : null,
              },
        )
      : false;
    if (sent) result[kind]++;
    else result.noRecipient++;
  }
  return result;
}
