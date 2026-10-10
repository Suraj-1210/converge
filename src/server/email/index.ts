import "server-only";
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

export async function sendEmail(to: string, msg: EmailMessage): Promise<void> {
  if (!emailConfigured()) {
    if (env.NODE_ENV === "production") {
      throw new Error("Email is not configured (SES_*). Refusing to drop the message.");
    }
    // Dev only: show what would have been sent. Never runs in production.
    console.log(`[email:dev] to=${to} subject="${msg.subject}"\n${msg.text}\n[email:dev] end`);
    return;
  }

  const res = await ses().send(
    new SendEmailCommand({
      FromEmailAddress: env.EMAIL_FROM ?? DEFAULT_FROM,
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
