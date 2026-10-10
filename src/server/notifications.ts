import { env } from "~/env";
import { adminNewSignupEmail, appUrl, sendEmail } from "./email";
import type { Application } from "./applications/store";

// Tell the Collegepond admin inbox (ADMIN_EMAIL) about a new partner signup.
// Callers fire-and-forget: a mail failure must never fail the signup itself.
export async function notifyAdminOfSignup(app: Application): Promise<void> {
  if (!env.ADMIN_EMAIL) return;
  try {
    await sendEmail(
      env.ADMIN_EMAIL,
      adminNewSignupEmail(
        {
          applicationId: app.applicationId,
          name: `${app.firstName} ${app.lastName}`.trim(),
          email: app.email,
          phone: `${app.countryCode} ${app.phone}`,
          role: app.role,
          company: app.companyName,
          location: [app.city, app.state, app.country].filter(Boolean).join(", "),
        },
        appUrl(),
      ),
    );
  } catch (e) {
    // Minimal, non-PII log (never the applicant's name/email/phone).
    console.error(
      `[Notification] admin email for signup ${app.applicationId} failed:`,
      e instanceof Error ? e.message : e,
    );
  }
}
