import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { findVisibleStudent } from "~/server/partner-access";
import { presignGetUrl, spacesConfigured } from "~/server/storage/spaces";
import { AdminRole } from "~/server/db/enums";
import { canSeeStudent, isCounsellingRole } from "~/server/staff-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same roles as financeProcedure (bank-detail verification).
const BANK_PROOF_ADMIN_ROLES: number[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_MANAGER,
  AdminRole.FINANCE_EXECUTIVE,
];

// Gated proxy for PRIVATE Spaces objects (student docs, partner KYC, avatars).
// The object key is stored in the DB; this route verifies the caller may see it,
// then 302-redirects to a short-lived presigned URL. In local-dev (no Spaces)
// private files are plain /uploads/... paths and never reach this route.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  if (!spacesConfigured()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { key: segments } = await params;
  const key = (segments ?? []).map((s) => decodeURIComponent(s)).join("/");
  if (!key) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const jar = await cookies();

  // Admins (collegepond staff) may read any document, except partners'
  // cancelled cheques / bank letters, which are for finance roles only, and
  // a counsellor's student documents, which follow the admin Students list
  // (src/server/staff-access.ts).
  const adminToken = jar.get(SESSION_COOKIE_NAME)?.value;
  const admin = adminToken ? await verifySessionJwt(adminToken) : null;
  let allowed =
    admin != null && (!key.startsWith("bank-proofs/") || BANK_PROOF_ADMIN_ROLES.includes(admin.role));
  if (allowed && admin && isCounsellingRole(admin.role)) {
    const doc = await db.document.findFirst({
      where: { file_url: key, student_id: { not: null } },
      select: { student_id: true },
    });
    if (doc?.student_id != null && !(await canSeeStudent(admin, doc.student_id))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  // Partners may only read files attached to their own user/org (or to a
  // student they can see).
  if (!allowed) {
    const partner = await resolvePartnerSession(
      jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
      adminToken,
    );
    if (!partner) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const me = await db.user.findUnique({
      where: { id: partner.id },
      select: { id: true, org_id: true, avatar_url: true, organization: { select: { logo_url: true } } },
    });
    // Profile photos and the org logo live on user/organization rows rather
    // than as documents, so check those first.
    if (me && (key === me.avatar_url || key === me.organization?.logo_url)) {
      allowed = true;
    } else if (me?.org_id) {
      const [colleague, bankProof] = await Promise.all([
        db.user.findFirst({ where: { org_id: me.org_id, avatar_url: key }, select: { id: true } }),
        // Their own payout account's cancelled cheque / bank letter.
        db.partner_bank_account.findFirst({ where: { org_id: me.org_id, proof_url: key }, select: { id: true } }),
      ]);
      allowed = colleague != null || bankProof != null;
    }
    const doc = await db.document.findFirst({
      where: { file_url: key },
      select: { user_id: true, org_id: true, student_id: true },
    });
    if (!allowed && me && doc) {
      if (doc.user_id === me.id) {
        allowed = true;
      } else if (
        doc.org_id !== null &&
        me.org_id !== null &&
        doc.org_id === me.org_id
      ) {
        allowed = true;
      } else if (doc.student_id !== null) {
        // Same rule as the student list: the owner sees their agency's
        // students, a counsellor their own, an independent theirs.
        allowed = (await findVisibleStudent(me.id, doc.student_id)) !== null;
      }
    }
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const signed = await presignGetUrl(key);
  return NextResponse.redirect(signed, { status: 302 });
}
