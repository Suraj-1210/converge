import { NextResponse } from "next/server";
import { runTasksCron } from "~/server/tasks-cron";

// Counsellor tasks and shortlist follow-ups (src/server/tasks.ts,
// src/server/shortlist-follow-up.ts) for an external scheduler, protected
// exactly like /api/cron/follow-ups:
//   - set CRON_SECRET in the environment, and
//   - call GET /api/cron/tasks?run=morning|evening with
//     `Authorization: Bearer <secret>` (or `?secret=`).
// morning (daily 09:00 IST, with the other crons): imports new reminders and
//   application follow-ups into My Tasks and creates the shortlist follow-up
//   tasks falling due today. Nothing depends on it running: the same happens
//   whenever someone opens My Tasks.
// evening (working days, after 19:00 IST, e.g. 19:15): emails each Head
//   Counsellor the counsellors who left tasks incomplete without closing
//   their day. Once per counsellor per day; a repeat call sends nothing.
// If CRON_SECRET is unset the endpoint is disabled (503).
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
  const run = url.searchParams.get("run") === "evening" ? "evening" : "morning";
  try {
    const result = await runTasksCron(run);
    return NextResponse.json({ ok: true, run, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, run, error: e instanceof Error ? e.message : "Tasks cron failed" },
      { status: 500 },
    );
  }
}
