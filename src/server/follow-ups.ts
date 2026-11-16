import "server-only";
import { type Prisma } from "../../generated/prisma";
import { TRPCError } from "@trpc/server";
import { db } from "~/server/db";
import { DocumentStatus, UniApplicationStatus, UniApplicationStatusLabel } from "~/server/db/enums";
import {
  DEFAULT_DECISION_WEEKS,
  DEPOSIT_FOLLOW_UP_DAYS_BEFORE,
  FASTER_TAT_DECISION_WEEKS,
  FOLLOW_UP_KINDS,
  FOLLOW_UP_KIND_LABEL,
  FOLLOW_UP_KIND_STAGES,
  FOLLOW_UP_STAGES,
  MAX_FOLLOW_UP_DAYS_AHEAD,
  VISA_FOLLOW_UP_INTERVAL_DAYS,
  addDays,
  daysBetween,
  fmtDay,
  isFollowUpKind,
  isFollowUpKindStage,
  type FollowUpKind,
} from "~/lib/follow-ups";
import { stageAtLeast } from "~/lib/application-stages";
import { dateInTimezone, dateKey, oooToday } from "~/server/out-of-office";
import { getTatConfig } from "~/server/tat";
import { notifyCounsellorFollowUp } from "~/server/counsellor-notify";
import { appUrl, counsellorFollowUpEmail, emailFromAddress, sendEmail } from "~/server/email";
import { buildIcs, emailAddress, type IcsMethod } from "~/server/ics";
import { staffApplicationScope, type StaffUser } from "~/server/staff-access";

// Application follow-ups (tester doc 29 Oct 2026, decided with Suraj 30 Oct;
// deposit and visa kinds from the 16 Nov change list). One system, three
// kinds (src/lib/follow-ups.ts), each numbered on its own and tied to its
// own stages:
//
//   decision  Application Submitted / Under Review. The counsellor schedules
//             them, one open at a time, as many as needed.
//   deposit   Unconditional Offer. Created automatically, due 7 days before
//             application.deposit_deadline (today if that has passed). A new
//             or changed deadline creates or moves it (anchor_date = the
//             deadline it was made for, so the same deadline never makes a
//             second); a removed deadline closes it. The counsellor must tick
//             it done: it stays on the overdue list and keeps reminding.
//             Moving to Deposit Paid (or past it) closes it, and the
//             counsellor is emailed that the deposit was paid.
//   visa      Deposit Paid / Visa Filed (visa documentation). Scheduled by
//             hand with a date, the days the partner is asked to respond
//             within, and remarks. Weekly: once one is done or falls due, the
//             next is set 7 days on (same duration and remarks). Closes when
//             the visa (or refusal) is uploaded, or the visa outcome is
//             recorded, or the application closes.
//
// Any open follow-up closes (never deleted) when the application leaves its
// kind's stages: transitionApplication → closeOpenFollowUps.
//
// Reminders, sent by the daily /api/cron/follow-ups run (or a Super Admin's
// "Run reminders now"), to the student's counsellor (the follow-up's creator
// when the student has none), routed through responderFor() for out of
// office (counsellor-notify.ts):
//   - due date: in-app + email;
//   - first overdue day: in-app + email;
//   - every later overdue day: an in-app reminder only (one rolling item per
//     application and kind, refreshed daily), no more email.
// Each send is claimed first with a conditional update of its timestamp, so
// a second run the same day (or two at once) sends nothing twice.
// Rescheduling clears the timestamps.
//
// Calendar (no OAuth sync): every follow-up, when scheduled or moved, is
// emailed to its owner as an invite (.ics, METHOD:REQUEST, UID per
// follow-up, SEQUENCE bumped on every change). When one closes by itself
// while its event is still ahead (always for deposit and visa), a CANCEL
// goes to the address holding the invite. Completing one leaves its event
// as a record. The panel can also download the .ics (followUpIcsFile).
//
// Who sees overdue follow-ups (TAT Management): staffApplicationScope, so a
// counsellor sees their own, a Counsellor Lead their team's and their own,
// a Super Admin all of them.
//
// Every change is audit-logged.

const label = (s: number) => (UniApplicationStatusLabel as Record<number, string | undefined>)[s] ?? "Updated";
const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();
const studentLink = (studentId: number) => `/admin/students/${studentId}?tab=application`;
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Follow-up not found" });
const fail = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const NOUN: Record<FollowUpKind, string> = {
  decision: "Follow-up",
  deposit: "Deposit follow-up",
  visa: "Visa file follow-up",
};
// Blank remarks are stored as NULL.
const cleanRemarks = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
const nameOf = (kind: FollowUpKind, seq: number) => `${NOUN[kind]} ${seq}`;
const kindOf = (s: string): FollowUpKind => (isFollowUpKind(s) ? s : "decision");

const NOTIFICATION_TYPES = ["application.follow_up_due", "application.follow_up_overdue"];
const openWhere = { completed_at: null, closed_at: null } as const;

// Decision follow-ups keep the link they always had (existing bell items
// match on it); the other kinds add their own, so clearing one kind's
// reminders leaves the others.
const followUpLink = (studentId: number, applicationId: number, kind: FollowUpKind = "decision") =>
  `${studentLink(studentId)}&app=${applicationId}${kind === "decision" ? "" : `&fu=${kind}`}`;

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
  deposit_deadline: true,
  deposit_amount: true,
  deposit_currency: true,
  course: { select: { name: true, faster_tat: true, university: { select: { name: true } } } },
} as const;

const rowSelect = {
  id: true,
  application_id: true,
  kind: true,
  seq: true,
  due_date: true,
  anchor_date: true,
  respond_within_days: true,
  remarks: true,
  completed_at: true,
  closed_at: true,
  created_by_cp_user_id: true,
  ics_sequence: true,
  ics_sent_sequence: true,
  ics_sent_to: true,
} as const;
type Row = Prisma.application_follow_upGetPayload<{ select: typeof rowSelect }>;

// Days the visa follow-up gives the partner, and by when.
function respondLine(r: { due_date: Date; respond_within_days: number | null }) {
  if (!r.respond_within_days) return null;
  const by = addDays(dateKey(r.due_date), r.respond_within_days);
  return `Partner to respond within ${plural(r.respond_within_days, "day")} (by ${fmtDay(by)})`;
}

function depositLine(a: { deposit_amount: Prisma.Decimal | null; deposit_currency: string | null }) {
  if (a.deposit_amount === null) return null;
  return `Deposit: ${a.deposit_currency ?? ""} ${Number(a.deposit_amount).toLocaleString("en-IN")}`.replace("  ", " ");
}

// ---- Context for messages --------------------------------------------------------

type Ctx = {
  app: Prisma.applicationGetPayload<{ select: typeof appSelect }>;
  studentName: string;
  ownerId: number | null;
  timezone: string;
  today: string;
};

async function loadCtx(applicationId: number, createdBy: number | null): Promise<Ctx | null> {
  const app = await db.application.findUnique({ where: { id: applicationId }, select: appSelect });
  if (!app) return null;
  const student = await db.student.findUnique({
    where: { id: app.student_id },
    select: { first_name: true, last_name: true, cp_counsellor_id: true },
  });
  const timezone = await tz();
  return {
    app,
    studentName: student ? fullName(student) : `CP-${app.student_id}`,
    ownerId: student?.cp_counsellor_id ?? createdBy,
    timezone,
    today: dateInTimezone(new Date(), timezone),
  };
}

async function messageLines(r: Row, c: Ctx, overdueDays = 0): Promise<string[]> {
  const kind = kindOf(r.kind);
  const due = dateKey(r.due_date);
  const a = c.app;
  const lines = [
    `Student: ${c.studentName}`,
    `University: ${a.course.university.name}`,
    `Program: ${a.course.name}`,
    `Stage: ${label(a.status)}`,
  ];
  if (kind === "decision") {
    const submitted = await submittedOn(a, c.timezone);
    lines.push(`Submitted: ${submitted ? fmtDay(submitted) : "not recorded"}`);
  } else if (kind === "deposit") {
    if (a.deposit_deadline) lines.push(`Deposit deadline: ${fmtDay(dateKey(a.deposit_deadline))}`);
    const dep = depositLine(a);
    if (dep) lines.push(dep);
  } else {
    const resp = respondLine(r);
    if (resp) lines.push(resp);
  }
  if (r.remarks) lines.push(`Remarks: ${r.remarks}`);
  lines.push(
    `${nameOf(kind, r.seq)} due: ${fmtDay(due)}${overdueDays > 0 ? ` (overdue ${plural(overdueDays, "day")})` : ""}`,
  );
  return lines;
}

// ---- Calendar ---------------------------------------------------------------------

function icsHost() {
  try {
    return new URL(appUrl()).host;
  } catch {
    return "convergeapp.co";
  }
}

function followUpIcs(
  method: IcsMethod,
  r: Row,
  c: Ctx,
  lines: string[],
  to: { name: string; email: string } | null,
  sequence = r.ics_sequence,
) {
  const kind = kindOf(r.kind);
  const url = `${appUrl().replace(/\/+$/, "")}${followUpLink(c.app.student_id, c.app.id, kind)}`;
  return buildIcs(method, {
    uid: `follow-up-${r.id}@${icsHost()}`,
    sequence,
    date: dateKey(r.due_date),
    summary: `${nameOf(kind, r.seq)}: ${c.studentName} – ${c.app.course.university.name}`,
    description: `${lines.join("\n")}\n\nOpen in Converge: ${url}`,
    url,
    organizer: emailAddress(emailFromAddress()),
    attendee: to,
  });
}

// The .ics behind the panel's "Add to calendar" (METHOD:PUBLISH, same UID
// as the emailed invite).
export async function followUpIcsFile(followUpId: number): Promise<{ fileName: string; ics: string } | null> {
  const r = await db.application_follow_up.findUnique({ where: { id: followUpId }, select: rowSelect });
  if (!r) return null;
  const c = await loadCtx(r.application_id, r.created_by_cp_user_id);
  if (!c) return null;
  const ics = followUpIcs("PUBLISH", r, c, await messageLines(r, c), null);
  return { fileName: `follow-up-${r.id}.ics`, ics };
}

// Claims the invite for SEQUENCE `seq` (only one sender wins); undone when
// nothing could be emailed, so a later run tries again.
async function claimInvite(r: Row): Promise<boolean> {
  const res = await db.application_follow_up.updateMany({
    where: {
      id: r.id,
      ...openWhere,
      ics_sequence: r.ics_sequence,
      OR: [{ ics_sent_sequence: null }, { ics_sent_sequence: { lt: r.ics_sequence } }],
    },
    data: { ics_sent_sequence: r.ics_sequence },
  });
  return res.count === 1;
}

async function recordInvite(r: Row, emailedTo: string | null, c: Ctx, lines: string[]) {
  if (!emailedTo) {
    await db.application_follow_up.updateMany({
      where: { id: r.id, ics_sent_sequence: r.ics_sequence },
      data: { ics_sent_sequence: r.ics_sent_sequence },
    });
    return;
  }
  await db.application_follow_up.update({ where: { id: r.id }, data: { ics_sent_to: emailedTo } });
  // The event moved to someone else (out of office cover changed): take it
  // off the old calendar.
  if (r.ics_sent_to && r.ics_sent_to.toLowerCase() !== emailedTo.toLowerCase()) {
    await sendCancelOnly(r, c, lines, r.ics_sent_to);
  }
}

async function sendCancelOnly(r: Row, c: Ctx, lines: string[], address: string) {
  const kind = kindOf(r.kind);
  try {
    await sendEmail(
      address,
      counsellorFollowUpEmail(
        { name: "" },
        {
          subject: `Calendar: ${nameOf(kind, r.seq)} cancelled (${c.app.course.university.name})`,
          heading: `${nameOf(kind, r.seq)} cancelled`,
          intro: "This follow-up is no longer on your list, so its calendar entry is cancelled.",
          lines,
          link: followUpLink(c.app.student_id, c.app.id, kind),
        },
        appUrl(),
      ),
      {
        calendar: {
          method: "CANCEL",
          ics: followUpIcs("CANCEL", r, c, lines, { name: address, email: address }, r.ics_sequence + 1),
        },
      },
    );
  } catch (e) {
    console.error("[follow-ups] calendar cancel failed:", e instanceof Error ? e.message : e);
  }
}

// Emails the owner the invite for an open follow-up, unless this SEQUENCE
// went out already. Never throws: the change itself is saved.
async function sendInvite(followUpId: number, why: "scheduled" | "moved" | "updated"): Promise<void> {
  try {
    const r = await db.application_follow_up.findUnique({ where: { id: followUpId }, select: rowSelect });
    if (!r || r.completed_at || r.closed_at) return;
    const c = await loadCtx(r.application_id, r.created_by_cp_user_id);
    if (!c?.ownerId) return;
    if (!(await claimInvite(r))) return;
    const kind = kindOf(r.kind);
    const due = dateKey(r.due_date);
    const when = due === c.today ? "today" : `for ${fmtDay(due)}`;
    const uni = c.app.course.university.name;
    const lines = await messageLines(r, c);
    const intro =
      why === "moved"
        ? `${nameOf(kind, r.seq)} is now ${when}. Your calendar entry is updated.`
        : why === "updated"
          ? `${nameOf(kind, r.seq)} (${when}) has new details. Your calendar entry is updated.`
          : kind === "deposit"
          ? `The deposit deadline is ${c.app.deposit_deadline ? fmtDay(dateKey(c.app.deposit_deadline)) : "set"}, so a deposit follow-up is set ${when} (${DEPOSIT_FOLLOW_UP_DAYS_BEFORE} days before it). Check with the partner that the deposit is on its way, then tick it done in the Application tab.`
          : kind === "visa"
            ? `${nameOf(kind, r.seq)} is set ${when}: chase the partner for the visa file${r.respond_within_days ? ` and a response within ${plural(r.respond_within_days, "day")}` : ""}. It repeats every week until the visa is uploaded or the outcome is recorded.`
            : `${nameOf(kind, r.seq)} with the university is set ${when}.`;
    const { emailedTo } = await notifyCounsellorFollowUp(c.ownerId, {
      type: "application.follow_up_scheduled",
      title: `${why === "moved" ? "Moved" : why === "updated" ? "Updated" : "Scheduled"}: ${nameOf(kind, r.seq)}, ${uni} (${c.studentName})`,
      lines,
      link: followUpLink(c.app.student_id, c.app.id, kind),
      tone: "blue",
      inApp: false,
      email: {
        subject: `${NOUN[kind]} ${why}: ${uni} (${fmtDay(due)})`,
        intro: `${intro} The calendar invite is attached.`,
      },
      calendar: (to) => ({ method: "REQUEST", ics: followUpIcs("REQUEST", r, c, lines, to) }),
    });
    await recordInvite(r, emailedTo, c, lines);
  } catch (e) {
    console.error("[follow-ups] invite failed:", e instanceof Error ? e.message : e);
  }
}

// ---- Panel (admin Application tab) -------------------------------------------

export async function followUpPanel(applicationId: number) {
  const a = await db.application.findUnique({ where: { id: applicationId }, select: appSelect });
  if (!a) throw notFound();
  const timezone = await tz();
  const today = dateInTimezone(new Date(), timezone);
  const rows = await db.application_follow_up.findMany({
    where: { application_id: applicationId },
    orderBy: [{ seq: "asc" }, { id: "asc" }],
    select: { ...rowSelect, completed_by_cp_user_id: true, closed_reason: true },
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
  const person = (id: number | null) => {
    const p = id ? people.find((x) => x.id === id) : null;
    return p ? fullName(p) : null;
  };
  const submitted = await submittedOn(a, timezone);
  const { weeks, isDefault } = decisionWeeks(a);
  const visaIn = await visaDocumentFor(a.id);
  const sections = FOLLOW_UP_KINDS.map((kind) => {
    const mine = rows.filter((r) => kindOf(r.kind) === kind);
    const active = isFollowUpKindStage(kind, a.status);
    const open = mine.some((r) => !r.completed_at && !r.closed_at);
    return {
      kind,
      label: FOLLOW_UP_KIND_LABEL[kind],
      active,
      // Deposit follow-ups come from the deadline; one can still be added by
      // hand (none open) once the automatic one is done.
      canSchedule: active && !open && !(kind === "visa" && visaIn),
      rows: mine.map((r) => ({
        id: r.id,
        kind,
        seq: r.seq,
        dueDate: dateKey(r.due_date),
        anchorDate: r.anchor_date ? dateKey(r.anchor_date) : null,
        respondWithinDays: r.respond_within_days,
        respondBy: r.respond_within_days ? addDays(dateKey(r.due_date), r.respond_within_days) : null,
        remarks: r.remarks,
        completedOn: r.completed_at ? dateInTimezone(r.completed_at, timezone) : null,
        completedBy: person(r.completed_by_cp_user_id),
        closedOn: r.closed_at ? dateInTimezone(r.closed_at, timezone) : null,
        closedReason: r.closed_reason,
        createdBy: person(r.created_by_cp_user_id),
        auto: kind === "deposit" ? !!r.anchor_date : r.created_by_cp_user_id === null,
      })),
    };
  }).filter((s) => s.active || s.rows.length > 0);
  return {
    active: sections.some((s) => s.active),
    stage: label(a.status),
    today,
    submittedOn: submitted,
    decisionWeeks: weeks,
    decisionWeeksIsDefault: isDefault,
    expectedBy: submitted ? addDays(submitted, weeks * 7) : null,
    depositDeadline: a.deposit_deadline ? dateKey(a.deposit_deadline) : null,
    visaUploaded: visaIn,
    sections,
  };
}

// ---- Changes -------------------------------------------------------------------

const STAGE_HINT: Record<FollowUpKind, string> = {
  decision: "University-decision follow-ups are only for applications at Application Submitted or Under Review.",
  deposit: "Deposit follow-ups are only for applications at Unconditional Offer.",
  visa: "Visa file follow-ups are only for applications at Deposit Paid or Visa Filed.",
};

async function requireKindStage(applicationId: number, kind: FollowUpKind) {
  const a = await db.application.findUnique({ where: { id: applicationId }, select: { status: true } });
  if (!a) throw notFound();
  if (!isFollowUpKindStage(kind, a.status)) throw fail(STAGE_HINT[kind]);
}

async function validDueDate(dueDate: string) {
  const today = await oooToday();
  if (dueDate < today) throw fail("Pick today or a later date.");
  if (daysBetween(today, dueDate) > MAX_FOLLOW_UP_DAYS_AHEAD) throw fail("Pick a date within a year.");
  return new Date(`${dueDate}T00:00:00Z`);
}

// The open follow-up with this id.
async function openFollowUp(followUpId: number) {
  const f = await db.application_follow_up.findUnique({ where: { id: followUpId }, select: rowSelect });
  if (!f) throw notFound();
  if (f.completed_at || f.closed_at) throw fail("This follow-up is already finished.");
  return f;
}

// Bell items about an application's follow-ups of one kind are done with
// once it is completed or closed.
async function clearReminders(applicationId: number, kind: FollowUpKind) {
  const a = await db.application.findUnique({ where: { id: applicationId }, select: { student_id: true } });
  if (!a) return;
  await db.cp_notification.updateMany({
    where: { type: { in: NOTIFICATION_TYPES }, link: followUpLink(a.student_id, applicationId, kind), read_at: null },
    data: { read_at: new Date() },
  });
}

async function nextSeq(applicationId: number, kind: FollowUpKind) {
  const last = await db.application_follow_up.findFirst({
    where: { application_id: applicationId, kind },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return (last?.seq ?? 0) + 1;
}

// Creates a follow-up with the next number of its kind. Two writers racing
// for the same number: the unique key stops the second, which retries once.
async function createFollowUp(data: {
  application_id: number;
  kind: FollowUpKind;
  due_date: Date;
  anchor_date?: Date | null;
  respond_within_days?: number | null;
  remarks?: string | null;
  created_by_cp_user_id: number | null;
}) {
  for (let attempt = 0; ; attempt++) {
    const seq = await nextSeq(data.application_id, data.kind);
    try {
      return await db.application_follow_up.create({ data: { ...data, seq }, select: rowSelect });
    } catch (e) {
      if (attempt === 0 && (e as { code?: string } | null)?.code === "P2002") continue;
      throw e;
    }
  }
}

// A document showing the visa is decided: a visa copy or a refusal letter
// for this application, not rejected by Collegepond.
const VISA_DONE_DOC_TYPES = ["visa", "visa_refusal"];
async function visaDocumentFor(applicationId: number): Promise<boolean> {
  const n = await db.document.count({
    where: {
      application_id: applicationId,
      doc_type: { in: VISA_DONE_DOC_TYPES },
      status: { not: DocumentStatus.REJECTED },
    },
  });
  return n > 0;
}

export async function scheduleFollowUp(
  actorCpUserId: number,
  applicationId: number,
  kind: FollowUpKind,
  dueDate: string,
  extra: { respondWithinDays?: number | null; remarks?: string | null } = {},
) {
  await requireKindStage(applicationId, kind);
  const due = await validDueDate(dueDate);
  if (kind === "visa") {
    if (!extra.respondWithinDays) throw fail("Enter how many days the partner has to respond.");
    if (await visaDocumentFor(applicationId)) throw fail("The visa is already uploaded for this application.");
  }
  const open = await db.application_follow_up.count({ where: { application_id: applicationId, kind, ...openWhere } });
  if (open > 0) throw fail("Complete the open follow-up first, or change its date.");
  const row = await createFollowUp({
    application_id: applicationId,
    kind,
    due_date: due,
    respond_within_days: kind === "visa" ? extra.respondWithinDays : null,
    remarks: cleanRemarks(extra.remarks),
    created_by_cp_user_id: actorCpUserId,
  });
  await db.audit_log.create({
    data: {
      action: "application.follow_up_scheduled",
      entity_type: "application",
      entity_id: applicationId,
      metadata: {
        followUpId: row.id,
        kind,
        seq: row.seq,
        dueDate,
        ...(kind === "visa" ? { respondWithinDays: extra.respondWithinDays, remarks: row.remarks } : {}),
        byCpUserId: actorCpUserId,
      },
    },
  });
  await sendInvite(row.id, "scheduled");
  return { id: row.id, kind, seq: row.seq };
}

// Change an open follow-up's date (and, for a visa one, the response days
// and remarks). Any change re-sends the calendar invite with a higher
// SEQUENCE; a new date is also a new reminder schedule.
export async function rescheduleFollowUp(
  actorCpUserId: number,
  followUpId: number,
  dueDate: string,
  extra: { respondWithinDays?: number | null; remarks?: string | null } = {},
) {
  const f = await openFollowUp(followUpId);
  const kind = kindOf(f.kind);
  await requireKindStage(f.application_id, kind);
  const due = await validDueDate(dueDate);
  const from = dateKey(f.due_date);
  const dateChanged = from !== dueDate;
  const data: Prisma.application_follow_upUpdateInput = {};
  if (dateChanged) {
    Object.assign(data, { due_date: due, due_notified_at: null, overdue_emailed_at: null, overdue_reminded_on: null });
  }
  if (kind === "visa") {
    if (extra.respondWithinDays !== undefined && extra.respondWithinDays !== f.respond_within_days) {
      if (!extra.respondWithinDays) throw fail("Enter how many days the partner has to respond.");
      data.respond_within_days = extra.respondWithinDays;
    }
    if (extra.remarks !== undefined && cleanRemarks(extra.remarks) !== f.remarks) {
      data.remarks = cleanRemarks(extra.remarks);
    }
  }
  if (Object.keys(data).length === 0) return { kind, seq: f.seq };
  data.ics_sequence = { increment: 1 };
  await db.application_follow_up.update({ where: { id: f.id }, data });
  if (dateChanged) await clearReminders(f.application_id, kind);
  await db.audit_log.create({
    data: {
      action: "application.follow_up_rescheduled",
      entity_type: "application",
      entity_id: f.application_id,
      metadata: {
        followUpId: f.id,
        kind,
        seq: f.seq,
        from,
        to: dueDate,
        ...("respond_within_days" in data ? { respondWithinDays: data.respond_within_days } : {}),
        ...("remarks" in data ? { remarks: data.remarks } : {}),
        byCpUserId: actorCpUserId,
      },
    },
  });
  await sendInvite(f.id, dateChanged ? "moved" : "updated");
  return { kind, seq: f.seq };
}

export async function completeFollowUp(actorCpUserId: number, followUpId: number) {
  const f = await openFollowUp(followUpId);
  const kind = kindOf(f.kind);
  // Conditional: a double click (or an auto-close racing it) completes once.
  const res = await db.application_follow_up.updateMany({
    where: { id: f.id, ...openWhere },
    data: { completed_at: new Date(), completed_by_cp_user_id: actorCpUserId },
  });
  if (res.count === 0) throw fail("This follow-up is already finished.");
  await clearReminders(f.application_id, kind);
  await db.audit_log.create({
    data: {
      action: "application.follow_up_completed",
      entity_type: "application",
      entity_id: f.application_id,
      metadata: { followUpId: f.id, kind, seq: f.seq, dueDate: dateKey(f.due_date), byCpUserId: actorCpUserId },
    },
  });
  const next = kind === "visa" ? await ensureNextVisaFollowUp(f, await oooToday()) : null;
  return { kind, seq: f.seq, next };
}

// Visa file follow-ups are weekly: once one is done or falls due, the next
// is set 7 days after it (7 days from today if that has passed too), with
// the same response days and remarks, unless a later one is open already or
// the visa is in. Returns the new one, or null.
async function ensureNextVisaFollowUp(
  f: Row,
  today: string,
): Promise<{ id: number; seq: number; dueDate: string } | null> {
  try {
    const a = await db.application.findUnique({ where: { id: f.application_id }, select: { status: true } });
    if (!a || !isFollowUpKindStage("visa", a.status)) return null;
    if (await visaDocumentFor(f.application_id)) return null;
    const later = await db.application_follow_up.count({
      where: { application_id: f.application_id, kind: "visa", ...openWhere, due_date: { gt: f.due_date } },
    });
    if (later > 0) return null;
    let due = addDays(dateKey(f.due_date), VISA_FOLLOW_UP_INTERVAL_DAYS);
    if (due <= today) due = addDays(today, VISA_FOLLOW_UP_INTERVAL_DAYS);
    const row = await createFollowUp({
      application_id: f.application_id,
      kind: "visa",
      due_date: new Date(`${due}T00:00:00Z`),
      respond_within_days: f.respond_within_days,
      remarks: f.remarks,
      created_by_cp_user_id: f.created_by_cp_user_id,
    });
    await db.audit_log.create({
      data: {
        action: "application.follow_up_scheduled",
        entity_type: "application",
        entity_id: f.application_id,
        metadata: { followUpId: row.id, kind: "visa", seq: row.seq, dueDate: due, weeklyAfter: f.id, via: "weekly" },
      },
    });
    return { id: row.id, seq: row.seq, dueDate: due };
  } catch (e) {
    console.error("[follow-ups] next visa follow-up failed:", e instanceof Error ? e.message : e);
    return null;
  }
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

// ---- Deposit: follows application.deposit_deadline --------------------------------

// Creates, moves or closes the application's automatic deposit follow-up to
// match its deposit deadline. Called when the deposit details are saved, when
// the application reaches Unconditional Offer, and by the daily run. Never
// throws: the deadline itself is saved.
export async function syncDepositFollowUp(applicationId: number, actorCpUserId: number | null): Promise<void> {
  try {
    const a = await db.application.findUnique({
      where: { id: applicationId },
      select: { status: true, deposit_deadline: true },
    });
    if (!a || !isFollowUpKindStage("deposit", a.status)) return;
    const auto = await db.application_follow_up.findMany({
      where: { application_id: applicationId, kind: "deposit", closed_at: null, anchor_date: { not: null } },
      select: rowSelect,
      orderBy: { seq: "desc" },
    });
    if (!a.deposit_deadline) {
      const open = auto.filter((r) => !r.completed_at);
      if (open.length) await closeRows(applicationId, "deposit", open, "Deposit deadline removed", actorCpUserId);
      return;
    }
    const deadline = dateKey(a.deposit_deadline);
    const today = await oooToday();
    // A date still being typed (year 0002 …) or absurdly far: leave it.
    if (deadline < "2000-01-01" || daysBetween(today, deadline) > 2 * 366) return;
    if (auto.some((r) => r.anchor_date && dateKey(r.anchor_date) === deadline)) return;
    let due = addDays(deadline, -DEPOSIT_FOLLOW_UP_DAYS_BEFORE);
    if (due < today) due = today;
    const dueDate = new Date(`${due}T00:00:00Z`);
    const anchor = new Date(`${deadline}T00:00:00Z`);
    const open = await db.application_follow_up.findFirst({
      where: { application_id: applicationId, kind: "deposit", ...openWhere },
      orderBy: { seq: "desc" },
      select: rowSelect,
    });
    if (open) {
      const from = dateKey(open.due_date);
      await db.application_follow_up.update({
        where: { id: open.id },
        data: {
          due_date: dueDate,
          anchor_date: anchor,
          ...(from !== due
            ? { due_notified_at: null, overdue_emailed_at: null, overdue_reminded_on: null, ics_sequence: { increment: 1 } }
            : {}),
        },
      });
      if (from !== due) await clearReminders(applicationId, "deposit");
      await db.audit_log.create({
        data: {
          action: "application.follow_up_rescheduled",
          entity_type: "application",
          entity_id: applicationId,
          metadata: {
            followUpId: open.id,
            kind: "deposit",
            seq: open.seq,
            from,
            to: due,
            depositDeadline: deadline,
            ...(actorCpUserId ? { byCpUserId: actorCpUserId } : { via: "follow-up run" }),
          },
        },
      });
      if (from !== due) await sendInvite(open.id, "moved");
      return;
    }
    const row = await createFollowUp({
      application_id: applicationId,
      kind: "deposit",
      due_date: dueDate,
      anchor_date: anchor,
      created_by_cp_user_id: actorCpUserId,
    });
    await db.audit_log.create({
      data: {
        action: "application.follow_up_scheduled",
        entity_type: "application",
        entity_id: applicationId,
        metadata: {
          followUpId: row.id,
          kind: "deposit",
          seq: row.seq,
          dueDate: due,
          depositDeadline: deadline,
          ...(actorCpUserId ? { byCpUserId: actorCpUserId } : { via: "follow-up run" }),
        },
      },
    });
    await sendInvite(row.id, "scheduled");
  } catch (e) {
    console.error("[follow-ups] deposit sync failed:", e instanceof Error ? e.message : e);
  }
}

// ---- Auto-close ---------------------------------------------------------------

// Why a kind's open follow-ups end when the application moves to `status`.
function closeReason(kind: FollowUpKind, status: number): { reason: string; depositPaid: boolean } {
  if (kind === "deposit" && stageAtLeast(status, UniApplicationStatus.DEPOSIT_PAID)) {
    return { reason: "Deposit paid", depositPaid: true };
  }
  if (kind === "visa") {
    if (status === UniApplicationStatus.VISA_SECURED || status === UniApplicationStatus.ENROLLED) {
      return { reason: "Visa approved", depositPaid: false };
    }
    if (status === UniApplicationStatus.VISA_REJECTED) return { reason: "Visa rejected", depositPaid: false };
  }
  return { reason: `Moved to ${label(status)}`, depositPaid: false };
}

// Closes these open follow-ups of one kind, then tells the owner when it
// matters: always for a paid deposit; otherwise when a calendar event is
// still ahead (always for deposit and visa, whose invites go out at once).
// Never throws.
async function closeRows(
  applicationId: number,
  kind: FollowUpKind,
  rows: Row[],
  reason: string,
  actorCpUserId: number | null,
  opts: { depositPaid?: boolean } = {},
): Promise<number> {
  try {
    if (rows.length === 0) return 0;
    const res = await db.application_follow_up.updateMany({
      where: { id: { in: rows.map((f) => f.id) }, ...openWhere },
      data: { closed_at: new Date(), closed_reason: reason.slice(0, 100) },
    });
    if (res.count === 0) return 0;
    await clearReminders(applicationId, kind);
    await db.audit_log.create({
      data: {
        action: "application.follow_ups_auto_closed",
        entity_type: "application",
        entity_id: applicationId,
        metadata: {
          kind,
          followUpIds: rows.map((f) => f.id),
          seqs: rows.map((f) => f.seq),
          reason,
          ...(actorCpUserId ? { byCpUserId: actorCpUserId } : { via: "follow-up run" }),
        },
      },
    });
    await tellClosed(applicationId, kind, rows, reason, !!opts.depositPaid);
    return res.count;
  } catch (e) {
    console.error("[follow-ups] auto-close failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

async function tellClosed(applicationId: number, kind: FollowUpKind, rows: Row[], reason: string, depositPaid: boolean) {
  // The latest one carries the event that is still ahead.
  const latest = [...rows].sort((x, y) => y.due_date.getTime() - x.due_date.getTime())[0]!;
  const c = await loadCtx(applicationId, latest.created_by_cp_user_id);
  if (!c) return;
  const invited = !!latest.ics_sent_to;
  const ahead = dateKey(latest.due_date) >= c.today;
  const email = depositPaid || (invited && (kind !== "decision" || ahead));
  if (!email) return;
  const uni = c.app.course.university.name;
  const lines = await messageLines(latest, c);
  lines.splice(lines.length - 1, 1, `${nameOf(kind, latest.seq)}: closed (${reason})`);
  const cancel = invited && ahead;
  const intro = depositPaid
    ? `The application moved to Deposit Paid, so the open deposit follow-up was closed automatically. Nothing more to do for it.`
    : kind === "visa"
      ? `${reason}, so the weekly visa file follow-ups have stopped.`
      : `${nameOf(kind, latest.seq)} was closed automatically: ${reason}.`;
  let emailedTo: string | null = null;
  if (c.ownerId) {
    ({ emailedTo } = await notifyCounsellorFollowUp(c.ownerId, {
      type: "application.follow_up_closed",
      title: depositPaid
        ? `Deposit paid: deposit follow-up closed, ${uni} (${c.studentName})`
        : `${NOUN[kind]} closed: ${uni} (${c.studentName})`,
      lines,
      link: followUpLink(c.app.student_id, c.app.id, kind),
      tone: depositPaid ? "green" : "gray",
      inApp: kind !== "decision",
      email: {
        subject: depositPaid ? `Deposit paid: follow-up closed for ${uni}` : `${NOUN[kind]} closed: ${uni}`,
        intro: cancel
          ? `${intro} The calendar entry for ${nameOf(kind, latest.seq).toLowerCase()} (${fmtDay(dateKey(latest.due_date))}) is cancelled.`
          : intro,
      },
      calendar: cancel
        ? (to) => ({
            method: "CANCEL",
            ics: followUpIcs("CANCEL", latest, c, lines, to, latest.ics_sequence + 1),
          })
        : null,
    }));
  }
  if (cancel && latest.ics_sent_to && emailedTo?.toLowerCase() !== latest.ics_sent_to.toLowerCase()) {
    await sendCancelOnly(latest, c, lines, latest.ics_sent_to);
  }
  if (invited) {
    await db.application_follow_up.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { ics_sent_to: null },
    });
  }
}

// The application moved to `newStatus`: open follow-ups of every kind whose
// stages it left are closed, and reaching Unconditional Offer with a deposit
// deadline already set creates the deposit follow-up. Called by
// transitionApplication (actor = who moved it) and by the daily run as a
// safety net (actor null). Never throws: the stage change is saved.
export async function closeOpenFollowUps(
  applicationId: number,
  newStatus: number,
  actorCpUserId: number | null,
): Promise<number> {
  let closed = 0;
  try {
    const open = await db.application_follow_up.findMany({
      where: { application_id: applicationId, ...openWhere },
      select: rowSelect,
    });
    for (const kind of FOLLOW_UP_KINDS) {
      if (isFollowUpKindStage(kind, newStatus)) continue;
      const rows = open.filter((r) => kindOf(r.kind) === kind);
      if (rows.length === 0) continue;
      const { reason, depositPaid } = closeReason(kind, newStatus);
      closed += await closeRows(applicationId, kind, rows, reason, actorCpUserId, { depositPaid });
    }
  } catch (e) {
    console.error("[follow-ups] auto-close failed:", e instanceof Error ? e.message : e);
  }
  if (isFollowUpKindStage("deposit", newStatus)) await syncDepositFollowUp(applicationId, actorCpUserId);
  return closed;
}

// A visa copy or refusal letter was uploaded: the student's open visa file
// follow-ups end (that application's, or every one of the student's when the
// file isn't tied to an application). Never throws.
export async function closeVisaFollowUpsForDocument(
  studentId: number,
  docType: string,
  applicationId: number | null,
): Promise<void> {
  if (!VISA_DONE_DOC_TYPES.includes(docType)) return;
  try {
    const open = await db.application_follow_up.findMany({
      where: {
        kind: "visa",
        ...openWhere,
        ...(applicationId ? { application_id: applicationId } : { application: { student_id: studentId } }),
      },
      select: rowSelect,
    });
    const reason = docType === "visa" ? "Visa uploaded" : "Visa refusal uploaded";
    for (const appId of new Set(open.map((r) => r.application_id))) {
      await closeRows(
        appId,
        "visa",
        open.filter((r) => r.application_id === appId),
        reason,
        null,
      );
    }
  } catch (e) {
    console.error("[follow-ups] visa document close failed:", e instanceof Error ? e.message : e);
  }
}

// ---- Overdue list (TAT Management) --------------------------------------------

export async function overdueFollowUps(user: StaffUser) {
  const today = await oooToday();
  const rows = await db.application_follow_up.findMany({
    where: {
      ...openWhere,
      due_date: { lt: new Date(`${today}T00:00:00Z`) },
      OR: FOLLOW_UP_KINDS.map((kind) => ({ kind, application: { status: { in: FOLLOW_UP_KIND_STAGES[kind] } } })),
      application: await staffApplicationScope(user),
    },
    orderBy: [{ due_date: "asc" }, { id: "asc" }],
    take: 500,
    select: {
      id: true,
      kind: true,
      seq: true,
      due_date: true,
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
      const kind = kindOf(r.kind);
      return {
        id: r.id,
        kind,
        kindLabel: FOLLOW_UP_KIND_LABEL[kind],
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
        link: followUpLink(s.id, r.application.id, kind),
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
  closed: number; // open follow-ups on applications that had moved on (or whose visa is in)
  created: number; // deposit follow-ups for a deadline, and next weekly visa follow-ups
  invites: number; // calendar invites (re)sent that hadn't gone out
  noRecipient: number; // claimed, but the student has no active counsellor
};

const DUE_INTRO: Record<FollowUpKind, (r: Row, c: Ctx) => string> = {
  decision: (r) =>
    `Follow-up ${r.seq} with the university is due today. Check on the decision, then tick it done in the Application tab and schedule the next one if needed.`,
  deposit: (_r, c) =>
    `The deposit deadline is ${c.app.deposit_deadline ? fmtDay(dateKey(c.app.deposit_deadline)) : "coming up"}. Follow up with the partner on the deposit today, then tick this done in the Application tab.`,
  visa: (r) =>
    `Chase the partner for the visa file today${r.respond_within_days ? ` (they should respond within ${plural(r.respond_within_days, "day")})` : ""}, then tick it done in the Application tab.`,
};

const OVERDUE_INTRO: Record<FollowUpKind, (r: Row, c: Ctx, due: string) => string> = {
  decision: (r, _c, due) =>
    `Follow-up ${r.seq} with the university was due on ${fmtDay(due)} and hasn't been marked done. Follow up, then tick it done in the Application tab, or change its date.`,
  deposit: (r, c, due) =>
    `Deposit follow-up ${r.seq} was due on ${fmtDay(due)} and hasn't been marked done${c.app.deposit_deadline ? ` (deposit deadline ${fmtDay(dateKey(c.app.deposit_deadline))})` : ""}. It stays on the overdue list until it's ticked done in the Application tab.`,
  visa: (r, _c, due) =>
    `Visa file follow-up ${r.seq} was due on ${fmtDay(due)} and hasn't been marked done. Chase the partner, then tick it done in the Application tab.`,
};

// Sends today's follow-up reminders. Safe to run any number of times a day.
export async function runFollowUpReminders(now = new Date()): Promise<FollowUpRunResult> {
  const timezone = await tz();
  const today = dateInTimezone(now, timezone);
  const todayDate = new Date(`${today}T00:00:00Z`);
  const result: FollowUpRunResult = {
    today,
    due: 0,
    overdueFirst: 0,
    overdueDaily: 0,
    closed: 0,
    created: 0,
    invites: 0,
    noRecipient: 0,
  };

  // Safety net: open follow-ups on applications that left their kind's
  // stages (every stage change goes through transitionApplication, which
  // closes them; this catches anything that didn't).
  const openRows = await db.application_follow_up.findMany({
    where: openWhere,
    select: { application_id: true, kind: true, application: { select: { status: true } } },
  });
  const staleApps = new Map<number, number>();
  for (const r of openRows) {
    if (!isFollowUpKindStage(kindOf(r.kind), r.application.status)) staleApps.set(r.application_id, r.application.status);
  }
  for (const [id, status] of staleApps) result.closed += await closeOpenFollowUps(id, status, null);

  // Visa follow-ups whose visa (or refusal) is already uploaded.
  const visaOpen = await db.application_follow_up.findMany({
    where: { kind: "visa", ...openWhere },
    select: { application_id: true },
  });
  for (const appId of new Set(visaOpen.map((r) => r.application_id))) {
    if (!(await visaDocumentFor(appId))) continue;
    const rows = await db.application_follow_up.findMany({
      where: { application_id: appId, kind: "visa", ...openWhere },
      select: rowSelect,
    });
    const docType = await db.document.findFirst({
      where: { application_id: appId, doc_type: { in: VISA_DONE_DOC_TYPES }, status: { not: DocumentStatus.REJECTED } },
      orderBy: { id: "desc" },
      select: { doc_type: true },
    });
    result.closed += await closeRows(
      appId,
      "visa",
      rows,
      docType?.doc_type === "visa_refusal" ? "Visa refusal uploaded" : "Visa uploaded",
      null,
    );
  }

  // Deposit follow-ups for deadlines that don't have one yet.
  const depositApps = await db.application.findMany({
    where: { status: { in: FOLLOW_UP_KIND_STAGES.deposit }, deposit_deadline: { not: null } },
    select: { id: true },
  });
  for (const a of depositApps) {
    const before = await db.application_follow_up.count({ where: { application_id: a.id, kind: "deposit" } });
    await syncDepositFollowUp(a.id, null);
    const after = await db.application_follow_up.count({ where: { application_id: a.id, kind: "deposit" } });
    result.created += after - before;
  }

  const rows = (
    await db.application_follow_up.findMany({
      where: { ...openWhere, due_date: { lte: todayDate } },
      orderBy: { id: "asc" },
      select: {
        ...rowSelect,
        due_notified_at: true,
        overdue_emailed_at: true,
        overdue_reminded_on: true,
        application: { select: { status: true } },
      },
    })
  ).filter((f) => isFollowUpKindStage(kindOf(f.kind), f.application.status));

  for (const f of rows) {
    const fk = kindOf(f.kind);
    const due = dateKey(f.due_date);
    const overdueDays = daysBetween(due, today);

    // Weekly visa file: the next one is set once this one falls due.
    let next: { id: number; seq: number; dueDate: string } | null = null;
    if (fk === "visa") {
      next = await ensureNextVisaFollowUp(f, today);
      if (next) result.created++;
    }

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

    const c = await loadCtx(f.application_id, f.created_by_cp_user_id);
    if (!c) continue;
    const uni = c.app.course.university.name;
    const lines = await messageLines(f, c, overdueDays);
    const link = followUpLink(c.app.student_id, c.app.id, fk);
    const noun = nameOf(fk, f.seq);

    // The next weekly visa follow-up's invite rides on today's email.
    let nextRow: Row | null = null;
    if (next && kind !== "overdueDaily") {
      nextRow = await db.application_follow_up.findUnique({ where: { id: next.id }, select: rowSelect });
      if (nextRow && !(await claimInvite(nextRow))) nextRow = null;
    }
    const nextLines = nextRow ? await messageLines(nextRow, c) : [];
    const nextNote = nextRow
      ? ` The next weekly follow-up is set for ${fmtDay(dateKey(nextRow.due_date))}: its calendar invite is attached.`
      : "";
    const calendar = nextRow
      ? (to: { name: string; email: string }) => ({
          method: "REQUEST" as const,
          ics: followUpIcs("REQUEST", nextRow, c, nextLines, to),
        })
      : null;

    // The overdue item replaces yesterday's "due" one.
    if (kind === "overdueFirst") {
      await db.cp_notification.updateMany({
        where: { type: "application.follow_up_due", link, read_at: null },
        data: { read_at: now },
      });
    }
    const sent = c.ownerId
      ? await notifyCounsellorFollowUp(
          c.ownerId,
          kind === "due"
            ? {
                type: "application.follow_up_due",
                title: `${noun} due: ${uni} (${c.studentName})`,
                lines,
                link,
                tone: "orange",
                email: { subject: `${NOUN[fk]} due: ${uni}`, intro: DUE_INTRO[fk](f, c) + nextNote },
                calendar,
              }
            : {
                type: "application.follow_up_overdue",
                title: `${noun} overdue ${plural(overdueDays, "day")}: ${uni} (${c.studentName})`,
                lines,
                link,
                tone: "red",
                rolling: kind === "overdueDaily",
                email:
                  kind === "overdueFirst"
                    ? { subject: `${NOUN[fk]} overdue: ${uni}`, intro: OVERDUE_INTRO[fk](f, c, due) + nextNote }
                    : null,
                calendar: kind === "overdueFirst" ? calendar : null,
              },
        )
      : { notified: false, emailedTo: null };
    if (nextRow) await recordInvite(nextRow, sent.emailedTo, c, nextLines);
    if (sent.notified) result[kind]++;
    else result.noRecipient++;
  }

  // Invites that haven't gone out (an email failed, or a change the run
  // made): today's or later open follow-ups only.
  const pending = await db.application_follow_up.findMany({
    where: { ...openWhere, due_date: { gte: todayDate } },
    select: { id: true, kind: true, ics_sequence: true, ics_sent_sequence: true, application: { select: { status: true } } },
  });
  for (const p of pending) {
    if (!isFollowUpKindStage(kindOf(p.kind), p.application.status)) continue;
    if (p.ics_sent_sequence !== null && p.ics_sent_sequence >= p.ics_sequence) continue;
    await sendInvite(p.id, p.ics_sent_sequence === null ? "scheduled" : "moved");
    const after = await db.application_follow_up.findUnique({ where: { id: p.id }, select: { ics_sent_sequence: true } });
    if (after?.ics_sent_sequence === p.ics_sequence) result.invites++;
  }
  return result;
}
