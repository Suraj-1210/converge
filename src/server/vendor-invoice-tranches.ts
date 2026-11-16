// Which instalments (commission_tranche rows) a vendor invoice line bills.
//
// Since 16 Nov 2026 a commission can be invoiced instalment by instalment: a
// line links the tranches it bills through vendor_invoice_item_tranche, and an
// instalment can be on one invoice only. A line with no links bills the WHOLE
// commission (every line made before that, and commissions without tranche
// rows), so it covers every tranche.

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());

export type TrancheLinks = { vendor_invoice_item_tranche: { commission_tranche_id: number }[] };

// The select that loads a line's links.
export const TRANCHE_LINKS_SELECT = {
  vendor_invoice_item_tranche: { select: { commission_tranche_id: true } },
} as const;

/** True when the line bills every tranche of its commission (no links). */
export const isWholeCommissionLine = (it: TrancheLinks): boolean =>
  it.vendor_invoice_item_tranche.length === 0;

/** Does this line bill the tranche? */
export const lineBillsTranche = (it: TrancheLinks, trancheId: number): boolean =>
  isWholeCommissionLine(it) ||
  it.vendor_invoice_item_tranche.some((l) => l.commission_tranche_id === trancheId);

/** The line (of a commission's vendor invoice lines) that bills a tranche. */
export function lineForTranche<L extends TrancheLinks>(lines: L[], trancheId: number): L | null {
  return (
    lines.find((l) => l.vendor_invoice_item_tranche.some((x) => x.commission_tranche_id === trancheId)) ??
    lines.find(isWholeCommissionLine) ??
    null
  );
}

/**
 * The tranches a line bills, each with the fraction of the line's expected
 * amount it accounts for. A whole-commission line splits by tranche amount over
 * the commission's gross (as before instalment invoicing, so existing invoices
 * read exactly as they did); an instalment line splits by tranche amount over
 * the amounts of the tranches it bills.
 */
export function lineTrancheShares<T extends { id: number; amount: Decimalish }>(
  it: TrancheLinks,
  tranches: T[],
  gross: number,
): { tranche: T; fraction: number }[] {
  if (isWholeCommissionLine(it)) {
    return tranches.map((t) => ({ tranche: t, fraction: gross > 0 ? num(t.amount) / gross : 1 }));
  }
  const billed = tranches.filter((t) => lineBillsTranche(it, t.id));
  const base = billed.reduce((s, t) => s + num(t.amount), 0);
  return billed.map((t) => ({
    tranche: t,
    fraction: base > 0 ? num(t.amount) / base : 1 / billed.length,
  }));
}
