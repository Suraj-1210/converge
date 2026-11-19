"use client";

import Link from "next/link";
import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { fmtIstDateTime, fmtWeekday, type FollowUpStage } from "~/lib/tasks";
import { CARD, Empty, ErrorBox, PhaseBadge, Pill, TD, TH } from "~/components/tasks/ui";
import { ConfirmPartnerModal, RecordFollowUpModal, type FollowUpCaseRef } from "~/components/tasks/follow-up-modals";
import { Pipeline } from "./my-day";

type Row = RouterOutputs["tasks"]["followUps"]["rows"][number];

const ACTION: Record<number, string> = { 2: "Record response", 3: "Log call / email / WhatsApp", 4: "Proceed or close" };

function toRef(r: Row): FollowUpCaseRef {
  return {
    caseId: r.caseId,
    stage: r.nextStage as FollowUpStage,
    studentId: r.studentId,
    studentName: r.studentName,
    partner: r.partner,
    sharedAt: r.sharedAt,
    waitingWorkingDays: r.waitingWorkingDays,
    followUpsDone: r.followUpsDone,
    thenDue: r.thenDue,
  };
}

function DueText({ r }: { r: Row }) {
  if (r.dueState === "overdue") {
    return (
      <span className="font-semibold text-[#B42318]">
        Overdue{r.overdueDays ? ` ${r.overdueDays} day${r.overdueDays === 1 ? "" : "s"}` : ""}
      </span>
    );
  }
  if (r.dueState === "today") return <span className="font-semibold text-[#B54708]">Due today</span>;
  return <span className="text-[#475467]">{fmtWeekday(r.nextDue)}</span>;
}

function sub(r: Row) {
  if (r.lastRecorded) return `${r.followUpsDone} follow-up${r.followUpsDone === 1 ? "" : "s"}, no confirmation`;
  if (r.waitingWorkingDays > 1) return `no reply for ${r.waitingWorkingDays} working days`;
  return `shared ${fmtIstDateTime(r.sharedAt)}`;
}

// The cards on My day (compact) and the rows of the Partner follow-ups tab.
export function FollowUpRows({ rows, onToast, compact = false }: { rows: Row[]; onToast: (m: string) => void; compact?: boolean }) {
  const [recording, setRecording] = useState<FollowUpCaseRef | null>(null);
  if (rows.length === 0) return <Empty>No shortlist is waiting on a partner.</Empty>;
  return (
    <>
      <div className="divide-y divide-[#F2F4F7] overflow-hidden rounded-lg border border-[#E4E7EC]">
        {rows.map((r) => {
          const actionable = r.dueState !== "scheduled";
          return (
            <div key={r.caseId} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${r.dueState === "overdue" ? "bg-[#FEF3F2]/60" : ""}`}>
              <div className="min-w-[220px] flex-1">
                <div className="flex items-center gap-2">
                  <Link href={`/admin/students/${r.studentId}?tab=application`} className="text-[14px] font-semibold text-[#101828] hover:text-[#1570EF]">
                    {r.studentName}
                  </Link>
                  <span className="rounded bg-[#EFF8FF] px-1.5 py-0.5 text-[11px] font-semibold text-[#1570EF]">CP-{r.studentId}</span>
                </div>
                <div className="text-[12px] text-[#667085]">
                  Partner: {r.partner} · {sub(r)}
                  {!compact && r.counsellor && <> · {r.counsellor}</>}
                </div>
              </div>
              <PhaseBadge phase={r.phase} label={actionable ? r.nextStageLabel : r.phaseLabel} />
              <div className="w-[120px] text-[12px]">
                <DueText r={r} />
              </div>
              {actionable ? (
                <button
                  type="button"
                  onClick={() => setRecording(toRef(r))}
                  className={`cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-semibold ${
                    r.nextStage === 4 ? "bg-[#1570EF] text-white hover:bg-[#175CD3]" : "border border-[#1570EF] text-[#1570EF] hover:bg-[#F5FAFF]"
                  }`}
                >
                  {ACTION[r.nextStage]}
                </button>
              ) : (
                <span className="rounded-lg border border-[#E4E7EC] px-3 py-1.5 text-[12px] font-semibold text-[#667085]">Scheduled</span>
              )}
            </div>
          );
        })}
      </div>
      {recording && (
        <RecordFollowUpModal
          c={recording}
          onClose={() => setRecording(null)}
          onDone={(m) => {
            setRecording(null);
            onToast(m);
          }}
        />
      )}
    </>
  );
}

export function PartnerFollowUps({ isHead, onToast }: { isHead: boolean; onToast: (m: string) => void }) {
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const q = api.tasks.followUps.useQuery({ scope });
  const [confirming, setConfirming] = useState<Row | null>(null);
  const [recording, setRecording] = useState<FollowUpCaseRef | null>(null);
  if (q.error) return <ErrorBox message={q.error.message} />;
  const b = q.data;
  return (
    <div className="space-y-5">
      {isHead && (
        <div className="flex gap-2">
          <Pill active={scope === "mine"} onClick={() => setScope("mine")}>My students</Pill>
          <Pill active={scope === "team"} onClick={() => setScope("team")}>Team</Pill>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className={CARD}>
          <div className="px-5 py-4">
            <h3 className="text-[15px] font-semibold text-[#101828]">Waiting on partner confirmation</h3>
            <p className="text-[12px] text-[#667085]">
              First follow-up the next working day after the shortlist is shared, then every 3 working days; the third
              is the final one (proceed or close).
            </p>
          </div>
          {!b ? (
            <Empty>Loading…</Empty>
          ) : b.rows.length === 0 ? (
            <Empty>No shortlist is waiting on a partner.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={TH}>Student</th>
                    <th className={TH}>Partner</th>
                    {scope === "team" && <th className={TH}>Counsellor</th>}
                    <th className={TH}>Shared</th>
                    <th className={TH}>Status</th>
                    <th className={TH}>Next</th>
                    <th className={TH}>Last response</th>
                    <th className={TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r) => (
                    <tr key={r.caseId} className={`border-b border-[#F2F4F7] last:border-0 ${r.dueState === "overdue" ? "bg-[#FEF3F2]/60" : ""}`}>
                      <td className={TD}>
                        <Link href={`/admin/students/${r.studentId}?tab=application`} className="font-semibold text-[#101828] hover:text-[#1570EF]">
                          {r.studentName}
                        </Link>
                        <div className="text-[11px] text-[#98A2B3]">CP-{r.studentId}</div>
                      </td>
                      <td className={TD}>{r.partner}</td>
                      {scope === "team" && <td className={TD}>{r.counsellor ?? "—"}</td>}
                      <td className={`${TD} whitespace-nowrap`}>
                        {fmtIstDateTime(r.sharedAt)}
                        <div className="text-[11px] text-[#667085]">{r.waitingWorkingDays} working day{r.waitingWorkingDays === 1 ? "" : "s"}</div>
                      </td>
                      <td className={TD}>
                        <PhaseBadge phase={r.phase} label={r.phaseLabel} />
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        {r.nextStageLabel}
                        <div className="text-[12px]">
                          <DueText r={r} />
                        </div>
                      </td>
                      <td className={`${TD} max-w-[220px] text-[12px] text-[#475467]`}>{r.lastRecorded?.comments ?? "—"}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <div className="flex gap-1.5">
                          {r.dueState !== "scheduled" && (
                            <button type="button" className="cursor-pointer rounded-md bg-[#1570EF] px-2.5 py-1 text-xs font-semibold text-white" onClick={() => setRecording(toRef(r))}>
                              {ACTION[r.nextStage]}
                            </button>
                          )}
                          <button type="button" className="cursor-pointer rounded-md border border-[#12B76A] px-2.5 py-1 text-xs font-semibold text-[#067647]" onClick={() => setConfirming(r)}>
                            Partner confirmed
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className={`${CARD} h-fit px-5 py-4`}>
          <h3 className="text-[15px] font-semibold text-[#101828]">Shortlist pipeline</h3>
          <p className="mb-3 text-[12px] text-[#667085]">{scope === "mine" ? "My students" : "Team"}, by partner-confirmation status</p>
          {b && <Pipeline counts={b.pipeline.counts} />}
          {b && (
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[#F2F4F7] pt-3">
              <div className="rounded-lg bg-[#ECFDF3] px-3 py-2">
                <div className="text-[11px] text-[#067647]">Confirmed this week</div>
                <div className="text-xl font-bold text-[#067647]">{b.pipeline.confirmedThisWeek}</div>
              </div>
              <div className="rounded-lg bg-[#F2F4F7] px-3 py-2">
                <div className="text-[11px] text-[#475467]">Closed this week</div>
                <div className="text-xl font-bold text-[#344054]">{b.pipeline.closedThisWeek}</div>
              </div>
            </div>
          )}
        </div>
      </div>
      {recording && (
        <RecordFollowUpModal
          c={recording}
          onClose={() => setRecording(null)}
          onDone={(m) => {
            setRecording(null);
            onToast(m);
          }}
        />
      )}
      {confirming && (
        <ConfirmPartnerModal
          caseId={confirming.caseId}
          studentId={confirming.studentId}
          studentName={confirming.studentName}
          onClose={() => setConfirming(null)}
          onDone={(m) => {
            setConfirming(null);
            onToast(m);
          }}
        />
      )}
    </div>
  );
}
