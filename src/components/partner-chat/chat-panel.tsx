"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { STUDENT_DOC_TYPES } from "~/server/db/enums";
import { fmtMinutes, type TatStatus } from "~/lib/tat";
import { guessStudentDocType } from "~/lib/student-doc-guess";

// Partner ↔ Collegepond chat for one student (src/server/partner-chat.ts),
// used on the partner student profile, the admin student page and both
// inboxes. `side` picks the partner or staff procedures; the server decides
// who may use them. Polls every 4 s while open and visible.

export type ChatSide = "partner" | "staff";

const POLL_MS = 4000;
const MAX_FILES = 10;

// Colours by side, the same in both portals, so a Collegepond message always
// looks like one. System lines are neutral.
const BUBBLE: Record<ChatSide, string> = {
  staff: "border border-[#B2DDFF] bg-[#EFF8FF] text-[#101828]",
  partner: "border border-[#E4E7EC] bg-white text-[#101828]",
};
const SIDE_TAG: Record<ChatSide, string> = {
  staff: "text-[#175CD3]",
  partner: "text-[#6941C6]",
};

const TAT_TONE: Record<TatStatus, string> = {
  Breached: "bg-[#FEF3F2] text-[#B42318] border-[#FECDCA]",
  Warning: "bg-[#FFFAEB] text-[#B54708] border-[#FEDF89]",
  "On Track": "bg-[#ECFDF3] text-[#027A48] border-[#ABEFC6]",
};

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function sizeLabel(n: number | null): string {
  if (!n) return "";
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// An uploaded file waiting to be sent. docType: the checklist type for
// "Send and save to documents" ("" = chat only), pre-filled from the name.
type Pending = { id: number; fileName: string; sizeBytes: number | null; docType: string };
type Filed = { attachmentId: number; fileName: string; label: string | null; error: string | null };

export function PartnerChatPanel({
  side,
  studentId,
  onToast,
  heightClass = "h-[620px]",
}: {
  side: ChatSide;
  studentId: number;
  onToast: (msg: string) => void;
  heightClass?: string;
}) {
  const utils = api.useUtils();
  const isPartner = side === "partner";
  const opts = { refetchInterval: POLL_MS, refetchOnWindowFocus: true, retry: false } as const;
  const partnerQ = api.partnerChat.partnerThread.useQuery({ studentId }, { ...opts, enabled: isPartner });
  const staffQ = api.partnerChat.staffThread.useQuery({ studentId }, { ...opts, enabled: !isPartner });
  const q = isPartner ? partnerQ : staffQ;
  const data = q.data;

  const refresh = async () => {
    if (isPartner) {
      await utils.partnerChat.partnerThread.invalidate({ studentId });
      void utils.partnerChat.partnerInbox.invalidate();
    } else {
      await utils.partnerChat.staffThread.invalidate({ studentId });
      void utils.partnerChat.staffInbox.invalidate();
    }
  };
  const onError = (e: { message: string }) => onToast(e.message);
  const partnerSend = api.partnerChat.partnerSend.useMutation({ onError });
  const staffSend = api.partnerChat.staffSend.useMutation({ onError });
  const partnerEdit = api.partnerChat.partnerEdit.useMutation({ onError });
  const staffEdit = api.partnerChat.staffEdit.useMutation({ onError });
  const partnerSave = api.partnerChat.partnerSaveAttachment.useMutation({ onError });
  const staffSave = api.partnerChat.staffSaveAttachment.useMutation({ onError });
  const afterRead = () => {
    if (isPartner) {
      void utils.partnerChat.partnerUnreadCount.invalidate();
      void utils.partnerChat.partnerInbox.invalidate();
      void utils.partnerNotifications.list.invalidate();
    } else {
      void utils.partnerChat.staffInbox.invalidate();
      void utils.notifications.list.invalidate();
    }
  };
  const partnerRead = api.partnerChat.partnerMarkRead.useMutation({ onSuccess: afterRead });
  const staffRead = api.partnerChat.staffMarkRead.useMutation({ onSuccess: afterRead });
  const send = isPartner ? partnerSend : staffSend;
  const edit = isPartner ? partnerEdit : staffEdit;
  const save = isPartner ? partnerSave : staffSave;
  const markRead = isPartner ? partnerRead : staffRead;
  const noReply = api.partnerChat.staffNoReplyNeeded.useMutation({
    onError,
    onSuccess: () => {
      void refresh();
      void utils.notifications.list.invalidate();
    },
  });

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [savingFor, setSavingFor] = useState<{ attachmentId: number; docType: string } | null>(null);
  // Result of the last "Send and save to documents": where each file went.
  const [filed, setFiled] = useState<Filed[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const messages = data?.messages ?? [];
  const lastId = data?.lastMessageId ?? 0;

  // Scroll to the newest message when one arrives.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Mark as read while the thread is on screen.
  const readSent = useRef(0);
  useEffect(() => {
    if (!data || lastId === 0 || lastId <= data.myLastReadId || readSent.current >= lastId) return;
    if (typeof document !== "undefined" && document.hidden) return;
    readSent.current = lastId;
    markRead.mutate({ studentId, upToId: lastId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, data?.myLastReadId, studentId]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_FILES - pending.length;
    if (room <= 0) {
      onToast(`Up to ${MAX_FILES} files per message.`);
      return;
    }
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, room)) {
        const fd = new FormData();
        fd.append("side", side);
        fd.append("studentId", String(studentId));
        fd.append("file", f);
        const res = await fetch("/api/partner-chat/upload", { method: "POST", body: fd });
        const json = (await res.json().catch(() => ({}))) as { id?: number; fileName?: string; sizeBytes?: number | null; error?: string };
        if (!res.ok || !json.id) {
          onToast(json.error ?? `Couldn't attach ${f.name}`);
          continue;
        }
        const fileName = json.fileName ?? f.name;
        setPending((p) => [...p, { id: json.id!, fileName, sizeBytes: json.sizeBytes ?? null, docType: guessStudentDocType(fileName) }]);
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // saveDocs: also file each typed attachment into the student's documents.
  const submit = (saveDocs = false) => {
    const body = draft.trim();
    if ((!body && pending.length === 0) || send.isPending || uploading) return;
    const sent = pending;
    send.mutate(
      {
        studentId,
        body,
        attachmentIds: sent.map((p) => p.id),
        ...(saveDocs ? { fileAs: sent.map((p) => ({ attachmentId: p.id, docType: p.docType })) } : {}),
      },
      {
        onSuccess: (r) => {
          setDraft("");
          setPending([]);
          if (saveDocs) {
            // Every file, including the ones left untyped (chat only).
            setFiled(
              sent.map(
                (p) =>
                  r.filed.find((f) => f.attachmentId === p.id) ?? {
                    attachmentId: p.id,
                    fileName: p.fileName,
                    label: null,
                    error: null,
                  },
              ),
            );
            if (isPartner) void utils.students.partnerDocuments.invalidate({ studentId });
          }
          void refresh();
        },
      },
    );
  };
  const typedCount = pending.filter((p) => p.docType).length;

  const saveEdit = () => {
    if (!editing) return;
    edit.mutate(
      { messageId: editing.id, body: editing.body },
      {
        onSuccess: () => {
          setEditing(null);
          void refresh();
        },
      },
    );
  };

  const saveToDocs = () => {
    if (!savingFor?.docType) return;
    save.mutate(
      { attachmentId: savingFor.attachmentId, docType: savingFor.docType },
      {
        onSuccess: (r) => {
          setSavingFor(null);
          onToast(`Saved to the student's documents (${r.label})`);
          void refresh();
          if (isPartner) void utils.students.partnerDocuments.invalidate({ studentId });
        },
      },
    );
  };

  const forbidden = q.error?.data?.code === "FORBIDDEN" || q.error?.data?.code === "NOT_FOUND";

  return (
    <div className={`flex ${heightClass} flex-col overflow-hidden rounded-[14px] border border-[#E4E7EC] bg-white`}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[#E4E7EC] px-5 py-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#1570EF]">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="white" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <span className="text-sm font-semibold text-[#101828]">{isPartner ? "Chat with Collegepond" : "Partner chat"}</span>
        {data && (
          <span className="min-w-0 text-xs text-[#667085]">
            <span className={SIDE_TAG.partner}>Partner:</span> {data.participants.partner.join(", ") || "—"}
            <span className="mx-1.5 text-[#D0D5DD]">|</span>
            <span className={SIDE_TAG.staff}>Collegepond:</span>{" "}
            {data.participants.collegepond.join(", ") || "counselling team (no counsellor assigned yet)"}
          </span>
        )}
        {data?.tat && (
          <span
            title={`Waiting since ${timeLabel(data.tat.since)}. Business hours only. Target ${fmtMinutes(data.tat.thresholdMinutes)}${data.tat.dueAt ? `, due ${timeLabel(data.tat.dueAt)}` : ""}.`}
            className={`ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${TAT_TONE[data.tat.status]}`}
          >
            Awaiting reply · {fmtMinutes(data.tat.elapsedMinutes)} of {fmtMinutes(data.tat.thresholdMinutes)}
            {data.tat.status === "Breached" ? " · overdue" : ""}
          </span>
        )}
      </div>

      {/* Out of office: who to contact instead (both sides) */}
      {data && data.outOfOffice.length > 0 && (
        <div className="space-y-1 border-b border-[#FEDF89] bg-[#FFFAEB] px-5 py-2 text-[12px] text-[#B54708]">
          {data.outOfOffice.map((o) => (
            <div key={o.name}>
              <span className="font-semibold">{o.name}</span> is out of office {o.dates}. Contact{" "}
              <span className="font-semibold">{o.alternate.name}</span>{" "}
              <a href={`mailto:${o.alternate.email}`} className="underline">
                {o.alternate.email}
              </a>
              {o.alternate.phone ? ` · ${o.alternate.phone}` : ""}
              {!isPartner && " (they get this chat and its reply clock meanwhile)"}
            </div>
          ))}
        </div>
      )}

      {/* Messages */}
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto bg-[#F5F6FA] px-5 py-4">
        {q.isLoading ? (
          <p className="py-8 text-center text-sm text-[#98A2B3]">Loading…</p>
        ) : forbidden ? (
          <p className="py-10 text-center text-sm text-[#B42318]">{q.error?.message}</p>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-[#98A2B3]">
            {isPartner
              ? "No messages yet. Ask Collegepond's counselling team anything about this student. Attach documents here, too."
              : "No messages yet. The partner's messages about this student will appear here."}
          </p>
        ) : (
          messages.map((m) => {
            if (m.kind === "system") {
              return (
                <div key={m.id} className="flex justify-center">
                  <span className="rounded-full bg-[#EAECF0] px-3 py-1 text-[11px] text-[#475467]">
                    {m.body} · {timeLabel(m.createdAt)}
                  </span>
                </div>
              );
            }
            const s = m.side as ChatSide;
            const isEditing = editing?.id === m.id;
            return (
              <div key={m.id} className={`flex flex-col ${m.mine ? "items-end" : "items-start"}`}>
                <div className="mb-0.5 px-1 text-[11px] text-[#667085]">
                  <span className="font-semibold text-[#344054]">{m.mine ? "You" : m.senderName}</span>
                  {m.senderRole && <span className={`ml-1.5 ${SIDE_TAG[s]}`}>{m.senderRole}</span>}
                </div>
                <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-[13px] ${BUBBLE[s]}`}>
                  {isEditing ? (
                    <div className="w-[min(420px,60vw)]">
                      <textarea
                        value={editing.body}
                        onChange={(e) => setEditing({ id: m.id, body: e.target.value })}
                        rows={3}
                        maxLength={4000}
                        className="w-full resize-none rounded-lg border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[#1570EF]"
                      />
                      <div className="mt-1.5 flex justify-end gap-2">
                        <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-xs font-semibold text-[#344054]">
                          Cancel
                        </button>
                        <button type="button" onClick={saveEdit} disabled={edit.isPending} className="rounded-md bg-[#1570EF] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    m.body && <div className="break-words whitespace-pre-wrap">{m.body}</div>
                  )}
                  {m.attachments.length > 0 && (
                    <div className={`space-y-1.5 ${m.body ? "mt-2" : ""}`}>
                      {m.attachments.map((a) => (
                        <div key={a.id} className="rounded-lg border border-[#E4E7EC] bg-white px-2.5 py-2">
                          <div className="flex items-center gap-2">
                            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-[#667085]" fill="none" stroke="currentColor" strokeWidth={2}>
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <a href={a.url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-medium text-[#1570EF] hover:underline">
                              {a.fileName}
                            </a>
                            <span className="shrink-0 text-[11px] text-[#98A2B3]">{sizeLabel(a.sizeBytes)}</span>
                          </div>
                          {a.savedAs ? (
                            <div className="mt-1 text-[11px] font-medium text-[#027A48]">✓ Saved to Documents · {a.savedAs}</div>
                          ) : savingFor?.attachmentId === a.id ? (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              <select
                                value={savingFor.docType}
                                onChange={(e) => setSavingFor({ attachmentId: a.id, docType: e.target.value })}
                                className="h-7 rounded-md border border-[#D0D5DD] px-1.5 text-xs outline-none focus:border-[#1570EF]"
                              >
                                <option value="">Document type…</option>
                                {STUDENT_DOC_TYPES.map((d) => (
                                  <option key={d.key} value={d.key}>
                                    {d.label}
                                  </option>
                                ))}
                              </select>
                              <button type="button" onClick={saveToDocs} disabled={!savingFor.docType || save.isPending} className="h-7 rounded-md bg-[#1570EF] px-2.5 text-xs font-semibold text-white disabled:opacity-50">
                                {save.isPending ? "Saving…" : "Save"}
                              </button>
                              <button type="button" onClick={() => setSavingFor(null)} className="h-7 rounded-md px-1.5 text-xs text-[#667085] hover:text-[#344054]">
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setSavingFor({ attachmentId: a.id, docType: "" })}
                              className="mt-1 text-[11px] font-semibold text-[#1570EF] hover:underline"
                            >
                              Save to student documents
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 px-1 text-[10px] text-[#98A2B3]">
                  <span>{timeLabel(m.createdAt)}</span>
                  {m.editedAt && <span>· edited</span>}
                  {m.replyMinutes != null && <span title="Collegepond reply time, business hours">· replied in {fmtMinutes(m.replyMinutes)}</span>}
                  {m.mine && <span className={m.seen ? "text-[#1570EF]" : ""}>· {m.seen ? "Seen" : "Sent"}</span>}
                  {m.ack && !m.noReplyNeeded && (
                    <span title="A short acknowledgement: it doesn't start the reply clock (Settings → TAT Settings)">
                      · Acknowledgement, no reply clock
                    </span>
                  )}
                  {m.noReplyNeeded && (
                    <span className="text-[#027A48]" title={`Marked ${timeLabel(m.noReplyNeeded.at)}. It no longer holds the reply clock.`}>
                      · No reply needed ({m.noReplyNeeded.by})
                    </span>
                  )}
                  {m.canMarkNoReply && !m.ack && (
                    <button
                      type="button"
                      disabled={noReply.isPending}
                      onClick={() => noReply.mutate({ messageId: m.id, on: !m.noReplyNeeded })}
                      title={
                        m.noReplyNeeded
                          ? "Put this message back on the reply clock"
                          : "This message doesn't need a Collegepond reply: stop its reply clock"
                      }
                      className="font-semibold text-[#667085] hover:text-[#1570EF] disabled:opacity-50"
                    >
                      · {m.noReplyNeeded ? "Undo" : "No reply needed"}
                    </button>
                  )}
                  {m.canEdit && !isEditing && (
                    <button type="button" onClick={() => setEditing({ id: m.id, body: m.body ?? "" })} className="font-semibold text-[#667085] hover:text-[#1570EF]">
                      · Edit
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      {!forbidden && (
        <div
          className={`border-t px-4 py-3 ${dragging ? "border-[#1570EF] bg-[#F5F9FF]" : "border-[#E4E7EC]"}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
        >
          {filed && (
            <div className="mb-2.5 rounded-lg border border-[#ABEFC6] bg-[#ECFDF3] px-3 py-2 text-xs text-[#344054]">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-semibold text-[#027A48]">
                  Sent. {filed.filter((f) => f.label).length} of {filed.length} file{filed.length === 1 ? "" : "s"} saved to the student&apos;s documents
                </span>
                <button type="button" onClick={() => setFiled(null)} className="text-[#667085] hover:text-[#344054]" aria-label="Dismiss">
                  ×
                </button>
              </div>
              <ul className="space-y-0.5">
                {filed.map((f) => (
                  <li key={f.attachmentId}>
                    <span className="font-medium">{f.fileName}</span>{" "}
                    {f.label ? (
                      <span className="text-[#027A48]">→ Documents · {f.label}</span>
                    ) : f.error ? (
                      <span className="text-[#B42318]">→ not saved: {f.error} (sent in chat)</span>
                    ) : (
                      <span className="text-[#B54708]">→ no type picked: sent as a chat attachment only</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pending.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {pending.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] px-2.5 py-1.5 text-xs text-[#344054]">
                  <span className="min-w-0 flex-1 truncate font-medium">{p.fileName}</span>
                  <span className="text-[#98A2B3]">{sizeLabel(p.sizeBytes)}</span>
                  <select
                    value={p.docType}
                    aria-label={`Document type for ${p.fileName}`}
                    onChange={(e) => setPending((x) => x.map((y) => (y.id === p.id ? { ...y, docType: e.target.value } : y)))}
                    className={`h-7 max-w-[220px] rounded-md border px-1.5 text-xs outline-none focus:border-[#1570EF] ${p.docType ? "border-[#D0D5DD] bg-white" : "border-[#FEDF89] bg-[#FFFAEB]"}`}
                  >
                    <option value="">Other / not a student document</option>
                    {STUDENT_DOC_TYPES.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" aria-label={`Remove ${p.fileName}`} onClick={() => setPending((x) => x.filter((y) => y.id !== p.id))} className="px-1 text-[#98A2B3] hover:text-[#B42318]">
                    ×
                  </button>
                </div>
              ))}
              <p className="text-[11px] text-[#667085]">
                {typedCount > 0
                  ? `"Send and save" files ${typedCount === pending.length ? "every file" : `the ${typedCount} typed file${typedCount === 1 ? "" : "s"}`} into the student's documents${typedCount < pending.length ? "; the rest go as chat attachments only" : ""}. Check the guessed types first.`
                  : "Pick a document type to also file these into the student's documents, or just send them in chat."}
              </p>
            </div>
          )}
          <div className="flex items-end gap-2">
            <input ref={fileRef} type="file" multiple accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" className="hidden" onChange={(e) => void upload(e.target.files)} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              title="Attach files: several at once, or drag them here (PDF, DOC, DOCX, JPG, PNG; up to 10 MB each)"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg border border-[#D0D5DD] text-[#667085] hover:border-[#1570EF] hover:text-[#1570EF] disabled:opacity-50"
            >
              {uploading ? (
                <span className="text-[10px]">…</span>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              )}
            </button>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(false);
                }
              }}
              maxLength={4000}
              placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"
              rows={1}
              className="max-h-28 min-h-[38px] flex-1 resize-none rounded-lg border border-[#D0D5DD] px-3 py-2 text-sm outline-none focus:border-[#1570EF]"
            />
            {typedCount > 0 && (
              <button
                type="button"
                onClick={() => submit(true)}
                disabled={send.isPending || uploading}
                title="Send, and file each typed attachment into the student's document checklist"
                className="h-[38px] rounded-lg border border-[#1570EF] bg-white px-3 text-sm font-semibold text-[#1570EF] hover:bg-[#EFF8FF] disabled:opacity-50"
              >
                Send and save to documents
              </button>
            )}
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={(!draft.trim() && pending.length === 0) || send.isPending || uploading}
              className="h-[38px] rounded-lg bg-[#1570EF] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#1257c4] disabled:opacity-50"
            >
              {send.isPending ? "Sending…" : "Send"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-[#98A2B3]">
            Messages can be edited for 5 minutes and can&apos;t be deleted.
            {isPartner ? " Everyone on your side who works with this student sees this chat." : " The partner sees Collegepond replies under your name."}
          </p>
        </div>
      )}
    </div>
  );
}
