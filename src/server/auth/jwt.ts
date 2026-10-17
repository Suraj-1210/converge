import { SignJWT, jwtVerify } from "jose";
import { env } from "~/env";

const SESSION_TTL = "8h";

// Distinct cookie names so admin and partner sessions can coexist on the
// same browser without colliding (e.g. devs logged into both at once).
export const SESSION_COOKIE_NAME = "cp_session";
export const PARTNER_SESSION_COOKIE_NAME = "cp_partner_session";
// While an agency owner views the portal as one of their counsellors, their
// own partner session is parked here and cp_partner_session holds the
// counsellor's (see resolvePartnerSession).
export const PARTNER_OWNER_SESSION_COOKIE_NAME = "cp_partner_owner_session";

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
  /**
   * Set while an agency owner is viewing as this counsellor: the owner's
   * user id. Never set together with impersonatorId.
   */
  ownerImpersonatorId?: number;
  /** Expiry, epoch seconds. */
  exp?: number;
}

export async function signPartnerSessionJwt(
  claims: { id: number; impersonatorId?: number; ownerImpersonatorId?: number },
  expiresAt?: number,
): Promise<string> {
  return new SignJWT({
    kind: "partner",
    ...(claims.impersonatorId ? { imp: claims.impersonatorId } : {}),
    ...(claims.ownerImpersonatorId ? { own: claims.ownerImpersonatorId } : {}),
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
    const own = payload.own;
    if (own !== undefined && (typeof own !== "number" || !Number.isInteger(own) || own <= 0)) {
      return null;
    }
    // One impersonation at a time: a token claiming both is never issued.
    if (imp && own) return null;
    return {
      id,
      ...(imp ? { impersonatorId: imp } : {}),
      ...(own ? { ownerImpersonatorId: own } : {}),
      ...(typeof payload.exp === "number" ? { exp: payload.exp } : {}),
    };
  } catch {
    return null;
  }
}

// Resolves the partner session for a request. An impersonation session is only
// honoured alongside the impersonator's own session:
//   - Super Admin → partner: the admin's own (non-impersonating) admin session,
//     so signing out of the admin portal also ends the impersonation;
//   - agency owner → counsellor: the owner's own partner session, parked in
//     cp_partner_owner_session, which must itself be a plain session (not one
//     a Super Admin is impersonating).
// Use this rather than verifyPartnerSessionJwt when authorizing a request.
// Whether the owner still owns the counsellor's agency is checked per request
// in the tRPC partner procedures (this runs in edge middleware too: no DB).
export async function resolvePartnerSession(
  partnerToken: string | null | undefined,
  adminToken: string | null | undefined,
  ownerToken?: string | null,
): Promise<PartnerSessionClaims | null> {
  if (!partnerToken) return null;
  const partner = await verifyPartnerSessionJwt(partnerToken);
  if (partner?.ownerImpersonatorId) {
    const owner = ownerToken ? await verifyPartnerSessionJwt(ownerToken) : null;
    if (
      !owner ||
      owner.impersonatorId ||
      owner.ownerImpersonatorId ||
      owner.id !== partner.ownerImpersonatorId
    ) {
      return null;
    }
    return partner;
  }
  if (!partner?.impersonatorId) return partner;
  const admin = adminToken ? await verifySessionJwt(adminToken) : null;
  if (!admin || admin.realId || admin.id !== partner.impersonatorId) return null;
  return partner;
}

// =============================================================================
// Signup verification proofs
// =============================================================================
//
// Signup verifies the email and phone OTPs in separate calls before the form is
// submitted. Each successful verify returns one of these, and submitApplication
// requires both, so an application can only be filed for an email and phone the
// applicant controls. Bound to the exact address/number; never a session.

const SIGNUP_PROOF_TTL = "2h";

export type SignupProofChannel = "email" | "phone";
// "counsellor": an agency owner verified a counsellor's contact while adding
// them. Kept distinct so that proof can't be replayed into a public signup.
export type SignupProofPurpose = "signup" | "counsellor";

function signupProofKind(channel: SignupProofChannel, purpose: SignupProofPurpose) {
  return `${purpose}_${channel}_verified`;
}

/** `subject` is the lower-cased email or the E.164 digits of the phone. */
export async function signSignupProof(
  channel: SignupProofChannel,
  subject: string,
  purpose: SignupProofPurpose = "signup",
): Promise<string> {
  return new SignJWT({ kind: signupProofKind(channel, purpose) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(SIGNUP_PROOF_TTL)
    .sign(secret());
}

export async function verifySignupProof(
  token: string,
  channel: SignupProofChannel,
  subject: string,
  purpose: SignupProofPurpose = "signup",
): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    return payload.kind === signupProofKind(channel, purpose) && payload.sub === subject;
  } catch {
    return false;
  }
}
