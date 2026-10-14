import "server-only";
import { db } from "~/server/db";
import { UserStatus, UserType } from "~/server/db/enums";

// Who commission money belongs to. commission, invoice and
// partner_bank_account rows carry exactly one of org_id (an agency) or
// payee_user_id (an independent counsellor, who has no org) — enforced by the
// chk_*_payee constraints (migration 20261014102716). The payee is stamped
// when the row is created (billing confirmation, claim, bank-details save) and
// never moves afterwards.

export type Payee = { orgId: number; userId: null } | { orgId: null; userId: number };

export const orgPayee = (orgId: number): Payee => ({ orgId, userId: null });
export const independentPayee = (userId: number): Payee => ({ orgId: null, userId });

export function payeeOf(row: { org_id: number | null; payee_user_id: number | null }): Payee {
  if (row.org_id != null) return orgPayee(row.org_id);
  if (row.payee_user_id != null) return independentPayee(row.payee_user_id);
  // Unreachable under the CHECK constraint.
  throw new Error("Row has neither an org nor a payee user");
}

// The payee's rows (a Prisma filter) and the columns to write on a new row.
export function payeeWhere(p: Payee): { org_id: number } | { payee_user_id: number } {
  return p.orgId != null ? { org_id: p.orgId } : { payee_user_id: p.userId };
}

export function payeeData(p: Payee): { org_id: number | null; payee_user_id: number | null } {
  return { org_id: p.orgId, payee_user_id: p.userId };
}

// The signed-in payee from payeeProcedure's ctx.payee: an agency owner is
// paid through their org, an independent as themselves.
export function payeeFromSession(me: { id: number; orgId: number | null }): Payee {
  return me.orgId != null ? orgPayee(me.orgId) : independentPayee(me.id);
}

// Whose commission an application earns, decided at billing confirmation.
// An agency's student → the agency. An independent's student (no org) → the
// independent who created it, whatever their status now: the student enrolled
// while they were active, so the record must exist; a suspended or deleted
// independent just can't claim or be paid (Suraj, 14 Oct 2026). Null when
// nobody can be identified.
export async function payeeForApplication(app: {
  org_id: number | null;
  student_id: number;
}): Promise<Payee | null> {
  if (app.org_id != null) return orgPayee(app.org_id);
  const student = await db.student.findUnique({
    where: { id: app.student_id },
    select: { org_id: true, created_by_user_id: true },
  });
  if (student?.org_id !== null || student.created_by_user_id == null) return null;
  const creator = await db.user.findUnique({
    where: { id: student.created_by_user_id },
    select: { id: true, type: true },
  });
  return creator?.type === UserType.INDEPENDENT_COUNSELLOR ? independentPayee(creator.id) : null;
}

// ---- display (admin lists) ----------------------------------------------------

// Select on a commission / invoice / partner_bank_account row for payeeLabel.
export const PAYEE_LABEL_SELECT = {
  organization: { select: { name: true } },
  payee_user: { select: { first_name: true, last_name: true, status: true, deleted_at: true } },
} as const;

type PayeeLabelRow = {
  organization: { name: string } | null;
  payee_user: { first_name: string; last_name: string; status: number; deleted_at: Date | null } | null;
};

// An independent who can't sign in any more (same rule as protectedPartnerProcedure).
export function independentInactiveReason(u: {
  status: number;
  deleted_at: Date | null;
}): "deleted" | "suspended" | null {
  if (u.deleted_at) return "deleted";
  if (u.status === UserStatus.INACTIVE || u.status === UserStatus.REJECTED) return "suspended";
  return null;
}

// "Partner" column for Finance: the agency's name, or the independent's own
// name. payeeInactive flags a suspended / deleted independent, who can't
// claim or be paid until reactivated (or Finance records a decision at release).
export function payeeLabel(row: PayeeLabelRow): {
  partner: string;
  partnerType: "agency" | "independent";
  payeeInactive: "deleted" | "suspended" | null;
} {
  if (row.organization) {
    return { partner: row.organization.name, partnerType: "agency", payeeInactive: null };
  }
  const u = row.payee_user;
  return {
    partner: u ? `${u.first_name} ${u.last_name}`.trim() : "Unknown partner",
    partnerType: "independent",
    payeeInactive: u ? independentInactiveReason(u) : null,
  };
}

// PAN is mandatory on an India-based independent's claim (Suraj, 14 Oct 2026).
// India-based is the signup rule: a +91 phone (isPanRequired in lib/utils/pan).
// Signup stores the phone as "+91…".
export function independentIsIndiaBased(phone: string): boolean {
  return phone.replace(/\s+/g, "").startsWith("+91");
}
