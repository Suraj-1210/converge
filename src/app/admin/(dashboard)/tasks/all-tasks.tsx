"use client";

import { useEffect, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import { TASK_CATEGORY_CODES, TaskSourceLabel, taskCategoryLabel, type TaskSource, type TaskState } from "~/lib/tasks";
import { CARD, Empty, ErrorBox, Pill } from "~/components/tasks/ui";
import { TaskTable } from "~/components/tasks/task-table";

const SELECT = "rounded-lg border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-[13px]";

export function AllTasks({ isHead, onToast }: { isHead: boolean; onToast: (m: string) => void }) {
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [state, setState] = useState<TaskState | "open" | "">("open");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [source, setSource] = useState<TaskSource | "">("");
  const [assignee, setAssignee] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const people = api.tasks.people.useQuery(undefined, { enabled: isHead }).data ?? [];
  const q = api.tasks.list.useQuery(
    {
      scope,
      state: state || undefined,
      category: category === "" ? undefined : Number(category),
      priority: priority === "" ? undefined : Number(priority),
      source: source || undefined,
      assigneeId: scope === "team" && assignee ? Number(assignee) : undefined,
      search: debounced || undefined,
    },
    { placeholderData: keepPreviousData },
  );
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[#E4E7EC] px-5 py-4">
        {isHead && (
          <>
            <Pill active={scope === "mine"} onClick={() => setScope("mine")}>Mine</Pill>
            <Pill active={scope === "team"} onClick={() => setScope("team")}>Team</Pill>
            <span className="mx-1 h-5 w-px bg-[#E4E7EC]" />
          </>
        )}
        <select value={state} onChange={(e) => setState(e.target.value as TaskState | "open" | "")} className={SELECT}>
          <option value="open">Open</option>
          <option value="overdue">Overdue</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All (not cancelled)</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={SELECT}>
          <option value="">All categories</option>
          {TASK_CATEGORY_CODES.map((c) => (
            <option key={c} value={c}>
              {taskCategoryLabel(c)}
            </option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className={SELECT}>
          <option value="">Any priority</option>
          <option value="2">High</option>
          <option value="1">Medium</option>
          <option value="0">Low</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value as TaskSource | "")} className={SELECT}>
          <option value="">All sources</option>
          {(Object.keys(TaskSourceLabel) as TaskSource[]).map((s) => (
            <option key={s} value={s}>
              {TaskSourceLabel[s]}
            </option>
          ))}
        </select>
        {scope === "team" && (
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={SELECT}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search task, student, TSK- / CP-ID"
          className={`${SELECT} ml-auto w-64`}
        />
      </div>
      {q.error ? (
        <div className="p-5">
          <ErrorBox message={q.error.message} />
        </div>
      ) : !q.data ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          <TaskTable tasks={q.data.tasks} today={q.data.today} showAssignee={scope === "team"} onToast={onToast} empty="No tasks match." />
          {q.data.tasks.length >= 500 && <div className="px-5 py-3 text-[12px] text-[#667085]">Showing the first 500. Narrow the filters.</div>}
        </>
      )}
    </div>
  );
}
