import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { AdminRole, UserType } from "~/server/db/enums";
import { loadNote, noteFileName, renderAdjustmentNote } from "~/server/adjustment-note";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FINANCE_ROLES: number[] = [AdminRole.SUPER_ADMIN, AdminRole.FINANCE_MANAGER, AdminRole.FINANCE_EXECUTIVE];

// An Adjustment Note PDF (~/server/adjustment-note). Finance staff may open
// any; a partner only their own: the agency owner for the agency's, an
// independent counsellor for their own (the payeeProcedure rule; agency
// counsellors are refused). Anyone else gets a 404, as for a missing note.
// ?download=1 saves it; otherwise it opens inline.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const notFound = NextResponse.json({ error: "Not found" }, { status: 404 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return notFound;
  const note = await loadNote(id);
  if (!note) return notFound;

  const jar = await cookies();
  const adminToken = jar.get(SESSION_COOKIE_NAME)?.value;
  const admin = adminToken ? await verifySessionJwt(adminToken) : null;
  let allowed = admin != null && FINANCE_ROLES.includes(admin.role);
  if (!allowed) {
    const partner = await resolvePartnerSession(
      jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
      adminToken,
      jar.get(PARTNER_OWNER_SESSION_COOKIE_NAME)?.value,
    );
    if (partner) {
      const me = await db.user.findUnique({
        where: { id: partner.id },
        select: { id: true, type: true, is_owner: true, org_id: true },
      });
      if (me?.type === UserType.AGENCY_OWNER && me.is_owner === 1 && me.org_id != null) {
        allowed = note.org_id === me.org_id;
      } else if (me?.type === UserType.INDEPENDENT_COUNSELLOR) {
        allowed = note.payee_user_id === me.id;
      }
    }
  }
  if (!allowed) return notFound;

  const pdf = await renderAdjustmentNote(note);
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${noteFileName(note)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
