"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "~/trpc/react";
import { useUrlState } from "~/lib/url-state";
import { Toast } from "~/components/ui/toast";
import { CreateTaskModal } from "~/components/tasks/create-task-modal";
import { BTN_PRIMARY } from "~/components/tasks/ui";
import { AdminRole } from "~/server/db/enums";
import { fmtWeekday } from "~/lib/tasks";
import { MyDay } from "./my-day";
import { AllTasks } from "./all-tasks";
import { PartnerFollowUps } from "./follow-ups-tab";
import { CarryForward } from "./carry-forward";
import { AgeingReport } from "./ageing";
import { TeamDashboard } from "./team";

// My Tasks (items 7-9, 19 Nov 2026; PDF pages 1, 6, 7). The counselling
// team's one task list: their own tasks, automatic shortlist follow-ups,
// Tasks & Notes reminders and application follow-ups. Head Counsellors
// (Counsellor Leads) and Super Admins also get the carry-forward approvals,
// the ageing report and the team dashboard. Server: src/server/tasks.ts.

const TABS = [
  { id: "day", label: "My day" },
  { id: "all", label: "All tasks" },
  { id: "follow-ups", label: "Partner follow-ups" },
  { id: "carry-forward", label: "Carry-forward requests" },
  { id: "ageing", label: "Ageing report", head: true },
  { id: "team", label: "Team dashboard", head: true },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function MyTasksPage() {
  const [view, setView] = useUrlState({ tab: "day" });
  const role = api.authSession.me.useQuery().data?.role;
  const isHead = role === AdminRole.SUPER_ADMIN || role === AdminRole.COUNSELLOR_LEAD;
  const tabs = TABS.filter((t) => !("head" in t) || isHead);
  const tab: TabId = tabs.some((t) => t.id === view.tab) ? (view.tab as TabId) : "day";
  const day = api.tasks.myDay.useQuery(undefined, { refetchInterval: 60_000 });
  const board = api.tasks.followUps.useQuery({ scope: "mine" }, { refetchInterval: 120_000 });
  // Also for a counsellor covering their lead while the lead is out.
  const cf = api.tasks.carryForward.useQuery();
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState("");
  const onToast = (m: string) => setToast(m);
  const d = day.data;
  const incomplete = d ? d.stats.overdue + d.stats.pending : 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">My Tasks</h1>
          <p className="mt-1 text-sm text-[#667085]">
            {d ? `${fmtWeekday(d.today)} · ${d.isWorkingDay ? "Working day ends 7:00 PM" : "Not a working day"}` : " "}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/tasks/close-day"
            className="inline-flex items-center rounded-lg border border-[#FDA29B] bg-white px-4 py-2 text-[13px] font-semibold text-[#B42318] hover:bg-[#FEF3F2]"
          >
            {d?.closedSubmittedAt ? "Close your day · submitted" : `Close your day${incomplete ? ` (${incomplete})` : ""}`}
          </Link>
          <button type="button" className={BTN_PRIMARY} onClick={() => setCreating(true)}>
            + Create task
          </button>
        </div>
      </div>

      <div className="mb-5 flex gap-1 overflow-x-auto border-b-2 border-[#E4E7EC]">
        {tabs.map((t) => {
          const active = tab === t.id;
          const badge =
            t.id === "follow-ups" ? board.data?.dueCount : t.id === "carry-forward" ? cf.data?.stats.awaiting : undefined;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setView({ tab: t.id })}
              className={`-mb-[2px] flex cursor-pointer items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition ${
                active ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#1570EF]"
              }`}
            >
              {t.label}
              {!!badge && <span className="rounded-full bg-[#FFFAEB] px-1.5 text-[11px] font-bold text-[#B54708]">{badge}</span>}
            </button>
          );
        })}
      </div>

      {tab === "day" && <MyDay query={day} board={board.data} onToast={onToast} onShowFollowUps={() => setView({ tab: "follow-ups" })} />}
      {tab === "all" && <AllTasks isHead={isHead} onToast={onToast} />}
      {tab === "follow-ups" && <PartnerFollowUps isHead={isHead} onToast={onToast} />}
      {tab === "carry-forward" && <CarryForward onToast={onToast} />}
      {tab === "ageing" && isHead && <AgeingReport />}
      {tab === "team" && isHead && <TeamDashboard />}

      {creating && d && (
        <CreateTaskModal
          today={d.today}
          onClose={() => setCreating(false)}
          onDone={(m) => {
            setCreating(false);
            onToast(m);
          }}
        />
      )}
      <Toast message={toast} open={!!toast} onClose={() => setToast("")} />
    </div>
  );
}
