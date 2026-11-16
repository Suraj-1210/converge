// Resources library (16 Nov 2026): constants shared by the admin page, the
// partner page and the server. Client-safe (no server imports).

// resource.audience
export const ResourceAudience = {
  ALL: 0,
  OWNERS_AND_INDEPENDENTS: 1,
  AGENCY_COUNSELLORS: 2,
} as const;
export type ResourceAudience = (typeof ResourceAudience)[keyof typeof ResourceAudience];

export const RESOURCE_AUDIENCE_OPTIONS: { value: ResourceAudience; label: string }[] = [
  { value: ResourceAudience.ALL, label: "All partners" },
  { value: ResourceAudience.OWNERS_AND_INDEPENDENTS, label: "Agency owners and independent counsellors" },
  { value: ResourceAudience.AGENCY_COUNSELLORS, label: "Agency counsellors" },
];

export function audienceLabel(a: number): string {
  return RESOURCE_AUDIENCE_OPTIONS.find((o) => o.value === a)?.label ?? "All partners";
}

// resource.kind
export const ResourceKind = { FILE: 0, LINK: 1 } as const;
export type ResourceKind = (typeof ResourceKind)[keyof typeof ResourceKind];

// resource_download.action
export const ResourceAction = { DOWNLOAD: 0, PREVIEW: 1, LINK: 2 } as const;

// Uploads: 25 MB, and only these types, checked by content (magic bytes) on
// the server, not by extension alone.
export const RESOURCE_MAX_BYTES = 25 * 1024 * 1024;

export const RESOURCE_FILE_TYPES = {
  pdf: { mime: "application/pdf", label: "PDF", exts: ["pdf"] },
  jpg: { mime: "image/jpeg", label: "JPG", exts: ["jpg", "jpeg"] },
  png: { mime: "image/png", label: "PNG", exts: ["png"] },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word",
    exts: ["docx"],
  },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "PowerPoint",
    exts: ["pptx"],
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel",
    exts: ["xlsx"],
  },
  doc: { mime: "application/msword", label: "Word", exts: ["doc"] },
  ppt: { mime: "application/vnd.ms-powerpoint", label: "PowerPoint", exts: ["ppt"] },
  xls: { mime: "application/vnd.ms-excel", label: "Excel", exts: ["xls"] },
} as const;
export type ResourceFileType = keyof typeof RESOURCE_FILE_TYPES;

// For <input accept>.
export const RESOURCE_ACCEPT = Object.values(RESOURCE_FILE_TYPES)
  .flatMap((t) => t.exts.map((e) => `.${e}`))
  .join(",");

export function fileTypeLabel(mime: string): string {
  return Object.values(RESOURCE_FILE_TYPES).find((t) => t.mime === mime)?.label ?? "File";
}

// PDFs and images open in the browser; everything else downloads.
export function isPreviewable(mime: string | null | undefined): boolean {
  return mime === "application/pdf" || mime === "image/jpeg" || mime === "image/png";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Publish / expiry are calendar dates in India time.
const IST_OFFSET_MS = 330 * 60 * 1000;

// Today's date in India as "YYYY-MM-DD".
export function todayIstIso(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// "New" for 14 days from the publish date.
export const RESOURCE_NEW_DAYS = 14;

export function isNewResource(publishOnIso: string, now: Date = new Date()): boolean {
  const today = Date.parse(`${todayIstIso(now)}T00:00:00Z`);
  const published = Date.parse(`${publishOnIso}T00:00:00Z`);
  return today - published < RESOURCE_NEW_DAYS * 86_400_000;
}

// Where the file / link behind a resource is opened. Every partner open goes
// through this route so it is logged and the audience / dates are re-checked.
export function resourceOpenUrl(
  id: number,
  mode: "preview" | "download" | "open",
  opts: { versionId?: number; asAdmin?: boolean } = {},
): string {
  const q = new URLSearchParams({ mode });
  if (opts.versionId) q.set("v", String(opts.versionId));
  if (opts.asAdmin) q.set("as", "admin");
  return `/api/resources/${id}?${q.toString()}`;
}
