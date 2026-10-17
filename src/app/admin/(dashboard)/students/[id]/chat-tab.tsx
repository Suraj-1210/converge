"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function WhatsappGlyph() {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#25D366]">
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="white">
        <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2zm5.6 14.2c-.24.67-1.2 1.23-1.9 1.34-.5.08-1.15.14-3.35-.72-2.82-1.1-4.6-3.96-4.74-4.15-.14-.19-1.14-1.52-1.14-2.9 0-1.38.72-2.06 1-2.35.24-.24.5-.3.67-.3l.48.01c.16.01.37-.06.58.44.24.55.8 1.9.87 2.04.07.14.12.3.02.48-.1.19-.14.3-.29.47-.14.16-.3.36-.43.48-.14.14-.29.3-.13.58.16.29.72 1.18 1.54 1.9 1.06.94 1.95 1.23 2.24 1.37.29.14.46.12.63-.07.19-.19.72-.84.91-1.13.19-.29.38-.24.63-.14.26.09 1.62.76 1.9.9.28.14.47.21.53.33.07.12.07.67-.17 1.34z" />
      </svg>
    </span>
  );
}

export function ChatTab({
  studentId,
  onToast,
}: {
  studentId: number;
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const configuredQ = api.chat.configured.useQuery();
  // Poll so inbound replies (which arrive on the webhook) show up without a reload.
  const threadQ = api.chat.thread.useQuery(
    { studentId },
    { refetchInterval: 15000, refetchOnWindowFocus: true },
  );
  // Reconcile the DB against Periskope on open + on an interval, so the thread
  // reflects the real conversation even if a webhook event was missed. NON-
  // blocking: the DB thread renders immediately; a successful sync just
  // invalidates it to pull in anything new.
  const syncChat = api.chat.sync.useMutation({
    onSuccess: () => void utils.chat.thread.invalidate({ studentId }),
  });
  // Reconcile only while actually viewing this chat: ChatTab is mounted only when
  // the Chat tab is selected (nav away → unmount → interval cleared), and each
  // tick is skipped when the browser tab is hidden.
  useEffect(() => {
    syncChat.mutate({ studentId });
    const t = setInterval(() => {
      if (!document.hidden) syncChat.mutate({ studentId });
    }, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const send = api.chat.send.useMutation({
    onSuccess: async () => {
      setDraft("");
      await utils.chat.thread.invalidate({ studentId });
    },
    onError: (e) => onToast(e.message),
  });

  const messages = threadQ.data ?? [];
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    send.mutate({ studentId, message: text });
  };

  return (
    <div className="flex h-[560px] flex-col overflow-hidden rounded-[14px] border border-[#E4E7EC] bg-white">
      <div className="flex items-center gap-2.5 border-b border-[#E4E7EC] px-5 py-3">
        <WhatsappGlyph />
        <span className="text-sm font-semibold text-[#101828]">WhatsApp</span>
        <span className="text-xs text-[#98A2B3]">· in sync with the student&apos;s WhatsApp</span>
      </div>

      {configuredQ.data && !configuredQ.data.configured && (
        <div className="border-b border-[#FEC84B] bg-[#FFFAEB] px-5 py-2 text-xs font-medium text-[#B54708]">
          WhatsApp isn&apos;t connected yet — messages can&apos;t be sent until the provider keys are configured.
        </div>
      )}

      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto bg-[#F5F6FA] px-5 py-4">
        {threadQ.isLoading ? (
          <p className="py-8 text-center text-sm text-[#98A2B3]">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-[#98A2B3]">No messages yet.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-[13px] ${
                  m.fromMe
                    ? "bg-[#DCF8C6] text-[#101828]"
                    : "border border-[#E4E7EC] bg-white text-[#101828]"
                }`}
              >
                <div className="break-words whitespace-pre-wrap">{m.body}</div>
                <div className="mt-0.5 text-right text-[10px] text-[#98A2B3]">
                  {timeLabel(m.at)}
                  {m.fromMe && m.status ? ` · ${m.status}` : ""}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-[#E4E7EC] px-4 py-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"
          rows={1}
          className="max-h-28 flex-1 resize-none rounded-lg border border-[#D0D5DD] px-3 py-2 text-sm outline-none focus:border-[#1570EF]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim() || send.isPending}
          className="rounded-lg bg-[#1570EF] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1257c4] disabled:opacity-50"
        >
          {send.isPending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
