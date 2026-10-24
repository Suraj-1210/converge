"use client";

import { type ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { MobileGate } from "./mobile-gate";
import { PARTNER_NAV_SECTIONS } from "./partner-nav-config";
import { api } from "~/trpc/react";
import { PartnerKindLabel } from "~/server/db/enums";
import { ImpersonationBanner, bannerOffsetStyle, useImpersonation } from "./impersonation";

export function PartnerDashboardShell({ children }: { children: ReactNode }) {
  const me = api.auth.me.useQuery(undefined, { retry: false });
  const utils = api.useUtils();
  const logout = api.auth.logout.useMutation();
  // Non-null while a Super Admin is impersonating this partner, or the agency
  // owner is viewing as this counsellor.
  const impersonating = useImpersonation("partner");

  // Persistent partner notification feed (counsellor decisions, etc.).
  const feed = api.partnerNotifications.list.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const branding = api.settings.branding.useQuery().data;
  // Chat threads with unread Collegepond messages (sidebar badge).
  const chatUnread = api.partnerChat.partnerUnreadCount.useQuery(undefined, {
    refetchInterval: 30_000,
    retry: false,
  }).data;
  const markAllRead = api.partnerNotifications.markAllRead.useMutation({
    onSuccess: () => void utils.partnerNotifications.list.invalidate(),
  });
  const setRead = api.partnerNotifications.setRead.useMutation({
    onSuccess: () => void utils.partnerNotifications.list.invalidate(),
  });

  // Managing the team is the agency owner's job; counsellors and independents
  // don't get the Counsellors page. Commission is the agency's money, so
  // agency counsellors don't get it either (the server refuses both anyway).
  const kind = me.data?.kind;
  const sections = PARTNER_NAV_SECTIONS.map((sec) => ({
    ...sec,
    items: sec.items.filter(
      (i) =>
        (i.href !== "/partner/counsellors" || kind === "agency") &&
        (i.href !== "/partner/commission" || (kind !== undefined && kind !== "counsellor")),
    ),
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
        accountHref="/partner/account"
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
        <div className="p-6">{children}</div>
      </main>
    </div>
    </MobileGate>
  );
}
