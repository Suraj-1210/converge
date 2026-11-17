import { db } from "~/server/db";
import { effectiveRate } from "~/server/api/routers/fx";

// One source for ₹ estimates of foreign-currency amounts: the stored
// Settings › Exchange Rates (effective = manual override, else mid − bank
// margin). University Billing and the Finance dashboard both read this, so
// their ₹ figures agree. A currency with no stored rate is NOT guessed at:
// it is reported as "not converted" so the page can say so.

export type InrRates = { rates: Record<string, number>; fetchedAt: Date | null };

export async function loadInrRates(): Promise<InrRates> {
  const rows = await db.fx_rate.findMany();
  const rates: Record<string, number> = { INR: 1 };
  let fetchedAt: Date | null = null;
  for (const r of rows) {
    const rate = effectiveRate(
      Number(r.mid_rate),
      Number(r.margin_pct),
      r.manual_rate == null ? null : Number(r.manual_rate),
    );
    if (rate > 0) rates[r.currency] = rate;
    if (r.fetched_at && (!fetchedAt || r.fetched_at > fetchedAt)) fetchedAt = r.fetched_at;
  }
  return { rates, fetchedAt };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The reference rate for BOOKING money in ₹ (e.g. a bonus becoming
 * claimable). If the currency has no stored rate, refresh from the feed once;
 * if there's still none, refuse rather than guess.
 */
export async function bookingInrRate(currency: string): Promise<number> {
  if (currency === "INR") return 1;
  let fx = await loadInrRates();
  if (fx.rates[currency] == null) {
    const { refreshFxRates } = await import("~/server/api/routers/fx");
    await refreshFxRates().catch(() => undefined);
    fx = await loadInrRates();
  }
  const rate = fx.rates[currency];
  if (rate == null) {
    throw new Error(`No exchange rate for ${currency}. Refresh Settings › Exchange Rates and try again.`);
  }
  return rate;
}

/** ₹ for an amount, or null when the currency has no stored rate. */
export function inrOf(rates: InrRates, amount: number, currency: string | null | undefined): number | null {
  const ccy = currency ?? "INR";
  const rate = rates.rates[ccy];
  return rate == null ? null : round2(amount * rate);
}

/**
 * Sums amounts into ₹, keeping whatever couldn't be converted per currency.
 * `notConverted` is { USD: 1500 } etc. — shown as "+ $1,500 not converted".
 */
export function inrAccumulator(rates: InrRates) {
  let inr = 0;
  const notConverted: Record<string, number> = {};
  return {
    add(amount: number, currency: string | null | undefined) {
      if (!amount) return;
      const v = inrOf(rates, amount, currency);
      if (v == null) {
        const ccy = currency ?? "INR";
        notConverted[ccy] = round2((notConverted[ccy] ?? 0) + amount);
      } else inr += v;
    },
    result() {
      return { inr: round2(inr), notConverted };
    },
  };
}
