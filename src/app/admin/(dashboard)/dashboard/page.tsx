"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import {
  greeting,
  formatLongDate,
  formatINR,
  timeAgo,
  humanize,
  stageLabel,
  countryName,
  countryFlag,
} from "~/components/dashboard/format";
import {
  KpiCard,
  DashboardCard,
  Funnel,
  DonutChart,
  BreakdownList,
  ActivityFeed,
  StatTrio,
  MeterRow,
  Icon,
  NeedsDataBadge,
  EmptyState,
  Skeleton,
  SkeletonRows,
  AVATAR_GRADIENTS,
} from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";
import { AutoAssignCard } from "./auto-assign-card";
import { tierBadgeStyle } from "~/lib/partner-tiers";

const num = (n: number) => n.toLocaleString("en-IN");

// Happy-path application stages (0–7) for the pipeline funnel, with colors.
// In pipeline order: Visa Filed (code 9) sits between Deposit and Visa.
const FUNNEL_STAGES: { status: number; color: string }[] = [
  { status: 0, color: "#1570EF" },
  { status: 1, color: "#0BA5EC" },
  { status: 2, color: "#6172F3" },
  { status: 3, color: "#7F56D9" },
  { status: 4, color: "#9E77ED" },
  { status: 5, color: "#6941C6" },
  { status: 6, color: "#F79009" },
  { status: 9, color: "#36BFFA" },
  { status: 7, color: "#12B76A" },
  { status: 8, color: "#039855" },
];

const COUNTRY_PALETTE = [
  "#1570EF",
  "#7F56D9",
  "#12B76A",
  "#F79009",
  "#0BA5EC",
  "#F04438",
];
const UNI_PALETTE = [
  "#1570EF",
  "#0BA5EC",
  "#7F56D9",
  "#12B76A",
  "#F79009",
  "#E31B54",
];


// Map an audit action to an emoji + bubble color for the activity feed.
function activityStyle(action: string): { icon: string; bg: string } {
  const a = action.toLowerCase();
  if (a.includes("partner") || a.includes("org")) return { icon: "🤝", bg: "#ECFDF3" };
  if (a.includes("application") || a.includes("app")) return { icon: "📋", bg: "#EFF8FF" };
  if (a.includes("student")) return { icon: "🎓", bg: "#F0F9FF" };
  if (a.includes("commission") || a.includes("invoice") || a.includes("payment"))
    return { icon: "💰", bg: "#FFFAEB" };
  if (a.includes("counsel") || a.includes("user")) return { icon: "👤", bg: "#F9F5FF" };
  if (a.includes("login") || a.includes("auth")) return { icon: "🔐", bg: "#F2F4F7" };
  return { icon: "•", bg: "#F2F4F7" };
}

function QuickActions({ pending }: { pending: number }) {
  const items: { label: string; href: string; badge?: number }[] = [
    // The count is partner signups under review, so it goes to Partners (which
    // opens on its Pending tab), not counsellor approvals.
    { label: "Review Approvals", href: "/admin/partners", badge: pending },
    { label: "Add Partner", href: "/admin/partners" },
    { label: "Add University", href: "/admin/universities" },
    { label: "View Students", href: "/admin/students" },
  ];
  return (
    <details className="relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1260d4] [&::-webkit-details-marker]:hidden">
        <Icon name="bolt" size={15} />
        Quick Actions
        <Icon name="chevron-down" size={14} />
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-[#E4E7EC] bg-white p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            className="flex items-center justify-between rounded-lg px-3 py-2 text-[13px] text-[#344054] hover:bg-[#F0F7FF] hover:text-[#1570EF]"
          >
            {it.label}
            {it.badge != null && it.badge > 0 && (
              <span className="rounded-full bg-[#FEF3F2] px-2 py-0.5 text-[11px] font-bold text-[#B42318]">
                {it.badge}
              </span>
            )}
          </Link>
        ))}
      </div>
    </details>
  );
}

export default function DashboardPage() {
  const me = api.authSession.me.useQuery().data;
  const { data, isLoading } = api.dashboard.adminStats.useQuery();
  const firstName = me?.firstName ?? "";
  const k = data?.kpis;

  const queueMap = new Map(
    (data?.applicationQueue ?? []).map((q) => [q.status, q.count]),
  );
  const funnelSteps = FUNNEL_STAGES.map((s) => ({
    label: stageLabel(s.status),
    count: queueMap.get(s.status) ?? 0,
    color: s.color,
  }));

  const countryData = (data?.applicationsByCountry ?? []).map((c, i) => ({
    label: `${countryFlag(c.country)} ${countryName(c.country)}`,
    value: c.count,
    color: COUNTRY_PALETTE[i % COUNTRY_PALETTE.length]!,
  }));

  const uniRows = (data?.topUniversities ?? []).map((u, i) => ({
    label: u.name,
    value: u.applications,
    color: UNI_PALETTE[i % UNI_PALETTE.length]!,
    lead: (
      <span style={{ color: UNI_PALETTE[i % UNI_PALETTE.length]! }} className="font-bold">
        {i + 1}
      </span>
    ) as ReactNode,
  }));

  const activityItems = (data?.recentActivity ?? []).map((r) => {
    const s = activityStyle(r.action);
    return {
      id: r.id,
      icon: s.icon,
      bg: s.bg,
      text: (
        <>
          <strong className="font-semibold text-[#101828]">{humanize(r.action)}</strong>
          {r.entityType ? ` · ${r.entityType}` : ""}
        </>
      ),
      time: timeAgo(r.at),
    };
  });

  const partners = data?.topPartners ?? [];

  return (
    <>
      {/* Welcome + date + quick actions */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-bold text-[#101828]"
            suppressHydrationWarning
          >
            {greeting()}
            {firstName ? `, ${firstName}` : ""} 👋
          </h1>
          <p className="mt-1 text-sm text-[#667085]">
            Here&apos;s what&apos;s happening across Collegepond today.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="hidden h-9 items-center gap-2 rounded-lg border border-[#E4E7EC] bg-white px-3 text-[13px] font-medium text-[#344054] sm:flex"
            suppressHydrationWarning
          >
            <Icon name="calendar" size={15} className="text-[#667085]" />
            {formatLongDate(new Date())}
          </span>
          <QuickActions pending={k?.pendingApprovals ?? 0} />
        </div>
      </div>

      {/* KPIs */}
      <Stagger className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <FadeUp className="h-full">
          <KpiCard
            label="Total Students"
            icon="students"
            tone="blue"
            href="/admin/students"
            loading={!data}
            value={k ? num(k.students.value) : "—"}
            trend={k?.students.trend}
            trendNote="vs last month"
          />
        </FadeUp>
        <FadeUp className="h-full">
          <KpiCard
            label="Active Applications"
            icon="applications"
            tone="purple"
            loading={!data}
            value={k ? num(k.applications.value) : "—"}
            trend={k?.applications.trend}
            trendNote="vs last month"
          />
        </FadeUp>
        <FadeUp className="h-full">
          <KpiCard
            label="Partner Network"
            icon="partners"
            tone="green"
            href="/admin/partners"
            loading={!data}
            value={k ? num(k.partners.value) : "—"}
            trend={k?.partners.trend}
            trendNote="this month"
          />
        </FadeUp>
        <FadeUp className="h-full">
          <KpiCard
            label="Revenue (YTD)"
            icon="revenue"
            tone="orange"
            loading={!data}
            value={k ? formatINR(k.revenue.value) : "—"}
            needsData
          />
        </FadeUp>
      </Stagger>

      {/* Pending approvals call-out */}
      {k && k.pendingApprovals > 0 && (
        <Link
          href="/admin/partners"
          className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-[#FEDF89] bg-[#FFFCF5] px-5 py-3.5 text-[13px] transition-colors hover:border-[#F79009]"
        >
          <span className="flex items-center gap-2.5 font-medium text-[#B54708]">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#FEF0C7] text-[#B54708]">
              <Icon name="approvals" size={16} />
            </span>
            {k.pendingApprovals} partner approval{k.pendingApprovals === 1 ? "" : "s"} awaiting review
          </span>
          <span className="font-semibold text-[#B54708]">Review →</span>
        </Link>
      )}

      {/* Counsellor Lead only: Auto Assign switch and team */}
      <AutoAssignCard />

      {/* Row 1: Application Pipeline + Applications by Country */}
      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <DashboardCard
          title="Application Pipeline"
          link="/admin/students"
          className="lg:col-span-2"
        >
          {isLoading ? <SkeletonRows rows={8} /> : <Funnel steps={funnelSteps} />}
        </DashboardCard>

        <DashboardCard title="Applications by Country">
          {isLoading ? (
            <div className="flex flex-wrap items-center gap-5">
              <Skeleton className="h-[168px] w-[168px] rounded-full" />
              <div className="flex-1 space-y-2.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-3.5 w-full" />
                ))}
              </div>
            </div>
          ) : countryData.length > 0 ? (
            <DonutChart data={countryData} centerLabel="apps" />
          ) : (
            <EmptyState />
          )}
        </DashboardCard>
      </div>

      {/* Row 2: Top Partners + Recent Activity */}
      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <DashboardCard
          title="Top Performing Partners"
          link="/admin/partners"
          className="lg:col-span-2"
          bodyClassName=""
        >
          {isLoading ? (
            <div className="p-5">
              <SkeletonRows rows={6} />
            </div>
          ) : partners.length > 0 ? (
            <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[#E4E7EC] bg-[#F9FAFB] text-left text-[11px] font-semibold tracking-wide text-[#667085] uppercase">
                    <th className="px-4 py-2.5">Partner</th>
                    <th className="px-4 py-2.5">Tier</th>
                    <th className="px-4 py-2.5">Students</th>
                    <th className="px-4 py-2.5">Apps</th>
                    <th className="px-4 py-2.5">Deposits</th>
                    <th className="px-4 py-2.5">Conv.</th>
                    <th className="px-4 py-2.5">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {partners.map((p, i) => {
                    // Partner Tiers: this FY's tier (automatic or a Super Admin floor).
                    const tier = p.tier;
                    const conv =
                      p.students > 0 ? Math.round((p.deposits / p.students) * 100) : 0;
                    const convColor =
                      conv >= 50 ? "#027A48" : conv >= 30 ? "#B54708" : "#B42318";
                    return (
                      <tr
                        key={p.orgId}
                        className="border-b border-[#F2F4F7] text-[13px] last:border-0 hover:bg-[#FAFBFC]"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <span
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
                              style={{
                                background: AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length],
                              }}
                            >
                              {p.name.slice(0, 2).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate font-medium text-[#101828]">
                                {p.name}
                              </div>
                              {p.city && (
                                <div className="truncate text-[11px] text-[#98A2B3]">
                                  {p.city}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {tier ? (
                            <span
                              className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                              style={tierBadgeStyle(tier.effective.badgeColor)}
                              title={`${tier.label} · ${tier.students} confirmed in ${tier.fyLabel}`}
                            >
                              {tier.effective.name}
                            </span>
                          ) : (
                            <span className="text-[#98A2B3]">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-semibold text-[#101828]">
                          {p.students}
                        </td>
                        <td className="px-4 py-3 text-[#344054]">{p.applications}</td>
                        <td className="px-4 py-3 text-[#344054]">{p.deposits}</td>
                        <td className="px-4 py-3 font-semibold" style={{ color: convColor }}>
                          {conv}%
                        </td>
                        <td className="px-4 py-3 font-medium text-[#98A2B3]">
                          {formatINR(p.revenue)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 border-t border-[#E4E7EC] px-4 py-2.5 text-[11px] text-[#98A2B3]">
              <NeedsDataBadge />
              Revenue reflects the commissions module (in progress) — figures are sample for now.
            </div>
            </>
          ) : (
            <div className="p-5">
              <EmptyState />
            </div>
          )}
        </DashboardCard>

        <DashboardCard title="Recent Activity">
          {isLoading ? <SkeletonRows /> : <ActivityFeed items={activityItems} />}
        </DashboardCard>
      </div>

      {/* Row 3: Application Queue + Top Universities + TAT */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <DashboardCard title="Application Queue" link="/admin/students">
          {isLoading ? (
            <SkeletonRows />
          ) : data && data.applicationQueue.length > 0 ? (
            <ul className="space-y-1">
              {data.applicationQueue.map((q) => {
                const color =
                  FUNNEL_STAGES.find((s) => s.status === q.status)?.color ??
                  (q.status >= 20 ? "#F04438" : "#667085");
                return (
                  <li
                    key={q.status}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-[#F0F7FF]"
                  >
                    <span className="flex items-center gap-2 text-[13px] text-[#344054]">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: color }}
                      />
                      {stageLabel(q.status)}
                    </span>
                    <span className="min-w-7 rounded-md bg-[#F2F4F7] px-2 py-0.5 text-center text-[13px] font-bold text-[#101828]">
                      {q.count}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState />
          )}
        </DashboardCard>

        <DashboardCard title="Top Universities">
          {isLoading ? <SkeletonRows /> : <BreakdownList rows={uniRows} />}
        </DashboardCard>

        {/* TAT Compliance — UI ready; TAT module gated off until data exists. */}
        <DashboardCard title="TAT Compliance" headerRight={<NeedsDataBadge />}>
          <StatTrio
            items={[
              { label: "Active Breaches", value: 4, color: "#F04438" },
              { label: "Avg Response", value: "18h", color: "#1570EF" },
              { label: "Compliance", value: "87%", color: "#12B76A" },
            ]}
          />
          <MeterRow label="Chat Response" value={95} color="#12B76A" />
          <MeterRow label="App Submission" value={82} color="#F79009" />
          <MeterRow label="Doc Review" value={91} color="#1570EF" />
          <MeterRow label="Shortlisting" value={74} color="#F04438" />
        </DashboardCard>
      </div>

    </>
  );
}
