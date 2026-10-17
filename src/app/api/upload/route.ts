import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { saveUpload } from "~/server/storage";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024;

// Visibility is decided server-side by folder — never trust the client.
// Only non-sensitive public assets (university logos) are public-read.
const PUBLIC_FOLDERS = new Set(["uni-logos"]);

// Folder → who may upload there. signup/* is intentionally open (pre-auth),
// everything else requires the matching session. Unknown folders are rejected.
type FolderAuth = "admin" | "partner" | "public";
function folderPolicy(folder: string): FolderAuth | null {
  if (folder === "uni-logos") return "admin";
  if (folder === "avatars") return "partner";
  // Cancelled cheque / bank letter for payout bank details. Private.
  if (folder === "bank-proofs") return "partner";
  // Admin adding a partner's KYC document on their behalf (partners can't
  // upload until approved). Private, like the signup documents.
  if (/^partner-docs\/[a-zA-Z0-9._-]+$/.test(folder)) return "admin";
  if (/^signup\/(agency|independent)\/[a-zA-Z0-9._-]+$/.test(folder)) {
    return "public";
  }
  return null;
}

// Minimal in-process per-IP fixed-window limiter. Defense-in-depth for the
// open signup path; per-instance only (a shared store is the proper fix — see
// the OTP H1 finding).
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const ipHits = new Map<string, { count: number; windowStart: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hit = ipHits.get(ip);
  if (!hit || now - hit.windowStart > RATE_WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  hit.count += 1;
  return hit.count > RATE_LIMIT;
}

// Magic-byte sniff so a missing/spoofed Content-Type can't bypass the
// allow-list. Only PDF / JPEG / PNG are accepted.
function sniffMime(buf: Buffer): "application/pdf" | "image/jpeg" | "image/png" | null {
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "%PDF") {
    return "application/pdf";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  return null;
}

export async function POST(req: Request) {
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim();
  const ip = xff && xff.length > 0 ? xff : "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many uploads — please slow down" },
      { status: 429 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  const folderRaw = formData.get("folder");
  const folder = typeof folderRaw === "string" ? folderRaw : "";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  const policy = folderPolicy(folder);
  if (!policy) {
    return NextResponse.json({ error: "Invalid upload target" }, { status: 400 });
  }

  // Per-folder authorization.
  if (policy !== "public") {
    const jar = await cookies();
    const ok =
      policy === "admin"
        ? await verifySessionJwt(jar.get(SESSION_COOKIE_NAME)?.value ?? "")
        : await resolvePartnerSession(
            jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
            jar.get(SESSION_COOKIE_NAME)?.value,
            jar.get(PARTNER_OWNER_SESSION_COOKIE_NAME)?.value,
          );
    if (!ok) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Validate the actual bytes, not the (spoofable) Content-Type header.
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!sniffMime(buffer)) {
    return NextResponse.json(
      { error: "Unsupported file type (PDF, JPG, PNG only)" },
      { status: 415 },
    );
  }

  // Storage failures (e.g. Spaces creds missing/wrong in the deployed env) would
  // otherwise bubble up as an unhandled 500 → HTML body → the client falls back
  // to a useless "Upload failed". Return a clean, specific JSON error instead and
  // log the real cause server-side for diagnosis.
  let stored: Awaited<ReturnType<typeof saveUpload>>;
  try {
    stored = await saveUpload(file, { folder, public: PUBLIC_FOLDERS.has(folder) });
  } catch (e) {
    console.error("[upload] storage error:", e);
    const notConfigured = e instanceof Error && /spaces is not configured/i.test(e.message);
    return NextResponse.json(
      {
        error: notConfigured
          ? "File storage isn't set up on the server yet — please contact support."
          : "Couldn't save the file. Please try again, or contact support if it persists.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: stored.url });
}
