"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { MobileGate } from "./mobile-gate";
import { PARTNER_NAV_SECTIONS } from "./partner-nav-config";
import { api } from "~/trpc/react";
import { PartnerKindLabel } from "~/server/db/enums";
import { partnerTabForPath } from "~/lib/partner-tabs";
import { ImpersonationBanner, bannerOffsetStyle, useImpersonation } from "./impersonation";

export function PartnerDashboardShell({ children }: { children: ReactNode }) {
  const me = api.auth.me.useQuery(undefined, { retry: false });
  const utils = api.useUtils();
  const logout = api.auth.logout.useMutation();
  // Non-null while a Super Admin is impersonating this partner, or the agency
  // owner is viewing as this counsellor.
  const impersonating = useImpersonation("partner");
  // Tabs are gated by the partner's effective tabs: their type's default, a
  // Super Admin's switches and any per-user override (~/lib/partner-tabs).
  // The server refuses a switched-off tab's data from the same set.
  const tabs = api.tabAccess.partnerMine.useQuery(undefined, { retry: false }).data?.tabs;
  const hasTab = (href: string) => {
    const tab = partnerTabForPath(href);
    return tab === null || !!tabs?.includes(tab);
  };
  const pathname = usePathname();
  const pageTab = partnerTabForPath(pathname);

  // Persistent partner notification feed (counsellor decisions, etc.).
  const feed = api.partnerNotifications.list.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const branding = api.settings.branding.useQuery().data;
  // Chat threads with unread Collegepond messages (sidebar badge).
  const chatUnread = api.partnerChat.partnerUnreadCount.useQuery(undefined, {
    refetchInterval: 30_000,
    retry: false,
    enabled: !!tabs?.includes("chat"),
  }).data;
  const markAllRead = api.partnerNotifications.markAllRead.useMutation({
    onSuccess: () => void utils.partnerNotifications.list.invalidate(),
  });
  const setRead = api.partnerNotifications.setRead.useMutation({
    onSuccess: () => void utils.partnerNotifications.list.invalidate(),
  });

  // Managing the team (Counsellors) stays the agency owner's and Commission
  // the payee's: built into the tab defaults, which can't grant them to
  // anyone else. Gated items appear once the tabs are known, never before.
  const kind = me.data?.kind;
  const sections = PARTNER_NAV_SECTIONS.map((sec) => ({
    ...sec,
    items: sec.items.filter((i) => hasTab(i.href)),
  })).filter((sec) => sec.items.length > 0);

  const userName =
    `${me.data?.firstName ?? ""} ${me.data?.lastName ?? ""}`.trim() ||
    (me.data?.email ?? "Partner");

  const initials = userName
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function handleLogout() {
    try {
      await logout.mutateAsync();
    } catch {
      // Even if the server call fails (e.g. cookie already gone), continue with
      // the bounce. Hard navigation so the browser drops the cleared cookie and
      // middleware re-checks auth on a fresh request (a soft replace would stay
      // in the still-authenticated SPA); the reload also discards the cache.
    }
    // Logging out of a Super Admin's partner impersonation ends it; the
    // admin's own session is intact, so return to the admin portal. An owner
    // viewing as a counsellor is signed out altogether.
    window.location.href = impersonating?.by === "admin" ? "/admin/dashboard" : "/login";
  }

  return (
    <MobileGate>
    <div className="min-h-screen bg-[#F5F6FA] text-[#1D2939]" style={bannerOffsetStyle(!!impersonating)}>
      <ImpersonationBanner side="partner" />
      <Sidebar
        sections={sections}
        logoSubtitle="Partner Portal"
        badges={{ chat: chatUnread ?? 0 }}
        onLogout={handleLogout}
        logoUrl={branding?.partnerLogoUrl}
      />
      <Topbar
        userName={userName}
        userInitials={initials}
        userAvatarUrl={me.data?.avatarUrl}
        roleLabel={kind ? PartnerKindLabel[kind] : "Partner"}
        searchPlaceholder="Search students, applications…"
        accountHref={tabs?.includes("account") ? "/partner/account" : undefined}
        notifications={feed.data?.notifications ?? []}
        onMarkAllRead={() => {
          if ((feed.data?.unread ?? 0) > 0) markAllRead.mutate();
        }}
        notificationsHref="/partner/notifications"
        onNotificationClick={(n) => {
          if (n.unread && /^\d+$/.test(n.id)) setRead.mutate({ id: Number(n.id), read: true });
        }}
        onLogout={handleLogout}
      />
      <main className="ml-16 min-h-screen pt-[calc(60px+var(--banner-h,0px))]">
        <div className="p-6">
          {!pageTab ? children : !tabs ? null : tabs.includes(pageTab) ? children : <NotAuthorised />}
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
        This section isn&apos;t turned on for your account. If you need it, contact Collegepond.
      </p>
      <Link
        href="/partner/dashboard"
        className="mt-5 inline-block rounded-lg bg-[#1570EF] px-4 py-2 text-sm font-medium text-white hover:bg-[#175CD3]"
      >
        Go to Dashboard
      </Link>
    </div>
  );
}
