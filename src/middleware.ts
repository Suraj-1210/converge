import { NextResponse, type NextRequest } from "next/server";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";

const PARTNER_GATED_PATHS = ["/partner", "/mou-signing", "/pending-verification"];

function redirectTo(req: NextRequest, path: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ---- Admin gating ----
  if (pathname.startsWith("/admin")) {
    if (pathname === "/admin/login" || pathname === "/admin") {
      return NextResponse.next();
    }
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    const claims = token ? await verifySessionJwt(token) : null;
    if (!claims) return redirectTo(req, "/admin/login");
    return NextResponse.next();
  }

  // ---- Partner gating ----
  // /partner/*, /mou-signing, /pending-verification all require a valid
  // partner session. Status / MOU-signed gating is enforced at page level
  // (middleware runs in edge runtime, no DB access).
  const isPartnerGated = PARTNER_GATED_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (isPartnerGated) {
    const claims = await resolvePartnerSession(
      req.cookies.get(PARTNER_SESSION_COOKIE_NAME)?.value,
      req.cookies.get(SESSION_COOKIE_NAME)?.value,
      req.cookies.get(PARTNER_OWNER_SESSION_COOKIE_NAME)?.value,
    );
    if (!claims) return redirectTo(req, "/login");
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/partner/:path*",
    "/mou-signing",
    "/pending-verification",
  ],
};
