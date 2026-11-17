import "server-only";
import { TRPCError } from "@trpc/server";
import { inrOf, loadInrRates } from "~/server/fx-rates";
import { db } from "~/server/db";
import {
  AdjustmentDirection,
  AdjustmentSide,
  AdjustmentStatus,
  VendorInvoiceStatus,
  financialYearOf,
} from "~/server/db/enums";
import { payeeWhere, type Payee } from "~/server/payee";
import {
  COLLECT_COMMISSION_SELECT,
  COLLECT_LINE_SELECT,
  invoiceCollection,
  lineForTranche,
} from "~/server/vendor-invoice-tranches";

// The Adjustments ledger (16 Nov 2026). Suraj: an overriding deduction "in the
// event a partner commits fraud and we have the payment, or the student
// returns and the university deducts the amount from our calculation ...
// there can be others."
//
// An adjustment is its own dated, append-only record. The original commission,
// invoice, payment and payout rows are never edited. An APPROVED adjustment is
// applied through adjustment_allocation rows, and its balance is
// amount − SUM(allocations):
//
//   UNIVERSITY side (what the university / vendor owes Collegepond):
//     on approval it's allocated to its own vendor invoice if that's still
//     open, then to the same counterparty's other open invoices in that
//     currency, oldest first. Whatever is left (the money was already
//     collected) stands as a credit and is allocated to the counterparty's next
//     invoice when it's raised. An invoice's outstanding is
//     instalment outstanding − deductions + credits allocated to it.
//
//   PARTNER side (what Collegepond owes the payee, INR):
//     netted off the payee's next payout at release (reconciliation.release).
//     A deduction larger than that payout carries its balance forward.
//
// Never automatic between the sides (Suraj): a university clawback doesn't
// create a partner deduction; Finance raises one separately if wanted.
//
// Who: a finance role drafts; ONLY a Super Admin approves or rejects. A
// Finance Manager / Super Admin can put a payee on payout hold (payout_hold):
// claims still come in, nothing is approved for payment or released.

type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
const round2 = (n: number) => Math.round(n * 100) / 100;

export type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
type Client = Tx | typeof db;

// Sign of an adjustment as applied to the balance it touches.
export const signOf = (direction: number): 1 | -1 => (direction === AdjustmentDirection.CREDIT ? 1 : -1);

// ---- balances ---------------------------------------------------------------

type OpenRow = { id: number; direction: number; amount: number; allocated: number; balance: number };

// Approved adjustments on one side with a balance left, oldest first. With
// `lock`, the adjustment rows are locked for the rest of the transaction so two
// releases (or invoices) can't spend the same balance.
async function openAdjustments(
  c: Client,
  where: Record<string, unknown>,
  lock: boolean,
): Promise<OpenRow[]> {
  const rows = await c.adjustment.findMany({
    where: { status: AdjustmentStatus.APPROVED, ...where },
    orderBy: [{ adjustment_date: "asc" }, { id: "asc" }],
    select: { id: true, direction: true, amount: true, adjustment_allocation: { select: { amount: true } } },
  });
  if (lock && rows.length > 0) {
    await c.$queryRawUnsafe(
      `SELECT id FROM adjustment WHERE id IN (${rows.map(() => "?").join(", ")}) FOR UPDATE`,
      ...rows.map((r) => r.id),
    );
  }
  return rows
    .map((r) => {
      const allocated = round2(r.adjustment_allocation.reduce((s, a) => s + num(a.amount), 0));
      return { id: r.id, direction: r.direction, amount: num(r.amount), allocated, balance: round2(num(r.amount) - allocated) };
    })
    .filter((r) => r.balance > 0);
}

// ---- partner side -------------------------------------------------------------

const partnerWhere = (p: Payee) => ({ side: AdjustmentSide.PARTNER, ...payeeWhere(p) });

/** What's still to be netted for a payee (INR): deductions to recover, credits to pay. */
export async function partnerAdjustmentBalance(p: Payee, c: Client = db) {
  const open = await openAdjustments(c, partnerWhere(p), false);
  const sum = (d: number) => round2(open.filter((r) => r.direction === d).reduce((s, r) => s + r.balance, 0));
  return { deductionInr: sum(AdjustmentDirection.DEDUCTION), creditInr: sum(AdjustmentDirection.CREDIT) };
}

/** Outstanding partner balances for many payees at once (list views). Key: payeeKey(). */
export async function partnerAdjustmentBalances(): Promise<Map<string, { deductionInr: number; creditInr: number }>> {
  const rows = await db.adjustment.findMany({
    where: { status: AdjustmentStatus.APPROVED, side: AdjustmentSide.PARTNER },
    select: {
      org_id: true,
      payee_user_id: true,
      direction: true,
      amount: true,
      adjustment_allocation: { select: { amount: true } },
    },
  });
  const out = new Map<string, { deductionInr: number; creditInr: number }>();
  for (const r of rows) {
    const bal = round2(num(r.amount) - r.adjustment_allocation.reduce((s, a) => s + num(a.amount), 0));
    if (bal <= 0) continue;
    const k = payeeKey(r);
    const e = out.get(k) ?? { deductionInr: 0, creditInr: 0 };
    if (r.direction === AdjustmentDirection.CREDIT) e.creditInr = round2(e.creditInr + bal);
    else e.deductionInr = round2(e.deductionInr + bal);
    out.set(k, e);
  }
  return out;
}

export const payeeKey = (r: { org_id: number | null; payee_user_id: number | null }) =>
  r.org_id != null ? `o${r.org_id}` : `u${r.payee_user_id ?? 0}`;

export type PartnerNetting = {
  base: number;
  deductionInr: number;
  creditInr: number;
  toPay: number;
  allocations: { adjustmentId: number; amount: number }[];
};

// How a payout of `base` INR nets against the payee's open adjustments:
// credits are added in full, then deductions are recovered (oldest first) up
// to what's payable. Any deduction left over carries forward.
function planNetting(base: number, open: OpenRow[]): PartnerNetting {
  const allocations: PartnerNetting["allocations"] = [];
  let creditInr = 0;
  for (const r of open.filter((x) => x.direction === AdjustmentDirection.CREDIT)) {
    allocations.push({ adjustmentId: r.id, amount: r.balance });
    creditInr = round2(creditInr + r.balance);
  }
  let room = round2(base + creditInr);
  let deductionInr = 0;
  for (const r of open.filter((x) => x.direction === AdjustmentDirection.DEDUCTION)) {
    if (room <= 0) break;
    const take = round2(Math.min(r.balance, room));
    allocations.push({ adjustmentId: r.id, amount: take });
    deductionInr = round2(deductionInr + take);
    room = round2(room - take);
  }
  return { base, deductionInr, creditInr, toPay: round2(base + creditInr - deductionInr), allocations };
}

/** Preview for the release dialog (no locks, no writes). */
export async function previewPartnerNetting(p: Payee, base: number): Promise<PartnerNetting> {
  return planNetting(base, await openAdjustments(db, partnerWhere(p), false));
}

/**
 * Inside the release transaction: lock the payee's open adjustments, check the
 * netting still matches what was paid (`expected`, planned before the money
 * moved), and record the allocations against the payout.
 */
export async function applyPartnerNetting(
  tx: Tx,
  p: Payee,
  payoutId: number,
  expected: PartnerNetting,
  byCpUserId: number,
): Promise<void> {
  const now = planNetting(expected.base, await openAdjustments(tx, partnerWhere(p), true));
  if (now.toPay !== expected.toPay) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This partner's adjustments changed while you were releasing. Refresh and release again.",
    });
  }
  for (const a of now.allocations) {
    await tx.adjustment_allocation.create({
      data: { adjustment_id: a.adjustmentId, partner_payout_id: payoutId, amount: a.amount, created_by_cp_user_id: byCpUserId },
    });
  }
}

// ---- payout hold ----------------------------------------------------------------

export async function activeHold(p: Payee, c: Client = db) {
  return c.payout_hold.findFirst({
    where: { ...payeeWhere(p), lifted_at: null },
    orderBy: { id: "desc" },
    select: { id: true, reason: true, placed_at: true, placed_by_cp_user_id: true },
  });
}

/** Active holds keyed by payeeKey(), for list views. */
export async function activeHolds(): Promise<Map<string, { reason: string; placedAt: Date }>> {
  const rows = await db.payout_hold.findMany({
    where: { lifted_at: null },
    select: { org_id: true, payee_user_id: true, reason: true, placed_at: true },
  });
  return new Map(rows.map((r) => [payeeKey(r), { reason: r.reason, placedAt: r.placed_at }]));
}

/** Refuse approving for payment / releasing while the payee is on hold. */
export async function assertNoPayoutHold(p: Payee, action: "approve" | "release"): Promise<void> {
  const h = await activeHold(p);
  if (h) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `This partner's payouts are on hold (${h.reason}). A Finance Manager or Super Admin must lift the hold (Finance › Adjustments › Payout holds) before you can ${action === "approve" ? "approve a claim for payment" : "release a payout"}.`,
    });
  }
}

// ---- university side --------------------------------------------------------------

// Whose receivable a university adjustment belongs to: the vendor, or on a
// direct contract (no vendor) the university itself.
type Counterparty = { vendorId: number } | { vendorId: null; universityId: number };

const counterpartyWhere = (cp: Counterparty) =>
  cp.vendorId != null ? { vendor_id: cp.vendorId } : { vendor_id: null, university_id: cp.universityId };

// The vendor invoices of a counterparty in a currency (a direct university's
// invoices have no vendor; they're found through the universities they bill).
async function counterpartyInvoiceIds(c: Client, cp: Counterparty, currency: string): Promise<number[]> {
  const rows = await c.vendor_invoice.findMany({
    where:
      cp.vendorId != null
        ? { vendor_id: cp.vendorId, currency }
        : {
            vendor_id: null,
            currency,
            vendor_invoice_item: {
              some: { commission: { application: { course: { university_id: cp.universityId } } } },
            },
          },
    orderBy: [{ invoice_date: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Net effect of allocations per invoice: { deducted, credited } in invoice currency. */
export async function invoiceAdjustmentTotals(
  invoiceIds: number[],
  c: Client = db,
): Promise<Map<number, { deducted: number; credited: number }>> {
  const out = new Map<number, { deducted: number; credited: number }>();
  if (invoiceIds.length === 0) return out;
  const rows = await c.adjustment_allocation.findMany({
    where: { vendor_invoice_id: { in: invoiceIds } },
    select: { vendor_invoice_id: true, amount: true, adjustment: { select: { direction: true } } },
  });
  for (const r of rows) {
    const e = out.get(r.vendor_invoice_id!) ?? { deducted: 0, credited: 0 };
    if (r.adjustment.direction === AdjustmentDirection.CREDIT) e.credited = round2(e.credited + num(r.amount));
    else e.deducted = round2(e.deducted + num(r.amount));
    out.set(r.vendor_invoice_id!, e);
  }
  return out;
}

/** Each invoice's adjustment lines (what was applied to it), for the invoice view. Staff-only. */
export async function invoiceAdjustmentLines(invoiceIds: number[]) {
  const out = new Map<
    number,
    { adjustmentId: number; direction: "deduction" | "credit"; reason: string; amount: number; note: string | null; student: string | null; at: Date }[]
  >();
  if (invoiceIds.length === 0) return out;
  const rows = await db.adjustment_allocation.findMany({
    where: { vendor_invoice_id: { in: invoiceIds } },
    orderBy: { id: "asc" },
    select: {
      vendor_invoice_id: true,
      amount: true,
      created_at: true,
      adjustment: {
        select: {
          id: true,
          direction: true,
          internal_note: true,
          reason: { select: { name: true } },
          commission: { select: { application: { select: { student: { select: { first_name: true, last_name: true } } } } } },
        },
      },
    },
  });
  for (const r of rows) {
    const list = out.get(r.vendor_invoice_id!) ?? [];
    const s = r.adjustment.commission?.application.student;
    list.push({
      adjustmentId: r.adjustment.id,
      direction: r.adjustment.direction === AdjustmentDirection.CREDIT ? "credit" : "deduction",
      reason: r.adjustment.reason.name,
      amount: num(r.amount),
      note: r.adjustment.internal_note,
      student: s ? `${s.first_name} ${s.last_name}`.trim() : null,
      at: r.created_at,
    });
    out.set(r.vendor_invoice_id!, list);
  }
  return out;
}

/** University-side adjustments per commission (Vendor Billing): approved net and drafts. */
export async function commissionUniversityAdjustments(commissionIds: number[]) {
  const out = new Map<number, { deduction: number; credit: number; drafts: number; currency: string }>();
  if (commissionIds.length === 0) return out;
  const rows = await db.adjustment.findMany({
    where: {
      side: AdjustmentSide.UNIVERSITY,
      commission_id: { in: commissionIds },
      status: { in: [AdjustmentStatus.DRAFT, AdjustmentStatus.APPROVED] },
    },
    select: { commission_id: true, status: true, direction: true, amount: true, currency: true },
  });
  for (const r of rows) {
    const e = out.get(r.commission_id!) ?? { deduction: 0, credit: 0, drafts: 0, currency: r.currency };
    if (r.status === AdjustmentStatus.DRAFT) e.drafts += 1;
    else if (r.direction === AdjustmentDirection.CREDIT) e.credit = round2(e.credit + num(r.amount));
    else e.deduction = round2(e.deduction + num(r.amount));
    out.set(r.commission_id!, e);
  }
  return out;
}

/** An invoice's outstanding after adjustments (never below 0). */
export const netOutstanding = (instalmentOutstanding: number, adj?: { deducted: number; credited: number }) =>
  Math.max(0, round2(instalmentOutstanding - (adj?.deducted ?? 0) + (adj?.credited ?? 0)));

// What's still open on each invoice (invoice currency), after adjustments.
async function openAmounts(c: Client, invoiceIds: number[]): Promise<Map<number, number>> {
  if (invoiceIds.length === 0) return new Map();
  const invs = await c.vendor_invoice.findMany({
    where: { id: { in: invoiceIds } },
    select: {
      id: true,
      vendor_invoice_item: { select: { ...COLLECT_LINE_SELECT, commission: { select: COLLECT_COMMISSION_SELECT } } },
    },
  });
  const adj = await invoiceAdjustmentTotals(invoiceIds, c);
  return new Map(invs.map((i) => [i.id, netOutstanding(invoiceCollection(i.vendor_invoice_item).outstanding, adj.get(i.id))]));
}

// Allocate one approved university adjustment's balance to invoices, in order.
// A deduction only takes what's still open on an invoice; a credit (the
// university owes more) goes whole to the first one.
async function allocateToInvoices(
  tx: Tx,
  adj: { id: number; direction: number; balance: number },
  invoiceIds: number[],
  byCpUserId: number | null,
): Promise<number> {
  let left = adj.balance;
  const open = adj.direction === AdjustmentDirection.DEDUCTION ? await openAmounts(tx, invoiceIds) : null;
  for (const id of invoiceIds) {
    if (left <= 0) break;
    const take = round2(open ? Math.min(left, open.get(id) ?? 0) : left);
    if (take <= 0) continue;
    await tx.adjustment_allocation.create({
      data: { adjustment_id: adj.id, vendor_invoice_id: id, amount: take, created_by_cp_user_id: byCpUserId },
    });
    left = round2(left - take);
  }
  return left;
}

/**
 * On approval of a UNIVERSITY adjustment: apply it to its own invoice if
 * still open, then the counterparty's other open invoices in that currency.
 * Returns what's left as a standing credit (for the next invoice).
 */
export async function applyUniversityAdjustment(tx: Tx, adjustmentId: number, byCpUserId: number): Promise<number> {
  const a = await tx.adjustment.findUniqueOrThrow({
    where: { id: adjustmentId },
    select: {
      id: true,
      direction: true,
      amount: true,
      currency: true,
      vendor_id: true,
      university_id: true,
      vendor_invoice_id: true,
      commission_tranche_id: true,
      commission: { select: { vendor_invoice_item: { select: { vendor_invoice_id: true, vendor_invoice_item_tranche: { select: { commission_tranche_id: true } } } } } },
    },
  });
  const cp: Counterparty | null =
    a.vendor_id != null ? { vendorId: a.vendor_id } : a.university_id != null ? { vendorId: null, universityId: a.university_id } : null;
  if (!cp) return num(a.amount);
  // Its own invoice first: the one named, else the line billing its tranche,
  // else the commission's (first) invoice line.
  const lines = a.commission?.vendor_invoice_item ?? [];
  const own =
    a.vendor_invoice_id ??
    (a.commission_tranche_id != null ? lineForTranche(lines, a.commission_tranche_id)?.vendor_invoice_id : null) ??
    lines[0]?.vendor_invoice_id ??
    null;
  const others = await counterpartyInvoiceIds(tx, cp, a.currency);
  const order = [...(own != null && others.includes(own) ? [own] : []), ...others.filter((id) => id !== own)];
  // A credit with no invoice of its own waits for the next invoice rather than
  // landing on an unrelated open one.
  const targets = a.direction === AdjustmentDirection.CREDIT ? (own != null && others.includes(own) ? [own] : []) : order;
  return allocateToInvoices(tx, { id: a.id, direction: a.direction, balance: num(a.amount) }, targets, byCpUserId);
}

/**
 * When a vendor invoice is raised: apply the counterparty's standing
 * university credits / deductions (same currency) to it, oldest first.
 */
export async function applyStandingAdjustmentsToInvoice(tx: Tx, invoiceId: number, byCpUserId: number): Promise<void> {
  const inv = await tx.vendor_invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: {
      vendor_id: true,
      currency: true,
      vendor_invoice_item: { select: { commission: { select: { application: { select: { course: { select: { university_id: true } } } } } } } },
    },
  });
  const where =
    inv.vendor_id != null
      ? { vendor_id: inv.vendor_id }
      : {
          vendor_id: null,
          university_id: {
            in: Array.from(new Set(inv.vendor_invoice_item.map((it) => it.commission.application.course.university_id))),
          },
        };
  const open = await openAdjustments(tx, { side: AdjustmentSide.UNIVERSITY, currency: inv.currency, ...where }, true);
  for (const r of open) await allocateToInvoices(tx, r, [invoiceId], byCpUserId);
}

/** Standing university balances (not yet on any invoice), per counterparty + currency. */
export async function standingUniversityBalances() {
  const rows = await db.adjustment.findMany({
    where: { status: AdjustmentStatus.APPROVED, side: AdjustmentSide.UNIVERSITY },
    select: {
      vendor_id: true,
      university_id: true,
      currency: true,
      direction: true,
      amount: true,
      vendor: { select: { name: true } },
      university: { select: { name: true } },
      adjustment_allocation: { select: { amount: true } },
    },
  });
  const out = new Map<string, { vendorId: number | null; universityId: number | null; name: string; currency: string; deduction: number; credit: number }>();
  for (const r of rows) {
    const bal = round2(num(r.amount) - r.adjustment_allocation.reduce((s, a) => s + num(a.amount), 0));
    if (bal <= 0) continue;
    const k = `${r.vendor_id ?? `u${r.university_id}`}:${r.currency}`;
    const e = out.get(k) ?? {
      vendorId: r.vendor_id,
      universityId: r.vendor_id == null ? r.university_id : null,
      name: r.vendor?.name ?? r.university?.name ?? "Direct",
      currency: r.currency,
      deduction: 0,
      credit: 0,
    };
    if (r.direction === AdjustmentDirection.CREDIT) e.credit = round2(e.credit + bal);
    else e.deduction = round2(e.deduction + bal);
    out.set(k, e);
  }
  return Array.from(out.values());
}

// ---- totals for the Finance dashboard ------------------------------------------

/**
 * Approved adjustment totals for a financial year (by adjustment_date), INR at
 * the reference rate (Settings › Exchange Rates), plus what's still unapplied. For the Finance dashboard's
 * "Deductions" in receivables and payouts.
 */
export async function adjustmentTotals(fy?: number) {
  const fx = await loadInrRates();
  const rows = await db.adjustment.findMany({
    where: { status: AdjustmentStatus.APPROVED },
    select: {
      side: true,
      direction: true,
      amount: true,
      currency: true,
      adjustment_date: true,
      adjustment_allocation: { select: { amount: true } },
    },
  });
  const blank = () => ({ deductionsInr: 0, creditsInr: 0, unappliedDeductionsInr: 0, unappliedCreditsInr: 0, count: 0 });
  const out = { university: blank(), partner: blank() };
  for (const r of rows) {
    if (fy != null && financialYearOf(r.adjustment_date) !== fy) continue;
    const t = r.side === AdjustmentSide.PARTNER ? out.partner : out.university;
    // ₹ at the reference rate (Settings › Exchange Rates); no rate → left out.
    const amt = inrOf(fx, num(r.amount), r.currency) ?? 0;
    const bal = inrOf(fx, num(r.amount) - r.adjustment_allocation.reduce((s, a) => s + num(a.amount), 0), r.currency) ?? 0;
    t.count += 1;
    if (r.direction === AdjustmentDirection.CREDIT) {
      t.creditsInr = round2(t.creditsInr + amt);
      t.unappliedCreditsInr = round2(t.unappliedCreditsInr + Math.max(0, bal));
    } else {
      t.deductionsInr = round2(t.deductionsInr + amt);
      t.unappliedDeductionsInr = round2(t.unappliedDeductionsInr + Math.max(0, bal));
    }
  }
  return out;
}

// Open vendor invoice statuses (for callers that list receivables).
export const OPEN_INVOICE_STATUSES = [VendorInvoiceStatus.SENT, VendorInvoiceStatus.PARTIAL_PAYMENT];
export { counterpartyWhere };
