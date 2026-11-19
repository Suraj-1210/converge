import { NextResponse } from "next/server";
import { retryDueLoanReferrals } from "~/server/loan-sharing";

// Retries loan referrals the Enrollment App hasn't taken yet
// (src/server/loan-sharing.ts), for an external scheduler every 10 minutes,
// protected exactly like /api/cron/fx:
//   - set CRON_SECRET in the environment, and
//   - call GET /api/cron/loan-referrals with `Authorization: Bearer <secret>` (or `?secret=`).
// If CRON_SECRET is unset the endpoint is disabled (503). A Super Admin can
// also retry from Loan Referrals.
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
    const result = await retryDueLoanReferrals();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Loan referral retry failed" },
      { status: 500 },
    );
  }
}
