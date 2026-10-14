import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifyPartnerSessionJwt,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { findVisibleStudent } from "~/server/partner-access";
import { presignGetUrl, spacesConfigured } from "~/server/storage/spaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // Admins (collegepond staff) may read any document.
  const adminToken = jar.get(SESSION_COOKIE_NAME)?.value;
  const admin = adminToken ? await verifySessionJwt(adminToken) : null;
  let allowed = Boolean(admin);

  // Partners may only read files attached to their own user/org (or to a
  // student they can see).
  if (!allowed) {
    const partnerToken = jar.get(PARTNER_SESSION_COOKIE_NAME)?.value;
    const partner = partnerToken
      ? await verifyPartnerSessionJwt(partnerToken)
      : null;
    if (!partner) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const me = await db.user.findUnique({
      where: { id: partner.id },
      select: { id: true, org_id: true },
    });
    const doc = await db.document.findFirst({
      where: { file_url: key },
      select: { user_id: true, org_id: true, student_id: true },
    });
    if (me && doc) {
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
