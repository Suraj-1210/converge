import { db } from "~/server/db";
import { countryCodes } from "~/lib/constants/location-data";

// One partner account per email and per phone number, across every agency and
// independent. Used by public signup and by agency owners adding counsellors,
// so the same person can't end up as two records in two agencies.

// Phones are stored as country code + digits ("+919876543210"), but older rows
// carry spaces or dashes ("+91 98765 43210") or no country code at all, so
// numbers are compared on digits only.
export async function findPartnerByContact(
  email: string,
  countryCode: string,
  phone: string,
  excludeUserId?: number,
): Promise<{ id: number; matchedOn: "email" | "phone" } | null> {
  // No digits → match nothing by phone (never the rows with a blank phone).
  const local = phone.replace(/\D/g, "") || "-";
  const full = `${countryCode.replace(/\D/g, "")}${local}`;
  const rows = await db.$queryRaw<{ id: number; email: string }[]>`
    SELECT id, email FROM \`user\`
    WHERE (LOWER(email) = ${email.toLowerCase()}
           OR REGEXP_REPLACE(phone, '[^0-9]', '') IN (${full}, ${local}))
      AND id <> ${excludeUserId ?? 0}
    LIMIT 1`;
  const hit = rows[0];
  if (!hit) return null;
  return {
    id: Number(hit.id),
    matchedOn: hit.email.toLowerCase() === email.toLowerCase() ? "email" : "phone",
  };
}

// Splits a stored phone into the portal's country-code picker + local number.
// Falls back to an empty code when the stored value has none we recognise.
export function splitStoredPhone(stored: string): { countryCode: string; phone: string } {
  const compact = stored.replace(/[^\d+]/g, "");
  const code = countryCodes
    .map((c) => c.value)
    .sort((a, b) => b.length - a.length)
    .find((c) => compact.startsWith(c));
  return code
    ? { countryCode: code, phone: compact.slice(code.length) }
    : { countryCode: "", phone: compact.replace(/\D/g, "") };
}
