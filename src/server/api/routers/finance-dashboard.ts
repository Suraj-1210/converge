import { z } from "zod";
import { createTRPCRouter, financeProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  DocumentStatus,
  PartnerInvoiceStatus,
  PayoutStatus,
  TrancheKind,
  TrancheStatus,
  UniApplicationStatus,
  VendorInvoiceStatus,
  VendorType,
  financialYearOf,
} from "~/server/db/enums";
import { effectiveRate } from "~/server/api/routers/fx";
import { lineTrancheShares, TRANCHE_LINKS_SELECT } from "~/server/vendor-invoice-tranches";

// ---------------------------------------------------------------------------
// Finance dashboard (approved by Suraj, 16 Nov 2026): the landing page for
// Finance Managers / Executives and an extra tab for Super Admins. Read-only
// aggregates over the same tables University Billing, the Commission Ledger,
// Invoices & Payouts and Reconciliation write; it never changes anything.
//
// Money is returned per currency, never pre-converted:
//   by  = currency → amount, in the currency the money is booked in
//   inr = the exact ₹ where the money was actually booked in ₹ (vendor
//         payments, partner payouts), else null
// The page converts the rest with the stored Settings › Exchange Rates
// (fx_rate, effective rate) and shows whatever has no rate as "not converted",
// so a missing rate is never read as 0.
//
// Definitions (FY = 1 April – 31 March, code = starting year):
//   Placements        applications ENROLLED, dated by their Enrolled stage
//   Commission earned CP share (cpReceivable) of commissions approved in the FY
//   Billed            vendor invoices with fy = FY (as University Billing stats)
//   Collected         vendor payments with fy = FY (recorded; approved or not)
//   Receivables       billed − collected in the FY, per currency (as stats)
//   Not yet billed    CP share of the FY's commissions' instalments (or whole
//                     commissions) on no vendor invoice
//   Distributed       partner payouts RELEASED with fy = FY
//   Partner payables  payouts approved but not released (any FY)
// ---------------------------------------------------------------------------

type Amounts = Record<string, number>;
type Money = { by: Amounts; inr: number | null };

const round2 = (n: number) => Math.round(n * 100) / 100;
// Raw-query numbers arrive as Decimal / bigint / string.
const n = (v: unknown): number => (v == null ? 0 : Number(v));

function addTo(target: Amounts, ccy: string, amount: number) {
  target[ccy] = round2((target[ccy] ?? 0) + amount);
}

const emptyMoney = (): Money => ({ by: {}, inr: null });
function addMoney(m: Money, ccy: string, amount: number, inr: number | null) {
  addTo(m.by, ccy, amount);
  if (inr != null) m.inr = round2((m.inr ?? 0) + inr);
}

// [start, end) of a financial year, matching financialYearOf (UTC months).
const fyStart = (fy: number) => new Date(Date.UTC(fy, 3, 1));
const fyEnd = (fy: number) => new Date(Date.UTC(fy + 1, 3, 1));

// "2026-11-16" for today in India, the business's calendar.
function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

// SQL for "the FY this timestamp falls in" over a range of FYs, with its
// bound parameters (FY boundaries are passed as Dates, like Prisma writes).
function fyCase(column: string, fys: number[]): { sql: string; params: Date[] } {
  const params: Date[] = [];
  const whens = fys.map((fy) => {
    params.push(fyStart(fy), fyEnd(fy));
    return `WHEN ${column} >= ? AND ${column} < ? THEN ${fy}`;
  });
  return { sql: `CASE ${whens.join(" ")} END`, params };
}

// CP's share of a commission amount (cpReceivable in university-billing):
// the gross on a direct deal, gross × cp_share_pct on a third-party one.
const CP_SHARE_SQL = (amount: string) =>
  `CASE WHEN c.cp_share_pct IS NULL THEN ${amount} ELSE ROUND(${amount} * c.cp_share_pct) / 100 END`;

// A paid-out payout's currency and amount: the foreign remittance when it was
// paid abroad, else ₹.
const PAYOUT_CCY_SQL = `CASE WHEN p.amount_foreign IS NULL THEN 'INR' ELSE COALESCE(p.currency, 'INR') END`;
const PAYOUT_AMT_SQL = `COALESCE(p.amount_foreign, p.amount_inr)`;

// Claims approved but not yet paid (Reconciliation's pending states).
const UNPAID_PAYOUT_STATES: number[] = [
  PayoutStatus.APPROVED,
  PayoutStatus.READY_TO_PAY,
  PayoutStatus.ON_HOLD,
  PayoutStatus.SENT_BACK,
];
const OPEN_INVOICE_STATES: number[] = [VendorInvoiceStatus.SENT, VendorInvoiceStatus.PARTIAL_PAYMENT];

// Stored Settings › Exchange Rates: ₹ per 1 unit (effective = manual override,
// else mid − bank margin). Empty until rates are refreshed.
async function storedRates() {
  const rows = await db.fx_rate.findMany();
  const rates: Record<string, number> = {};
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

// Instalments (or whole commissions without tranche rows) on no vendor
// invoice, as CP-share amounts per commission currency. A tranche counts as
// invoiced when a line links it, or when its commission has a whole-commission
// line (a line with no tranche links bills every BASE tranche). A university
// volume bonus (tranche kind 1) is billed in full, in its scheme currency, on
// its own invoice; a partner incentive (kind 2) is never billed.
async function notYetBilled(fy: number | null) {
  const range = fy == null ? "" : "AND COALESCE(c.approved_at, c.created_at) >= ? AND COALESCE(c.approved_at, c.created_at) < ?";
  const params = fy == null ? [] : [fyStart(fy), fyEnd(fy)];
  const rows = await db.$queryRawUnsafe<{ ccy: string; amt: unknown; items: unknown; commissions: unknown }[]>(
    `SELECT x.ccy, SUM(x.amt) AS amt, SUM(x.items) AS items, COUNT(DISTINCT x.cid) AS commissions FROM (
       SELECT c.id AS cid, c.currency AS ccy, ${CP_SHARE_SQL("COALESCE(t.amount, 0)")} AS amt, 1 AS items
       FROM commission_tranche t
       JOIN commission c ON c.id = t.commission_id
       WHERE t.kind = 0
         AND NOT EXISTS (SELECT 1 FROM vendor_invoice_item_tranche l WHERE l.commission_tranche_id = t.id)
         AND NOT EXISTS (
           SELECT 1 FROM vendor_invoice_item i
           WHERE i.commission_id = c.id
             AND NOT EXISTS (SELECT 1 FROM vendor_invoice_item_tranche l2 WHERE l2.vendor_invoice_item_id = i.id))
         ${range}
       UNION ALL
       SELECT c.id, c.currency, ${CP_SHARE_SQL("c.commision_amount")}, 1
       FROM commission c
       WHERE NOT EXISTS (SELECT 1 FROM commission_tranche t WHERE t.commission_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM vendor_invoice_item i WHERE i.commission_id = c.id)
         ${range}
       UNION ALL
       SELECT c.id, b.currency, COALESCE(t.amount, 0), 1
       FROM commission_tranche t
       JOIN commission c ON c.id = t.commission_id
       JOIN commission_bonus b ON b.commission_tranche_id = t.id
       WHERE t.kind = 1
         AND NOT EXISTS (SELECT 1 FROM vendor_invoice_item_tranche l WHERE l.commission_tranche_id = t.id)
         ${range}
     ) x GROUP BY x.ccy`,
    ...params,
    ...params,
    ...params,
  );
  const by: Amounts = {};
  let items = 0;
  let commissions = 0;
  for (const r of rows) {
    addTo(by, r.ccy, n(r.amt));
    items += n(r.items);
    commissions += n(r.commissions);
  }
  return { by, items, commissions };
}

// What's still to collect on each open vendor invoice — the instalments it
// bills that aren't collected yet — mirroring University Billing's ageing
// (invoiceCollection there): a part-payment that completes no instalment
// doesn't reduce it.
const isCollected = (status: number) =>
  status === TrancheStatus.COLLECTED || status === TrancheStatus.RECEIVED || status === TrancheStatus.PAID;

async function openInvoices() {
  const invoices = await db.vendor_invoice.findMany({
    where: { status: { in: OPEN_INVOICE_STATES } },
    select: {
      id: true,
      currency: true,
      due_date: true,
      vendor_invoice_item: {
        select: {
          ...TRANCHE_LINKS_SELECT,
          expected_amount: true,
          commission: {
            select: {
              commision_amount: true,
              collegepond_received_at: true,
              // Vendor-billed tranches; kind lets a whole line skip a volume bonus.
              commission_tranche: {
                where: { kind: { not: TrancheKind.PARTNER_INCENTIVE } },
                select: { id: true, kind: true, status: true, amount: true },
              },
              application: { select: { course: { select: { university: { select: { id: true, name: true } } } } } },
            },
          },
        },
      },
    },
  });
  const today = new Date(`${todayIst()}T00:00:00Z`).getTime();
  return invoices.map((inv) => {
    let outstanding = 0;
    for (const it of inv.vendor_invoice_item) {
      const expected = Number(it.expected_amount);
      const ts = it.commission.commission_tranche;
      if (ts.length === 0) {
        if (it.commission.collegepond_received_at == null) outstanding += expected;
        continue;
      }
      for (const { tranche, fraction } of lineTrancheShares(it, ts, Number(it.commission.commision_amount))) {
        if (!isCollected(tranche.status)) outstanding += expected * fraction;
      }
    }
    const daysOverdue = inv.due_date ? Math.floor((today - inv.due_date.getTime()) / 86_400_000) : 0;
    const unis = new Map(
      inv.vendor_invoice_item.map((it) => {
        const u = it.commission.application.course.university;
        return [u.id, u.name] as const;
      }),
    );
    return {
      id: inv.id,
      currency: inv.currency,
      outstanding: round2(outstanding),
      daysOverdue: Math.max(0, daysOverdue),
      notYetDue: inv.due_date == null || daysOverdue < 0,
      // Same buckets as University Billing's ageing report.
      bucket: daysOverdue <= 30 ? 0 : daysOverdue <= 60 ? 1 : daysOverdue <= 90 ? 2 : 3,
      university:
        unis.size === 1
          ? { id: Array.from(unis.keys())[0]!, name: Array.from(unis.values())[0]! }
          : { id: 0, name: unis.size === 0 ? "—" : "Multiple universities" },
    };
  });
}

const fyInput = z.object({ fy: z.number().int().min(2000).max(2100) });

export const financeDashboardRouter = createTRPCRouter({
  // FYs to offer: every FY with finance activity, plus the current one.
  financialYears: financeProcedure.query(async () => {
    const current = financialYearOf(new Date());
    const [inv, pay, out] = await Promise.all([
      db.vendor_invoice.findMany({ where: { fy: { not: null } }, distinct: ["fy"], select: { fy: true } }),
      db.vendor_payment.findMany({ where: { fy: { not: null } }, distinct: ["fy"], select: { fy: true } }),
      db.partner_payout.findMany({ where: { fy: { not: null } }, distinct: ["fy"], select: { fy: true } }),
    ]);
    const set = new Set<number>([current]);
    for (const r of [...inv, ...pay, ...out]) if (r.fy != null && r.fy <= current) set.add(r.fy);
    return { current, years: Array.from(set).sort((a, b) => b - a) };
  }),

  // KPIs, money flow, needs-action counts, ageing, monthly trend and top
  // receivables for one FY. Ageing / top receivables / needs-action are as of
  // today (they're about what's open now), not FY-bound.
  overview: financeProcedure.input(fyInput).query(async ({ input }) => {
    const { fy } = input;
    const start = fyStart(fy);
    const end = fyEnd(fy);
    const todayStr = todayIst();
    const today = new Date(`${todayStr}T00:00:00Z`);

    const [
      rates,
      placementRows,
      earnedRows,
      billedRows,
      collectedRows,
      overdueInFy,
      notBilled,
      distributedRows,
      payableRows,
      approveCommission,
      backlog,
      collectionsToApprove,
      claimsToReview,
      payoutsToVerify,
      payoutsToRelease,
      overdueOpen,
      open,
      billedTrend,
      collectedTrend,
      distributedTrend,
    ] = await Promise.all([
      storedRates(),
      db.$queryRawUnsafe<{ apps: unknown; students: unknown }[]>(
        `SELECT COUNT(*) AS apps, COUNT(DISTINCT a.student_id) AS students
         FROM application a
         LEFT JOIN application_stage_history h ON h.application_id = a.id AND h.stage = ?
         WHERE a.status = ? AND COALESCE(h.occurred_at, a.updated_at) >= ? AND COALESCE(h.occurred_at, a.updated_at) < ?`,
        UniApplicationStatus.ENROLLED,
        UniApplicationStatus.ENROLLED,
        start,
        end,
      ),
      db.$queryRawUnsafe<{ ccy: string; amt: unknown; cnt: unknown }[]>(
        `SELECT c.currency AS ccy, SUM(${CP_SHARE_SQL("c.commision_amount")}) AS amt, COUNT(*) AS cnt
         FROM commission c
         WHERE COALESCE(c.approved_at, c.created_at) >= ? AND COALESCE(c.approved_at, c.created_at) < ?
         GROUP BY c.currency`,
        start,
        end,
      ),
      db.vendor_invoice.groupBy({
        by: ["currency"],
        where: { fy },
        _sum: { total_expected_amount: true },
        _count: { _all: true },
      }),
      db.$queryRawUnsafe<
        { ccy: string; amt: unknown; inr: unknown; cnt: unknown; amt_ok: unknown; inr_ok: unknown }[]
      >(
        `SELECT vi.currency AS ccy, SUM(p.amount_foreign) AS amt, SUM(p.amount_inr) AS inr, COUNT(*) AS cnt,
                SUM(CASE WHEN p.approved_at IS NOT NULL THEN p.amount_foreign ELSE 0 END) AS amt_ok,
                SUM(CASE WHEN p.approved_at IS NOT NULL THEN p.amount_inr ELSE 0 END) AS inr_ok
         FROM vendor_payment p JOIN vendor_invoice vi ON vi.id = p.vendor_invoice_id
         WHERE p.fy = ?
         GROUP BY vi.currency`,
        fy,
      ),
      db.vendor_invoice.count({
        where: { fy, status: { in: OPEN_INVOICE_STATES }, due_date: { lt: today } },
      }),
      notYetBilled(fy),
      db.$queryRawUnsafe<{ ccy: string; amt: unknown; inr: unknown; cnt: unknown }[]>(
        `SELECT ${PAYOUT_CCY_SQL} AS ccy, SUM(${PAYOUT_AMT_SQL}) AS amt, SUM(p.amount_inr) AS inr, COUNT(*) AS cnt
         FROM partner_payout p
         WHERE p.status = ? AND p.fy = ?
         GROUP BY ccy`,
        PayoutStatus.RELEASED,
        fy,
      ),
      db.partner_payout.aggregate({
        where: { status: { in: UNPAID_PAYOUT_STATES } },
        _sum: { amount_inr: true },
        _count: { _all: true },
      }),
      // Approve commission: enrolled, no commission yet, deposit slip verified
      // (confirmBilling's gate).
      db.$queryRawUnsafe<{ ready: unknown; waiting: unknown }[]>(
        `SELECT COALESCE(SUM(x.verified), 0) AS ready, COALESCE(SUM(1 - x.verified), 0) AS waiting FROM (
           SELECT EXISTS (
             SELECT 1 FROM document d
             WHERE d.application_id = a.id AND d.doc_type = ? AND d.is_most_recent = 1 AND d.status = ?
           ) AS verified
           FROM application a
           WHERE a.status = ? AND NOT EXISTS (SELECT 1 FROM commission c WHERE c.application_id = a.id)
         ) x`,
        "deposit_receipt",
        DocumentStatus.APPROVED,
        UniApplicationStatus.ENROLLED,
      ),
      notYetBilled(null),
      db.vendor_payment.count({ where: { approved_at: null } }),
      db.invoice.count({
        where: { status: { in: [PartnerInvoiceStatus.SUBMITTED, PartnerInvoiceStatus.UNDER_REVIEW] } },
      }),
      db.partner_payout.count({ where: { status: { in: [PayoutStatus.APPROVED, PayoutStatus.ON_HOLD] } } }),
      db.partner_payout.count({ where: { status: PayoutStatus.READY_TO_PAY } }),
      db.vendor_invoice.count({ where: { status: { in: OPEN_INVOICE_STATES }, due_date: { lt: today } } }),
      openInvoices(),
      db.$queryRawUnsafe<{ ym: string; ccy: string; amt: unknown }[]>(
        `SELECT DATE_FORMAT(vi.invoice_date, '%Y-%m') AS ym, vi.currency AS ccy, SUM(vi.total_expected_amount) AS amt
         FROM vendor_invoice vi WHERE vi.fy = ? GROUP BY ym, ccy`,
        fy,
      ),
      db.$queryRawUnsafe<{ ym: string; ccy: string; amt: unknown; inr: unknown }[]>(
        `SELECT DATE_FORMAT(p.payment_date, '%Y-%m') AS ym, vi.currency AS ccy,
                SUM(p.amount_foreign) AS amt, SUM(p.amount_inr) AS inr
         FROM vendor_payment p JOIN vendor_invoice vi ON vi.id = p.vendor_invoice_id
         WHERE p.fy = ? GROUP BY ym, ccy`,
        fy,
      ),
      db.$queryRawUnsafe<{ ym: string; ccy: string; amt: unknown; inr: unknown }[]>(
        `SELECT DATE_FORMAT(COALESCE(p.payment_date, p.released_at), '%Y-%m') AS ym, ${PAYOUT_CCY_SQL} AS ccy,
                SUM(${PAYOUT_AMT_SQL}) AS amt, SUM(p.amount_inr) AS inr
         FROM partner_payout p WHERE p.status = ? AND p.fy = ? GROUP BY ym, ccy`,
        PayoutStatus.RELEASED,
        fy,
      ),
    ]);

    // KPIs
    const earned = emptyMoney();
    let earnedCount = 0;
    for (const r of earnedRows) {
      addMoney(earned, r.ccy, n(r.amt), null);
      earnedCount += n(r.cnt);
    }
    const billed = emptyMoney();
    let billedCount = 0;
    for (const r of billedRows) {
      addMoney(billed, r.currency, Number(r._sum.total_expected_amount ?? 0), null);
      billedCount += r._count._all;
    }
    const collected = emptyMoney();
    const approved = emptyMoney();
    let collectedCount = 0;
    for (const r of collectedRows) {
      addMoney(collected, r.ccy, n(r.amt), n(r.inr));
      addMoney(approved, r.ccy, n(r.amt_ok), n(r.inr_ok));
      collectedCount += n(r.cnt);
    }
    // Receivables: billed − collected per currency (University Billing's
    // stats compute the same difference in ₹).
    const receivables: Amounts = {};
    for (const ccy of new Set([...Object.keys(billed.by), ...Object.keys(collected.by)])) {
      const v = round2((billed.by[ccy] ?? 0) - (collected.by[ccy] ?? 0));
      if (v > 0) receivables[ccy] = v;
    }
    const distributed = emptyMoney();
    let distributedCount = 0;
    for (const r of distributedRows) {
      addMoney(distributed, r.ccy, n(r.amt), n(r.inr));
      distributedCount += n(r.cnt);
    }
    // Claims are in ₹; a foreign payee's currency amount is fixed at release.
    const payablesInr = round2(Number(payableRows._sum.amount_inr ?? 0));
    const payables: Money = { by: payablesInr > 0 ? { INR: payablesInr } : {}, inr: payablesInr };

    // Ageing (open invoices, as of today)
    const ageing = [0, 1, 2, 3].map((bucket) => {
      const rows = open.filter((r) => r.bucket === bucket && r.outstanding > 0);
      const by: Amounts = {};
      for (const r of rows) addTo(by, r.currency, r.outstanding);
      return { bucket, count: rows.length, notYetDue: rows.filter((r) => r.notYetDue).length, by };
    });

    // Top receivables by university (open invoices, as of today)
    const uniMap = new Map<number | string, { id: number; name: string; by: Amounts; invoices: number; overdue: number }>();
    for (const r of open) {
      if (r.outstanding <= 0) continue;
      const key = r.university.id || r.university.name;
      const u = uniMap.get(key) ?? { id: r.university.id, name: r.university.name, by: {}, invoices: 0, overdue: 0 };
      addTo(u.by, r.currency, r.outstanding);
      u.invoices += 1;
      if (r.daysOverdue > 0) u.overdue += 1;
      uniMap.set(key, u);
    }

    // Monthly trend, April → March
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(fy, 3 + i, 1));
      return d.toISOString().slice(0, 7);
    });
    const trend = months.map((ym) => ({
      month: ym,
      billed: emptyMoney(),
      collected: emptyMoney(),
      distributed: emptyMoney(),
    }));
    const byMonth = new Map(trend.map((t) => [t.month, t]));
    for (const r of billedTrend) {
      const t = byMonth.get(r.ym);
      if (t) addMoney(t.billed, r.ccy, n(r.amt), null);
    }
    for (const r of collectedTrend) {
      const t = byMonth.get(r.ym);
      if (t) addMoney(t.collected, r.ccy, n(r.amt), n(r.inr));
    }
    for (const r of distributedTrend) {
      const t = byMonth.get(r.ym);
      if (t) addMoney(t.distributed, r.ccy, n(r.amt), n(r.inr));
    }

    const placement = placementRows[0];
    return {
      fy,
      isCurrentFy: fy === financialYearOf(new Date()),
      today: todayStr,
      rates: { rates: rates.rates, fetchedAt: rates.fetchedAt },
      kpis: {
        placements: { students: n(placement?.students), applications: n(placement?.apps) },
        earned: { money: earned, count: earnedCount },
        billed: { money: billed, count: billedCount },
        collected: { money: collected, count: collectedCount },
        receivables: { money: { by: receivables, inr: null } as Money, overdueCount: overdueInFy },
        notBilled: { money: { by: notBilled.by, inr: null } as Money, items: notBilled.items, commissions: notBilled.commissions },
        distributed: { money: distributed, count: distributedCount },
        payables: { money: payables, count: payableRows._count._all },
      },
      flow: { earned, billed, collected, approved, distributed },
      actions: {
        approveCommission: n(approveCommission[0]?.ready),
        awaitingDepositSlip: n(approveCommission[0]?.waiting),
        instalmentsToInvoice: backlog.items,
        collectionsToApprove,
        claimsToReview,
        payoutsToVerify,
        payoutsToRelease,
        overdueInvoices: overdueOpen,
      },
      ageing,
      trend,
      universities: Array.from(uniMap.values()),
    };
  }),

  // Partner payouts released per payee (agency org or independent counsellor)
  // for the FY and the three before it, with the YoY change. For an FY still
  // in progress the YoY is same-period-to-date (1 Apr → today vs 1 Apr → the
  // same day last year); for a finished FY it's full year vs full year.
  partnerPayouts: financeProcedure.input(fyInput).query(async ({ input }) => {
    const { fy } = input;
    const fys = [fy - 3, fy - 2, fy - 1, fy];
    const todayStr = todayIst();
    const inProgress = fy === financialYearOf(new Date(`${todayStr}T00:00:00Z`));
    // Same day one year back ("2025-11-16"); 29 Feb falls back to 28 Feb.
    const [y, m, d] = todayStr.split("-").map(Number) as [number, number, number];
    const lastYear = new Date(Date.UTC(y - 1, m - 1, Math.min(d, m === 2 ? 28 : d)));
    const cutoffPrev = lastYear.toISOString().slice(0, 10);

    const [rows, prevToDate] = await Promise.all([
      db.$queryRawUnsafe<
        { org_id: number | null; payee_user_id: number | null; fy: number; ccy: string; amt: unknown; inr: unknown; cnt: unknown }[]
      >(
        `SELECT i.org_id, i.payee_user_id, p.fy, ${PAYOUT_CCY_SQL} AS ccy,
                SUM(${PAYOUT_AMT_SQL}) AS amt, SUM(p.amount_inr) AS inr, COUNT(*) AS cnt
         FROM partner_payout p JOIN invoice i ON i.id = p.invoice_id
         WHERE p.status = ? AND p.fy BETWEEN ? AND ?
         GROUP BY i.org_id, i.payee_user_id, p.fy, ccy`,
        PayoutStatus.RELEASED,
        fys[0],
        fy,
      ),
      inProgress
        ? db.$queryRawUnsafe<{ org_id: number | null; payee_user_id: number | null; inr: unknown }[]>(
            `SELECT i.org_id, i.payee_user_id, SUM(p.amount_inr) AS inr
             FROM partner_payout p JOIN invoice i ON i.id = p.invoice_id
             WHERE p.status = ? AND p.fy = ? AND COALESCE(p.payment_date, DATE(p.released_at)) <= ?
             GROUP BY i.org_id, i.payee_user_id`,
            PayoutStatus.RELEASED,
            fy - 1,
            cutoffPrev,
          )
        : Promise.resolve([]),
    ]);

    const keyOf = (r: { org_id: number | null; payee_user_id: number | null }) =>
      r.org_id != null ? `org:${r.org_id}` : `user:${r.payee_user_id}`;
    type Row = {
      key: string;
      orgId: number | null;
      userId: number | null;
      byFy: Record<number, Money & { count: number }>;
      prevToDateInr: number;
    };
    const map = new Map<string, Row>();
    for (const r of rows) {
      const k = keyOf(r);
      const row = map.get(k) ?? {
        key: k,
        orgId: r.org_id == null ? null : Number(r.org_id),
        userId: r.payee_user_id == null ? null : Number(r.payee_user_id),
        byFy: {},
        prevToDateInr: 0,
      };
      const f = Number(r.fy);
      const cell = row.byFy[f] ?? { by: {}, inr: null, count: 0 };
      addMoney(cell, r.ccy, n(r.amt), n(r.inr));
      cell.count += n(r.cnt);
      row.byFy[f] = cell;
      map.set(k, row);
    }
    for (const r of prevToDate) {
      const row = map.get(keyOf(r));
      if (row) row.prevToDateInr = round2(n(r.inr));
    }

    const orgIds = Array.from(map.values()).flatMap((r) => (r.orgId != null ? [r.orgId] : []));
    const userIds = Array.from(map.values()).flatMap((r) => (r.userId != null ? [r.userId] : []));
    const [orgs, users] = await Promise.all([
      orgIds.length ? db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [],
      userIds.length
        ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, first_name: true, last_name: true } })
        : [],
    ]);
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const userName = new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]));

    const inr = (row: Row, f: number) => row.byFy[f]?.inr ?? 0;
    const out = Array.from(map.values()).map((row) => {
      const current = inr(row, fy);
      const prevFull = inr(row, fy - 1);
      const base = inProgress ? row.prevToDateInr : prevFull;
      const yoyPct = base > 0 ? Math.round(((current - base) / base) * 1000) / 10 : null;
      const earlier = inr(row, fy - 2) + inr(row, fy - 3);
      // Flags: had payouts last FY and none this FY; down by half or more on
      // the comparison basis; new or back after a gap.
      const flag: "stopped" | "down" | "new" | "returning" | null =
        prevFull > 0 && current === 0
          ? "stopped"
          : yoyPct != null && yoyPct <= -50
            ? "down"
            : current > 0 && prevFull === 0
              ? earlier > 0
                ? "returning"
                : "new"
              : null;
      return {
        key: row.key,
        name:
          row.orgId != null
            ? (orgName.get(row.orgId) ?? `Partner #${row.orgId}`)
            : (userName.get(row.userId!) ?? `Counsellor #${row.userId}`),
        type: row.orgId != null ? ("agency" as const) : ("independent" as const),
        orgId: row.orgId,
        userId: row.userId,
        byFy: row.byFy,
        currentInr: current,
        baseInr: base,
        yoyPct,
        flag,
      };
    });
    out.sort((a, b) => b.currentInr - a.currentInr || (b.byFy[fy - 1]?.inr ?? 0) - (a.byFy[fy - 1]?.inr ?? 0));
    return {
      fys,
      compare: inProgress
        ? { mode: "toDate" as const, from: fyStart(fy).toISOString().slice(0, 10), to: todayStr, prevTo: cutoffPrev }
        : { mode: "full" as const },
      rows: out,
    };
  }),

  // Commission earned / billed / collected by channel: Direct (no vendor, or
  // a vendor of type Direct) vs each third-party vendor, for the FY and the
  // three before it. Grouped in SQL.
  channels: financeProcedure.input(fyInput).query(async ({ input }) => {
    const { fy } = input;
    const fys = [fy - 3, fy - 2, fy - 1, fy];
    const fyExpr = fyCase("COALESCE(c.approved_at, c.created_at)", fys);

    const [vendors, earnedRows, billedRows, collectedRows] = await Promise.all([
      db.vendor.findMany({ select: { id: true, name: true, type: true } }),
      db.$queryRawUnsafe<{ vendor_id: number | null; fy: unknown; ccy: string; amt: unknown; cnt: unknown }[]>(
        `SELECT c.vendor_id, ${fyExpr.sql} AS fy, c.currency AS ccy,
                SUM(${CP_SHARE_SQL("c.commision_amount")}) AS amt, COUNT(*) AS cnt
         FROM commission c
         WHERE COALESCE(c.approved_at, c.created_at) >= ? AND COALESCE(c.approved_at, c.created_at) < ?
         GROUP BY c.vendor_id, fy, ccy`,
        ...fyExpr.params,
        fyStart(fys[0]!),
        fyEnd(fy),
      ),
      db.vendor_invoice.groupBy({
        by: ["vendor_id", "fy", "currency"],
        where: { fy: { gte: fys[0], lte: fy } },
        _sum: { total_expected_amount: true },
      }),
      db.$queryRawUnsafe<{ vendor_id: number | null; fy: unknown; ccy: string; amt: unknown; inr: unknown }[]>(
        `SELECT vi.vendor_id, p.fy, vi.currency AS ccy, SUM(p.amount_foreign) AS amt, SUM(p.amount_inr) AS inr
         FROM vendor_payment p JOIN vendor_invoice vi ON vi.id = p.vendor_invoice_id
         WHERE p.fy BETWEEN ? AND ?
         GROUP BY vi.vendor_id, p.fy, ccy`,
        fys[0],
        fy,
      ),
    ]);

    const vendorById = new Map(vendors.map((v) => [v.id, v]));
    type Row = {
      key: string;
      name: string;
      channel: "direct" | "thirdParty";
      vendorId: number | null;
      earned: Record<number, Money>;
      billed: Record<number, Money>;
      collected: Record<number, Money>;
    };
    const map = new Map<string, Row>();
    const rowFor = (vendorId: number | null): Row => {
      const key = vendorId == null ? "direct" : `vendor:${vendorId}`;
      let row = map.get(key);
      if (!row) {
        const v = vendorId == null ? null : vendorById.get(vendorId);
        row = {
          key,
          name: vendorId == null ? "Direct" : (v?.name ?? `Vendor #${vendorId}`),
          channel: v == null || v.type === VendorType.DIRECT ? "direct" : "thirdParty",
          vendorId,
          earned: {},
          billed: {},
          collected: {},
        };
        map.set(key, row);
      }
      return row;
    };
    const cell = (rec: Record<number, Money>, f: number) => (rec[f] ??= emptyMoney());

    for (const r of earnedRows) {
      if (r.fy == null) continue;
      addMoney(cell(rowFor(r.vendor_id == null ? null : Number(r.vendor_id)).earned, Number(r.fy)), r.ccy, n(r.amt), null);
    }
    for (const r of billedRows) {
      if (r.fy == null) continue;
      addMoney(cell(rowFor(r.vendor_id).billed, r.fy), r.currency, Number(r._sum.total_expected_amount ?? 0), null);
    }
    for (const r of collectedRows) {
      if (r.fy == null) continue;
      addMoney(
        cell(rowFor(r.vendor_id == null ? null : Number(r.vendor_id)).collected, Number(r.fy)),
        r.ccy,
        n(r.amt),
        n(r.inr),
      );
    }
    // Third-party vendors with no activity yet still get a row, so the list
    // shows every channel Finance works with.
    for (const v of vendors) if (v.type !== VendorType.DIRECT) rowFor(v.id);

    const rows = Array.from(map.values()).sort((a, b) =>
      a.key === "direct" ? -1 : b.key === "direct" ? 1 : a.name.localeCompare(b.name),
    );
    return { fys, rows };
  }),
});
