import "server-only";
import { db } from "~/server/db";
import { AdminRoleLabel, isAdminRole } from "~/server/db/enums";
import { currentImpersonation } from "~/server/auth/impersonation-context";
import { appUrl, counsellorFollowUpEmail, counsellorStudentUpdateEmail, sendEmail } from "~/server/email";
import { dateInTimezone, oooToday, responderFor } from "~/server/out-of-office";
import { createStaffNotifications, upsertStaffNotification } from "~/server/staff-notify";
import { getTatConfig } from "~/server/tat";

// Telling a student's Collegepond counsellor about things that happen to
// their student that they didn't do themselves (decided by Suraj via B2B,
// 24 Oct 2026):
//   - an application stage change or deferral by someone else (a lead, a
//     Super Admin, or a confirmed partner report);
//   - a new assignment, manual or automatic (the new and the previous
//     counsellor);
//   - a colleague acting on their student (shortlist, apply, inactive /
//     reactivate, pending-doc tick, deposit details, admin uploads, a chat
//     reply). Low-noise: one rolling item per student, per colleague, per
//     day, and one email for it;
//   - a partner reporting Deposit Paid / visa / deferral / closure.
// Each goes in-app (cp_notification) and by email to whoever answers for the
// counsellor today: the counsellor, or their alternate while they're out of
// office (who is told they're covering). An absent counsellor still gets the
// in-app item, without email, so their history is complete when they're
// back. No staff preference yet: always on.
//
// "Themselves" is the real person: a Counselling Lead or Super Admin viewing
// as the counsellor is a colleague, not the counsellor. Never throws:
// everything here runs after the change is saved.

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();
const studentLink = (studentId: number) => `/admin/students/${studentId}`;
type Tone = "blue" | "green" | "orange" | "red" | "gray";

// The real staff member behind an action (undoes impersonation / view-as).
export function realActorId(effectiveCpUserId: number | null | undefined): number | null {
  return currentImpersonation()?.realCpUserId ?? effectiveCpUserId ?? null;
}

async function staffName(cpUserId: number | null): Promise<string> {
  if (cpUserId === null) return "Someone at Collegepond";
  const u = await db.collegepond_user.findUnique({
    where: { id: cpUserId },
    select: { first_name: true, last_name: true, role: true },
  });
  if (!u) return "A colleague";
  return isAdminRole(u.role) ? `${fullName(u)} (${AdminRoleLabel[u.role]})` : fullName(u);
}

type Person = { id: number; first_name: string; last_name: string; email: string; status: number };
const personSelect = { id: true, first_name: true, last_name: true, email: true, status: true } as const;

// Who hears about a counsellor's student today, or nothing if the actor is
// the counsellor (or the alternate covering them) themselves.
async function recipientsFor(counsellorId: number, actorId: number | null) {
  const responderId = await responderFor(counsellorId);
  if (actorId !== null && (actorId === counsellorId || actorId === responderId)) return null;
  const people = await db.collegepond_user.findMany({
    where: { id: { in: [...new Set([counsellorId, responderId])] }, status: 1 },
    select: personSelect,
  });
  const counsellor = people.find((p) => p.id === counsellorId) ?? null;
  const responder = people.find((p) => p.id === responderId) ?? counsellor;
  if (!responder) return null;
  return { counsellor, responder, covering: counsellor && responder.id !== counsellor.id ? counsellor : null };
}

async function deliver(
  r: { counsellor: Person | null; responder: Person; covering: Person | null },
  n: { type: string; title: string; lines: string[]; link: string; tone: Tone; email: boolean; subject: string },
) {
  const body = n.lines.join(" · ").slice(0, 500);
  await createStaffNotifications([r.responder.id], {
    type: n.type,
    title: n.title,
    body: r.covering ? `${body} · covering for ${fullName(r.covering)}`.slice(0, 500) : body,
    link: n.link,
    tone: n.tone,
  });
  if (r.covering) {
    await createStaffNotifications([r.covering.id], { type: n.type, title: n.title, body, link: n.link, tone: n.tone });
  }
  if (n.email) {
    try {
      await sendEmail(
        r.responder.email,
        counsellorStudentUpdateEmail(
          { name: fullName(r.responder) },
          {
            subject: n.subject,
            heading: n.title,
            lines: n.lines,
            link: n.link,
            coveringFor: r.covering ? fullName(r.covering) : null,
          },
          appUrl(),
        ),
      );
    } catch (e) {
      console.error("[counsellor-notify] email failed:", e instanceof Error ? e.message : e);
    }
  }
}

async function studentRow(studentId: number) {
  return db.student.findUnique({
    where: { id: studentId },
    select: { id: true, first_name: true, last_name: true, cp_counsellor_id: true },
  });
}

// ---- Discrete events --------------------------------------------------------

// One event about one student, for its counsellor (skipped when the actor is
// the counsellor). actorCpUserId: the effective staff user (ctx.cpUser.id);
// null when a partner caused it.
export async function notifyStudentCounsellor(args: {
  studentId: number;
  actorCpUserId: number | null;
  type: string;
  title: (studentName: string, actorName: string) => string;
  lines: string[];
  tone?: Tone;
  tab?: string;
  email?: boolean;
}): Promise<void> {
  try {
    const s = await studentRow(args.studentId);
    if (!s?.cp_counsellor_id) return;
    const actorId = args.actorCpUserId === null ? null : realActorId(args.actorCpUserId);
    const r = await recipientsFor(s.cp_counsellor_id, actorId);
    if (!r) return;
    const actorName = actorId === null ? "The partner" : await staffName(actorId);
    const title = args.title(fullName(s), actorName).slice(0, 255);
    await deliver(r, {
      type: args.type,
      title,
      lines: args.lines,
      link: `${studentLink(s.id)}${args.tab ? `?tab=${args.tab}` : ""}`,
      tone: args.tone ?? "blue",
      email: args.email ?? true,
      subject: title,
    });
  } catch (e) {
    console.error("[counsellor-notify] failed:", e instanceof Error ? e.message : e);
  }
}

// ---- Colleague actions: one rolling item per student, colleague and day ----

// A colleague (not the counsellor) did something to the counsellor's student.
// The first action of the day creates the item and sends one email; later
// ones the same day are added to that item's list while it's unread.
export async function notifyColleagueAction(
  studentId: number,
  actorCpUserId: number,
  action: string,
  opts: { tab?: string } = {},
): Promise<void> {
  try {
    const s = await studentRow(studentId);
    if (!s?.cp_counsellor_id) return;
    const actorId = realActorId(actorCpUserId);
    const r = await recipientsFor(s.cp_counsellor_id, actorId);
    if (!r || actorId === null) return;
    const type = `student.colleague:${actorId}`;
    const link = `${studentLink(s.id)}${opts.tab ? `?tab=${opts.tab}` : ""}`;
    const tz = (await getTatConfig()).timezone;
    const today = await oooToday();

    // Today's unread item from this colleague about this student, if any.
    const existing = await db.cp_notification.findFirst({
      where: {
        cp_user_id: r.responder.id,
        type,
        OR: [{ link: studentLink(s.id) }, { link: { startsWith: `${studentLink(s.id)}?` } }],
        read_at: null,
        created_at: { gte: new Date(Date.now() - 36 * 3600_000) },
      },
      orderBy: { id: "desc" },
      select: { id: true, body: true, created_at: true },
    });
    if (existing && dateInTimezone(existing.created_at, tz) === today) {
      const lines = (existing.body ?? "").split(" · ").filter((l) => l && !l.startsWith("covering for"));
      if (!lines.includes(action)) lines.push(action);
      const covering = r.covering ? ` · covering for ${fullName(r.covering)}` : "";
      await db.cp_notification.update({
        where: { id: existing.id },
        data: {
          title: `${await staffName(actorId)} updated ${fullName(s)} (${lines.length} changes today)`.slice(0, 255),
          body: `${lines.join(" · ")}${covering}`.slice(0, 500),
        },
      });
      return;
    }
    const title = `${await staffName(actorId)} updated ${fullName(s)}`;
    await deliver(r, { type, title, lines: [action], link, tone: "gray", email: true, subject: title });
  } catch (e) {
    console.error("[counsellor-notify] colleague action failed:", e instanceof Error ? e.message : e);
  }
}

// ---- Assignment ---------------------------------------------------------------

// Students handed to a counsellor: one item (and email) for the new
// counsellor listing them, and one for each previous counsellor who lost
// some. Skips whoever made the change.
export async function notifyCounsellorAssignment(args: {
  studentIds: number[];
  newCounsellorId: number;
  previous: Map<number, number | null>; // student id → previous cp_counsellor_id
  actorCpUserId: number | null; // null = automatic
  auto?: boolean;
}): Promise<void> {
  try {
    const moved = args.studentIds.filter((id) => args.previous.get(id) !== args.newCounsellorId);
    if (moved.length === 0) return;
    const actorId = args.actorCpUserId === null ? null : realActorId(args.actorCpUserId);
    const students = await db.student.findMany({
      where: { id: { in: moved } },
      select: { id: true, first_name: true, last_name: true, org_id: true, organization: { select: { name: true } } },
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
    });
    if (students.length === 0) return;
    const by = args.auto ? "Auto Assign" : await staffName(actorId);
    const label = (s: (typeof students)[number]) =>
      `${fullName(s)} (CP-${s.id}${s.organization?.name ? `, ${s.organization.name}` : ""})`;
    const list = (rows: typeof students) =>
      rows.length > 10 ? [...rows.slice(0, 10).map(label), `…and ${rows.length - 10} more`] : rows.map(label);

    const toNew = await recipientsFor(args.newCounsellorId, actorId);
    if (toNew) {
      const one = students.length === 1 ? students[0]! : null;
      const title = one
        ? `${fullName(one)} was assigned to ${toNew.covering ? fullName(toNew.covering) : "you"}`
        : `${students.length} students were assigned to ${toNew.covering ? fullName(toNew.covering) : "you"}`;
      await deliver(toNew, {
        type: "student.assigned_to_me",
        title,
        lines: [`By ${by}`, ...list(students)],
        link: one ? studentLink(one.id) : "/admin/students",
        tone: "blue",
        email: true,
        subject: title,
      });
    }

    const byPrevious = new Map<number, typeof students>();
    for (const s of students) {
      const p = args.previous.get(s.id);
      if (p) byPrevious.set(p, [...(byPrevious.get(p) ?? []), s]);
    }
    const newName = await staffName(args.newCounsellorId);
    for (const [prevId, rows] of byPrevious) {
      const r = await recipientsFor(prevId, actorId);
      if (!r) continue;
      const one = rows.length === 1 ? rows[0]! : null;
      const title = one
        ? `${fullName(one)} was reassigned to ${newName}`
        : `${rows.length} students were reassigned to ${newName}`;
      await deliver(r, {
        type: "student.reassigned_away",
        title,
        lines: [`By ${by}`, ...list(rows)],
        link: "/admin/students",
        tone: "gray",
        email: true,
        subject: title,
      });
    }
  } catch (e) {
    console.error("[counsellor-notify] assignment failed:", e instanceof Error ? e.message : e);
  }
}

// One-line wrappers for the call sites: an action on a program for several
// students (shortlist), or on one application.
export async function notifyColleagueCourseAction(
  studentIds: number[],
  actorCpUserId: number,
  verb: string,
  courseId: number,
): Promise<void> {
  try {
    const c = await db.course.findUnique({
      where: { id: courseId },
      select: { name: true, university: { select: { name: true } } },
    });
    const what = c ? `${c.university.name} – ${c.name}` : "a program";
    for (const id of [...new Set(studentIds)]) {
      await notifyColleagueAction(id, actorCpUserId, `${verb} ${what}`, { tab: "application" });
    }
  } catch (e) {
    console.error("[counsellor-notify] course action failed:", e instanceof Error ? e.message : e);
  }
}

export async function notifyColleagueApplicationAction(
  applicationId: number,
  actorCpUserId: number,
  verb: string,
): Promise<void> {
  try {
    const a = await db.application.findUnique({
      where: { id: applicationId },
      select: { student_id: true, course: { select: { name: true, university: { select: { name: true } } } } },
    });
    if (!a) return;
    await notifyColleagueAction(a.student_id, actorCpUserId, `${verb} (${a.course.university.name} – ${a.course.name})`, {
      tab: "application",
    });
  } catch (e) {
    console.error("[counsellor-notify] application action failed:", e instanceof Error ? e.message : e);
  }
}

// ---- Application follow-ups ---------------------------------------------------

// A follow-up reminder from the daily run (src/server/follow-ups.ts) for the
// counsellor who owns it, routed like everything above: whoever answers for
// them today gets the item and the email; an absent counsellor still gets
// the in-app item. `rolling` keeps one unread item per application that the
// next reminder refreshes (the daily overdue reminder) instead of piling up.
// Returns false when nobody active could be told.
export async function notifyCounsellorFollowUp(
  counsellorId: number,
  n: {
    type: string;
    title: string;
    lines: string[];
    link: string;
    tone: Tone;
    rolling?: boolean;
    email: { subject: string; intro: string } | null;
  },
): Promise<boolean> {
  try {
    const r = await recipientsFor(counsellorId, null);
    if (!r) return false;
    const body = n.lines.join(" · ").slice(0, 500);
    const item = (covering: Person | null) => ({
      type: n.type,
      title: n.title,
      body: covering ? `${body} · covering for ${fullName(covering)}`.slice(0, 500) : body,
      link: n.link,
      tone: n.tone,
    });
    const send = (id: number, covering: Person | null) =>
      n.rolling ? upsertStaffNotification(id, item(covering)) : createStaffNotifications([id], item(covering));
    await send(r.responder.id, r.covering);
    if (r.covering) await send(r.covering.id, null);
    if (n.email) {
      try {
        await sendEmail(
          r.responder.email,
          counsellorFollowUpEmail(
            { name: fullName(r.responder) },
            {
              subject: n.email.subject,
              heading: n.title,
              intro: n.email.intro,
              lines: n.lines,
              link: n.link,
              coveringFor: r.covering ? fullName(r.covering) : null,
            },
            appUrl(),
          ),
        );
      } catch (e) {
        console.error("[counsellor-notify] follow-up email failed:", e instanceof Error ? e.message : e);
      }
    }
    return true;
  } catch (e) {
    console.error("[counsellor-notify] follow-up failed:", e instanceof Error ? e.message : e);
    return false;
  }
}
