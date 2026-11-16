"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { countryName } from "~/components/dashboard/format";
import { Icon } from "~/components/dashboard/widgets";
import { useUrlState } from "~/lib/url-state";
import { useExportLog } from "~/lib/export-log";
import {
  NONE,
  PERIOD_PRESETS,
  REPORT_TABS,
  UniStatusOptions,
  intakeSortKey,
  isIsoDate,
  periodLabel,
  presetRange,
  todayIst,
  type PeriodPreset,
  type ReportFilters,
  type ReportTab,
} from "~/lib/reports";
import { DrillModal } from "./drilldown";
import { buildDoc, docToCsvRows, downloadCsv, downloadPdf, downloadXlsx, fileStamp, filterSummary, type FilterNames, type ReportDoc } from "./export";
import { DrillProvider, type Drill } from "./ui";
import {
  CounsellorTab,
  CountryTab,
  DepositTab,
  IntakeTab,
  OverviewTab,
  PartnerTab,
  RmTab,
  UniversityTab,
  VisaTab,
  WeeklyTab,
} from "./tabs";

// Reports & Analytics (Super Admin only; 16 Nov 2026). Replaces the manual
// weekly B2B Excel report: live figures from the portal, one set of metric
// definitions (~/lib/reports), filters kept in the URL so a report can be
// shared or reloaded for any past period.

const DEFAULTS = {
  tab: "overview",
  period: "all",
  from: "",
  to: "",
  wFrom: "",
  wTo: "",
  intake: "",
  country: "",
  partner: "",
  rm: "",
  counsellor: "",
  university: "",
  vendor: "",
  status: "",
};

const selectCls =
  "h-[38px] w-full min-w-0 rounded-lg border border-[#D0D5DD] bg-white px-2.5 text-[13px] font-medium text-[#344054] outline-none hover:border-[#1570EF] focus:border-[#1570EF]";

function timeOf(iso?: string) {
  return iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";
}

export default function ReportsPage() {
  const [s, set, ready] = useUrlState(DEFAULTS);
  const tab = (REPORT_TABS.some((t) => t.key === s.tab) ? s.tab : "overview") as ReportTab;
  const today = todayIst();

  // Global period → from / to (application submitted date, lead added date).
  const preset = (PERIOD_PRESETS.some((p) => p.key === s.period) ? s.period : "all") as PeriodPreset;
  const range =
    preset === "custom"
      ? isIsoDate(s.from) && isIsoDate(s.to) && s.from <= s.to
        ? { from: s.from, to: s.to }
        : null
      : presetRange(preset, today);

  const filters: ReportFilters = useMemo(
    () => ({
      from: range?.from,
      to: range?.to,
      intake: s.intake || undefined,
      country: s.country || undefined,
      partner: s.partner || undefined,
      rm: s.rm || undefined,
      counsellor: s.counsellor || undefined,
      university: s.university || undefined,
      vendor: s.vendor || undefined,
      status: s.status || undefined,
    }),
    [range?.from, range?.to, s.intake, s.country, s.partner, s.rm, s.counsellor, s.university, s.vendor, s.status],
  );
  const dimFilters: ReportFilters = useMemo(() => ({ ...filters, from: undefined, to: undefined }), [filters]);

  // Weekly tab: its own dates, default the last 7 days.
  const last7 = presetRange("last_7", today)!;
  const wFrom = isIsoDate(s.wFrom) ? s.wFrom : last7.from;
  const wTo = isIsoDate(s.wTo) && s.wTo >= wFrom ? s.wTo : wFrom > last7.to ? wFrom : last7.to;

  const options = api.reports.options.useQuery(undefined, { enabled: ready, staleTime: 5 * 60_000 });
  const reportQ = api.reports.report.useQuery({ filters }, { enabled: ready && tab !== "weekly", placeholderData: (p) => p });
  const weeklyQ = api.reports.weekly.useQuery(
    { filters: dimFilters, from: wFrom, to: wTo },
    { enabled: ready && tab === "weekly", placeholderData: (p) => p },
  );
  const utils = api.useUtils();
  const logExport = useExportLog();

  const names: FilterNames = useMemo(() => {
    const o = options.data;
    const m = (list?: { value: string; label: string }[]) => new Map((list ?? []).map((x) => [x.value, x.label]));
    return { partners: m(o?.partners), rms: m(o?.rms), counsellors: m(o?.counsellors), universities: m(o?.universities) };
  }, [options.data]);

  const [drill, setDrill] = useState<Drill | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [exportOpen]);

  const activeFilterCount = (["intake", "country", "partner", "rm", "counsellor", "university", "vendor", "status"] as const).filter((k) => s[k]).length;
  const generatedAt = tab === "weekly" ? weeklyQ.data?.generatedAt : reportQ.data?.generatedAt;
  const fetching = tab === "weekly" ? weeklyQ.isFetching : reportQ.isFetching;
  const tabLabel = REPORT_TABS.find((t) => t.key === tab)!.label;

  // --- Exports --------------------------------------------------------------
  async function docFor(t: ReportTab): Promise<ReportDoc | null> {
    const list = async (metric: "depositInProcess" | "visaDecisions") =>
      (await utils.reports.drilldown.fetch({ filters, metric, page: 1, pageSize: 5000, sort: "submitted", dir: "desc" })).rows;
    const report = t === "weekly" ? undefined : (reportQ.data ?? (await utils.reports.report.fetch({ filters })));
    const weekly = t === "weekly" ? (weeklyQ.data ?? (await utils.reports.weekly.fetch({ filters: dimFilters, from: wFrom, to: wTo }))) : undefined;
    return buildDoc(t, {
      report,
      weekly,
      depositRows: t === "deposit" ? await list("depositInProcess") : undefined,
      visaRows: t === "visa" ? await list("visaDecisions") : undefined,
      filters: t === "weekly" ? dimFilters : filters,
      names,
    });
  }

  async function runExport(kind: "xlsx" | "xlsx-all" | "csv" | "pdf") {
    setExportOpen(false);
    setExporting(kind);
    try {
      const slug = tabLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (kind === "xlsx-all") {
        const docs = (await Promise.all(REPORT_TABS.map((t) => docFor(t.key)))).filter((d): d is ReportDoc => !!d);
        const file = `converge-b2b-report-${fileStamp()}.xlsx`;
        await downloadXlsx(file, docs);
        logExport(`Reports & Analytics — all tabs (XLSX)`, docs.length);
        return;
      }
      const doc = await docFor(tab);
      if (!doc) return;
      const rows = doc.blocks.reduce((n, b) => n + (b.kind === "table" ? b.rows.length : 0), 0);
      const file = `converge-report-${slug}-${fileStamp()}`;
      if (kind === "xlsx") await downloadXlsx(`${file}.xlsx`, [doc]);
      else if (kind === "csv") downloadCsv(`${file}.csv`, docToCsvRows(doc));
      else await downloadPdf(`${file}.pdf`, doc);
      logExport(`Reports & Analytics — ${tabLabel} (${kind.toUpperCase()})`, rows);
    } finally {
      setExporting(null);
    }
  }

  const o = options.data;
  const intakes = useMemo(() => [...(o?.intakes ?? [])].sort((a, b) => intakeSortKey(a) - intakeSortKey(b) || a.localeCompare(b)), [o?.intakes]);

  return (
    <DrillProvider value={setDrill}>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Reports &amp; Analytics</h1>
          <p className="mt-1 text-sm text-[#667085]">
            B2B performance, live from the portal: leads, applications, offers, deposits and visas. Click any figure for the records behind it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void (tab === "weekly" ? weeklyQ.refetch() : reportQ.refetch())}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] font-medium text-[#344054] hover:bg-[#F9FAFB]"
            title="Reload the figures"
          >
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${fetching ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            Refresh
          </button>
          <div className="relative" ref={exportRef}>
            <button
              type="button"
              onClick={() => setExportOpen((v) => !v)}
              disabled={!!exporting}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-[#1570EF] px-3.5 text-[13px] font-semibold text-white hover:bg-[#175CD3] disabled:opacity-60"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              {exporting ? "Preparing…" : "Export report"}
              <Icon name="chevron-down" size={14} />
            </button>
            {exportOpen && (
              <div className="absolute right-0 z-[60] mt-1 w-[260px] rounded-[10px] border border-[#E4E7EC] bg-white p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
                {(
                  [
                    ["xlsx", `Excel · ${tabLabel}`, "this tab, workbook layout"],
                    ["xlsx-all", "Excel · all tabs", "one sheet per tab, like the weekly workbook"],
                    ["csv", `CSV · ${tabLabel}`, "this tab's figures"],
                    ["pdf", `PDF · ${tabLabel}`, "printable, A4 landscape"],
                  ] as const
                ).map(([k, label, hint]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => void runExport(k)}
                    className="block w-full rounded-md px-3 py-2 text-left hover:bg-[#F0F7FF]"
                  >
                    <span className="block text-[13px] font-medium text-[#101828]">{label}</span>
                    <span className="block text-[11px] text-[#98A2B3]">{hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 rounded-xl border border-[#E4E7EC] bg-white p-4">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          {tab !== "weekly" && (
            <label className="col-span-2 sm:col-span-1">
              <span className="mb-1 block text-[11px] font-semibold tracking-wide text-[#667085] uppercase">Period</span>
              <select
                className={selectCls}
                value={preset}
                onChange={(e) => {
                  const p = e.target.value as PeriodPreset;
                  if (p === "custom") {
                    const cur = range ?? presetRange("this_month", today)!;
                    set({ period: p, from: cur.from, to: cur.to });
                  } else set({ period: p, from: "", to: "" });
                }}
              >
                {PERIOD_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {tab !== "weekly" && preset === "custom" && (
            <>
              <label>
                <span className="mb-1 block text-[11px] font-semibold tracking-wide text-[#667085] uppercase">From</span>
                <input type="date" className={selectCls} value={s.from} max={s.to || undefined} onChange={(e) => set({ from: e.target.value })} />
              </label>
              <label>
                <span className="mb-1 block text-[11px] font-semibold tracking-wide text-[#667085] uppercase">To</span>
                <input type="date" className={selectCls} value={s.to} min={s.from || undefined} onChange={(e) => set({ to: e.target.value })} />
              </label>
            </>
          )}
          <FilterSelect label="Intake" value={s.intake} onChange={(v) => set({ intake: v })} all="All intakes" options={[...intakes.map((i) => ({ value: i, label: i })), { value: NONE, label: "Intake not set" }]} />
          <FilterSelect
            label="Country"
            value={s.country}
            onChange={(v) => set({ country: v })}
            all="All countries"
            options={(o?.countries ?? []).map((c) => ({ value: c, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label))}
          />
          <FilterSelect label="Partner" value={s.partner} onChange={(v) => set({ partner: v })} all="All partners" options={o?.partners ?? []} />
          <FilterSelect label="Relationship Manager" value={s.rm} onChange={(v) => set({ rm: v })} all="All RMs" options={[...(o?.rms ?? []), { value: NONE, label: "Unassigned (no BDM)" }]} />
          <FilterSelect label="Counsellor" value={s.counsellor} onChange={(v) => set({ counsellor: v })} all="All counsellors" options={[...(o?.counsellors ?? []), { value: NONE, label: "Not assigned" }]} />
          <FilterSelect label="University" value={s.university} onChange={(v) => set({ university: v })} all="All universities" options={o?.universities ?? []} />
          <FilterSelect label="Vendor" value={s.vendor} onChange={(v) => set({ vendor: v })} all="All vendors" options={(o?.vendors ?? []).map((v) => ({ value: v, label: v }))} />
          <FilterSelect
            label="Application status"
            value={s.status}
            onChange={(v) => set({ status: v })}
            all="All statuses"
            options={UniStatusOptions.map((x) => ({ value: String(x.value), label: x.label }))}
          />
        </div>
        {(activeFilterCount > 0 || (tab !== "weekly" && preset !== "all")) && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#F2F4F7] pt-3 text-[12px] text-[#667085]">
            <span>{filterSummary(tab === "weekly" ? dimFilters : filters, names, true)}</span>
            <button
              type="button"
              onClick={() => set({ ...DEFAULTS, tab: s.tab, wFrom: s.wFrom, wTo: s.wTo })}
              className="h-8 rounded-lg border border-[#D0D5DD] bg-white px-3 font-medium text-[#667085] hover:bg-[#F9FAFB]"
            >
              Reset filters
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-[#E4E7EC]" role="tablist">
        {REPORT_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => set({ tab: t.key })}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap transition ${
              tab === t.key ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Reporting period + last updated */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-[#667085]">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EFF8FF] px-2.5 py-1 font-semibold text-[#175CD3]">
            <Icon name="calendar" size={13} />
            {tab === "weekly" ? periodLabel(wFrom, wTo) : periodLabel(filters.from, filters.to)}
          </span>
          <span>{tab === "weekly" ? "Weekly report" : tabLabel} · applications by submitted date, leads by date added</span>
        </span>
        <span className="flex items-center gap-1.5" suppressHydrationWarning>
          <span className={`h-2 w-2 rounded-full ${fetching ? "animate-pulse bg-[#F79009]" : "bg-[#12B76A]"}`} />
          {generatedAt ? `Last updated ${timeOf(generatedAt)} · live data` : "Loading…"}
        </span>
      </div>

      {(tab === "weekly" ? weeklyQ.error : reportQ.error) && (
        <div className="mb-5 rounded-xl border border-[#FECDCA] bg-[#FEF3F2] px-4 py-3 text-[13px] text-[#B42318]">
          {(tab === "weekly" ? weeklyQ.error : reportQ.error)?.message}
        </div>
      )}

      {tab === "overview" && <OverviewTab r={reportQ.data} filters={filters} />}
      {tab === "weekly" && (
        <WeeklyTab
          w={weeklyQ.data}
          loading={!weeklyQ.data}
          filters={dimFilters}
          from={wFrom}
          to={wTo}
          setRange={(from, to) => set({ wFrom: from, wTo: to })}
        />
      )}
      {tab === "rm" && <RmTab r={reportQ.data} filters={filters} />}
      {tab === "counsellor" && <CounsellorTab r={reportQ.data} filters={filters} />}
      {tab === "partner" && <PartnerTab r={reportQ.data} filters={filters} />}
      {tab === "country" && <CountryTab r={reportQ.data} filters={filters} />}
      {tab === "university" && <UniversityTab r={reportQ.data} filters={filters} />}
      {tab === "deposit" && <DepositTab r={reportQ.data} filters={filters} />}
      {tab === "visa" && <VisaTab r={reportQ.data} filters={filters} />}
      {tab === "intake" && <IntakeTab r={reportQ.data} filters={filters} />}

      <DrillModal drill={drill} names={names} onClose={() => setDrill(null)} />
    </DrillProvider>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  all,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  all: string;
  options: { value: string; label: string }[];
}) {
  // Keep a value from the URL selectable even before (or without) its option.
  const has = !value || options.some((o) => o.value === value);
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-[11px] font-semibold tracking-wide text-[#667085] uppercase">{label}</span>
      <select className={`${selectCls} ${value ? "border-[#1570EF] bg-[#F5FAFF]" : ""}`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {!has && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
