import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure, financeManagerProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// Currencies we convert to INR for estimates (INR is the base, never stored here).
// CHF/HKD/JPY: course currencies Uni Assist converts tuition from.
export const FX_CURRENCIES = ["USD", "GBP", "EUR", "AUD", "CAD", "NZD", "SGD", "CHF", "HKD", "JPY"];
// Free, no-key, daily mid-market feed (USD base; rates[X] = X per 1 USD).
const FEED_URL = "https://open.er-api.com/v6/latest/USD";
const FEED_SOURCE = "open.er-api.com";

// Effective INR-per-unit shown/used for estimates: a manual override wins, else
// mid-market minus the configured bank margin %.
export function effectiveRate(midRate: number, marginPct: number, manualRate: number | null): number {
  if (manualRate != null) return manualRate;
  return Math.round(midRate * (1 - marginPct / 100) * 100) / 100;
}

// Pull mid-market INR-per-unit for our currencies from the feed.
async function fetchMidRates(): Promise<Record<string, number>> {
  const res = await fetch(FEED_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`FX feed returned HTTP ${res.status}`);
  const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
  if (data.result !== "success" || !data.rates) throw new Error("FX feed returned no rates");
  const inrPerUsd = data.rates.INR;
  if (!inrPerUsd || inrPerUsd <= 0) throw new Error("FX feed missing INR");
  const out: Record<string, number> = {};
  for (const cur of FX_CURRENCIES) {
    const perUsd = data.rates[cur];
    if (perUsd && perUsd > 0) out[cur] = Math.round((inrPerUsd / perUsd) * 10000) / 10000;
  }
  return out;
}

// Shared refresh used by the Settings "Refresh" button + the /api/cron/fx route.
export async function refreshFxRates(): Promise<{ updated: number; source: string }> {
  const mids = await fetchMidRates();
  const now = new Date();
  const entries = Object.entries(mids);
  await Promise.all(
    entries.map(([currency, mid]) =>
      db.fx_rate.upsert({
        where: { currency },
        update: { mid_rate: mid, source: FEED_SOURCE, fetched_at: now },
        create: { currency, mid_rate: mid, source: FEED_SOURCE, fetched_at: now },
      }),
    ),
  );
  return { updated: entries.length, source: FEED_SOURCE };
}

export const fxRouter = createTRPCRouter({
  // Any admin can view the rates.
  list: protectedAdminProcedure.query(async () => {
    const rows = await db.fx_rate.findMany({ orderBy: { currency: "asc" } });
    return rows.map((r) => {
      const mid = Number(r.mid_rate);
      const margin = Number(r.margin_pct);
      const manual = r.manual_rate != null ? Number(r.manual_rate) : null;
      return {
        currency: r.currency,
        midRate: mid,
        marginPct: margin,
        manualRate: manual,
        effectiveRate: effectiveRate(mid, margin, manual),
        source: r.source,
        fetchedAt: r.fetched_at ? r.fetched_at.toISOString() : null,
        updatedAt: r.updated_at.toISOString(),
      };
    });
  }),

  // Pull fresh mid-market rates from the feed.
  refresh: financeManagerProcedure.mutation(async () => {
    try {
      return await refreshFxRates();
    } catch (e) {
      throw new TRPCError({ code: "BAD_GATEWAY", message: e instanceof Error ? e.message : "FX feed failed" });
    }
  }),

  // Edit the bank margin and/or a manual override for one currency.
  update: financeManagerProcedure
    .input(
      z.object({
        currency: z.string().length(3),
        marginPct: z.number().min(0).max(20).optional(),
        manualRate: z.number().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const data: { margin_pct?: number; manual_rate?: number | null } = {};
      if (input.marginPct !== undefined) data.margin_pct = input.marginPct;
      if (input.manualRate !== undefined) data.manual_rate = input.manualRate;
      await db.fx_rate.update({ where: { currency: input.currency }, data });
      return { ok: true as const };
    }),

  // Clear a currency's manual override so its effective rate tracks the live
  // mid-market feed again (mid − margin). The bank margin is left untouched.
  reset: financeManagerProcedure
    .input(z.object({ currency: z.string().length(3) }))
    .mutation(async ({ input }) => {
      await db.fx_rate.update({
        where: { currency: input.currency },
        data: { manual_rate: null },
      });
      return { ok: true as const };
    }),
});
