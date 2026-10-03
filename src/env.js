import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    DATABASE_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_SMS_TEMPLATE_ID: z.string().optional(),
    MSG91_EMAIL_TEMPLATE_ID: z.string().optional(),
    MSG91_EMAIL_FROM: z.string().optional(),
    MSG91_EMAIL_DOMAIN: z.string().optional(),
    // How the admin login code is delivered: "sms" (default) or "email". Staging
    // uses "email" so testers can sign in while MSG91 SMS delivery is unreliable.
    ADMIN_LOGIN_OTP_CHANNEL: z.enum(["sms", "email"]).optional(),
    // MSG91 email templates for transactional (non-OTP) mail. Optional — the
    // sender degrades to a minimal log until the template exists.
    MSG91_ADMIN_NOTIFY_TEMPLATE_ID: z.string().optional(),
    MSG91_MOREINFO_TEMPLATE_ID: z.string().optional(),
    // Partner account-lifecycle emails (approve / reject / deactivate /
    // reactivate). Optional — each degrades to a minimal log until set.
    MSG91_PARTNER_APPROVED_TEMPLATE_ID: z.string().optional(),
    MSG91_PARTNER_REJECTED_TEMPLATE_ID: z.string().optional(),
    MSG91_PARTNER_DEACTIVATED_TEMPLATE_ID: z.string().optional(),
    MSG91_PARTNER_REACTIVATED_TEMPLATE_ID: z.string().optional(),
    ADMIN_EMAIL: z.string().email().optional(),
    AUTH_SECRET: z.string().min(32),
    // Encrypts portal credentials at rest; falls back to AUTH_SECRET when
    // unset so existing environments keep working.
    CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),
    // DigitalOcean Spaces (S3-compatible) for file uploads in production.
    // When unset, uploads fall back to the local-disk backend (dev only).
    SPACES_KEY: z.string().optional(),
    SPACES_SECRET: z.string().optional(),
    SPACES_BUCKET: z.string().optional(),
    SPACES_REGION: z.string().optional(),
    // Regional S3 endpoint, e.g. https://blr1.digitaloceanspaces.com
    SPACES_ENDPOINT: z.string().url().optional(),
    // Optional CDN/origin base for PUBLIC objects (logos). Falls back to the
    // bucket origin URL derived from SPACES_ENDPOINT when unset.
    SPACES_CDN_URL: z.string().url().optional(),
    // DigitalOcean Managed MySQL CA certificate (PEM contents). When set, the DB
    // connection verifies TLS strictly (the cert is written to a temp file at
    // boot since App Platform's filesystem is ephemeral). Unset → local/dev, or
    // encrypted-but-unverified for a remote host.
    DATABASE_CA_CERT: z.string().optional(),
    // RazorpayX — partner payouts + bank-account verification. Optional: when
    // unset, payout release falls back to manual recording and bank-verify is
    // disabled. Use rzp_test_* keys for sandbox, rzp_live_* for production.
    // RAZORPAYX_ACCOUNT_NUMBER is the source virtual account (e.g. 2323230000000000).
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),
    // Secret configured on the RazorpayX webhook — verifies inbound payout events.
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY,
    MSG91_SMS_TEMPLATE_ID: process.env.MSG91_SMS_TEMPLATE_ID,
    MSG91_EMAIL_TEMPLATE_ID: process.env.MSG91_EMAIL_TEMPLATE_ID,
    MSG91_EMAIL_FROM: process.env.MSG91_EMAIL_FROM,
    MSG91_EMAIL_DOMAIN: process.env.MSG91_EMAIL_DOMAIN,
    ADMIN_LOGIN_OTP_CHANNEL: process.env.ADMIN_LOGIN_OTP_CHANNEL,
    MSG91_ADMIN_NOTIFY_TEMPLATE_ID: process.env.MSG91_ADMIN_NOTIFY_TEMPLATE_ID,
    MSG91_MOREINFO_TEMPLATE_ID: process.env.MSG91_MOREINFO_TEMPLATE_ID,
    MSG91_PARTNER_APPROVED_TEMPLATE_ID:
      process.env.MSG91_PARTNER_APPROVED_TEMPLATE_ID,
    MSG91_PARTNER_REJECTED_TEMPLATE_ID:
      process.env.MSG91_PARTNER_REJECTED_TEMPLATE_ID,
    MSG91_PARTNER_DEACTIVATED_TEMPLATE_ID:
      process.env.MSG91_PARTNER_DEACTIVATED_TEMPLATE_ID,
    MSG91_PARTNER_REACTIVATED_TEMPLATE_ID:
      process.env.MSG91_PARTNER_REACTIVATED_TEMPLATE_ID,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
    SPACES_KEY: process.env.SPACES_KEY,
    SPACES_SECRET: process.env.SPACES_SECRET,
    SPACES_BUCKET: process.env.SPACES_BUCKET,
    SPACES_REGION: process.env.SPACES_REGION,
    SPACES_ENDPOINT: process.env.SPACES_ENDPOINT,
    SPACES_CDN_URL: process.env.SPACES_CDN_URL,
    DATABASE_CA_CERT: process.env.DATABASE_CA_CERT,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
    RAZORPAYX_ACCOUNT_NUMBER: process.env.RAZORPAYX_ACCOUNT_NUMBER,
    RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
