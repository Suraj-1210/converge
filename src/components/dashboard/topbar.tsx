"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BellIcon,
  ChevronDownIcon,
  ProfileIcon,
  SearchIcon,
  TasksIcon,
} from "./nav-icons";

export interface NotificationItem {
  id: string;
  title: string;
  time: string;
  tone: "blue" | "green" | "orange" | "red" | "gray";
  unread?: boolean;
  /** Optional secondary line under the title (e.g. a rejection reason). */
  body?: string;
  /** When set, the notification row links to the relevant page on click. */
  href?: string;
}

interface TopbarProps {
  userName: string;
  userInitials: string;
  // Profile photo URL; initials are shown when absent or if it fails to load.
  userAvatarUrl?: string | null;
  roleLabel: string;
  taskCount?: number;
  notifications?: NotificationItem[];
  searchPlaceholder?: string;
  /**
   * If provided, the profile dropdown shows a "My Account" link pointing here.
   * Omit (admin shells) to hide account-level entries entirely.
   */
  accountHref?: string;
  onSearch?: (value: string) => void;
  onTasksClick?: () => void;
  onMarkAllRead?: () => void;
  onLogout?: () => void;
}

const DOT_TONES: Record<NotificationItem["tone"], string> = {
  blue: "bg-[#1570EF]",
  green: "bg-[#12B76A]",
  orange: "bg-[#F79009]",
  red: "bg-[#F04438]",
  gray: "bg-[#98A2B3]",
};

export function Topbar({
  userName,
  userInitials,
  userAvatarUrl,
  roleLabel,
  taskCount = 0,
  notifications = [],
  searchPlaceholder = "Search partners, students, applications...",
  accountHref,
  onSearch,
  onTasksClick,
  onMarkAllRead,
  onLogout,
}: TopbarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const hasUnread = notifications.some((n) => n.unread);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
      if (
        profileRef.current &&
        !profileRef.current.contains(e.target as Node)
      ) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header
      className="fixed top-0 right-0 left-16 z-40 flex h-[60px] items-center gap-3 border-b border-[#E4E7EC] bg-white px-6"
    >
      <div className="flex-1" />

      {/* Search */}
      <div className="hidden h-9 w-[280px] items-center gap-2 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] px-3 md:flex">
        <SearchIcon className="h-4 w-4 shrink-0 stroke-[#98A2B3]" />
        <input
          type="search"
          placeholder={searchPlaceholder}
          onChange={(e) => onSearch?.(e.target.value)}
          className="flex-1 border-none bg-transparent text-[13px] text-[#101828] outline-none placeholder:text-[#98A2B3]"
        />
        <span className="rounded bg-[#E4E7EC] px-1.5 py-0.5 text-[11px] font-medium text-[#98A2B3]">
          ⌘K
        </span>
      </div>

      {/* Tasks */}
      <button
        type="button"
        aria-label="Tasks"
        onClick={onTasksClick}
        className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[#E4E7EC] bg-white transition-colors hover:bg-[#F9FAFB]"
      >
        <TasksIcon className="h-[18px] w-[18px] stroke-[#667085]" />
        {taskCount > 0 && (
          <span className="absolute top-0.5 right-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-[10px] bg-[#F04438] px-1 text-[10px] leading-none font-bold text-white">
            {taskCount > 99 ? "99+" : taskCount}
          </span>
        )}
      </button>

      {/* Notifications */}
      <div ref={notifRef} className="relative">
        <button
          type="button"
          aria-label="Notifications"
          aria-expanded={notifOpen}
          onClick={() => setNotifOpen((v) => !v)}
          className="relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-[#E4E7EC] bg-white transition-colors hover:bg-[#F9FAFB]"
        >
          <BellIcon className="h-[18px] w-[18px] stroke-[#667085]" />
          {hasUnread && (
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full border-2 border-white bg-[#F04438]" />
          )}
        </button>

        {notifOpen && (
          <div className="absolute top-11 right-0 z-[100] flex max-h-[480px] w-[360px] flex-col overflow-hidden rounded-xl border border-[#E4E7EC] bg-white shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#E4E7EC] px-4 py-3.5">
              <h3 className="text-sm font-semibold text-[#101828]">
                Notifications
              </h3>
              <button
                type="button"
                onClick={onMarkAllRead}
                className="cursor-pointer border-none bg-transparent text-xs font-medium text-[#1570EF] hover:underline"
              >
                Mark all as read
              </button>
            </div>
            <div className="max-h-[380px] overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[#98A2B3]">
                  No notifications
                </div>
              ) : (
                notifications.map((n) => {
                  const rowClass = `block cursor-pointer border-b border-[#F2F4F7] px-4 py-3 transition-colors last:border-b-0 ${
                    n.unread
                      ? "bg-[#F0F7FF] hover:bg-[#E0EFFF]"
                      : "hover:bg-[#FAFBFC]"
                  }`;
                  const body = (
                    <div className="flex items-start gap-2.5">
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_TONES[n.tone]}`}
                      />
                      <div className="flex-1">
                        <div className="text-[13px] leading-snug font-semibold text-[#101828]">
                          {n.title}
                        </div>
                        {n.body && (
                          <div className="mt-0.5 text-[12px] leading-snug text-[#475467]">
                            {n.body}
                          </div>
                        )}
                        <div className="mt-1 text-[11px] text-[#98A2B3]">
                          {n.time}
                        </div>
                      </div>
                    </div>
                  );
                  return n.href ? (
                    <Link
                      key={n.id}
                      href={n.href}
                      className={rowClass}
                      onClick={() => setNotifOpen(false)}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div key={n.id} className={rowClass}>
                      {body}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* Profile */}
      <div ref={profileRef} className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={profileOpen}
          onClick={() => setProfileOpen((v) => !v)}
          className="flex cursor-pointer items-center gap-2.5 rounded-lg border-none bg-transparent py-1 pr-2 pl-1 transition-colors hover:bg-[#F9FAFB]"
        >
          {userAvatarUrl && !avatarFailed ? (
            // eslint-disable-next-line @next/next/no-img-element -- private, presigned URLs
            <img
              src={userAvatarUrl}
              alt=""
              onError={() => setAvatarFailed(true)}
              className="h-[34px] w-[34px] rounded-full object-cover"
            />
          ) : (
            <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-gradient-to-br from-[#1570EF] to-[#0b4ea2] text-sm font-semibold text-white">
              {userInitials}
            </span>
          )}
          <span className="hidden text-left leading-tight sm:block">
            <span className="block text-[13px] font-semibold text-[#101828]">
              {userName}
            </span>
            <span className="block text-[11px] text-[#98A2B3]">
              {roleLabel}
            </span>
          </span>
          <ChevronDownIcon className="h-3.5 w-3.5 stroke-[#98A2B3]" />
        </button>

        {profileOpen && (
          <div
            role="menu"
            className="absolute top-12 right-0 z-[100] min-w-[200px] rounded-[10px] border border-[#E4E7EC] bg-white p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.12)]"
          >
            {accountHref && (
              <>
                <Link
                  href={accountHref}
                  role="menuitem"
                  onClick={() => setProfileOpen(false)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm text-[#344054] no-underline transition-colors hover:bg-[#F0F7FF] hover:text-[#1570EF] [&:hover_svg]:stroke-[#1570EF]"
                >
                  <ProfileIcon className="h-4 w-4 stroke-[#667085]" />
                  My Account
                </Link>
                <div className="my-1 h-px bg-[#E4E7EC]" />
              </>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={onLogout}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border-none bg-transparent px-3 py-2 text-left text-sm text-[#F04438] transition-colors hover:bg-[#FEF3F2]"
            >
              <ProfileIcon className="h-4 w-4 stroke-[#F04438]" />
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
