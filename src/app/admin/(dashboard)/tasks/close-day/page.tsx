"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { Toast } from "~/components/ui/toast";
import { DELAY_REASONS, ShiftStatus, ShiftStatusLabel, fmtShortDay, fmtWeekday, taskCategoryLabel, type DelayReason } from "~/lib/tasks";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, ErrorBox, INPUT, PriorityBadge } from "~/components/tasks/ui";

// Close your day (PDF page 5). Every task due today or earlier that isn't
// done needs a reason; the counsellor can ask to move it to the next working
// day, which their Head Counsellor approves (emailed on submit). The
// original created and due dates never change. Server: submitCloseDay in
// src/server/tasks.ts.

type Draft = { reason: DelayReason | ""; details: string; shift: boolean };

const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;

export default function CloseDayPage() {
  const utils = api.useUtils();
  const q = api.tasks.closeDay.useQuery();
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [toast, setToast] = useState("");
  const v = q.data;
  useEffect(() => {
    if (!v) return;
    setDrafts((cur) => {
      const next = { ...cur };
      for (const t of v.tasks) {
        if (next[t.id]) continue;
        next[t.id] = {
          reason: (t.request?.reason as DelayReason | undefined) ?? "",
          details: t.request?.details ?? "",
          shift: t.request?.shift ?? false,
        };
      }
      return next;
    });
  }, [v]);
  const submit = api.tasks.submitCloseDay.useMutation({
    onSuccess: async (r, vars) => {
      await Promise.all([utils.tasks.closeDay.invalidate(), utils.tasks.myDay.invalidate(), utils.tasks.carryForward.invalidate()]);
      setToast(vars.draft ? "Draft saved" : r.emailed ? "Submitted. Your Head Counsellor has been emailed." : "Submitted");
    },
    onError: (e) => setToast(e.message),
  });
  const set = (id: number, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }));

  const send = (draft: boolean) => {
    if (!v) return;
    const errs: Record<number, string> = {};
    const items = v.tasks
      .filter((t) => t.request?.status !== ShiftStatus.APPROVED && t.request?.status !== ShiftStatus.REJECTED)
      .map((t) => {
        const d = drafts[t.id] ?? { reason: "", details: "", shift: false };
        if (!draft && !d.reason) errs[t.id] = "Choose a reason";
        else if (!draft && !d.details.trim()) errs[t.id] = "Add details before submitting";
        return { taskId: t.id, reason: d.reason === "" ? "other" : d.reason, details: d.details, shift: d.shift };
      })
      .filter((i) => !draft || drafts[i.taskId]?.reason);
    setErrors(errs);
    if (Object.keys(errs).length) return setToast("Give a reason and details for every task first.");
    if (items.length === 0) return setToast(draft ? "Nothing to save yet" : "Nothing to submit");
    submit.mutate({ draft, items });
  };

  if (q.error) return <ErrorBox message={q.error.message} />;
  const undecided = (t: NonNullable<typeof v>["tasks"][number]) =>
    t.request?.status !== ShiftStatus.APPROVED && t.request?.status !== ShiftStatus.REJECTED;
  const requests = v ? v.tasks.filter((t) => undecided(t) && drafts[t.id]?.shift).length : 0;
  return (
    <div className="max-w-[880px]">
      <Link href="/admin/tasks" className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-[#667085] hover:text-[#1570EF]">
        ← Back to My Tasks
      </Link>
      <h1 className="text-2xl font-bold text-[#101828]">Close your day</h1>
      {!v ? (
        <div className={`${CARD} mt-4 px-6 py-12 text-center text-sm text-[#98A2B3]`}>Loading…</div>
      ) : (
        <>
          <p className="mt-1 text-sm text-[#667085]">
            {fmtWeekday(v.day)} · {v.dayClosed ? "day closed at 7:00 PM" : "day closes at 7:00 PM"} · {v.completed} of {v.total} tasks completed (
            {v.completionPct}%)
            {v.submittedAt && " · submitted, you can still update it"}
          </p>
          {v.tasks.length === 0 ? (
            <div className="mt-5 rounded-xl border border-[#ABEFC6] bg-[#ECFDF3] px-5 py-4 text-[14px] text-[#067647]">
              Nothing left for today. Every task due today or earlier is done.
            </div>
          ) : (
            <>
              <div className="mt-5 rounded-xl border border-[#FDA29B] bg-[#FEF3F2] px-5 py-3 text-[13px] text-[#912018]">
                <b>
                  {v.tasks.length} task{v.tasks.length === 1 ? " was" : "s were"} not completed.
                </b>{" "}
                Give a reason for each. You can ask to move a task to the next working day — your Head Counsellor approves
                it. The original created and due dates never change.
              </div>
              <div className="mt-4 space-y-4">
                {v.tasks.map((t) => {
                  const d = drafts[t.id] ?? { reason: "", details: "", shift: false };
                  const decided = t.request?.status === ShiftStatus.APPROVED || t.request?.status === ShiftStatus.REJECTED;
                  const overdueDays = t.dueDate && t.dueDate < v.today ? Math.round((Date.parse(v.today) - Date.parse(t.dueDate)) / 86_400_000) : 0;
                  return (
                    <div key={t.id} className={`${CARD} border-[#FECDCA] px-5 py-4`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[15px] font-semibold text-[#101828]">{t.title}</span>
                            <span className="rounded-full bg-[#B42318] px-2 py-0.5 text-[11px] font-semibold text-white">
                              {overdueDays ? `Overdue ${overdueDays} day${overdueDays === 1 ? "" : "s"}` : "Due today"}
                            </span>
                            <PriorityBadge priority={t.priority} />
                          </div>
                          <div className="text-[12px] text-[#667085]">
                            {t.code} · {t.studentName} (CP-{t.studentId}) · {t.partner} · {taskCategoryLabel(t.category)}
                          </div>
                        </div>
                        <div className="flex gap-5 text-[12px]">
                          <div>
                            <div className="text-[#667085]">Created</div>
                            <b className="text-[#101828]">{fmtShortDay(t.assignedOn)}</b>
                          </div>
                          <div>
                            <div className="text-[#667085]">Original due</div>
                            <b className="text-[#101828]">{fmtShortDay(t.originalDueDate)}</b>
                          </div>
                          <div>
                            <div className="text-[#667085]">Postponed</div>
                            <b className={t.postponements ? "text-[#C4320A]" : "text-[#101828]"}>
                              {t.postponements}×{t.postponements && t.dueDate ? ` (to ${fmtShortDay(t.dueDate)})` : ""}
                            </b>
                          </div>
                        </div>
                      </div>
                      {decided ? (
                        <div className="mt-3 rounded-lg bg-[#F9FAFB] px-3 py-2 text-[13px] text-[#344054]">
                          Shift request <b>{ShiftStatusLabel[t.request!.status as ShiftStatus].toLowerCase()}</b>
                          {t.request?.rejectReason && <> — “{t.request.rejectReason}”</>}
                        </div>
                      ) : (
                        <>
                          <div className="mt-3 grid gap-3 sm:grid-cols-[220px_1fr]">
                            <div>
                              <div className="mb-1 text-[12px] font-semibold text-[#344054]">
                                Reason <span className="text-[#D92D20]">*</span>
                              </div>
                              <select value={d.reason} onChange={(e) => set(t.id, { reason: e.target.value as DelayReason })} className={INPUT}>
                                <option value="">Select</option>
                                {DELAY_REASONS.map((r) => (
                                  <option key={r.code} value={r.code}>
                                    {r.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <div className="mb-1 text-[12px] font-semibold text-[#344054]">
                                Details <span className="text-[#D92D20]">*</span>
                              </div>
                              <input
                                value={d.details}
                                onChange={(e) => set(t.id, { details: e.target.value })}
                                maxLength={500}
                                placeholder="What's blocking this task?"
                                className={`${INPUT} ${errors[t.id] ? "border-[#D92D20]" : ""}`}
                              />
                              {errors[t.id] && <div className="mt-1 text-[12px] text-[#B42318]">{errors[t.id]}</div>}
                            </div>
                          </div>
                          <label className="mt-3 flex cursor-pointer flex-wrap items-center gap-3 rounded-lg bg-[#F9FAFB] px-3 py-2 text-[13px]">
                            <input type="checkbox" checked={d.shift} onChange={(e) => set(t.id, { shift: e.target.checked })} className="h-4 w-4 accent-[#1570EF]" />
                            <b className="text-[#101828]">Request shift to next working day</b>
                            <span className="text-[#475467]">
                              {d.shift ? (
                                <>
                                  New due: <b>{v.newDueLabel}</b>
                                </>
                              ) : (
                                "Not requested — task stays on today's list as overdue"
                              )}
                            </span>
                            {d.shift && t.postponements > 0 && (
                              <span className="ml-auto text-[12px] font-semibold text-[#C4320A]">This would be the {ordinal(t.postponements + 1)} postponement</span>
                            )}
                            {t.request?.status === ShiftStatus.PENDING && <span className="ml-auto text-[12px] text-[#B54708]">Awaiting decision</span>}
                          </label>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className={`${CARD} mt-4 flex flex-wrap items-center justify-between gap-3 px-5 py-4`}>
                <div className="text-[13px] text-[#475467]">
                  {requests} shift request{requests === 1 ? "" : "s"} will be emailed to{" "}
                  <b>{v.approverNames.join(", ") || "your Head Counsellor"}</b> for approval. Approved tasks move to{" "}
                  {v.newDueLabel}; their original dates are kept for ageing reports.
                </div>
                <div className="flex gap-2">
                  <button type="button" className={BTN_SECONDARY} disabled={submit.isPending} onClick={() => send(true)}>
                    Save draft
                  </button>
                  <button type="button" className={BTN_PRIMARY} disabled={submit.isPending} onClick={() => send(false)}>
                    {submit.isPending ? "Submitting…" : "Submit reasons & requests"}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
      <Toast message={toast} open={!!toast} onClose={() => setToast("")} />
    </div>
  );
}
