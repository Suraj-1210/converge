"use client";

import { useEffect, useState } from "react";
import { Modal } from "~/components/ui/modal";
import { api } from "~/trpc/react";
import { TASK_CATEGORY_CODES, TaskCategory, fmtWeekday, taskCategoryLabel } from "~/lib/tasks";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL } from "./ui";

// Create task (PDF page 4). Task ID and assigned date are shown, not edited;
// the partner fills from the student. "Overdue" is never picked: it's set
// automatically after the due date.

export function CreateTaskModal({
  today,
  onClose,
  onDone,
  student,
}: {
  today: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  student?: { id: number; name: string; partner: string };
}) {
  const utils = api.useUtils();
  const code = api.tasks.nextCode.useQuery().data;
  const me = api.authSession.me.useQuery().data;
  const people = api.tasks.people.useQuery().data ?? [];
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const students = api.tasks.students.useQuery({ search: debounced }, { enabled: !student }).data ?? [];
  const [picked, setPicked] = useState<{ id: number; name: string; partner: string } | null>(student ?? null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<number>(TaskCategory.DOCUMENT_VERIFICATION);
  const [priority, setPriority] = useState(1);
  const [activity, setActivity] = useState("");
  const [due, setDue] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [status, setStatus] = useState<0 | 1>(0);
  const [assignee, setAssignee] = useState<number | null>(null);
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const create = api.tasks.create.useMutation({
    onSuccess: async (r) => {
      await Promise.all([
        utils.tasks.myDay.invalidate(),
        utils.tasks.list.invalidate(),
        utils.tasks.badge.invalidate(),
        utils.tasks.nextCode.invalidate(),
        utils.shortlistFollowUp.studentTasks.invalidate(),
      ]);
      onDone(`${r.code} created`);
    },
    onError: (e) => setError(e.message),
  });
  const submit = () => {
    setError("");
    if (!title.trim()) return setError("Enter a task name.");
    if (!picked) return setError("Pick the student.");
    if (!activity.trim()) return setError("Describe the pending activity.");
    if (!due) return setError("Pick a due date.");
    create.mutate({
      title: title.trim(),
      studentId: picked.id,
      category,
      priority,
      pendingActivity: activity.trim(),
      dueDate: due,
      followUpDate: followUp || null,
      status,
      assigneeId: assignee,
      remarks: remarks.trim() || null,
    });
  };
  const assignable = people.filter((p) => p.assignable && p.id !== me?.id);
  const req = <span className="text-[#D92D20]"> *</span>;
  return (
    <Modal
      open
      title="Create task"
      onClose={onClose}
      width="w-[680px]"
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={create.isPending} onClick={submit}>
            {create.isPending ? "Creating…" : "Create task"}
          </button>
        </>
      }
    >
      <div className="-mt-2 text-[13px] text-[#667085]">
        Task ID <b className="text-[#344054]">{code ?? "…"}</b> · assigned {fmtWeekday(today)}
      </div>
      <div>
        <label className={LABEL}>Task name{req}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={INPUT} placeholder="e.g. Collect updated SOP and transcript" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="relative">
          <label className={LABEL}>Student / CP ID{req}</label>
          {picked ? (
            <div className="flex items-center justify-between rounded-lg border border-[#D0D5DD] px-3 py-2 text-[13px]">
              <span>
                {picked.name} <span className="ml-1 rounded bg-[#EFF8FF] px-1.5 py-0.5 text-[11px] font-semibold text-[#1570EF]">CP-{picked.id}</span>
              </span>
              {!student && (
                <button type="button" className="cursor-pointer text-[12px] text-[#667085] hover:text-[#1570EF]" onClick={() => setPicked(null)}>
                  Change
                </button>
              )}
            </div>
          ) : (
            <>
              <input value={search} onChange={(e) => setSearch(e.target.value)} className={INPUT} placeholder="Search name or CP-ID" />
              {students.length > 0 && (
                <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-[#E4E7EC] bg-white shadow-lg">
                  {students.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setPicked(s)}
                      className="block w-full cursor-pointer px-3 py-2 text-left text-[13px] hover:bg-[#F5FAFF]"
                    >
                      {s.name} <span className="text-[11px] text-[#98A2B3]">CP-{s.id} · {s.partner}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div>
          <label className={LABEL}>Partner name</label>
          <input value={picked?.partner ?? ""} disabled className={`${INPUT} bg-[#F9FAFB] text-[#475467]`} />
          <div className="mt-1 text-[11px] text-[#667085]">Filled from the student&apos;s record</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={LABEL}>Task category{req}</label>
          <select value={category} onChange={(e) => setCategory(Number(e.target.value))} className={INPUT}>
            {TASK_CATEGORY_CODES.map((c) => (
              <option key={c} value={c}>
                {taskCategoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL}>Priority{req}</label>
          <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-[#D0D5DD]">
            {[2, 1, 0].map((p) => (
              <label
                key={p}
                className={`flex cursor-pointer items-center justify-center gap-1.5 border-r border-[#D0D5DD] py-2 text-[13px] last:border-r-0 ${
                  priority === p ? (p === 2 ? "bg-[#FEE4E2] font-semibold text-[#B42318]" : p === 1 ? "bg-[#FEF0C7] font-semibold text-[#B54708]" : "bg-[#F2F4F7] font-semibold text-[#344054]") : "text-[#344054]"
                }`}
              >
                <input type="radio" checked={priority === p} onChange={() => setPriority(p)} className="accent-[#1570EF]" />
                {["Low", "Medium", "High"][p]}
              </label>
            ))}
          </div>
        </div>
      </div>
      <div>
        <label className={LABEL}>Pending activity{req}</label>
        <input value={activity} onChange={(e) => setActivity(e.target.value)} maxLength={500} className={INPUT} placeholder="What exactly is pending" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={LABEL}>Assigned date</label>
          <input value={fmtWeekday(today)} disabled className={`${INPUT} bg-[#F9FAFB] text-[#475467]`} />
        </div>
        <div>
          <label className={LABEL}>Due date{req}</label>
          <input type="date" min={today} value={due} onChange={(e) => setDue(e.target.value)} className={INPUT} />
        </div>
        <div>
          <label className={LABEL}>Follow-up date</label>
          <input type="date" min={today} value={followUp} onChange={(e) => setFollowUp(e.target.value)} className={INPUT} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={LABEL}>Status</label>
          <select value={status} onChange={(e) => setStatus(Number(e.target.value) as 0 | 1)} className={INPUT}>
            <option value={0}>Pending</option>
            <option value={1}>In Progress</option>
          </select>
          <div className="mt-1 text-[11px] text-[#667085]">Overdue is set automatically after the due date</div>
        </div>
        <div>
          <label className={LABEL}>Assign to</label>
          <select value={assignee ?? ""} onChange={(e) => setAssignee(e.target.value ? Number(e.target.value) : null)} className={INPUT}>
            <option value="">Me{me ? ` (${me.firstName} ${me.lastName})` : ""}</option>
            {assignable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className={LABEL}>Remarks</label>
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={1000} className={INPUT} placeholder="Add any context for this task" />
      </div>
      {error && <div className="text-[13px] text-[#B42318]">{error}</div>}
    </Modal>
  );
}
