"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DashboardCard, EmptyState, Icon, type IconName } from "~/components/dashboard/widgets";
import {
  FUNNEL_RULE,
  METRICS,
  type DrillMetric,
  type MetricKey,
  type ReportFilters,
} from "~/lib/reports";

// ---------------------------------------------------------------------------
// Drill-down: every count opens the records behind it.
// ---------------------------------------------------------------------------
export interface Drill {
  metric: DrillMetric;
  title: string;
  filters: ReportFilters;
}
const DrillContext = createContext<(d: Drill) => void>(() => undefined);
export const DrillProvider = DrillContext.Provider;
export const useDrill = () => useContext(DrillContext);

// Series colours, shared by cards and charts so a metric looks the same
// everywhere (portal palette).
export const SERIES: Partial<Record<MetricKey, string>> & Record<string, string> = {
  total: "#1570EF",
  active: "#7F56D9",
  activeUnique: "#6941C6",
  submitted: "#0BA5EC",
  conditional: "#9E77ED",
  unconditional: "#B692F6",
  depositPaid: "#F79009",
  depositInProcess: "#F79009",
  visaFiled: "#0BA5EC",
  visaApproved: "#12B76A",
  visaRejected: "#F04438",
  rejected: "#B42318",
  leads: "#0BA5EC",
  shortlisted: "#7F56D9",
  partnerShortlistApproved: "#B692F6",
};

export const fmtN = (n: number) => n.toLocaleString("en-IN");

// ---------------------------------------------------------------------------
// KPI card (Finance dashboard style), clickable into its records.
// ---------------------------------------------------------------------------
export function Kpi({
  label,
  value,
  icon,
  tone,
  sub,
  drill,
  loading,
  delta,
}: {
  label: string;
  value: number | undefined;
  icon: IconName;
  tone: string;
  sub?: ReactNode;
  drill?: Drill;
  loading?: boolean;
  // Week-on-week: the previous period's value.
  delta?: number;
}) {
  const open = useDrill();
  const clickable = !!drill && !loading;
  const diff = delta === undefined || value === undefined ? null : value - delta;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => drill && open(drill)}
      title={clickable ? "Show the records" : undefined}
      className="group flex h-full w-full flex-col items-stretch justify-start rounded-xl border border-[#E4E7EC] bg-white p-5 text-left transition-all enabled:cursor-pointer enabled:hover:border-[#1570EF] enabled:hover:shadow-[0_4px_16px_rgba(21,112,239,0.08)]"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-[#667085] uppercase">{label}</span>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: `${tone}14`, color: tone }}
        >
          <Icon name={icon} size={18} />
        </span>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-[28px] leading-none font-extrabold text-[#101828]">
          {loading || value === undefined ? (
            <span className="inline-block h-7 w-14 animate-pulse rounded bg-[#F2F4F7]" />
          ) : (
            fmtN(value)
          )}
        </span>
        {diff !== null && !loading && (
          <span
            className={`mb-0.5 inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              diff > 0
                ? "bg-[#ECFDF3] text-[#027A48]"
                : diff < 0
                  ? "bg-[#FEF3F2] text-[#B42318]"
                  : "bg-[#F2F4F7] text-[#667085]"
            }`}
            title={`Previous period: ${fmtN(delta!)}`}
          >
            {diff > 0 && <Icon name="trend-up" size={11} />}
            {diff < 0 && <Icon name="trend-down" size={11} />}
            {diff === 0 ? "no change" : `${diff > 0 ? "+" : ""}${fmtN(diff)}`}
          </span>
        )}
      </div>
      {sub && !loading && <div className="mt-2 text-xs text-[#667085]">{sub}</div>}
    </button>
  );
}

// A count in a table cell; opens its records. Zero is shown muted and inert.
export function CountCell({ value, drill, strong }: { value: number; drill: Drill; strong?: boolean }) {
  const open = useDrill();
  if (value === 0) return <span className="text-[#D0D5DD]">0</span>;
  return (
    <button
      type="button"
      onClick={() => open(drill)}
      className={`rounded px-1.5 py-0.5 tabular-nums transition hover:bg-[#EFF8FF] hover:text-[#1570EF] ${
        strong ? "font-bold text-[#101828]" : "font-semibold text-[#344054]"
      }`}
      title="Show the records"
    >
      {fmtN(value)}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Breakdown table: one row per group, a column per metric, a TOTAL row.
// Headers re-sort; the default order is the workbook's.
// ---------------------------------------------------------------------------
export interface Column<R> {
  key: string;
  label: string;
  value: (r: R) => number;
  drill?: (r: R | null) => Drill | null;
  // The TOTAL row's figure when it isn't the column sum (distinct counts).
  total?: number;
  strong?: boolean;
  hint?: string;
}

export function BreakdownTable<R extends { key: string }>({
  rows,
  name,
  nameLabel,
  columns,
  rank = true,
  emptyLabel,
  maxHeight,
}: {
  rows: R[];
  name: (r: R) => ReactNode;
  nameLabel: string;
  columns: Column<R>[];
  rank?: boolean;
  emptyLabel?: string;
  maxHeight?: number;
}) {
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const c = columns.find((x) => x.key === sort.col);
    if (!c) return rows;
    return [...rows].sort((a, b) => (c.value(a) - c.value(b)) * sort.dir);
  }, [rows, sort, columns]);
  if (rows.length === 0) return <EmptyState label={emptyLabel ?? "Nothing for these filters."} />;
  const th = "border-b border-[#E4E7EC] px-3 py-2.5 whitespace-nowrap";
  return (
    <div className="overflow-x-auto" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-[#F9FAFB] text-left text-[11px] font-semibold tracking-[0.3px] text-[#667085] uppercase">
            {rank && <th className={`${th} w-12`}>#</th>}
            <th className={th}>{nameLabel}</th>
            {columns.map((c) => (
              <th key={c.key} className={`${th} text-right`} title={c.hint}>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 uppercase hover:text-[#1570EF]"
                  onClick={() =>
                    setSort((s) => (s?.col === c.key ? (s.dir === -1 ? { col: c.key, dir: 1 } : null) : { col: c.key, dir: -1 }))
                  }
                >
                  {c.label}
                  {sort?.col === c.key && <span aria-hidden>{sort.dir === -1 ? "↓" : "↑"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.key} className="border-b border-[#F2F4F7] hover:bg-[#FCFCFD]">
              {rank && <td className="px-3 py-2 text-xs font-semibold text-[#98A2B3]">{i + 1}</td>}
              <td className="max-w-[320px] px-3 py-2 font-medium text-[#101828]">{name(r)}</td>
              {columns.map((c) => {
                const d = c.drill?.(r);
                const v = c.value(r);
                return (
                  <td key={c.key} className="px-3 py-1.5 text-right">
                    {d ? <CountCell value={v} drill={d} strong={c.strong} /> : <span className="tabular-nums">{fmtN(v)}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-[#F9FAFB] font-bold">
            {rank && <td />}
            <td className="px-3 py-2.5 text-[12px] tracking-wide text-[#344054] uppercase">Total</td>
            {columns.map((c) => {
              const v = c.total ?? rows.reduce((s, r) => s + c.value(r), 0);
              const d = c.drill?.(null);
              return (
                <td key={c.key} className="px-3 py-2 text-right">
                  {d ? <CountCell value={v} drill={d} strong /> : <span className="tabular-nums">{fmtN(v)}</span>}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal grouped bars (country / university / RM / counsellor
// comparisons). Bars open their records.
// ---------------------------------------------------------------------------
export function HBarChart<R extends { key: string }>({
  rows,
  name,
  series,
  limit = 10,
}: {
  rows: R[];
  name: (r: R) => string;
  series: { key: string; label: string; color: string; value: (r: R) => number; drill?: (r: R) => Drill }[];
  limit?: number;
}) {
  const open = useDrill();
  const shown = rows.slice(0, limit);
  const max = Math.max(1, ...shown.flatMap((r) => series.map((s) => s.value(r))));
  if (shown.length === 0 || max === 0) return <EmptyState label="Nothing to chart for these filters." />;
  return (
    <div>
      <Legend items={series} />
      <div className="space-y-3">
        {shown.map((r) => (
          <div key={r.key} className="grid grid-cols-[minmax(90px,30%)_1fr] items-center gap-3">
            <div className="truncate text-[12.5px] font-medium text-[#344054]" title={name(r)}>
              {name(r)}
            </div>
            <div className="space-y-1">
              {series.map((s) => {
                const v = s.value(r);
                if (!v) return null;
                const pct = Math.max(2, (v / max) * 100);
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!v || !s.drill}
                      onClick={() => s.drill && open(s.drill(r))}
                      className="h-3.5 rounded-sm transition-opacity enabled:cursor-pointer enabled:hover:opacity-80"
                      style={{ width: `${pct}%`, background: s.color, minWidth: v ? 4 : 0 }}
                      title={`${s.label}: ${fmtN(v)}`}
                    />
                    <span className="text-[11px] font-semibold text-[#475467] tabular-nums">{v ? fmtN(v) : ""}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {rows.length > limit && (
        <p className="mt-3 text-[11px] text-[#98A2B3]">
          Top {limit} of {rows.length}; the table below lists all.
        </p>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#475467]">
      {items.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vertical grouped bars over periods (weekly trend).
// ---------------------------------------------------------------------------
export function TrendChart({
  labels,
  series,
  highlightLast = true,
}: {
  labels: string[];
  series: { key: string; label: string; color: string; values: number[] }[];
  highlightLast?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const hasData = max > 0;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(360, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);
  if (max === 0) return <EmptyState label="No leads or submissions in these periods." />;
  const H = 240;
  const padL = 36;
  const padB = 34;
  const plotH = H - padB - 10;
  const n = labels.length;
  const groupW = (W - padL) / n;
  const barW = Math.min(22, (groupW - 14) / series.length);
  const nice = Math.max(1, Math.ceil(max / 4));
  const top = nice * 4;
  return (
    <div ref={box}>
      <Legend items={series} />
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label="Trend by period">
        {[0, 1, 2, 3, 4].map((i) => {
          const v = nice * i;
          const y = 10 + plotH - (v / top) * plotH;
          return (
            <g key={i}>
              <line x1={padL} x2={W} y1={y} y2={y} stroke="#F2F4F7" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#98A2B3">
                {v}
              </text>
            </g>
          );
        })}
        {labels.map((lab, gi) => {
          const gx = padL + gi * groupW;
          const last = highlightLast && gi === n - 1;
          return (
            <g key={gi}>
              {last && <rect x={gx + 2} y={6} width={groupW - 4} height={plotH + 6} rx={6} fill="#EFF8FF" />}
              {series.map((s, si) => {
                const v = s.values[gi] ?? 0;
                const h = (v / top) * plotH;
                const x = gx + (groupW - barW * series.length - 3 * (series.length - 1)) / 2 + si * (barW + 3);
                return (
                  <g key={s.key}>
                    <rect x={x} y={10 + plotH - h} width={barW} height={Math.max(0, h)} rx={2} fill={s.color}>
                      <title>{`${lab} · ${s.label}: ${v}`}</title>
                    </rect>
                    {v > 0 && (
                      <text x={x + barW / 2} y={10 + plotH - h - 3} textAnchor="middle" fontSize="9" fill="#475467">
                        {v}
                      </text>
                    )}
                  </g>
                );
              })}
              <text
                x={gx + groupW / 2}
                y={H - 16}
                textAnchor="middle"
                fontSize="10"
                fill={last ? "#1570EF" : "#667085"}
                fontWeight={last ? 700 : 400}
              >
                {lab}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "How these are counted": the rules behind the figures on a tab, from the
// same definitions the server uses.
// ---------------------------------------------------------------------------
export function HowCounted({ metrics, notes = [], funnel }: { metrics: MetricKey[]; notes?: ReactNode[]; funnel?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-5 py-3.5 text-left hover:bg-[#F9FAFB]"
      >
        <span className="flex items-center gap-2 text-[14px] font-semibold text-[#101828]">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#EFF8FF] text-[12px] font-bold text-[#1570EF]">
            i
          </span>
          How these are counted
        </span>
        <Icon name="chevron-down" size={16} className={`text-[#667085] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-[#E4E7EC] px-5 py-4 text-[13px] leading-relaxed text-[#475467]">
          <ul className="space-y-1.5">
            {metrics.map((m) => (
              <li key={m}>
                <span className="font-semibold text-[#101828]">{METRICS[m].label}:</span> {METRICS[m].rule}
              </li>
            ))}
            {funnel && (
              <li>
                <span className="font-semibold text-[#101828]">Stage funnel:</span> {FUNNEL_RULE}
              </li>
            )}
          </ul>
          <ul className="mt-3 space-y-1.5 border-t border-[#F2F4F7] pt-3">
            <li>
              <span className="font-semibold text-[#101828]">Dates:</span> applications count by their submitted date,
              leads by the date the partner added the student. With &ldquo;All time&rdquo; nothing is left out by date.
            </li>
            <li>
              <span className="font-semibold text-[#101828]">Stage figures</span> use each application&rsquo;s stage today,
              as the weekly tracker did.
            </li>
            <li>
              <span className="font-semibold text-[#101828]">Relationship Manager</span> is the partner&rsquo;s BDM;
              <span className="font-semibold text-[#101828]"> Counsellor</span> is the student&rsquo;s Collegepond
              counsellor; <span className="font-semibold text-[#101828]">Intake</span> is the deferred intake, else the
              course&rsquo;s, else the student&rsquo;s.
            </li>
            <li>
              <span className="font-semibold text-[#101828]">Vendor</span> is the commission contract chosen on the
              application (a contract without a vendor is Direct), else the counsellor&rsquo;s typed vendor, else
              &ldquo;Not set&rdquo;.
            </li>
            <li>
              &ldquo;Not Qualified&rdquo; from the old tracker is not an application stage in the portal, so it is not
              reported.
            </li>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Card wrapper with an optional caption on the right.
export function Card({
  title,
  caption,
  children,
  className,
  flush,
}: {
  title: string;
  caption?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <DashboardCard
      title={title}
      className={className}
      bodyClassName={flush ? "p-0" : "p-5"}
      headerRight={caption ? <span className="text-right text-xs text-[#98A2B3]">{caption}</span> : undefined}
    >
      {children}
    </DashboardCard>
  );
}
