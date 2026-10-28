"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, type RouterOutputs } from "~/trpc/react";
import { SkeletonTable } from "~/components/dashboard/widgets";
import { countryFlag } from "~/components/dashboard/format";
import { UniApplicationStatusLabel } from "~/server/db/enums";
import {
  APPLICATION_STAGE_ORDER,
  CLOSED_STAGES,
  isClosedStage,
  stageTone,
} from "~/lib/application-stages";
import { useUrlState } from "~/lib/url-state";

// Every application across the partner's students (27 Oct testing). The
// server scopes it by the partner access rules: an owner or independent sees
// all of the partner's students, an agency counsellor only theirs. A row opens
// the student's Applications tab, focused on that application.

type Row = RouterOutputs["applications"]["partnerList"][number];

const statusLabel = (s: number) =>
  (UniApplicationStatusLabel as Record<number, string | undefined>)[s] ?? "In progress";

// Stage filter values: a status code, or one of these groups.
const GROUPS: { id: string; label: string; test: (r: Row) => boolean }[] = [
  { id: "open", label: "In progress", test: (r) => !isClosedStage(r.status) },
  { id: "closed", label: "Closed", test: (r) => isClosedStage(r.status) },
  { id: "deferred", label: "Deferred", test: (r) => r.deferredTo !== null },
];

const STAGES = [...APPLICATION_STAGE_ORDER, ...CLOSED_STAGES] as number[];

const TH = "px-4 py-3 text-xs font-semibold whitespace-nowrap text-[#667085]";
const TD = "px-4 py-3 text-[13px] text-[#344054]";

function applicationHref(r: { studentId: number; id: number }): string {
  return `/partner/students/${r.studentId}?tab=applications&app=${r.id}`;
}

export default function PartnerApplicationsPage() {
  const router = useRouter();
  const me = api.auth.me.useQuery(undefined, { retry: false });
  // Bounce away if approval state shifted (mirrors /partner/dashboard).
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/partner/dashboard") router.replace(target);
  }, [me.data?.redirectUrl, router]);

  const list = api.applications.partnerList.useQuery(undefined, { retry: false });
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const [f, setF] = useUrlState({ q: "", stage: "" });
  const showCounsellor = me.data?.kind === "agency";

  // Search first; the stage pills count within the search.
  const searched = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.student} cp-${r.studentId} ${r.university} ${r.program} ${r.counsellor ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [rows, f.q]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of searched) m.set(String(r.status), (m.get(String(r.status)) ?? 0) + 1);
    for (const g of GROUPS) m.set(g.id, searched.filter(g.test).length);
    return m;
  }, [searched]);

  const shown = useMemo(() => {
    if (!f.stage) return searched;
    const group = GROUPS.find((g) => g.id === f.stage);
    return searched.filter(group ? group.test : (r) => String(r.status) === f.stage);
  }, [searched, f.stage]);

  const stageOptions = STAGES.filter((c) => (counts.get(String(c)) ?? 0) > 0);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Applications</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Every university application across your students, at its current stage. Collegepond updates each one as it
          moves.
        </p>
      </div>

      {list.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
          {list.error.message}
        </div>
      ) : (
        <>
          <div className="mb-4 rounded-2xl border border-[#E4E7EC] bg-white p-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex h-[38px] min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-[#D0D5DD] px-3 focus-within:border-[#1570EF] md:max-w-[340px]">
                <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} className="h-4 w-4 shrink-0 stroke-[#98A2B3]">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  value={f.q}
                  onChange={(e) => setF({ q: e.target.value })}
                  placeholder="Search student, CP-ID, university or program"
                  className="w-full border-none bg-transparent text-sm text-[#101828] outline-none placeholder:text-[#98A2B3]"
                />
              </div>
              <select
                aria-label="Stage"
                value={f.stage}
                onChange={(e) => setF({ stage: e.target.value })}
                className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-sm text-[#344054] outline-none hover:border-[#1570EF] focus:border-[#1570EF]"
              >
                <option value="">All stages ({searched.length})</option>
                {GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label} ({counts.get(g.id) ?? 0})
                  </option>
                ))}
                <optgroup label="Stage">
                  {stageOptions.map((c) => (
                    <option key={c} value={String(c)}>
                      {statusLabel(c)} ({counts.get(String(c)) ?? 0})
                    </option>
                  ))}
                </optgroup>
              </select>
              {(f.q || f.stage) && (
                <button
                  type="button"
                  onClick={() => setF({ q: "", stage: "" })}
                  className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
                >
                  Reset
                </button>
              )}
              <span className="ml-auto text-xs text-[#98A2B3]">
                {shown.length} {shown.length === 1 ? "application" : "applications"}
              </span>
            </div>
          </div>

          {/* Stage pills, pipeline order, only stages that have applications */}
          {stageOptions.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              <Pill label={`All (${searched.length})`} active={!f.stage} onClick={() => setF({ stage: "" })} />
              {stageOptions.map((c) => (
                <Pill
                  key={c}
                  label={`${statusLabel(c)} (${counts.get(String(c)) ?? 0})`}
                  active={f.stage === String(c)}
                  onClick={() => setF({ stage: String(c) })}
                />
              ))}
              {(counts.get("deferred") ?? 0) > 0 && (
                <Pill
                  label={`Deferred (${counts.get("deferred")})`}
                  active={f.stage === "deferred"}
                  onClick={() => setF({ stage: "deferred" })}
                />
              )}
            </div>
          )}

          <div className="overflow-x-auto rounded-2xl border border-[#E4E7EC] bg-white">
            {list.isLoading ? (
              <div className="p-4">
                <SkeletonTable rows={6} cols={6} />
              </div>
            ) : (
              <table className="w-full min-w-[960px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-[#E4E7EC] bg-[#F9FAFB]">
                    <th className={TH}>Student</th>
                    {showCounsellor && <th className={TH}>Counsellor</th>}
                    <th className={TH}>University</th>
                    <th className={TH}>Program</th>
                    <th className={TH}>Intake</th>
                    <th className={TH}>Stage</th>
                    <th className={TH} title="Days since the application was started">
                      Days
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr>
                      <td colSpan={showCounsellor ? 7 : 6} className="px-4 py-12 text-center text-sm text-[#98A2B3]">
                        {rows.length === 0
                          ? "No applications yet. Collegepond starts them from each student's shortlist."
                          : "No applications match these filters."}
                      </td>
                    </tr>
                  ) : (
                    shown.map((r) => <AppRow key={r.id} r={r} showCounsellor={showCounsellor} />)
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}

function AppRow({ r, showCounsellor }: { r: Row; showCounsellor: boolean }) {
  const router = useRouter();
  const tone = stageTone(r.status);
  const href = applicationHref(r);
  return (
    <tr
      onClick={() => router.push(href)}
      className="cursor-pointer border-b border-[#F2F4F7] transition-colors last:border-b-0 hover:bg-[#F9FAFB]"
    >
      <td className={TD}>
        <div className="font-semibold text-[#101828]">{r.student}</div>
        <div className="text-[11px] text-[#98A2B3]">CP-{r.studentId}</div>
      </td>
      {showCounsellor && <td className={TD}>{r.counsellor ?? <span className="text-[#98A2B3]">Unassigned</span>}</td>}
      <td className={TD}>
        <div className="max-w-[240px] truncate" title={r.university}>
          {r.country ? `${countryFlag(r.country)} ` : ""}
          {r.university}
        </div>
      </td>
      <td className={TD}>
        <div className="max-w-[260px] truncate" title={r.program}>
          {r.program}
        </div>
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        {r.deferredTo ? (
          <>
            <span className="text-[#98A2B3] line-through">{r.intake ?? "—"}</span>
            <div className="text-[12px] font-semibold text-[#B54708]">Deferred to {r.deferredTo}</div>
          </>
        ) : (
          (r.intake ?? "—")
        )}
      </td>
      <td className={TD}>
        {/* The status opens the same place as the row. */}
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap hover:underline"
          style={{ color: tone.color, background: tone.bg }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.color }} />
          {r.stage}
        </Link>
        {r.daysInStage !== null && (
          <div className="mt-0.5 text-[11px] text-[#98A2B3]">
            {r.daysInStage === 0 ? "Today" : `${r.daysInStage}d at this stage`}
          </div>
        )}
      </td>
      <td className={`${TD} whitespace-nowrap`}>{r.days}d</td>
    </tr>
  );
}

function Pill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
        active
          ? "border-[#1570EF] bg-[#1570EF] text-white"
          : "border-[#E4E7EC] bg-white text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
      }`}
    >
      {label}
    </button>
  );
}
