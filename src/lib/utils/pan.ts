// Indian PAN (Permanent Account Number) validation, shared by the client forms
// and the tRPC routers so both sides enforce exactly the same rule.
//
// Format: 5 letters, 4 digits, 1 letter — e.g. ABCPE1234F. The 4th character
// is the holder type:
//   A  Association of Persons     G  Government agency
//   B  Body of Individuals        H  Hindu Undivided Family
//   C  Company                    J  Artificial juridical person
//   F  Firm / LLP / partnership   L  Local authority
//   P  Individual                 T  Trust
//
// Which holder types are accepted depends on who is signing up:
//   agency      C, F or P — a sole proprietorship has no PAN of its own and
//               uses the proprietor's individual PAN, so P is allowed too.
//   individual  P only (independent counsellors).

import { z } from "zod";

export type PanHolder = "agency" | "individual";

const PAN_FORMAT = /^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$/;

export const PAN_HOLDER_TYPES: Record<PanHolder, readonly string[]> = {
  agency: ["C", "F", "P"],
  individual: ["P"],
};

// Uppercase and drop whitespace, so "abcpe 1234f" and "ABCPE1234F" are the
// same PAN. Everything that stores a PAN stores the normalised form.
export function normalizePan(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

// Returns a user-facing error, or null when `raw` is a valid PAN for `holder`.
// Blank input is reported as missing; callers decide whether PAN is required.
export function panError(raw: string, holder: PanHolder): string | null {
  const pan = normalizePan(raw);
  if (!pan) return "PAN is required";
  if (!PAN_FORMAT.test(pan)) {
    return "Enter a valid PAN: 5 letters, 4 digits, 1 letter (e.g. ABCPE1234F)";
  }
  if (!PAN_HOLDER_TYPES[holder].includes(pan[3]!)) {
    return holder === "agency"
      ? "Use the company, firm/LLP or proprietor PAN (4th character C, F or P)"
      : "Use your personal PAN (4th character P)";
  }
  return null;
}

// PAN is mandatory only for India-based partners: an agency whose country is
// India, or an independent counsellor with an Indian (+91) phone number.
// Elsewhere it is optional, but still validated when entered.
export function isPanRequired(
  role: "agency" | "independent",
  ctx: { country?: string | null; countryCode?: string | null },
): boolean {
  return role === "agency"
    ? ctx.country?.toUpperCase() === "IN"
    : ctx.countryCode === "+91";
}

// Optional PAN for server inputs: blank → undefined, otherwise normalised and
// checked against the holder rule.
export function optionalPanSchema(holder: PanHolder) {
  return z
    .string()
    .optional()
    .transform((v) => (v ? normalizePan(v) : ""))
    .superRefine((v, ctx) => {
      if (!v) return;
      const msg = panError(v, holder);
      if (msg) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
    })
    .transform((v) => v || undefined);
}
