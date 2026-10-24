// Tuition conversion for Uni Assist, off the fx_rate table (mid-market INR
// per 1 unit; INR itself is the base and has no row). Mid-market, not the
// bank-margin "effective" rate: this compares fees, it doesn't quote money,
// so converted amounts are always labelled approximate.
export type InrRates = Record<string, number>;

// Uni Assist's home currency: fees show and filter in EUR until the user
// picks another.
export const HOME_CURRENCY = "EUR";

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  CAD: "C$",
  AUD: "A$",
  NZD: "NZ$",
  SGD: "S$",
  CHF: "CHF ",
  HKD: "HK$",
  JPY: "¥",
  INR: "₹",
};

function inrPerUnit(ccy: string, rates: InrRates): number | null {
  if (ccy === "INR") return 1;
  const r = rates[ccy];
  return r && r > 0 ? r : null;
}

// Null when either side has no rate (unknown currency, or rates not loaded).
export function convertAmount(
  amount: number,
  from: string | null,
  to: string,
  rates: InrRates,
): number | null {
  if (!from) return null;
  if (from === to) return amount;
  const f = inrPerUnit(from, rates);
  const t = inrPerUnit(to, rates);
  if (f === null || t === null) return null;
  return (amount * f) / t;
}

// "€18,000", "₹17,40,000", "CHF 12,000"; unknown codes fall back to "XYZ 100".
export function formatMoney(amount: number, currency: string | null): string {
  const ccy = currency ?? "";
  const n = Math.round(amount).toLocaleString(ccy === "INR" ? "en-IN" : "en-US");
  const sym = CURRENCY_SYMBOLS[ccy];
  return sym ? `${sym}${n}` : `${ccy} ${n}`.trim();
}

// ----- Tuition brackets (system_config "uni_assist_tuition_brackets") -------

// Per currency, ascending breakpoints. [10000, 20000] gives three brackets:
// under 10,000 / 10,000–20,000 / 20,000 and above.
export type BracketConfig = Record<string, number[]>;

export const DEFAULT_TUITION_BRACKETS: BracketConfig = {
  EUR: [10000, 15000, 20000, 30000, 40000],
  USD: [10000, 20000, 30000, 40000, 50000],
  GBP: [10000, 15000, 20000, 30000, 40000],
  INR: [1000000, 1500000, 2000000, 3000000, 4000000],
};

export interface TuitionBracket {
  // Kept as digit strings: they round-trip through FilterState / saved
  // templates as tuitionMin / tuitionMax ("" = open-ended).
  min: string;
  max: string;
  label: string;
}

export function bracketsFor(config: BracketConfig, currency: string): TuitionBracket[] {
  const points = [...(config[currency] ?? [])].filter((n) => n > 0).sort((a, b) => a - b);
  if (points.length === 0) return [];
  const out: TuitionBracket[] = [
    { min: "", max: String(points[0]), label: `Under ${formatMoney(points[0]!, currency)}` },
  ];
  for (let i = 1; i < points.length; i++) {
    out.push({
      min: String(points[i - 1]),
      max: String(points[i]),
      label: `${formatMoney(points[i - 1]!, currency)} – ${formatMoney(points[i]!, currency)}`,
    });
  }
  const last = points[points.length - 1]!;
  out.push({ min: String(last), max: "", label: `${formatMoney(last, currency)} and above` });
  return out;
}

// Half-open [min, max) so a fee on a breakpoint lands in exactly one bracket.
export function inBracket(fee: number, min: number | null, max: number | null): boolean {
  if (min !== null && fee < min) return false;
  if (max !== null && fee >= max) return false;
  return true;
}
