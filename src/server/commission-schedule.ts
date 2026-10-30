import { CommissionType } from "~/server/db/enums";

// A contract's tranche schedule (commission_tranche_template rows) has to add
// up to the agreed commission, or Approve commission would split it wrongly
// (testers, 29 Oct 2026). Either every tranche is a % and they total 100%, or
// — on a FLAT deal only — every tranche is a fixed amount and they total the
// flat amount. Up to 4 tranches, direct and vendor contracts alike.

export type TrancheTemplateLike = { pct: number | null; amount: number | null };

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

// Why this schedule can't split `gross` (null = fine). `gross` is the flat
// amount on a FLAT deal; ignored on a percentage deal.
export function trancheScheduleIssue(
  tranches: TrancheTemplateLike[],
  commissionType: number | null,
  gross: number | null,
): string | null {
  if (tranches.length === 0) return null;
  const pcts = tranches.filter((t) => t.pct != null);
  const amounts = tranches.filter((t) => t.pct == null && t.amount != null);
  if (pcts.length + amounts.length !== tranches.length) {
    return "Every tranche needs a percentage or an amount.";
  }
  if (pcts.length > 0 && amounts.length > 0) {
    return "Use percentages for every tranche, or amounts for every tranche — not a mix.";
  }
  if (pcts.length > 0) {
    const total = pcts.reduce((s, t) => s + t.pct!, 0);
    return near(total, 100) ? null : `The tranches total ${fmt(total)}% — they must total 100%.`;
  }
  if (commissionType !== CommissionType.FLAT) {
    return "A percentage deal's tranches must be percentages (the commission depends on the tuition).";
  }
  const total = amounts.reduce((s, t) => s + t.amount!, 0);
  if (gross == null) return null;
  return near(total, gross)
    ? null
    : `The tranche amounts total ${fmt(total)} — they must total the flat commission of ${fmt(gross)}.`;
}

// Would adding/editing one tranche push the schedule over the agreed total?
// Checked on save so the editor can't overshoot; an under-total schedule is
// allowed while it's being built (it shows a warning, and Approve commission
// refuses it).
export function trancheOvershoot(
  tranches: TrancheTemplateLike[],
  commissionType: number | null,
  gross: number | null,
): string | null {
  const pctTotal = tranches.reduce((s, t) => s + (t.pct ?? 0), 0);
  if (pctTotal > 100.005) return `That makes the tranches total ${fmt(pctTotal)}% — more than 100%.`;
  if (commissionType === CommissionType.FLAT && gross != null) {
    const amtTotal = tranches.reduce((s, t) => s + (t.pct == null ? (t.amount ?? 0) : 0), 0);
    if (amtTotal > gross + 0.005) {
      return `That makes the tranche amounts total ${fmt(amtTotal)} — more than the flat commission of ${fmt(gross)}.`;
    }
  }
  return null;
}
