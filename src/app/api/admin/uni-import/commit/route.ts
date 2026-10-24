import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { canUseSection } from "~/lib/admin-sections";
import { commitImport, type ImportPreview } from "~/server/universities/import";

// Commit endpoint — receives a (potentially edited) preview JSON and writes
// it to the DB. Re-validates server-side as defence in depth.
export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  const claims = token ? await verifySessionJwt(token) : null;
  if (!claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Universities is a lead-and-above section (~/lib/admin-sections).
  if (!canUseSection(claims.role, "universities")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Light shape check; the importer trusts admin input but we don't want a
  // wildly malformed payload to crash the server.
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as ImportPreview).universities) ||
    !Array.isArray((body as ImportPreview).courses)
  ) {
    return NextResponse.json(
      { error: "Body must include `universities` and `courses` arrays" },
      { status: 400 },
    );
  }

  try {
    const summary = await commitImport(body as ImportPreview);
    return NextResponse.json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Commit failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
