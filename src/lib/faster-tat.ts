// course.faster_tat — how quickly the university turns an application round
// when it's faster than standard. NULL (blank in the import) = standard.
// Shared by the importer, the course form and both Uni Assist pages.
export const FASTER_TAT_OPTIONS: Array<{ code: number; label: string }> = [
  { code: 1, label: "Same day" },
  { code: 2, label: "1–3 days" },
  { code: 3, label: "Within 7 days" },
];

export function fasterTatLabel(code: number | null | undefined): string | null {
  if (code == null) return null;
  return FASTER_TAT_OPTIONS.find((o) => o.code === code)?.label ?? null;
}

// Import cell → code. Accepts the labels (any dash, case-insensitive), the
// codes 1-3, and blank. `invalid` flags text we can't map.
export function parseFasterTat(
  v: string | number | boolean | null | undefined,
): { code: number | null; invalid: boolean } {
  if (v === null || v === undefined) return { code: null, invalid: false };
  if (typeof v === "number") {
    return FASTER_TAT_OPTIONS.some((o) => o.code === v)
      ? { code: v, invalid: false }
      : { code: null, invalid: true };
  }
  const s = String(v)
    .trim()
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ");
  if (!s || s === "standard" || s === "no" || s === "none") {
    return { code: null, invalid: false };
  }
  if (["1", "same day", "same-day"].includes(s)) return { code: 1, invalid: false };
  if (["2", "1-3 days", "1 - 3 days", "1-3"].includes(s)) return { code: 2, invalid: false };
  if (["3", "within 7 days", "7 days", "within a week"].includes(s)) {
    return { code: 3, invalid: false };
  }
  return { code: null, invalid: true };
}
