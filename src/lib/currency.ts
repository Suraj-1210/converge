// Money display + the currency list for finance (vendors, contracts, vendor
// invoices, partner payouts). Symbols come from fx-convert's CURRENCY_SYMBOLS so
// Uni Assist and finance agree; finance shows paise/cents, Uni Assist doesn't.
import { CURRENCY_SYMBOLS } from "~/lib/fx-convert";

// INR first (the house currency), then the common contract currencies.
export const FINANCE_CURRENCIES = [
  "INR", "USD", "GBP", "EUR", "CAD", "AUD", "NZD", "SGD", "CHF", "HKD", "JPY",
] as const;
export type FinanceCurrency = (typeof FINANCE_CURRENCIES)[number];

export const isFinanceCurrency = (c: string | null | undefined): c is FinanceCurrency =>
  c != null && (FINANCE_CURRENCIES as readonly string[]).includes(c);

export const currencySymbol = (ccy: string | null | undefined): string =>
  (ccy && CURRENCY_SYMBOLS[ccy]) ?? (ccy ? `${ccy} ` : "");

// Dropdown options: "EUR (€)".
export const CURRENCY_OPTIONS = FINANCE_CURRENCIES.map((c) => ({
  value: c,
  label: `${c} (${(CURRENCY_SYMBOLS[c] ?? c).trim()})`,
}));

// "€5,342.50", "₹4,91,998", "CHF 1,200". Whole numbers drop the decimals.
export function money(amount: number, ccy: string | null | undefined): string {
  const c = ccy ?? "";
  const n = amount.toLocaleString(c === "INR" ? "en-IN" : "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const sym = currencySymbol(c);
  return sym ? `${sym}${n}` : n;
}

// "€5,342 × 92.10 = ₹4,91,998" — a foreign amount at the rate it was booked.
export function fxLine(foreign: number, ccy: string, rate: number, inr: number): string {
  if (ccy === "INR") return money(inr, "INR");
  return `${money(foreign, ccy)} × ${rate.toFixed(2)} = ${money(inr, "INR")}`;
}
