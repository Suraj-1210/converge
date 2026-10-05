import "server-only";
import { createHash } from "node:crypto";
import { db } from "~/server/db";

// Persistent email-OTP store (DB-backed so it survives restarts and works
// across multiple App Platform instances — unlike an in-process Map). Codes are
// stored hashed; a per-code attempt cap blocks brute force of the 5-digit code.

const OTP_EXPIRY_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generate(): string {
  return String(Math.floor(10000 + Math.random() * 90000));
}

/**
 * Issues a fresh code for `email`, or returns null if a code was issued within
 * the resend cooldown (the previous code stays valid in that window).
 */
export async function issueEmailOtp(email: string): Promise<string | null> {
  const identifier = email.toLowerCase();
  const existing = await db.otp_code.findUnique({
    where: { identifier },
    select: { created_at: true, expires_at: true },
  });
  if (
    existing &&
    existing.expires_at.getTime() > Date.now() &&
    Date.now() - existing.created_at.getTime() < RESEND_COOLDOWN_MS
  ) {
    return null;
  }

  const code = generate();
  const expires_at = new Date(Date.now() + OTP_EXPIRY_MS);
  const code_hash = hash(code);
  await db.otp_code.upsert({
    where: { identifier },
    create: { identifier, code_hash, expires_at, attempts: 0 },
    update: { code_hash, expires_at, attempts: 0, created_at: new Date() },
  });
  return code;
}

/**
 * Withdraws a code that never reached the user (the send failed), so the
 * resend cooldown does not block an immediate retry.
 */
export async function discardEmailOtp(email: string): Promise<void> {
  await db.otp_code
    .delete({ where: { identifier: email.toLowerCase() } })
    .catch(() => undefined);
}

/** Verifies a code, enforcing expiry and the attempt cap. Consumes on success. */
export async function checkEmailOtp(email: string, code: string): Promise<boolean> {
  const identifier = email.toLowerCase();
  const row = await db.otp_code.findUnique({ where: { identifier } });
  if (!row) return false;

  const drop = () =>
    db.otp_code.delete({ where: { identifier } }).catch(() => undefined);

  if (row.expires_at.getTime() < Date.now() || row.attempts >= MAX_ATTEMPTS) {
    await drop();
    return false;
  }
  if (row.code_hash !== hash(code)) {
    // Count the wrong guess; invalidate once the cap is hit.
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      await drop();
    } else {
      await db.otp_code
        .update({ where: { identifier }, data: { attempts: { increment: 1 } } })
        .catch(() => undefined);
    }
    return false;
  }
  await drop();
  return true;
}
