"use client";

import { useState } from "react";
import { Modal } from "~/components/ui/modal";
import { api } from "~/trpc/react";
import {
  CALL_OUTCOMES,
  FOLLOW_UP_CHANNELS,
  PARTNER_RESPONSES,
  SHORTLIST_CLOSURE_REASONS,
  fmtIstDateTime,
  fmtWeekday,
  type FollowUpChannel,
  type FollowUpStage,
  type PartnerResponse,
  type ShortlistClosureReason,
} from "~/lib/tasks";
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL } from "./ui";

// The three shortlist follow-up stage modals (PDF page 3) and the "Partner
// confirmed" / "Reopen" dialogs, shared by My Tasks and the student page.
// Server rules: src/server/shortlist-follow-up.ts.

export type FollowUpCaseRef = {
  caseId: number;
  stage: FollowUpStage;
  studentId: number;
  studentName: string;
  partner: string;
  sharedAt: string;
  waitingWorkingDays: number;
  followUpsDone?: number;
  thenDue?: string | null; // when the next stage would fall due if still pending
};

const STAGE_CHIP: Record<FollowUpStage, { text: string; tone: string; title: string }> = {
  2: { text: "Stage 2 · First follow-up", tone: "bg-[#EFF8FF] text-[#175CD3]", title: "Record partner response" },
  3: { text: "Stage 3 · Second follow-up", tone: "bg-[#FFF6ED] text-[#C4320A]", title: "Log follow-up actions" },
  4: { text: "Stage 4 · Final follow-up", tone: "bg-[#F4F3FF] text-[#5925DC]", title: "Proceed or close the case" },
};

function useInvalidate(studentId: number) {
  const utils = api.useUtils();
  return () =>
    Promise.all([
      utils.tasks.myDay.invalidate(),
      utils.tasks.followUps.invalidate(),
      utils.tasks.list.invalidate(),
      utils.tasks.badge.invalidate(),
      utils.shortlistFollowUp.panel.invalidate({ studentId }),
      utils.shortlistFollowUp.studentTasks.invalidate({ studentId }),
      utils.students.adminGet.invalidate({ id: studentId }),
    ]);
}

function Radio({
  checked,
  onChange,
  title,
  hint,
  danger,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  hint: string;
  danger?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition ${
        checked ? (danger ? "border-[#D92D20] bg-[#FEF3F2]/40 ring-1 ring-[#D92D20]" : "border-[#1570EF] bg-[#F5FAFF] ring-1 ring-[#1570EF]") : "border-[#E4E7EC] hover:border-[#98A2B3]"
      }`}
    >
      <input type="radio" checked={checked} onChange={onChange} className="mt-0.5 h-4 w-4 accent-[#1570EF]" />
      <span>
        <span className="block text-[14px] font-semibold text-[#101828]">{title}</span>
        <span className="block text-[12px] text-[#667085]">{hint}</span>
      </span>
    </label>
  );
}

function Header({ c }: { c: FollowUpCaseRef }) {
  const chip = STAGE_CHIP[c.stage];
  return (
    <div className="-mt-1 border-b border-[#F2F4F7] pb-3">
      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${chip.tone}`}>{chip.text}</span>
      <div className="mt-2 text-[13px] text-[#475467]">
        {c.studentName} · CP-{c.studentId} · {c.partner}
      </div>
      <div className="text-[12px] text-[#667085]">
        {c.stage === 2
          ? `Shortlist shared ${fmtIstDateTime(c.sharedAt)}`
          : c.stage === 3
            ? `No confirmation for ${c.waitingWorkingDays} working day${c.waitingWorkingDays === 1 ? "" : "s"}`
            : `${c.followUpsDone ?? 2} follow-up${(c.followUpsDone ?? 2) === 1 ? "" : "s"} since ${fmtIstDateTime(c.sharedAt)} · no confirmation`}
      </div>
    </div>
  );
}

export function RecordFollowUpModal({
  c,
  onClose,
  onDone,
}: {
  c: FollowUpCaseRef;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const invalidate = useInvalidate(c.studentId);
  const [response, setResponse] = useState<PartnerResponse>("pending");
  const [comments, setComments] = useState("");
  const [channels, setChannels] = useState<FollowUpChannel[]>([]);
  const [callTime, setCallTime] = useState("");
  const [callOutcome, setCallOutcome] = useState<string>(CALL_OUTCOMES[0]);
  const [decision, setDecision] = useState<"proceed" | "close" | null>(null);
  const [closure, setClosure] = useState<ShortlistClosureReason | "">("");
  const [error, setError] = useState("");
  const record = api.shortlistFollowUp.record.useMutation({
    onSuccess: async (r) => {
      await invalidate();
      onDone(
        r.outcome === "confirmed"
          ? "Partner confirmed: follow-ups stopped and a Begin application task was added"
          : r.outcome === "closed"
            ? "Case closed at shortlisting"
            : r.outcome === "ended"
              ? "Follow-ups stopped: edit and re-share the shortlist"
              : `Saved. Next follow-up ${"nextDue" in r && r.nextDue ? fmtWeekday(r.nextDue) : ""}`,
      );
    },
    onError: (e) => setError(e.message),
  });

  const toggle = (ch: FollowUpChannel) =>
    setChannels((cur) => (cur.includes(ch) ? cur.filter((x) => x !== ch) : [...cur, ch]));

  const submit = () => {
    setError("");
    if (c.stage === 4) {
      if (!decision) return setError("Choose Proceed further or Close case.");
      if (decision === "close" && !closure) return setError("Choose a closure reason.");
      if (decision === "close" && closure === "other" && !comments.trim()) return setError("Add a comment for Other.");
      record.mutate({ caseId: c.caseId, stage: 4, decision, closureReason: closure || undefined, comments: comments.trim() || null });
      return;
    }
    if (c.stage === 3 && channels.length === 0) return setError("Pick at least one: call, email or WhatsApp.");
    if ((c.stage === 3 || response === "pending") && !comments.trim()) {
      return setError(c.stage === 3 ? "Add comments on the follow-up." : "Say why confirmation is pending.");
    }
    record.mutate({
      caseId: c.caseId,
      stage: c.stage,
      response,
      channels: c.stage === 3 ? channels : undefined,
      callTime: channels.includes("call") ? callTime || null : null,
      callOutcome: channels.includes("call") ? callOutcome : null,
      comments: comments.trim() || null,
    });
  };

  const closing = c.stage === 4 && decision === "close";
  return (
    <Modal
      open
      title={STAGE_CHIP[c.stage].title}
      onClose={onClose}
      width="w-[460px]"
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={closing ? BTN_DANGER : BTN_PRIMARY} disabled={record.isPending} onClick={submit}>
            {record.isPending ? "Saving…" : closing ? "Close case" : c.stage === 4 && decision === "proceed" ? "Proceed further" : "Save follow-up"}
          </button>
        </>
      }
    >
      <Header c={c} />
      {c.stage === 2 && (
        <>
          <div className="text-[13px] font-semibold text-[#344054]">Partner response</div>
          <div className="space-y-2">
            {PARTNER_RESPONSES.map((r) => (
              <Radio key={r.code} checked={response === r.code} onChange={() => setResponse(r.code)} title={r.label} hint={r.hint} />
            ))}
          </div>
          <div>
            <label className={LABEL}>
              {response === "pending" ? "Why is confirmation pending?" : "Comments"}
              {response === "pending" && <span className="text-[#D92D20]"> *</span>}
            </label>
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={3} maxLength={1000} className={INPUT} />
          </div>
          {response === "pending" && (
            <div className="rounded-lg bg-[#F2F4F7] px-3 py-2 text-[12px] text-[#475467]">
              If still pending, the second follow-up is scheduled for{" "}
              <b>{c.thenDue ? fmtWeekday(c.thenDue) : "3 working days later"}</b>.
            </div>
          )}
        </>
      )}
      {c.stage === 3 && (
        <>
          <div className="text-[13px] font-semibold text-[#344054]">
            How did you follow up? <span className="text-[#D92D20]">*</span>{" "}
            <span className="font-normal text-[#667085]">Pick at least one</span>
          </div>
          <div className="space-y-2">
            {FOLLOW_UP_CHANNELS.map((ch) => {
              const on = channels.includes(ch.code);
              return (
                <div key={ch.code} className={`rounded-lg border px-4 py-3 ${on ? "border-[#1570EF] bg-[#F5FAFF] ring-1 ring-[#1570EF]" : "border-[#E4E7EC]"}`}>
                  <label className="flex cursor-pointer items-center gap-3">
                    <input type="checkbox" checked={on} onChange={() => toggle(ch.code)} className="h-4 w-4 accent-[#1570EF]" />
                    <span className="text-[14px] font-semibold text-[#101828]">{ch.label}</span>
                  </label>
                  {on && ch.code === "call" && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <div className="mb-1 text-[11px] text-[#667085]">Time</div>
                        <input type="time" value={callTime} onChange={(e) => setCallTime(e.target.value)} className={INPUT} />
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] text-[#667085]">Outcome</div>
                        <select value={callOutcome} onChange={(e) => setCallOutcome(e.target.value)} className={INPUT}>
                          {CALL_OUTCOMES.map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div>
            <label className={LABEL}>Partner response</label>
            <select value={response} onChange={(e) => setResponse(e.target.value as PartnerResponse)} className={INPUT}>
              {PARTNER_RESPONSES.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.code === "pending" ? "No confirmation yet" : r.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL}>
              Comments <span className="text-[#D92D20]">*</span>
            </label>
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={3} maxLength={1000} className={INPUT} />
          </div>
          <div className="text-[12px] text-[#667085]">
            Logged in the follow-up history only: Converge doesn&apos;t message the partner.
          </div>
        </>
      )}
      {c.stage === 4 && (
        <>
          <div className="text-[13px] font-semibold text-[#344054]">
            Decision <span className="text-[#D92D20]">*</span>
          </div>
          <div className="space-y-2">
            <Radio
              checked={decision === "proceed"}
              onChange={() => setDecision("proceed")}
              title="Proceed further"
              hint="Partner has confirmed. Student moves to the application process."
            />
            <Radio
              checked={decision === "close"}
              onChange={() => setDecision("close")}
              title="Close case"
              hint="Closes at the shortlisting stage. Reason required."
              danger
            />
          </div>
          {decision === "close" && (
            <div>
              <label className={LABEL}>
                Closure reason <span className="text-[#D92D20]">*</span>
              </label>
              <select value={closure} onChange={(e) => setClosure(e.target.value as ShortlistClosureReason)} className={INPUT}>
                <option value="">Select a reason</option>
                {SHORTLIST_CLOSURE_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={LABEL}>Comments</label>
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={3} maxLength={1000} className={INPUT} />
          </div>
          {decision === "close" && (
            <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-[12px] text-[#912018]">
              Closing cancels open follow-up tasks and sets the student to <b>Closed – Shortlisting</b>. Reopen it
              (or reactivate the student) if the partner comes back.
            </div>
          )}
          {decision === "proceed" && (
            <div className="rounded-lg bg-[#ECFDF3] px-3 py-2 text-[12px] text-[#067647]">
              Universities still awaiting the partner are approved on the partner&apos;s behalf, so you can Apply. A
              Begin application task is added to your list.
            </div>
          )}
        </>
      )}
      {error && <div className="text-[13px] text-[#B42318]">{error}</div>}
    </Modal>
  );
}

export function ConfirmPartnerModal({
  caseId,
  studentId,
  studentName,
  onClose,
  onDone,
}: {
  caseId: number;
  studentId: number;
  studentName: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const invalidate = useInvalidate(studentId);
  const [comments, setComments] = useState("");
  const [error, setError] = useState("");
  const m = api.shortlistFollowUp.confirm.useMutation({
    onSuccess: async () => {
      await invalidate();
      onDone("Partner confirmed: follow-ups stopped and a Begin application task was added");
    },
    onError: (e) => setError(e.message),
  });
  return (
    <Modal
      open
      title="Partner confirmed the shortlist"
      onClose={onClose}
      width="w-[460px]"
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={m.isPending} onClick={() => m.mutate({ caseId, comments: comments.trim() || null })}>
            {m.isPending ? "Saving…" : "Partner confirmed"}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-[#475467]">
        Record that the partner confirmed {studentName}&apos;s shortlist (by phone, email…). Open follow-ups stop, the
        universities still awaiting the partner are approved on their behalf so you can Apply, and a Begin application
        task is added.
      </p>
      <div>
        <label className={LABEL}>How did they confirm?</label>
        <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={3} maxLength={1000} className={INPUT} placeholder="e.g. Tanvi confirmed on a call at 3 PM" />
      </div>
      {error && <div className="text-[13px] text-[#B42318]">{error}</div>}
    </Modal>
  );
}

export function ReopenCaseModal({
  caseId,
  studentId,
  onClose,
  onDone,
}: {
  caseId: number;
  studentId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const invalidate = useInvalidate(studentId);
  const [comments, setComments] = useState("");
  const [error, setError] = useState("");
  const m = api.shortlistFollowUp.reopen.useMutation({
    onSuccess: async (r) => {
      await invalidate();
      onDone(`Case reopened. First follow-up ${fmtWeekday(r.nextDue)}`);
    },
    onError: (e) => setError(e.message),
  });
  return (
    <Modal
      open
      title="Reopen the case"
      onClose={onClose}
      width="w-[460px]"
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={m.isPending} onClick={() => m.mutate({ caseId, comments: comments.trim() || null })}>
            {m.isPending ? "Reopening…" : "Reopen"}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-[#475467]">
        The partner came back. The follow-up schedule restarts from today and the student is reactivated if the case
        closure made them inactive.
      </p>
      <div>
        <label className={LABEL}>Note</label>
        <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={3} maxLength={1000} className={INPUT} />
      </div>
      {error && <div className="text-[13px] text-[#B42318]">{error}</div>}
    </Modal>
  );
}
