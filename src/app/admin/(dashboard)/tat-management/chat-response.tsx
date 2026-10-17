"use client";

import Link from "next/link";
import { api } from "~/trpc/react";
import { StatCard } from "~/components/dashboard/widgets";
import { AdminRole } from "~/server/db/enums";
import { fmtMinutes, type TatStatus } from "~/lib/tat";

// TAT Management → Chat Response: real data from partner chat (src/server/tat.ts,
// routers/tat.ts). The clock runs in business hours only, from the first
// unanswered partner message to the next Collegepond message. Rows follow
// the viewer's student scope.

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-[13px] text-[#344054]";
const CARD = "rounded-xl border border-[#E4E7EC] bg-white";

const STATUS_TONE: Record<TatStatus, { wrap: string; dot: string; timer: string; row: string }> = {
  Breached: { wrap: "bg-[#FEF3F2] text-[#B42318]", dot: "bg-[#F04438]", timer: "text-[#B42318]", row: "bg-[#FEF3F2]" },
  Warning: { wrap: "bg-[#FFFAEB] text-[#B54708]", dot: "bg-[#F79009]", timer: "text-[#B54708]", row: "bg-[#FFFCF5]" },
  "On Track": { wrap: "bg-[#ECFDF3] text-[#027A48]", dot: "bg-[#12B76A]", timer: "text-[#027A48]", row: "" },
};

function StatusBadge({ status }: { status: TatStatus }) {
  const t = STATUS_TONE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${t.wrap}`}>
      <span className={`h-2 w-2 rounded-full ${t.dot}`} />
      {status}
    </span>
  );
}

const dt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

function pctTone(p: number | null) {
  if (p === null) return "text-[#98A2B3]";
  if (p >= 90) return "text-[#027A48]";
  if (p >= 70) return "text-[#B54708]";
  return "text-[#B42318]";
}

export function ChatResponseTat() {
  const q = api.tat.chatOverview.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const role = api.authSession.me.useQuery().data?.role;
  const d = q.data;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">TAT Management</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Chat Response: how quickly Collegepond replies to partners in partner chat.
            {d && (
              <>
                {" "}
                Target {d.target ? fmtMinutes(d.target.thresholdMinutes) : "—"}, warning at {d.target?.warningPct ?? "—"}%, counting business hours only:{" "}
                {d.hours}.
              </>
            )}
          </p>
        </div>
        {role === AdminRole.SUPER_ADMIN && (
          <Link href="/admin/settings?section=tat" className="rounded-lg border border-[#D0D5DD] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]">
            TAT settings
          </Link>
        )}
      </div>

      {q.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">{q.error.message}</div>
      ) : !d ? (
        <div className={`${CARD} px-6 py-12 text-center text-sm text-[#98A2B3]`}>Loading…</div>
      ) : (
        <>
          {d.target && !d.target.active && (
            <div className="mb-4 rounded-lg border border-[#FEC84B] bg-[#FFFAEB] px-4 py-2.5 text-[13px] text-[#B54708]">
              The Chat Response target is paused in Settings, so no warnings or breaches are raised. Reply times are still recorded.
            </div>
          )}
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <StatCard icon="clock" tone="blue" label="Awaiting Reply" value={d.stats.waiting} />
            <StatCard icon="trend-down" tone="orange" label="Warning Zone" value={d.stats.warning} />
            <StatCard icon="bolt" tone="red" label="Breached" value={d.stats.breached} />
            <StatCard icon="check" tone="green" label="Avg Reply (30d)" value={d.stats.avgMinutes30d === null ? "—" : fmtMinutes(d.stats.avgMinutes30d)} />
            <StatCard icon="trophy" tone="purple" label="Within Target (30d)" value={d.stats.compliancePct30d === null ? "—" : `${d.stats.compliancePct30d}%`} />
          </div>

          <div className={`${CARD} mb-6`}>
            <div className="flex items-center gap-2 border-b border-[#E4E7EC] px-5 py-4">
              <h3 className="text-[15px] font-semibold text-[#101828]">Awaiting a Collegepond reply</h3>
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{d.pending.length}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={TH}>Student</th>
                    <th className={TH}>Partner</th>
                    <th className={TH}>Counsellor</th>
                    <th className={TH}>Waiting Since</th>
                    <th className={TH}>Elapsed</th>
                    <th className={TH}>Remaining</th>
                    <th className={TH}>Status</th>
                    <th className={TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {d.pending.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-[#98A2B3]">
                        No partner is waiting for a reply.
                      </td>
                    </tr>
                  ) : (
                    d.pending.map((p) => {
                      const t = STATUS_TONE[p.status];
                      return (
                        <tr key={p.studentId} className={`border-b border-[#F2F4F7] last:border-0 ${t.row}`}>
                          <td className={`${TD} font-semibold text-[#101828]`}>{p.studentName}</td>
                          <td className={TD}>{p.partnerName}</td>
                          <td className={TD}>{p.counsellor ?? <span className="text-[#98A2B3]">Unassigned</span>}</td>
                          <td className={`${TD} whitespace-nowrap text-xs`}>{dt(p.since)}</td>
                          <td className={`${TD} font-mono font-semibold ${t.timer}`}>{fmtMinutes(p.elapsedMinutes)}</td>
                          <td className={`${TD} font-mono font-semibold ${t.timer}`} title={p.dueAt ? `Due ${dt(p.dueAt)}` : undefined}>
                            {p.remainingMinutes < 0 ? `+${fmtMinutes(-p.remainingMinutes)}` : fmtMinutes(p.remainingMinutes)}
                          </td>
                          <td className={TD}>
                            <StatusBadge status={p.status} />
                          </td>
                          <td className={TD}>
                            <Link href={`/admin/partner-chat?student=${p.studentId}`} className="rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]">
                              Open chat
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className={CARD}>
            <div className="flex items-center gap-2 border-b border-[#E4E7EC] px-5 py-4">
              <h3 className="text-[15px] font-semibold text-[#101828]">By counsellor</h3>
              <span className="text-xs text-[#98A2B3]">Replies in the last 30 days, credited to the student&apos;s counsellor at the time</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={TH}>Counsellor</th>
                    <th className={TH}>Replies</th>
                    <th className={TH}>Within Target</th>
                    <th className={TH}>Avg Reply</th>
                    <th className={TH}>Waiting Now</th>
                    <th className={TH}>Overdue Now</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byCounsellor.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-sm text-[#98A2B3]">
                        No partner chat replies yet.
                      </td>
                    </tr>
                  ) : (
                    d.byCounsellor.map((c) => {
                      const pct = c.replies ? Math.round((c.withinTarget / c.replies) * 100) : null;
                      return (
                        <tr key={c.counsellorId ?? "none"} className="border-b border-[#F2F4F7] last:border-0">
                          <td className={`${TD} font-semibold text-[#101828]`}>{c.name}</td>
                          <td className={TD}>{c.replies}</td>
                          <td className={`${TD} font-semibold ${pctTone(pct)}`}>
                            {pct === null ? "—" : `${pct}% (${c.withinTarget}/${c.replies})`}
                          </td>
                          <td className={TD}>{c.avgMinutes === null ? "—" : fmtMinutes(c.avgMinutes)}</td>
                          <td className={TD}>{c.waiting}</td>
                          <td className={`${TD} ${c.overdue ? "font-semibold text-[#B42318]" : ""}`}>{c.overdue}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
