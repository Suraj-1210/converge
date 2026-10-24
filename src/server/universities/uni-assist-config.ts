import { db } from "~/server/db";
import {
  DEFAULT_TUITION_BRACKETS,
  type BracketConfig,
  type InrRates,
} from "~/lib/fx-convert";

// Mid-market INR-per-unit from fx_rate, for Uni Assist's tuition conversion.
// Refreshed by Settings → Exchange Rates (or /api/cron/fx when scheduled).
export async function loadInrRates(): Promise<{
  rates: InrRates;
  fetchedAt: string | null;
}> {
  const rows = await db.fx_rate.findMany({
    select: { currency: true, mid_rate: true, fetched_at: true },
  });
  const rates: InrRates = {};
  let latest: Date | null = null;
  for (const r of rows) {
    const mid = Number(r.mid_rate);
    if (mid > 0) rates[r.currency] = mid;
    if (r.fetched_at && (!latest || r.fetched_at > latest)) latest = r.fetched_at;
  }
  return { rates, fetchedAt: latest ? latest.toISOString() : null };
}

// Tuition bracket breakpoints per currency (Settings → Uni Assist Brackets).
// system_config key → JSON; defaults fill currencies never saved.
export const BRACKETS_CONFIG_KEY = "uni_assist_tuition_brackets";

export async function loadBracketConfig(): Promise<BracketConfig> {
  const row = await db.system_config.findUnique({
    where: { config_key: BRACKETS_CONFIG_KEY },
  });
  if (!row) return DEFAULT_TUITION_BRACKETS;
  try {
    const stored = JSON.parse(row.value) as BracketConfig;
    return { ...DEFAULT_TUITION_BRACKETS, ...stored };
  } catch {
    return DEFAULT_TUITION_BRACKETS;
  }
}

export async function saveBracketConfig(config: BracketConfig): Promise<void> {
  const value = JSON.stringify(config);
  await db.system_config.upsert({
    where: { config_key: BRACKETS_CONFIG_KEY },
    create: { config_key: BRACKETS_CONFIG_KEY, value },
    update: { value },
  });
}
