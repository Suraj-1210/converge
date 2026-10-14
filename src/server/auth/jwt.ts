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

export async function signSessionJwt(claims: {
  id: number;
  role: number;
}): Promise<string> {
  return new SignJWT({ kind: "admin", role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(claims.id))
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret());
}

export async function verifySessionJwt(
  token: string,
): Promise<{ id: number; role: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.kind !== "admin") return null;
    if (typeof payload.sub !== "string") return null;
    if (typeof payload.role !== "number") return null;
    const id = Number(payload.sub);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { id, role: payload.role };
  } catch {
    return null;
  }
}

// =============================================================================
// Partner session (user table — agency owner / independent counsellor)
// =============================================================================

export async function signPartnerSessionJwt(claims: {
  id: number;
}): Promise<string> {
  return new SignJWT({ kind: "partner" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(claims.id))
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret());
}

export async function verifyPartnerSessionJwt(
  token: string,
): Promise<{ id: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.kind !== "partner") return null;
    if (typeof payload.sub !== "string") return null;
    const id = Number(payload.sub);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { id };
  } catch {
    return null;
  }
}

// =============================================================================
// Contact verification proofs
// =============================================================================
//
// An agency owner adding a counsellor verifies the counsellor's email and phone
// OTPs in separate calls; each successful verify returns one of these, and
// addCounsellor / updateCounsellor require them, so a counsellor can only be
// saved with an email and phone that person controls. Bound to the exact
// address/number; never a session. (Staging also uses these for signup.)

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
