"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import { DashboardCard } from "~/components/dashboard/widgets";

// Counsellor Lead's Auto Assign switch (decided with Suraj, 14 Oct 2026).
// With it on, new students of the lead's partners that have no Collegepond
// counsellor go to the partner's own counsellor, or else the team's primary
// SPOC. The team and SPOC are set by a Super Admin under Settings ->
// Counselling Teams. Renders nothing for anyone who isn't a lead.
export function AutoAssignCard() {
  const utils = api.useUtils();
  const mineQ = api.counsellingTeams.mine.useQuery();
  const [error, setError] = useState("");
  const setMut = api.counsellingTeams.setAutoAssign.useMutation({
    onSuccess: async () => {
      setError("");
      await utils.counsellingTeams.mine.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const t = mineQ.data;
  if (!t) return null;
  const on = t.autoAssign;
  const canTurnOn = t.primarySpoc !== null;

  return (
    <DashboardCard
      title="Auto Assign"
      className="mb-5"
      headerRight={
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Auto Assign new leads"
          disabled={setMut.isPending || (!on && !canTurnOn)}
          onClick={() => setMut.mutate({ enabled: !on })}
          title={!on && !canTurnOn ? "No primary SPOC set for your team yet" : undefined}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${on ? "bg-[#1570EF]" : "bg-[#D0D5DD]"} disabled:cursor-not-allowed disabled:opacity-50 enabled:cursor-pointer`}
        >
          <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${on ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      }
    >
      <p className="text-sm text-[#344054]">
        {on ? (
          <>
            <strong className="font-semibold text-[#027A48]">On.</strong> New leads from your partners go to the
            partner&apos;s own counsellor, otherwise to your primary SPOC
            {t.primarySpoc ? <> <strong className="font-semibold">{t.primarySpoc.name}</strong></> : null}.
          </>
        ) : (
          <>
            <strong className="font-semibold text-[#667085]">Off.</strong> New leads from your partners stay unassigned
            until you assign them.
          </>
        )}{" "}
        A counsellor you pick by hand always wins.
      </p>
      {!canTurnOn && (
        <p className="mt-2 text-xs text-[#B54708]">
          No primary SPOC is set for your team. A Super Admin can set one under Settings → Counselling Teams.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-[#B42318]">{error}</p>}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Link href="/admin/students" className="rounded-lg border border-[#E4E7EC] px-4 py-3 hover:border-[#1570EF]">
          <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">Unassigned leads</div>
          <div className="mt-1 text-xl font-bold text-[#101828]">{t.unassigned}</div>
        </Link>
        <div className="rounded-lg border border-[#E4E7EC] px-4 py-3">
          <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">Auto-assigned (30 days)</div>
          <div className="mt-1 text-xl font-bold text-[#101828]">{t.autoAssigned30d}</div>
        </div>
        <div className="rounded-lg border border-[#E4E7EC] px-4 py-3">
          <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">Assigned to you</div>
          <div className="mt-1 text-xl font-bold text-[#101828]">{t.ownStudents}</div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">Your team</div>
        {t.members.length === 0 ? (
          <p className="text-sm text-[#98A2B3]">No counsellors report to you yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {t.members.map((m) => (
              <span
                key={m.id}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${m.id === t.primarySpoc?.id ? "bg-[#EFF8FF] text-[#1570EF]" : "bg-[#F2F4F7] text-[#344054]"}`}
              >
                {m.name}
                {m.id === t.primarySpoc?.id ? " · Primary SPOC" : ""} · {m.students} student{m.students === 1 ? "" : "s"}
              </span>
            ))}
          </div>
        )}
      </div>
    </DashboardCard>
  );
}
