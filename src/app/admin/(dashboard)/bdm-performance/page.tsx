"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { Toast } from "~/components/ui/toast";
import { StatCard, SkeletonTable } from "~/components/dashboard/widgets";
import { AdminRole, ProspectStage } from "~/server/db/enums";
import { fmtMoney, relDays, PIPE_SEGMENTS, TIER_BADGE, STATUS_BADGE } from "./data";
import { Avatar, CARD, TD, TH } from "./crm-ui";
import { ProspectPipeline } from "./prospect-pipeline";
import { ActivityLog, activityListInput } from "./activity-log";
import { MyTasks } from "./my-tasks";

// Note: this page renders REAL partner data (organizations + their students/applications/
// commissions, grouped by the owner user's bdm_id). The CRM tabs (Prospect Pipeline,
// Activity Log, My Tasks) run on the bdmCrm router and are shown to Super Admin and
// BDM only, matching its server-side access rule. The mock's scorecard, alerts and
// agenda still have no backend and remain out.

const TIER_RANK: Record<string, number> = { Diamond: 5, Titanium: 4, Platinum: 3, Gold: 2, Silver: 1 };
const STATUS_RANK: Record<string, number> = { Active: 3, Pending: 2, Deactivated: 1 };
type ContentTab = "portfolio" | "prospects" | "activity" | "tasks";

export default function BDMPerformancePage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isBdm = mounted && role === AdminRole.BDM;
  const isSuperAdmin = mounted && role === AdminRole.SUPER_ADMIN;
  const canCrm = isBdm || isSuperAdmin;
  const meId = meQ.data?.id;
  const [tab, setTab] = useState<ContentTab>("portfolio");

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const toast = (m: string) => { setToastMsg(m); setToastOpen(true); };

  const [bdm, setBdm] = useState("all");
  const [fType, setFType] = useState("");
  const [fTier, setFTier] = useState("");
  const [applied, setApplied] = useState({ type: "", tier: "" });
  const [sortKey, setSortKey] = useState("revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const bdmsQ = api.bdm.bdms.useQuery();
  const ov = api.bdm.overview.useQuery(bdm === "all" ? undefined : { bdmId: Number(bdm) });

  const partners = useMemo(() => ov.data?.partners ?? [], [ov.data]);
  const leaderboard = ov.data?.leaderboard ?? [];

  const totals = useMemo(() => ({
    partners: partners.length,
    students: partners.reduce((s, p) => s + p.students, 0),
    apps: partners.reduce((s, p) => s + p.apps, 0),
    deposits: partners.reduce((s, p) => s + p.deposits, 0),
    revenue: partners.reduce((s, p) => s + p.revenue, 0),
  }), [partners]);

  const portfolioRows = useMemo(() => {
    const rows = partners.filter((p) => (!applied.type || p.status === applied.type) && (!applied.tier || p.tierLabel === applied.tier));
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (p: (typeof partners)[number]): number | string => {
      switch (sortKey) {
        case "name": return p.name;
        case "tier": return TIER_RANK[p.tierLabel] ?? 0;
        case "status": return STATUS_RANK[p.status] ?? 0;
        case "students": return p.students;
        case "apps": return p.apps;
        case "deposits": return p.deposits;
        case "conversion": return p.conversion;
        case "lastAct": return -(p.lastActDays ?? 99999);
        default: return p.revenue;
      }
    };
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * dir;
      return ((va as number) - (vb as number)) * dir;
    });
  }, [partners, applied, sortKey, sortDir]);

  const pipelineRows = useMemo(
    () => partners.filter((p) => p.pipe.leads + p.pipe.preapp + p.pipe.submitted + p.pipe.offer + p.pipe.deposit > 0).sort((a, b) => b.students - a.students),
    [partners],
  );

  const sortHead = (key: string, label: string) => (
    <th className={`${TH} cursor-pointer select-none hover:text-[#1570EF]`} onClick={() => { if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc")); else { setSortKey(key); setSortDir("desc"); } }}>
      {label} <span className="text-[#98A2B3]">⇅</span>
    </th>
  );

  const loading = !mounted || ov.isLoading;
  // CRM scope: a BDM is pinned to themselves by the server, so they send none.
  // Super Admin follows the BDM selector.
  const crmScope = useMemo(() => (!isBdm && bdm !== "all" ? { bdmId: Number(bdm) } : {}), [isBdm, bdm]);
  const defaultBdmId = !isBdm && bdm !== "all" ? Number(bdm) : undefined;
  // Same inputs the tab components use, so these share their cache.
  const prospectsQ = api.bdmCrm.prospect.list.useQuery(crmScope, { enabled: canCrm });
  const activitiesQ = api.bdmCrm.activity.list.useQuery(activityListInput(crmScope), { enabled: canCrm });
  const taskSummaryQ = api.bdmCrm.task.summary.useQuery(crmScope, { enabled: canCrm });
  const bdmOptions = useMemo(() => (bdmsQ.data?.bdms ?? []).map((b) => ({ id: b.id, name: b.name })), [bdmsQ.data]);
  // A BDM may only attach activities and tasks to their own partners.
  const partnerOptions = useMemo(
    () => partners.filter((p) => !isBdm || p.bdmId === meId).map((p) => ({ id: p.id, name: p.name, city: p.city })),
    [partners, isBdm, meId],
  );
  const prospectOptions = useMemo(
    () => (prospectsQ.data ?? []).filter((p) => p.stage !== ProspectStage.CONVERTED).map((p) => ({ id: p.id, name: p.agencyName })),
    [prospectsQ.data],
  );
  const contentTabs: { id: ContentTab; label: string; count: number }[] = [
    { id: "portfolio", label: "Partner Portfolio", count: portfolioRows.length },
    { id: "prospects", label: "Prospect Pipeline", count: (prospectsQ.data ?? []).filter((p) => p.stage !== ProspectStage.CONVERTED && p.stage !== ProspectStage.LOST).length },
    { id: "activity", label: "Activity Log", count: activitiesQ.data?.length ?? 0 },
    { id: "tasks", label: isSuperAdmin ? "Tasks" : "My Tasks", count: taskSummaryQ.data?.open ?? 0 },
  ];
  const crmProps = { scope: crmScope, isSuperAdmin, defaultBdmId, bdms: bdmOptions, partners: partnerOptions, notify: toast };

  const selectorTabs = [{ id: "all", label: "All BDMs", count: bdmsQ.data?.total ?? 0 }, ...(bdmsQ.data?.bdms ?? []).map((b) => ({ id: String(b.id), label: b.name, count: b.partnerCount }))];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#101828]">BDM Performance</h1>
        <p className="mt-1 text-sm text-[#667085]">{isBdm ? "Your partner portfolio, conversion rates, and revenue performance." : "Track BDM partner portfolios, conversion rates, and revenue performance."}</p>
      </div>

      {/* BDM selector */}
      {!isBdm && (
        <div className="mb-5 flex flex-wrap gap-1 border-b border-[#E4E7EC]">
          {selectorTabs.map((t) => {
            const on = bdm === t.id;
            return (
              <button key={t.id} onClick={() => setBdm(t.id)} className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold ${on ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}>
                {t.label}<span className={`rounded-full px-1.5 py-0.5 text-[11px] ${on ? "bg-[#EFF8FF] text-[#1570EF]" : "bg-[#F2F4F7] text-[#344054]"}`}>{t.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Stat cards — all real aggregates */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard icon="partners" tone="blue" label="Partners" value={totals.partners} />
        <StatCard icon="students" tone="purple" label="Students" value={totals.students} />
        <StatCard icon="applications" tone="orange" label="Applications" value={totals.apps} />
        <StatCard icon="deposit" tone="cyan" label="Deposits" value={totals.deposits} />
        <StatCard icon="revenue" tone="green" label="Revenue" value={fmtMoney(totals.revenue)} />
      </div>

      {/* Leaderboard */}
      {isSuperAdmin && bdm === "all" && (
        <div className={`${CARD} mb-6`}>
          <div className="border-b border-[#E4E7EC] px-5 py-3.5"><h3 className="text-[15px] font-semibold text-[#101828]">BDM Leaderboard</h3></div>
          {leaderboard.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-[#98A2B3]">No BDMs with active partners yet.</div>
          ) : (
            <div className="divide-y divide-[#F2F4F7]">
              {leaderboard.map((l, i) => (
                <div key={l.id} className="flex items-center gap-4 px-5 py-3.5">
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold text-white ${i === 0 ? "bg-[#F79009]" : i === 1 ? "bg-[#98A2B3]" : i === 2 ? "bg-[#B54708]" : "bg-[#D0D5DD]"}`}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[#101828]">{l.name}</div>
                    <div className="text-xs text-[#667085]">{l.partners} active {l.partners === 1 ? "partner" : "partners"} · {l.students} students</div>
                  </div>
                  <div className="text-right"><div className="text-sm font-bold text-[#101828]">{fmtMoney(l.revenue)}</div><div className="text-[11px] text-[#98A2B3]">Revenue</div></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content tabs (CRM users only) */}
      {canCrm && (
        <div className="mb-5 flex flex-wrap gap-1 border-b border-[#E4E7EC]">
          {contentTabs.map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold ${on ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}>
                {t.label}<span className={`rounded-full px-1.5 py-0.5 text-[11px] ${on ? "bg-[#EFF8FF] text-[#1570EF]" : "bg-[#F2F4F7] text-[#344054]"}`}>{t.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {canCrm && tab === "prospects" && <ProspectPipeline {...crmProps} />}
      {canCrm && tab === "activity" && <ActivityLog {...crmProps} prospects={prospectOptions} />}
      {canCrm && tab === "tasks" && <MyTasks {...crmProps} prospects={prospectOptions} />}

      {(!canCrm || tab === "portfolio") && (
      <>
      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <select value={fType} onChange={(e) => setFType(e.target.value)} className="h-9 rounded-lg border border-[#D0D5DD] px-3 text-sm text-[#344054] outline-none focus:border-[#1570EF]"><option value="">All Partner Types</option><option value="Active">Active</option><option value="Pending">Pending</option><option value="Deactivated">Deactivated</option></select>
        <select value={fTier} onChange={(e) => setFTier(e.target.value)} className="h-9 rounded-lg border border-[#D0D5DD] px-3 text-sm text-[#344054] outline-none focus:border-[#1570EF]"><option value="">All Tiers</option><option>Diamond</option><option>Titanium</option><option>Platinum</option><option>Gold</option><option>Silver</option></select>
        <button onClick={() => { setApplied({ type: fType, tier: fTier }); toast("Filters applied"); }} className="h-9 rounded-lg border border-[#1570EF] px-3.5 text-[13px] font-semibold text-[#1570EF] hover:bg-[#EFF8FF]">Apply Filter</button>
        <button onClick={() => { setFType(""); setFTier(""); setApplied({ type: "", tier: "" }); toast("Filters reset"); }} className="h-9 rounded-lg border border-[#D0D5DD] px-3.5 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]">Reset</button>
      </div>

      {/* Portfolio */}
      <div className="space-y-6">
        <div className={CARD}>
          <div className="flex items-center gap-2 border-b border-[#E4E7EC] px-5 py-4"><h3 className="text-[15px] font-semibold text-[#101828]">Partner Portfolio</h3><span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{portfolioRows.length}</span></div>
          <div className="overflow-x-auto">
            {loading ? <div className="p-4"><SkeletonTable rows={6} cols={6} /></div> : (
              <table className="w-full border-collapse">
                <thead><tr>
                  {sortHead("name", "Partner")}{sortHead("tier", "Tier")}{sortHead("status", "Status")}
                  {sortHead("students", "Students")}{sortHead("apps", "Applications")}{sortHead("deposits", "Deposits")}{sortHead("conversion", "Conversion")}
                  {sortHead("revenue", "Revenue")}{sortHead("lastAct", "Last Activity")}<th className={TH}>Actions</th>
                </tr></thead>
                <tbody>
                  {portfolioRows.length === 0 ? (
                    <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-[#98A2B3]">No partners found</td></tr>
                  ) : portfolioRows.map((p) => {
                    const st = STATUS_BADGE[p.status];
                    const convColor = p.apps === 0 ? "text-[#98A2B3]" : p.conversion >= 30 ? "text-[#027A48]" : p.conversion >= 20 ? "text-[#B54708]" : "text-[#B42318]";
                    return (
                      <tr key={p.id} className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#F9FAFB]">
                        <td className={TD}><div className="flex items-center gap-2.5"><Avatar name={p.name} /><div><div className="font-semibold text-[#101828]">{p.name}</div><div className="text-[11px] text-[#98A2B3]">{p.city}</div></div></div></td>
                        <td className={TD}><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TIER_BADGE[p.tierLabel as keyof typeof TIER_BADGE]}`}>{p.tierLabel}</span></td>
                        <td className={TD}><span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.wrap}`}><span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />{p.status}</span></td>
                        <td className={`${TD} font-semibold text-[#101828]`}>{p.students}</td>
                        <td className={TD}>{p.apps}</td>
                        <td className={`${TD} font-semibold text-[#101828]`}>{p.deposits}</td>
                        <td className={`${TD} font-semibold ${convColor}`}>{p.conversion}%</td>
                        <td className={`${TD} font-bold text-[#101828]`}>{fmtMoney(p.revenue)}</td>
                        <td className={`${TD} whitespace-nowrap text-[#98A2B3]`}>{p.lastActDays == null ? "—" : relDays(p.lastActDays)}</td>
                        <td className={TD}><button onClick={() => toast(`Partner detail view for ${p.name} is coming soon`)} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]">View</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {!loading && pipelineRows.length > 0 && (
          <div className={CARD}>
            <div className="border-b border-[#E4E7EC] px-5 py-4"><h3 className="text-[15px] font-semibold text-[#101828]">Pipeline Visualization</h3></div>
            <div className="space-y-3 px-5 py-4">
              {pipelineRows.map((p) => {
                const total = p.pipe.leads + p.pipe.preapp + p.pipe.submitted + p.pipe.offer + p.pipe.deposit;
                return (
                  <div key={p.id} className="flex items-center gap-3">
                    <div className="w-[180px] shrink-0 truncate text-[13px] font-medium text-[#344054]">{p.name}</div>
                    <div className="flex h-6 flex-1 overflow-hidden rounded-md bg-[#F2F4F7]">
                      {PIPE_SEGMENTS.map((seg) => { const v = p.pipe[seg.key]; const w = (v / total) * 100; return v > 0 ? <div key={seg.key} style={{ width: `${w}%`, background: seg.color }} className="flex items-center justify-center text-[10px] font-bold text-white">{v >= 3 ? v : ""}</div> : null; })}
                    </div>
                    <div className="w-8 shrink-0 text-right text-sm font-bold text-[#101828]">{total}</div>
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-4 border-t border-[#F2F4F7] pt-3">
                {PIPE_SEGMENTS.map((s) => <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-[#667085]"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
              </div>
            </div>
          </div>
        )}
      </div>

      </>
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}
