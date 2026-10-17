import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { UserType } from "~/server/db/enums";
import { MOU_USER_SELECT, executedMouFor, mouFileName, renderExecutedMou } from "~/server/mou-pdf";
import { readStoredFile } from "~/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signed-in partner's executed MOU as a PDF. ?download=1 saves it as a
// file; otherwise it opens in the browser's PDF viewer. Only the partner owner
// (agency owner or independent) gets it: the MOU is between Collegepond and
// the agency, and agency counsellors are refused.
//
// Serves the copy frozen at signing. MOUs signed before copies were kept have
// none, so theirs is rendered from the current text.
export async function GET(req: Request) {
  const jar = await cookies();
  const partner = await resolvePartnerSession(
    jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
    jar.get(SESSION_COOKIE_NAME)?.value,
    jar.get(PARTNER_OWNER_SESSION_COOKIE_NAME)?.value,
  );
  if (!partner) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await db.user.findUnique({
    where: { id: partner.id },
    select: { ...MOU_USER_SELECT, type: true, deleted_at: true },
  });
  if (!me || me.deleted_at) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (me.type === UserType.AGENCY_COUNSELLOR) {
    return NextResponse.json(
      { error: "The MOU is managed by your agency's owner." },
      { status: 403 },
    );
  }
  const signer = me.mou_signed_at
    ? me
    : me.org_id
      ? await db.user.findFirst({
          where: { org_id: me.org_id, is_owner: 1, mou_signed_at: { not: null } },
          select: MOU_USER_SELECT,
        })
      : null;
  if (!signer?.mou_signed_at) {
    return NextResponse.json({ error: "The MOU has not been signed yet." }, { status: 404 });
  }

  const mou = executedMouFor(signer, signer.mou_signed_at);
  let pdf: Uint8Array;
  if (signer.mou_pdf_url) {
    // Never substitute a re-render for a stored copy — the point of the copy
    // is that it's exactly what was signed.
    try {
      pdf = await readStoredFile(signer.mou_pdf_url);
    } catch (err) {
      console.error("[mou] couldn't read the stored MOU", signer.mou_pdf_url, err);
      return NextResponse.json(
        { error: "Couldn't load your signed MOU right now. Please try again shortly." },
        { status: 502 },
      );
    }
  } else {
    pdf = await renderExecutedMou(mou);
  }

  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${mouFileName(mou)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
