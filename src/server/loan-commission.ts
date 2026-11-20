import "server-only";
import { db } from "~/server/db";
import { LoanCommissionSource, LoanCommissionStatus } from "~/server/db/enums";
import { payeeWhere, type Payee } from "~/server/payee";

// Loan commission (20 Nov 2026; spec "Loan Commission Flow — Converge").
//
// When a partner-referred loan is disbursed, Converge opens one commission
// line per disbursement tranche. Normally only the FIRST tranche earns
// commission (Suraj, 20 Nov); a lender marked "pays on later tranches" opens a
// line for each later one too, and SA / FM can add a tranche line by hand.
//
// Each line is priced as % of the amount disbursed, from two dated masters:
//   lender %  (loan_lender_rate)  what the lender pays Collegepond (expected)
//   partner % (loan_partner_rate) what the partner earns, one % per partner
// Both are stamped on the line from the rates effective on its disbursal
// date; a later master change never touches a priced line. A line missing
// either waits as NEEDS_RATE and is priced when Finance sets the rate.
//
// It becomes claimable only once Collegepond's lender receipt covering it is
// approved (loan_receipt; router loanCommission). Anything that changes
// upstream after that is FLAGGED for Finance (attention), never applied.

type Decimalish = { toNumber: () => number } | null;
export const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
export const numOrNull = (d: Decimalish): number | null => (d == null ? null : d.toNumber());
export const round2 = (n: number) => Math.round(n * 100) / 100;
const pctOf = (amount: number, pct: number | null) => (pct == null ? null : round2((amount * pct) / 100));

// A date-only value as MySQL DATE stores it (UTC midnight).
export const dateOnly = (d: Date | string): Date => {
  const iso = typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  return new Date(`${iso}T00:00:00Z`);
};

// Lines not yet tied to money in flight: their amount and rates may still
// follow upstream changes and master edits.
export const OPEN_LINE_STATES: number[] = [LoanCommissionStatus.NEEDS_RATE, LoanCommissionStatus.AWAITING_RECEIPT];

// Who a referral's commission belongs to: the referrer's agency, or the
// independent counsellor themselves.
export function referralPayee(r: { org_id: number | null; partner_user_id: number }): Payee {
  return r.org_id != null ? { orgId: r.org_id, userId: null } : { orgId: null, userId: r.partner_user_id };
}

// The lender row for a name as the Enrollment App sends it. A name Converge
// hasn't seen is added with no rate, so Finance sees "Needs rate".
export async function lenderFor(name: string): Promise<{ id: number; pays_later_tranches: number }> {
  const clean = name.trim().slice(0, 150);
  const found = await db.loan_lender.findUnique({ where: { name: clean }, select: { id: true, pays_later_tranches: true } });
  if (found) return found;
  try {
    return await db.loan_lender.create({ data: { name: clean }, select: { id: true, pays_later_tranches: true } });
  } catch {
    // Lost a race to create it.
    return db.loan_lender.findUniqueOrThrow({ where: { name: clean }, select: { id: true, pays_later_tranches: true } });
  }
}

export async function lenderPctOn(lenderId: number, on: Date): Promise<number | null> {
  const r = await db.loan_lender_rate.findFirst({
    where: { lender_id: lenderId, effective_from: { lte: dateOnly(on) } },
    orderBy: { effective_from: "desc" },
    select: { cp_pct: true },
  });
  return r ? num(r.cp_pct) : null;
}

export async function partnerPctOn(payee: Payee, on: Date): Promise<number | null> {
  const r = await db.loan_partner_rate.findFirst({
    where: { ...payeeWhere(payee), effective_from: { lte: dateOnly(on) } },
    orderBy: [{ effective_from: "desc" }, { id: "desc" }],
    select: { pct: true },
  });
  return r ? num(r.pct) : null;
}

// Fill whatever rate a line is still missing, then its amounts and status.
// Only NEEDS_RATE lines: a priced line keeps the rates it was stamped with.
export async function priceWaitingLines(where: { lenderId?: number; payee?: Payee } = {}): Promise<number> {
  const lines = await db.loan_commission.findMany({
    where: {
      status: LoanCommissionStatus.NEEDS_RATE,
      ...(where.lenderId ? { lender_id: where.lenderId } : {}),
      ...(where.payee ? payeeWhere(where.payee) : {}),
    },
    select: { id: true, lender_id: true, org_id: true, payee_user_id: true, disbursed_amount: true, disbursed_on: true, lender_pct: true, partner_pct: true },
  });
  let priced = 0;
  for (const l of lines) {
    const payee: Payee = l.org_id != null ? { orgId: l.org_id, userId: null } : { orgId: null, userId: l.payee_user_id! };
    const lenderPct = numOrNull(l.lender_pct) ?? (await lenderPctOn(l.lender_id, l.disbursed_on));
    const partnerPct = numOrNull(l.partner_pct) ?? (await partnerPctOn(payee, l.disbursed_on));
    const amount = num(l.disbursed_amount);
    const ready = lenderPct != null && partnerPct != null;
    await db.loan_commission.updateMany({
      where: { id: l.id, status: LoanCommissionStatus.NEEDS_RATE },
      data: {
        lender_pct: lenderPct,
        partner_pct: partnerPct,
        expected_cp: pctOf(amount, lenderPct),
        partner_amount: pctOf(amount, partnerPct),
        status: ready ? LoanCommissionStatus.AWAITING_RECEIPT : LoanCommissionStatus.NEEDS_RATE,
      },
    });
    if (ready) priced++;
  }
  return priced;
}

// Open one line (idempotent on referral + application + tranche). Returns
// false when it already existed.
export async function openLine(input: {
  referral: { id: number; org_id: number | null; partner_user_id: number };
  applicationRowId: number | null;
  appExternalId: string | null;
  trancheNo: number;
  source: number;
  lenderId: number;
  amount: number;
  on: Date;
  note?: string | null;
  createdBy?: number | null;
}): Promise<{ created: boolean; id: number | null }> {
  const payee = referralPayee(input.referral);
  const on = dateOnly(input.on);
  const lenderPct = await lenderPctOn(input.lenderId, on);
  const partnerPct = await partnerPctOn(payee, on);
  const amount = round2(input.amount);
  try {
    const row = await db.loan_commission.create({
      data: {
        referral_id: input.referral.id,
        referral_application_id: input.applicationRowId,
        app_external_id: input.appExternalId,
        tranche_no: input.trancheNo,
        source: input.source,
        lender_id: input.lenderId,
        org_id: payee.orgId,
        payee_user_id: payee.userId,
        disbursed_amount: amount,
        disbursed_on: on,
        lender_pct: lenderPct,
        partner_pct: partnerPct,
        expected_cp: pctOf(amount, lenderPct),
        partner_amount: pctOf(amount, partnerPct),
        status:
          lenderPct != null && partnerPct != null
            ? LoanCommissionStatus.AWAITING_RECEIPT
            : LoanCommissionStatus.NEEDS_RATE,
        note: input.note ?? null,
        created_by_cp_user_id: input.createdBy ?? null,
      },
      select: { id: true },
    });
    return { created: true, id: row.id };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { created: false, id: null };
    throw e;
  }
}

// Something changed upstream that Finance has to look at. Lines already
// cancelled are left alone; the newest note wins.
export async function flagLines(ids: number[], text: string): Promise<void> {
  if (ids.length === 0) return;
  await db.loan_commission.updateMany({
    where: { id: { in: ids }, status: { not: LoanCommissionStatus.CANCELLED } },
    data: { attention: text.slice(0, 255), attention_at: new Date() },
  });
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// An application as the webhook delivered it (contract 2). `tranches` is the
// optional per-tranche list; without it the first disbursedAmount seen is
// taken as the first tranche.
export type SyncedApplication = {
  id: string;
  lender: string;
  status: string;
  disbursedAmount: number | null;
  disbursedAt: string | null;
  tranches?: { date: string | null; amount: number | null }[] | null;
};

// Called after every application.updated / snapshot row is stored.
export async function onApplicationSynced(
  r: { id: number; org_id: number | null; partner_user_id: number },
  a: SyncedApplication,
  applicationRowId: number | null,
  at: Date,
): Promise<void> {
  const lines = await db.loan_commission.findMany({
    where: { referral_id: r.id, app_external_id: a.id, source: LoanCommissionSource.SYNC },
    orderBy: { tranche_no: "asc" },
    select: { id: true, tranche_no: true, status: true, disbursed_amount: true, disbursed_on: true, lender_pct: true, partner_pct: true },
  });
  const live = lines.filter((l) => l.status !== LoanCommissionStatus.CANCELLED);

  // The application left "disbursed" for a closed state: Finance decides.
  if (live.length > 0 && (a.status === "declined" || a.status === "closed")) {
    await flagLines(live.map((l) => l.id), `The application is now "${a.status}" in the Enrollment App.`);
  }

  const tranches = (a.tranches ?? [])
    .filter((t) => t.amount != null && t.amount > 0)
    .map((t) => ({ amount: t.amount!, on: t.date ? new Date(t.date) : null }));
  const total = a.disbursedAmount ?? 0;
  if (tranches.length === 0 && total <= 0) {
    if (live.length > 0) await flagLines(live.map((l) => l.id), "The disbursed amount was removed in the Enrollment App.");
    return;
  }
  const lender = await lenderFor(a.lender);
  const fallbackOn = a.disbursedAt ? new Date(a.disbursedAt) : at;

  if (tranches.length > 0) {
    // Per-tranche data: line n follows tranche n while it's still open.
    const wanted = lender.pays_later_tranches ? tranches.length : 1;
    for (let n = 1; n <= Math.max(wanted, live.length); n++) {
      const t = tranches[n - 1];
      const line = live.find((l) => l.tranche_no === n);
      if (!line) {
        if (t && n <= wanted) {
          await openLine({ referral: r, applicationRowId, appExternalId: a.id, trancheNo: n, source: LoanCommissionSource.SYNC, lenderId: lender.id, amount: t.amount, on: t.on ?? fallbackOn });
        }
        continue;
      }
      if (!t) {
        await flagLines([line.id], `Tranche ${n} was removed in the Enrollment App.`);
        continue;
      }
      if (round2(num(line.disbursed_amount)) === round2(t.amount)) continue;
      if (OPEN_LINE_STATES.includes(line.status)) {
        const lp = numOrNull(line.lender_pct);
        const pp = numOrNull(line.partner_pct);
        await db.loan_commission.update({
          where: { id: line.id },
          data: { disbursed_amount: round2(t.amount), expected_cp: pctOf(t.amount, lp), partner_amount: pctOf(t.amount, pp) },
        });
      } else {
        await flagLines([line.id], `Tranche ${n} changed to ${inr(t.amount)} in the Enrollment App.`);
      }
    }
    return;
  }

  // Only the running total: the first total seen is tranche 1; a later rise is
  // a later tranche (a line only if the lender pays on later tranches); a
  // drop below what the lines hold is flagged.
  if (live.length === 0 && lines.length === 0) {
    await openLine({ referral: r, applicationRowId, appExternalId: a.id, trancheNo: 1, source: LoanCommissionSource.SYNC, lenderId: lender.id, amount: total, on: fallbackOn });
    return;
  }
  const held = round2(live.reduce((s, l) => s + num(l.disbursed_amount), 0));
  if (total < held - 0.5) {
    await flagLines(live.map((l) => l.id), `The disbursed total dropped to ${inr(total)} in the Enrollment App.`);
  } else if (total > held + 0.5 && lender.pays_later_tranches && live.length > 0) {
    const next = Math.max(...lines.map((l) => l.tranche_no)) + 1;
    await openLine({ referral: r, applicationRowId, appExternalId: a.id, trancheNo: next, source: LoanCommissionSource.SYNC, lenderId: lender.id, amount: round2(total - held), on: at });
  }
}

// The application is gone from the Enrollment App (deleted, or missing from a
// snapshot): its lines stay, flagged.
export async function onApplicationGone(referralId: number, externalId: string): Promise<void> {
  const lines = await db.loan_commission.findMany({
    where: { referral_id: referralId, app_external_id: externalId, status: { not: LoanCommissionStatus.CANCELLED } },
    select: { id: true },
  });
  await flagLines(lines.map((l) => l.id), "The lender application was deleted in the Enrollment App.");
}
