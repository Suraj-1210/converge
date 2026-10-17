"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { useExportLog } from "~/lib/export-log";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { Icon } from "~/components/dashboard/widgets";
import { AdminRole } from "~/server/db/enums";
import { DepartmentsPanel } from "./departments-panel";
import { CounsellingTeamsPanel } from "./counselling-teams-panel";
import { PartnerTiersPanel } from "./partner-tiers-panel";
import { TatSettingsPanel } from "./tat-settings-panel";

const SECTIONS = [
  { id: "general", icon: "bolt", label: "General Settings" },
  { id: "notifications", icon: "approvals", label: "Notification Preferences" },
  { id: "data", icon: "applications", label: "Data Management" },
  { id: "fx", icon: "revenue", label: "Exchange Rates" },
  { id: "departments", icon: "partners", label: "Departments" },
  { id: "teams", icon: "students", label: "Counselling Teams" },
  { id: "tiers", icon: "revenue", label: "Partner Tiers" },
  { id: "tat", icon: "clock", label: "TAT Settings" },
  { id: "system", icon: "globe", label: "System Info" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
// Master data only a Super Admin may see or manage.
const SUPER_ADMIN_SECTIONS: readonly SectionId[] = ["departments", "teams", "tiers", "tat"];

const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";

const CURRENCY_OPTS = [
  { value: "INR", label: "INR - Indian Rupee" },
  { value: "USD", label: "USD - US Dollar" },
  { value: "GBP", label: "GBP - British Pound" },
  { value: "EUR", label: "EUR - Euro" },
  { value: "AUD", label: "AUD - Australian Dollar" },
  { value: "CAD", label: "CAD - Canadian Dollar" },
];
const MONTH_OPTS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m) => ({ value: m, label: m }));
const DATE_FMT_OPTS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"].map((d) => ({ value: d, label: d }));
const TZ_OPTS = [
  "Asia/Kolkata (IST, UTC+5:30)", "America/New_York (EST, UTC-5)", "America/Chicago (CST, UTC-6)",
  "America/Los_Angeles (PST, UTC-8)", "Europe/London (GMT, UTC+0)", "Europe/Berlin (CET, UTC+1)",
  "Australia/Sydney (AEST, UTC+11)", "Pacific/Auckland (NZST, UTC+12)", "Asia/Singapore (SGT, UTC+8)", "Asia/Dubai (GST, UTC+4)",
].map((t) => ({ value: t, label: t }));

const NOTIF_DEFS = [
  { key: "email", label: "Email Notifications", desc: "Receive email alerts for important updates and actions" },
  { key: "appStatus", label: "Application Status Updates", desc: "Get notified when student applications change status" },
  { key: "invoice", label: "Invoice Alerts", desc: "Alerts for new invoices, overdue payments, and billing changes" },
  { key: "payment", label: "Payment Confirmations", desc: "Confirmation notifications when payments are received or sent" },
  { key: "events", label: "Event Reminders", desc: "Reminders for upcoming events, deadlines, and scheduled tasks" },
  { key: "system", label: "System Updates", desc: "Notifications about system maintenance, new features, and updates" },
] as const;


function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${on ? "bg-[#1570EF]" : "bg-[#D0D5DD]"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="border-b border-[#F2F4F7] px-5 py-4">
      <h3 className="text-[15px] font-semibold text-[#101828]">{title}</h3>
      <p className="mt-0.5 text-sm text-[#667085]">{desc}</p>
    </div>
  );
}

function AdminNotice({ show, text }: { show: boolean; text: string }) {
  if (!show) return null;
  return <div className="rounded-lg border border-[#FEC84B] bg-[#FFFAEB] px-3.5 py-2 text-xs font-medium text-[#B54708]">⚠ {text}</div>;
}

export default function SettingsPage() {
  const meQ = api.authSession.me.useQuery();
  const statsQ = api.settings.dataStats.useQuery();
  const role = meQ.data?.role;

  const [mounted, setMounted] = useState(false);
  const canEdit = !mounted || role === AdminRole.SUPER_ADMIN;
  const canEditFx = !mounted || role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;

  const isSuperAdmin = role === AdminRole.SUPER_ADMIN;
  const [section, setSection] = useState<SectionId>("general");
  // Gated on `mounted`: the role is only known client-side, and the first
  // client render must match the server's or hydration fails.
  const visibleSections = SECTIONS.filter(
    (s) => (mounted && isSuperAdmin) || !SUPER_ADMIN_SECTIONS.includes(s.id),
  );
  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const toast = (m: string) => { setToastMsg(m); setToastOpen(true); };
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const flashSaved = (key: string) => { setSavedFlash(key); setTimeout(() => setSavedFlash(null), 3000); };

  // General settings (localStorage-persisted)
  const [general, setGeneral] = useState({
    companyName: "Collegepond", adminLogoUrl: "", partnerLogoUrl: "", currency: "INR",
    ayStartMonth: "April", dateFormat: "DD/MM/YYYY", timeZone: TZ_OPTS[0]!.value,
  });
  const [notifs, setNotifs] = useState<Record<string, boolean>>({
    email: true, appStatus: true, invoice: true, payment: true, events: true, system: false,
  });
  const [sysInfo, setSysInfo] = useState<Record<string, string>>({});
  const [editFx, setEditFx] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  // System settings — now DB-backed (system_config), was localStorage.
  const configQ = api.settings.getConfig.useQuery();
  const saveGeneralMut = api.settings.saveGeneral.useMutation({
    onSuccess: () => { flashSaved("general"); toast("Settings saved"); },
    onError: (e) => toast(e.message),
  });
  const saveNotifsMut = api.settings.saveNotifications.useMutation({
    onSuccess: () => { flashSaved("notifications"); toast("Preferences saved"); },
    onError: (e) => toast(e.message),
  });

  // Live exchange rates — real fx_rate table + mid-market feed.
  const utils = api.useUtils();
  const logExport = useExportLog();
  const fxQ = api.fx.list.useQuery();
  const fxRefresh = api.fx.refresh.useMutation({
    onSuccess: async (r) => { await utils.fx.list.invalidate(); toast(`Refreshed ${r.updated} rates from ${r.source}`); },
    onError: (e) => toast(e.message),
  });
  const fxUpdate = api.fx.update.useMutation({
    onSuccess: async () => { await utils.fx.list.invalidate(); setEditFx(null); toast("Rate updated"); },
    onError: (e) => toast(e.message),
  });
  const fxReset = api.fx.reset.useMutation({
    onSuccess: async () => { await utils.fx.list.invalidate(); toast("Reset to live rate"); },
    onError: (e) => toast(e.message),
  });

  // Hydrate the editable state from the DB once the config query resolves.
  useEffect(() => {
    if (configQ.data) {
      setGeneral(configQ.data.general);
      setNotifs(configQ.data.notifications);
    }
  }, [configQ.data]);

  useEffect(() => {
    setMounted(true);
    // Deep link, e.g. /admin/settings?section=departments from the Users form.
    const wanted = new URLSearchParams(window.location.search).get("section");
    const match = SECTIONS.find((s) => s.id === wanted);
    if (match) setSection(match.id);
    // System info (browser-derived)
    const ua = navigator.userAgent;
    const browser = ua.includes("Edg") ? "Edge" : ua.includes("Chrome") ? "Chrome" : ua.includes("Firefox") ? "Firefox" : ua.includes("Safari") ? "Safari" : "Unknown";
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) bytes += k.length + (localStorage.getItem(k)?.length ?? 0);
    }
    setSysInfo({
      sync: new Date().toLocaleString("en-IN"),
      browser,
      platform: navigator.platform,
      screen: `${window.screen.width} × ${window.screen.height}`,
      storage: `${(bytes / 1024).toFixed(1)} KB`,
      keys: String(localStorage.length),
    });
  }, []);

  const saveGeneral = () => saveGeneralMut.mutate(general);
  const saveNotifs = () =>
    saveNotifsMut.mutate({
      email: !!notifs.email, appStatus: !!notifs.appStatus, invoice: !!notifs.invoice,
      payment: !!notifs.payment, events: !!notifs.events, system: !!notifs.system,
    });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ general, notifs }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `collegepond-settings-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(url); logExport("Settings JSON"); toast("Settings exported");
  };
  const importJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const raw = typeof r.result === "string" ? r.result : "";
        const d = JSON.parse(raw) as { general?: object; notifs?: object };
        if (d.general) setGeneral((p) => ({ ...p, ...d.general }));
        if (d.notifs) setNotifs((p) => ({ ...p, ...d.notifs }));
        toast("Settings imported");
      } catch { toast("Invalid settings file"); }
    };
    r.readAsText(f);
  };
  const clearCache = () => {
    for (const k of ["cp_partners", "cp_placements", "cp_reconciliation", "cp_billing", "cp_commission", "cp_tat", "cp_bdm"]) localStorage.removeItem(k);
    setClearOpen(false); toast("Cache cleared");
  };

  const stats = statsQ.data;
  const DATA_STATS = useMemo(() => ([
    { label: "Universities", value: stats?.universities },
    { label: "Programs", value: stats?.programs },
    { label: "Students", value: stats?.students },
    { label: "Invoices", value: stats?.invoices },
    { label: "Events", value: stats?.events },
  ]), [stats]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Settings</h1>
        <p className="mt-1 text-sm text-[#667085]">System configuration and data management</p>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left nav */}
        <nav className="w-full shrink-0 lg:w-56">
          {visibleSections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`mb-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition ${
                section === s.id ? "bg-[#EFF8FF] text-[#1570EF]" : "text-[#344054] hover:bg-[#F9FAFB]"
              }`}
            >
              <span className={`inline-flex h-5 w-5 items-center justify-center [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:fill-none ${section === s.id ? "stroke-[#1570EF]" : "stroke-[#667085]"}`}>
                <Icon name={s.icon} size={18} />
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        {/* Panel */}
        <div className="min-w-0 flex-1">
          {section === "general" && (
            <div className={CARD}>
              <SectionHeader title="General Settings" desc="Configure core application settings and preferences" />
              <div className="space-y-4 p-5">
                <AdminNotice show={!canEdit} text="Admin access required to modify settings" />
                <div className="flex flex-col gap-4 sm:flex-row">
                  <FormInput label="Company Name" value={general.companyName} disabled={!canEdit} onChange={(e) => setGeneral({ ...general, companyName: e.target.value })} />
                  <FormInput label="Admin Logo URL" placeholder="https://example.com/logo.png" value={general.adminLogoUrl} disabled={!canEdit} onChange={(e) => setGeneral({ ...general, adminLogoUrl: e.target.value })} />
                </div>
                <div className="flex flex-col gap-4 sm:flex-row">
                  <FormInput label="Partner Logo URL" placeholder="https://example.com/logo.png" value={general.partnerLogoUrl} disabled={!canEdit} onChange={(e) => setGeneral({ ...general, partnerLogoUrl: e.target.value })} />
                </div>
                <div className="flex flex-col gap-4 sm:flex-row">
                  <FormSelect label="Default Currency" options={CURRENCY_OPTS} value={general.currency} disabled={!canEdit} onChange={(e) => setGeneral({ ...general, currency: e.target.value })} />
                  <FormSelect label="Academic Year Start Month" options={MONTH_OPTS} value={general.ayStartMonth} disabled={!canEdit} onChange={(e) => setGeneral({ ...general, ayStartMonth: e.target.value })} />
                </div>
                <div className="flex flex-col gap-4 sm:flex-row">
                  <FormSelect label="Date Format" options={DATE_FMT_OPTS} value={general.dateFormat} disabled={!canEdit} onChange={(e) => setGeneral({ ...general, dateFormat: e.target.value })} />
                  <FormSelect label="Time Zone" options={TZ_OPTS} value={general.timeZone} disabled={!canEdit} onChange={(e) => setGeneral({ ...general, timeZone: e.target.value })} />
                </div>
                <div className="flex items-center gap-3">
                  <Button onClick={saveGeneral} disabled={!canEdit} loading={saveGeneralMut.isPending}>Save Changes</Button>
                  {savedFlash === "general" && <span className="text-sm font-semibold text-[#067647]">Saved successfully</span>}
                </div>
              </div>
            </div>
          )}

          {section === "notifications" && (
            <div className={CARD}>
              <SectionHeader title="Notification Preferences" desc="Control which notifications you receive" />
              <div className="p-5">
                <AdminNotice show={!canEdit} text="Admin access required to modify notification preferences" />
                <div className="divide-y divide-[#F2F4F7]">
                  {NOTIF_DEFS.map((n) => (
                    <div key={n.key} className="flex items-center justify-between gap-4 py-3.5">
                      <div>
                        <div className="text-sm font-semibold text-[#101828]">{n.label}</div>
                        <div className="text-xs text-[#667085]">{n.desc}</div>
                      </div>
                      <Toggle on={!!notifs[n.key]} disabled={!canEdit} onChange={() => setNotifs({ ...notifs, [n.key]: !notifs[n.key] })} />
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <Button onClick={saveNotifs} disabled={!canEdit} loading={saveNotifsMut.isPending}>Save Preferences</Button>
                  {savedFlash === "notifications" && <span className="text-sm font-semibold text-[#067647]">Saved successfully</span>}
                </div>
              </div>
            </div>
          )}

          {section === "data" && (
            <div className="space-y-6">
              <div className={CARD}>
                <SectionHeader title="Data Management" desc="Export, import, and manage application data" />
                <div className="divide-y divide-[#F2F4F7]">
                  {[
                    { t: "Export All Data", d: "Download a JSON backup of your configuration", btn: "Export JSON", on: exportJson, danger: false },
                    { t: "Import Data", d: "Upload a JSON backup file to restore configuration", btn: "Upload JSON", on: () => document.getElementById("settings-import")?.click(), danger: false },
                    { t: "Clear Cache", d: "Remove cached data (settings and exchange rates are preserved)", btn: "Clear Cache", on: () => setClearOpen(true), danger: true },
                  ].map((row) => (
                    <div key={row.t} className="flex items-center justify-between gap-4 px-5 py-4">
                      <div>
                        <div className="text-sm font-semibold text-[#101828]">{row.t}</div>
                        <div className="text-xs text-[#667085]">{row.d}</div>
                      </div>
                      {row.danger ? (
                        <button disabled={!canEdit} onClick={row.on} className="h-10 rounded-lg border border-[#FDA29B] px-4 text-[13px] font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:cursor-not-allowed disabled:opacity-50">{row.btn}</button>
                      ) : (
                        <Button variant="secondary" disabled={!canEdit} onClick={row.on}>{row.btn}</Button>
                      )}
                    </div>
                  ))}
                </div>
                <input id="settings-import" type="file" accept=".json" className="hidden" onChange={importJson} />
              </div>

              <div className={CARD}>
                <SectionHeader title="Data Statistics" desc="Overview of data stored in the application" />
                <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 lg:grid-cols-5">
                  {DATA_STATS.map((s) => (
                    <div key={s.label} className="rounded-lg border border-[#E4E7EC] p-4 text-center">
                      <div className="text-[26px] font-extrabold text-[#101828]">{s.value ?? "—"}</div>
                      <div className="mt-0.5 text-xs text-[#667085]">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {section === "fx" && (
            <div className="space-y-6">
              <div className={CARD}>
                <SectionHeader title="Exchange Rates" desc="Live mid-market rates with an editable bank margin, used for INR estimates" />
              </div>
              <div className={CARD}>
                <div className="flex items-center justify-between gap-3 border-b border-[#F2F4F7] px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[15px] font-semibold text-[#101828]">Currency Exchange Rates</h3>
                    <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{fxQ.data?.length ?? 0}</span>
                  </div>
                  {canEditFx && <Button variant="secondary" className="!h-9 !text-[13px]" loading={fxRefresh.isPending} onClick={() => fxRefresh.mutate()}>Refresh from feed</Button>}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={TH}>Currency</th>
                        <th className={TH}>Live Mid (INR)</th>
                        <th className={TH}>Margin</th>
                        <th className={TH}>Effective (INR)</th>
                        <th className={TH}>Updated</th>
                        <th className={`${TH} text-right`}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!mounted || fxQ.isLoading ? (
                        <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-[#98A2B3]">Loading rates…</td></tr>
                      ) : (fxQ.data ?? []).map((r) => (
                        <tr key={r.currency} className="border-b border-[#F2F4F7] last:border-0">
                          <td className={`${TD} font-semibold text-[#101828]`}>{r.currency} → INR</td>
                          <td className={TD}>{r.midRate.toFixed(2)}</td>
                          <td className={TD}>{r.manualRate != null ? <span className="text-[#98A2B3]">override</span> : `${r.marginPct}%`}</td>
                          <td className={`${TD} font-semibold text-[#101828]`}>₹{r.effectiveRate.toFixed(2)}</td>
                          <td className={`${TD} text-xs text-[#98A2B3]`}>{r.fetchedAt ? new Date(r.fetchedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
                          <td className={`${TD} text-right`}>
                            {canEditFx ? (
                              <div className="flex items-center justify-end gap-1.5">
                                {r.manualRate != null && (
                                  <Button
                                    variant="secondary"
                                    className="!h-8 !px-3 !text-[12px]"
                                    loading={fxReset.isPending && fxReset.variables?.currency === r.currency}
                                    onClick={() => fxReset.mutate({ currency: r.currency })}
                                    title="Clear the manual override and follow the live feed"
                                  >
                                    Reset
                                  </Button>
                                )}
                                <Button variant="secondary" className="!h-8 !px-3 !text-[12px]" onClick={() => setEditFx(r.currency)}>Edit</Button>
                              </div>
                            ) : (
                              <span className="text-xs text-[#98A2B3]">View only</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="text-xs text-[#98A2B3]">Live mid-market from open.er-api.com; effective rate = mid − your bank margin (or a manual override). Booked amounts should use the realized FIRC rate (separate, with the finance module).</p>
            </div>
          )}

          {section === "departments" && (
            isSuperAdmin ? (
              <DepartmentsPanel toast={toast} />
            ) : (
              <div className={`${CARD} p-5`}>
                <AdminNotice show text={meQ.isLoading ? "Loading…" : "Only Super Admins can view or manage departments"} />
              </div>
            )
          )}

          {section === "teams" && (
            isSuperAdmin ? (
              <CounsellingTeamsPanel toast={toast} />
            ) : (
              <div className={`${CARD} p-5`}>
                <AdminNotice show text={meQ.isLoading ? "Loading…" : "Only Super Admins can view or manage counselling teams"} />
              </div>
            )
          )}

          {section === "tat" && (
            isSuperAdmin ? (
              <TatSettingsPanel toast={toast} />
            ) : (
              <div className={`${CARD} p-5`}>
                <AdminNotice show text={meQ.isLoading ? "Loading…" : "Only Super Admins can view or manage TAT settings"} />
              </div>
            )
          )}

          {section === "tiers" && (
            isSuperAdmin ? (
              <PartnerTiersPanel toast={toast} />
            ) : (
              <div className={`${CARD} p-5`}>
                <AdminNotice show text={meQ.isLoading ? "Loading…" : "Only Super Admins can view or manage partner tiers"} />
              </div>
            )
          )}

          {section === "system" && (
            <div className={CARD}>
              <SectionHeader title="System Information" desc="Technical details about the application environment" />
              <dl className="divide-y divide-[#F2F4F7]">
                {[
                  ["App Version", "1.0.0 (Beta)"],
                  ["Portal Type", "Admin Portal"],
                  ["Last Data Sync", sysInfo.sync ?? "—"],
                  ["Browser", sysInfo.browser ?? "—"],
                  ["Platform", sysInfo.platform ?? "—"],
                  ["Screen Resolution", sysInfo.screen ?? "—"],
                  ["localStorage Usage", sysInfo.storage ?? "—"],
                  ["localStorage Keys", sysInfo.keys ?? "—"],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between px-5 py-3 text-sm">
                    <dt className="text-[#667085]">{k}</dt>
                    <dd className="font-medium text-[#344054]">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>

      {editFx && (() => {
        const row = fxQ.data?.find((r) => r.currency === editFx);
        return row ? <EditFxModal row={row} saving={fxUpdate.isPending} onClose={() => setEditFx(null)} onSave={(marginPct, manualRate) => fxUpdate.mutate({ currency: editFx, marginPct, manualRate })} /> : null;
      })()}
      {clearOpen && (
        <Modal open title="Confirm Clear Cache" onClose={() => setClearOpen(false)}
          footer={<><Button variant="secondary" onClick={() => setClearOpen(false)}>Cancel</Button><button onClick={clearCache} className="h-10 rounded-lg bg-[#D92D20] px-4 text-[13px] font-semibold text-white hover:bg-[#B42318]">Clear Cache</button></>}
        >
          <p className="text-sm text-[#344054]">Cached page data will be removed.</p>
          <p className="mt-2 text-xs text-[#98A2B3]">Settings and exchange rates are preserved. This action cannot be undone.</p>
        </Modal>
      )}
      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}

function EditFxModal({ row, saving, onClose, onSave }: { row: { currency: string; midRate: number; marginPct: number; manualRate: number | null }; saving: boolean; onClose: () => void; onSave: (marginPct: number, manualRate: number | null) => void }) {
  const [margin, setMargin] = useState(String(row.marginPct));
  const [manual, setManual] = useState(row.manualRate != null ? String(row.manualRate) : "");
  const m = Number(margin) || 0;
  const computed = Math.round(row.midRate * (1 - m / 100) * 100) / 100;
  const hasManual = manual.trim() !== "";
  const preview = hasManual ? Number(manual) : computed;
  return (
    <Modal open title={`Edit ${row.currency} → INR`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} onClick={() => onSave(m, hasManual ? Number(manual) : null)}>Save</Button></>}
    >
      <FormInput label="Live mid-market (INR)" value={row.midRate.toFixed(2)} disabled />
      <FormInput label="Bank margin (%)" type="number" step="0.05" value={margin} onChange={(e) => setMargin(e.target.value)} />
      <FormInput label="Manual override (INR) — optional" type="number" step="0.01" placeholder={`Auto: ${computed.toFixed(2)}`} value={manual} onChange={(e) => setManual(e.target.value)} />
      <p className="mt-1 text-xs text-[#667085]">Effective rate: <span className="font-semibold text-[#101828]">₹{(Number.isFinite(preview) ? preview : computed).toFixed(2)}</span> {hasManual ? "(manual override)" : `(mid − ${m}% margin)`}</p>
    </Modal>
  );
}
