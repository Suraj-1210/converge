"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { type RouterOutputs } from "~/trpc/react";
import { PIPELINE_PHASES, ShortlistPhaseLabel, TASK_CATEGORY_CODES, fmtShortDay, fmtWeekday, taskCategoryLabel } from "~/lib/tasks";
import { CARD, ErrorBox, Pill, Tile, fmtCountdown } from "~/components/tasks/ui";
import { TaskTable } from "~/components/tasks/task-table";
import { FollowUpRows } from "./follow-ups-tab";
import { PHASE_BAR } from "~/components/tasks/ui";

type Day = RouterOutputs["tasks"]["myDay"];
type Board = RouterOutputs["tasks"]["followUps"];

export function MyDay({
  query,
  board,
  onToast,
  onShowFollowUps,
}: {
  query: { data?: Day; error: { message: string } | null; isLoading: boolean };
  board?: Board;
  onToast: (m: string) => void;
  onShowFollowUps: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "overdue" | "pending" | "high">("all");
  const [category, setCategory] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  const d = query.data;
  const rows = useMemo(() => {
    if (!d) return [];
    return d.tasks.filter((t) => {
      if (filter === "overdue" && t.state !== "overdue") return false;
      if (filter === "pending" && t.state !== "pending" && t.state !== "in_progress") return false;
      if (filter === "high" && t.priority !== 2) return false;
      if (category !== "" && t.category !== Number(category)) return false;
      return true;
    });
  }, [d, filter, category]);
  if (query.error) return <ErrorBox message={query.error.message} />;
  if (!d) return <div className={`${CARD} px-6 py-12 text-center text-sm text-[#98A2B3]`}>Loading…</div>;
  const s = d.stats;
  const open = s.overdue + s.pending;
  const shown = showAll ? rows : rows.slice(0, 8);

  return (
    <div className="space-y-5">
      {d.isWorkingDay && open > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#FDA29B] bg-[#FEF3F2] px-5 py-3.5">
          <div>
            <div className="text-[14px] font-semibold text-[#B42318]">
              {d.dayClosed ? "The working day has closed" : `Day closes in ${fmtCountdown(d.minutesToClose)}`} — {s.overdue} task
              {s.overdue === 1 ? " is" : "s are"} overdue and {s.pending} {s.pending === 1 ? "is" : "are"} still open
            </div>
            <div className="text-[12px] text-[#912018]">
              {d.dayClosed
                ? d.closedSubmittedAt
                  ? "You've closed your day. You can still update reasons and shift requests."
                  : `Unfinished tasks are red. Give a reason for each and request a shift to ${d.nextWorkingDayLabel}. Your Head Counsellor is emailed to approve.`
                : `At 7:00 PM, unfinished tasks turn red. Give a reason for each and request a shift to ${d.nextWorkingDayLabel}. Your Head Counsellor is emailed to approve.`}
            </div>
          </div>
          <Link href="/admin/tasks/close-day" className="rounded-lg bg-[#B42318] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#912018]">
            Review incomplete tasks
          </Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Tile label="Total assigned today" value={s.total} sub={`incl. ${s.auto} auto-generated`} />
        <Tile label="Completed" value={s.completed} tone="green" sub={s.completedLate ? `${s.completedLate} closed after due date` : "on time"} />
        <Tile label="Pending" value={s.pending} tone="orange" sub={`${s.inProgress} in progress · ${s.pending - s.inProgress} not started`} />
        <Tile label="Overdue" value={s.overdue} tone="red" sub={s.oldestOverdue ? `oldest due ${fmtWeekday(s.oldestOverdue)}` : "none"} />
        <Tile label="Daily completion" value={`${s.completionPct}%`}>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#F2F4F7]">
            <div className="h-full rounded-full bg-[#1570EF]" style={{ width: `${s.completionPct}%` }} />
          </div>
        </Tile>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className={CARD}>
          <div className="flex items-start justify-between px-5 pt-4 pb-3">
            <div>
              <h3 className="text-[15px] font-semibold text-[#101828]">Shortlist follow-ups</h3>
              <p className="text-[12px] text-[#667085]">Generated automatically after a shortlist is shared. Stops when the partner confirms.</p>
            </div>
            <button type="button" onClick={onShowFollowUps} className="cursor-pointer text-[13px] font-semibold text-[#1570EF]">
              View all {board?.rows.length ?? ""}
            </button>
          </div>
          <div className="px-3 pb-3">
            {board ? (
              <FollowUpRows rows={board.rows.slice(0, 5)} onToast={onToast} compact />
            ) : (
              <div className="px-3 py-6 text-center text-sm text-[#98A2B3]">Loading…</div>
            )}
          </div>
        </div>
        <div className={`${CARD} px-5 py-4`}>
          <h3 className="text-[15px] font-semibold text-[#101828]">Shortlist pipeline</h3>
          <p className="mb-3 text-[12px] text-[#667085]">My students, by partner-confirmation status</p>
          {board && <Pipeline counts={board.pipeline.counts} />}
          {board && (
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[#F2F4F7] pt-3">
              <div className="rounded-lg bg-[#ECFDF3] px-3 py-2">
                <div className="text-[11px] text-[#067647]">Confirmed this week</div>
                <div className="text-xl font-bold text-[#067647]">{board.pipeline.confirmedThisWeek}</div>
              </div>
              <div className="rounded-lg bg-[#F2F4F7] px-3 py-2">
                <div className="text-[11px] text-[#475467]">Closed this week</div>
                <div className="text-xl font-bold text-[#344054]">{board.pipeline.closedThisWeek}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <h3 className="text-[15px] font-semibold text-[#101828]">Today&apos;s task list</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Pill active={filter === "all"} onClick={() => setFilter("all")}>All {d.tasks.length}</Pill>
            <Pill active={filter === "overdue"} onClick={() => setFilter("overdue")}>Overdue {s.overdue}</Pill>
            <Pill active={filter === "pending"} onClick={() => setFilter("pending")}>Pending {s.pending}</Pill>
            <Pill active={filter === "high"} onClick={() => setFilter("high")}>High priority</Pill>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-[#D0D5DD] bg-white px-2 py-1 text-[12px]">
              <option value="">All categories</option>
              {TASK_CATEGORY_CODES.map((c) => (
                <option key={c} value={c}>
                  {taskCategoryLabel(c)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <TaskTable tasks={shown} today={d.today} onToast={onToast} empty="Nothing due today. Tasks due later are under All tasks." />
        <div className="flex items-center justify-between border-t border-[#F2F4F7] px-5 py-3 text-[12px] text-[#667085]">
          <span>
            Showing {shown.length} of {rows.length} · overdue first
          </span>
          {rows.length > 8 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="cursor-pointer font-semibold text-[#1570EF]">
              {showAll ? "Show fewer" : "Show all"}
            </button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-[#98A2B3]">
        Today&apos;s list: open tasks due {fmtShortDay(d.today)} or earlier, plus everything you completed today. Tasks
        marked auto come from shortlist follow-ups, Tasks &amp; Notes reminders and application follow-ups.
      </p>
    </div>
  );
}

export function Pipeline({ counts }: { counts: Record<string, number> }) {
  const max = Math.max(1, ...PIPELINE_PHASES.map((p) => counts[p] ?? 0));
  return (
    <div className="space-y-2.5">
      {PIPELINE_PHASES.map((p) => (
        <div key={p}>
          <div className="flex justify-between text-[13px] text-[#344054]">
            <span>{ShortlistPhaseLabel[p]}</span>
            <b>{counts[p] ?? 0}</b>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#F2F4F7]">
            <div className="h-full rounded-full" style={{ width: `${((counts[p] ?? 0) / max) * 100}%`, background: PHASE_BAR[p] }} />
          </div>
        </div>
      ))}
    </div>
  );
}
