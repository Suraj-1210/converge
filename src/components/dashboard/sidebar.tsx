"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { LogoutIcon } from "./nav-icons";
import { type AdminRole, type NavItem, type NavSection } from "./nav-config";

interface SidebarProps {
  sections: NavSection[];
  logoSubtitle: string;
  /** Configured logo image URL; falls back to the Collegepond mark when empty. */
  logoUrl?: string;
  badges?: Record<string, number | string | undefined>;
  /** Current admin role (string form) — gates items that declare `roles`.
   *  Null while loading: items stay visible (fail-open) until the role resolves. */
  role?: AdminRole | null;
  /** Optional render slot above the logout button (e.g. admin role switcher). */
  footer?: ReactNode;
  onLogout?: () => void;
}

// The rail sits at 64px and expands to 240px on hover / keyboard focus, overlaying the
// content (which keeps a fixed 64px margin, so nothing reflows). Labels fade in; icons
// live in a fixed 64px column so they never shift during the elastic width animation.
const REVEAL = "opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100";

// Default logo when none is configured in Settings → General.
const FALLBACK_LOGO =
  "https://collegepond.com/wp-content/uploads/2025/07/cropped-Cp_logo_blue_comp.webp";

export function Sidebar({ sections, logoSubtitle, badges = {}, role = null, footer, onLogout, logoUrl }: SidebarProps) {
  const pathname = usePathname();
  const canSee = (item: NavItem): boolean =>
    !item.hidden && (!item.roles || role == null || item.roles.includes(role));

  return (
    <nav
      aria-label="Primary"
      className="group fixed top-[var(--banner-h,0px)] bottom-0 left-0 z-50 flex w-16 flex-col overflow-hidden border-r border-[#E4E7EC] bg-white transition-[width,box-shadow] duration-300 ease-[cubic-bezier(0.34,1.15,0.64,1)] hover:w-60 hover:shadow-[0_16px_48px_rgba(16,24,40,0.16)] focus-within:w-60 focus-within:shadow-[0_16px_48px_rgba(16,24,40,0.16)]"
    >
      <div className="flex h-full w-60 flex-col">
        {/* Logo */}
        <div className="flex items-center border-b border-[#E4E7EC] py-4">
          <span className="flex w-16 shrink-0 justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={logoUrl?.trim() ? logoUrl : FALLBACK_LOGO}
              alt="Logo"
              className="h-[34px] w-[34px] rounded-lg object-contain"
            />
          </span>
          <div className={REVEAL}>
            <div className="text-[17px] leading-tight font-bold whitespace-nowrap text-[#101828]">Collegepond</div>
            <div className="text-[10px] font-semibold tracking-wider text-[#1570EF] uppercase">{logoSubtitle}</div>
          </div>
        </div>

        {/* Sections */}
        <div className="flex-1 overflow-x-hidden overflow-y-auto py-3">
          {sections.map((section) => {
            const items = section.items.filter(canSee);
            if (items.length === 0) return null;
            return (
              <div key={section.label} className="mb-1">
                <div className={`px-5 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider whitespace-nowrap text-[#98A2B3] uppercase ${REVEAL}`}>
                  {section.label}
                </div>
                {items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isActive(pathname, item.href)}
                    badge={item.badgeKey ? badges[item.badgeKey] : undefined}
                  />
                ))}
              </div>
            );
          })}
        </div>

        {/* Optional footer slot (e.g. admin role switcher) */}
        {footer && <div className={`border-t border-[#E4E7EC] px-3 py-2 ${REVEAL}`}>{footer}</div>}

        {/* Logout */}
        <div className="border-t border-[#E4E7EC] py-2">
          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center text-sm font-medium whitespace-nowrap text-[#F04438] transition-colors hover:bg-[#FEF3F2]"
          >
            <span className="flex w-16 shrink-0 justify-center py-2.5">
              <LogoutIcon className="h-5 w-5 stroke-[#F04438]" />
            </span>
            <span className={REVEAL}>Logout</span>
          </button>
        </div>
      </div>
    </nav>
  );
}

function NavLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number | string }) {
  const stateClasses = item.disabled
    ? "cursor-not-allowed text-[#D0D5DD]"
    : active
      ? "bg-[#1570EF] text-white"
      : "text-[#344054] hover:bg-[#F0F7FF] hover:text-[#1570EF]";
  const iconStateClasses = item.disabled
    ? "stroke-[#D0D5DD]"
    : active
      ? "stroke-white"
      : "stroke-[#667085] group-hover/nav:stroke-[#1570EF]";

  // Only render a badge for a meaningful value — hide undefined / empty / zero
  // so a real count of 0 (e.g. no pending approvals) shows nothing, not a "0" pip.
  const showBadge =
    badge !== undefined && badge !== "" && badge !== 0 && badge !== "0";

  const content = (
    <>
      <span className="relative flex w-16 shrink-0 justify-center">
        <span className={`inline-flex h-5 w-5 items-center justify-center [&_svg]:h-5 [&_svg]:w-5 [&_svg]:fill-none ${iconStateClasses}`}>
          {item.icon}
        </span>
        {/* Collapsed-rail badge dot (the full count appears on expand). */}
        {showBadge && !active && (
          <span className="absolute top-0 right-3.5 h-2 w-2 rounded-full bg-[#F04438] transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" />
        )}
      </span>
      <span className={`flex-1 ${REVEAL}`}>{item.label}</span>
      {showBadge && (
        <span className={`mr-4 min-w-[20px] rounded-[10px] px-1.5 py-px text-center text-[11px] font-semibold ${active ? "bg-white/25 text-white" : "bg-[#F04438] text-white"} ${REVEAL}`}>
          {badge}
        </span>
      )}
    </>
  );

  const base = "group/nav relative mb-0.5 flex items-center py-2.5 text-sm font-medium whitespace-nowrap transition-colors";
  if (item.disabled) {
    return <span aria-disabled="true" className={`${base} ${stateClasses}`}>{content}</span>;
  }
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} className={`${base} ${stateClasses}`}>
      {content}
    </Link>
  );
}

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (pathname === href) return true;
  return pathname.startsWith(href + "/");
}
