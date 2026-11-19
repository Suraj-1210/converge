"use client";

import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import { addDays } from "~/lib/follow-ups";
import { fmtMinutes } from "~/lib/tat";
import { TASK_CATEGORY_CODES, taskCategoryLabel, type TaskState } from "~/lib/tasks";
import { CARD, Empty, ErrorBox, Tile, TD, TH } from "~/components/tasks/ui";

// Head Counsellor monitoring dashboard (item 9): tasks assigned in the
// period across the team (everyone for a Super Admin), plus pending
// shortlists, follow-ups due and shortlisting turnaround.

const SELECT = "rounded-lg border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-[13px]";
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function TeamDashboard() {
  const today = useMemo(istToday, []);
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [counsellor, setCounsellor] = useState("");
  const [department, setDepartment] = useState("");
  const [category, setCategory] = useState("");
  const [state, setState] = useState<TaskState | "">("");
  const [partner, setPartner] = useState("");
  const [studentId, setStudentId] = useState("");
  const people = api.tasks.people.useQuery().data ?? [];
  const filters = api.tasks.teamFilters.useQuery().data;
  const sid = Number(studentId.replace(/^CP-?/i, ""));
  const q = api.tasks.team.useQuery(
    {
      from,
      to: to < from ? from : to,
      counsellorId: counsellor ? Number(counsellor) : undefined,
      departmentId: department ? Number(department) : undefined,
      category: category === "" ? undefined : Number(category),
      state: state || undefined,
      partner: partner || undefined,
      studentId: Number.isInteger(sid) && sid > 0 ? sid : undefined,
    },
    { placeholderData: keepPreviousData },
  );
  const d = q.data;
  return (
    <div className="space-y-5">
      <div className={`${CARD} flex flex-wrap items-center gap-2 px-4 py-3`}>
        <span className="text-[12px] text-[#667085]">Assigned</span>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={SELECT} />
        <span className="text-[12px] text-[#667085]">to</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={SELECT} />
        <select value={counsellor} onChange={(e) => setCounsellor(e.target.value)} className={SELECT}>
          <option value="">All counsellors</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={department} onChange={(e) => setDepartment(e.target.value)} className={SELECT}>
          <option value="">All departments</option>
          {(filters?.departments ?? []).map((dep) => (
            <option key={dep.id} value={dep.id}>
              {dep.name}
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
        <select value={state} onChange={(e) => setState(e.target.value as TaskState | "")} className={SELECT}>
          <option value="">Any status</option>
          <option value="pending">Pending / In progress</option>
          <option value="overdue">Overdue</option>
          <option value="completed">Completed</option>
        </select>
        <select value={partner} onChange={(e) => setPartner(e.target.value)} className={`${SELECT} max-w-[200px]`}>
          <option value="">All partners</option>
          {(filters?.partners ?? []).map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <input value={studentId} onChange={(e) => setStudentId(e.target.value)} placeholder="Student CP-ID" className={`${SELECT} w-32`} />
      </div>
      {q.error && <ErrorBox message={q.error.message} />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Tile label="Total tasks assigned" value={d.stats.assigned} />
            <Tile label="Completed" value={d.stats.completed} tone="green" />
            <Tile label="Pending" value={d.stats.pending} tone="orange" />
            <Tile label="Overdue" value={d.stats.overdue} tone={d.stats.overdue ? "red" : "default"} />
            <Tile label="Shifted" value={d.stats.shifted} sub="postponed at least once" />
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile label="Average completion time" value={`${d.stats.avgCompletionDays}d`} sub="calendar days, created → done" />
            <Tile label="Pending shortlists" value={d.shortlisting.pending} tone={d.shortlisting.pending ? "orange" : "default"} sub="students added in the period, not shared yet" />
            <Tile label="Follow-ups due" value={d.stats.followUpsDue} tone={d.stats.followUpsDue ? "orange" : "default"} sub="shortlist + application follow-ups, today or earlier" />
            <Tile
              label="Shortlisting turnaround"
              value={d.shortlisting.avgMinutes === null ? "—" : fmtMinutes(d.shortlisting.avgMinutes)}
              sub={d.shortlisting.sla ? `added → shared, SLA ${fmtMinutes(d.shortlisting.sla.minutes)} (weekends excluded)` : "added → shared"}
            />
          </div>
          <div className={CARD}>
            <div className="px-5 py-4">
              <h3 className="text-[15px] font-semibold text-[#101828]">By counsellor</h3>
            </div>
            {d.counsellors.length === 0 ? (
              <Empty>No tasks in this period.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={TH}>Counsellor</th>
                      <th className={TH}>Assigned</th>
                      <th className={TH}>Completed</th>
                      <th className={TH}>Pending</th>
                      <th className={TH}>Overdue</th>
                      <th className={TH}>Shifted</th>
                      <th className={TH}>Completion</th>
                      <th className={TH}>Avg. days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.counsellors.map((c) => (
                      <tr key={c.id} className="border-b border-[#F2F4F7] last:border-0">
                        <td className={`${TD} font-semibold text-[#101828]`}>{c.name}</td>
                        <td className={TD}>{c.assigned}</td>
                        <td className={TD}>{c.completed}</td>
                        <td className={TD}>{c.pending}</td>
                        <td className={`${TD} ${c.overdue ? "font-semibold text-[#B42318]" : ""}`}>{c.overdue}</td>
                        <td className={TD}>{c.shifted}</td>
                        <td className={TD}>
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[#F2F4F7]">
                              <div className="h-full rounded-full bg-[#1570EF]" style={{ width: `${c.completionPct}%` }} />
                            </div>
                            {c.completionPct}%
                          </div>
                        </td>
                        <td className={TD}>{c.avgDays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
