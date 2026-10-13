"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { timeAgo, formatDate, stageLabel } from "~/components/dashboard/format";
import {
  KpiCard,
  DashboardCard,
  NeedsDataBadge,
  EmptyState,
  Skeleton,
  SkeletonRows,
  Icon,
} from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";

const num = (n: number) => n.toLocaleString("en-IN");

const QUICK_LINKS = [
  { label: "Students", href: "/partner/students" },
  { label: "Uni Assist", href: "/partner/uni-assist" },
  { label: "Events", href: "/partner/events" },
  { label: "Commission", href: "/partner/commission" },
  { label: "Resources", href: "/partner/resources" },
  { label: "My Account", href: "/partner/account" },
];

export default function PartnerDashboardPage() {
  const router = useRouter();
  const me = api.auth.me.useQuery(undefined, { retry: false });
  const recordVisit = api.auth.recordDashboardVisit.useMutation();
  const { data: stats, isLoading } = api.dashboard.partnerStats.useQuery();

  // Bounce away if state has shifted (e.g. unsigned MOU, or status no longer
  // approved). Middleware enforces the cookie; this enforces the "approved +
  // signed" precondition for the dashboard page itself.
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/partner/dashboard") {
      router.replace(target);
    }
  }, [me.data?.redirectUrl, router]);

  // Stamp last_login_at on every dashboard mount. useRef guards StrictMode
  // double-invocation in dev so we don't fire twice.
  const recordedRef = useRef(false);
  useEffect(() => {
    if (recordedRef.current) return;
    if (me.data?.redirectUrl !== "/partner/dashboard") return;
    recordedRef.current = true;
    recordVisit.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.redirectUrl]);

  const contacts = stats?.contacts ?? [];
  const bdm = stats?.bdm ?? null;

  return (
    <>
      <div className="mb-6">
        <h1
          className="text-2xl font-bold text-[#101828]"
          suppressHydrationWarning
        >
          Welcome{me.data?.firstName ? `, ${me.data.firstName}` : ""}! 👋
        </h1>
        <p className="mt-1 text-sm text-[#667085]">
          Here&apos;s an overview of your partnership with Collegepond.
        </p>
      </div>

      {/* KPIs */}
      <Stagger className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <FadeUp className="h-full">
          <KpiCard
            label="All Applications"
            icon="applications"
            tone="blue"
            href="/partner/students"
            loading={isLoading}
            value={stats ? num(stats.kpis.applications) : "—"}
          />
        </FadeUp>
        <FadeUp className="h-full">
          <KpiCard
            label="Offers Received"
            icon="offer"
            tone="purple"
            loading={isLoading}
            value={stats ? num(stats.kpis.offers) : "—"}
          />
        </FadeUp>
        <FadeUp className="h-full">
          <KpiCard
            label="Deposits Paid"
            icon="deposit"
            tone="orange"
            loading={isLoading}
            value={stats ? num(stats.kpis.deposits) : "—"}
          />
        </FadeUp>
        <FadeUp className="h-full">
          <KpiCard
            label="Visas Received"
            icon="visa"
            tone="green"
            loading={isLoading}
            value={stats ? num(stats.kpis.visas) : "—"}
          />
        </FadeUp>
      </Stagger>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Recent Applications — live */}
        <DashboardCard
          title="Recent Applications"
          link="/partner/students"
          className="lg:col-span-2"
        >
          {isLoading ? (
            <SkeletonRows />
          ) : stats && stats.recentApplications.length > 0 ? (
            <ul className="divide-y divide-[#F2F4F7]">
              {stats.recentApplications.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 py-2.5 text-[13px] first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-[#101828]">{a.student}</div>
                    <div className="truncate text-xs text-[#98A2B3]">{a.university}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[#475467]">{stageLabel(a.status)}</div>
                    <div className="text-xs text-[#98A2B3]">{timeAgo(a.at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState label="No applications yet." />
          )}
        </DashboardCard>

        {/* Your Collegepond team — under a "Counselling Team" heading, the
            counsellor then the counsellor lead (individually unlabelled), then
            the BDM under their own heading. */}
        <DashboardCard title="Your Collegepond Team">
          {isLoading ? (
            <div className="space-y-3">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <Skeleton className="h-4 w-32" />
                </div>
              ))}
            </div>
          ) : contacts.length || bdm ? (
            <div className="space-y-3 text-[13px]">
              {contacts.length > 0 && (
                <div>
                  <TeamHeading>Counselling Team</TeamHeading>
                  <div className="space-y-3">
                    {contacts.map((c) => (
                      <TeamContact key={c.name} name={c.name} phone={c.phone} />
                    ))}
                  </div>
                </div>
              )}
              {bdm && (
                <div className={contacts.length ? "border-t border-[#EAECF0] pt-3" : ""}>
                  <TeamHeading>Business Development Manager</TeamHeading>
                  <TeamContact name={bdm.name} phone={bdm.phone} />
                </div>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-[#98A2B3]">
              Your Collegepond team will appear here once assigned.
            </p>
          )}
        </DashboardCard>

        {/* Students this year — live */}
        <DashboardCard title="Students This Year">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-[#ECFDF3] text-[#12B76A]">
              <Icon name="students" size={22} />
            </span>
            <div>
              <div className="text-[28px] leading-none font-extrabold text-[#101828]">
                {isLoading ? (
                  <Skeleton className="h-7 w-12" />
                ) : stats ? (
                  num(stats.studentsThisYear)
                ) : (
                  "—"
                )}
              </div>
              <p className="mt-1 text-xs text-[#98A2B3]">New students since January.</p>
            </div>
          </div>
        </DashboardCard>

        {/* Events — live (event table) */}
        <DashboardCard title="Upcoming Events" link="/partner/events">
          {isLoading ? (
            <SkeletonRows rows={3} />
          ) : stats && stats.events.length > 0 ? (
            <ul className="space-y-3">
              {stats.events.map((e) => (
                <li key={e.id} className="flex gap-3 text-[13px]">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EFF8FF] text-[#1570EF]">
                    <Icon name="calendar" size={16} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-[#101828]">{e.title}</div>
                    <div className="text-xs text-[#98A2B3]">
                      {formatDate(e.date)}
                      {e.isVirtual ? " · Virtual" : e.location ? ` · ${e.location}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState label="No upcoming events." />
          )}
        </DashboardCard>

        {/* Quick Links — real navigation */}
        <DashboardCard title="Quick Links">
          <div className="grid grid-cols-2 gap-2 text-[13px]">
            {QUICK_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-lg border border-[#E4E7EC] px-3 py-2 font-medium text-[#344054] transition-colors hover:border-[#1570EF] hover:text-[#1570EF]"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </DashboardCard>

        {/* ---- Static widgets below: UI built, awaiting a real data source ---- */}

        {/* TODO(data): Important Notices — needs a notices/announcements table. */}
        <DashboardCard title="Important Notices" headerRight={<NeedsDataBadge />}>
          <ul className="space-y-2 text-[13px] text-[#475467]">
            <li>• MOU renewals for FY26 are now open in My Account.</li>
            <li>• New commission slabs effective from the next intake.</li>
          </ul>
        </DashboardCard>

        {/* TODO(data): Partner Loyalty tier — needs loyalty/tier data (user.tier). */}
        <DashboardCard title="Partner Loyalty Program" headerRight={<NeedsDataBadge />}>
          <div className="text-[13px]">
            <span className="rounded-full bg-[#F2F4F7] px-2.5 py-1 text-xs font-semibold text-[#344054]">
              Silver Partner
            </span>
            <p className="mt-2 text-xs text-[#98A2B3]">
              Reach 25 students this year to unlock Gold benefits.
            </p>
          </div>
        </DashboardCard>

        {/* TODO(data): EduFin loan banner — needs a partner-offers/promos source. */}
        <div className="rounded-xl border border-[#E4E7EC] bg-gradient-to-r from-[#EFF8FF] to-[#F9FAFB] p-5 lg:col-span-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[#101828]">
              Education loans made easy with EduFin Bank
            </h2>
            <NeedsDataBadge />
          </div>
          <p className="mt-1 text-[13px] text-[#475467]">
            Help your students fund their studies — fast approvals for Collegepond partners.
          </p>
        </div>
      </div>
    </>
  );
}

function TeamHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
      {children}
    </div>
  );
}

function TeamContact({ name, phone }: { name: string; phone: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#1570EF] to-[#0b4ea2] text-xs font-bold text-white">
        {name
          .split(/\s+/)
          .map((w) => w[0])
          .join("")
          .slice(0, 2)
          .toUpperCase()}
      </span>
      <div className="min-w-0">
        <div className="truncate font-semibold text-[#101828]">{name}</div>
        {phone ? (
          <a href={`tel:${phone.replace(/\s+/g, "")}`} className="text-[#475467] hover:text-[#1570EF]">
            {phone}
          </a>
        ) : (
          <span className="text-[#98A2B3]">—</span>
        )}
      </div>
    </div>
  );
}
