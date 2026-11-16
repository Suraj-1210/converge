"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { canAccessAdminPath } from "~/lib/admin-sections";
import { money as fmtMoney } from "~/lib/currency";
import { formatINR, greeting } from "~/components/dashboard/format";
import { DashboardCard, EmptyState, Icon, Skeleton, SkeletonRows, type IconName } from "~/components/dashboard/widgets";
import { AdminRole, financialYearLabel } from "~/server/db/enums";

// The Finance dashboard (Suraj, 16 Nov 2026): Finance Managers and Executives
// land here instead of the general dashboard; Super Admins get it as a tab.
// Data: financeDashboard.* (read-only, finance roles only). Amounts come per
// currency; the INR view converts them with the stored exchange rates and
// shows anything without a rate as "not converted", never as 0.

type RO = inferRouterOutputs<AppRouter>;
type Overview = RO["financeDashboard"]["overview"];
type Money = Overview["kpis"]["earned"]["money"];
type Amounts = Money["by"];
type Rates = Record<string, number>;
type View = "inr" | "ccy";

const COLORS = {
  earned: "#0BA5EC",
  billed: "#1570EF",
  collected: "#12B76A",
  approved: "#039855",
  distributed: "#7F56D9",
};

// ₹ total of an amount: exact ₹ where it was booked in ₹, else converted at
// the stored rate. Currencies with no rate are returned in `missing`.
function toInr(m: Money, rates: Rates): { inr: number; missing: Amounts } {
  if (m.inr != null) return { inr: m.inr, missing: {} };
  let inr = 0;
  const missing: Amounts = {};
  for (const [ccy, amt] of Object.entries(m.by)) {
    if (!amt) continue;
    const rate = ccy === "INR" ? 1 : rates[ccy];
    if (rate) inr += amt * rate;
    else missing[ccy] = amt;
  }
  return { inr: Math.round(inr * 100) / 100, missing };
}

const entries = (a: Amounts) =>
  Object.entries(a)
    .filter(([, v]) => Math.abs(v) >= 0.005)
    .sort((x, y) => y[1] - x[1]);

const moneyOf = (by: Amounts): Money => ({ by, inr: null });

// "$2,970 · £2,150"
const listAmounts = (a: Amounts) =>
  entries(a)
    .map(([c, v]) => fmtMoney(Math.round(v), c))
    .join(" · ");

// "₹12.4 L" with a precise tooltip.
function Inr({ value }: { value: number }) {
  return <span title={fmtMoney(Math.round(value), "INR")}>{formatINR(Math.round(value))}</span>;
}

// One amount, in the chosen view. INR: the ₹ total plus what couldn't be
// converted. By currency: one line per currency.
function MoneyText({
  m,
  view,
  rates,
  max = 3,
  inline = false,
}: {
  m: Money;
  view: View;
  rates: Rates;
  max?: number;
  inline?: boolean;
}) {
  if (view === "inr") {
    const { inr, missing } = toInr(m, rates);
    const miss = entries(missing);
    return (
      <span className={inline ? "" : "block"}>
        {miss.length > 0 && inr === 0 ? <span className="text-[#98A2B3]">—</span> : <Inr value={inr} />}
        {miss.length > 0 && (
          <span
            className={`${inline ? "ml-1.5" : "mt-1 block"} text-[11px] font-medium text-[#B54708]`}
            title="No exchange rate stored for this currency"
          >
            + {listAmounts(missing)} not converted
          </span>
        )}
      </span>
    );
  }
  const rows = entries(m.by);
  if (rows.length === 0) return <span className="text-[#98A2B3]">—</span>;
  const shown = rows.slice(0, max);
  // Several currencies stacked: shrink relative to the card's figure size.
  return (
    <span className={inline ? "" : shown.length > 2 ? "block text-[0.72em] leading-snug" : "block"}>
      {shown.map(([c, v], i) =>
        inline ? (
          <span key={c}>
            {i > 0 && " · "}
            {fmtMoney(Math.round(v), c)}
          </span>
        ) : (
          <span key={c} className="block">
            {fmtMoney(Math.round(v), c)}
          </span>
        ),
      )}
      {rows.length > max && <span className="block text-[11px] text-[#98A2B3]">+{rows.length - max} more</span>}
    </span>
  );
}

const isFinanceManager = (role: number) => role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;

export function FinanceDashboard({ firstName, embedded = false }: { firstName?: string; embedded?: boolean }) {
  const me = api.authSession.me.useQuery().data;
  const sections = api.tabAccess.mine.useQuery().data?.sections;
  const fysQ = api.financeDashboard.financialYears.useQuery();
  const [fy, setFy] = useState<number | null>(null);
  const [view, setView] = useState<View>("inr");
  useEffect(() => {
    if (fy == null && fysQ.data) setFy(fysQ.data.current);
  }, [fy, fysQ.data]);

  const enabled = fy != null;
  const overviewQ = api.financeDashboard.overview.useQuery({ fy: fy ?? 0 }, { enabled });
  const payoutsQ = api.financeDashboard.partnerPayouts.useQuery({ fy: fy ?? 0 }, { enabled });
  const channelsQ = api.financeDashboard.channels.useQuery({ fy: fy ?? 0 }, { enabled });
  const o = overviewQ.data;
  const rates = useMemo<Rates>(() => o?.rates.rates ?? {}, [o]);
  const role = me?.role ?? -1;
  const canAct = isFinanceManager(role);
  const linkable = (href: string) => canAccessAdminPath(sections, href.split("?")[0]!);

  // Currencies on the page that have no stored rate (INR view only).
  const unconverted = useMemo(() => {
    if (!o) return [];
    const seen = new Set<string>();
    const scan = (m: Money) => {
      if (m.inr != null) return;
      for (const [c, v] of Object.entries(m.by)) if (v && c !== "INR" && !rates[c]) seen.add(c);
    };
    Object.values(o.flow).forEach(scan);
    scan(o.kpis.receivables.money);
    scan(o.kpis.notBilled.money);
    o.ageing.forEach((b) => scan(moneyOf(b.by)));
    return Array.from(seen).sort();
  }, [o, rates]);

  // By-currency view: the money flow and trend chart one currency at a time.
  // Ordered by commission-side activity (earned → approved), so the default
  // is the main contract currency; payout-only currencies (usually ₹) last.
  const currencies = useMemo(() => {
    if (!o) return [];
    const cpSide: Amounts = {};
    for (const m of [o.flow.earned, o.flow.billed, o.flow.collected, o.flow.approved])
      for (const [c, v] of Object.entries(m.by)) cpSide[c] = (cpSide[c] ?? 0) + v;
    const first = entries(cpSide).map(([c]) => c);
    const rest = Object.keys(o.flow.distributed.by).filter((c) => !first.includes(c));
    return [...first, ...rest];
  }, [o]);
  const [focusCcy, setFocusCcy] = useState<string | null>(null);
  const ccy = focusCcy && currencies.includes(focusCcy) ? focusCcy : (currencies[0] ?? "INR");

  const fyLabel = fy != null ? financialYearLabel(fy) : "";

  return (
    <>
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          {embedded ? (
            <h1 className="text-xl font-bold text-[#101828]">Finance</h1>
          ) : (
            <h1 className="text-2xl font-bold text-[#101828]" suppressHydrationWarning>
              {greeting()}
              {firstName ? `, ${firstName}` : ""} 👋
            </h1>
          )}
          <p className="mt-1 text-sm text-[#667085]">
            Placements, commission, billing, collections and partner payouts{fyLabel ? ` · ${fyLabel} (1 Apr – 31 Mar)` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-[#E4E7EC] bg-white px-3 text-[13px] font-medium text-[#344054]">
            <Icon name="calendar" size={15} className="text-[#667085]" />
            <select
              aria-label="Financial year"
              className="bg-transparent outline-none"
              value={fy ?? ""}
              onChange={(e) => setFy(Number(e.target.value))}
            >
              {(fysQ.data?.years ?? []).map((y) => (
                <option key={y} value={y}>
                  {financialYearLabel(y)}
                  {y === fysQ.data?.current ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="flex h-9 rounded-lg border border-[#E4E7EC] bg-white p-0.5 text-[13px] font-semibold" role="group" aria-label="Currency view">
            {(
              [
                ["inr", "INR (converted)"],
                ["ccy", "By currency"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`rounded-md px-3 transition ${view === v ? "bg-[#1570EF] text-white" : "text-[#667085] hover:text-[#344054]"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Missing exchange rates */}
      {view === "inr" && unconverted.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-[#FEDF89] bg-[#FFFCF5] px-4 py-3 text-[13px] text-[#B54708]">
          <Icon name="clock" size={16} />
          <span>
            No exchange rate stored for <strong>{unconverted.join(", ")}</strong>, so those amounts are shown as{" "}
            <em>not converted</em> rather than counted in ₹.{" "}
            {role === AdminRole.SUPER_ADMIN ? (
              <>
                Refresh rates in{" "}
                <Link href="/admin/settings" className="font-semibold underline">
                  Settings › Exchange Rates
                </Link>
                .
              </>
            ) : (
              <>A Super Admin can refresh them in Settings › Exchange Rates.</>
            )}
          </span>
        </div>
      )}

      {/* KPIs */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Placements"
          icon="students"
          tone="#1570EF"
          loading={!o}
          value={o ? o.kpis.placements.students.toLocaleString("en-IN") : ""}
          sub={o ? `students enrolled in ${fyLabel}` : undefined}
          href={linkable("/admin/student-placements") ? "/admin/student-placements" : undefined}
        />
        <Kpi
          label="Commission earned"
          icon="revenue"
          tone="#0BA5EC"
          loading={!o}
          value={o && <MoneyText max={6} m={o.kpis.earned.money} view={view} rates={rates} />}
          sub={o ? `CP share · ${o.kpis.earned.count} approved commission${o.kpis.earned.count === 1 ? "" : "s"}` : undefined}
          href={linkable("/admin/commissions") ? "/admin/commissions" : undefined}
        />
        <Kpi
          label="Billed to universities"
          icon="offer"
          tone="#1570EF"
          loading={!o}
          value={o && <MoneyText max={6} m={o.kpis.billed.money} view={view} rates={rates} />}
          sub={o ? `${o.kpis.billed.count} vendor invoice${o.kpis.billed.count === 1 ? "" : "s"}` : undefined}
          href={linkable("/admin/university-billing") ? "/admin/university-billing?tab=billing" : undefined}
        />
        <Kpi
          label="Collected"
          icon="check"
          tone="#12B76A"
          loading={!o}
          value={o && <MoneyText max={6} m={o.kpis.collected.money} view={view} rates={rates} />}
          sub={
            o
              ? view === "inr"
                ? `₹ actually received · ${o.kpis.collected.count} payment${o.kpis.collected.count === 1 ? "" : "s"}`
                : `${o.kpis.collected.count} payment${o.kpis.collected.count === 1 ? "" : "s"} recorded`
              : undefined
          }
          href={linkable("/admin/commissions") ? "/admin/commissions?tab=collections" : undefined}
        />
        <Kpi
          label="Receivables"
          icon="clock"
          tone="#F79009"
          loading={!o}
          value={o && <MoneyText max={6} m={o.kpis.receivables.money} view={view} rates={rates} />}
          sub={
            o ? (
              <>
                billed − collected in {fyLabel}
                {o.kpis.receivables.overdueCount > 0 && (
                  <span className="ml-1 font-semibold text-[#B42318]">· {o.kpis.receivables.overdueCount} overdue</span>
                )}
              </>
            ) : undefined
          }
          href={linkable("/admin/university-billing") ? "/admin/university-billing?tab=ageing" : undefined}
        />
        <Kpi
          label="Not yet billed"
          icon="deposit"
          tone="#667085"
          loading={!o}
          value={o && <MoneyText max={6} m={o.kpis.notBilled.money} view={view} rates={rates} />}
          sub={
            o
              ? `${o.kpis.notBilled.items} instalment${o.kpis.notBilled.items === 1 ? "" : "s"} of ${fyLabel}'s commission on no invoice`
              : undefined
          }
          href={linkable("/admin/university-billing") ? "/admin/university-billing?tab=billing" : undefined}
        />
        <Kpi
          label="Distributed to partners"
          icon="partners"
          tone="#7F56D9"
          loading={!o}
          value={o && <MoneyText max={6} m={o.kpis.distributed.money} view={view} rates={rates} />}
          sub={o ? `${o.kpis.distributed.count} payout${o.kpis.distributed.count === 1 ? "" : "s"} released` : undefined}
          href={linkable("/admin/invoices") ? "/admin/invoices" : undefined}
        />
        <Kpi
          label="Partner payables"
          icon="approvals"
          tone="#E31B54"
          loading={!o}
          value={o && <MoneyText max={6} m={o.kpis.payables.money} view={view} rates={rates} />}
          sub={o ? `${o.kpis.payables.count} approved claim${o.kpis.payables.count === 1 ? "" : "s"} not yet paid (all FYs)` : undefined}
          href={linkable("/admin/reconciliation") ? "/admin/reconciliation" : undefined}
        />
      </div>

      {/* Money flow + Needs action */}
      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <DashboardCard
          title={`Money flow · ${fyLabel}`}
          className="lg:col-span-2"
          headerRight={view === "ccy" ? <CurrencyChips list={currencies} value={ccy} onChange={setFocusCcy} /> : undefined}
        >
          {!o ? <SkeletonRows rows={5} /> : <MoneyFlow flow={o.flow} view={view} rates={rates} ccy={ccy} />}
        </DashboardCard>
        <DashboardCard title="Needs action" bodyClassName="p-2">
          {!o ? (
            <div className="p-3">
              <SkeletonRows rows={6} />
            </div>
          ) : (
            <NeedsAction actions={o.actions} canAct={canAct} linkable={linkable} />
          )}
        </DashboardCard>
      </div>

      {/* Ageing + top receivables */}
      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <DashboardCard title="Receivables ageing" headerRight={<span className="text-xs text-[#98A2B3]">open invoices, from due date</span>}>
          {!o ? <SkeletonRows rows={4} /> : <Ageing ageing={o.ageing} view={view} rates={rates} linkable={linkable} />}
        </DashboardCard>
        <DashboardCard title="Top receivables by university" headerRight={<span className="text-xs text-[#98A2B3]">open now</span>} bodyClassName="p-0">
          {!o ? (
            <div className="p-5">
              <SkeletonRows rows={5} />
            </div>
          ) : (
            <TopUniversities rows={o.universities} view={view} rates={rates} linkable={linkable} />
          )}
        </DashboardCard>
      </div>

      {/* Monthly trend */}
      <DashboardCard
        title={`Monthly trend · ${fyLabel}`}
        className="mb-5"
        headerRight={view === "ccy" ? <CurrencyChips list={currencies} value={ccy} onChange={setFocusCcy} /> : undefined}
      >
        {!o ? <Skeleton className="h-[220px] w-full" /> : <Trend trend={o.trend} view={view} rates={rates} ccy={ccy} />}
      </DashboardCard>

      {/* Partner payouts by FY */}
      <DashboardCard title="Partner payouts by financial year" className="mb-5" bodyClassName="p-0">
        {!payoutsQ.data ? (
          <div className="p-5">
            <SkeletonRows rows={5} />
          </div>
        ) : (
          <PartnerPayouts data={payoutsQ.data} view={view} />
        )}
      </DashboardCard>

      {/* Direct vs third-party */}
      <DashboardCard title="Direct vs third-party vendor income" className="mb-5" bodyClassName="p-0">
        {!channelsQ.data ? (
          <div className="p-5">
            <SkeletonRows rows={5} />
          </div>
        ) : (
          <Channels data={channelsQ.data} fy={fy!} view={view} rates={rates} />
        )}
      </DashboardCard>
    </>
  );
}

// ---------------------------------------------------------------------------

function Kpi({
  label,
  icon,
  tone,
  value,
  sub,
  href,
  loading,
}: {
  label: string;
  icon: IconName;
  tone: string;
  value: ReactNode;
  sub?: ReactNode;
  href?: string;
  loading: boolean;
}) {
  const body = (
    <>
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-[#667085] uppercase">{label}</span>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: `${tone}14`, color: tone }}
        >
          <Icon name={icon} size={18} />
        </span>
      </div>
      <div className="text-[24px] leading-tight font-extrabold text-[#101828]">
        {loading ? <span className="inline-block h-7 w-20 animate-pulse rounded bg-[#F2F4F7]" /> : value}
      </div>
      {!loading && sub && <div className="mt-2 text-xs text-[#667085]">{sub}</div>}
    </>
  );
  const cls =
    "block h-full rounded-xl border border-[#E4E7EC] bg-white p-5 transition-all hover:border-[#1570EF] hover:shadow-[0_4px_16px_rgba(21,112,239,0.08)]";
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function CurrencyChips({ list, value, onChange }: { list: string[]; value: string; onChange: (c: string) => void }) {
  if (list.length <= 1) return list[0] ? <span className="text-xs font-semibold text-[#667085]">{list[0]}</span> : null;
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          aria-pressed={c === value}
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
            c === value ? "bg-[#1570EF] text-white" : "bg-[#F2F4F7] text-[#475467] hover:bg-[#E4E7EC]"
          }`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

const FLOW_STAGES: { key: keyof Overview["flow"]; label: string; note: string }[] = [
  { key: "earned", label: "Earned", note: "CP share of commissions approved" },
  { key: "billed", label: "Billed", note: "vendor invoices raised" },
  { key: "collected", label: "Collected", note: "vendor payments recorded" },
  { key: "approved", label: "Approved", note: "collections approved → claimable" },
  { key: "distributed", label: "Distributed", note: "partner payouts released" },
];

function MoneyFlow({ flow, view, rates, ccy }: { flow: Overview["flow"]; view: View; rates: Rates; ccy: string }) {
  const values = FLOW_STAGES.map((s) => {
    const m = flow[s.key];
    if (view === "inr") {
      const { inr, missing } = toInr(m, rates);
      return { ...s, value: inr, missing };
    }
    // Partner payouts are booked in ₹ (or the remittance currency); a stage
    // with nothing in this currency shows an empty bar.
    return { ...s, value: m.by[ccy] ?? 0, missing: {} as Amounts };
  });
  const max = Math.max(1, ...values.map((v) => v.value));
  return (
    <div className="space-y-3.5">
      {values.map((v) => (
        <div key={v.key} className="grid grid-cols-[110px_1fr] items-center gap-3 sm:grid-cols-[130px_1fr_150px]">
          <div>
            <div className="text-[13px] font-semibold text-[#344054]">{v.label}</div>
            <div className="text-[11px] text-[#98A2B3]">{v.note}</div>
          </div>
          <div className="h-7 rounded-md bg-[#F2F4F7]">
            <div
              className="h-7 rounded-md transition-all"
              style={{ width: `${Math.max(v.value > 0 ? 1.5 : 0, (v.value / max) * 100)}%`, background: COLORS[v.key] }}
            />
          </div>
          <div className="col-span-2 text-right text-[13px] font-bold text-[#101828] sm:col-span-1">
            {view === "inr" ? (
              v.value === 0 && entries(v.missing).length > 0 ? (
                <span className="text-[#98A2B3]">—</span>
              ) : (
                <Inr value={v.value} />
              )
            ) : (
              fmtMoney(Math.round(v.value), ccy)
            )}
            {entries(v.missing).length > 0 && (
              <div className="text-[11px] font-medium text-[#B54708]">+ {listAmounts(v.missing)} not converted</div>
            )}
          </div>
        </div>
      ))}
      <p className="pt-1 text-[11px] text-[#98A2B3]">
        Earned, billed and collected are CP&apos;s share; distributed is the partners&apos; share paid out.
        {view === "ccy" && ccy !== "INR" && " Partner payouts are mostly in ₹, so the last bar is often empty here."}
      </p>
    </div>
  );
}

function NeedsAction({
  actions,
  canAct,
  linkable,
}: {
  actions: Overview["actions"];
  canAct: boolean;
  linkable: (href: string) => boolean;
}) {
  const rows: { label: string; count: number; href: string; fm: boolean; sub?: string }[] = [
    {
      label: "Approve commission",
      count: actions.approveCommission,
      href: "/admin/university-billing",
      fm: true,
      sub:
        actions.awaitingDepositSlip > 0
          ? `deposit slip verified · ${actions.awaitingDepositSlip} more waiting on a slip`
          : "deposit slip verified",
    },
    { label: "Instalments to invoice", count: actions.instalmentsToInvoice, href: "/admin/university-billing?tab=billing", fm: true },
    { label: "Collections awaiting approval", count: actions.collectionsToApprove, href: "/admin/commissions?tab=collections", fm: true },
    { label: "Partner claims to review", count: actions.claimsToReview, href: "/admin/invoices", fm: true },
    { label: "Payouts to verify", count: actions.payoutsToVerify, href: "/admin/reconciliation", fm: false },
    { label: "Payouts to release", count: actions.payoutsToRelease, href: "/admin/reconciliation", fm: true },
    { label: "Overdue invoices", count: actions.overdueInvoices, href: "/admin/university-billing?tab=ageing&overdue=1", fm: false, sub: "chase the university" },
  ];
  return (
    <ul>
      {rows.map((r) => {
        const open = linkable(r.href);
        const inner = (
          <>
            <span
              className={`flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-[13px] font-bold ${
                r.count > 0 ? "bg-[#FEF0C7] text-[#B54708]" : "bg-[#F2F4F7] text-[#98A2B3]"
              }`}
            >
              {r.count}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-[#344054]">
                {r.label}
                {r.fm && (
                  <span className="rounded bg-[#F4EBFF] px-1.5 py-px text-[10px] font-bold text-[#6941C6]" title="Finance Manager or Super Admin action">
                    FM
                  </span>
                )}
              </span>
              {r.sub && <span className="block text-[11px] text-[#98A2B3]">{r.sub}</span>}
            </span>
            {r.fm && !canAct ? (
              <span className="text-[11px] font-semibold text-[#98A2B3]">FM approves</span>
            ) : open && r.count > 0 ? (
              <span className="text-[12px] font-semibold text-[#1570EF]">Open →</span>
            ) : null}
          </>
        );
        return (
          <li key={r.label}>
            {open ? (
              <Link href={r.href} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-[#F9FAFB]">
                {inner}
              </Link>
            ) : (
              <div className="flex items-center gap-3 px-3 py-2.5">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const AGEING_LABELS = ["0–30 days", "31–60 days", "61–90 days", "90+ days"];
const AGEING_COLORS = ["#12B76A", "#F79009", "#F04438", "#B42318"];

function Ageing({
  ageing,
  view,
  rates,
  linkable,
}: {
  ageing: Overview["ageing"];
  view: View;
  rates: Rates;
  linkable: (href: string) => boolean;
}) {
  const totals = ageing.map((b) => (view === "inr" ? toInr(moneyOf(b.by), rates).inr : 0));
  const sum = totals.reduce((s, v) => s + v, 0);
  const open = linkable("/admin/university-billing");
  return (
    <div>
      {view === "inr" && sum > 0 && (
        <div className="mb-4 flex h-3 overflow-hidden rounded-full bg-[#F2F4F7]">
          {totals.map((t, i) => (
            <div key={i} style={{ width: `${(t / sum) * 100}%`, background: AGEING_COLORS[i] }} title={AGEING_LABELS[i]} />
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {ageing.map((b) => {
          const href = `/admin/university-billing?tab=ageing&bucket=${b.bucket}`;
          const body = (
            <>
              <div className="flex items-center gap-2 text-[12px] font-semibold text-[#667085]">
                <span className="h-2 w-2 rounded-full" style={{ background: AGEING_COLORS[b.bucket] }} />
                {AGEING_LABELS[b.bucket]}
              </div>
              <div className={`mt-1 text-[18px] font-extrabold ${b.bucket >= 2 && b.count > 0 ? "text-[#B42318]" : "text-[#101828]"}`}>
                <MoneyText m={moneyOf(b.by)} view={view} rates={rates} max={2} />
              </div>
              <div className="mt-0.5 text-[11px] text-[#98A2B3]">
                {b.count} invoice{b.count === 1 ? "" : "s"}
                {b.bucket === 0 && b.notYetDue > 0 && ` · ${b.notYetDue} not yet due`}
              </div>
            </>
          );
          return open && b.count > 0 ? (
            <Link key={b.bucket} href={href} className="rounded-xl border border-[#E4E7EC] p-3.5 hover:border-[#1570EF]">
              {body}
            </Link>
          ) : (
            <div key={b.bucket} className="rounded-xl border border-[#E4E7EC] p-3.5">
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TopUniversities({
  rows,
  view,
  rates,
  linkable,
}: {
  rows: Overview["universities"];
  view: View;
  rates: Rates;
  linkable: (href: string) => boolean;
}) {
  // Rank by ₹ where a rate exists; amounts that can't be converted sort last.
  const ranked = [...rows]
    .map((r) => ({ ...r, inr: toInr(moneyOf(r.by), rates).inr }))
    .sort((a, b) => b.inr - a.inr || b.overdue - a.overdue)
    .slice(0, 8);
  if (ranked.length === 0) return <EmptyState label="Nothing outstanding — every invoice is collected." />;
  const open = linkable("/admin/university-billing");
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="text-left text-[11px] font-semibold tracking-wide text-[#667085] uppercase">
          <th className="px-5 py-2.5">University</th>
          <th className="px-3 py-2.5 text-right">Outstanding</th>
          <th className="px-5 py-2.5 text-right">Overdue</th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((r) => (
          <tr key={`${r.id}-${r.name}`} className="border-t border-[#F2F4F7]">
            <td className="px-5 py-2.5 font-medium text-[#101828]">
              {open ? (
                <Link
                  href={`/admin/university-billing?tab=ageing&university=${encodeURIComponent(r.name)}`}
                  className="hover:text-[#1570EF] hover:underline"
                >
                  {r.name}
                </Link>
              ) : (
                r.name
              )}
              <span className="ml-1.5 text-[11px] text-[#98A2B3]">
                {r.invoices} invoice{r.invoices === 1 ? "" : "s"}
              </span>
            </td>
            <td className="px-3 py-2.5 text-right font-semibold text-[#101828]">
              <MoneyText m={moneyOf(r.by)} view={view} rates={rates} max={2} />
            </td>
            <td className="px-5 py-2.5 text-right">
              {r.overdue > 0 ? (
                <span className="rounded-full bg-[#FEF3F2] px-2 py-0.5 text-[11px] font-bold text-[#B42318]">{r.overdue}</span>
              ) : (
                <span className="text-[#98A2B3]">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const TREND_SERIES = [
  { key: "billed", label: "Billed", color: COLORS.billed },
  { key: "collected", label: "Collected", color: COLORS.collected },
  { key: "distributed", label: "Distributed", color: COLORS.distributed },
] as const;

function compact(v: number, ccy: string): string {
  if (ccy === "INR") return formatINR(Math.round(v));
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : `${Math.round(v)}`;
  return fmtMoney(0, ccy).replace("0", s);
}

function Trend({ trend, view, rates, ccy }: { trend: Overview["trend"]; view: View; rates: Rates; ccy: string }) {
  const unit = view === "inr" ? "INR" : ccy;
  const missing: Amounts = {};
  const data = trend.map((t) =>
    TREND_SERIES.map((s) => {
      const m = t[s.key];
      if (view === "ccy") return m.by[ccy] ?? 0;
      const r = toInr(m, rates);
      for (const [c, v] of Object.entries(r.missing)) missing[c] = (missing[c] ?? 0) + v;
      return r.inr;
    }),
  );
  const max = Math.max(0, ...data.flat());
  if (max === 0) return <EmptyState label={`No billing, collections or payouts in ${unit} this year yet.`} />;
  const W = 720;
  const H = 220;
  const padL = 56;
  const padB = 24;
  const plotH = H - padB - 8;
  const groupW = (W - padL) / 12;
  const barW = Math.min(14, (groupW - 10) / 3);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4 text-[12px] text-[#475467]">
        {TREND_SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="text-[#98A2B3]">in {unit === "INR" && view === "inr" ? "₹ (converted)" : unit}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Monthly billed, collected and distributed">
        {ticks.map((t, i) => {
          const y = 8 + plotH - (t / max) * plotH;
          return (
            <g key={i}>
              <line x1={padL} x2={W} y1={y} y2={y} stroke="#F2F4F7" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#98A2B3">
                {compact(t, unit)}
              </text>
            </g>
          );
        })}
        {data.map((vals, mi) => (
          <g key={mi}>
            {vals.map((v, si) => {
              const h = (v / max) * plotH;
              const x = padL + mi * groupW + (groupW - barW * 3 - 4) / 2 + si * (barW + 2);
              return (
                <rect key={si} x={x} y={8 + plotH - h} width={barW} height={Math.max(0, h)} rx={2} fill={TREND_SERIES[si]!.color}>
                  <title>{`${MONTHS[mi]} · ${TREND_SERIES[si]!.label}: ${unit === "INR" ? fmtMoney(Math.round(v), "INR") : fmtMoney(Math.round(v), unit)}`}</title>
                </rect>
              );
            })}
            <text x={padL + mi * groupW + groupW / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="#667085">
              {MONTHS[mi]}
            </text>
          </g>
        ))}
      </svg>
      {view === "inr" && entries(missing).length > 0 && (
        <p className="mt-2 text-[11px] font-medium text-[#B54708]">Not in the chart (no exchange rate): {listAmounts(missing)}</p>
      )}
    </div>
  );
}

// --- Partner payouts by FY -------------------------------------------------

type Payouts = RO["financeDashboard"]["partnerPayouts"];

const FLAG_STYLE: Record<NonNullable<Payouts["rows"][number]["flag"]>, { label: string; cls: string }> = {
  stopped: { label: "No payouts this FY", cls: "bg-[#FEF3F2] text-[#B42318]" },
  down: { label: "Down sharply", cls: "bg-[#FFF6ED] text-[#B54708]" },
  new: { label: "New", cls: "bg-[#ECFDF3] text-[#027A48]" },
  returning: { label: "Back after a gap", cls: "bg-[#EFF8FF] text-[#175CD3]" },
};

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 56 + 2},${20 - (v / max) * 16}`).join(" ");
  const last = values[values.length - 1] ?? 0;
  const prev = values[values.length - 2] ?? 0;
  const color = last > prev ? "#12B76A" : last < prev ? "#F04438" : "#98A2B3";
  return (
    <svg width="60" height="22" viewBox="0 0 60 22" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function PartnerPayouts({ data, view }: { data: Payouts; view: View }) {
  const [filter, setFilter] = useState<"all" | "flagged">("all");
  const [showAll, setShowAll] = useState(false);
  const fy = data.fys[data.fys.length - 1]!;
  const rows = data.rows.filter((r) => filter === "all" || r.flag === "stopped" || r.flag === "down");
  const flagged = data.rows.filter((r) => r.flag === "stopped" || r.flag === "down").length;
  const shown = showAll ? rows : rows.slice(0, 12);
  const cmp =
    data.compare.mode === "toDate"
      ? `YoY is same period to date: 1 Apr – ${fmtDay(data.compare.to)} vs 1 Apr – ${fmtDay(data.compare.prevTo)}, in ₹.`
      : `YoY is ${financialYearLabel(fy)} vs ${financialYearLabel(fy - 1)}, full years, in ₹.`;
  if (data.rows.length === 0) {
    return <EmptyState label="No partner payouts released in these four years." />;
  }
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <p className="text-[12px] text-[#667085]">
          Released payouts per partner (agency or independent counsellor), sorted by {financialYearLabel(fy)}. {cmp}
        </p>
        <div className="flex gap-1 text-[12px] font-semibold">
          {(
            [
              ["all", `All (${data.rows.length})`],
              ["flagged", `Falling away (${flagged})`],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setFilter(v)}
              aria-pressed={filter === v}
              className={`rounded-full px-3 py-1 ${filter === v ? "bg-[#1570EF] text-white" : "bg-[#F2F4F7] text-[#475467]"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead>
            <tr className="border-t border-[#F2F4F7] text-left text-[11px] font-semibold tracking-wide text-[#667085] uppercase">
              <th className="px-5 py-2.5">Partner</th>
              {data.fys.map((f) => (
                <th key={f} className="px-3 py-2.5 text-right">
                  {financialYearLabel(f).replace("FY ", "")}
                  {f === fy && data.compare.mode === "toDate" && <span className="font-normal normal-case"> (to date)</span>}
                </th>
              ))}
              <th className="px-3 py-2.5 text-center">Trend</th>
              <th className="px-3 py-2.5 text-right">YoY</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className="border-t border-[#F2F4F7] align-top">
                <td className="px-5 py-2.5">
                  <div className="font-medium text-[#101828]">{r.name}</div>
                  <div className="text-[11px] text-[#98A2B3]">{r.type === "agency" ? "Agency" : "Independent counsellor"}</div>
                </td>
                {data.fys.map((f) => {
                  const cell = r.byFy[f];
                  return (
                    <td key={f} className={`px-3 py-2.5 text-right ${f === fy ? "font-semibold text-[#101828]" : "text-[#475467]"}`}>
                      {!cell ? (
                        <span className="text-[#D0D5DD]">—</span>
                      ) : view === "inr" ? (
                        <Inr value={cell.inr ?? 0} />
                      ) : (
                        <MoneyText m={cell} view="ccy" rates={{}} max={3} />
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-center">
                  <Sparkline values={data.fys.map((f) => r.byFy[f]?.inr ?? 0)} />
                </td>
                <td className="px-3 py-2.5 text-right font-semibold">
                  {r.yoyPct == null ? (
                    <span className="text-[#98A2B3]">—</span>
                  ) : (
                    <span className={r.yoyPct >= 0 ? "text-[#027A48]" : "text-[#B42318]"}>
                      {r.yoyPct > 0 ? "+" : ""}
                      {r.yoyPct.toFixed(0)}%
                    </span>
                  )}
                </td>
                <td className="px-5 py-2.5 text-right">
                  {r.flag && (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${FLAG_STYLE[r.flag].cls}`}>
                      {FLAG_STYLE[r.flag].label}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 12 && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="w-full border-t border-[#F2F4F7] py-2.5 text-[13px] font-semibold text-[#1570EF] hover:bg-[#F9FAFB]"
        >
          {showAll ? "Show top 12" : `Show all ${rows.length}`}
        </button>
      )}
      <p className="border-t border-[#F2F4F7] px-5 py-2.5 text-[11px] text-[#98A2B3]">
        Flags: <strong>No payouts this FY</strong> = paid last FY, nothing yet this FY; <strong>Down sharply</strong> = 50% or more below
        the comparison period.
        {view === "ccy" && " By currency shows what was actually remitted (₹, or the foreign amount for payees abroad)."}
      </p>
    </div>
  );
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// --- Direct vs third-party --------------------------------------------------

type ChannelsData = RO["financeDashboard"]["channels"];
type Metric = "earned" | "billed" | "collected";

function sumMoney(list: (Money | undefined)[]): Money {
  const parts = list.filter((m): m is Money => m != null);
  const by: Amounts = {};
  for (const m of parts) for (const [c, v] of Object.entries(m.by)) by[c] = (by[c] ?? 0) + v;
  // Exact ₹ only when every part has it (collections); otherwise convert.
  const exact = parts.length > 0 && parts.every((m) => m.inr != null);
  return { by, inr: exact ? parts.reduce((s, m) => s + (m.inr ?? 0), 0) : null };
}

function Channels({ data, fy, view, rates }: { data: ChannelsData; fy: number; view: View; rates: Rates }) {
  const [metric, setMetric] = useState<Metric>("earned");
  const direct = data.rows.filter((r) => r.channel === "direct");
  const third = data.rows.filter((r) => r.channel === "thirdParty");
  const totalOf = (rows: ChannelsData["rows"], f: number) => sumMoney(rows.map((r) => r[metric][f]));

  // Share for the selected FY: ₹ in the INR view, per currency otherwise.
  const shareRows: { label: string; direct: number; third: number; unit: string; missing?: Amounts }[] = [];
  if (view === "inr") {
    const d = toInr(totalOf(direct, fy), rates);
    const t = toInr(totalOf(third, fy), rates);
    const missing: Amounts = { ...d.missing };
    for (const [c, v] of Object.entries(t.missing)) missing[c] = (missing[c] ?? 0) + v;
    shareRows.push({ label: "All currencies (₹)", direct: d.inr, third: t.inr, unit: "INR", missing });
  } else {
    const d = totalOf(direct, fy).by;
    const t = totalOf(third, fy).by;
    for (const c of new Set([...Object.keys(d), ...Object.keys(t)])) {
      if ((d[c] ?? 0) + (t[c] ?? 0) > 0) shareRows.push({ label: c, direct: d[c] ?? 0, third: t[c] ?? 0, unit: c });
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <p className="text-[12px] text-[#667085]">
          Direct = university contracts with no vendor. Third-party = commission through an aggregator (CP&apos;s share).
        </p>
        <div className="flex gap-1 text-[12px] font-semibold">
          {(["earned", "billed", "collected"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={metric === m}
              onClick={() => setMetric(m)}
              className={`rounded-full px-3 py-1 capitalize ${metric === m ? "bg-[#1570EF] text-white" : "bg-[#F2F4F7] text-[#475467]"}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 px-5 pb-4">
        {shareRows.length === 0 && <p className="text-[13px] text-[#98A2B3]">Nothing {metric} in {financialYearLabel(fy)} yet.</p>}
        {shareRows.map((s) => {
          const total = s.direct + s.third;
          const dPct = total > 0 ? Math.round((s.direct / total) * 100) : 0;
          return (
            <div key={s.label}>
              <div className="mb-1 flex flex-wrap justify-between gap-2 text-[12px]">
                <span className="font-semibold text-[#344054]">
                  {financialYearLabel(fy)} · {s.label}
                </span>
                <span className="text-[#667085]">
                  <span className="font-semibold text-[#1570EF]">Direct {dPct}%</span> ({s.unit === "INR" ? formatINR(Math.round(s.direct)) : fmtMoney(Math.round(s.direct), s.unit)})
                  {" · "}
                  <span className="font-semibold text-[#F79009]">Third-party {total > 0 ? 100 - dPct : 0}%</span> (
                  {s.unit === "INR" ? formatINR(Math.round(s.third)) : fmtMoney(Math.round(s.third), s.unit)})
                </span>
              </div>
              <div className="flex h-3 overflow-hidden rounded-full bg-[#F2F4F7]">
                <div style={{ width: `${total > 0 ? (s.direct / total) * 100 : 0}%`, background: "#1570EF" }} />
                <div style={{ width: `${total > 0 ? (s.third / total) * 100 : 0}%`, background: "#F79009" }} />
              </div>
              {s.missing && entries(s.missing).length > 0 && (
                <div className="mt-1 text-[11px] font-medium text-[#B54708]">+ {listAmounts(s.missing)} not converted (not in the split)</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[13px]">
          <thead>
            <tr className="border-t border-[#F2F4F7] text-left text-[11px] font-semibold tracking-wide text-[#667085] uppercase">
              <th className="px-5 py-2.5">Channel</th>
              {data.fys.map((f) => (
                <th key={f} className="px-3 py-2.5 text-right">
                  {financialYearLabel(f).replace("FY ", "")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Direct", direct],
                ["Third-party vendors", third],
              ] as const
            ).map(([groupLabel, rows]) => (
              <ChannelGroup key={groupLabel} label={groupLabel} rows={rows} fys={data.fys} metric={metric} view={view} rates={rates} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChannelGroup({
  label,
  rows,
  fys,
  metric,
  view,
  rates,
}: {
  label: string;
  rows: ChannelsData["rows"];
  fys: number[];
  metric: Metric;
  view: View;
  rates: Rates;
}) {
  if (rows.length === 0) return null;
  const showSubtotal = rows.length > 1 || rows[0]!.name !== label;
  return (
    <>
      {showSubtotal && (
        <tr className="border-t border-[#E4E7EC] bg-[#F9FAFB]">
          <td className="px-5 py-2 text-[12px] font-bold text-[#344054]">{label}</td>
          {fys.map((f) => (
            <td key={f} className="px-3 py-2 text-right text-[12px] font-bold text-[#344054]">
              <MoneyText m={sumMoney(rows.map((r) => r[metric][f]))} view={view} rates={rates} max={3} />
            </td>
          ))}
        </tr>
      )}
      {rows.map((r) => (
        <tr key={r.key} className="border-t border-[#F2F4F7]">
          <td className={`py-2.5 ${showSubtotal ? "pr-5 pl-8" : "px-5 font-semibold"} text-[#101828]`}>{r.name}</td>
          {fys.map((f) => {
            const m = r[metric][f];
            return (
              <td key={f} className="px-3 py-2.5 text-right text-[#475467]">
                {m ? <MoneyText m={m} view={view} rates={rates} max={3} /> : <span className="text-[#D0D5DD]">—</span>}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
