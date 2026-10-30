// Shared formatting helpers for the admin + partner dashboards.
// Pure functions only — safe to import into any client/server component.

import { UniApplicationStatusLabel } from "~/server/db/enums";

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function timeAgo(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const s = Math.max(0, Math.floor((Date.now() - t.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function formatDate(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  return t.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatLongDate(d: Date): string {
  return d.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Indian-style compact currency: ₹2.4 Cr, ₹3.5 L, ₹12K, ₹950.
export function formatINR(amount: number): string {
  if (amount >= 1_00_00_000) return `₹${(amount / 1_00_00_000).toFixed(1)} Cr`;
  if (amount >= 1_00_000) return `₹${(amount / 1_00_000).toFixed(1)} L`;
  if (amount >= 1_000) return `₹${(amount / 1_000).toFixed(0)}K`;
  return `₹${amount}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function humanize(s: string): string {
  return s.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// UniApplicationStatusLabel is a Record over the enum; cast so a stray/unknown
// status code degrades gracefully instead of rendering "undefined".
export function stageLabel(status: number): string {
  const map = UniApplicationStatusLabel as Record<number, string | undefined>;
  return map[status] ?? `Stage ${status}`;
}

// Country codes are stored ISO2 (e.g. IE). Show the full name: flag emoji
// render as bare letters on Windows ("IE IE"), so the portal uses names
// (29 Oct testing). Common destinations are listed; anything else falls back
// to the browser's/Node's region names, then to the code itself.
const COUNTRY_NAMES: Record<string, string> = {
  GB: "United Kingdom",
  UK: "United Kingdom",
  US: "United States",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  IE: "Ireland",
  NZ: "New Zealand",
  FR: "France",
  NL: "Netherlands",
  SG: "Singapore",
  IT: "Italy",
  IN: "India",
};

let regionNames: Intl.DisplayNames | null | undefined;

export function countryName(code: string): string {
  const c = code.trim().toUpperCase();
  if (!c) return "";
  const known = COUNTRY_NAMES[c];
  if (known) return known;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    const name = c.length === 2 ? regionNames?.of(c) : undefined;
    return name?.trim() ? name : code;
  } catch {
    return code;
  }
}
