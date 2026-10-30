// Reusable presentational building blocks shared by the admin + partner
// dashboards. Keep these dumb (no data fetching) so both dashboards compose
// the same vocabulary of cards, KPIs, funnels, charts and feeds.

import { type ReactNode } from "react";
import Link from "next/link";
import { CountUp } from "./motion";

// ---------------------------------------------------------------------------
// Icons — a small Feather-style set used across KPI cards and headers.
// ---------------------------------------------------------------------------
export type IconName =
  | "students"
  | "applications"
  | "partners"
  | "revenue"
  | "approvals"
  | "clock"
  | "globe"
  | "university"
  | "calendar"
  | "check"
  | "trophy"
  | "offer"
  | "visa"
  | "deposit"
  | "trend-up"
  | "trend-down"
  | "bolt"
  | "chevron-down";

const ICON_PATHS: Record<IconName, ReactNode> = {
  students: (
    <>
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5" />
    </>
  ),
  applications: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  partners: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  revenue: (
    <>
      <rect x="1" y="4" width="22" height="16" rx="2" />
      <path d="M1 10h22" />
    </>
  ),
  approvals: (
    <>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" />
    </>
  ),
  university: (
    <>
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  trophy: (
    <>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </>
  ),
  offer: (
    <>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </>
  ),
  visa: (
    <>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  // A banknote rather than "$": these cards show ₹, € and £ amounts.
  deposit: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  "trend-up": (
    <>
      <path d="M23 6l-9.5 9.5-5-5L1 18" />
      <path d="M17 6h6v6" />
    </>
  ),
  "trend-down": (
    <>
      <path d="M23 18l-9.5-9.5-5 5L1 6" />
      <path d="M17 18h6v-6" />
    </>
  ),
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  "chevron-down": <path d="M6 9l6 6 6-6" />,
};

export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared tokens
// ---------------------------------------------------------------------------
export type Tone = "blue" | "green" | "purple" | "orange" | "red" | "cyan";

const TONES: Record<Tone, { bg: string; fg: string }> = {
  blue: { bg: "bg-[#EFF8FF]", fg: "text-[#1570EF]" },
  green: { bg: "bg-[#ECFDF3]", fg: "text-[#12B76A]" },
  purple: { bg: "bg-[#F9F5FF]", fg: "text-[#7F56D9]" },
  orange: { bg: "bg-[#FFF6ED]", fg: "text-[#F79009]" },
  red: { bg: "bg-[#FEF3F2]", fg: "text-[#F04438]" },
  cyan: { bg: "bg-[#F0F9FF]", fg: "text-[#0BA5EC]" },
};

// Gradient avatars for ranked lists / partner cells.
export const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#1570EF,#0b4ea2)",
  "linear-gradient(135deg,#7F56D9,#6941C6)",
  "linear-gradient(135deg,#F79009,#DC6803)",
  "linear-gradient(135deg,#12B76A,#039855)",
  "linear-gradient(135deg,#0BA5EC,#0086C9)",
  "linear-gradient(135deg,#E31B54,#C01048)",
  "linear-gradient(135deg,#667085,#475467)",
  "linear-gradient(135deg,#9E77ED,#6941C6)",
];

export type Trend = { value: string; dir: "up" | "down" } | null;

// ---------------------------------------------------------------------------
// KPI card — colored icon, big value, optional trend pill.
// ---------------------------------------------------------------------------
export function KpiCard({
  label,
  value,
  icon,
  tone = "blue",
  trend,
  trendNote,
  href,
  loading,
  needsData,
}: {
  label: string;
  value: ReactNode;
  icon: IconName;
  tone?: Tone;
  trend?: Trend;
  trendNote?: string;
  href?: string;
  loading?: boolean;
  // Marks the metric as wired-but-sample (data source still being built).
  needsData?: boolean;
}) {
  const t = TONES[tone];
  const cls =
    "block rounded-xl border border-[#E4E7EC] bg-white p-5 transition-all hover:border-[#1570EF] hover:shadow-[0_4px_16px_rgba(21,112,239,0.08)]";
  const body = (
    <>
      <div className="mb-3 flex items-start justify-between">
        <span className="text-xs font-semibold tracking-wide text-[#667085] uppercase">
          {label}
        </span>
        <span
          className={`flex h-10 w-10 items-center justify-center rounded-[10px] ${t.bg} ${t.fg}`}
        >
          <Icon name={icon} size={20} />
        </span>
      </div>
      <div className="text-[28px] leading-none font-extrabold text-[#101828]">
        {loading ? (
          <span className="inline-block h-7 w-16 animate-pulse rounded bg-[#F2F4F7]" />
        ) : (
          <CountUp value={value} />
        )}
      </div>
      {needsData ? (
        <div className="mt-2">
          <NeedsDataBadge />
        </div>
      ) : (
        trend && (
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                trend.dir === "up"
                  ? "bg-[#ECFDF3] text-[#027A48]"
                  : "bg-[#FEF3F2] text-[#B42318]"
              }`}
            >
              <Icon name={trend.dir === "up" ? "trend-up" : "trend-down"} size={12} />
              {trend.value}
            </span>
            {trendNote && <span className="text-xs text-[#98A2B3]">{trendNote}</span>}
          </div>
        )
      )}
    </>
  );
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// ---------------------------------------------------------------------------
// Plain stat card — colored icon box, big number, label (no trend). Used by
// the list pages (placements / approvals / events).
// ---------------------------------------------------------------------------
export function StatCard({
  icon,
  tone = "blue",
  value,
  label,
  sub,
  onClick,
  active = false,
}: {
  icon: IconName;
  tone?: Tone;
  value: ReactNode;
  label: string;
  /** Optional muted sub-line under the label (e.g. "N overdue"). */
  sub?: ReactNode;
  /** When provided, the card becomes a clickable filter toggle. */
  onClick?: () => void;
  /** Highlights the card (e.g. when its filter is applied). */
  active?: boolean;
}) {
  const t = TONES[tone];
  const interactive = !!onClick;
  return (
    <div
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={`rounded-xl border bg-white p-5 transition ${
        active ? "border-[#1570EF] ring-1 ring-[#1570EF]" : "border-[#E4E7EC]"
      } ${interactive ? "cursor-pointer hover:border-[#84caff] hover:shadow-sm" : ""}`}
    >
      <div
        className={`mb-3.5 flex h-11 w-11 items-center justify-center rounded-[10px] ${t.bg} ${t.fg}`}
      >
        <Icon name={icon} size={22} />
      </div>
      <div className="text-[28px] leading-none font-extrabold text-[#101828]">{value}</div>
      <div className="mt-1.5 text-[13px] font-medium text-[#667085]">{label}</div>
      {sub != null && <div className="mt-0.5 text-xs text-[#98A2B3]">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card shell with a header (title + optional link or custom right-slot).
// ---------------------------------------------------------------------------
export function DashboardCard({
  title,
  link,
  linkLabel = "View all",
  headerRight,
  children,
  className,
  bodyClassName = "p-5",
}: {
  title: string;
  link?: string;
  linkLabel?: string;
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-[#E4E7EC] bg-white ${className ?? ""}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[#E4E7EC] px-5 py-4">
        <h2 className="text-[15px] font-semibold text-[#101828]">{title}</h2>
        {headerRight ??
          (link ? (
            <Link
              href={link}
              className="text-[13px] font-medium text-[#1570EF] hover:underline"
            >
              {linkLabel} →
            </Link>
          ) : null)}
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal funnel — colored fill bars with counts.
// ---------------------------------------------------------------------------
export function Funnel({
  steps,
}: {
  steps: { label: string; sub?: string; count: number; color: string }[];
}) {
  if (steps.every((s) => s.count === 0)) return <EmptyState />;
  const max = Math.max(1, ...steps.map((s) => s.count));
  return (
    <div>
      {steps.map((s, i) => {
        const pct = s.count > 0 ? Math.max(8, Math.round((s.count / max) * 100)) : 0;
        return (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-[#F2F4F7] py-2.5 last:border-0"
          >
            <div className="w-32 shrink-0">
              <div className="text-[13px] font-medium text-[#344054]">{s.label}</div>
              {s.sub && <div className="text-[10px] text-[#98A2B3]">{s.sub}</div>}
            </div>
            <div className="h-7 flex-1 overflow-hidden rounded-md bg-[#F2F4F7]">
              <div
                className="flex h-full items-center rounded-md pl-2.5 text-xs font-semibold text-white animate-[growW_0.7s_ease-out]"
                style={{ width: `${pct}%`, background: s.color }}
              >
                {s.count > 0 ? s.count : ""}
              </div>
            </div>
            <div className="w-8 shrink-0 text-right text-sm font-bold text-[#101828]">
              {s.count}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdown list — leading badge/flag, label, mini bar, count.
// ---------------------------------------------------------------------------
export function BreakdownList({
  rows,
}: {
  rows: { label: string; value: number; color: string; lead?: ReactNode }[];
}) {
  if (rows.length === 0) return <EmptyState />;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r, i) => (
        <div
          key={i}
          className="flex items-center gap-2.5 border-b border-[#F2F4F7] py-2 last:border-0"
        >
          {r.lead != null && (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[#F2F4F7] text-sm">
              {r.lead}
            </span>
          )}
          <span className="flex-1 truncate text-[13px] font-medium text-[#344054]">
            {r.label}
          </span>
          <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-[#F2F4F7]">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.round((r.value / max) * 100)}%`,
                background: r.color,
              }}
            />
          </span>
          <span className="w-7 shrink-0 text-right text-[13px] font-bold text-[#101828]">
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut chart (SVG) + legend.
// ---------------------------------------------------------------------------
export function DonutChart({
  data,
  size = 168,
  thickness = 22,
  centerLabel = "total",
}: {
  data: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return <EmptyState />;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;

  let acc = 0;
  const slices = data.map((d) => {
    const start = acc;
    acc += d.value;
    return { ...d, start };
  });

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0"
      >
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#F2F4F7" strokeWidth={thickness} />
        <g
          style={{
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: "donutSweep 0.7s ease-out",
          }}
        >
          {slices.map((s, i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${(s.value / total) * c} ${c}`}
              strokeDashoffset={-(s.start / total) * c}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          ))}
        </g>
        <text
          x={cx}
          y={cy - 2}
          textAnchor="middle"
          style={{ fontSize: 26, fontWeight: 800, fill: "#101828" }}
        >
          {total}
        </text>
        <text
          x={cx}
          y={cy + 16}
          textAnchor="middle"
          style={{ fontSize: 11, fill: "#98A2B3" }}
        >
          {centerLabel}
        </text>
      </svg>
      <ul className="min-w-[140px] flex-1 space-y-2">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2 text-[13px]">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: d.color }}
            />
            <span className="flex-1 truncate text-[#344054]">{d.label}</span>
            <span className="font-semibold text-[#101828]">{d.value}</span>
            <span className="w-9 text-right text-xs text-[#98A2B3]">
              {Math.round((d.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity feed — emoji bubble + text + relative time.
// ---------------------------------------------------------------------------
export function ActivityFeed({
  items,
}: {
  items: { id: number | string; icon: string; bg: string; text: ReactNode; time: string }[];
}) {
  if (items.length === 0) return <EmptyState label="No recent activity." />;
  return (
    <ul>
      {items.map((a) => (
        <li
          key={a.id}
          className="flex gap-3 border-b border-[#F2F4F7] py-2.5 last:border-0"
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm"
            style={{ background: a.bg }}
          >
            {a.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] leading-snug text-[#344054]">{a.text}</div>
            <div className="mt-0.5 text-[11px] text-[#98A2B3]">{a.time}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Ranked list — gradient rank chip, name + sub, trailing value.
// ---------------------------------------------------------------------------
export function RankList({
  rows,
  valueLabel,
}: {
  rows: { name: string; sub?: string; value: ReactNode }[];
  valueLabel?: string;
}) {
  if (rows.length === 0) return <EmptyState />;
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center gap-3 text-[13px]">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
            style={{ background: AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length] }}
          >
            {i + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-[#101828]">{r.name}</span>
            {r.sub && <span className="block truncate text-xs text-[#98A2B3]">{r.sub}</span>}
          </span>
          <span className="shrink-0 font-semibold text-[#101828]">
            {r.value}
            {valueLabel && (
              <span className="ml-1 text-xs font-normal text-[#98A2B3]">{valueLabel}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Three mini stat boxes (e.g. TAT summary header).
// ---------------------------------------------------------------------------
export function StatTrio({
  items,
}: {
  items: { label: string; value: ReactNode; color: string }[];
}) {
  return (
    <div className="mb-4 grid grid-cols-3 gap-2.5">
      {items.map((it, i) => (
        <div key={i} className="rounded-[10px] border border-[#E4E7EC] p-3 text-center">
          <div className="text-[22px] leading-none font-extrabold" style={{ color: it.color }}>
            {it.value}
          </div>
          <div className="mt-1 text-[11px] font-medium text-[#667085]">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

// Labelled progress meter (label · track · %).
export function MeterRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="w-24 shrink-0 text-xs font-medium text-[#344054]">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#F2F4F7]">
        <span
          className="block h-full rounded-full animate-[growW_0.7s_ease-out]"
          style={{ width: `${value}%`, background: color }}
        />
      </span>
      <span className="w-9 shrink-0 text-right text-xs font-bold" style={{ color }}>
        {value}%
      </span>
    </div>
  );
}

// Marks a widget rendered with static/sample content — the UI is built and
// ready, it just needs a real data source wired in later.
export function NeedsDataBadge() {
  return (
    <span className="rounded-full bg-[#FFFAEB] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[#B54708] uppercase">
      Sample · needs data
    </span>
  );
}

export function EmptyState({ label = "No data yet." }: { label?: string }) {
  return <p className="py-6 text-center text-[13px] text-[#98A2B3]">{label}</p>;
}

// Shimmer placeholder block — compose into skeleton cards/rows/lists.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-md bg-[#EAECF0] ${className ?? ""}`} />
  );
}

// Skeleton list rows for a card body that's loading.
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-10" />
        </div>
      ))}
    </div>
  );
}

// Table-shaped skeleton (header strip + rows of cells) for table pages.
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div>
      <div className="flex gap-4 border-b border-[#E4E7EC] bg-[#F9FAFB] px-4 py-2.5">
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} className={`h-3 ${c === 0 ? "w-32" : "flex-1"}`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-[#F2F4F7] px-4 py-3.5 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-4 ${c === 0 ? "w-36" : "flex-1"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
