import { db } from "~/server/db";
import type { AdminSessionClaims, PartnerSessionClaims } from "~/server/auth/jwt";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  signSessionJwt,
  verifyPartnerSessionJwt,
} from "~/server/auth/jwt";
import {
  buildPartnerSessionCookie,
  buildSessionCookie,
  clearPartnerOwnerSessionCookie,
  clearPartnerSessionCookie,
  clearSessionCookie,
  maxAgeUntil,
  readCookie,
} from "~/server/auth/cookies";
import { AdminRole, AdminRoleLabel, UserType, isAdminRole } from "~/server/db/enums";

// Super Admin impersonation, modelled on the Collegepond enrollment app:
//  - staff target: the admin's cp_session is swapped for one whose subject is
//    the target (role = target's role) and which carries the real admin's id;
//  - partner target: a cp_partner_session is issued for the target, carrying
//    the real admin's id; the admin's own cp_session is left untouched.
// No OTP or email ever goes to the target. Start and end are written to
// audit_log, and everything in between is attributed to the real admin (see
// impersonation-context.ts).

export type ImpersonationKind = "staff" | "partner";

export const PARTNER_TYPE_LABEL: Record<number, string> = {
  [UserType.AGENCY_OWNER]: "Agency Owner",
  [UserType.AGENCY_COUNSELLOR]: "Agency Counsellor",
  [UserType.INDEPENDENT_COUNSELLOR]: "Independent Counsellor",
};

export const PARTNER_USER_TYPES: number[] = [
  UserType.AGENCY_OWNER,
  UserType.AGENCY_COUNSELLOR,
  UserType.INDEPENDENT_COUNSELLOR,
];

export function staffRoleLabel(role: number): string {
  return isAdminRole(role) ? AdminRoleLabel[role] : "Staff";
}

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();

export async function describeTarget(
  kind: ImpersonationKind,
  id: number,
): Promise<{ name: string; roleLabel: string } | null> {
  if (kind === "staff") {
    const u = await db.collegepond_user.findUnique({
      where: { id },
      select: { first_name: true, last_name: true, role: true },
    });
    return u ? { name: fullName(u), roleLabel: staffRoleLabel(u.role) } : null;
  }
  const u = await db.user.findUnique({
    where: { id },
    select: { first_name: true, last_name: true, type: true },
  });
  return u ? { name: fullName(u), roleLabel: PARTNER_TYPE_LABEL[u.type] ?? "Partner" } : null;
}

export async function writeImpersonationAudit(
  event: "started" | "ended",
  realCpUserId: number,
  kind: ImpersonationKind,
  targetId: number,
): Promise<void> {
  const [admin, target] = await Promise.all([
    db.collegepond_user.findUnique({
      where: { id: realCpUserId },
      select: { first_name: true, last_name: true },
    }),
    describeTarget(kind, targetId),
  ]);
  await db.audit_log.create({
    data: {
      action: `impersonation.${event}`,
      entity_type: kind === "staff" ? "cp_user" : "user",
      entity_id: targetId,
      // audit_log.user_id references the partner `user` table.
      ...(kind === "partner" ? { user_id: targetId } : {}),
      metadata: {
        byCpUserId: realCpUserId,
        adminName: admin ? fullName(admin) : null,
        targetKind: kind,
        targetId,
        targetName: target?.name ?? null,
        targetRole: target?.roleLabel ?? null,
      },
    },
  });
}

interface SessionCtx {
  cpUser: AdminSessionClaims | null;
  cpPartner: PartnerSessionClaims | null;
  headers: Headers;
  resHeaders: Headers;
}

// ---- Agency owner → their own counsellor -----------------------------------
// The owner's own cp_partner_session is parked in cp_partner_owner_session and
// cp_partner_session becomes the counsellor's, carrying the owner's id (claim
// "own"); it is honoured only alongside that parked session (see
// resolvePartnerSession). Super Admin impersonation is the model: no OTP or
// email to the counsellor, start/end audit rows, and everything in between
// attributed to the owner (impersonation-context).

export async function writeOwnerImpersonationAudit(
  event: "started" | "ended",
  ownerId: number,
  counsellorId: number,
): Promise<void> {
  const [owner, target] = await Promise.all([
    db.user.findUnique({
      where: { id: ownerId },
      select: { first_name: true, last_name: true, org_id: true },
    }),
    describeTarget("partner", counsellorId),
  ]);
  await db.audit_log.create({
    data: {
      action: `impersonation.${event}`,
      entity_type: "user",
      entity_id: counsellorId,
      user_id: ownerId,
      org_id: owner?.org_id ?? null,
      metadata: {
        byUserId: ownerId,
        impersonatorKind: "agency_owner",
        ownerName: owner ? fullName(owner) : null,
        targetKind: "partner",
        targetId: counsellorId,
        targetName: target?.name ?? null,
        targetRole: target?.roleLabel ?? null,
      },
    },
  });
}

// Ends an owner's view-as: puts the owner's own session back (the parked
// token, unchanged, so the original login's expiry stands). Returns false when
// there was no valid parked session to restore, i.e. the owner is signed out.
export async function endOwnerImpersonation(
  ctx: SessionCtx,
  opts: { restore: boolean } = { restore: true },
): Promise<boolean> {
  const ownerToken = readCookie(ctx.headers, PARTNER_OWNER_SESSION_COOKIE_NAME);
  const owner = ownerToken ? await verifyPartnerSessionJwt(ownerToken) : null;
  const ownerId = ctx.cpPartner?.ownerImpersonatorId ?? owner?.id;
  if (ownerId && ctx.cpPartner?.ownerImpersonatorId) {
    await writeOwnerImpersonationAudit("ended", ownerId, ctx.cpPartner.id);
  }
  ctx.resHeaders.append("Set-Cookie", clearPartnerOwnerSessionCookie());
  const valid = !!owner && !owner.impersonatorId && !owner.ownerImpersonatorId && !!owner.exp;
  if (opts.restore && valid && ownerToken && owner?.exp) {
    ctx.resHeaders.append("Set-Cookie", buildPartnerSessionCookie(ownerToken, maxAgeUntil(owner.exp)));
    return true;
  }
  ctx.resHeaders.append("Set-Cookie", clearPartnerSessionCookie());
  return false;
}

// Ends a staff impersonation: restores the real admin's own session (same
// expiry as the original login), or signs out if they are no longer an active
// Super Admin. Returns where to send the browser.
export async function endStaffImpersonation(ctx: SessionCtx & { cpUser: AdminSessionClaims & { realId: number } }): Promise<string> {
  const { realId, id: targetId, exp } = ctx.cpUser;
  await writeImpersonationAudit("ended", realId, "staff", targetId);
  const real = await db.collegepond_user.findUnique({
    where: { id: realId },
    select: { status: true, role: true },
  });
  if (real?.status !== 1 || real.role !== AdminRole.SUPER_ADMIN) {
    ctx.resHeaders.append("Set-Cookie", clearSessionCookie());
    return "/admin/login";
  }
  const token = await signSessionJwt({ id: realId, role: real.role }, exp);
  ctx.resHeaders.append("Set-Cookie", buildSessionCookie(token, maxAgeUntil(exp)));
  return "/admin/dashboard";
}

// Ends a partner impersonation: drops the impersonated partner session. The
// admin's own session was never replaced, so nothing needs restoring.
export async function endPartnerImpersonation(ctx: SessionCtx & { cpPartner: PartnerSessionClaims & { impersonatorId: number } }): Promise<void> {
  await writeImpersonationAudit("ended", ctx.cpPartner.impersonatorId, "partner", ctx.cpPartner.id);
  ctx.resHeaders.append("Set-Cookie", clearPartnerSessionCookie());
}

// Logging out of either portal mid-impersonation still records the end.
export async function endImpersonationFromLogout(ctx: SessionCtx): Promise<void> {
  const { cpUser, cpPartner } = ctx;
  if (cpUser?.realId) {
    await writeImpersonationAudit("ended", cpUser.realId, "staff", cpUser.id);
  }
  if (cpPartner?.impersonatorId) {
    await endPartnerImpersonation({ ...ctx, cpPartner: { ...cpPartner, impersonatorId: cpPartner.impersonatorId } });
  }
}
