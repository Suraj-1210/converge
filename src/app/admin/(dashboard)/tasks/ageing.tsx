"use client";

import { Fragment, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import { addDays } from "~/lib/follow-ups";
import { TASK_CATEGORY_CODES, fmtShortDay, taskCategoryLabel, taskCode } from "~/lib/tasks";
import { BTN_SECONDARY, CARD, Empty, ErrorBox, Tile, TD, TH, downloadCsv } from "~/components/tasks/ui";
import { TaskHistory } from "~/components/tasks/task-table";

// Task ageing & completion (PDF page 7): measured from the original creation
// and due dates. Head Counsellor (their team) and Super Admin (everyone).

const SELECT = "rounded-lg border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-[13px]";
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function AgeingReport() {
  const today = useMemo(istToday, []);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [counsellor, setCounsellor] = useState("");
  const [category, setCategory] = useState("");
  const [postponedOnly, setPostponedOnly] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const people = api.tasks.people.useQuery().data ?? [];
  const q = api.tasks.ageing.useQuery(
    {
      from,
      to: to < from ? from : to,
      counsellorId: counsellor ? Number(counsellor) : undefined,
      category: category === "" ? undefined : Number(category),
      postponedOnly,
    },
    { placeholderData: keepPreviousData },
  );
  const d = q.data;
  const exportCsv = () => {
    if (!d) return;
    downloadCsv(
      `task-ageing-${from}-to-${to}.csv`,
      ["Task ID", "Task", "Student", "CP ID", "Partner", "Category", "Counsellor", "Source", "Created", "Original due", "Postponements", "Revised due dates", "Completed", "Status", "Total days", "Days late (vs original due)", "Reason for delay"],
      d.items.map((t) => [
        taskCode(t.id),
        t.title,
        t.studentName,
        `CP-${t.studentId}`,
        t.partner,
        taskCategoryLabel(t.category),
        t.assigneeName ?? "",
        t.auto ? "auto" : "manual",
        t.createdOn,
        t.originalDueDate ?? "",
        t.postponements,
        t.revisedDues.join(" | "),
        t.completedOn ?? "",
        t.state,
        t.totalDays,
        t.lateDays,
        t.delayReason ?? "",
      ]),
    );
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[#667085]">Measured from the original creation and due dates · visible to Head Counsellors and Super Admin</p>
        <button type="button" className={BTN_SECONDARY} onClick={exportCsv} disabled={!d}>
          Export CSV
        </button>
      </div>
      <div className={`${CARD} flex flex-wrap items-center gap-2 px-4 py-3`}>
        <span className="text-[12px] text-[#667085]">Created</span>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={SELECT} />
        <span className="text-[12px] text-[#667085]">to</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={SELECT} />
        <button type="button" className="cursor-pointer text-[12px] text-[#1570EF]" onClick={() => { setFrom(addDays(today, -29)); setTo(today); }}>
          Last 30 days
        </button>
        <select value={counsellor} onChange={(e) => setCounsellor(e.target.value)} className={SELECT}>
          <option value="">All counsellors ({people.length})</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={SELECT}>
          <option value="">All categories</option>
          {TASK_CATEGORY_CODES.map((c) => (
            <option key={c} value={c}>
              {taskCategoryLabel(c)}
            </option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#D0D5DD] px-2.5 py-1.5 text-[13px]">
          <input type="checkbox" checked={postponedOnly} onChange={(e) => setPostponedOnly(e.target.checked)} className="accent-[#1570EF]" />
          Postponed only
        </label>
      </div>
      {q.error && <ErrorBox message={q.error.message} />}
      {d && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Tile label="Tasks completed" value={d.stats.completed} sub={`of ${d.stats.created} created`} />
          <Tile label="Completed by original due date" value={`${d.stats.onTimePct}%`} sub={`${d.stats.onTime} of ${d.stats.completed}`} />
          <Tile label="Average days to complete" value={d.stats.avgDays} sub="calendar days, created → done" />
          <Tile label="Tasks postponed" value={d.stats.postponed} tone={d.stats.postponed ? "orange" : "default"} sub={`${d.stats.postponedTwice} postponed 2× or more`} />
        </div>
      )}
      <div className={CARD}>
        <div className="px-5 py-4">
          <h3 className="text-[15px] font-semibold text-[#101828]">{postponedOnly ? "Postponed tasks" : "Tasks"}</h3>
        </div>
        {!d ? (
          <Empty>Loading…</Empty>
        ) : d.items.length === 0 ? (
          <Empty>No tasks in this period.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Task</th>
                  <th className={TH}>Counsellor</th>
                  <th className={TH}>Created</th>
                  <th className={TH}>Original due</th>
                  <th className={TH}>Postponed</th>
                  <th className={TH}>Revised due</th>
                  <th className={TH}>Completed</th>
                  <th className={TH}>Total time</th>
                  <th className={TH}>Reason for delay</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((t) => (
                  <Fragment key={t.id}>
                    <tr className="cursor-pointer border-b border-[#F2F4F7] hover:bg-[#F9FAFB]" onClick={() => setOpen(open === t.id ? null : t.id)}>
                      <td className={TD}>
                        <div className="font-semibold text-[#101828]">{t.title}</div>
                        <div className="text-[11px] text-[#667085]">
                          {t.code} · {t.studentName}, CP-{t.studentId}
                        </div>
                      </td>
                      <td className={TD}>{t.assigneeName ?? "—"}</td>
                      <td className={TD}>{fmtShortDay(t.createdOn)}</td>
                      <td className={TD}>{fmtShortDay(t.originalDueDate)}</td>
                      <td className={TD}>
                        <span className={t.postponements ? "font-semibold text-[#C4320A]" : ""}>{t.postponements}</span>
                        {t.pendingShift && <span className="text-[12px] text-[#667085]"> +1 pending</span>}
                      </td>
                      <td className={TD}>{t.revisedDues.length ? t.revisedDues.map(fmtShortDay).join(", ") : "—"}</td>
                      <td className={TD}>
                        {t.open ? <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 text-[11px] font-semibold text-[#475467]">Open</span> : fmtShortDay(t.completedOn)}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <b>
                          {t.totalDays} day{t.totalDays === 1 ? "" : "s"}
                        </b>
                        {t.open ? (
                          <span className="text-[12px] text-[#667085]"> so far</span>
                        ) : t.lateDays > 0 ? (
                          <span className="ml-1 rounded bg-[#FEF3F2] px-1.5 text-[11px] font-semibold text-[#B42318]">+{t.lateDays} late</span>
                        ) : (
                          <span className="ml-1 rounded bg-[#ECFDF3] px-1.5 text-[11px] font-semibold text-[#067647]">On time</span>
                        )}
                      </td>
                      <td className={TD}>{t.delayReason ?? "—"}</td>
                    </tr>
                    {open === t.id && (
                      <tr className="border-b border-[#F2F4F7]">
                        <td colSpan={9} className="px-5 pb-4">
                          <div className="rounded-lg border border-[#D1E9FF] bg-[#F5FAFF] px-4 py-3">
                            <div className="mb-2 text-[12px] font-semibold text-[#175CD3]">History</div>
                            <TaskHistory rows={t.history} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-[#F2F4F7] px-5 py-3 text-[11px] text-[#667085]">
          Total time = calendar days from the original creation date to completion. Late = days past the original due date,
          not the revised one. Click a row for its postponement history.
        </div>
      </div>
    </div>
  );
}
