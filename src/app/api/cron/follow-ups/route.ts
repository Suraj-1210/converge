import { NextResponse } from "next/server";
import { runFollowUpReminders } from "~/server/follow-ups";

// Daily application follow-up reminders (src/server/follow-ups.ts) for an
// external scheduler, protected exactly like /api/cron/fx:
//   - set CRON_SECRET in the environment, and
//   - call GET /api/cron/follow-ups with `Authorization: Bearer <secret>` (or `?secret=`).
// If CRON_SECRET is unset the endpoint is disabled (503). Idempotent: a
// second call the same day sends nothing twice. A Super Admin can also run
// it from TAT Management (followUps.runNow).
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
    const result = await runFollowUpReminders();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Follow-up reminders failed" },
      { status: 500 },
    );
  }
}
