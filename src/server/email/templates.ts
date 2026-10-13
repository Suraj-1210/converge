// Collegepond transactional email templates. Every email the app sends is
// defined here (subject + HTML + plain text) so the wording is version
// controlled and provider-agnostic — the transport (./index.ts) only delivers.
//
// HTML is table-based with inline styles: email clients ignore <style> blocks
// and most modern CSS. Every interpolated value goes through esc().

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

const BRAND = "#1570EF";
const INK = "#101828";
const MUTED = "#475467";

// Header bar: Collegepond primary blue from the brand guidelines, with the
// official white logo on the left. Buttons keep BRAND — white 15px text on
// #0C7BFE is only 4.0:1, below WCAG AA for small text.
const HEADER_BG = "#0C7BFE";
// Absolute production URL so every environment's emails load the same file,
// and it must never move: sent emails reference it forever. The PNG is 2x
// (400x72) of the 200x36 box; Outlook only honours the width/height attributes.
const LOGO_URL = "https://portal.convergeapp.co/email/collegepond-logo-white.png";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A block of body content: paragraphs, an OTP box, a button, a list…
type Block =
  | { p: string } // plain text, escaped
  | { code: string }
  | { button: { label: string; url: string } }
  | { list: string[] }
  | { quote: string; label?: string };

function renderHtml(heading: string, greeting: string, blocks: Block[], preheader: string): string {
  const body = blocks
    .map((b) => {
      if ("p" in b) {
        return `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${MUTED};">${esc(b.p)}</p>`;
      }
      if ("code" in b) {
        return `<p style="margin:0 0 8px;font-size:15px;line-height:24px;color:${MUTED};">Your verification code is:</p>
<div style="margin:0 0 20px;padding:16px 0;border-radius:10px;background:#F2F7FF;text-align:center;font-size:32px;font-weight:700;letter-spacing:10px;color:${INK};font-family:'Courier New',Courier,monospace;">${esc(b.code)}</div>`;
      }
      if ("button" in b) {
        return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 24px;"><tr><td style="border-radius:8px;background:${BRAND};">
<a href="${esc(b.button.url)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(b.button.label)}</a>
</td></tr></table>`;
      }
      if ("list" in b) {
        const items = b.list
          .map((i) => `<li style="margin:0 0 6px;">${esc(i)}</li>`)
          .join("");
        return `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:24px;color:${INK};">${items}</ul>`;
      }
      return `<div style="margin:0 0 16px;padding:12px 16px;border-left:3px solid ${BRAND};background:#F9FAFB;font-size:15px;line-height:24px;color:${INK};">${
        b.label ? `<strong>${esc(b.label)}</strong><br>` : ""
      }${esc(b.quote).replace(/\n/g, "<br>")}</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#F2F4F7;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F7;padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td align="left" valign="middle" bgcolor="${HEADER_BG}" style="background:${HEADER_BG};padding:22px 32px;text-align:left;">
<img src="${LOGO_URL}" width="200" height="36" alt="Collegepond" border="0" style="display:block;border:0;outline:none;text-decoration:none;width:200px;max-width:200px;height:auto;color:#ffffff;font-size:20px;font-weight:700;line-height:36px;">
</td></tr>
<tr><td style="padding:32px;">
<h1 style="margin:0 0 20px;font-size:22px;line-height:30px;color:${INK};">${esc(heading)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${MUTED};">${esc(greeting)}</p>
${body}
<p style="margin:24px 0 0;font-size:15px;line-height:24px;color:${MUTED};">Thanks,<br><strong style="color:${INK};">Team Collegepond</strong></p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #EAECF0;font-size:12px;line-height:18px;color:#98A2B3;">
This is an automated message from Collegepond. Questions? Reply to this email or write to support@collegepond.com.
</td></tr>
</table></td></tr></table></body></html>`;
}

function renderText(heading: string, greeting: string, blocks: Block[]): string {
  const lines = [heading, "", greeting, ""];
  for (const b of blocks) {
    if ("p" in b) lines.push(b.p, "");
    else if ("code" in b) lines.push(`Your verification code is: ${b.code}`, "");
    else if ("button" in b) lines.push(`${b.button.label}: ${b.button.url}`, "");
    else if ("list" in b) lines.push(...b.list.map((i) => `  - ${i}`), "");
    else lines.push(...(b.label ? [b.label] : []), b.quote, "");
  }
  lines.push("Thanks,", "Team Collegepond");
  return lines.join("\n");
}

function build(
  subject: string,
  heading: string,
  greeting: string,
  blocks: Block[],
  preheader = subject,
): EmailMessage {
  return {
    subject,
    html: renderHtml(heading, greeting, blocks, preheader),
    text: renderText(heading, greeting, blocks),
  };
}

const hello = (name?: string | null) => (name?.trim() ? `Hello ${name.trim()},` : "Hello,");
const loginUrl = (appUrl: string) => `${appUrl.replace(/\/+$/, "")}/login`;

// ─── OTP codes ───────────────────────────────────────────────────────────────

// 1. Partner signup — email verification (wording from the business template).
export function signupOtpEmail(code: string): EmailMessage {
  return build(
    "Verify Your Email Address – Collegepond Partner Registration",
    "Welcome to Collegepond!",
    hello(),
    [
      { p: "Thank you for registering with Collegepond as a partner." },
      { p: "To verify your email address and complete the registration process, please use the One-Time Password (OTP) provided below." },
      { code },
      { p: "This code is valid for 5 minutes. Please do not share this code with anyone." },
      { p: "As part of the registration process, you will also receive an OTP on your registered mobile number for verification." },
      { p: "If you did not initiate this registration, please ignore this email." },
    ],
    `Your Collegepond verification code is ${code}`,
  );
}

// 2. Partner portal login (sent on every login).
export function partnerLoginOtpEmail(code: string): EmailMessage {
  return build(
    "Your Collegepond Partner Portal Login Code",
    "Sign in to Collegepond",
    hello(),
    [
      { p: "To securely access your Collegepond Partner Portal, please use the One-Time Password (OTP) provided below." },
      { code },
      { p: "This code is valid for 5 minutes. Please do not share this code with anyone." },
      { p: "If you did not request this code, please ignore this email." },
    ],
    `Your Collegepond login code is ${code}`,
  );
}

// 3. Collegepond staff (admin) login, when the admin code goes by email.
export function adminLoginOtpEmail(code: string): EmailMessage {
  return build(
    "Your Collegepond Admin Login Code",
    "Sign in to Collegepond Admin",
    hello(),
    [
      { p: "Use the One-Time Password (OTP) below to sign in to the Collegepond admin portal." },
      { code },
      { p: "This code is valid for 5 minutes. Please do not share this code with anyone." },
      { p: "If you did not try to sign in, please let the IT team know." },
    ],
    `Your Collegepond admin login code is ${code}`,
  );
}

// ─── Partner account lifecycle ───────────────────────────────────────────────

export interface PartnerRef {
  name: string;
  company?: string | null;
}

// 4. Super Admin approved the partner (subject from the business template).
export function partnerApprovedEmail(p: PartnerRef, appUrl: string): EmailMessage {
  return build(
    "Your Collegepond Partner Account Is Approved",
    "Welcome to Collegepond!",
    hello(p.name),
    [
      {
        p: p.company
          ? `We are pleased to inform you that the partner registration for ${p.company} with Collegepond has been approved.`
          : "We are pleased to inform you that your partner registration with Collegepond has been approved.",
      },
      { p: "You can now sign in to your Collegepond Partner Portal. Each time you sign in, we will email you a one-time code to keep your account secure." },
      { button: { label: "Log in to the Partner Portal", url: loginUrl(appUrl) } },
      { p: "We look forward to building a successful partnership with you." },
    ],
  );
}

// 5. Application declined.
export function partnerDeclinedEmail(p: PartnerRef, reason: string | null): EmailMessage {
  return build(
    "Update on Your Collegepond Partner Application",
    "About your partner application",
    hello(p.name),
    [
      { p: "Thank you for your interest in partnering with Collegepond. After reviewing your application, we are unable to approve it at this time." },
      ...(reason?.trim() ? [{ quote: reason.trim(), label: "Reason" } as Block] : []),
      { p: "If you believe this is a mistake, or your circumstances change, simply reply to this email and our team will be happy to take another look." },
    ],
  );
}

// 6. More information requested before a decision.
export function moreInfoRequestEmail(
  p: PartnerRef,
  req: { items: string[]; other?: string | null; message?: string | null },
): EmailMessage {
  const items = [...req.items, ...(req.other?.trim() ? [req.other.trim()] : [])];
  return build(
    "Action Needed: More Information for Your Collegepond Partner Application",
    "We need a few more details",
    hello(p.name),
    [
      { p: "Thank you for registering with Collegepond. To continue reviewing your partner application, we need the following from you:" },
      ...(items.length ? [{ list: items } as Block] : []),
      ...(req.message?.trim() ? [{ quote: req.message.trim(), label: "Message from our team" } as Block] : []),
      { p: "Please reply to this email with the requested information or documents. We will continue the review as soon as we receive them." },
    ],
  );
}

// 7. Account deactivated.
export function partnerDeactivatedEmail(p: PartnerRef, reason: string | null): EmailMessage {
  return build(
    "Your Collegepond Partner Account Has Been Deactivated",
    "Your account has been deactivated",
    hello(p.name),
    [
      { p: "Your Collegepond Partner Portal account has been deactivated, so you will not be able to sign in for now." },
      ...(reason?.trim() ? [{ quote: reason.trim(), label: "Reason" } as Block] : []),
      { p: "If you have questions or would like to reactivate your account, please reply to this email." },
    ],
  );
}

// 8. Account reactivated.
export function partnerReactivatedEmail(p: PartnerRef, appUrl: string): EmailMessage {
  return build(
    "Your Collegepond Partner Account Has Been Reactivated",
    "Welcome back!",
    hello(p.name),
    [
      { p: "Your Collegepond Partner Portal account is active again. You can sign in as usual." },
      { button: { label: "Log in to the Partner Portal", url: loginUrl(appUrl) } },
    ],
  );
}

// 10. A single signup document was rejected during review. There is no
// re-upload screen in the portal yet, so the partner replies with a new copy.
export function documentRejectedEmail(p: PartnerRef, documentName: string): EmailMessage {
  return build(
    `Action Needed: Please Re-send Your ${documentName}`,
    "A document needs your attention",
    hello(p.name),
    [
      { p: `While reviewing your Collegepond partner application, we were unable to accept the following document:` },
      { list: [documentName] },
      { p: "This usually happens when a scan is unclear, incomplete, or the wrong document was uploaded. Please reply to this email with a clear, complete copy (PDF, JPG or PNG) and we will continue the review." },
    ],
  );
}

// ─── Students & commissions ──────────────────────────────────────────────────

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const portal = (appUrl: string, path: string) => `${appUrl.replace(/\/+$/, "")}${path}`;

// 11. A student's university application moved to a new status.
export function applicationStatusEmail(
  p: PartnerRef,
  a: { studentName: string; university: string; program: string; status: string; note?: string | null },
  appUrl: string,
): EmailMessage {
  return build(
    `Application Update: ${a.studentName} – ${a.status}`,
    "Student application update",
    hello(p.name),
    [
      { p: `There is an update on ${a.studentName}'s application:` },
      {
        list: [
          `Student: ${a.studentName}`,
          `University: ${a.university}`,
          `Program: ${a.program}`,
          `New status: ${a.status}`,
        ],
      },
      ...(a.note?.trim() ? [{ p: a.note.trim() } as Block] : []),
      { button: { label: "View in the Partner Portal", url: portal(appUrl, "/partner/students") } },
    ],
  );
}

// 12. A commission claim (partner invoice) was approved, in full or in part.
export function commissionClaimApprovedEmail(
  p: PartnerRef,
  c: { invoiceNumber: string; amountInr: number; partial: boolean },
  appUrl: string,
): EmailMessage {
  return build(
    c.partial
      ? `Commission Claim ${c.invoiceNumber} Partially Approved`
      : `Commission Claim ${c.invoiceNumber} Approved`,
    c.partial ? "Your claim is partially approved" : "Your claim is approved",
    hello(p.name),
    [
      {
        p: c.partial
          ? `Your commission claim ${c.invoiceNumber} has been partially approved. We have approved the students for whom Collegepond has already received the commission from the university; the rest will follow once it arrives.`
          : `Your commission claim ${c.invoiceNumber} has been approved for payment.`,
      },
      { list: [`Amount approved: ${inr(c.amountInr)}`] },
      { p: "Our finance team will now release the payment to your registered bank account. You will receive another email once it has been sent." },
      { button: { label: "View in the Partner Portal", url: portal(appUrl, "/partner/commission") } },
    ],
  );
}

// 13. A commission claim was rejected.
export function commissionClaimRejectedEmail(
  p: PartnerRef,
  c: { invoiceNumber: string; reason: string },
  appUrl: string,
): EmailMessage {
  return build(
    `Commission Claim ${c.invoiceNumber} Not Approved`,
    "Your claim could not be approved",
    hello(p.name),
    [
      { p: `We were unable to approve your commission claim ${c.invoiceNumber}.` },
      { quote: c.reason, label: "Reason" },
      { p: "Once the issue is resolved you can submit a new claim from the Commission section of the Partner Portal. If you have questions, simply reply to this email." },
      { button: { label: "Go to Commission", url: portal(appUrl, "/partner/commission") } },
    ],
  );
}

// 14. A payout was released to the partner's bank.
export function payoutSentEmail(
  p: PartnerRef,
  pay: { invoiceNumber: string; amountInr: number; method: string; reference: string; paymentDate: string },
  appUrl: string,
): EmailMessage {
  return build(
    `Payment Sent: ${inr(pay.amountInr)} for Claim ${pay.invoiceNumber}`,
    "Your payment is on its way",
    hello(p.name),
    [
      { p: `We have released the payment for your commission claim ${pay.invoiceNumber}.` },
      {
        list: [
          `Amount: ${inr(pay.amountInr)}`,
          `Payment method: ${pay.method}`,
          `Reference / UTR: ${pay.reference}`,
          `Payment date: ${pay.paymentDate}`,
        ],
      },
      { p: "Depending on your bank, it may take up to 2 working days to appear in your account. If it has not arrived by then, reply to this email with the reference above." },
      { button: { label: "View Payment History", url: portal(appUrl, "/partner/commission") } },
    ],
  );
}

// ─── Agency counsellors & MOU ────────────────────────────────────────────────

// 15. An agency owner added this person as a counsellor (pending approval).
export function counsellorAddedEmail(
  c: { name: string; agency: string; addedBy: string },
  appUrl: string,
): EmailMessage {
  return build(
    `You've Been Added as a Counsellor at ${c.agency}`,
    "Welcome to Collegepond",
    hello(c.name),
    [
      { p: `${c.addedBy} has added you as a counsellor for ${c.agency} on the Collegepond Partner Portal.` },
      { p: "Our team will review the request shortly. Once it is approved, we will email you and you can sign in with this email address — we send a one-time code each time you sign in, so there is no password to remember." },
      { button: { label: "Go to the Partner Portal", url: loginUrl(appUrl) } },
      { p: "If you weren't expecting this, simply reply to this email and let us know." },
    ],
  );
}

// 16. Collegepond admin inbox: a counsellor is waiting for approval.
export function adminCounsellorPendingEmail(
  c: { name: string; email: string; phone: string; agency: string },
  appUrl: string,
): EmailMessage {
  return build(
    `New Counsellor Awaiting Approval: ${c.name} (${c.agency})`,
    "Counsellor awaiting approval",
    "Hello,",
    [
      { p: `${c.agency} has added a counsellor who needs approval before they can sign in.` },
      { list: [`Name: ${c.name}`, `Email: ${c.email}`, `Phone: ${c.phone}`, `Agency: ${c.agency}`] },
      { button: { label: "Review Counsellor Approvals", url: portal(appUrl, "/admin/counselor-approvals") } },
    ],
  );
}

// 17. The counsellor's own account was approved.
export function counsellorApprovedEmail(
  c: { name: string; agency: string },
  appUrl: string,
): EmailMessage {
  return build(
    "Your Collegepond Counsellor Account Is Approved",
    "You're all set!",
    hello(c.name),
    [
      { p: `Your counsellor account for ${c.agency} on the Collegepond Partner Portal has been approved.` },
      { p: "Sign in with this email address — we will email you a one-time code each time." },
      { button: { label: "Log in to the Partner Portal", url: loginUrl(appUrl) } },
    ],
  );
}

// 18. Agency owner: Collegepond decided on a counsellor they added.
export function counsellorDecisionOwnerEmail(
  p: PartnerRef,
  c: { counsellorName: string; approved: boolean; reason?: string | null },
  appUrl: string,
): EmailMessage {
  return build(
    c.approved
      ? `${c.counsellorName} Is Approved as a Counsellor`
      : `Counsellor Request for ${c.counsellorName} Not Approved`,
    c.approved ? "Counsellor approved" : "Counsellor request not approved",
    hello(p.name),
    [
      {
        p: c.approved
          ? `${c.counsellorName} has been approved as a counsellor for your agency and can now sign in to the Partner Portal.`
          : `We were unable to approve ${c.counsellorName} as a counsellor for your agency.`,
      },
      ...(!c.approved && c.reason?.trim() ? [{ quote: c.reason.trim(), label: "Reason" } as Block] : []),
      ...(!c.approved
        ? [{ p: "If you have questions, or would like to add someone else, simply reply to this email." } as Block]
        : []),
      { button: { label: "View Your Counsellors", url: portal(appUrl, "/partner/counsellors") } },
    ],
  );
}

// 19. Approved partner hasn't signed the partnership agreement (MOU) yet.
export function mouReminderEmail(p: PartnerRef, appUrl: string): EmailMessage {
  return build(
    "Reminder: Sign Your Collegepond Partner Agreement",
    "One last step to get started",
    hello(p.name),
    [
      {
        p: p.company
          ? `Your partner account for ${p.company} is approved, but the Collegepond partnership agreement (MOU) hasn't been signed yet.`
          : "Your partner account is approved, but the Collegepond partnership agreement (MOU) hasn't been signed yet.",
      },
      { p: "Signing takes a couple of minutes: log in to the Partner Portal and you will be taken straight to the agreement. You can start adding students as soon as it is signed." },
      { button: { label: "Log in and Sign the MOU", url: loginUrl(appUrl) } },
      { p: "If you have questions about the agreement, simply reply to this email." },
    ],
  );
}

// ─── Internal ────────────────────────────────────────────────────────────────

// 9. New partner signup → Collegepond admin inbox (ADMIN_EMAIL).
export function adminNewSignupEmail(
  a: {
    applicationId: string;
    name: string;
    email: string;
    phone: string;
    role: "agency" | "independent";
    company?: string | null;
    location?: string | null;
  },
  appUrl: string,
): EmailMessage {
  const who = a.company?.trim() ? `${a.name} (${a.company.trim()})` : a.name;
  return build(
    `New Partner Application: ${who}`,
    "New partner application",
    "Hello,",
    [
      { p: "A new partner application is waiting for review." },
      {
        list: [
          `Application ID: ${a.applicationId}`,
          `Type: ${a.role === "agency" ? "Agency" : "Independent counsellor"}`,
          `Name: ${a.name}`,
          ...(a.company?.trim() ? [`Company: ${a.company.trim()}`] : []),
          `Email: ${a.email}`,
          `Phone: ${a.phone}`,
          ...(a.location?.trim() ? [`Location: ${a.location.trim()}`] : []),
        ],
      },
      { button: { label: "Review in Partner Management", url: `${appUrl.replace(/\/+$/, "")}/admin/partners` } },
    ],
  );
}
