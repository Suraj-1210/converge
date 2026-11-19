"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { useUrlState } from "~/lib/url-state";

// Full notifications page for both portals ("See older notifications" in the
// bell): the person's notification history, newest first, with read/unread,
// search, paging, mark-as-read and clear / restore. Cleared items leave the
// bell but stay here under Cleared. An agency owner can also look through
// their counsellors' notifications (read-only). The admin portal also lists what needs attention right now
// (the live signals behind the bell, which aren't stored history).

type Filter = "all" | "unread" | "read";
type View = "inbox" | "cleared" | "everything";

const VIEWS: { id: View; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "cleared", label: "Cleared" },
  { id: "everything", label: "Everything" },
];
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
  const [url, setUrl, ready] = useUrlState({ view: "inbox", q: "", whose: "mine" });
  const view = (VIEWS.some((v) => v.id === url.view) ? url.view : "inbox") as View;
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [searchText, setSearchText] = useState("");
  useEffect(() => setSearchText(url.q), [url.q]);
  // Search as you type, a beat after the last key.
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchText.trim() !== url.q) {
        setUrl({ q: searchText.trim() });
        setPage(1);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchText, url.q, setUrl]);
  const utils = api.useUtils();
  const members = api.partnerNotifications.agencyMembers.useQuery(undefined, { enabled: side === "partner" }).data;
  const whose: "mine" | "agency" | number =
    side === "partner" && members
      ? url.whose === "agency"
        ? "agency"
        : /^\d+$/.test(url.whose)
          ? Number(url.whose)
          : "mine"
      : "mine";
  const base = { filter, view, search: url.q, page, pageSize: PAGE_SIZE };

  const staffQ = api.staffNotifications.page.useQuery(base, { enabled: ready && side === "admin" });
  const partnerQ = api.partnerNotifications.page.useQuery({ ...base, whose }, { enabled: ready && side === "partner" });
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
  const staffClear = api.staffNotifications.setCleared.useMutation({ onSuccess: refresh });
  const partnerClear = api.partnerNotifications.setCleared.useMutation({ onSuccess: refresh });
  const staffClearAll = api.staffNotifications.clearAll.useMutation({ onSuccess: refresh });
  const partnerClearAll = api.partnerNotifications.clearAll.useMutation({ onSuccess: refresh });
  const setCleared = (id: number, cleared: boolean) =>
    side === "admin" ? staffClear.mutate({ id, cleared }) : partnerClear.mutate({ id, cleared });
  const clearAll = () => (side === "admin" ? staffClearAll.mutate() : partnerClearAll.mutate());

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
        <div className="flex gap-2">
          <button
            type="button"
            onClick={markAll}
            disabled={!data || data.unread === 0}
            className="rounded-lg border border-[#D0D5DD] bg-white px-3 py-2 text-sm font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Mark all as read
          </button>
          {view === "inbox" && whose === "mine" && (
            <button
              type="button"
              onClick={clearAll}
              disabled={!data || data.total === 0}
              className="rounded-lg border border-[#D0D5DD] bg-white px-3 py-2 text-sm font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-50"
              title="Clear everything from the bell; it stays here under Cleared"
            >
              Clear all
            </button>
          )}
        </div>
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
        <div className="flex flex-wrap items-center gap-2 border-b border-[#E4E7EC] px-4 py-3">
          <div className="flex rounded-lg border border-[#D0D5DD] p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => {
                  setUrl({ view: v.id });
                  setPage(1);
                }}
                className={`rounded-md px-3 py-1 text-xs font-semibold ${
                  view === v.id ? "bg-[#EFF8FF] text-[#175CD3]" : "text-[#475467] hover:bg-[#F9FAFB]"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search notifications…"
            aria-label="Search notifications"
            className="h-[30px] min-w-[180px] flex-1 rounded-lg border border-[#D0D5DD] px-2.5 text-[13px] outline-none focus:border-[#1570EF]"
          />
          {members && (
            <select
              value={whose === "mine" ? "mine" : String(whose)}
              onChange={(e) => {
                setUrl({ whose: e.target.value });
                setPage(1);
              }}
              aria-label="Whose notifications"
              className="h-[30px] rounded-lg border border-[#D0D5DD] bg-white px-2 text-[13px] text-[#344054] outline-none"
            >
              <option value="mine">Mine</option>
              <option value="agency">Whole agency</option>
              {members.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
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
            {url.q
              ? "No notifications match your search."
              : view === "cleared"
                ? "Nothing cleared yet."
                : filter === "unread"
                  ? "No unread notifications."
                  : "No notifications yet."}
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
                      {n.recipient && <span className="font-semibold text-[#667085]"> · To {n.recipient}</span>}
                      {n.archived && view === "everything" && <span> · Cleared</span>}
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
                  {n.own && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => setRead(n.dbId, n.unread)}
                        className="rounded-md px-2 py-1 text-[11px] font-semibold text-[#1570EF] hover:bg-[#EFF8FF]"
                      >
                        {n.unread ? "Mark read" : "Mark unread"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCleared(n.dbId, !n.archived)}
                        className="rounded-md px-2 py-1 text-[11px] font-semibold text-[#667085] hover:bg-[#F2F4F7]"
                      >
                        {n.archived ? "Restore" : "Clear"}
                      </button>
                    </div>
                  )}
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
