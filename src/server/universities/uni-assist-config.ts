import { db } from "~/server/db";
import {
  DEFAULT_TUITION_BRACKETS,
  type BracketConfig,
  type InrRates,
} from "~/lib/fx-convert";
import { loadInrRates as loadReferenceRates } from "~/server/fx-rates";

// INR-per-unit for Uni Assist's tuition conversion: the same reference rate
// every module uses (Settings › Exchange Rates, src/server/fx-rates.ts).
export async function loadInrRates(): Promise<{
  rates: InrRates;
  fetchedAt: string | null;
}> {
  const { rates, fetchedAt } = await loadReferenceRates();
  const out: InrRates = {};
  for (const [ccy, r] of Object.entries(rates)) if (ccy !== "INR") out[ccy] = r;
  return { rates: out, fetchedAt: fetchedAt ? fetchedAt.toISOString() : null };
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
