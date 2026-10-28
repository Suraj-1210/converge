import { NextResponse, type NextRequest } from "next/server";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";

const PARTNER_GATED_PATHS = ["/partner", "/mou-signing", "/pending-verification"];

// Sends a signed-out request to a login page. `?next=` carries the page they
// were on, so signing in again (or refreshing after a session ran out) brings
// them back to it instead of the dashboard. The login pages only honour a
// same-portal path (safeReturnPath in ~/lib/url-state).
function redirectTo(req: NextRequest, path: string, returnTo?: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  if (returnTo) url.searchParams.set("next", returnTo);
  return NextResponse.redirect(url);
}

// The page being opened, without Next's internal ?_rsc cache key (a client
// navigation's fetch carries one).
function returnPathFor(req: NextRequest): string | undefined {
  if (req.method !== "GET") return undefined;
  const params = new URLSearchParams(req.nextUrl.search);
  params.delete("_rsc");
  const qs = params.toString();
  return `${req.nextUrl.pathname}${qs ? `?${qs}` : ""}`;
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
    if (!claims) return redirectTo(req, "/admin/login", returnPathFor(req));
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
    if (!claims) {
      return redirectTo(req, "/login", pathname.startsWith("/partner/") ? returnPathFor(req) : undefined);
    }
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
