import "server-only";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { AdminRole, UserType } from "~/server/db/enums";
import { type AdminSection, canEditSection } from "~/lib/admin-sections";
import { coveredCounsellorIds, responderFor } from "~/server/out-of-office";
import { notifyCounsellorAssignment } from "~/server/counsellor-notify";

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
//   BDM               → students of the partners they are BDM of (27 Oct)
//   everyone else     → every student (Super Admin, finance, ops, …)
// A counsellor or lead covering for someone out of office (out-of-office.ts)
// also sees that person's assigned students, until the To date passes.
//
// Partner visibility (dashboard Top Partners, partner counts):
//   Counsellor        → partners whose counsellor or counsellor lead they are
//   Counsellor Lead   → the same, plus partners whose counsellor is in their team
//   BDM               → partners whose BDM they are
//   everyone else     → every partner
//
// BDM segregation (decided with Suraj, 27 Oct 2026): a BDM sees only the
// partners assigned to them (user.bdm_id on the agency owner or independent
// counsellor) and those partners' students, applications, placements and
// commissions — in lists, counts, search, exports and by id. Partner
// Management, BDM Performance and the commission views use bdmPartners() /
// requireStaffPartner*() for the partner side.
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

// Roles that see a slice of students and partners rather than all of them.
export function isScopedStaffRole(role: number): boolean {
  return isCounsellingRole(role) || role === AdminRole.BDM;
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

// The partners a BDM is BDM of: agencies by org, independents by user id.
// null = not a BDM (no BDM restriction).
export type PartnerSet = { orgIds: number[]; independentIds: number[] };

export async function bdmPartners(user: StaffUser): Promise<PartnerSet | null> {
  if (user.role !== AdminRole.BDM) return null;
  const rows = await db.user.findMany({
    where: {
      bdm_id: user.id,
      type: { in: [UserType.AGENCY_OWNER, UserType.INDEPENDENT_COUNSELLOR] },
    },
    select: { id: true, org_id: true },
  });
  return {
    orgIds: [...new Set(rows.map((r) => r.org_id).filter((x): x is number => x !== null))],
    independentIds: rows.filter((r) => r.org_id === null).map((r) => r.id),
  };
}

// Students belonging to a set of partners.
function studentsOfPartners(p: PartnerSet): Prisma.studentWhereInput {
  const or: Prisma.studentWhereInput[] = [];
  if (p.orgIds.length) or.push({ org_id: { in: p.orgIds } });
  if (p.independentIds.length) or.push({ org_id: null, created_by_user_id: { in: p.independentIds } });
  return or.length ? { OR: or } : { id: { in: [] } };
}

// Partner-side users (owners, independents and agency members) of a set of
// partners.
function usersOfPartners(p: PartnerSet): Prisma.userWhereInput {
  const or: Prisma.userWhereInput[] = [];
  if (p.orgIds.length) or.push({ org_id: { in: p.orgIds } });
  if (p.independentIds.length) or.push({ id: { in: p.independentIds } });
  return or.length ? { OR: or } : { id: { in: [] } };
}

// Prisma filter for the students this staff user may see. `{}` = all.
export async function staffStudentScope(user: StaffUser): Promise<Prisma.studentWhereInput> {
  const bdm = await bdmPartners(user);
  if (bdm) return studentsOfPartners(bdm);
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
  if (!isScopedStaffRole(user.role)) return {};
  return { student: await staffStudentScope(user) };
}

// Partner users this staff user is responsible for. `{}` = all.
export async function staffPartnerScope(user: StaffUser): Promise<Prisma.userWhereInput> {
  if (user.role === AdminRole.BDM) {
    return { bdm_id: user.id, type: { in: [UserType.AGENCY_OWNER, UserType.INDEPENDENT_COUNSELLOR] } };
  }
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

// Partner-side user filter for BDM-scoped views (Partner Management,
// Counselor Approvals, Placements, commissions). `{}` = all. Unlike
// staffPartnerScope this leaves counsellors unrestricted: those pages are
// role-gated for them instead (~/lib/admin-sections).
export async function bdmUserScope(user: StaffUser): Promise<Prisma.userWhereInput> {
  const bdm = await bdmPartners(user);
  return bdm ? usersOfPartners(bdm) : {};
}

// Organization filter for the same views. `{}` = all.
export async function bdmOrgScope(user: StaffUser): Promise<Prisma.organizationWhereInput> {
  const bdm = await bdmPartners(user);
  return bdm ? { id: { in: bdm.orgIds } } : {};
}

// ---- Guards -----------------------------------------------------------------

const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

// View-only roles (ADMIN_SECTION_READ_ONLY) may read a section but not write.
export function requireSectionEdit(user: StaffUser, section: AdminSection): void {
  if (!canEditSection(user.role, section)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You have view-only access to this section." });
  }
}

// A partner-side user (by id) this staff user may see; BDMs only their own
// partners' people. NOT_FOUND otherwise, like a missing record.
export async function requireStaffPartnerUser(user: StaffUser, partnerUserId: number): Promise<void> {
  const bdm = await bdmPartners(user);
  if (!bdm) return;
  const n = await db.user.count({ where: { AND: [{ id: partnerUserId }, usersOfPartners(bdm)] } });
  if (n === 0) throw notFound("Partner");
}

// The same, by the partner's sign-in email (the Partner Management actions).
export async function requireStaffPartnerEmail(user: StaffUser, email: string): Promise<void> {
  const bdm = await bdmPartners(user);
  if (!bdm) return;
  const n = await db.user.count({
    where: { AND: [{ email: email.toLowerCase() }, usersOfPartners(bdm)] },
  });
  if (n === 0) throw notFound("Partner");
}

export async function requireStaffOrg(user: StaffUser, orgId: number): Promise<void> {
  const bdm = await bdmPartners(user);
  if (bdm && !bdm.orgIds.includes(orgId)) throw notFound("Partner");
}

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
      // Tell the counsellor it was routed to (counsellor-notify.ts).
      void notifyCounsellorAssignment({
        studentIds: [s.id],
        newCounsellorId: target,
        previous: new Map(),
        actorCpUserId: null,
        auto: true,
      });
    }
  } catch (e) {
    console.error("[auto-assign] failed:", e instanceof Error ? e.message : e);
  }
  return assigned;
}
