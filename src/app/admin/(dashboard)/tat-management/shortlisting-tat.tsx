"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import { addDays } from "~/lib/follow-ups";
import { fmtMinutes } from "~/lib/tat";
import { fmtIstDateTime } from "~/lib/tasks";

// TAT Management → Shortlisting (item 10, 19 Nov 2026;
// src/server/shortlisting-tat.ts). Students added by partners in the period:
// student added → shortlist shared against the SLA (Settings → TAT Settings,
// 24h by default), weekend hours not counted. Rows follow the viewer's
// Students visibility.

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-[13px] text-[#344054]";
const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const SELECT = "rounded-lg border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-[13px]";
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const dur = (m: number | null | undefined) => (m === null || m === undefined ? "—" : fmtMinutes(m));

const STATUS_TONE: Record<string, string> = {
  Breached: "bg-[#FEF3F2] text-[#B42318]",
  Warning: "bg-[#FFFAEB] text-[#B54708]",
  "On Track": "bg-[#ECFDF3] text-[#027A48]",
};

function Tile({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className={`${CARD} px-5 py-4`}>
      <div className="text-[13px] text-[#475467]">{label}</div>
      <div className={`mt-1 text-[26px] font-bold ${tone ?? "text-[#101828]"}`}>{value}</div>
      {sub && <div className="text-xs text-[#667085]">{sub}</div>}
    </div>
  );
}

export function ShortlistingTat() {
  const today = useMemo(istToday, []);
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [counsellor, setCounsellor] = useState("");
  const q = api.tat.shortlisting.useQuery(
    { from, to: to < from ? from : to, counsellorId: counsellor ? Number(counsellor) : undefined },
    { placeholderData: keepPreviousData, retry: false },
  );
  const d = q.data;
  const counsellors = d?.counsellors ?? [];
  return (
    <div className="mt-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-[#101828]">Shortlisting TAT</h2>
          <p className="mt-1 text-sm text-[#667085]">
            Student added by the partner → shortlist shared with the partner
            {d?.sla ? `, target ${dur(d.sla.minutes)}` : ""}. Saturday and Sunday hours don&apos;t count.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-[#667085]">Added</span>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={SELECT} />
          <span className="text-[12px] text-[#667085]">to</span>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={SELECT} />
          <select value={counsellor} onChange={(e) => setCounsellor(e.target.value)} className={SELECT}>
            <option value="">All counsellors</option>
            {counsellors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {q.error ? (
        <div className={`${CARD} px-5 py-6 text-sm text-[#B42318]`}>{q.error.message}</div>
      ) : !d ? (
        <div className={`${CARD} px-5 py-10 text-center text-sm text-[#98A2B3]`}>Loading…</div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Tile label="Average shortlisting time" value={dur(d.stats.avgMinutes)} sub={`${d.stats.shared} of ${d.stats.students} shared`} />
            <Tile label="Within SLA" value={d.stats.withinSla ?? "—"} tone="text-[#067647]" />
            <Tile label="Exceeding SLA" value={d.stats.exceedingSla ?? "—"} tone={d.stats.exceedingSla ? "text-[#B42318]" : undefined} />
            <Tile label="Pending shortlists" value={d.stats.pending} tone={d.stats.pending ? "text-[#C4320A]" : undefined} sub={d.stats.pendingBreached !== null ? `${d.stats.pendingBreached} past the SLA` : undefined} />
            <Tile
              label="Fastest / slowest"
              value={d.fastest ? dur(d.fastest.avgMinutes) : "—"}
              sub={d.fastest && d.slowest ? `${d.fastest.name} · slowest ${d.slowest.name} (${dur(d.slowest.avgMinutes)})` : undefined}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
            <div className={CARD}>
              <div className="px-5 py-4">
                <h3 className="text-[15px] font-semibold text-[#101828]">Where the time goes</h3>
                <p className="text-[12px] text-[#667085]">Average per step, students with both ends recorded</p>
              </div>
              <table className="w-full border-collapse">
                <tbody>
                  {d.segments.map((s) => (
                    <tr key={s.key} className="border-t border-[#F2F4F7]">
                      <td className={TD}>{s.label}</td>
                      <td className={`${TD} text-right font-semibold`}>{dur(s.avgMinutes)}</td>
                      <td className={`${TD} text-right text-[11px] text-[#98A2B3]`}>{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={CARD}>
              <div className="px-5 py-4">
                <h3 className="text-[15px] font-semibold text-[#101828]">By counsellor</h3>
              </div>
              {counsellors.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-[#98A2B3]">No assigned students in this period.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={TH}>Counsellor</th>
                        <th className={TH}>Shared</th>
                        <th className={TH}>Average</th>
                        <th className={TH}>Fastest</th>
                        <th className={TH}>Slowest</th>
                        <th className={TH}>Within SLA</th>
                        <th className={TH}>Exceeding</th>
                        <th className={TH}>Pending</th>
                      </tr>
                    </thead>
                    <tbody>
                      {counsellors.map((c) => (
                        <tr key={c.id} className="border-b border-[#F2F4F7] last:border-0">
                          <td className={`${TD} font-semibold text-[#101828]`}>{c.name}</td>
                          <td className={TD}>{c.shared}</td>
                          <td className={TD}>{dur(c.avgMinutes)}</td>
                          <td className={TD}>{dur(c.fastestMinutes)}</td>
                          <td className={TD}>{dur(c.slowestMinutes)}</td>
                          <td className={`${TD} text-[#067647]`}>{c.withinSla}</td>
                          <td className={`${TD} ${c.exceedingSla ? "font-semibold text-[#B42318]" : ""}`}>{c.exceedingSla}</td>
                          <td className={TD}>{c.pending}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className={CARD}>
            <div className="flex items-center gap-2 px-5 py-4">
              <h3 className="text-[15px] font-semibold text-[#101828]">Pending shortlists</h3>
              <span className="rounded-full bg-[#FFF6ED] px-2 py-0.5 text-xs font-semibold text-[#C4320A]">{d.pending.length}</span>
              <span className="text-xs text-[#98A2B3]">No shortlist shared yet, oldest first</span>
            </div>
            {d.pending.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-[#98A2B3]">Nothing pending.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={TH}>Student</th>
                      <th className={TH}>Partner</th>
                      <th className={TH}>Counsellor</th>
                      <th className={TH}>Added</th>
                      <th className={TH}>Ageing</th>
                      <th className={TH}>SLA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.pending.map((r) => (
                      <tr key={r.studentId} className="border-b border-[#F2F4F7] last:border-0">
                        <td className={TD}>
                          <Link href={`/admin/students/${r.studentId}?tab=follow-ups`} className="font-semibold text-[#101828] hover:text-[#1570EF]">
                            {r.studentName}
                          </Link>
                          <div className="text-[11px] text-[#98A2B3]">CP-{r.studentId}</div>
                        </td>
                        <td className={TD}>{r.partner}</td>
                        <td className={TD}>{r.counsellor ?? <span className="text-[#98A2B3]">Unassigned</span>}</td>
                        <td className={`${TD} whitespace-nowrap`}>{fmtIstDateTime(r.addedAt)}</td>
                        <td className={`${TD} font-semibold`}>{dur(r.elapsedMinutes)}</td>
                        <td className={TD}>
                          {r.status && <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE[r.status]}`}>{r.status}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
