"use client";

import { useEffect, useRef, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  MAX_DECISION_WEEKS,
  MAX_FOLLOW_UP_DAYS_AHEAD,
  addDays,
  fmtDay,
  followUpStatus,
  type FollowUpKind,
} from "~/lib/follow-ups";

// Application follow-ups (src/server/follow-ups.ts) on an application card:
// scheduled while the application is at Application Submitted / Under
// Review, one open at a time, as many as needed. Once the application moves
// on, open ones are closed and the panel is read-only history.

const KIND_TONE: Record<FollowUpKind, string> = {
  upcoming: "bg-[#EFF8FF] text-[#175CD3]",
  today: "bg-[#FFFAEB] text-[#B54708]",
  overdue: "bg-[#FEF3F2] text-[#B42318]",
  completed: "bg-[#ECFDF3] text-[#027A48]",
  closed: "bg-[#F2F4F7] text-[#667085]",
};

const INPUT =
  "h-[32px] rounded-md border border-[#D0D5DD] bg-white px-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]";
const BTN_PRIMARY =
  "cursor-pointer rounded-md bg-[#1570EF] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#175CD3] disabled:cursor-not-allowed disabled:opacity-50";
const BTN_SECONDARY =
  "cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-50";
const LINK_BTN = "cursor-pointer text-[12px] font-semibold text-[#1570EF] hover:underline";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function FollowUpsPanel({
  applicationId,
  status,
  onToast,
}: {
  applicationId: number;
  // The card's current status: a stage change can close follow-ups.
  status: number;
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const q = api.followUps.forApplication.useQuery({ applicationId });
  const refresh = () => {
    void utils.followUps.forApplication.invalidate({ applicationId });
    void utils.followUps.overdue.invalidate();
  };
  const firstStatus = useRef(status);
  useEffect(() => {
    if (status !== firstStatus.current) {
      firstStatus.current = status;
      void utils.followUps.forApplication.invalidate({ applicationId });
    }
  }, [status, applicationId, utils]);

  // Opened from a reminder (…?tab=application&app=<id>): bring this card into view.
  const ref = useRef<HTMLDivElement>(null);
  const loaded = !!q.data;
  useEffect(() => {
    if (!loaded) return;
    const app = new URLSearchParams(window.location.search).get("app");
    if (app !== String(applicationId)) return;
    // After the rest of the tab has laid out.
    const t = setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 500);
    return () => clearTimeout(t);
  }, [loaded, applicationId]);

  const onError = (err: { message: string }) => onToast(err.message);
  const completeMut = api.followUps.complete.useMutation({
    onSuccess: (r) => {
      refresh();
      onToast(`Follow-up ${r.seq} completed`);
    },
    onError,
  });

  const d = q.data;
  if (!d) return null;
  if (!d.active && d.rows.length === 0) return null;
  const latest = d.rows[d.rows.length - 1];

  return (
    <div ref={ref} className="mt-4 rounded-[10px] border border-[#B2DDFF] bg-[#F5FAFF] px-5 py-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <div className="text-[13px] font-bold text-[#175CD3]">Follow-ups</div>
        {latest && (
          <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-[#175CD3] ring-1 ring-[#B2DDFF]">
            Follow-up {latest.seq}
          </span>
        )}
        {!d.active && (
          <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 text-[11px] font-semibold text-[#667085]">Read-only</span>
        )}
      </div>
      <DecisionLine
        applicationId={applicationId}
        data={d}
        editable={d.active}
        onSaved={() => {
          refresh();
          onToast("Expected decision time updated");
        }}
        onError={onError}
      />

      {d.rows.length > 0 && (
        <ul className="mt-3 space-y-2">
          {d.rows.map((r) => (
            <FollowUpRow
              key={r.id}
              row={r}
              today={d.today}
              editable={d.active}
              busy={completeMut.isPending}
              onComplete={() => completeMut.mutate({ followUpId: r.id })}
              onRescheduled={(seq) => {
                refresh();
                onToast(`Follow-up ${seq} moved`);
              }}
              onError={onError}
            />
          ))}
        </ul>
      )}

      {d.active ? (
        d.canSchedule ? (
          <ScheduleForm
            applicationId={applicationId}
            nextSeq={(latest?.seq ?? 0) + 1}
            today={d.today}
            expectedBy={d.expectedBy}
            onScheduled={(seq) => {
              refresh();
              onToast(`Follow-up ${seq} scheduled`);
            }}
            onError={onError}
          />
        ) : (
          <p className="mt-2.5 text-xs text-[#475467]">Tick the open follow-up done to schedule the next one.</p>
        )
      ) : (
        <p className="mt-2.5 text-xs text-[#667085]">
          The application is at {d.stage}, so follow-ups have ended.
        </p>
      )}
    </div>
  );
}

type PanelData = RouterOutputs["followUps"]["forApplication"];
type Row = PanelData["rows"][number];

// "University decision expected in N weeks · submitted <date> · due by <date>"
function DecisionLine({
  applicationId,
  data: d,
  editable,
  onSaved,
  onError,
}: {
  applicationId: number;
  data: PanelData;
  editable: boolean;
  onSaved: () => void;
  onError: (err: { message: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [weeks, setWeeks] = useState(String(d.decisionWeeks));
  const mut = api.followUps.setDecisionWeeks.useMutation({
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
    onError,
  });
  const n = Number(weeks);
  const valid = Number.isInteger(n) && n >= 1 && n <= MAX_DECISION_WEEKS;

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#344054]">
        University decision expected in
        <input
          type="number"
          min={1}
          max={MAX_DECISION_WEEKS}
          value={weeks}
          onChange={(e) => setWeeks(e.target.value)}
          aria-label="Weeks to a decision"
          className={`${INPUT} w-[70px]`}
        />
        weeks from submission
        <button
          type="button"
          disabled={!valid || mut.isPending}
          onClick={() => mut.mutate({ applicationId, weeks: n })}
          className={BTN_PRIMARY}
        >
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)} className={BTN_SECONDARY}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="text-[13px] text-[#475467]">
      University decision expected in {plural(d.decisionWeeks, "week")}
      {d.decisionWeeksIsDefault && <span className="text-[#98A2B3]"> (default)</span>}
      {" · "}
      {d.submittedOn ? `submitted ${fmtDay(d.submittedOn)}` : "submitted date not recorded"}
      {d.expectedBy && ` · due by ${fmtDay(d.expectedBy)}`}
      {editable && (
        <>
          {" "}
          <button
            type="button"
            onClick={() => {
              setWeeks(String(d.decisionWeeks));
              setEditing(true);
            }}
            className={LINK_BTN}
          >
            Change
          </button>
        </>
      )}
    </div>
  );
}

function FollowUpRow({
  row: r,
  today,
  editable,
  busy,
  onComplete,
  onRescheduled,
  onError,
}: {
  row: Row;
  today: string;
  editable: boolean;
  busy: boolean;
  onComplete: () => void;
  onRescheduled: (seq: number) => void;
  onError: (err: { message: string }) => void;
}) {
  const st = followUpStatus(r, today);
  const open = st.kind === "upcoming" || st.kind === "today" || st.kind === "overdue";
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(r.dueDate);
  const mut = api.followUps.reschedule.useMutation({
    onSuccess: (res) => {
      setEditing(false);
      onRescheduled(res.seq);
    },
    onError,
  });
  const max = addDays(today, MAX_FOLLOW_UP_DAYS_AHEAD);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-white px-3 py-2 ring-1 ring-[#E4E7EC]">
      <input
        type="checkbox"
        checked={st.kind === "completed"}
        disabled={!open || !editable || busy}
        onChange={(e) => {
          if (e.target.checked) onComplete();
        }}
        aria-label={`Follow-up ${r.seq} done`}
        title={open ? "Mark done" : undefined}
        className="h-4 w-4 cursor-pointer accent-[#12B76A] disabled:cursor-default"
      />
      <span className="text-[13px] font-semibold text-[#101828]">Follow-up {r.seq}</span>
      {editing ? (
        <span className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={date}
            min={today}
            max={max}
            onChange={(e) => setDate(e.target.value)}
            aria-label={`New date for follow-up ${r.seq}`}
            className={INPUT}
          />
          <button
            type="button"
            disabled={!date || date < today || date > max || mut.isPending}
            onClick={() => mut.mutate({ followUpId: r.id, dueDate: date })}
            className={BTN_PRIMARY}
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className={BTN_SECONDARY}>
            Cancel
          </button>
        </span>
      ) : (
        <span className={`text-[13px] ${open ? "text-[#344054]" : "text-[#667085]"}`}>{fmtDay(r.dueDate)}</span>
      )}
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${KIND_TONE[st.kind]}`}>{st.label}</span>
      {st.kind === "completed" && r.completedBy && <span className="text-[11px] text-[#667085]">by {r.completedBy}</span>}
      {st.kind === "closed" && r.closedReason && <span className="text-[11px] text-[#667085]">{r.closedReason}</span>}
      {open && editable && !editing && (
        <button
          type="button"
          onClick={() => {
            setDate(r.dueDate < today ? today : r.dueDate);
            setEditing(true);
          }}
          className={`${LINK_BTN} ml-auto`}
        >
          Change date
        </button>
      )}
    </li>
  );
}

// A date, or "in N days/weeks" after the expected decision date (or today).
function ScheduleForm({
  applicationId,
  nextSeq,
  today,
  expectedBy,
  onScheduled,
  onError,
}: {
  applicationId: number;
  nextSeq: number;
  today: string;
  expectedBy: string | null;
  onScheduled: (seq: number) => void;
  onError: (err: { message: string }) => void;
}) {
  const [mode, setMode] = useState<"relative" | "date">("relative");
  const [amount, setAmount] = useState("1");
  const [unit, setUnit] = useState<"days" | "weeks">("weeks");
  const [base, setBase] = useState<"expected" | "today">(expectedBy && expectedBy >= today ? "expected" : "today");
  const [date, setDate] = useState("");
  const mut = api.followUps.schedule.useMutation({
    onSuccess: (r) => {
      setDate("");
      onScheduled(r.seq);
    },
    onError,
  });
  const max = addDays(today, MAX_FOLLOW_UP_DAYS_AHEAD);

  const n = Number(amount);
  const from = base === "expected" && expectedBy ? expectedBy : today;
  const due =
    mode === "date" ? date : Number.isInteger(n) && n >= 0 && n <= 99 ? addDays(from, unit === "weeks" ? n * 7 : n) : "";
  const problem = !due
    ? null
    : due < today
      ? "That date has passed. Pick a later one."
      : due > max
        ? "Pick a date within a year."
        : null;

  return (
    <div className="mt-3 border-t border-[#D1E9FF] pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-semibold text-[#344054]">Schedule follow-up {nextSeq}</span>
        <div className="flex overflow-hidden rounded-md ring-1 ring-[#D0D5DD]">
          {(
            [
              ["relative", "In days / weeks"],
              ["date", "On a date"],
            ] as const
          ).map(([m, text]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`cursor-pointer px-2.5 py-1 text-[12px] font-medium ${
                mode === m ? "bg-[#1570EF] text-white" : "bg-white text-[#344054] hover:bg-[#F9FAFB]"
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#344054]">
        {mode === "date" ? (
          <input
            type="date"
            value={date}
            min={today}
            max={max}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Follow-up date"
            className={INPUT}
          />
        ) : (
          <>
            In
            <input
              type="number"
              min={0}
              max={99}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="How many"
              className={`${INPUT} w-[64px]`}
            />
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as "days" | "weeks")}
              aria-label="Days or weeks"
              className={`${INPUT} cursor-pointer`}
            >
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
            after
            <select
              value={base}
              onChange={(e) => setBase(e.target.value as "expected" | "today")}
              aria-label="Counted from"
              className={`${INPUT} cursor-pointer`}
            >
              {expectedBy && <option value="expected">the expected decision ({fmtDay(expectedBy)})</option>}
              <option value="today">today</option>
            </select>
          </>
        )}
        <button
          type="button"
          disabled={!due || !!problem || mut.isPending}
          onClick={() => mut.mutate({ applicationId, dueDate: due })}
          className={BTN_PRIMARY}
        >
          Schedule
        </button>
        {mode === "relative" && due && !problem && <span className="text-xs text-[#475467]">→ {fmtDay(due)}</span>}
      </div>
      {problem && <p className="mt-1.5 text-xs text-[#B42318]">{problem}</p>}
    </div>
  );
}
