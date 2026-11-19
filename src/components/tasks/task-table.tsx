"use client";

import Link from "next/link";
import { useState } from "react";
import { Modal } from "~/components/ui/modal";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  ShiftStatusLabel,
  TaskSourceLabel,
  fmtIstDateTime,
  fmtShortDay,
  fmtWeekday,
  type ShiftStatus,
} from "~/lib/tasks";
import {
  AutoTag,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_SMALL,
  DueCell,
  Empty,
  INPUT,
  LABEL,
  PriorityBadge,
  StateBadge,
  TD,
  TH,
  categoryLabel,
} from "./ui";

export type TaskRow = RouterOutputs["tasks"]["list"]["tasks"][number];

function useTaskInvalidate() {
  const utils = api.useUtils();
  return () =>
    Promise.all([
      utils.tasks.myDay.invalidate(),
      utils.tasks.list.invalidate(),
      utils.tasks.badge.invalidate(),
      utils.tasks.closeDay.invalidate(),
      utils.shortlistFollowUp.studentTasks.invalidate(),
    ]);
}

export function TaskTable({
  tasks,
  today,
  showAssignee = false,
  onToast,
  empty = "No tasks.",
}: {
  tasks: TaskRow[];
  today: string;
  showAssignee?: boolean;
  onToast: (m: string) => void;
  empty?: string;
}) {
  const invalidate = useTaskInvalidate();
  const [open, setOpen] = useState<TaskRow | null>(null);
  const complete = api.tasks.complete.useMutation({
    onSuccess: async () => {
      await invalidate();
      onToast("Task completed");
    },
    onError: (e) => onToast(e.message),
  });
  const update = api.tasks.update.useMutation({
    onSuccess: async () => {
      await invalidate();
    },
    onError: (e) => onToast(e.message),
  });
  if (tasks.length === 0) return <Empty>{empty}</Empty>;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>Task</th>
              <th className={TH}>Student</th>
              <th className={TH}>Partner</th>
              {showAssignee && <th className={TH}>Assigned to</th>}
              <th className={TH}>Category</th>
              <th className={TH}>Priority</th>
              <th className={TH}>Due</th>
              <th className={TH}>Status</th>
              <th className={TH}>Remarks</th>
              <th className={TH}></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const overdue = t.state === "overdue";
              const openTask = t.state !== "completed" && t.state !== "cancelled";
              return (
                <tr key={t.id} className={`border-b border-[#F2F4F7] last:border-0 ${overdue ? "bg-[#FEF3F2]/70" : ""}`}>
                  <td className={TD}>
                    <button type="button" onClick={() => setOpen(t)} className="cursor-pointer text-left font-semibold text-[#101828] hover:text-[#1570EF]">
                      {t.title}
                    </button>
                    <div className="text-[11px] text-[#667085]">
                      {t.code}
                      {t.auto && <AutoTag />}
                      {t.postponements > 0 && <span className="font-semibold text-[#C4320A]"> · postponed {t.postponements}×</span>}
                      {t.lastShift?.status === 1 && <span className="text-[#B54708]"> · shift requested</span>}
                    </div>
                  </td>
                  <td className={TD}>
                    <Link href={`/admin/students/${t.studentId}`} className="text-[#101828] hover:text-[#1570EF]">
                      {t.studentName}
                    </Link>
                    <div className="text-[11px] text-[#98A2B3]">CP-{t.studentId}</div>
                  </td>
                  <td className={TD}>{t.partner}</td>
                  {showAssignee && <td className={TD}>{t.assigneeName ?? <span className="text-[#98A2B3]">Unassigned</span>}</td>}
                  <td className={TD}>{categoryLabel(t.category)}</td>
                  <td className={TD}>
                    <PriorityBadge priority={t.priority} />
                  </td>
                  <td className={TD}>
                    <DueCell due={t.dueDate} original={t.originalDueDate} today={today} overdue={overdue} />
                  </td>
                  <td className={TD}>
                    <StateBadge state={t.state} />
                  </td>
                  <td className={`${TD} max-w-[220px] text-[#475467]`}>{t.remarks ?? "—"}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {openTask && t.stageTask && (
                      <Link href={t.link} className={BTN_SMALL}>
                        Record follow-up
                      </Link>
                    )}
                    {openTask && t.canComplete && (
                      <span className="inline-flex gap-1.5">
                        {t.state === "pending" && (
                          <button type="button" className={BTN_SMALL} disabled={update.isPending} onClick={() => update.mutate({ id: t.id, status: 1 })}>
                            Start
                          </button>
                        )}
                        <button type="button" className={BTN_SMALL} disabled={complete.isPending} onClick={() => complete.mutate({ id: t.id })}>
                          Done
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && <TaskDetailModal task={open} today={today} onClose={() => setOpen(null)} onToast={onToast} />}
    </>
  );
}

export function TaskDetailModal({
  task,
  today,
  onClose,
  onToast,
}: {
  task: TaskRow;
  today: string;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const invalidate = useTaskInvalidate();
  const history = api.tasks.history.useQuery({ id: task.id });
  const [remarks, setRemarks] = useState(task.remarks ?? "");
  const [followUp, setFollowUp] = useState(task.followUpDate ?? "");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const isOpen = task.state !== "completed" && task.state !== "cancelled";
  const update = api.tasks.update.useMutation({
    onSuccess: async () => {
      await invalidate();
      onToast("Task updated");
      onClose();
    },
    onError: (e) => onToast(e.message),
  });
  const cancel = api.tasks.cancel.useMutation({
    onSuccess: async () => {
      await invalidate();
      onToast("Task cancelled");
      onClose();
    },
    onError: (e) => onToast(e.message),
  });
  return (
    <Modal
      open
      title={task.title}
      onClose={onClose}
      width="w-[620px]"
      footer={
        isOpen ? (
          <>
            {task.source === "manual" && !cancelling && (
              <button type="button" className={`${BTN_SECONDARY} mr-auto text-[#B42318]`} onClick={() => setCancelling(true)}>
                Cancel task
              </button>
            )}
            <button type="button" className={BTN_SECONDARY} onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={update.isPending}
              onClick={() => update.mutate({ id: task.id, remarks: remarks.trim() || null, followUpDate: followUp || null })}
            >
              Save
            </button>
          </>
        ) : undefined
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
        <Field label="Task ID" value={`${task.code}${task.auto ? ` · ${TaskSourceLabel[task.source]}` : ""}`} />
        <Field label="Status" value={<StateBadge state={task.state} />} />
        <Field label="Student" value={`${task.studentName} (CP-${task.studentId})`} />
        <Field label="Partner" value={task.partner} />
        <Field label="Category" value={categoryLabel(task.category)} />
        <Field label="Priority" value={<PriorityBadge priority={task.priority} />} />
        <Field label="Assigned" value={`${fmtWeekday(task.assignedOn)}${task.assigneeName ? ` · ${task.assigneeName}` : ""}`} />
        <Field label="Original due" value={fmtWeekday(task.originalDueDate)} />
        <Field label="Revised due" value={task.dueDate !== task.originalDueDate ? fmtWeekday(task.dueDate) : "—"} />
        <Field label="Postponed" value={`${task.postponements}×`} />
        {task.completedAt && <Field label="Completed" value={fmtIstDateTime(task.completedAt)} />}
      </div>
      {task.pendingActivity && (
        <div>
          <div className={LABEL}>Pending activity</div>
          <div className="rounded-lg bg-[#F9FAFB] px-3 py-2 text-[13px] text-[#344054]">{task.pendingActivity}</div>
        </div>
      )}
      {task.lastShift && (
        <div className="rounded-lg border border-[#E4E7EC] px-3 py-2 text-[12px] text-[#475467]">
          <b>{fmtShortDay(task.lastShift.day)}</b> · {task.lastShift.reasonLabel}: {task.lastShift.details}
          {task.lastShift.shiftRequested && (
            <>
              {" "}· shift to {fmtShortDay(task.lastShift.newDueDate)}:{" "}
              <b>{ShiftStatusLabel[task.lastShift.status as ShiftStatus]}</b>
              {task.lastShift.rejectReason && <> — “{task.lastShift.rejectReason}”</>}
            </>
          )}
        </div>
      )}
      {isOpen && (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={LABEL}>Remarks</label>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={1000} className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>Follow-up date</label>
            <input type="date" min={today} value={followUp} onChange={(e) => setFollowUp(e.target.value)} className={INPUT} />
          </div>
          <div className="flex items-end">
            <Link href={task.link} className={BTN_SECONDARY}>
              Open student
            </Link>
          </div>
        </div>
      )}
      {cancelling && (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-3">
          <label className={LABEL}>Why cancel it?</label>
          <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={255} className={INPUT} />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className={BTN_SECONDARY} onClick={() => setCancelling(false)}>
              Keep it
            </button>
            <button type="button" className={BTN_DANGER} disabled={!cancelReason.trim() || cancel.isPending} onClick={() => cancel.mutate({ id: task.id, reason: cancelReason.trim() })}>
              Cancel task
            </button>
          </div>
        </div>
      )}
      <div>
        <div className={LABEL}>History</div>
        <TaskHistory rows={history.data ?? []} loading={history.isLoading} />
      </div>
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] tracking-wide text-[#667085] uppercase">{label}</div>
      <div className="text-[#101828]">{value}</div>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: "Created",
  started: "Started",
  status: "Status changed",
  completed: "Completed",
  cancelled: "Cancelled",
  reopened: "Reopened",
  reassigned: "Reassigned",
  rescheduled: "Rescheduled",
  not_completed: "Not completed",
  shift_requested: "Shift requested",
  shift_approved: "Shift approved",
  shift_rejected: "Shift rejected",
};

export function TaskHistory({
  rows,
  loading,
}: {
  rows: { id: number; kind: string; at: string; by: string | null; from: string | null; to: string | null; reason: string | null; note: string | null }[];
  loading?: boolean;
}) {
  if (loading) return <div className="text-[12px] text-[#98A2B3]">Loading…</div>;
  if (rows.length === 0) return <div className="text-[12px] text-[#98A2B3]">No history yet.</div>;
  return (
    <ul className="space-y-1.5">
      {rows.map((e) => (
        <li key={e.id} className="grid grid-cols-[120px_1fr] gap-3 text-[12px]">
          <span className="text-[#667085]">{fmtIstDateTime(e.at)}</span>
          <span className="text-[#344054]">
            <b>{EVENT_LABEL[e.kind] ?? e.kind}</b>
            {e.by && <> by {e.by}</>}
            {e.reason && <> — <i>{e.reason}</i></>}
            {e.note && <>: {e.note}</>}
            {(e.kind === "shift_approved" || e.kind === "rescheduled" || e.kind === "shift_requested") && e.to && (
              <> · {e.from ? `${fmtShortDay(e.from)} → ` : ""}due {fmtShortDay(e.to)}</>
            )}
            {e.kind === "created" && e.to && <> · due {fmtShortDay(e.to)}</>}
          </span>
        </li>
      ))}
    </ul>
  );
}
