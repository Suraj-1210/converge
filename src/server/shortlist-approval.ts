import "server-only";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import {
  AdminRole,
  ShortlistApproval,
  ShortlistSource,
} from "~/server/db/enums";
import {
  appUrl,
  sendEmail,
  shortlistDecisionEmail,
  shortlistProposedEmail,
} from "~/server/email";
import {
  emailPartners,
  studentPartnerRecipients,
} from "~/server/email/partners";
import { createNotifications } from "~/server/notify";
import { studentPartner } from "~/server/staff-access";
import { notificationPrefCode } from "~/lib/constants/notification-prefs";

// University assignment approval (Phase 3B, decided with Suraj 17 Oct 2026).
// A shortlist row is one side's proposal (added_by) that the other side
// approves or rejects (approval_status):
//   - Collegepond proposes → the partner approves/rejects from their portal
//     (agency owner, the assigned agency counsellor, or the independent);
//   - a partner proposes → Collegepond's counsellor approves/rejects.
//   - Apply (creating the application) is refused until approved.
//   - A rejected row stays visible with its reason; the proposing side can
//     re-propose it (back to pending, optional note) or remove it.
//   - No timeout and no reminders.
// The other side hears about every proposal and decision: partners in-app
// and by email (preference "app.shortlist"); Collegepond by email (the
// student's counsellor → the partner's Counsellor Lead → every Lead, as for
// partner profile edits) and through the admin bell.
//
// Every function here runs after the change is saved, so failures are logged
// and never thrown back at the caller.

const fullName = (u: { first_name: string; last_name: string }) =>
  `${u.first_name} ${u.last_name}`.trim();

const LOG = "[shortlist]";

function logError(context: string, e: unknown) {
  console.error(`${LOG} ${context} failed:`, e instanceof Error ? e.message : e);
}

// A student with nobody on the partner side (no agency and no independent
// who created them) has nobody to approve a Collegepond proposal, so it is
// approved on creation.
export function hasPartnerSide(s: {
  org_id: number | null;
  created_by_user_id: number | null;
}): boolean {
  return s.org_id !== null || s.created_by_user_id !== null;
}

// ---- Partner side -----------------------------------------------------------

// Partner users who switched the in-app "app.shortlist" toggle off.
async function inAppOptedOut(userIds: number[]): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const rows = await db.notification_preference.findMany({
    where: {
      user_id: { in: userIds },
      notification_type: notificationPrefCode("app.shortlist"),
      via_in_app: 0,
    },
    select: { user_id: true },
  });
  return new Set(rows.map((r) => r.user_id));
}

async function notifyPartnerSide(
  studentId: number,
  inApp: { title: string; body: string; tone: "blue" | "green" | "red" | "orange" },
  email: Parameters<typeof shortlistProposedEmail>[1] | Parameters<typeof shortlistDecisionEmail>[1],
  context: string,
) {
  const recipients = await studentPartnerRecipients(studentId);
  if (recipients.length === 0) return;
  const link = `/partner/students/${studentId}?tab=applications`;
  try {
    const skip = await inAppOptedOut(recipients.map((r) => r.id));
    await createNotifications(
      recipients.filter((r) => !skip.has(r.id)).map((r) => r.id),
      { type: "student.shortlist", title: inApp.title, body: inApp.body, link, tone: inApp.tone },
    );
  } catch (e) {
    logError(`${context} in-app`, e);
  }
  await emailPartners(
    recipients,
    (r) =>
      "approved" in email
        ? shortlistDecisionEmail({ name: r.name }, email, appUrl())
        : shortlistProposedEmail({ name: r.name }, email, appUrl()),
    context,
    "app.shortlist",
  );
}

async function courseLabels(courseIds: number[]) {
  const courses = await db.course.findMany({
    where: { id: { in: courseIds } },
    select: { id: true, name: true, university: { select: { name: true } } },
  });
  const byId = new Map(courses.map((c) => [c.id, c]));
  return courseIds
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => ({ university: c.university.name, program: c.name }));
}

async function studentName(studentId: number): Promise<string | null> {
  const s = await db.student.findUnique({
    where: { id: studentId },
    select: { first_name: true, last_name: true },
  });
  return s ? fullName(s) : null;
}

// Collegepond proposed (or re-proposed) programs for a student: ask the
// partner side to approve. Partners see "Collegepond", never a staff name.
export async function notifyPartnerOfProposal(args: {
  studentId: number;
  courseIds: number[];
  note?: string | null;
  reproposed?: boolean;
}): Promise<void> {
  try {
    if (args.courseIds.length === 0) return;
    const [name, programs] = await Promise.all([
      studentName(args.studentId),
      courseLabels(args.courseIds),
    ]);
    if (!name || programs.length === 0) return;
    const one = programs.length === 1 ? programs[0]! : null;
    await notifyPartnerSide(
      args.studentId,
      {
        title: one
          ? `Approve ${one.university} for ${name}?`
          : `Approve ${programs.length} universities for ${name}?`,
        body: `Collegepond ${args.reproposed ? "re-proposed" : "proposed"} ${
          one ? `${one.university} – ${one.program}` : programs.map((p) => p.university).join(", ")
        }. Approve or reject from the student's Applications tab.`,
        tone: "orange",
      },
      {
        toStaff: false,
        studentName: name,
        studentId: args.studentId,
        proposedBy: "Collegepond",
        programs,
        note: args.note,
        reproposed: args.reproposed,
      },
      `shortlist proposal for student ${args.studentId}`,
    );
  } catch (e) {
    logError("partner proposal notification", e);
  }
}

// Collegepond approved or rejected a partner's proposal.
export async function notifyPartnerOfDecision(args: {
  studentId: number;
  courseId: number;
  approved: boolean;
  reason?: string | null;
}): Promise<void> {
  try {
    const [name, [program]] = await Promise.all([
      studentName(args.studentId),
      courseLabels([args.courseId]),
    ]);
    if (!name || !program) return;
    await notifyPartnerSide(
      args.studentId,
      {
        title: `${program.university} ${args.approved ? "approved" : "rejected"} for ${name}`,
        body: args.approved
          ? `Collegepond approved your shortlist pick (${program.program}).`
          : `Collegepond rejected your shortlist pick (${program.program})${
              args.reason ? `: ${args.reason}` : "."
            }`,
        tone: args.approved ? "green" : "red",
      },
      {
        toStaff: false,
        studentName: name,
        studentId: args.studentId,
        university: program.university,
        program: program.program,
        approved: args.approved,
        decidedBy: "Collegepond",
        reason: args.reason,
      },
      `shortlist decision for student ${args.studentId}`,
    );
  } catch (e) {
    logError("partner decision notification", e);
  }
}

// ---- Collegepond side -------------------------------------------------------

// The student's Collegepond counsellor; with none (or inactive), the
// partner's Counsellor Lead; with no active lead, every Lead (same routing
// as partner profile edits, src/server/student-changes.ts). `alsoCpUserId`
// (the staff member who proposed it) is added when active.
async function counsellingRecipients(studentId: number, alsoCpUserId?: number | null) {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      org_id: true,
      created_by_user_id: true,
      cp_counsellor: {
        select: { id: true, email: true, first_name: true, last_name: true, status: true },
      },
    },
  });
  if (!student) return [];
  const pick = { id: true, email: true, first_name: true, last_name: true } as const;
  const cp = student.cp_counsellor?.status === 1 ? student.cp_counsellor : null;
  let list: { id: number; email: string; first_name: string; last_name: string }[];
  if (cp) {
    list = [cp];
  } else {
    const leadId = (await studentPartner(student))?.lead_counsellor_id ?? null;
    const lead = leadId
      ? await db.collegepond_user.findFirst({ where: { id: leadId, status: 1 }, select: pick })
      : null;
    list = lead
      ? [lead]
      : await db.collegepond_user.findMany({
          where: { role: AdminRole.COUNSELLOR_LEAD, status: 1 },
          select: pick,
        });
  }
  if (alsoCpUserId && !list.some((r) => r.id === alsoCpUserId)) {
    const extra = await db.collegepond_user.findFirst({
      where: { id: alsoCpUserId, status: 1 },
      select: pick,
    });
    if (extra) list.push(extra);
  }
  return list;
}

async function emailCounselling(
  studentId: number,
  alsoCpUserId: number | null,
  build: (r: { name: string }) => ReturnType<typeof shortlistProposedEmail>,
  context: string,
) {
  const recipients = await counsellingRecipients(studentId, alsoCpUserId);
  if (recipients.length === 0) {
    console.log(`${LOG} ${context}: no Collegepond counsellor or lead to email`);
    return;
  }
  for (const r of recipients) {
    try {
      await sendEmail(r.email, build({ name: fullName(r) }));
    } catch (e) {
      logError(context, e);
    }
  }
}

async function partnerLabel(partnerUserId: number): Promise<string> {
  const u = await db.user.findUnique({
    where: { id: partnerUserId },
    select: { first_name: true, last_name: true, organization: { select: { name: true } } },
  });
  if (!u) return "A partner";
  return u.organization ? `${fullName(u)} (${u.organization.name})` : fullName(u);
}

// A partner proposed (or re-proposed) a program: Collegepond reviews it.
export async function notifyCollegepondOfProposal(args: {
  studentId: number;
  courseId: number;
  partnerUserId: number;
  note?: string | null;
  reproposed?: boolean;
}): Promise<void> {
  try {
    const [name, programs, by] = await Promise.all([
      studentName(args.studentId),
      courseLabels([args.courseId]),
      partnerLabel(args.partnerUserId),
    ]);
    if (!name || programs.length === 0) return;
    await emailCounselling(
      args.studentId,
      null,
      (r) =>
        shortlistProposedEmail(
          r,
          {
            toStaff: true,
            studentName: name,
            studentId: args.studentId,
            proposedBy: by,
            programs,
            note: args.note,
            reproposed: args.reproposed,
          },
          appUrl(),
        ),
      `partner proposal email for student ${args.studentId}`,
    );
  } catch (e) {
    logError("Collegepond proposal notification", e);
  }
}

// The partner approved or rejected Collegepond's proposal. The staff member
// who proposed it is told as well as the student's counsellor.
export async function notifyCollegepondOfDecision(args: {
  studentId: number;
  courseId: number;
  partnerUserId: number;
  proposerCpUserId: number | null;
  approved: boolean;
  reason?: string | null;
}): Promise<void> {
  try {
    const [name, [program], by] = await Promise.all([
      studentName(args.studentId),
      courseLabels([args.courseId]),
      partnerLabel(args.partnerUserId),
    ]);
    if (!name || !program) return;
    await emailCounselling(
      args.studentId,
      args.proposerCpUserId,
      (r) =>
        shortlistDecisionEmail(
          r,
          {
            toStaff: true,
            studentName: name,
            studentId: args.studentId,
            university: program.university,
            program: program.program,
            approved: args.approved,
            decidedBy: by,
            reason: args.reason,
          },
          appUrl(),
        ),
      `partner decision email for student ${args.studentId}`,
    );
  } catch (e) {
    logError("Collegepond decision notification", e);
  }
}

// ---- Admin bell -------------------------------------------------------------

// Work waiting on Collegepond, within the admin Students list's visibility:
// partner proposals to review, and Collegepond proposals the partner
// rejected (until re-proposed or removed). Derived from current state, like
// the rest of the bell.
export async function shortlistBellItems(studentScope: Prisma.studentWhereInput) {
  const [toReview, rejected] = await Promise.all([
    db.shortlist.findMany({
      where: {
        added_by: ShortlistSource.PARTNER,
        approval_status: ShortlistApproval.PENDING,
        student: studentScope,
      },
      select: { student_id: true },
    }),
    db.shortlist.findMany({
      where: {
        added_by: ShortlistSource.COLLEGEPOND,
        approval_status: ShortlistApproval.REJECTED,
        student: studentScope,
      },
      select: { student_id: true },
    }),
  ]);
  const unis = (n: number) => `${n} ${n === 1 ? "university" : "universities"}`;
  const href = (rows: { student_id: number }[]) => {
    const ids = [...new Set(rows.map((r) => r.student_id))];
    return ids.length === 1 ? `/admin/students/${ids[0]!}?tab=application` : "/admin/students";
  };
  const items: {
    id: string;
    title: string;
    time: string;
    tone: "orange" | "red";
    unread: boolean;
    href: string;
  }[] = [];
  if (toReview.length > 0) {
    items.push({
      id: "shortlist-proposals",
      title: `Shortlist: ${unis(toReview.length)} proposed by partners awaiting approval`,
      time: "Needs review",
      tone: "orange",
      unread: true,
      href: href(toReview),
    });
  }
  if (rejected.length > 0) {
    items.push({
      id: "shortlist-rejections",
      title: `Shortlist: ${unis(rejected.length)} rejected by partners`,
      time: "Needs action",
      tone: "red",
      unread: true,
      href: href(rejected),
    });
  }
  return items;
}
