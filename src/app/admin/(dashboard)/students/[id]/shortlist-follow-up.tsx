"use client";

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { fmtMinutes } from "~/lib/tat";
import {
  followUpChannelLabel,
  fmtIstDateTime,
  fmtWeekday,
  type FollowUpStage,
} from "~/lib/tasks";
import { ConfirmPartnerModal, RecordFollowUpModal, ReopenCaseModal, type FollowUpCaseRef } from "~/components/tasks/follow-up-modals";
import { TaskTable } from "~/components/tasks/task-table";
import { CreateTaskModal } from "~/components/tasks/create-task-modal";
import { BTN_PRIMARY, BTN_SECONDARY, Empty, PhaseBadge } from "~/components/tasks/ui";

// The student's partner-confirmation follow-up (PDF page 2): the stepper and
// this round's history on the Application tab, and the full Follow-up
// History tab (every round, shortlisting TAT milestones, the student's
// tasks). Rules: src/server/shortlist-follow-up.ts.

type Panel = RouterOutputs["shortlistFollowUp"]["panel"];
type History = Panel["history"][number];

const EVENT_TITLE: Record<string, string> = {
  shared: "Shortlist shared with partner",
  schools_added: "More universities shared",
  task_created: "Follow-up task created",
  stage_recorded: "Follow-up recorded",
  confirmed: "Partner confirmed",
  closed: "Case closed at shortlisting",
  ended: "Follow-ups stopped",
  reopened: "Case reopened",
};

function HistoryList({ rows }: { rows: History[] }) {
  if (rows.length === 0) return <div className="py-3 text-[13px] text-[#98A2B3]">Nothing recorded yet.</div>;
  return (
    <div className="divide-y divide-[#F2F4F7]">
      {rows.map((e) => (
        <div key={e.id} className="grid grid-cols-[110px_1fr] gap-4 py-3">
          <div className="text-[12px] text-[#667085]">{fmtIstDateTime(e.at)}</div>
          <div className="text-[13px] text-[#344054]">
            <b className="text-[#101828]">
              {e.kind === "stage_recorded" || e.kind === "task_created" ? `${e.stageLabel ?? "Follow-up"} ${e.kind === "task_created" ? "task created" : "recorded"}` : (EVENT_TITLE[e.kind] ?? e.kind)}
            </b>
            {e.by && <span className="text-[#667085]"> by {e.by}</span>}
            {e.detail && <span className="text-[#667085]"> · {e.detail}</span>}
            {(!!e.responseLabel || e.channels.length > 0) && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {e.responseLabel && (
                  <span className="rounded-md bg-[#FFFAEB] px-2 py-0.5 text-[11px] font-semibold text-[#B54708]">Response: {e.responseLabel}</span>
                )}
                {e.channels.map((ch) => (
                  <span key={ch} className="rounded-md bg-[#F2F4F7] px-2 py-0.5 text-[11px] font-semibold text-[#475467]">
                    {followUpChannelLabel(ch)}
                    {ch === "call" && (e.callTime || e.callOutcome) ? ` · ${[e.callTime, e.callOutcome].filter(Boolean).join(" · ")}` : ""}
                  </span>
                ))}
              </div>
            )}
            {e.comments && <div className="mt-1.5 rounded-lg bg-[#F9FAFB] px-3 py-2 text-[13px] text-[#344054]">{e.comments}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Step({ state, title, lines }: { state: "done" | "current" | "todo" | "closed"; title: string; lines: string[] }) {
  const circle =
    state === "done"
      ? "border-[#079455] bg-[#079455] text-white"
      : state === "closed"
        ? "border-[#D92D20] bg-[#D92D20] text-white"
        : state === "current"
          ? "border-[#1570EF] bg-white text-[#1570EF]"
          : "border-[#D0D5DD] bg-white";
  const color = state === "done" ? "text-[#067647]" : state === "current" ? "text-[#1570EF]" : state === "closed" ? "text-[#B42318]" : "text-[#475467]";
  return (
    <div className="min-w-[120px] flex-1">
      <div className="flex items-center">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-[12px] font-bold ${circle}`}>
          {state === "done" ? "✓" : state === "closed" ? "✕" : state === "current" ? "●" : ""}
        </span>
        <span className={`mx-1 h-0.5 flex-1 ${state === "done" ? "bg-[#079455]" : "bg-[#E4E7EC]"}`} />
      </div>
      <div className={`mt-2 text-[13px] font-semibold ${color}`}>{title}</div>
      {lines.map((l, i) => (
        <div key={i} className="text-[11px] text-[#667085]">
          {l}
        </div>
      ))}
    </div>
  );
}

export function ShortlistFollowUpPanel({ studentId, studentName, onToast }: { studentId: number; studentName: string; onToast: (m: string) => void }) {
  const q = api.shortlistFollowUp.panel.useQuery({ studentId });
  const [recording, setRecording] = useState<FollowUpCaseRef | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reopening, setReopening] = useState(false);
  const p = q.data;
  const c = p?.current;
  if (!p || !c) return null;
  const caseHistory = p.history.filter((e) => e.caseId === c.id);
  const ref: FollowUpCaseRef = {
    caseId: c.id,
    stage: c.nextStage as FollowUpStage,
    studentId,
    studentName,
    partner: p.partnerName,
    sharedAt: c.sharedAt,
    waitingWorkingDays: c.waitingWorkingDays,
    followUpsDone: c.stages.filter((s) => s.recordedAt).length,
    thenDue: c.schedule[1]?.due ?? null,
  };
  const outcomeState = c.status === 1 ? "done" : c.status === 2 ? "closed" : c.open ? "todo" : "closed";
  const shared = caseHistory.find((e) => e.kind === "shared");
  return (
    <div className="mb-6 rounded-[14px] border border-[#E4E7EC] bg-white px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-bold text-[#101828]">Partner confirmation follow-up</h3>
            <PhaseBadge phase={c.phase} label={c.phaseLabel} />
          </div>
          <p className="mt-0.5 text-[13px] text-[#475467]">
            Shortlist shared <b>{fmtIstDateTime(c.sharedAt, true)}</b> with {p.partnerName}
            {c.open ? (
              <>
                {" "}
                · waiting <b>{c.waitingWorkingDays} working day{c.waitingWorkingDays === 1 ? "" : "s"}</b> · next follow-up{" "}
                <b>{fmtWeekday(c.nextDue)}</b>
              </>
            ) : (
              <>
                {" "}
                · <b>{c.outcomeLabel}</b> {c.outcomeAt && <>on {fmtIstDateTime(c.outcomeAt)}</>}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {c.open && p.canAct && (
            <>
              <button type="button" className="cursor-pointer rounded-lg border border-[#079455] bg-white px-4 py-2 text-[13px] font-semibold text-[#067647] hover:bg-[#ECFDF3]" onClick={() => setConfirming(true)}>
                Partner confirmed
              </button>
              <button type="button" className={BTN_PRIMARY} onClick={() => setRecording(ref)}>
                Record follow-up
              </button>
            </>
          )}
          {c.canReopen && (
            <button type="button" className={BTN_SECONDARY} onClick={() => setReopening(true)}>
              Reopen case
            </button>
          )}
        </div>
      </div>

      <div className="mt-5 flex gap-1 overflow-x-auto pb-1">
        <Step state="done" title="Shortlist shared" lines={[fmtIstDateTime(c.sharedAt), ...(shared?.detail ? [shared.detail] : [])]} />
        <Step state="done" title="Awaiting partner confirmation" lines={["Response timer started"]} />
        {c.stages.map((s) => {
          const sched = c.schedule.find((x) => x.stage === s.stage);
          const state = s.recordedAt ? "done" : c.open && c.nextStage === s.stage ? "current" : "todo";
          const lines = s.recordedAt
            ? [`${fmtWeekday(s.recordedAt.slice(0, 10))} · done`, `Response: ${s.responseLabel ?? "—"}`]
            : sched
              ? [`Due ${fmtWeekday(sched.due)}`, s.stage === 2 ? "Record response" : s.stage === 3 ? "Call · email · WhatsApp" : "Proceed or close case"]
              : ["—"];
          return <Step key={s.stage} state={state} title={s.label} lines={lines} />;
        })}
        <Step state={outcomeState} title="Confirmed / Closed" lines={c.open ? ["Workflow stops here"] : [c.outcomeLabel ?? ""]} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_300px]">
        <div>
          <h4 className="mb-1 text-[14px] font-semibold text-[#101828]">Follow-up history</h4>
          <HistoryList rows={caseHistory} />
        </div>
        {c.open && c.schedule.length > 0 && (
          <div className="h-fit rounded-xl border border-[#E4E7EC] bg-[#F9FAFB] px-4 py-3 text-[13px] text-[#344054]">
            <div className="mb-2 font-semibold text-[#101828]">Upcoming, if the partner stays silent</div>
            {c.schedule.map((s) => (
              <p key={s.stage} className="mb-1.5">
                <b>{fmtWeekday(s.due)}</b> —{" "}
                {s.stage === 2
                  ? "First follow-up task. Record the response or why it's pending."
                  : s.stage === 3
                    ? "Second follow-up task. Must log call, email and/or WhatsApp."
                    : "Final follow-up. Choose Proceed further or Close case with a reason."}
              </p>
            ))}
            <div className="mt-2 border-t border-[#E4E7EC] pt-2 text-[12px] text-[#667085]">
              Marking the partner as confirmed at any stage cancels open follow-ups and moves {studentName} to Begin
              Application.
            </div>
          </div>
        )}
        {!c.open && c.closureNote && (
          <div className="h-fit rounded-xl border border-[#FECDCA] bg-[#FEF3F2] px-4 py-3 text-[13px] text-[#912018]">{c.closureNote}</div>
        )}
      </div>

      {recording && (
        <RecordFollowUpModal
          c={recording}
          onClose={() => setRecording(null)}
          onDone={(m) => {
            setRecording(null);
            onToast(m);
          }}
        />
      )}
      {confirming && (
        <ConfirmPartnerModal
          caseId={c.id}
          studentId={studentId}
          studentName={studentName}
          onClose={() => setConfirming(false)}
          onDone={(m) => {
            setConfirming(false);
            onToast(m);
          }}
        />
      )}
      {reopening && (
        <ReopenCaseModal
          caseId={c.id}
          studentId={studentId}
          onClose={() => setReopening(false)}
          onDone={(m) => {
            setReopening(false);
            onToast(m);
          }}
        />
      )}
    </div>
  );
}

const MILESTONES: { key: keyof RouterOutputs["shortlistFollowUp"]["milestones"]["milestones"]; label: string; manual?: "review_completed_at" | "docs_verified_at" | "shortlisting_completed_at"; hint?: string }[] = [
  { key: "added", label: "Student added by partner" },
  { key: "assigned", label: "Assigned to counsellor" },
  { key: "reviewStarted", label: "Profile review started", hint: "when the assigned counsellor first opened the profile" },
  { key: "reviewCompleted", label: "Profile review completed", manual: "review_completed_at" },
  { key: "docsVerified", label: "Documents verified", manual: "docs_verified_at" },
  { key: "shortlistingStarted", label: "Shortlisting started", hint: "first university shortlisted" },
  { key: "shortlistingCompleted", label: "Shortlisting completed", manual: "shortlisting_completed_at" },
  { key: "shared", label: "Shortlist shared with partner" },
  { key: "confirmed", label: "Partner confirmation received" },
];

export function FollowUpHistoryTab({
  studentId,
  studentName,
  onToast,
}: {
  studentId: number;
  studentName: string;
  onToast: (m: string) => void;
}) {
  const utils = api.useUtils();
  const panel = api.shortlistFollowUp.panel.useQuery({ studentId });
  const ms = api.shortlistFollowUp.milestones.useQuery({ studentId });
  const tasks = api.shortlistFollowUp.studentTasks.useQuery({ studentId });
  const me = api.authSession.me.useQuery().data;
  const [creating, setCreating] = useState(false);
  const mark = api.shortlistFollowUp.markMilestone.useMutation({
    onSuccess: async () => {
      await utils.shortlistFollowUp.milestones.invalidate({ studentId });
      onToast("Milestone saved");
    },
    onError: (e) => onToast(e.message),
  });
  const canMark = me?.role === 0 || me?.role === 3 || me?.role === 4;
  const m = ms.data;
  return (
    <div className="space-y-6">
      <div className="rounded-[14px] border border-[#E4E7EC] bg-white px-6 py-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-[15px] font-bold text-[#101828]">Shortlisting TAT</h3>
            <p className="text-[12px] text-[#667085]">Student added → shortlist shared, weekend hours not counted.</p>
          </div>
          {m && (
            <div className="text-right">
              <div className={`text-xl font-bold ${m.status === "Breached" ? "text-[#B42318]" : m.status === "Warning" ? "text-[#B54708]" : "text-[#067647]"}`}>
                {fmtMinutes(m.elapsedMinutes)}
                {!m.shared && <span className="text-[12px] font-normal text-[#667085]"> so far</span>}
              </div>
              {m.slaMinutes !== null && (
                <div className="text-[11px] text-[#667085]">
                  SLA {fmtMinutes(m.slaMinutes)} · {m.status}
                </div>
              )}
            </div>
          )}
        </div>
        {m && (
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {MILESTONES.map((x) => {
              const at = m.milestones[x.key];
              return (
                <div key={x.key} className="flex items-start justify-between gap-2 rounded-lg border border-[#F2F4F7] px-3 py-2">
                  <div>
                    <div className="text-[12px] font-semibold text-[#344054]">{x.label}</div>
                    <div className={`text-[12px] ${at ? "text-[#101828]" : "text-[#98A2B3]"}`}>{at ? fmtIstDateTime(at, true) : x.hint ?? "—"}</div>
                  </div>
                  {x.manual && canMark && (
                    <button
                      type="button"
                      disabled={mark.isPending}
                      onClick={() => mark.mutate({ studentId, field: x.manual!, clear: !!at })}
                      className="cursor-pointer text-[11px] font-semibold whitespace-nowrap text-[#1570EF] hover:underline disabled:opacity-50"
                    >
                      {at ? "Undo" : "Mark now"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-[14px] border border-[#E4E7EC] bg-white px-6 py-5">
        <h3 className="mb-1 text-[15px] font-bold text-[#101828]">Partner confirmation follow-ups</h3>
        <p className="mb-2 text-[12px] text-[#667085]">Every round, newest first.</p>
        {panel.data ? <HistoryList rows={panel.data.history} /> : <Empty>Loading…</Empty>}
      </div>

      <div className="rounded-[14px] border border-[#E4E7EC] bg-white">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h3 className="text-[15px] font-bold text-[#101828]">Tasks</h3>
            <p className="text-[12px] text-[#667085]">Everyone&apos;s tasks on {studentName}, including automatic ones.</p>
          </div>
          {canMark && (
            <button type="button" className={BTN_SECONDARY} onClick={() => setCreating(true)}>
              + Create task
            </button>
          )}
        </div>
        {tasks.data ? <TaskTable tasks={tasks.data.tasks} today={tasks.data.today} showAssignee onToast={onToast} empty="No tasks on this student." /> : <Empty>Loading…</Empty>}
      </div>
      {creating && tasks.data && (
        <CreateTaskModal
          today={tasks.data.today}
          student={{ id: studentId, name: studentName, partner: panel.data?.partnerName ?? "" }}
          onClose={() => setCreating(false)}
          onDone={(msg) => {
            setCreating(false);
            onToast(msg);
          }}
        />
      )}
    </div>
  );
}
