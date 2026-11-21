import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { db } from "~/server/db";
import { AdminRole } from "~/server/db/enums";
import { readStoredFile } from "~/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A file on a partner's loan referral, for the Super Admin's read-only view
// of the loan page (/admin/loan-referrals/[publicId]). ?kind=doc is a loan
// document upload (loan_doc_file), ?kind=chat a PDF on a partner's chat reply
// (loan_referral_message_file). Served inline. Anyone but an active Super
// Admin gets a 404, as for a missing file.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const notFound = NextResponse.json({ error: "Not found" }, { status: 404 });
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const claims = token ? await verifySessionJwt(token) : null;
  if (claims?.role !== AdminRole.SUPER_ADMIN) return notFound;
  const me = await db.collegepond_user.findUnique({ where: { id: claims.id }, select: { status: true } });
  if (me?.status !== 1) return notFound;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return notFound;
  const kind = new URL(req.url).searchParams.get("kind");
  const f =
    kind === "doc"
      ? await db.loan_doc_file.findUnique({ where: { id }, select: { file_name: true, storage_ref: true, content_type: true } })
      : kind === "chat"
        ? await db.loan_referral_message_file
            .findUnique({ where: { id }, select: { file_name: true, storage_ref: true } })
            .then((m) => (m ? { ...m, content_type: "application/pdf" } : null))
        : null;
  if (!f) return notFound;
  const buf = await readStoredFile(f.storage_ref);
  const ascii = f.file_name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": f.content_type,
      "content-disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
