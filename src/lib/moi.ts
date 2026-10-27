// course.moi_accepted — whether the course accepts an MOI (Medium of
// Instruction) letter, i.e. English-medium prior education, in place of an
// English test. 1 = accepted, 0 = not accepted, NULL (blank) = unknown.
// Shared by the importer, the course API and form, and both Uni Assist pages.
export function moiLabel(v: boolean | null | undefined): string | null {
  if (v == null) return null;
  return v ? "MOI accepted" : "MOI not accepted";
}

// Yes / No / blank for exports and the import template.
export function moiYesNo(v: boolean | null | undefined): string {
  if (v == null) return "";
  return v ? "Yes" : "No";
}

export function moiFromDb(v: number | null | undefined): boolean | null {
  if (v == null) return null;
  return v === 1;
}

export function moiToDb(v: boolean | null | undefined): number | null {
  if (v == null) return null;
  return v ? 1 : 0;
}

// Import cell → value. Yes / No (any case, Y / N, 1 / 0, true / false) or
// blank. Unlike the other yes/no columns, anything else is an error rather
// than "No": a wrong "not accepted" would steer a student to a test they
// don't need. `invalid` flags text we can't map.
export function parseMoi(
  v: string | number | boolean | null | undefined,
): { value: boolean | null; invalid: boolean } {
  if (v === null || v === undefined) return { value: null, invalid: false };
  if (typeof v === "boolean") return { value: v, invalid: false };
  if (typeof v === "number") {
    if (v === 1) return { value: true, invalid: false };
    if (v === 0) return { value: false, invalid: false };
    return { value: null, invalid: true };
  }
  const s = String(v).trim().toLowerCase();
  if (!s) return { value: null, invalid: false };
  if (["yes", "y", "1", "true", "accepted"].includes(s)) return { value: true, invalid: false };
  if (["no", "n", "0", "false", "not accepted"].includes(s)) {
    return { value: false, invalid: false };
  }
  return { value: null, invalid: true };
}
