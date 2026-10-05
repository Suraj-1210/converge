import { env } from "~/env";
import { checkEmailOtp, issueEmailOtp } from "./email-store";

const OTP_LENGTH = 5;
const OTP_EXPIRY_MINUTES = 5;

interface Msg91Response {
  type?: string;
  message?: string;
  request_id?: string;
  status?: string;
  errors?: unknown;
}

function authkey(): string {
  if (!env.MSG91_AUTH_KEY) {
    throw new Error("MSG91_AUTH_KEY not configured");
  }
  return env.MSG91_AUTH_KEY;
}

async function msg91Fetch(url: string, body: unknown): Promise<Msg91Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authkey: authkey(),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Msg91Response;
  if (!res.ok || data.type === "error" || data.status === "fail") {
    // MSG91 puts the reason in `message` (OTP API) or `errors` (email API).
    // Neither echoes the authkey, so the detail is safe to surface in logs.
    const detail = data.message ?? (data.errors ? JSON.stringify(data.errors).slice(0, 300) : "");
    throw new Error(`MSG91 request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

// ─── SMS (MSG91 manages OTP state server-side) ──────────────────────────────

export async function sendPhoneOtp(phoneE164: string): Promise<void> {
  if (!env.MSG91_SMS_TEMPLATE_ID) {
    throw new Error("MSG91_SMS_TEMPLATE_ID not configured");
  }
  const data = await msg91Fetch("https://control.msg91.com/api/v5/otp", {
    template_id: env.MSG91_SMS_TEMPLATE_ID,
    mobile: phoneE164,
    otp_length: OTP_LENGTH,
    otp_expiry: OTP_EXPIRY_MINUTES,
  });
  // MSG91 accepts the request before the SMS is delivered, so "accepted" is not
  // "delivered". Log its request id (never the phone number) so a code that
  // doesn't arrive can be looked up in MSG91's delivery reports.
  console.log(`[otp] MSG91 accepted SMS OTP request ${data.request_id ?? data.message ?? "(no request id)"}`);
}

export async function verifyPhoneOtp(phoneE164: string, code: string): Promise<boolean> {
  const res = await fetch(
    `https://control.msg91.com/api/v5/otp/verify?otp=${encodeURIComponent(code)}&mobile=${encodeURIComponent(phoneE164)}`,
    { method: "POST", headers: { authkey: authkey() } },
  );
  const data = (await res.json().catch(() => ({}))) as Msg91Response;
  return res.ok && data.type === "success";
}

// ─── Email (we own the code; MSG91 just delivers the mail) ──────────────────
// Code state lives in the DB (./email-store) so it survives restarts / runs
// across instances and enforces the verify attempt cap (brute-force guard).

export async function sendEmailOtp(email: string): Promise<void> {
  if (!env.MSG91_EMAIL_TEMPLATE_ID || !env.MSG91_EMAIL_FROM || !env.MSG91_EMAIL_DOMAIN) {
    throw new Error("MSG91 email config incomplete");
  }

  const code = await issueEmailOtp(email);
  if (code === null) {
    // Resend within the cooldown — the previously sent code is still valid.
    throw new Error("An OTP was just sent. Please wait before requesting another.");
  }

  await msg91Fetch("https://control.msg91.com/api/v5/email/send", {
    recipients: [{ to: [{ email }], variables: { otp: code } }],
    from: { email: env.MSG91_EMAIL_FROM },
    domain: env.MSG91_EMAIL_DOMAIN,
    template_id: env.MSG91_EMAIL_TEMPLATE_ID,
  });
}

export function verifyEmailOtp(email: string, code: string): Promise<boolean> {
  return checkEmailOtp(email, code);
}
