import { NextResponse } from "next/server";
import { db } from "~/server/db";
import { referralScopeFor } from "~/server/loan-sharing";
import { loanPartnerFromCookies } from "~/server/loan-sharing-auth";
import { readStoredFile } from "~/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A file of a partner's loan document upload, for whoever can see that
// referral (~/server/loan-sharing referralScopeFor). Served inline.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await loanPartnerFromCookies();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const f = await db.loan_doc_file.findFirst({
    where: { id, upload: { referral: referralScopeFor(who.user) } },
    select: { file_name: true, storage_ref: true, content_type: true },
  });
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
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
