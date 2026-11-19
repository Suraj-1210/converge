import { NextResponse } from "next/server";
import { env } from "~/env";
import { applyEnrollmentEvents, enrollmentEventsBody, verifySignedRequest } from "~/server/loan-sharing";

// Progress on partner loan leads, pushed by the Collegepond Enrollment App
// (its convergeOutbox sender). Signed with ENROLLMENT_WEBHOOK_SECRET:
// x-cp-timestamp + x-cp-signature = HMAC-SHA256 of "<timestamp>.<raw body>",
// 5-minute window (docs/loan-sharing/CONTRACT.md). Unset secret → 503, so the
// route can't be hit blindly before it is configured.
//
// Idempotent: event ids already stored and events for referrals we don't know
// are counted as ignored. Any non-2xx makes the Enrollment App retry.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = env.ENROLLMENT_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  const raw = await req.text();
  if (
    !verifySignedRequest(raw, req.headers.get("x-cp-timestamp"), req.headers.get("x-cp-signature"), secret)
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const body = enrollmentEventsBody.safeParse(json);
  if (!body.success) {
    return NextResponse.json({ error: "Expected { events: [...] } with 1–100 events" }, { status: 400 });
  }
  try {
    const { accepted, ignored, invalid } = await applyEnrollmentEvents(body.data.events);
    // A malformed event can never succeed on retry: log it and count it as
    // ignored rather than making the sender retry the whole batch forever.
    if (invalid.length) console.warn("[enrollment-loan] invalid events:", invalid.slice(0, 5));
    return NextResponse.json({ accepted, ignored: ignored + invalid.length });
  } catch (e) {
    console.error("[enrollment-loan] apply failed:", e);
    return NextResponse.json({ error: "Could not apply events" }, { status: 500 });
  }
}
