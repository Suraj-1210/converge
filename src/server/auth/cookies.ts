import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "~/server/auth/jwt";

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8; // matches the JWT TTL

// Session cookies are emitted via ctx.resHeaders: next/headers cookies() writes
// are dropped by the tRPC fetch handler and never reach the browser.
function cookie(name: string, value: string, maxAge: number): string {
  const attrs = [`${name}=${value}`, "HttpOnly", "Path=/", `Max-Age=${maxAge}`, "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

// Seconds left until a JWT `exp` (epoch seconds), for a cookie that must not
// outlive the session it carries.
export function maxAgeUntil(exp: number): number {
  return Math.max(0, exp - Math.floor(Date.now() / 1000));
}

export function buildSessionCookie(token: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return cookie(SESSION_COOKIE_NAME, token, maxAge);
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE_NAME, "", 0);
}

export function buildPartnerSessionCookie(token: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return cookie(PARTNER_SESSION_COOKIE_NAME, token, maxAge);
}

export function clearPartnerSessionCookie(): string {
  return cookie(PARTNER_SESSION_COOKIE_NAME, "", 0);
}

// The agency owner's own session, parked while they view as a counsellor.
export function buildPartnerOwnerSessionCookie(token: string, maxAge: number): string {
  return cookie(PARTNER_OWNER_SESSION_COOKIE_NAME, token, maxAge);
}

export function clearPartnerOwnerSessionCookie(): string {
  return cookie(PARTNER_OWNER_SESSION_COOKIE_NAME, "", 0);
}

// A cookie's raw value from request headers (tRPC context, route handlers).
export function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
