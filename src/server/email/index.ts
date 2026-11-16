import "server-only";
import { randomBytes } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env } from "~/env";
import type { EmailMessage } from "./templates";

// Transactional email delivery via Amazon SES (HTTPS API — App Platform blocks
// outbound SMTP). Templates live in ./templates; this module only delivers.
//
// Without SES config:
//   development  → the message is printed to the dev-server log, not sent
//   production   → sendEmail throws, so a missing config is loud, not silent

export * from "./templates";

const DEFAULT_FROM = "Collegepond <noreply@collegepond.com>";
const DEFAULT_REPLY_TO = "support@collegepond.com";
const DEFAULT_APP_URL = "https://portal.convergeapp.co";

export function emailConfigured(): boolean {
  return Boolean(env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY);
}

// Base URL for links in emails (login button, admin review link).
export function appUrl(): string {
  return env.APP_URL ?? DEFAULT_APP_URL;
}

let client: SESv2Client | null = null;
function ses(): SESv2Client {
  client ??= new SESv2Client({
    region: env.SES_REGION ?? "ap-south-1",
    credentials: {
      accessKeyId: env.SES_ACCESS_KEY_ID!,
      secretAccessKey: env.SES_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}

// A calendar invite riding on an email (src/server/ics.ts): REQUEST adds or
// updates the event, CANCEL removes it.
export interface EmailCalendar {
  method: "REQUEST" | "CANCEL";
  ics: string;
  fileName?: string;
}

export function emailFromAddress(): string {
  return env.EMAIL_FROM ?? DEFAULT_FROM;
}

export async function sendEmail(
  to: string,
  msg: EmailMessage,
  opts: { calendar?: EmailCalendar } = {},
): Promise<void> {
  if (!emailConfigured()) {
    if (env.NODE_ENV === "production") {
      throw new Error("Email is not configured (SES_*). Refusing to drop the message.");
    }
    // Dev only: show what would have been sent. Never runs in production.
    const cal = opts.calendar
      ? `\n[email:dev] calendar ${opts.calendar.fileName ?? "invite.ics"} (METHOD:${opts.calendar.method})\n${opts.calendar.ics}`
      : "";
    console.log(`[email:dev] to=${to} subject="${msg.subject}"\n${msg.text}${cal}\n[email:dev] end`);
    return;
  }

  if (opts.calendar) {
    // SES "Simple" content can't carry a text/calendar alternative, which is
    // what Gmail and Outlook turn into an invite, so this one goes as raw MIME.
    const res = await ses().send(
      new SendEmailCommand({
        FromEmailAddress: emailFromAddress(),
        Destination: { ToAddresses: [to] },
        Content: { Raw: { Data: buildCalendarMime(to, msg, opts.calendar) } },
        ConfigurationSetName: env.SES_CONFIGURATION_SET,
      }),
    );
    console.log(
      `[email] SES accepted "${msg.subject}" (calendar ${opts.calendar.method}) as ${res.MessageId ?? "(no id)"}`,
    );
    return;
  }

  const res = await ses().send(
    new SendEmailCommand({
      FromEmailAddress: emailFromAddress(),
      ReplyToAddresses: [env.EMAIL_REPLY_TO ?? DEFAULT_REPLY_TO],
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: msg.html, Charset: "UTF-8" },
            Text: { Data: msg.text, Charset: "UTF-8" },
          },
        },
      },
      // Optional: routes bounce/complaint/delivery events if one is set up.
      ConfigurationSetName: env.SES_CONFIGURATION_SET,
    }),
  );
  // The message id (never the address) lets a missing email be traced in SES.
  console.log(`[email] SES accepted "${msg.subject}" as ${res.MessageId ?? "(no id)"}`);
}

// ---- Raw MIME (calendar invites) -------------------------------------------
//
// multipart/mixed
//   multipart/alternative
//     text/plain
//     text/html
//     text/calendar; method=…   (the part mail clients turn into an invite)
//   invite.ics attachment       (for clients that only look at attachments)
// Every part is base64, so any UTF-8 is safe and no line passes 76 chars.

const ASCII = /^[\x20-\x7e]*$/;
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function b64Lines(data: string): string {
  return (Buffer.from(data, "utf-8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

// RFC 2047 encoded-word for a header value that isn't plain ASCII.
function headerText(s: string): string {
  const clean = oneLine(s);
  return ASCII.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf-8").toString("base64")}?=`;
}

// "Name <addr>" with the display name encoded when needed.
function headerAddress(s: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (!m) return oneLine(s);
  const name = oneLine(m[1]!);
  const addr = oneLine(m[2]!);
  if (!name) return addr;
  return ASCII.test(name) ? `"${name.replace(/"/g, "")}" <${addr}>` : `${headerText(name)} <${addr}>`;
}

export function buildCalendarMime(to: string, msg: EmailMessage, cal: EmailCalendar): Buffer {
  const mixed = `mixed_${randomBytes(12).toString("hex")}`;
  const alt = `alt_${randomBytes(12).toString("hex")}`;
  const file = (cal.fileName ?? "invite.ics").replace(/[^A-Za-z0-9._-]/g, "_");
  const part = (type: string, body: string, extra: string[] = []) =>
    [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra, "", b64Lines(body)].join("\r\n");
  const lines = [
    `From: ${headerAddress(emailFromAddress())}`,
    `To: ${oneLine(to)}`,
    `Reply-To: ${headerAddress(env.EMAIL_REPLY_TO ?? DEFAULT_REPLY_TO)}`,
    `Subject: ${headerText(msg.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    part("text/plain; charset=UTF-8", msg.text),
    `--${alt}`,
    part("text/html; charset=UTF-8", msg.html),
    `--${alt}`,
    part(`text/calendar; charset=UTF-8; method=${cal.method}`, cal.ics),
    `--${alt}--`,
    "",
    `--${mixed}`,
    part(`application/ics; name="${file}"`, cal.ics, [`Content-Disposition: attachment; filename="${file}"`]),
    `--${mixed}--`,
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf-8");
}
