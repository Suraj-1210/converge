"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { Toast } from "~/components/ui/toast";
import { StatCard } from "~/components/dashboard/widgets";
import { ChatResponseTat } from "./chat-response";
import { AdminRole } from "~/server/db/enums";
import { SHOW_DEMO_DATA } from "~/lib/demo";

// TAT Management. Chat Response (partner chat) is the first action measured
// for real (./chat-response.tsx, src/server/tat.ts). The other actions below are
// still illustrative seed data: shown only in local dev, labelled as samples,
// and never in production, until each is wired to the same TAT master.
export default function TATManagementPage() {
  return (
    <div>
      <ChatResponseTat />
      {SHOW_DEMO_DATA && (
        <div className="mt-12 border-t-2 border-dashed border-[#D0D5DD] pt-8">
          <div className="mb-4 rounded-lg border border-[#FEC84B] bg-[#FFFAEB] px-4 py-2.5 text-[13px] font-medium text-[#B54708]">
            Sample data (local dev only): the other TAT actions aren&apos;t wired yet. Nothing below is real.
          </div>
          <TatDashboard />
        </div>
      )}
    </div>
  );
}

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-[13px] text-[#344054]";
const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Cfg = { action: string; thresholdH: number; warningPct: number; esc1: string; esc2: string; active: boolean };
const CONFIG_SEED: Cfg[] = [
  { action: "Chat Response", thresholdH: 2, warningPct: 80, esc1: "Team Lead", esc2: "Ops Manager", active: true },
  { action: "Document Review", thresholdH: 24, warningPct: 75, esc1: "Team Lead", esc2: "Ops Manager", active: true },
  { action: "Application Submission", thresholdH: 48, warningPct: 80, esc1: "Team Lead", esc2: "Super Admin", active: true },
  { action: "University Shortlisting", thresholdH: 72, warningPct: 70, esc1: "Senior Counselor", esc2: "Team Lead", active: true },
  { action: "Offer Processing", thresholdH: 24, warningPct: 80, esc1: "Team Lead", esc2: "Ops Manager", active: true },
  { action: "Visa Document Review", thresholdH: 48, warningPct: 75, esc1: "Team Lead", esc2: "Super Admin", active: true },
  { action: "Partner Response", thresholdH: 12, warningPct: 80, esc1: "BDM", esc2: "Team Lead", active: true },
  { action: "Student Follow-up", thresholdH: 24, warningPct: 75, esc1: "Counselor", esc2: "Team Lead", active: true },
  { action: "Fee Payment Follow-up", thresholdH: 72, warningPct: 80, esc1: "Finance Exec", esc2: "Finance Mgr", active: true },
  { action: "Report Generation", thresholdH: 4, warningPct: 90, esc1: "Content Mgr", esc2: "Super Admin", active: true },
];

type Item = { id: string; name: string; action: string; offsetH: number; thresholdH: number };
const ITEMS_SEED: Item[] = [
  { id: "T1", name: "Ananya Patel", action: "Document Review", offsetH: 30, thresholdH: 24 },
  { id: "T2", name: "Rohan Sharma", action: "Application Submission", offsetH: 52, thresholdH: 48 },
  { id: "T3", name: "Pacific Study Abroad", action: "Partner Response", offsetH: 14, thresholdH: 12 },
  { id: "T4", name: "Priya Joshi", action: "Offer Processing", offsetH: 20, thresholdH: 24 },
  { id: "T5", name: "Sneha Reddy", action: "Visa Document Review", offsetH: 40, thresholdH: 48 },
  { id: "T6", name: "Karthik Iyer", action: "University Shortlisting", offsetH: 58, thresholdH: 72 },
  { id: "T7", name: "Meera Pillai", action: "Student Follow-up", offsetH: 20, thresholdH: 24 },
  { id: "T8", name: "Aditya Verma", action: "Chat Response", offsetH: 0.5, thresholdH: 2 },
  { id: "T9", name: "Kavya Desai", action: "Fee Payment Follow-up", offsetH: 24, thresholdH: 72 },
  { id: "T10", name: "Arjun Nair", action: "Report Generation", offsetH: 1, thresholdH: 4 },
];

const COUNSELORS = ["Rahul Verma", "Sneha Kapoor", "Amit Desai", "Kavita Rao", "Priya Mehta"];
const ACTIONS_SHORT = ["Chat Response", "Document Review", "App Submission", "Uni Shortlisting", "Offer Processing", "Visa Doc Review", "Partner Response", "Student Follow-up", "Fee Payment", "Report Gen"];
// each cell: [pct, done, total]
const MATRIX: [number, number, number][][] = [
  [[95, 19, 20], [82, 14, 17], [78, 7, 9], [65, 11, 17], [90, 9, 10], [85, 17, 20], [92, 12, 13], [88, 15, 17], [72, 13, 18], [100, 5, 5]],
  [[98, 49, 50], [76, 13, 17], [85, 17, 20], [70, 7, 10], [88, 15, 17], [60, 9, 15], [78, 7, 9], [92, 23, 25], [45, 5, 11], [95, 19, 20]],
  [[90, 27, 30], [92, 23, 25], [70, 14, 20], [82, 9, 11], [75, 12, 16], [88, 22, 25], [95, 19, 20], [68, 17, 25], [80, 8, 10], [90, 9, 10]],
  [[88, 22, 25], [70, 7, 10], [92, 11, 12], [55, 11, 20], [82, 9, 11], [78, 14, 18], [85, 17, 20], [90, 18, 20], [65, 13, 20], [88, 7, 8]],
  [[96, 24, 25], [88, 22, 25], [95, 19, 20], [90, 18, 20], [92, 23, 25], [90, 27, 30], [98, 49, 50], [94, 47, 50], [85, 17, 20], [92, 23, 25]],
];

type Recipient = { name: string; email: string; role: string; type: "Full Report" | "Summary" | "Breaches Only"; active: boolean };
const RECIPIENTS_SEED: Recipient[] = [
  { name: "Suraj Bajaj", email: "suraj.bajaj@collegepond.com", role: "Super Admin", type: "Full Report", active: true },
  { name: "Priya Mehta", email: "priya.mehta@collegepond.com", role: "Ops Team Lead", type: "Full Report", active: true },
  { name: "Aarav Kulkarni", email: "aarav.kulkarni@collegepond.com", role: "BDM", type: "Summary", active: true },
  { name: "Neha Sharma", email: "neha.sharma@collegepond.com", role: "Finance Manager", type: "Breaches Only", active: false },
];

const TOP_BREACHES = [
  { item: "Ananya Patel", action: "Document Review", who: "Rahul Verma", overdue: "+12h" },
  { item: "Rohan Sharma", action: "Application Submission", who: "Sneha Kapoor", overdue: "+8h" },
  { item: "Priya Joshi", action: "Offer Processing", who: "Amit Desai", overdue: "+6h" },
  { item: "Pacific Study Abroad", action: "Partner Response", who: "Kavita Rao", overdue: "+4h" },
  { item: "Sneha Reddy", action: "Visa Document Review", who: "Priya Mehta", overdue: "+2h" },
];

type Status = "Breached" | "Warning" | "On Track";
const statusOf = (elapsed: number, threshold: number): Status =>
  elapsed > threshold ? "Breached" : elapsed >= 0.8 * threshold ? "Warning" : "On Track";
const STATUS_TONE: Record<Status, { wrap: string; dot: string; timer: string }> = {
  Breached: { wrap: "bg-[#FEF3F2] text-[#B42318]", dot: "bg-[#F04438]", timer: "text-[#B42318]" },
  Warning: { wrap: "bg-[#FFFAEB] text-[#B54708]", dot: "bg-[#F79009]", timer: "text-[#B54708]" },
  "On Track": { wrap: "bg-[#ECFDF3] text-[#027A48]", dot: "bg-[#12B76A]", timer: "text-[#027A48]" },
};
function fmtDur(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}
function fmtDT(d: Date): string {
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}
function band(pct: number): string {
  if (pct >= 90) return "bg-[#ECFDF3] text-[#027A48]";
  if (pct >= 70) return "bg-[#FFFAEB] text-[#B54708]";
  if (pct >= 50) return "bg-[#FFF6ED] text-[#C4320A]";
  return "bg-[#FEF3F2] text-[#B42318]";
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-[#1570EF]" : "bg-[#D0D5DD]"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}>
      <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${on ? "left-[23px]" : "left-[3px]"}`} />
    </button>
  );
}
function StatusBadge({ status }: { status: Status }) {
  const t = STATUS_TONE[status];
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${t.wrap}`}><span className={`h-2 w-2 rounded-full ${t.dot}`} />{status}</span>;
}
const TABS = ["TAT Configuration", "Aging Analysis", "My TAT Status", "Report Configuration"] as const;

function TatDashboard() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => { setMounted(true); setNow(Date.now()); }, []);
  const canEdit = !mounted || role === AdminRole.SUPER_ADMIN || role === AdminRole.OPERATIONS_LEAD;

  const [tab, setTab] = useState(0);
  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const toast = (m: string) => { setToastMsg(m); setToastOpen(true); };

  // Tab 1 config
  const [config, setConfig] = useState(CONFIG_SEED);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState({ thresholdH: 0, warningPct: 0 });

  // Tab 3 items
  const [items, setItems] = useState(ITEMS_SEED);
  const [fStatus, setFStatus] = useState("");
  const [fAction, setFAction] = useState("");

  // Tab 2 heatmap filter
  const [fHeat, setFHeat] = useState("");

  // Tab 4 schedule + recipients
  const [sendTime, setSendTime] = useState("08:00");
  const [frequency, setFrequency] = useState("daily");
  const [schedActive, setSchedActive] = useState(true);
  const [recipients, setRecipients] = useState(RECIPIENTS_SEED);

  const breachCount = items.filter((it) => statusOf(it.offsetH, it.thresholdH) === "Breached").length;
  const warnCount = items.filter((it) => statusOf(it.offsetH, it.thresholdH) === "Warning").length;
  const resolvedToday = 12 + (ITEMS_SEED.length - items.length);

  const visItems = useMemo(() => items.filter((it) => {
    if (fStatus && statusOf(it.offsetH, it.thresholdH) !== fStatus) return false;
    if (fAction && it.action !== fAction) return false;
    return true;
  }), [items, fStatus, fAction]);

  const visCols = useMemo(() => (fHeat ? [ACTIONS_SHORT.indexOf(fHeat)].filter((i) => i >= 0) : ACTIONS_SHORT.map((_, i) => i)), [fHeat]);
  const rowAvg = (r: number) => Math.round(visCols.reduce((s, c) => s + (MATRIX[r]?.[c]?.[0] ?? 0), 0) / (visCols.length || 1));
  const colAvg = (c: number) => Math.round(MATRIX.reduce((s, row) => s + (row[c]?.[0] ?? 0), 0) / MATRIX.length);
  const grandAvg = Math.round(COUNSELORS.reduce((s, _, r) => s + rowAvg(r), 0) / COUNSELORS.length);

  const startEdit = (i: number) => { setEditIdx(i); const c = config[i]; if (c) setDraft({ thresholdH: c.thresholdH, warningPct: c.warningPct }); };
  const saveEdit = () => {
    if (editIdx === null) return;
    setConfig((p) => p.map((c, i) => (i === editIdx ? { ...c, thresholdH: draft.thresholdH, warningPct: draft.warningPct } : c)));
    setEditIdx(null); toast("Configuration saved for action type");
  };
  const toggleActive = (i: number) => {
    setConfig((p) => p.map((c, j) => (j === i ? { ...c, active: !c.active } : c)));
    const nowActive = !config[i]?.active;
    toast(nowActive ? "Status activated" : "Status paused successfully");
  };
  const complete = (id: string) => { setItems((p) => p.filter((it) => it.id !== id)); toast("Item marked as complete"); };

  const today = mounted && now ? fmtDT(new Date(now)).split(",")[0] ?? "" : "";

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-[#101828]">Other TAT actions (sample)</h2>
        <p className="mt-1 text-sm text-[#667085]">Design preview for the actions not yet measured.</p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard icon="bolt" tone="red" label="Active Breaches" value={breachCount + 4} />
        <StatCard icon="trend-down" tone="orange" label="Warning Zone" value={warnCount + 5} />
        <StatCard icon="check" tone="green" label="Resolved Today" value={resolvedToday} />
        <StatCard icon="clock" tone="blue" label="Avg Response Time" value="14.2h" />
        <StatCard icon="trophy" tone="purple" label="Compliance Rate" value="87%" />
      </div>

      <div className="mb-5 flex gap-1 border-b-2 border-[#E4E7EC]">
        {TABS.map((t, i) => {
          const count = i === 0 ? config.length : i === 2 ? items.length : null;
          const on = tab === i;
          return (
            <button key={t} onClick={() => setTab(i)} className={`-mb-0.5 flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${on ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}>
              {t}
              {count !== null && <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${on ? "bg-[#EFF8FF] text-[#1570EF]" : "bg-[#F2F4F7] text-[#344054]"}`}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* TAB 1 — TAT Configuration */}
      {tab === 0 && (
        <div className={CARD}>
          <div className="flex items-center justify-between gap-3 border-b border-[#E4E7EC] px-5 py-4">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-[#101828]">Action Type Thresholds</h3>
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{config.length}</span>
            </div>
            {canEdit && <button onClick={() => toast("All TAT configurations saved successfully")} className="h-10 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1565d8]">Save Changes</button>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr>
                <th className={TH}>Action Type</th><th className={TH}>Threshold (hours)</th><th className={TH}>Warning at (%)</th>
                <th className={TH}>Escalation Level 1</th><th className={TH}>Escalation Level 2</th><th className={TH}>Status</th><th className={TH}>Actions</th>
              </tr></thead>
              <tbody>
                {config.map((c, i) => {
                  const editing = editIdx === i;
                  return (
                    <tr key={c.action} className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#F9FAFB]">
                      <td className={`${TD} font-semibold text-[#101828]`}>{c.action}</td>
                      <td className={TD}>{editing ? <input type="number" min={1} max={720} value={draft.thresholdH} onChange={(e) => setDraft((d) => ({ ...d, thresholdH: Number(e.target.value) }))} className="w-[70px] rounded-md border border-[#1570EF] bg-[#EFF8FF] px-2 py-1 text-center text-[13px] outline-none" /> : `${c.thresholdH}h`}</td>
                      <td className={TD}>{editing ? <span className="inline-flex items-center gap-1"><input type="number" min={1} max={99} value={draft.warningPct} onChange={(e) => setDraft((d) => ({ ...d, warningPct: Number(e.target.value) }))} className="w-[70px] rounded-md border border-[#1570EF] bg-[#EFF8FF] px-2 py-1 text-center text-[13px] outline-none" />%</span> : `${c.warningPct}%`}</td>
                      <td className={TD}>{c.esc1}</td>
                      <td className={TD}>{c.esc2}</td>
                      <td className={TD}><Toggle on={c.active} disabled={!canEdit} onClick={() => toggleActive(i)} /></td>
                      <td className={TD}>
                        {!canEdit ? <span className="text-xs text-[#98A2B3]">View only</span>
                          : editing ? (
                            <div className="flex gap-2">
                              <button onClick={saveEdit} className="rounded-md bg-[#12B76A] px-3 py-1 text-xs font-semibold text-white hover:bg-[#0e9f5b]">Save</button>
                              <button onClick={() => setEditIdx(null)} className="rounded-md border border-[#D0D5DD] px-3 py-1 text-xs font-semibold text-[#344054] hover:bg-[#F9FAFB]">Cancel</button>
                            </div>
                          ) : <button onClick={() => startEdit(i)} className="rounded-md border border-[#D0D5DD] px-3 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]">Edit</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2 — Aging Analysis */}
      {tab === 1 && (
        <div>
          <div className="mb-4 w-56">
            <select value={fHeat} onChange={(e) => setFHeat(e.target.value)} className="h-[38px] w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]">
              <option value="">All Action Types</option>
              {ACTIONS_SHORT.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className={CARD}>
            <div className="flex items-center gap-2 border-b border-[#E4E7EC] px-5 py-4">
              <h3 className="text-[15px] font-semibold text-[#101828]">Compliance Heatmap</h3>
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">5 Counselors</span>
            </div>
            <div className="overflow-x-auto p-5">
              <table style={{ borderSpacing: 4 }} className="border-separate">
                <thead><tr>
                  <th className="px-2 py-1 text-left text-[11px] font-semibold uppercase text-[#667085]"></th>
                  {visCols.map((c) => <th key={c} className="px-2 py-1 text-center text-[11px] font-semibold text-[#667085]">{ACTIONS_SHORT[c]}</th>)}
                  <th className="px-2 py-1 text-center text-[11px] font-semibold text-[#1570EF]">Avg</th>
                </tr></thead>
                <tbody>
                  {COUNSELORS.map((name, r) => (
                    <tr key={name}>
                      <td className="whitespace-nowrap px-2 py-1 text-[13px] font-semibold text-[#101828]">{name}</td>
                      {visCols.map((c) => {
                        const cell = MATRIX[r]?.[c];
                        if (!cell) return <td key={c} />;
                        const [pct, done, total] = cell;
                        return <td key={c} title={`${done} of ${total} completed within TAT`} className={`h-[50px] w-[80px] rounded-lg text-center text-[13px] font-bold transition-transform hover:scale-105 ${band(pct)}`}>{pct}%</td>;
                      })}
                      <td className={`h-[50px] w-[80px] rounded-lg text-center text-[13px] font-bold ${band(rowAvg(r))}`}>{rowAvg(r)}%</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="px-2 py-1 text-[13px] font-bold text-[#1570EF]">Average</td>
                    {visCols.map((c) => <td key={c} className={`h-[50px] w-[80px] rounded-lg text-center text-[13px] font-bold ${band(colAvg(c))}`}>{colAvg(c)}%</td>)}
                    <td className={`h-[50px] w-[80px] rounded-lg text-center text-[13px] font-bold ${band(grandAvg)}`}>{grandAvg}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3 — My TAT Status */}
      {tab === 2 && (
        <div>
          <div className="mb-4 flex flex-wrap gap-3">
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="h-[38px] w-44 rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]">
              <option value="">All Statuses</option><option>On Track</option><option>Warning</option><option>Breached</option>
            </select>
            <select value={fAction} onChange={(e) => setFAction(e.target.value)} className="h-[38px] w-52 rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]">
              <option value="">All Actions</option>
              {CONFIG_SEED.map((c) => <option key={c.action} value={c.action}>{c.action}</option>)}
            </select>
          </div>
          <div className={CARD}>
            <div className="flex items-center gap-2 border-b border-[#E4E7EC] px-5 py-4">
              <h3 className="text-[15px] font-semibold text-[#101828]">Pending Items</h3>
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{visItems.length}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr>
                  <th className={TH}>Item</th><th className={TH}>Action Required</th><th className={TH}>Assigned At</th><th className={TH}>TAT Threshold</th>
                  <th className={TH}>Time Elapsed</th><th className={TH}>Time Remaining</th><th className={TH}>Status</th><th className={TH}>Actions</th>
                </tr></thead>
                <tbody>
                  {visItems.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-[#98A2B3]">No pending items</td></tr>
                  ) : visItems.map((it) => {
                    const st = statusOf(it.offsetH, it.thresholdH);
                    const tone = STATUS_TONE[st];
                    const rem = it.thresholdH - it.offsetH;
                    const assigned = mounted && now ? fmtDT(new Date(now - it.offsetH * 3600_000)) : "—";
                    return (
                      <tr key={it.id} className={`border-b border-[#F2F4F7] last:border-0 ${st === "Breached" ? "bg-[#FEF3F2]" : st === "Warning" ? "bg-[#FFFCF5]" : "hover:bg-[#F9FAFB]"}`}>
                        <td className={TD}><div className="font-semibold text-[#101828]">{it.name}</div><div className="text-[11px] text-[#98A2B3]">{it.action}</div></td>
                        <td className={TD}>{it.action}</td>
                        <td className={`${TD} whitespace-nowrap text-xs`}>{assigned}</td>
                        <td className={TD}>{it.thresholdH}h</td>
                        <td className={`${TD} font-mono font-semibold ${tone.timer}`}>{fmtDur(it.offsetH)}</td>
                        <td className={`${TD} font-mono font-semibold ${tone.timer}`}>{rem < 0 ? `+${fmtDur(-rem)}` : fmtDur(rem)}</td>
                        <td className={TD}><StatusBadge status={st} /></td>
                        <td className={TD}>
                          <div className="flex gap-1.5">
                            <button onClick={() => complete(it.id)} className="rounded-md bg-[#12B76A] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#0e9f5b]">Complete</button>
                            <button onClick={() => toast("Reassign dialog would open")} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-xs font-semibold text-[#344054] hover:bg-[#F9FAFB]">Reassign</button>
                            <button onClick={() => toast("Snoozed for 2 hours")} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-xs font-semibold text-[#344054] hover:bg-[#F9FAFB]">Snooze</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4 — Report Configuration */}
      {tab === 3 && (
        <div className="space-y-5">
          <div className={`${CARD} p-5`}>
            <h3 className="mb-4 text-[15px] font-semibold text-[#101828]">Schedule Settings</h3>
            <div className="space-y-4">
              <div className="flex items-center gap-4"><span className="w-32 text-sm font-medium text-[#344054]">Send Time</span><input type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} className="h-10 w-36 rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]" /></div>
              <div className="flex items-center gap-4"><span className="w-32 text-sm font-medium text-[#344054]">Frequency</span>
                <div className="flex gap-5">
                  {[["daily", "Daily"], ["weekdays", "Weekdays Only"], ["custom", "Custom"]].map(([v, l]) => (
                    <label key={v} className="flex cursor-pointer items-center gap-2 text-sm text-[#344054]"><input type="radio" name="freq" checked={frequency === v} onChange={() => setFrequency(v!)} className="accent-[#1570EF]" />{l}</label>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-4"><span className="w-32 text-sm font-medium text-[#344054]">Active</span><Toggle on={schedActive} onClick={() => setSchedActive((v) => !v)} /></div>
              <button onClick={() => toast("Report schedule saved successfully")} className="h-10 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1565d8]">Save Schedule</button>
            </div>
          </div>

          <div className={CARD}>
            <div className="border-b border-[#E4E7EC] px-5 py-4"><h3 className="text-[15px] font-semibold text-[#101828]">Recipients</h3></div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr><th className={TH}>Name</th><th className={TH}>Email</th><th className={TH}>Role</th><th className={TH}>Report Type</th><th className={TH}>Status</th></tr></thead>
                <tbody>
                  {recipients.map((r, i) => {
                    const pill = r.type === "Full Report" ? "bg-[#EFF8FF] text-[#1570EF]" : r.type === "Summary" ? "bg-[#F9F5FF] text-[#6941C6]" : "bg-[#FEF3F2] text-[#B42318]";
                    return (
                      <tr key={r.email} className="border-b border-[#F2F4F7] last:border-0">
                        <td className={`${TD} font-semibold text-[#101828]`}>{r.name}</td>
                        <td className={TD}>{r.email}</td>
                        <td className={TD}>{r.role}</td>
                        <td className={TD}><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${pill}`}>{r.type}</span></td>
                        <td className={TD}><Toggle on={r.active} onClick={() => setRecipients((p) => p.map((x, j) => (j === i ? { ...x, active: !x.active } : x)))} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#E4E7EC] px-5 py-3">
              <button onClick={() => toast("Add recipient dialog would open in production")} className="inline-flex items-center gap-1.5 rounded-lg border border-[#D0D5DD] px-3 py-2 text-[13px] font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>Add Recipient
              </button>
            </div>
          </div>

          <div className={`${CARD} p-5`}>
            <h3 className="mb-4 text-[15px] font-semibold text-[#101828]">Email Template Preview</h3>
            <div className="mx-auto max-w-[640px] overflow-hidden rounded-xl border border-[#E4E7EC]">
              <div className="border-b border-[#E4E7EC] bg-[#F9FAFB] px-5 py-3 text-xs text-[#667085]">
                <div>From: Collegepond Admin &lt;noreply@collegepond.com&gt;</div>
                <div className="mt-0.5 font-semibold text-[#344054]">Collegepond TAT Report — {today || "4 Mar 2026"}</div>
              </div>
              <div className="px-6 py-5">
                <div className="mb-2 text-base font-bold text-[#1570EF]">Collegepond TAT Report</div>
                <p className="mb-4 text-sm text-[#475467]">Good morning, here is your daily TAT compliance summary for 4 March 2026.</p>
                <div className="mb-5 grid grid-cols-3 gap-3">
                  {[["7", "Active Breaches", "text-[#B42318]"], ["87%", "Compliance Rate", "text-[#027A48]"], ["14.2h", "Avg Response Time", "text-[#1570EF]"]].map(([v, l, c]) => (
                    <div key={l} className="rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] px-3 py-3 text-center"><div className={`text-xl font-extrabold ${c}`}>{v}</div><div className="mt-0.5 text-[11px] text-[#667085]">{l}</div></div>
                  ))}
                </div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#667085]">Top 5 Breached Items</div>
                <table className="w-full border-collapse text-xs">
                  <thead><tr className="text-left text-[#98A2B3]"><th className="py-1.5">Item</th><th className="py-1.5">Action</th><th className="py-1.5">Assigned To</th><th className="py-1.5 text-right">Overdue By</th></tr></thead>
                  <tbody>
                    {TOP_BREACHES.map((b) => (
                      <tr key={b.item} className="border-t border-[#F2F4F7]"><td className="py-1.5 font-medium text-[#344054]">{b.item}</td><td className="py-1.5 text-[#667085]">{b.action}</td><td className="py-1.5 text-[#667085]">{b.who}</td><td className="py-1.5 text-right font-semibold text-[#B42318]">{b.overdue}</td></tr>
                    ))}
                  </tbody>
                </table>
                <button onClick={() => toast("This is a preview only")} className="mt-4 h-10 w-full rounded-lg bg-[#1570EF] text-[13px] font-semibold text-white hover:bg-[#1565d8]">View Full Report</button>
              </div>
              <div className="border-t border-[#E4E7EC] bg-[#F9FAFB] px-5 py-3 text-center text-[11px] text-[#98A2B3]">Collegepond Admin Portal — This is an automated report. Do not reply to this email.</div>
            </div>
          </div>
        </div>
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}
