"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { Toast } from "~/components/ui/toast";
import { type TatStatus } from "~/lib/tat";
import { CHAT_FILTER_DEFINITIONS } from "~/lib/partner-chat-rules";
import { type ChatSide, PartnerChatPanel } from "./chat-panel";

// Partner chat inbox: every student thread this person takes part in, with
// unread counts and the latest message; the Collegepond side also sees each
// thread's TAT clock. The selected thread opens alongside (?student=<id>).

type Filter = "all" | "unread" | "awaiting" | "overdue";

// Labels and tooltips come from one set of definitions
// (src/lib/partner-chat-rules.ts), shared with the server's filters.
const FILTER_IDS: Record<ChatSide, Filter[]> = {
  partner: ["all", "unread", "awaiting"],
  staff: ["all", "unread", "awaiting", "overdue"],
};
const FILTERS: Record<ChatSide, { id: Filter; label: string; help: string }[]> = {
  partner: FILTER_IDS.partner.map((id) => ({
    id,
    label: CHAT_FILTER_DEFINITIONS[id].label,
    help: CHAT_FILTER_DEFINITIONS[id].partner,
  })),
  staff: FILTER_IDS.staff.map((id) => ({
    id,
    label: CHAT_FILTER_DEFINITIONS[id].label,
    help: CHAT_FILTER_DEFINITIONS[id].staff,
  })),
};

const TAT_PILL: Record<TatStatus, string> = {
  Breached: "bg-[#FEF3F2] text-[#B42318]",
  Warning: "bg-[#FFFAEB] text-[#B54708]",
  "On Track": "bg-[#F2F4F7] text-[#475467]",
};

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

export function PartnerChatInbox({ side }: { side: ChatSide }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const toast = (m: string) => {
    setToastMsg(m);
    setToastOpen(true);
  };

  // Deep links: ?filter=unread|awaiting|overdue and ?student=<id>.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const f = p.get("filter") as Filter | null;
    if (f && FILTERS[side].some((x) => x.id === f)) setFilter(f);
    const s = Number(p.get("student"));
    if (Number.isInteger(s) && s > 0) setSelected(s);
  }, [side]);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (selected) p.set("student", String(selected));
    else p.delete("student");
    if (filter !== "all") p.set("filter", filter);
    else p.delete("filter");
    const qs = p.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [selected, filter]);

  const input = { filter, q: q.trim() || undefined };
  const opts = { refetchInterval: 15_000, retry: false } as const;
  const partnerQ = api.partnerChat.partnerInbox.useQuery(input, { ...opts, enabled: side === "partner" });
  const staffQ = api.partnerChat.staffInbox.useQuery(input, { ...opts, enabled: side === "staff" });
  const listQ = side === "partner" ? partnerQ : staffQ;
  const rows = listQ.data ?? [];
  // Numbers on the filter tabs, over every conversation (not the search).
  const countOpts = { refetchInterval: 15_000, retry: false } as const;
  const partnerCounts = api.partnerChat.partnerInboxCounts.useQuery(undefined, { ...countOpts, enabled: side === "partner" });
  const staffCounts = api.partnerChat.staffInboxCounts.useQuery(undefined, { ...countOpts, enabled: side === "staff" });
  const counts = (side === "partner" ? partnerCounts : staffCounts).data;
  const profileHref = (id: number) =>
    side === "partner" ? `/partner/students/${id}?tab=chat` : `/admin/students/${id}?tab=partner-chat`;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#101828]">{side === "partner" ? "Chat with Collegepond" : "Partner Chat"}</h1>
        <p className="mt-1 text-sm text-[#667085]">
          {side === "partner"
            ? "One conversation per student with Collegepond's counselling team. To start one, open a student and use the Chat tab."
            : "Conversations with partners, one per student. Reply time counts against the Chat Response TAT (business hours)."}
        </p>
      </div>

      {listQ.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">{listQ.error.message}</div>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          {/* Thread list */}
          <div className="flex w-full shrink-0 flex-col overflow-hidden rounded-[14px] border border-[#E4E7EC] bg-white lg:h-[680px] lg:w-[380px]">
            <div className="space-y-2.5 border-b border-[#E4E7EC] p-3">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search student name or ID"
                className="h-9 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]"
              />
              <div className="flex flex-wrap gap-1.5">
                {FILTERS[side].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    title={f.help}
                    aria-describedby="chat-filter-help"
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      filter === f.id ? "bg-[#1570EF] text-white" : "bg-[#F2F4F7] text-[#344054] hover:bg-[#EAECF0]"
                    }`}
                  >
                    {f.label}
                    {counts && f.id !== "all" && (
                      <span
                        className={`ml-1.5 inline-flex min-w-[18px] justify-center rounded-full px-1.5 text-[10px] leading-[16px] font-bold ${
                          filter === f.id
                            ? "bg-white text-[#1570EF]"
                            : counts[f.id] > 0
                              ? f.id === "overdue"
                                ? "bg-[#F04438] text-white"
                                : f.id === "awaiting"
                                  ? "bg-[#F79009] text-white"
                                  : "bg-[#1570EF] text-white"
                              : "bg-[#E4E7EC] text-[#667085]"
                        }`}
                      >
                        {counts[f.id]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {filter !== "all" && (
                <p id="chat-filter-help" className="text-[11px] leading-snug text-[#667085]">
                  <span className="font-semibold text-[#344054]">{CHAT_FILTER_DEFINITIONS[filter].label}:</span>{" "}
                  {FILTERS[side].find((f) => f.id === filter)?.help}
                </p>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {listQ.isLoading ? (
                <p className="px-4 py-8 text-center text-sm text-[#98A2B3]">Loading…</p>
              ) : rows.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-[#98A2B3]">
                  {filter === "all" && !q ? "No conversations yet." : "Nothing matches."}
                </p>
              ) : (
                rows.map((r) => (
                  <button
                    key={r.studentId}
                    type="button"
                    onClick={() => setSelected(r.studentId)}
                    className={`block w-full border-b border-[#F2F4F7] px-4 py-3 text-left transition hover:bg-[#F9FAFB] ${
                      selected === r.studentId ? "bg-[#F5F9FF]" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`min-w-0 flex-1 truncate text-sm ${r.unread ? "font-bold text-[#101828]" : "font-semibold text-[#344054]"}`}>
                        {r.studentName}
                      </span>
                      <span className="shrink-0 text-[11px] text-[#98A2B3]">{when(r.lastAt)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-[#667085]">
                      {side === "staff"
                        ? `${r.partnerName}${r.cpCounsellor ? ` · ${r.cpCounsellor}` : " · no CP counsellor"}`
                        : r.partnerCounsellor
                          ? `Counsellor: ${r.partnerCounsellor}`
                          : `CP-${r.studentId}`}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`min-w-0 flex-1 truncate text-xs ${r.unread ? "text-[#344054]" : "text-[#98A2B3]"}`}>
                        {r.lastSide === "staff" ? "Collegepond: " : r.lastSide === "partner" ? "Partner: " : ""}
                        {r.lastPreview}
                      </span>
                      {/* Partner side: their message is still waiting (no clock shown). */}
                      {side === "partner" && r.awaitingReply && (
                        <span
                          className="shrink-0 rounded-full bg-[#FFFAEB] px-2 py-0.5 text-[10px] font-semibold text-[#B54708]"
                          title={CHAT_FILTER_DEFINITIONS.awaiting.partner}
                        >
                          Awaiting reply
                        </span>
                      )}
                      {r.awaiting && (
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${TAT_PILL[r.awaiting.status]}`} title={`${r.awaiting.status === "Breached" ? "Overdue" : "Awaiting reply"}: waiting ${r.awaiting.label} for a Collegepond reply (business hours)`}>
                          {r.awaiting.status === "Breached" ? "Overdue" : "Awaiting"} · {r.awaiting.label}
                        </span>
                      )}
                      {r.unread > 0 && (
                        <span className="shrink-0 rounded-full bg-[#1570EF] px-1.5 py-0.5 text-[10px] font-bold text-white">{r.unread}</span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Selected thread */}
          <div className="min-w-0 flex-1">
            {selected ? (
              <>
                <div className="mb-2 flex justify-end">
                  <Link href={profileHref(selected)} className="text-xs font-semibold text-[#1570EF] hover:underline">
                    Open student profile →
                  </Link>
                </div>
                <PartnerChatPanel key={selected} side={side} studentId={selected} onToast={toast} heightClass="h-[650px]" />
              </>
            ) : (
              <div className="flex h-[680px] items-center justify-center rounded-[14px] border border-dashed border-[#D0D5DD] bg-white text-sm text-[#98A2B3]">
                Select a conversation
              </div>
            )}
          </div>
        </div>
      )}
      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}
