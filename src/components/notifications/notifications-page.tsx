"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "~/trpc/react";

// Full notifications page for both portals ("View all" in the bell): the
// person's notification history, newest first, with read/unread, paging and
// mark-as-read. The admin portal also lists what needs attention right now
// (the live signals behind the bell, which aren't stored history).

type Filter = "all" | "unread" | "read";
type Tone = "blue" | "green" | "orange" | "red" | "gray";

const DOT: Record<Tone, string> = {
  blue: "bg-[#1570EF]",
  green: "bg-[#12B76A]",
  orange: "bg-[#F79009]",
  red: "bg-[#F04438]",
  gray: "bg-[#98A2B3]",
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "read", label: "Read" },
];

const PAGE_SIZE = 20;

function fullDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function NotificationsPage({ side }: { side: "admin" | "partner" }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const utils = api.useUtils();
  const input = { filter, page, pageSize: PAGE_SIZE };

  const staffQ = api.staffNotifications.page.useQuery(input, { enabled: side === "admin" });
  const partnerQ = api.partnerNotifications.page.useQuery(input, { enabled: side === "partner" });
  const q = side === "admin" ? staffQ : partnerQ;
  const live = api.notifications.list.useQuery(undefined, { enabled: side === "admin" }).data;

  const refresh = () => {
    if (side === "admin") {
      void utils.staffNotifications.page.invalidate();
      void utils.staffNotifications.recent.invalidate();
    } else {
      void utils.partnerNotifications.page.invalidate();
      void utils.partnerNotifications.list.invalidate();
    }
  };
  const staffSetRead = api.staffNotifications.setRead.useMutation({ onSuccess: refresh });
  const partnerSetRead = api.partnerNotifications.setRead.useMutation({ onSuccess: refresh });
  const staffAll = api.staffNotifications.markAllRead.useMutation({ onSuccess: refresh });
  const partnerAll = api.partnerNotifications.markAllRead.useMutation({ onSuccess: refresh });
  const setRead = (id: number, read: boolean) =>
    side === "admin" ? staffSetRead.mutate({ id, read }) : partnerSetRead.mutate({ id, read });
  const markAll = () => (side === "admin" ? staffAll.mutate() : partnerAll.mutate());

  const data = q.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const liveItems = live?.notifications ?? [];

  return (
    <div className="mx-auto max-w-[920px]">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Notifications</h1>
          <p className="mt-1 text-sm text-[#667085]">
            {data ? `${data.unread} unread` : "Your notification history, newest first."}
          </p>
        </div>
        <button
          type="button"
          onClick={markAll}
          disabled={!data || data.unread === 0}
          className="rounded-lg border border-[#D0D5DD] bg-white px-3 py-2 text-sm font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Mark all as read
        </button>
      </div>

      {side === "admin" && liveItems.length > 0 && (
        <section className="mb-5 rounded-[14px] border border-[#E4E7EC] bg-white">
          <div className="border-b border-[#E4E7EC] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#101828]">Needs attention now</h2>
            <p className="text-xs text-[#98A2B3]">Live from current work queues; these clear when the work is done.</p>
          </div>
          <ul>
            {liveItems.map((n) => (
              <li key={n.id} className="border-b border-[#F2F4F7] last:border-b-0">
                <Link href={n.href} className="flex items-start gap-2.5 px-4 py-3 hover:bg-[#F9FAFB]">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[n.tone]}`} />
                  <span className="flex-1 text-[13px] font-semibold text-[#101828]">{n.title}</span>
                  <span className="shrink-0 text-[11px] text-[#98A2B3]">{n.time}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-[14px] border border-[#E4E7EC] bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-[#E4E7EC] px-4 py-3">
          <h2 className="text-sm font-semibold text-[#101828]">History</h2>
          <div className="flex gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setFilter(f.id);
                  setPage(1);
                }}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  filter === f.id ? "bg-[#1570EF] text-white" : "bg-[#F2F4F7] text-[#344054] hover:bg-[#EAECF0]"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {q.error ? (
          <p className="px-4 py-8 text-center text-sm text-[#B42318]">{q.error.message}</p>
        ) : q.isLoading ? (
          <p className="px-4 py-8 text-center text-sm text-[#98A2B3]">Loading…</p>
        ) : !data || data.items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-[#98A2B3]">
            {filter === "unread" ? "No unread notifications." : "No notifications yet."}
          </p>
        ) : (
          <ul>
            {data.items.map((n) => {
              const content = (
                <>
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[n.tone]}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] leading-snug ${n.unread ? "font-semibold text-[#101828]" : "text-[#344054]"}`}>
                      {n.title}
                    </span>
                    {n.body && <span className="mt-0.5 block text-[12px] leading-snug text-[#475467]">{n.body}</span>}
                    <span className="mt-1 block text-[11px] text-[#98A2B3]" title={fullDate(n.at)}>
                      {n.time} · {fullDate(n.at)}
                    </span>
                  </span>
                </>
              );
              return (
                <li
                  key={n.id}
                  className={`flex items-start gap-2 border-b border-[#F2F4F7] px-4 py-3 last:border-b-0 ${n.unread ? "bg-[#F5F9FF]" : ""}`}
                >
                  {n.href ? (
                    <Link
                      href={n.href}
                      onClick={() => n.unread && setRead(n.dbId, true)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 hover:underline-offset-2"
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">{content}</div>
                  )}
                  <button
                    type="button"
                    onClick={() => setRead(n.dbId, n.unread)}
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-[#1570EF] hover:bg-[#EFF8FF]"
                  >
                    {n.unread ? "Mark read" : "Mark unread"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {data && data.total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-[#E4E7EC] px-4 py-3 text-xs text-[#667085]">
            <span>
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg border border-[#D0D5DD] px-3 py-1.5 font-semibold text-[#344054] disabled:opacity-40"
              >
                Previous
              </button>
              <span className="self-center">
                Page {page} of {pages}
              </span>
              <button
                type="button"
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                className="rounded-lg border border-[#D0D5DD] px-3 py-1.5 font-semibold text-[#344054] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
