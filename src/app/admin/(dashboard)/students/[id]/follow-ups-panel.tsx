"use client";

import { useEffect, useRef, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  DEPOSIT_FOLLOW_UP_DAYS_BEFORE,
  MAX_DECISION_WEEKS,
  MAX_FOLLOW_UP_DAYS_AHEAD,
  MAX_FOLLOW_UP_REMARKS,
  MAX_RESPOND_WITHIN_DAYS,
  addDays,
  fmtDay,
  followUpStatus,
  type FollowUpKind,
  type FollowUpState,
} from "~/lib/follow-ups";

// Application follow-ups (src/server/follow-ups.ts) on an application card,
// one section per kind:
//   University decision  Submitted / Under Review: scheduled by hand, one
//                        open at a time, as many as needed.
//   Deposit              Unconditional Offer: set automatically 7 days before
//                        the deposit deadline (Deposit Details below).
//   Visa file            Deposit Paid / Visa Filed: scheduled by hand with the
//                        partner's response days and remarks, then weekly
//                        until the visa is in.
// Once the application leaves a kind's stages, its open follow-ups are closed
// and that section is read-only history.

const STATE_TONE: Record<FollowUpState, string> = {
  upcoming: "bg-[#EFF8FF] text-[#175CD3]",
  today: "bg-[#FFFAEB] text-[#B54708]",
  overdue: "bg-[#FEF3F2] text-[#B42318]",
  completed: "bg-[#ECFDF3] text-[#027A48]",
  closed: "bg-[#F2F4F7] text-[#667085]",
};

const NOUN: Record<FollowUpKind, string> = {
  decision: "Follow-up",
  deposit: "Deposit follow-up",
  visa: "Visa follow-up",
};

const INPUT =
  "h-[32px] rounded-md border border-[#D0D5DD] bg-white px-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]";
const BTN_PRIMARY =
  "cursor-pointer rounded-md bg-[#1570EF] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#175CD3] disabled:cursor-not-allowed disabled:opacity-50";
const BTN_SECONDARY =
  "cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-50";
const LINK_BTN = "cursor-pointer text-[12px] font-semibold text-[#1570EF] hover:underline";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type PanelData = RouterOutputs["followUps"]["forApplication"];
type Section = PanelData["sections"][number];
type Row = Section["rows"][number];

export function FollowUpsPanel({
  applicationId,
  status,
  onToast,
}: {
  applicationId: number;
  // The card's current status: a stage change can close or create follow-ups.
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
      onToast(
        r.next
          ? `${NOUN[r.kind]} ${r.seq} done · next one ${fmtDay(r.next.dueDate)}`
          : `${NOUN[r.kind]} ${r.seq} completed`,
      );
    },
    onError,
  });

  const d = q.data;
  if (!d) return null;
  if (d.sections.length === 0) return null;

  return (
    <div ref={ref} className="mt-4 rounded-[10px] border border-[#B2DDFF] bg-[#F5FAFF] px-5 py-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <div className="text-[13px] font-bold text-[#175CD3]">Follow-ups</div>
        {!d.active && (
          <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 text-[11px] font-semibold text-[#667085]">Read-only</span>
        )}
      </div>
      <div className="divide-y divide-[#D1E9FF]">
        {d.sections.map((s) => (
          <KindSection
            key={s.kind}
            applicationId={applicationId}
            data={d}
            section={s}
            completing={completeMut.isPending}
            onComplete={(id) => completeMut.mutate({ followUpId: id })}
            onChanged={(msg) => {
              refresh();
              onToast(msg);
            }}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}

function KindSection({
  applicationId,
  data: d,
  section: s,
  completing,
  onComplete,
  onChanged,
  onError,
}: {
  applicationId: number;
  data: PanelData;
  section: Section;
  completing: boolean;
  onComplete: (id: number) => void;
  onChanged: (msg: string) => void;
  onError: (err: { message: string }) => void;
}) {
  const latest = s.rows[s.rows.length - 1];
  const anyOpen = s.rows.some((r) => !r.completedOn && !r.closedOn);
  return (
    <section className="py-3 first:pt-2 last:pb-0" aria-label={`${s.label} follow-ups`}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[#175CD3] ring-1 ring-[#B2DDFF]">
          {s.label}
        </span>
        {latest && <span className="text-[11px] font-semibold text-[#475467]">{NOUN[s.kind]} {latest.seq}</span>}
      </div>

      {s.kind === "decision" && (
        <DecisionLine
          applicationId={applicationId}
          data={d}
          editable={s.active}
          onSaved={() => onChanged("Expected decision time updated")}
          onError={onError}
        />
      )}
      {s.kind === "deposit" && s.active && (
        <p className="text-[13px] text-[#475467]">
          {d.depositDeadline
            ? `Deposit deadline ${fmtDay(d.depositDeadline)}: a follow-up is set automatically ${DEPOSIT_FOLLOW_UP_DAYS_BEFORE} days before it, and moves when the deadline changes. It closes by itself at Deposit Paid.`
            : `Set the deposit deadline in Deposit Details: a follow-up is created ${DEPOSIT_FOLLOW_UP_DAYS_BEFORE} days before it.`}
        </p>
      )}
      {s.kind === "visa" && s.active && (
        <p className="text-[13px] text-[#475467]">
          {d.visaUploaded
            ? "The visa (or refusal) is uploaded, so visa file follow-ups have ended."
            : "Chase the partner for the visa file every week, until the visa is uploaded or the outcome is recorded."}
        </p>
      )}

      {s.rows.length > 0 && (
        <ul className="mt-2.5 space-y-2">
          {s.rows.map((r) => (
            <FollowUpRow
              key={r.id}
              row={r}
              today={d.today}
              editable={s.active}
              busy={completing}
              onComplete={() => onComplete(r.id)}
              onRescheduled={(seq) => onChanged(`${NOUN[s.kind]} ${seq} updated`)}
              onError={onError}
            />
          ))}
        </ul>
      )}

      {s.active ? (
        // Deposit follow-ups come from the deadline: adding one by hand is
        // only offered once the automatic one is done.
        s.canSchedule && !(s.kind === "deposit" && s.rows.length === 0) ? (
          s.kind === "visa" ? (
            <VisaScheduleForm
              applicationId={applicationId}
              nextSeq={(latest?.seq ?? 0) + 1}
              today={d.today}
              last={latest ?? null}
              onScheduled={(seq) => onChanged(`${NOUN.visa} ${seq} scheduled`)}
              onError={onError}
            />
          ) : (
            <ScheduleForm
              applicationId={applicationId}
              kind={s.kind}
              nextSeq={(latest?.seq ?? 0) + 1}
              today={d.today}
              expectedBy={s.kind === "decision" ? d.expectedBy : null}
              onScheduled={(seq) => onChanged(`${NOUN[s.kind]} ${seq} scheduled`)}
              onError={onError}
            />
          )
        ) : anyOpen ? (
          <p className="mt-2.5 text-xs text-[#475467]">
            {s.kind === "visa"
              ? "The next weekly follow-up is set automatically when the open one is done or falls due."
              : s.kind === "deposit"
                ? "Tick the deposit follow-up done once you've checked with the partner."
                : "Tick the open follow-up done to schedule the next one."}
          </p>
        ) : null
      ) : (
        <p className="mt-2.5 text-xs text-[#667085]">
          The application is at {d.stage}, so {s.label.toLowerCase()} follow-ups have ended.
        </p>
      )}
    </section>
  );
}

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
  const open = st.state === "upcoming" || st.state === "today" || st.state === "overdue";
  const visa = r.kind === "visa";
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(r.dueDate);
  const [days, setDays] = useState(String(r.respondWithinDays ?? ""));
  const [remarks, setRemarks] = useState(r.remarks ?? "");
  const mut = api.followUps.reschedule.useMutation({
    onSuccess: (res) => {
      setEditing(false);
      onRescheduled(res.seq);
    },
    onError,
  });
  const max = addDays(today, MAX_FOLLOW_UP_DAYS_AHEAD);
  const n = Number(days);
  const daysValid = Number.isInteger(n) && n >= 1 && n <= MAX_RESPOND_WITHIN_DAYS;
  const noun = `${NOUN[r.kind]} ${r.seq}`;

  return (
    <li className="rounded-lg bg-white px-3 py-2 ring-1 ring-[#E4E7EC]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <input
          type="checkbox"
          checked={st.state === "completed"}
          disabled={!open || !editable || busy}
          onChange={(e) => {
            if (e.target.checked) onComplete();
          }}
          aria-label={`${noun} done`}
          title={open ? "Mark done" : undefined}
          className="h-4 w-4 cursor-pointer accent-[#12B76A] disabled:cursor-default"
        />
        <span className="text-[13px] font-semibold text-[#101828]">{noun}</span>
        {!editing && (
          <span className={`text-[13px] ${open ? "text-[#344054]" : "text-[#667085]"}`}>{fmtDay(r.dueDate)}</span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATE_TONE[st.state]}`}>{st.label}</span>
        {r.auto && <span className="text-[11px] text-[#667085]">{r.kind === "deposit" ? "auto, from the deadline" : "auto, weekly"}</span>}
        {st.state === "completed" && r.completedBy && <span className="text-[11px] text-[#667085]">by {r.completedBy}</span>}
        {st.state === "closed" && r.closedReason && <span className="text-[11px] text-[#667085]">{r.closedReason}</span>}
        {open && !editing && (
          <span className="ml-auto flex items-center gap-3">
            <a
              href={`/api/admin/follow-ups/${r.id}/ics`}
              download
              className={LINK_BTN}
              title="Download an .ics file for Google Calendar, Outlook or Apple Calendar"
            >
              Add to calendar
            </a>
            {editable && (
              <button
                type="button"
                onClick={() => {
                  setDate(r.dueDate < today ? today : r.dueDate);
                  setDays(String(r.respondWithinDays ?? ""));
                  setRemarks(r.remarks ?? "");
                  setEditing(true);
                }}
                className={LINK_BTN}
              >
                {visa ? "Edit" : "Change date"}
              </button>
            )}
          </span>
        )}
      </div>
      {visa && !editing && (r.respondBy ?? r.remarks) && (
        <div className="mt-1 pl-7 text-[12px] text-[#475467]">
          {r.respondWithinDays && r.respondBy && (
            <div>
              Partner to respond within {plural(r.respondWithinDays, "day")} (by {fmtDay(r.respondBy)})
            </div>
          )}
          {r.remarks && <div className="whitespace-pre-wrap text-[#667085]">{r.remarks}</div>}
        </div>
      )}
      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-7 text-[13px] text-[#344054]">
          <input
            type="date"
            value={date}
            min={today}
            max={max}
            onChange={(e) => setDate(e.target.value)}
            aria-label={`New date for ${noun}`}
            className={INPUT}
          />
          {visa && (
            <>
              respond within
              <input
                type="number"
                min={1}
                max={MAX_RESPOND_WITHIN_DAYS}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                aria-label="Days the partner has to respond"
                className={`${INPUT} w-[64px]`}
              />
              days
              <textarea
                value={remarks}
                maxLength={MAX_FOLLOW_UP_REMARKS}
                onChange={(e) => setRemarks(e.target.value)}
                rows={2}
                placeholder="Remarks"
                aria-label="Remarks"
                className="min-h-[52px] w-full rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
              />
            </>
          )}
          <button
            type="button"
            disabled={!date || date < today || date > max || (visa && !daysValid) || mut.isPending}
            onClick={() =>
              mut.mutate({
                followUpId: r.id,
                dueDate: date,
                ...(visa ? { respondWithinDays: n, remarks: remarks.trim() || null } : {}),
              })
            }
            className={BTN_PRIMARY}
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className={BTN_SECONDARY}>
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

// A date, or "in N days/weeks" after the expected decision date (or today).
function ScheduleForm({
  applicationId,
  kind,
  nextSeq,
  today,
  expectedBy,
  onScheduled,
  onError,
}: {
  applicationId: number;
  kind: "decision" | "deposit";
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
        <span className="text-[12px] font-semibold text-[#344054]">
          Schedule {NOUN[kind].toLowerCase()} {nextSeq}
        </span>
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
          onClick={() => mut.mutate({ applicationId, kind, dueDate: due })}
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

// Visa file: the first follow-up's date, the days the partner is asked to
// respond within, and remarks. Later weeks follow by themselves.
function VisaScheduleForm({
  applicationId,
  nextSeq,
  today,
  last,
  onScheduled,
  onError,
}: {
  applicationId: number;
  nextSeq: number;
  today: string;
  last: Row | null;
  onScheduled: (seq: number) => void;
  onError: (err: { message: string }) => void;
}) {
  const [date, setDate] = useState(today);
  const [days, setDays] = useState(String(last?.respondWithinDays ?? 3));
  const [remarks, setRemarks] = useState("");
  const mut = api.followUps.schedule.useMutation({
    onSuccess: (r) => {
      setRemarks("");
      onScheduled(r.seq);
    },
    onError,
  });
  const max = addDays(today, MAX_FOLLOW_UP_DAYS_AHEAD);
  const n = Number(days);
  const daysValid = Number.isInteger(n) && n >= 1 && n <= MAX_RESPOND_WITHIN_DAYS;
  const problem = !date
    ? null
    : date < today
      ? "That date has passed. Pick a later one."
      : date > max
        ? "Pick a date within a year."
        : !daysValid
          ? `Response days must be 1 to ${MAX_RESPOND_WITHIN_DAYS}.`
          : null;

  return (
    <div className="mt-3 border-t border-[#D1E9FF] pt-3">
      <div className="mb-2 text-[12px] font-semibold text-[#344054]">
        Schedule visa follow-up {nextSeq} <span className="font-normal text-[#667085]">· repeats weekly</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#344054]">
        Follow up on
        <input
          type="date"
          value={date}
          min={today}
          max={max}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Follow-up date"
          className={INPUT}
        />
        partner to respond within
        <input
          type="number"
          min={1}
          max={MAX_RESPOND_WITHIN_DAYS}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          aria-label="Days the partner has to respond"
          className={`${INPUT} w-[64px]`}
        />
        days
      </div>
      <textarea
        value={remarks}
        maxLength={MAX_FOLLOW_UP_REMARKS}
        onChange={(e) => setRemarks(e.target.value)}
        rows={2}
        placeholder="Remarks (optional): what's pending from the partner"
        aria-label="Remarks"
        className="mt-2 min-h-[52px] w-full rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!date || !!problem || mut.isPending}
          onClick={() =>
            mut.mutate({
              applicationId,
              kind: "visa",
              dueDate: date,
              respondWithinDays: n,
              remarks: remarks.trim() || null,
            })
          }
          className={BTN_PRIMARY}
        >
          Schedule
        </button>
        {problem && <span className="text-xs text-[#B42318]">{problem}</span>}
      </div>
    </div>
  );
}
