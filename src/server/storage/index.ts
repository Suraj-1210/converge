import "server-only";
import { randomUUID } from "node:crypto";
import { env } from "~/env";
import { readLocal, saveLocal } from "./local";
import { getObjectBuffer, publicUrl, putObject, spacesConfigured } from "./spaces";

export interface StoredFile {
  /**
   * The value to persist in the DB and later pass to `resolveStorageUrl`.
   * - Spaces (private): the object key, e.g. "student-docs/5/uuid-name.pdf".
   * - Spaces (public): the permanent public/CDN URL.
   * - Local dev: "/uploads/...".
   */
  url: string;
  /** Raw storage key (no host), e.g. "student-docs/5/uuid-name.pdf". */
  key: string;
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}

function sanitizeFolder(folder: string): string {
  return folder
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/");
}

// Persist a raw buffer at an explicit key (callers that build their own key,
// e.g. the student-doc route and the logo importer). Public objects get a
// permanent URL; private objects store the key and are served via /api/files.
export async function saveBuffer(
  buffer: Buffer,
  key: string,
  opts: { contentType?: string; public?: boolean } = {},
): Promise<StoredFile> {
  if (spacesConfigured()) {
    await putObject(key, buffer, {
      contentType: opts.contentType,
      public: opts.public,
    });
    return { key, url: opts.public ? publicUrl(key) : key };
  }
  // App Platform's filesystem is ephemeral — never silently write uploads there
  // in production (they'd vanish on the next deploy/restart).
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Spaces is not configured (SPACES_*); refusing to write uploads to the ephemeral local disk in production.",
    );
  }
  const local = await saveLocal(buffer, key);
  return { key, url: local.url };
}

// Reads back a file stored by saveBuffer, given the `url` it returned. For
// private files the app serves itself rather than redirecting to Spaces.
export async function readStoredFile(ref: string): Promise<Buffer> {
  if (ref.startsWith("/uploads/")) return readLocal(ref);
  if (isPrivateKey(ref) && spacesConfigured()) return getObjectBuffer(ref);
  throw new Error(`Can't read stored file ${ref}`);
}

export async function saveUpload(
  file: File,
  opts: { folder?: string; public?: boolean } = {},
): Promise<StoredFile> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const now = new Date();
  const yyyyMm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const folder = opts.folder ? sanitizeFolder(opts.folder) || yyyyMm : yyyyMm;
  const key = `${folder}/${randomUUID()}-${sanitizeFilename(file.name)}`;
  return saveBuffer(buffer, key, {
    contentType: file.type || undefined,
    public: opts.public,
  });
}

// Turns a stored value into a browser-usable URL. Full URLs (public Spaces
// objects, legacy values) and local "/uploads/..." paths pass through
// untouched; a bare Spaces key routes through the gated /api/files proxy.
export function resolveStorageUrl(ref: string): string;
export function resolveStorageUrl(ref: string | null | undefined): string | null;
export function resolveStorageUrl(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref) || ref.startsWith("/")) return ref;
  return `/api/files/${ref}`;
}

// Whether a stored value is a private Spaces object served via /api/files.
export function isPrivateKey(ref: string | null | undefined): boolean {
  return Boolean(ref && !/^https?:\/\//i.test(ref) && !ref.startsWith("/"));
}
