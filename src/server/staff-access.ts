import "server-only";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { AdminRole } from "~/server/db/enums";
import { coveredCounsellorIds, responderFor } from "~/server/out-of-office";

// What a Collegepond staff user may see in the admin portal: the staff-side
// counterpart of partner-access.ts. Every admin list, count, search and
// by-id lookup of students (leads) and their applications goes through here,
// so the rules live in one place (decided with Suraj, 14 Oct 2026).
//
// Student visibility (student.cp_counsellor_id is the Collegepond counsellor):
//   Counsellor        → students assigned to them
//   Counsellor Lead   → students assigned to them or to a counsellor in their
//                       team, plus unassigned students of partners whose
//                       Counsellor Lead they are (so they can dispatch them)
//   everyone else     → every student (Super Admin, finance, ops, BDM, …)
// A counsellor or lead covering for someone out of office (out-of-office.ts)
// also sees that person's assigned students, until the To date passes.
//
// Partner visibility (dashboard Top Partners, partner counts):
//   Counsellor        → partners whose counsellor or counsellor lead they are
//   Counsellor Lead   → the same, plus partners whose counsellor is in their team
//   everyone else     → every partner
//
// Country-based segregation is planned; when it lands, add it to
// staffStudentScope / staffPartnerScope below and every caller follows.
//
// Anything outside the scope is refused as NOT_FOUND, exactly like a missing
// record, so IDs can't be probed.

export type StaffUser = { id: number; role: number };

export function isCounsellingRole(role: number): boolean {
  return role === AdminRole.COUNSELLOR || role === AdminRole.COUNSELLOR_LEAD;
}

// ---- Teams ------------------------------------------------------------------

// Counsellors reporting to a lead (not including the lead).
export async function teamMemberIds(leadId: number): Promise<number[]> {
  const rows = await db.counsellor_team_member.findMany({
    where: { team: { lead_cp_user_id: leadId } },
    select: { cp_user_id: true },
  });
  return rows.map((r) => r.cp_user_id);
}

// The counsellors a staff user may hand a student to: a lead → themselves and
// their team; a counsellor → their lead, their teammates and themselves.
// null = anyone (non-counselling roles).
export async function assignableCounsellorIds(user: StaffUser): Promise<number[] | null> {
  if (user.role === AdminRole.COUNSELLOR_LEAD) {
    return [user.id, ...(await teamMemberIds(user.id))];
  }
  if (user.role === AdminRole.COUNSELLOR) {
    const team = await db.counsellor_team.findFirst({
      where: { member: { some: { cp_user_id: user.id } } },
      select: { lead_cp_user_id: true, member: { select: { cp_user_id: true } } },
    });
    if (!team) return [user.id];
    return [...new Set([user.id, team.lead_cp_user_id, ...team.member.map((m) => m.cp_user_id)])];
  }
  return null;
}

// ---- Scopes -----------------------------------------------------------------

// Partners (user rows) whose Counsellor Lead this lead is: agencies by org,
// independents (no org) by user id.
async function ledPartners(leadId: number) {
  const rows = await db.user.findMany({
    where: { lead_counsellor_id: leadId },
    select: { id: true, org_id: true },
  });
  return {
    orgIds: [...new Set(rows.map((r) => r.org_id).filter((x): x is number => x !== null))],
    independentIds: rows.filter((r) => r.org_id === null).map((r) => r.id),
  };
}

// Prisma filter for the students this staff user may see. `{}` = all.
export async function staffStudentScope(user: StaffUser): Promise<Prisma.studentWhereInput> {
  if (user.role === AdminRole.COUNSELLOR) {
    const covering = await coveredCounsellorIds(user.id);
    return covering.length ? { cp_counsellor_id: { in: [user.id, ...covering] } } : { cp_counsellor_id: user.id };
  }
  if (user.role === AdminRole.COUNSELLOR_LEAD) {
    const [team, led, covering] = await Promise.all([
      teamMemberIds(user.id),
      ledPartners(user.id),
      coveredCounsellorIds(user.id),
    ]);
    const unassignedOfMyPartners: Prisma.studentWhereInput[] = [];
    if (led.orgIds.length) unassignedOfMyPartners.push({ org_id: { in: led.orgIds } });
    if (led.independentIds.length) {
      unassignedOfMyPartners.push({ org_id: null, created_by_user_id: { in: led.independentIds } });
    }
    return {
      OR: [
        { cp_counsellor_id: { in: [user.id, ...team, ...covering] } },
        ...(unassignedOfMyPartners.length
          ? [{ cp_counsellor_id: null, OR: unassignedOfMyPartners }]
          : []),
      ],
    };
  }
  return {};
}

// Applications of visible students.
export async function staffApplicationScope(user: StaffUser): Promise<Prisma.applicationWhereInput> {
  const scope = await staffStudentScope(user);
  return isCounsellingRole(user.role) ? { student: scope } : {};
}

// Partner users this staff user is responsible for. `{}` = all.
export async function staffPartnerScope(user: StaffUser): Promise<Prisma.userWhereInput> {
  if (user.role === AdminRole.COUNSELLOR) {
    return { OR: [{ counsellor_id: user.id }, { lead_counsellor_id: user.id }] };
  }
  if (user.role === AdminRole.COUNSELLOR_LEAD) {
    const team = await teamMemberIds(user.id);
    return {
      OR: [
        { lead_counsellor_id: user.id },
        { counsellor_id: { in: [user.id, ...team] } },
      ],
    };
  }
  return {};
}

// ---- Guards -----------------------------------------------------------------

const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

export async function canSeeStudent(user: StaffUser, studentId: number): Promise<boolean> {
  const scope = await staffStudentScope(user);
  const n = await db.student.count({ where: { AND: [{ id: studentId }, scope] } });
  return n > 0;
}

export async function requireStaffStudent(user: StaffUser, studentId: number): Promise<void> {
  if (!(await canSeeStudent(user, studentId))) throw notFound("Student");
}

// Every id must be visible; one that isn't fails the whole batch.
export async function requireStaffStudents(user: StaffUser, studentIds: number[]): Promise<void> {
  const ids = [...new Set(studentIds)];
  if (ids.length === 0) return;
  const scope = await staffStudentScope(user);
  const n = await db.student.count({ where: { AND: [{ id: { in: ids } }, scope] } });
  if (n !== ids.length) throw notFound("Student");
}

// The application's student id, if this staff user may see it.
export async function requireStaffApplication(user: StaffUser, applicationId: number): Promise<number> {
  const app = await db.application.findUnique({
    where: { id: applicationId },
    select: { student_id: true },
  });
  if (!app || !(await canSeeStudent(user, app.student_id))) throw notFound("Application");
  return app.student_id;
}

export async function requireStaffNote(user: StaffUser, noteId: number): Promise<void> {
  const note = await db.student_note.findUnique({
    where: { id: noteId },
    select: { student_id: true },
  });
  if (!note || !(await canSeeStudent(user, note.student_id))) throw notFound("Note");
}

// A hand-picked Collegepond counsellor for a student: must be an active
// counselling user, and a counselling-role assigner may only pick within
// their own team (otherwise they'd hand a student out of anyone's sight).
export async function requireAssignableCounsellor(user: StaffUser, counsellorId: number) {
  const c = await db.collegepond_user.findUnique({
    where: { id: counsellorId },
    select: { id: true, first_name: true, last_name: true, status: true, role: true },
  });
  if (c?.status !== 1 || !isCounsellingRole(c.role)) throw notFound("Counsellor");
  const allowed = await assignableCounsellorIds(user);
  if (allowed && !allowed.includes(c.id)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You can only assign students to yourself or your counselling team.",
    });
  }
  return c;
}

// ---- Auto-assign ------------------------------------------------------------

export type AutoAssignRule = "partner_counsellor" | "primary_spoc";

const activeCounsellor = async (id: number | null) => {
  if (id === null) return null;
  const c = await db.collegepond_user.findUnique({
    where: { id },
    select: { id: true, status: true, role: true },
  });
  return c?.status === 1 && isCounsellingRole(c.role) ? c.id : null;
};

// The partner a student belongs to, for routing: the agency owner, or the
// independent counsellor who created the student.
export async function studentPartner(student: { org_id: number | null; created_by_user_id: number | null }) {
  const select = { counsellor_id: true, lead_counsellor_id: true } as const;
  if (student.org_id !== null) {
    return db.user.findFirst({ where: { org_id: student.org_id, is_owner: 1 }, select });
  }
  if (student.created_by_user_id !== null) {
    return db.user.findUnique({ where: { id: student.created_by_user_id }, select });
  }
  return null;
}

// Routes new students that have no Collegepond counsellor (decided with
// Suraj, 14 Oct 2026). Only when the partner's Counsellor Lead has Auto
// Assign switched on:
//   1. the partner's own Collegepond counsellor, if active;
//   2. otherwise the lead's primary SPOC, if active.
// If that person is out of office today, their alternate gets the student
// instead (out-of-office.ts, decided with Suraj 24 Oct 2026).
// Never touches a student that already has a counsellor, so a hand-picked
// assignment always wins. Each assignment is audit-logged. Never throws:
// the students are already saved; a failure leaves them unassigned.
export async function autoAssignStudents(studentIds: number[]): Promise<number> {
  let assigned = 0;
  try {
    const students = await db.student.findMany({
      where: { id: { in: studentIds }, cp_counsellor_id: null },
      select: { id: true, org_id: true, created_by_user_id: true },
    });
    for (const s of students) {
      const partner = await studentPartner(s);
      if (!partner?.lead_counsellor_id) continue;
      const team = await db.counsellor_team.findUnique({
        where: { lead_cp_user_id: partner.lead_counsellor_id },
        select: { auto_assign: true, primary_spoc_cp_user_id: true },
      });
      if (team?.auto_assign !== 1) continue;

      let rule: AutoAssignRule = "partner_counsellor";
      let target = await activeCounsellor(partner.counsellor_id);
      if (target === null) {
        rule = "primary_spoc";
        target = await activeCounsellor(team.primary_spoc_cp_user_id);
      }
      if (target === null) continue;
      const chosen = target;
      target = (await activeCounsellor(await responderFor(chosen))) ?? chosen;

      // Conditional update: a manual assignment that raced us wins.
      const res = await db.student.updateMany({
        where: { id: s.id, cp_counsellor_id: null },
        data: { cp_counsellor_id: target, cp_auto_assigned_at: new Date() },
      });
      if (res.count === 0) continue;
      assigned++;
      await db.audit_log.create({
        data: {
          action: "student.cp_counsellor_auto_assigned",
          entity_type: "student",
          entity_id: s.id,
          metadata: {
            cpCounsellorId: target,
            leadCpUserId: partner.lead_counsellor_id,
            rule,
            ...(target !== chosen ? { coveringForCpUserId: chosen } : {}),
          },
        },
      });
    }
  } catch (e) {
    console.error("[auto-assign] failed:", e instanceof Error ? e.message : e);
  }
  return assigned;
}
