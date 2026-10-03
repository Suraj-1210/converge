"use client";

import { useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import {
  BDM_TASK_CATEGORY_CODES,
  BDM_TASK_PRIORITY_CODES,
  BdmTaskCategoryLabel,
  BdmTaskPriority,
  BdmTaskPriorityLabel,
} from "~/server/db/enums";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  EmptyState,
  PRIORITY_BADGE,
  PersonSelect,
  TargetSelect,
  codesWithLabels,
  fmtDay,
  parseTarget,
  todayIst,
  type Notify,
  type Option,
  type PartnerOption,
} from "./crm-ui";

type Task = RouterOutputs["bdmCrm"]["task"]["list"][number];
type Scope = { bdmId?: number };
type Filter = "all" | "open" | "overdue" | "urgent" | "completed";

const PRIORITY_OPTIONS = codesWithLabels(BDM_TASK_PRIORITY_CODES, BdmTaskPriorityLabel);
const CATEGORY_OPTIONS = codesWithLabels(BDM_TASK_CATEGORY_CODES, BdmTaskCategoryLabel);
const PRIORITY_RANK: Record<number, number> = { [BdmTaskPriority.URGENT]: 0, [BdmTaskPriority.NORMAL]: 1, [BdmTaskPriority.LOW]: 2 };

// The page reads the same queries for the tab count, so keep inputs identical.
export const taskListInput = (scope: Scope) => ({ ...scope, status: "all" as const });

export function MyTasks({
  scope,
  isSuperAdmin,
  defaultBdmId,
  bdms,
  partners,
  prospects,
  notify,
}: {
  scope: Scope;
  isSuperAdmin: boolean;
  defaultBdmId?: number;
  bdms: Option[];
  partners: PartnerOption[];
  prospects: Option[];
  notify: Notify;
}) {
  const utils = api.useUtils();
  const summaryQ = api.bdmCrm.task.summary.useQuery(scope);
  const listQ = api.bdmCrm.task.list.useQuery(taskListInput(scope));
  const [filter, setFilter] = useState<Filter>("open");
  const [creating, setCreating] = useState(false);
  const [rescheduling, setRescheduling] = useState<Task | null>(null);

  const refresh = () => void utils.bdmCrm.task.invalidate();
  const complete = api.bdmCrm.task.complete.useMutation({ onSuccess: () => { refresh(); notify("Task completed"); }, onError: (e) => notify(e.message) });
  const reopen = api.bdmCrm.task.reopen.useMutation({ onSuccess: () => { refresh(); notify("Task reopened"); }, onError: (e) => notify(e.message) });
  const toggling = complete.isPending || reopen.isPending;

  const s = summaryQ.data;
  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: (s?.open ?? 0) + (s?.completed ?? 0) },
    { key: "open", label: "Open", count: s?.open ?? 0 },
    { key: "overdue", label: "Overdue", count: s?.overdue ?? 0 },
    { key: "urgent", label: "Urgent", count: s?.urgent ?? 0 },
    { key: "completed", label: "Completed", count: s?.completed ?? 0 },
  ];

  // Mock order: completed last, overdue first, then priority, then due date.
  const rows = useMemo(() => {
    const picked = (listQ.data ?? []).filter((t) => {
      switch (filter) {
        case "open": return !t.done;
        case "overdue": return t.status === "overdue";
        case "urgent": return !t.done && t.priority === BdmTaskPriority.URGENT;
        case "completed": return t.done;
        default: return true;
      }
    });
    return picked.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const ao = a.status === "overdue" ? 0 : 1, bo = b.status === "overdue" ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ap = PRIORITY_RANK[a.priority] ?? 1, bp = PRIORITY_RANK[b.priority] ?? 1;
      if (ap !== bp) return ap - bp;
      return (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
    });
  }, [listQ.data, filter]);

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-3 border-b border-[#E4E7EC] px-5 py-4">
        <h3 className="text-[15px] font-semibold text-[#101828]">{isSuperAdmin ? "Tasks" : "My Tasks"}</h3>
        <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{rows.length}</span>
        <button onClick={() => setCreating(true)} className={`ml-auto ${BTN_PRIMARY}`}>+ New Task</button>
      </div>

      <div className="flex flex-wrap gap-6 border-b border-[#F2F4F7] px-5 py-3 text-[13px] text-[#667085]">
        <span><span className="mr-1 text-base font-bold text-[#101828]">{s?.open ?? 0}</span>Open</span>
        <span><span className="mr-1 text-base font-bold text-[#B42318]">{s?.overdue ?? 0}</span>Overdue</span>
        <span><span className="mr-1 text-base font-bold text-[#101828]">{s?.dueToday ?? 0}</span>Due Today</span>
        <span><span className="mr-1 text-base font-bold text-[#101828]">{s?.urgent ?? 0}</span>Urgent</span>
        <span><span className="mr-1 text-base font-bold text-[#027A48]">{s?.completed ?? 0}</span>Completed</span>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-[#F2F4F7] px-5 py-3">
        {filters.map((f) => {
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1 text-[12px] font-semibold ${on ? "bg-[#1570EF] text-white" : "bg-[#F2F4F7] text-[#344054] hover:bg-[#E4E7EC]"}`}
            >
              {f.label} <span className={on ? "text-[#D1E9FF]" : "text-[#98A2B3]"}>{f.count}</span>
            </button>
          );
        })}
      </div>

      {listQ.isLoading ? (
        <div className="px-5 py-8 text-center text-[13px] text-[#98A2B3]">Loading...</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={filter === "completed" ? "No completed tasks yet" : "No tasks found"}
          body={filter === "all" ? "Click \"New Task\" to create your first task." : "Try a different filter."}
        />
      ) : (
        <div className="divide-y divide-[#F2F4F7]">
          {rows.map((t) => (
            <div key={t.id} className={`flex items-start gap-3 px-5 py-3.5 ${t.done ? "bg-[#FCFCFD]" : ""}`}>
              <input
                type="checkbox"
                checked={t.done}
                disabled={toggling}
                onChange={() => (t.done ? reopen.mutate({ id: t.id }) : complete.mutate({ id: t.id }))}
                aria-label={t.done ? `Reopen ${t.title}` : `Complete ${t.title}`}
                className="mt-1 h-4 w-4 cursor-pointer accent-[#1570EF]"
              />
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] font-semibold ${t.done ? "text-[#98A2B3] line-through" : "text-[#101828]"}`}>{t.title}</div>
                {t.description && <div className="mt-0.5 text-[12px] text-[#667085]">{t.description}</div>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                  {t.target && (
                    <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 font-medium text-[#344054]">
                      {t.target.name} <span className="uppercase text-[#98A2B3]">{t.target.kind}</span>
                    </span>
                  )}
                  <span className="text-[#667085]">{t.categoryLabel}</span>
                  {isSuperAdmin && <span className="text-[#98A2B3]">→ {t.assigneeName}</span>}
                </div>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${PRIORITY_BADGE[t.priority] ?? ""}`}>{t.priorityLabel}</span>
              <div className="w-28 shrink-0 text-right text-[12px]">
                {t.done ? (
                  <span className="text-[#98A2B3]">Done {fmtDay(t.completedAt?.slice(0, 10))}</span>
                ) : t.status === "overdue" ? (
                  <span className="font-semibold text-[#B42318]">Overdue · {fmtDay(t.dueDate)}</span>
                ) : t.status === "dueToday" ? (
                  <span className="font-semibold text-[#B54708]">Due today</span>
                ) : (
                  <span className="text-[#667085]">Due {fmtDay(t.dueDate)}</span>
                )}
              </div>
              <div className="w-24 shrink-0 text-right">
                {!t.done && (
                  <button onClick={() => setRescheduling(t)} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]">
                    Reschedule
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <NewTaskModal
          isSuperAdmin={isSuperAdmin}
          defaultBdmId={defaultBdmId}
          bdms={bdms}
          partners={partners}
          prospects={prospects}
          notify={notify}
          onClose={() => setCreating(false)}
        />
      )}
      {rescheduling && <RescheduleModal task={rescheduling} notify={notify} onClose={() => setRescheduling(null)} />}
    </div>
  );
}

function NewTaskModal({
  isSuperAdmin,
  defaultBdmId,
  bdms,
  partners,
  prospects,
  notify,
  onClose,
}: {
  isSuperAdmin: boolean;
  defaultBdmId?: number;
  bdms: Option[];
  partners: PartnerOption[];
  prospects: Option[];
  notify: Notify;
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const today = todayIst();
  const [f, setF] = useState({
    title: "",
    description: "",
    target: "",
    dueDate: today,
    priority: String(BdmTaskPriority.NORMAL),
    category: "",
    assignedTo: defaultBdmId != null ? String(defaultBdmId) : "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const create = api.bdmCrm.task.create.useMutation({
    onSuccess: () => {
      void utils.bdmCrm.task.invalidate();
      notify("Task created");
      onClose();
    },
    onError: (e) => notify(e.message),
  });
  const target = parseTarget(f.target);
  const missing = !f.title.trim() || !target || !f.dueDate || f.category === "";
  const submit = () => {
    if (missing || !target) return;
    create.mutate({
      title: f.title,
      description: f.description,
      target,
      dueDate: f.dueDate,
      priority: Number(f.priority),
      category: Number(f.category),
      assignedTo: isSuperAdmin && f.assignedTo !== "" ? Number(f.assignedTo) : undefined,
    });
  };
  return (
    <Modal
      open
      title="Create Task"
      onClose={onClose}
      width="w-[600px]"
      footer={
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
          <button onClick={submit} disabled={create.isPending || missing} className={BTN_PRIMARY}>{create.isPending ? "Saving..." : "Create Task"}</button>
        </>
      }
    >
      <FormInput label="Title" required value={f.title} onChange={set("title")} maxLength={255} placeholder="e.g., Send commission proposal" />
      <FormTextarea label="Description" value={f.description} onChange={set("description")} rows={3} maxLength={1000} />
      <TargetSelect value={f.target} onChange={(v) => setF((s) => ({ ...s, target: v }))} partners={partners} prospects={prospects} />
      <div className="flex gap-3">
        <FormInput label="Due date" required type="date" min={today} value={f.dueDate} onChange={set("dueDate")} />
        <FormSelect label="Priority" value={f.priority} onChange={set("priority")} options={PRIORITY_OPTIONS} />
      </div>
      <div className="flex gap-3">
        <FormSelect label="Category" required value={f.category} onChange={set("category")} options={CATEGORY_OPTIONS} placeholder="Select category..." />
        {isSuperAdmin ? <PersonSelect label="Assign to" includeMe value={f.assignedTo} onChange={(v) => setF((s) => ({ ...s, assignedTo: v }))} bdms={bdms} /> : <div className="flex-1" />}
      </div>
    </Modal>
  );
}

function RescheduleModal({ task, notify, onClose }: { task: Task; notify: Notify; onClose: () => void }) {
  const utils = api.useUtils();
  const today = todayIst();
  const [dueDate, setDueDate] = useState(task.dueDate && task.dueDate >= today ? task.dueDate : today);
  const [reason, setReason] = useState("");
  const reschedule = api.bdmCrm.task.reschedule.useMutation({
    onSuccess: () => {
      void utils.bdmCrm.task.invalidate();
      notify("Task rescheduled");
      onClose();
    },
    onError: (e) => notify(e.message),
  });
  return (
    <Modal
      open
      title="Reschedule Task"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
          <button onClick={() => reschedule.mutate({ id: task.id, dueDate, reason })} disabled={reschedule.isPending || !dueDate} className={BTN_PRIMARY}>
            {reschedule.isPending ? "Saving..." : "Reschedule"}
          </button>
        </>
      }
    >
      <p className="text-sm text-[#344054]">
        <span className="font-semibold text-[#101828]">{task.title}</span> is due {fmtDay(task.dueDate)}.
      </p>
      <FormInput label="New due date" required type="date" min={today} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <FormTextarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="Why is this being rescheduled?" />
    </Modal>
  );
}
