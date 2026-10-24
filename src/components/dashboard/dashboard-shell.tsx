"use client";

import { type ReactNode, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Topbar, type NotificationItem } from "./topbar";
import { MobileGate } from "./mobile-gate";
import { NAV_SECTIONS, navRoleFromCode } from "./nav-config";
import { AdminRoleLabel, isAdminRole } from "~/server/db/enums";
import { SHOW_DEMO_DATA } from "~/lib/demo";
import { api } from "~/trpc/react";
import { AdminRole } from "~/server/db/enums";
import { canUseSection, sectionForPath } from "~/lib/admin-sections";
import {
  ImpersonateMenu,
  ImpersonationBanner,
  bannerOffsetStyle,
  useImpersonation,
} from "./impersonation";

// Dev-only illustrative bell content. In production the bell is driven entirely
// by api.notifications.list (real, current actionable state); these never render
// in a prod build (SHOW_DEMO_DATA is false). See ~/lib/demo.
const DEFAULT_NOTIFICATIONS: NotificationItem[] = [
  {
    id: "1",
    title: "3 partner approvals awaiting review",
    time: "15 min ago",
    tone: "orange",
    unread: true,
  },
  {
    id: "2",
    title: "TAT breach: 5 applications exceed 48h SLA",
    time: "1 hour ago",
    tone: "red",
    unread: true,
  },
  {
    id: "3",
    title: "New partner signup: Pacific Study Abroad (Mumbai)",
    time: "2 hours ago",
    tone: "green",
    unread: true,
  },
  {
    id: "4",
    title: "University of Leeds updated commission rates",
    time: "5 hours ago",
    tone: "blue",
  },
  {
    id: "5",
    title: "Monthly morning report generated successfully",
    time: "1 day ago",
    tone: "gray",
  },
];

export interface DashboardShellProps {
  children: ReactNode;
  badges?: Record<string, number | string | undefined>;
  notifications?: NotificationItem[];
  taskCount?: number;
}

export function DashboardShell({
  children,
  badges,
  notifications,
  taskCount = 0,
}: DashboardShellProps) {
  const logout = api.authSession.logout.useMutation();
  // Real signed-in admin (collegepond_user) — drives the profile name/role.
  const me = api.authSession.me.useQuery().data;
  // Non-null while a Super Admin is impersonating a staff user; `me` is then
  // the impersonated user.
  const impersonating = useImpersonation("admin");
  // Sections are role-gated (~/lib/admin-sections). A page outside the
  // signed-in role's sections renders a not-authorised state instead of
  // mounting (so none of its queries run); the server refuses them anyway.
  const pathname = usePathname();
  const pageSection = sectionForPath(pathname);

  // Live admin signals (pending approvals, payouts ready, invoices awaiting
  // review, new students). Drives both the bell and the sidebar approvals badge.
  const signals = api.notifications.list.useQuery().data;
  const branding = api.settings.branding.useQuery().data;
  const [allRead, setAllRead] = useState(false);

  // Resolution order: explicit prop override → real live data → dev-only demo
  // (empty in prod, never synthetic).
  const effectiveBadges =
    badges ?? signals?.badges ?? (SHOW_DEMO_DATA ? { approvals: 7 } : {});
  const liveNotifications =
    notifications ??
    signals?.notifications ??
    (SHOW_DEMO_DATA ? DEFAULT_NOTIFICATIONS : []);
  const shownNotifications = allRead
    ? liveNotifications.map((n) => ({ ...n, unread: false }))
    : liveNotifications;

  async function handleLogout() {
    try {
      await logout.mutateAsync();
    } catch {
      // Cookie may already be gone — keep going.
    }
    // Hard navigation so the browser drops the cleared cookie and middleware
    // re-checks auth on a fresh request; a soft router.replace would stay inside
    // the still-authenticated SPA. The full reload also discards the tRPC cache.
    window.location.href = "/admin/login";
  }

  const userName = me ? `${me.firstName} ${me.lastName}`.trim() : "";
  const roleLabel = me && isAdminRole(me.role) ? AdminRoleLabel[me.role] : "";
  const initials = userName
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <MobileGate>
    <div className="min-h-screen bg-[#F5F6FA] text-[#1D2939]" style={bannerOffsetStyle(!!impersonating)}>
      <ImpersonationBanner side="admin" />
      <Sidebar
        sections={NAV_SECTIONS.map((sec) => ({
          ...sec,
          // Gated items appear once the role is known, never before.
          items: sec.items.filter((i) => !i.section || (me && canUseSection(me.role, i.section))),
        }))}
        logoSubtitle="Admin Portal"
        badges={effectiveBadges}
        role={me && isAdminRole(me.role) ? navRoleFromCode(me.role) : null}
        logoUrl={branding?.adminLogoUrl}
      />
      <Topbar
        userName={userName}
        userInitials={initials}
        roleLabel={roleLabel}
        notifications={shownNotifications}
        taskCount={taskCount}
        onMarkAllRead={() => setAllRead(true)}
        onLogout={handleLogout}
        actions={
          !me || me.impersonated || impersonating ? null : me.role === AdminRole.SUPER_ADMIN ? (
            <ImpersonateMenu />
          ) : me.role === AdminRole.COUNSELLOR_LEAD ? (
            <ImpersonateMenu scope="team" />
          ) : null
        }
      />
      <main className="ml-16 min-h-screen pt-[calc(60px+var(--banner-h,0px))]">
        <div className="p-6">
          {!pageSection ? (
            children
          ) : !me ? null : canUseSection(me.role, pageSection) ? (
            children
          ) : (
            <NotAuthorised />
          )}
        </div>
      </main>
    </div>
    </MobileGate>
  );
}

function NotAuthorised() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-[#E4E7EC] bg-white px-6 py-10 text-center">
      <h1 className="text-lg font-semibold text-[#101828]">You don&apos;t have access to this page</h1>
      <p className="mt-2 text-sm text-[#667085]">
        This section isn&apos;t part of your role. If you need it, ask a Super Admin.
      </p>
      <Link
        href="/admin/dashboard"
        className="mt-5 inline-block rounded-lg bg-[#1570EF] px-4 py-2 text-sm font-medium text-white hover:bg-[#175CD3]"
      >
        Go to Dashboard
      </Link>
    </div>
  );
}
