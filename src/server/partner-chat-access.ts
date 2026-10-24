import "server-only";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { AdminRole, UserStatus, UserType } from "~/server/db/enums";
import { type OooNotice, oooNotices, responderFor } from "~/server/out-of-office";
import { partnerScope } from "~/server/partner-access";
import { requireStaffStudent, staffStudentScope, studentPartner, type StaffUser } from "~/server/staff-access";

// Who takes part in a student's partner chat (decided with Suraj, 14 and 17
// Oct 2026). Nobody is stored as a participant: it follows the student's
// current assignment, so whoever is assigned now sees the whole history.
//
// Partner side (built on partner-access.ts):
//   agency owner      → every student of their agency
//   agency counsellor → students assigned to them (or, while nobody is
//                       assigned, students they created)
//   independent       → their own students
// Collegepond side (built on staff-access.ts):
//   Counsellor        → students assigned to them
//   Counsellor Lead   → their own and their team's students, plus unassigned
//                       students of the partners they lead
//   Super Admin       → every student
//   every other role (Finance, Operations, BDM, …) → refused
//
// Another agency's student, or one outside a staff user's scope, looks
// exactly like a missing one (NOT_FOUND).

export type ChatSide = "partner" | "staff";

export const CHAT_STAFF_ROLES: number[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.COUNSELLOR_LEAD,
  AdminRole.COUNSELLOR,
];

export function isChatStaffRole(role: number): boolean {
  return CHAT_STAFF_ROLES.includes(role);
}

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Student not found" });

// ---- Partner side -------------------------------------------------------------

type PartnerRow = { id: number; type: number; org_id: number | null; is_owner: number };

async function partnerRow(partnerUserId: number): Promise<PartnerRow> {
  const u = await db.user.findUnique({
    where: { id: partnerUserId },
    select: { id: true, type: true, org_id: true, is_owner: true },
  });
  if (!u) throw new TRPCError({ code: "UNAUTHORIZED", message: "Account not found" });
  return u;
}

const isOwner = (u: PartnerRow) => u.type === UserType.AGENCY_OWNER && u.is_owner === 1 && u.org_id !== null;

// Prisma filter for the students whose chat this partner takes part in.
export async function partnerChatScope(partnerUserId: number): Promise<Prisma.studentWhereInput> {
  const u = await partnerRow(partnerUserId);
  const { where } = await partnerScope(partnerUserId);
  if (u.org_id === null || isOwner(u)) return where as Prisma.studentWhereInput;
  return {
    AND: [
      where as Prisma.studentWhereInput,
      { OR: [{ counsellor_id: u.id }, { counsellor_id: null, created_by_user_id: u.id }] },
    ],
  };
}

export async function requirePartnerChatStudent(partnerUserId: number, studentId: number) {
  const scope = await partnerChatScope(partnerUserId);
  const s = await db.student.findFirst({
    where: { AND: [{ id: studentId }, scope] },
    select: { id: true, org_id: true, first_name: true, last_name: true },
  });
  if (s) return s;
  // A student they can see but whose chat belongs to the assigned counsellor
  // says so, rather than pretending it doesn't exist.
  const { where } = await partnerScope(partnerUserId);
  const visible = await db.student.count({ where: { AND: [{ id: studentId }, where as Prisma.studentWhereInput] } });
  if (visible > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the counsellor assigned to this student and your agency owner can use this chat.",
    });
  }
  throw notFound();
}

// ---- Collegepond side -----------------------------------------------------------

export function requireChatStaffRole(user: StaffUser) {
  if (!isChatStaffRole(user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Partner chat is for the student's counsellor, their Counselling Lead and Super Admins.",
    });
  }
}

export async function staffChatScope(user: StaffUser): Promise<Prisma.studentWhereInput> {
  requireChatStaffRole(user);
  return staffStudentScope(user);
}

export async function requireStaffChatStudent(user: StaffUser, studentId: number) {
  requireChatStaffRole(user);
  await requireStaffStudent(user, studentId);
  const s = await db.student.findUnique({
    where: { id: studentId },
    select: { id: true, org_id: true, first_name: true, last_name: true },
  });
  if (!s) throw notFound();
  return s;
}

// ---- Who to tell ---------------------------------------------------------------------

export type Person = { id: number; first_name: string; last_name: string; email: string };

const personSelect = { id: true, first_name: true, last_name: true, email: true } as const;

// The partner-side participants of a student's chat, active accounts only.
// primary: who gets the unread-message email (the assigned counsellor, else
// the owner; for an independent, themselves).
export async function partnerParticipants(studentId: number): Promise<{ all: Person[]; primary: Person | null }> {
  const s = await db.student.findUnique({
    where: { id: studentId },
    select: { org_id: true, counsellor_id: true, created_by_user_id: true },
  });
  if (!s) return { all: [], primary: null };
  const active = { deleted_at: null, status: UserStatus.APPROVED };
  if (s.org_id === null) {
    if (s.created_by_user_id === null) return { all: [], primary: null };
    const me = await db.user.findFirst({ where: { id: s.created_by_user_id, ...active }, select: personSelect });
    return { all: me ? [me] : [], primary: me };
  }
  const counsellorId = s.counsellor_id ?? s.created_by_user_id;
  const [owners, counsellor] = await Promise.all([
    db.user.findMany({
      where: { org_id: s.org_id, type: UserType.AGENCY_OWNER, is_owner: 1, ...active },
      select: personSelect,
    }),
    counsellorId === null
      ? Promise.resolve(null)
      : db.user.findFirst({
          where: { id: counsellorId, org_id: s.org_id, type: UserType.AGENCY_COUNSELLOR, ...active },
          select: personSelect,
        }),
  ]);
  const all = [...owners, ...(counsellor && !owners.some((o) => o.id === counsellor.id) ? [counsellor] : [])];
  return { all, primary: counsellor ?? owners[0] ?? null };
}

// The Collegepond side: the student's counsellor and the Counselling Lead
// over them (for an unassigned student, the partner's Counsellor Lead).
// Super Admins can join any chat but aren't emailed.
//
// Out of office (out-of-office.ts): `responder` is who answers this chat
// today (the counsellor, or their alternate while they're out; with no
// counsellor, the lead or theirs) and `leadResponder` who takes escalations
// (the lead or their alternate). `outOfOffice` lists whichever of the two is
// out today, for display.
export async function staffParticipants(studentId: number): Promise<{
  counsellor: Person | null;
  lead: Person | null;
  responder: Person | null;
  leadResponder: Person | null;
  outOfOffice: OooNotice[];
}> {
  const s = await db.student.findUnique({
    where: { id: studentId },
    select: { cp_counsellor_id: true, org_id: true, created_by_user_id: true },
  });
  if (!s) return { counsellor: null, lead: null, responder: null, leadResponder: null, outOfOffice: [] };
  const activeCp = (id: number | null) =>
    id === null ? Promise.resolve(null) : db.collegepond_user.findFirst({ where: { id, status: 1 }, select: personSelect });

  const counsellor = await activeCp(s.cp_counsellor_id);
  let leadId: number | null = null;
  if (s.cp_counsellor_id !== null) {
    const team = await db.counsellor_team.findFirst({
      where: {
        OR: [{ member: { some: { cp_user_id: s.cp_counsellor_id } } }, { lead_cp_user_id: s.cp_counsellor_id }],
      },
      select: { lead_cp_user_id: true },
    });
    leadId = team?.lead_cp_user_id ?? null;
  } else {
    leadId = (await studentPartner(s))?.lead_counsellor_id ?? null;
  }
  const lead = leadId !== null && leadId !== counsellor?.id ? await activeCp(leadId) : null;

  const cover = async (p: Person | null): Promise<Person | null> => {
    if (!p) return null;
    const id = await responderFor(p.id);
    return id === p.id ? p : ((await activeCp(id)) ?? p);
  };
  const [counsellorCover, leadResponder, outOfOffice] = await Promise.all([
    cover(counsellor),
    cover(lead),
    oooNotices([counsellor?.id, lead?.id]),
  ]);
  return { counsellor, lead, responder: counsellorCover ?? leadResponder, leadResponder, outOfOffice };
}
