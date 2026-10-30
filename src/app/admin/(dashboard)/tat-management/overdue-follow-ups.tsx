"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "~/trpc/react";
import { AdminRole } from "~/server/db/enums";
import { fmtDay } from "~/lib/follow-ups";

// TAT Management → Overdue follow-ups (src/server/follow-ups.ts): application
// follow-ups past their date and not done. Rows follow the viewer's
// application scope: a counsellor sees their own, a Counsellor Lead their
// team's and their own, a Super Admin everyone's. A Super Admin can also run
// the daily reminders on demand (it never sends anything twice a day).

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-[13px] text-[#344054]";
const CARD = "rounded-xl border border-[#E4E7EC] bg-white";

export function OverdueFollowUps() {
  const q = api.followUps.overdue.useQuery(undefined, { refetchInterval: 5 * 60_000, retry: false });
  const role = api.authSession.me.useQuery().data?.role;
  const [ran, setRan] = useState<string | null>(null);
  const run = api.followUps.runNow.useMutation({
    onSuccess: (r) => {
      setRan(
        `Reminders run for ${fmtDay(r.today)}: ${r.due} due, ${r.overdueFirst} first overdue (with email), ${r.overdueDaily} daily overdue, ${r.closed} auto-closed${r.noRecipient ? `, ${r.noRecipient} with no counsellor to tell` : ""}.`,
      );
      void q.refetch();
    },
    onError: (e) => setRan(e.message),
  });
  const rows = q.data?.rows ?? [];

  return (
    <div className={`${CARD} mt-6`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[#E4E7EC] px-5 py-4">
        <h3 className="text-[15px] font-semibold text-[#101828]">Overdue follow-ups</h3>
        <span className="rounded-full bg-[#FEF3F2] px-2 py-0.5 text-xs font-semibold text-[#B42318]">{rows.length}</span>
        <span className="text-xs text-[#98A2B3]">Application follow-ups past their date and not marked done</span>
        {role === AdminRole.SUPER_ADMIN && (
          <button
            type="button"
            disabled={run.isPending}
            onClick={() => run.mutate()}
            title="Sends today's due and overdue reminders now. Safe to repeat: nothing is sent twice in a day."
            className="ml-auto cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF] disabled:opacity-50"
          >
            {run.isPending ? "Running…" : "Run reminders now"}
          </button>
        )}
      </div>
      {ran && <div className="border-b border-[#E4E7EC] bg-[#F5FAFF] px-5 py-2.5 text-[13px] text-[#175CD3]">{ran}</div>}
      {q.error ? (
        <div className="px-5 py-6 text-sm text-[#B42318]">{q.error.message}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Student</th>
                <th className={TH}>University / Program</th>
                <th className={TH}>Counsellor</th>
                <th className={TH}>Follow-up</th>
                <th className={TH}>Due Date</th>
                <th className={TH}>Overdue</th>
                <th className={TH}></th>
              </tr>
            </thead>
            <tbody>
              {!q.data ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-[#98A2B3]">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-[#98A2B3]">
                    No overdue follow-ups.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={`${TD} font-semibold text-[#101828]`}>
                      {r.studentName}
                      <div className="text-[11px] font-normal text-[#98A2B3]">CP-{r.studentId}</div>
                    </td>
                    <td className={TD}>
                      {r.university}
                      <div className="text-[12px] text-[#667085]">
                        {r.program} · {r.stage}
                      </div>
                    </td>
                    <td className={TD}>{r.counsellor ?? <span className="text-[#98A2B3]">Unassigned</span>}</td>
                    <td className={TD}>Follow-up {r.seq}</td>
                    <td className={`${TD} whitespace-nowrap`}>{fmtDay(r.dueDate)}</td>
                    <td className={`${TD} whitespace-nowrap font-semibold text-[#B42318]`}>
                      {r.daysOverdue} day{r.daysOverdue === 1 ? "" : "s"}
                    </td>
                    <td className={TD}>
                      <Link
                        href={r.link}
                        className="whitespace-nowrap rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
                      >
                        Open application
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
