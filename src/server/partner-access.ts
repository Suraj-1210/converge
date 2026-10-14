import { TRPCError } from "@trpc/server";
import { db } from "~/server/db";
import { UserStatus, UserType } from "~/server/db/enums";

// Agency-aware access rules for the partner portal, shared by the tRPC
// routers and the plain route handlers (uploads, file proxy) so "who may see
// or touch this record" is decided in one place.
//
// Student visibility:
//   agency owner        → every student in their org
//   agency counsellor   → students in their org assigned to them or that they
//                         created
//   independent (no org)→ students they created

export type PartnerUser = { id: number; type: number; org_id: number | null };

export function studentScopeFor(user: PartnerUser): Record<string, unknown> {
  if (user.org_id === null) return { created_by_user_id: user.id };
  if (user.type === UserType.AGENCY_COUNSELLOR) {
    return {
      org_id: user.org_id,
      OR: [{ counsellor_id: user.id }, { created_by_user_id: user.id }],
    };
  }
  return { org_id: user.org_id };
}

// Resolves the partner session to its user row and student-visibility filter.
export async function partnerScope(partnerUserId: number) {
  const user = await db.user.findUnique({
    where: { id: partnerUserId },
    select: { id: true, type: true, org_id: true },
  });
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Account not found" });
  }
  return { user, where: studentScopeFor(user) };
}

// The agency owner of an org: same test as agencyOwnerProcedure, for code
// that serves every partner but has owner-only parts.
export async function isAgencyOwner(partnerUserId: number): Promise<boolean> {
  const u = await db.user.findUnique({
    where: { id: partnerUserId },
    select: { type: true, is_owner: true, org_id: true },
  });
  return u?.type === UserType.AGENCY_OWNER && u.is_owner === 1 && u.org_id !== null;
}

// The student if this partner may see it, else null. Another agency's
// student looks exactly like a missing one.
export async function findVisibleStudent(partnerUserId: number, studentId: number) {
  const { where } = await partnerScope(partnerUserId);
  return db.student.findFirst({
    where: { AND: [{ id: studentId }, where] },
    select: { id: true, org_id: true, counsellor_id: true, first_name: true, last_name: true },
  });
}

export async function requireVisibleStudent(partnerUserId: number, studentId: number) {
  const student = await findVisibleStudent(partnerUserId, studentId);
  if (!student) throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
  return student;
}

// A counsellor of this org that the owner may manage (not soft-deleted).
// `assignable` additionally requires an approved, active counsellor — the only
// kind that can sign in and work a student.
export async function requireOrgCounsellor(
  orgId: number,
  counsellorId: number,
  opts: { assignable?: boolean } = {},
) {
  const c = await db.user.findFirst({
    where: {
      id: counsellorId,
      org_id: orgId,
      type: UserType.AGENCY_COUNSELLOR,
      deleted_at: null,
      ...(opts.assignable ? { status: UserStatus.APPROVED } : {}),
    },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      status: true,
      approved_by_collegepond_user_id: true,
    },
  });
  if (!c) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: opts.assignable
        ? "That counsellor isn't an active member of your agency."
        : "Counsellor not found",
    });
  }
  return c;
}
