import "server-only";
import { cookies } from "next/headers";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { UserStatus } from "~/server/db/enums";
import { partnerTabsFor } from "~/server/tab-access";

// The signed-in partner for the loan route handlers (reply upload, file
// download), with the same rules as protectedPartnerProcedure for the Loans
// tab: an active account that has the "loans" tab. Returns a reason string
// when refused.
export async function loanPartnerFromCookies(): Promise<
  | { ok: true; user: { id: number; type: number; org_id: number | null; first_name: string; last_name: string }; impersonatorId: number | null }
  | { ok: false; status: 401 | 403; error: string }
> {
  const jar = await cookies();
  const partner = await resolvePartnerSession(
    jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
    jar.get(SESSION_COOKIE_NAME)?.value,
    jar.get(PARTNER_OWNER_SESSION_COOKIE_NAME)?.value,
  );
  if (!partner) return { ok: false, status: 401, error: "Unauthorized" };
  const user = await db.user.findUnique({
    where: { id: partner.id },
    select: { id: true, type: true, org_id: true, status: true, deleted_at: true, first_name: true, last_name: true },
  });
  if (!user || user.deleted_at || user.status === UserStatus.REJECTED || user.status === UserStatus.INACTIVE) {
    return { ok: false, status: 401, error: "This account is no longer active." };
  }
  if (!(await partnerTabsFor(user.id, user.type)).includes("loans")) {
    return { ok: false, status: 403, error: "You don't have access to this section." };
  }
  return {
    ok: true,
    user,
    impersonatorId: partner.impersonatorId ?? partner.ownerImpersonatorId ?? null,
  };
}
