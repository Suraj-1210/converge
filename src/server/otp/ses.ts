import {
  adminLoginOtpEmail,
  partnerLoginOtpEmail,
  sendEmail,
  signupOtpEmail,
} from "~/server/email";
import { checkEmailOtp, discardEmailOtp, issueEmailOtp } from "./email-store";

// Email OTP: we own the code (DB-backed ./email-store — survives restarts,
// works across instances, caps verify attempts); SES just delivers it.

export type EmailOtpPurpose = "signup" | "partner_login" | "admin_login";

const TEMPLATE = {
  signup: signupOtpEmail,
  partner_login: partnerLoginOtpEmail,
  admin_login: adminLoginOtpEmail,
} as const;

export async function sendEmailOtp(email: string, purpose: EmailOtpPurpose): Promise<void> {
  const code = await issueEmailOtp(email);
  if (code === null) {
    // Resend within the cooldown — the previously sent code is still valid.
    throw new Error("An OTP was just sent. Please wait before requesting another.");
  }
  try {
    await sendEmail(email, TEMPLATE[purpose](code));
  } catch (e) {
    // Nothing was sent, so don't let this code hold the resend cooldown.
    await discardEmailOtp(email);
    throw e;
  }
}

export function verifyEmailOtp(email: string, code: string): Promise<boolean> {
  return checkEmailOtp(email, code);
}
