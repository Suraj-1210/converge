import { TrancheStatus } from "~/server/db/enums";

// Which instalments (commission_tranche rows) a vendor invoice line bills.
//
// Since 16 Nov 2026 a commission can be invoiced instalment by instalment: a
// line links the tranches it bills through vendor_invoice_item_tranche, and an
// instalment can be on one invoice only. A line with no links bills the WHOLE
// commission (every line made before that, and commissions without tranche
// rows), so it covers every tranche.

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
const round2 = (n: number) => Math.round(n * 100) / 100;

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

// ---- Collection (moved from the University Billing router, 16 Nov 2026, so
// ~/server/adjustments reads an invoice's outstanding the same way) ----

// A tranche counts as collected once Finance has recorded the vendor's
// payment for it — awaiting approval (COLLECTED) or approved and claimable
// (RECEIVED) — and stays so once it's paid out to the partner.
export const isCollected = (status: number) =>
  status === TrancheStatus.COLLECTED ||
  status === TrancheStatus.RECEIVED ||
  status === TrancheStatus.PAID;

// A vendor invoice line with what's needed to split it into the instalments it
// bills (see ~/server/vendor-invoice-tranches).
type CollectLine = TrancheLinks & {
  expected_amount: Decimalish;
  commission: {
    commision_amount: Decimalish;
    collegepond_received_at: Date | null;
    commission_tranche: { id: number; seq: number; name: string | null; status: number; amount: Decimalish }[];
  };
};

// An invoice's instalments by seq — only the tranches its lines bill — with
// what's invoiced and still to collect (invoice currency), plus the invoice's
// outstanding and collected totals. A pre-tranche commission (no tranche rows)
// counts as collected once its commission-level stamp is set.
export function invoiceCollection(items: CollectLine[]) {
  const bySeq = new Map<
    number,
    { seq: number; name: string | null; students: number; uncollected: number; expected: number; uncollectedExpected: number }
  >();
  let outstanding = 0;
  let collected = 0;
  for (const it of items) {
    const expected = num(it.expected_amount);
    const ts = it.commission.commission_tranche;
    if (ts.length === 0) {
      if (it.commission.collegepond_received_at == null) outstanding += expected;
      else collected += expected;
      continue;
    }
    for (const { tranche: t, fraction } of lineTrancheShares(it, ts, num(it.commission.commision_amount))) {
      const slice = expected * fraction;
      const e = bySeq.get(t.seq) ?? { seq: t.seq, name: t.name, students: 0, uncollected: 0, expected: 0, uncollectedExpected: 0 };
      // Students whose instalments are named differently share a neutral
      // label ("Instalment <seq>") rather than the first student's name.
      if (e.students > 0 && e.name !== t.name) e.name = null;
      e.students += 1;
      e.expected += slice;
      if (isCollected(t.status)) {
        collected += slice;
      } else {
        e.uncollected += 1;
        e.uncollectedExpected += slice;
        outstanding += slice;
      }
      bySeq.set(t.seq, e);
    }
  }
  const tranches = Array.from(bySeq.values())
    .sort((a, b) => a.seq - b.seq)
    .map((t) => ({ ...t, expected: round2(t.expected), uncollectedExpected: round2(t.uncollectedExpected) }));
  return { tranches, outstanding: round2(outstanding), collected: round2(collected) };
}

export const COLLECT_LINE_SELECT = {
  ...TRANCHE_LINKS_SELECT,
  expected_amount: true,
} as const;
export const COLLECT_COMMISSION_SELECT = {
  commision_amount: true,
  collegepond_received_at: true,
  commission_tranche: {
    orderBy: { seq: "asc" as const },
    select: { id: true, seq: true, name: true, status: true, amount: true, amount_inr: true },
  },
} as const;
