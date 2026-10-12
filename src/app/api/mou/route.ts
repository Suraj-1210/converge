import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { renderExecutedMou } from "~/server/mou-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signed-in partner's executed MOU as a PDF. ?download=1 saves it as a
// file; otherwise it opens in the browser's PDF viewer. A counsellor in an
// agency gets the MOU their agency owner signed.
export async function GET(req: Request) {
  const jar = await cookies();
  const partner = await resolvePartnerSession(
    jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
    jar.get(SESSION_COOKIE_NAME)?.value,
  );
  if (!partner) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const select = {
    first_name: true,
    last_name: true,
    email: true,
    phone: true,
    address: true,
    city: true,
    state: true,
    country: true,
    org_id: true,
    mou_signed_at: true,
    mou_signature: true,
    mou_signature_kind: true,
    mou_signer_name: true,
    mou_signed_ip: true,
    mou_version: true,
    organization: { select: { name: true, address: true, city: true, state: true, country: true } },
  } as const;
  const me = await db.user.findUnique({ where: { id: partner.id }, select });
  const signer = me?.mou_signed_at
    ? me
    : me?.org_id
      ? await db.user.findFirst({
          where: { org_id: me.org_id, is_owner: 1, mou_signed_at: { not: null } },
          select,
        })
      : null;
  if (!signer?.mou_signed_at) {
    return NextResponse.json({ error: "The MOU has not been signed yet." }, { status: 404 });
  }

  const org = signer.organization;
  const place = org?.address ? org : signer;
  const country = countryName(place.country);
  const address = [place.address, place.city, place.state, country].filter(Boolean).join(", ");
  const partnerName = `${signer.first_name} ${signer.last_name}`.trim();

  const pdf = await renderExecutedMou({
    partnerName,
    businessName: org?.name ?? null,
    email: signer.email,
    phone: signer.phone,
    address,
    signedAt: signer.mou_signed_at,
    signerName: signer.mou_signer_name,
    signature: signer.mou_signature,
    signatureKind: signer.mou_signature_kind,
    signedIp: signer.mou_signed_ip,
    version: signer.mou_version,
  });

  const fileName = `Collegepond-MOU-${(org?.name ?? partnerName).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Partner"}.pdf`;
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
