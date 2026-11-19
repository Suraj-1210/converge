"use client";

import Link from "next/link";
import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { ShiftStatus, ShiftStatusLabel, fmtIstDateTime, fmtShortDay, fmtWeekday } from "~/lib/tasks";
import { CARD, Empty, ErrorBox, INPUT, LABEL, Tile, TD, TH } from "~/components/tasks/ui";

// Carry-forward requests (PDF page 6). A Head Counsellor (Counsellor Lead)
// or Super Admin approves or rejects the shifts their counsellors asked for
// at day close; a counsellor sees how theirs were decided.

type View = RouterOutputs["tasks"]["carryForward"];
type Req = View["groups"][number]["requests"][number];

const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;

export function CarryForward({ onToast }: { onToast: (m: string) => void }) {
  const utils = api.useUtils();
  const q = api.tasks.carryForward.useQuery();
  const refresh = () =>
    Promise.all([utils.tasks.carryForward.invalidate(), utils.tasks.myDay.invalidate(), utils.tasks.list.invalidate()]);
  const approveAll = api.tasks.approveAllFirst.useMutation({
    onSuccess: async (r) => {
      await refresh();
      onToast(`${r.approved} request${r.approved === 1 ? "" : "s"} approved`);
    },
    onError: (e) => onToast(e.message),
  });
  if (q.error) return <ErrorBox message={q.error.message} />;
  const v = q.data;
  if (!v) return <Empty>Loading…</Empty>;
  return (
    <div className="space-y-5">
      {v.isHeadCounsellor && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[#667085]">Submitted at day close · approved tasks move to {v.nextWorkingDayLabel}. Original dates are kept for the ageing report.</p>
            <button
              type="button"
              disabled={!v.stats.firstRequests || approveAll.isPending}
              onClick={() => approveAll.mutate()}
              className="cursor-pointer rounded-lg border border-[#12B76A] bg-white px-4 py-2 text-[13px] font-semibold text-[#067647] hover:bg-[#ECFDF3] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Approve all first requests ({v.stats.firstRequests})
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile label="Awaiting decision" value={v.stats.awaiting} tone={v.stats.awaiting ? "orange" : "default"} />
            <Tile label="Incomplete tasks, team" value={v.stats.teamIncomplete} tone={v.stats.teamIncomplete ? "red" : "default"} />
            <Tile label="Team completion today" value={`${v.stats.teamCompletionPct}%`} />
            <Tile label="Repeat postponements" value={v.stats.repeat} />
          </div>
          {v.groups.length === 0 ? (
            <div className={CARD}>
              <Empty>No requests waiting.</Empty>
            </div>
          ) : (
            v.groups.map((g) => (
              <div key={g.counsellorId} className={CARD}>
                <div className="border-b border-[#E4E7EC] bg-[#F9FAFB] px-5 py-3 text-[13px]">
                  <b className="text-[#101828]">{g.name}</b>
                  <span className="text-[#667085]">
                    {" "}
                    · {fmtWeekday(g.day)} · {g.done}/{g.total} done · {g.total - g.done} incomplete · {g.requests.length} request
                    {g.requests.length === 1 ? "" : "s"}
                  </span>
                </div>
                {g.requests.map((r) => (
                  <RequestRow key={r.id} r={r} onToast={onToast} onDone={refresh} />
                ))}
                {g.notRequested.length > 0 && (
                  <div className="border-t border-[#F2F4F7] px-5 py-3 text-[12px] text-[#475467]">
                    <b>Not requested:</b>{" "}
                    {g.notRequested.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && "; "}
                        {r.task.title} ({r.task.code}) — {r.reason.toLowerCase()}, stays overdue
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}
      <div className={CARD}>
        <div className="px-5 py-4">
          <h3 className="text-[15px] font-semibold text-[#101828]">My shift requests</h3>
          <p className="text-[12px] text-[#667085]">The last two weeks. A rejection&apos;s reason comes from your Head Counsellor.</p>
        </div>
        {v.mine.length === 0 ? (
          <Empty>You haven&apos;t asked to shift any task.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Task</th>
                  <th className={TH}>Day</th>
                  <th className={TH}>Reason</th>
                  <th className={TH}>Requested</th>
                  <th className={TH}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {v.mine.map((r) => (
                  <tr key={r.id} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={TD}>
                      <div className="font-semibold text-[#101828]">{r.taskTitle}</div>
                      <div className="text-[11px] text-[#667085]">
                        {r.taskCode} ·{" "}
                        <Link href={`/admin/students/${r.studentId}`} className="hover:text-[#1570EF]">
                          {r.studentName}
                        </Link>
                      </div>
                    </td>
                    <td className={TD}>{fmtShortDay(r.day)}</td>
                    <td className={`${TD} max-w-[280px]`}>
                      <b>{r.reason}:</b> {r.details}
                    </td>
                    <td className={TD}>→ {fmtShortDay(r.newDue)}</td>
                    <td className={TD}>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                          r.status === ShiftStatus.APPROVED
                            ? "bg-[#ECFDF3] text-[#067647]"
                            : r.status === ShiftStatus.REJECTED
                              ? "bg-[#FEF3F2] text-[#B42318]"
                              : "bg-[#FFFAEB] text-[#B54708]"
                        }`}
                      >
                        {ShiftStatusLabel[r.status as ShiftStatus]}
                      </span>
                      {r.rejectReason && <div className="mt-1 text-[12px] text-[#B42318]">“{r.rejectReason}”</div>}
                      {r.decidedAt && <div className="text-[11px] text-[#98A2B3]">{fmtIstDateTime(r.decidedAt)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RequestRow({ r, onToast, onDone }: { r: Req; onToast: (m: string) => void; onDone: () => Promise<unknown> }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const decide = api.tasks.decideShift.useMutation({
    onSuccess: async (res, vars) => {
      await onDone();
      onToast(vars.approve ? `Approved: moves to ${fmtWeekday(res.newDue)}` : "Rejected; the counsellor sees your reason");
    },
    onError: (e) => onToast(e.message),
  });
  return (
    <div className={`border-b border-[#F2F4F7] px-5 py-4 last:border-0 ${rejecting ? "bg-[#FEF3F2]/40" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[260px] flex-1">
          <div className="font-semibold text-[#101828]">{r.task.title}</div>
          <div className="text-[12px] text-[#667085]">
            {r.task.code} · {r.task.studentName} (CP-{r.task.studentId}) · created {fmtShortDay(r.task.assignedOn)} · original due{" "}
            {fmtShortDay(r.task.originalDueDate)}
          </div>
          <div className="mt-1.5 text-[13px] text-[#344054]">
            <b>{r.reason}:</b> {r.details}
          </div>
          <div className="mt-1 text-[12px] text-[#475467]">
            {fmtShortDay(r.fromDue)} → <b>{fmtWeekday(r.newDue)}</b>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {r.postponementNo >= 2 && (
            <span className="rounded-full bg-[#FFF6ED] px-2.5 py-0.5 text-[11px] font-semibold text-[#C4320A]">{ordinal(r.postponementNo)} postponement</span>
          )}
          {r.canDecide && !rejecting && (
            <>
              <button type="button" onClick={() => setRejecting(true)} className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#B42318]">
                Reject
              </button>
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: r.id, approve: true })}
                className="cursor-pointer rounded-lg bg-[#079455] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#067647] disabled:opacity-50"
              >
                Approve
              </button>
            </>
          )}
        </div>
      </div>
      {rejecting && (
        <div className="mt-3">
          <label className={LABEL}>
            Reason for rejection <span className="font-normal text-[#667085]">— shared with the counsellor</span>
          </label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={INPUT} />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setRejecting(false)} className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-[13px] font-semibold text-[#344054]">
              Cancel
            </button>
            <button
              type="button"
              disabled={!reason.trim() || decide.isPending}
              onClick={() => decide.mutate({ id: r.id, approve: false, reason: reason.trim() })}
              className="cursor-pointer rounded-lg bg-[#D92D20] px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
            >
              Confirm rejection
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
