import { SignJWT, jwtVerify } from "jose";
import { env } from "~/env";

const SESSION_TTL = "8h";

// Distinct cookie names so admin and partner sessions can coexist on the
// same browser without colliding (e.g. devs logged into both at once).
export const SESSION_COOKIE_NAME = "cp_session";
export const PARTNER_SESSION_COOKIE_NAME = "cp_partner_session";

function secret(): Uint8Array {
  return new TextEncoder().encode(env.AUTH_SECRET);
}

// =============================================================================
// Admin session (collegepond_user)
// =============================================================================

export interface AdminSessionClaims {
  id: number;
  role: number;
  /** Set while a Super Admin is impersonating this staff user: the real admin. */
  realId?: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

// `realId` marks an impersonation session (sub = the impersonated staff user).
// `expiresAt` pins the expiry so starting/ending impersonation never extends
// the real admin's session past the original login's 8h.
export async function signSessionJwt(
  claims: { id: number; role: number; realId?: number },
  expiresAt?: number,
): Promise<string> {
  return new SignJWT({
    kind: "admin",
    role: claims.role,
    ...(claims.realId ? { imp: claims.realId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(claims.id))
    .setIssuedAt()
    .setExpirationTime(expiresAt ?? SESSION_TTL)
    .sign(secret());
}

export async function verifySessionJwt(
  token: string,
): Promise<AdminSessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.kind !== "admin") return null;
    if (typeof payload.sub !== "string") return null;
    if (typeof payload.role !== "number") return null;
    if (typeof payload.exp !== "number") return null;
    const id = Number(payload.sub);
    if (!Number.isInteger(id) || id <= 0) return null;
    const imp = payload.imp;
    if (imp !== undefined && (typeof imp !== "number" || !Number.isInteger(imp) || imp <= 0)) {
      return null;
    }
    return { id, role: payload.role, exp: payload.exp, ...(imp ? { realId: imp } : {}) };
  } catch {
    return null;
  }
}

// =============================================================================
// Partner session (user table — agency owner / independent counsellor)
// =============================================================================

export interface PartnerSessionClaims {
  id: number;
  /** Set while a Super Admin is impersonating this partner: the real admin. */
  impersonatorId?: number;
}

export async function signPartnerSessionJwt(
  claims: { id: number; impersonatorId?: number },
  expiresAt?: number,
): Promise<string> {
  return new SignJWT({
    kind: "partner",
    ...(claims.impersonatorId ? { imp: claims.impersonatorId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(claims.id))
    .setIssuedAt()
    .setExpirationTime(expiresAt ?? SESSION_TTL)
    .sign(secret());
}

export async function verifyPartnerSessionJwt(
  token: string,
): Promise<PartnerSessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.kind !== "partner") return null;
    if (typeof payload.sub !== "string") return null;
    const id = Number(payload.sub);
    if (!Number.isInteger(id) || id <= 0) return null;
    const imp = payload.imp;
    if (imp !== undefined && (typeof imp !== "number" || !Number.isInteger(imp) || imp <= 0)) {
      return null;
    }
    return { id, ...(imp ? { impersonatorId: imp } : {}) };
  } catch {
    return null;
  }
}

// Resolves the partner session for a request. An impersonation session is only
// honoured alongside the impersonating admin's own (non-impersonating) admin
// session, so signing out of the admin portal also ends any partner
// impersonation. Use this rather than verifyPartnerSessionJwt when
// authorizing a request.
export async function resolvePartnerSession(
  partnerToken: string | null | undefined,
  adminToken: string | null | undefined,
): Promise<PartnerSessionClaims | null> {
  if (!partnerToken) return null;
  const partner = await verifyPartnerSessionJwt(partnerToken);
  if (!partner?.impersonatorId) return partner;
  const admin = adminToken ? await verifySessionJwt(adminToken) : null;
  if (!admin || admin.realId || admin.id !== partner.impersonatorId) return null;
  return partner;
}
