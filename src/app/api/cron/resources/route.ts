import { NextResponse } from "next/server";
import { announceDueResources } from "~/server/resources";

// Announces resources whose publish date has arrived (src/server/resources.ts):
// the resource.published event, and the bell / email if "Notify partners" is
// ticked. Protected like /api/cron/follow-ups:
//   - set CRON_SECRET in the environment, and
//   - call GET /api/cron/resources with `Authorization: Bearer <secret>` (or `?secret=`).
// Optional: opening Admin or Partner > Resources runs the same sweep
// (throttled), so scheduled resources are announced without a scheduler too.
// Idempotent: nobody is notified twice.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const url = new URL(req.url);
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await announceDueResources()) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Announcing resources failed" },
      { status: 500 },
    );
  }
}
