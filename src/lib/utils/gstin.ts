// Indian GSTIN (GST Identification Number) validation, shared by the partner
// account form and the tRPC router so both sides apply the same rule.
//
// 15 characters, e.g. 27ABCPE1234F1Z5:
//   1–2   state code (01–38, 97 other territory, 99 centre jurisdiction)
//   3–12  the holder's PAN
//   13    entity number for that PAN in the state (1–9, then A–Z)
//   14    "Z" by default
//   15    check character (mod-36 checksum of the first 14)
//
// A wrong format or checksum is an error. A PAN or state that differs from
// what's on file is only a warning: the owner may know better (a new
// registration, an office that moved), and Collegepond re-verifies the
// certificate anyway.

import { normalizePan } from "~/lib/utils/pan";

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// GST state / UT codes → names, as the GST portal lists them.
export const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

// Older names / spellings partners may have on file for the same state.
const STATE_ALIASES: Record<string, string> = {
  orissa: "odisha",
  pondicherry: "puducherry",
  "nct of delhi": "delhi",
  "new delhi": "delhi",
  "daman and diu": "dadra and nagar haveli and daman and diu",
  "dadra and nagar haveli": "dadra and nagar haveli and daman and diu",
  "andaman and nicobar": "andaman and nicobar islands",
  "jammu & kashmir": "jammu and kashmir",
};

/** Uppercase and drop whitespace; everything that stores a GSTIN stores this. */
export function normalizeGstin(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

function checkChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]!);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

/** A user-facing error, or null when `raw` is a well-formed GSTIN. */
export function gstinError(raw: string): string | null {
  const g = normalizeGstin(raw);
  if (!g) return "GST number is required";
  if (g.length !== 15) return "A GST number is 15 characters (e.g. 27ABCPE1234F1Z5)";
  if (!GSTIN_FORMAT.test(g)) {
    return "Enter a valid GST number: 2-digit state code, 10-character PAN, then 3 characters (e.g. 27ABCPE1234F1Z5)";
  }
  if (!GST_STATE_CODES[g.slice(0, 2)]) return `${g.slice(0, 2)} isn't a GST state code`;
  if (checkChar(g.slice(0, 14)) !== g[14]) {
    return "This GST number's last character doesn't match — check it for a typo";
  }
  return null;
}

const canonState = (s: string) => {
  const k = s.trim().toLowerCase().replace(/\s+/g, " ").replace(/&/g, "and");
  return STATE_ALIASES[k] ?? STATE_ALIASES[s.trim().toLowerCase()] ?? k;
};

/**
 * Warnings for a well-formed GSTIN against what's on file: the PAN at
 * positions 3–12 should be the company PAN, and the state code the agency's
 * state. Unknown values on file give no warning.
 */
export function gstinWarnings(
  raw: string,
  onFile: { pan?: string | null; state?: string | null; country?: string | null },
): string[] {
  const g = normalizeGstin(raw);
  const out: string[] = [];
  const pan = onFile.pan ? normalizePan(onFile.pan) : "";
  if (pan && g.slice(2, 12) !== pan) {
    out.push(`The PAN inside this GST number (${g.slice(2, 12)}) doesn't match the company PAN on file (${pan}).`);
  }
  const stateName = GST_STATE_CODES[g.slice(0, 2)];
  const isIndia = !onFile.country || onFile.country.toUpperCase() === "IN";
  if (stateName && onFile.state && isIndia && canonState(stateName) !== canonState(onFile.state)) {
    out.push(`State code ${g.slice(0, 2)} is ${stateName}, but your business address is in ${onFile.state}.`);
  }
  return out;
}
