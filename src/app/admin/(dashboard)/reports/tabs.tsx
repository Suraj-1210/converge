"use client";

import Link from "next/link";
import { api } from "~/trpc/react";
import { countryName, formatDate } from "~/components/dashboard/format";
import { EmptyState, SkeletonRows, SkeletonTable } from "~/components/dashboard/widgets";
import {
  FUNNEL_STEPS,
  METRICS,
  SUMMARY_METRICS,
  addDays,
  daysInRange,
  fmtIsoDay,
  periodLabel,
  presetRange,
  type AppMetricKey,
  type Dimension,
  type DrillMetric,
  type MetricKey,
  type ReportFilters,
} from "~/lib/reports";
import { StageBadge } from "./drilldown";
import {
  counsellorRows,
  countryRows,
  intakeRows,
  partnerRows,
  rmLeadRows,
  rmRows,
  universityRows,
  vendorRows,
  weeklyShortlistRows,
  type NamedGroup,
  type Report,
  type Weekly,
} from "./derive";
import {
  BreakdownTable,
  Card,
  CountCell,
  HBarChart,
  HowCounted,
  Kpi,
  SERIES,
  TrendChart,
  fmtN,
  useDrill,
  type Column,
  type Drill,
} from "./ui";

const drillOf = (metric: DrillMetric, filters: ReportFilters, scope?: string): Drill => ({
  metric,
  filters,
  title: `${METRICS[metric as MetricKey]?.label ?? FUNNEL_STEPS.find((s) => s.key === metric)?.label ?? metric}${scope ? ` · ${scope}` : ""}`,
});

// Columns for an "X Wise" table: each count opens its records for that
// group (the group is just one more filter).
function metricColumns<R extends NamedGroup>(
  dim: Dimension,
  filters: ReportFilters,
  keys: AppMetricKey[],
  opts: { labels?: Partial<Record<AppMetricKey, string>>; totals?: Partial<Record<AppMetricKey, number>>; totalDrill?: boolean } = {},
): Column<R>[] {
  return keys.map((k) => ({
    key: k,
    label: opts.labels?.[k] ?? METRICS[k].label,
    value: (r: R) => r[k],
    strong: k === "depositPaid" || k === "active",
    total: opts.totals?.[k],
    hint: METRICS[k].rule,
    drill: (r: R | null) =>
      r ? drillOf(k, { ...filters, [dim]: r.key }, r.name) : opts.totalDrill === false ? null : drillOf(k, filters),
  }));
}

const OUTCOMES: AppMetricKey[] = ["active", "activeUnique", "conditional", "unconditional", "depositPaid", "visaApproved", "visaRejected"];
const SHORT: Partial<Record<AppMetricKey, string>> = {
  total: "Overall",
  active: "Active",
  activeUnique: "Active unique",
  conditional: "Conditional",
  unconditional: "Unconditional",
  depositPaid: "Deposit paid",
  visaApproved: "Visa approved",
  visaRejected: "Visa rejected",
  submitted: "Submitted",
  visaFiled: "Visa filed",
};

function Loading() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[118px] animate-pulse rounded-xl border border-[#E4E7EC] bg-white" />
        ))}
      </div>
      <div className="rounded-xl border border-[#E4E7EC] bg-white">
        <SkeletonTable rows={6} cols={6} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
export function OverviewTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  const open = useDrill();
  if (!r) return <Loading />;
  const t = r.totals;
  const k = (metric: AppMetricKey) => drillOf(metric, filters);
  const vr = vendorRows(r);
  const maxFunnel = Math.max(1, ...FUNNEL_STEPS.map((s) => r.funnel[s.key]));
  const src = r.vendorSources;
  return (
    <>
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Total Applications" value={t.total} icon="applications" tone="#1570EF" drill={k("total")} sub="every application, any stage" />
        <Kpi label="Total Active Applications" value={t.active} icon="bolt" tone="#7F56D9" drill={k("active")} sub="submitted or later, student active" />
        <Kpi label="Active Unique Applicants" value={t.activeUnique} icon="students" tone="#6941C6" drill={k("activeUnique")} sub="each active student once" />
        <Kpi label="Leads Received" value={r.leads} icon="partners" tone="#0BA5EC" drill={drillOf("leads", filters)} sub="students added by partners" />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Deposit Paid" value={t.depositPaid} icon="deposit" tone="#F79009" drill={k("depositPaid")} />
        <Kpi label="Visa Filed" value={t.visaFiled} icon="visa" tone="#0BA5EC" drill={k("visaFiled")} />
        <Kpi label="Visa Approved" value={t.visaApproved} icon="check" tone="#12B76A" drill={k("visaApproved")} />
        <Kpi label="Visa Rejected" value={t.visaRejected} icon="trend-down" tone="#F04438" drill={k("visaRejected")} />
        <Kpi label="Deferred" value={t.deferred} icon="calendar" tone="#667085" drill={k("deferred")} sub="to a later intake" />
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-5">
        <Card title="Stage funnel" caption="applications that reached each stage" className="lg:col-span-3">
          <div className="space-y-2.5">
            {FUNNEL_STEPS.map((s, i) => {
              const v = r.funnel[s.key];
              const prev = i > 0 ? r.funnel[FUNNEL_STEPS[i - 1]!.key] : null;
              const pct = v > 0 ? Math.max(6, (v / maxFunnel) * 100) : 0;
              return (
                <div key={s.key} className="flex items-center gap-3">
                  <div className="w-36 shrink-0 text-[13px] font-medium text-[#344054]">{s.label}</div>
                  <button
                    type="button"
                    disabled={!v}
                    onClick={() => open(drillOf(s.key, filters))}
                    className="h-8 flex-1 overflow-hidden rounded-md bg-[#F2F4F7] text-left enabled:cursor-pointer enabled:hover:ring-2 enabled:hover:ring-[#B2DDFF]"
                    title="Show the records"
                  >
                    {v > 0 && (
                      <span
                        className="flex h-full items-center rounded-md pl-2.5 text-xs font-bold text-white animate-[growW_0.7s_ease-out]"
                        style={{ width: `${pct}%`, background: s.color }}
                      >
                        {fmtN(v)}
                      </span>
                    )}
                  </button>
                  <div className="w-12 shrink-0 text-right text-[11px] text-[#98A2B3]" title="of the stage before">
                    {prev ? `${Math.round((v / prev) * 100)}%` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        <Card title="Full metric summary" caption="current stage" className="lg:col-span-2" flush>
          <ul>
            {SUMMARY_METRICS.map((m) => {
              const v = m === "leads" ? r.leads : t[m as AppMetricKey];
              return (
                <li key={m} className="flex items-center justify-between border-b border-[#F2F4F7] px-5 py-1.5 text-[13px] last:border-0">
                  <span className="text-[#475467]" title={METRICS[m].rule}>
                    {METRICS[m].label}
                  </span>
                  <CountCell value={v} drill={drillOf(m, filters)} strong={m === "total" || m === "active"} />
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card
        title="Processing vendor"
        caption={`source: ${src.contract} commission contract · ${src.text} typed by counsellor · ${src.none} not set`}
        className="mb-5"
        flush
      >
        <BreakdownTable
          rows={vr}
          nameLabel="Vendor"
          name={(x) => x.name}
          rank={false}
          columns={metricColumns("vendor", filters, ["total", "active", "conditional", "unconditional", "depositPaid", "visaFiled", "visaApproved"], {
            labels: SHORT,
            totals: { total: t.total },
          })}
        />
      </Card>

      <HowCounted metrics={[...SUMMARY_METRICS, "leads"]} funnel />
    </>
  );
}

// ---------------------------------------------------------------------------
// RM / Partner / Country / University / Intake: chart + table
// ---------------------------------------------------------------------------
function DimensionTab({
  r,
  filters,
  dim,
  rows,
  nameLabel,
  tableTitle,
  chartTitle,
  chart,
  columns,
  totals,
  totalDrill,
  rank = true,
  rules,
  caption,
  note,
}: {
  r: Report;
  filters: ReportFilters;
  dim: Dimension;
  rows: NamedGroup[];
  nameLabel: string;
  tableTitle: string;
  chartTitle: string;
  chart: AppMetricKey[];
  columns: AppMetricKey[];
  totals?: Partial<Record<AppMetricKey, number>>;
  totalDrill?: boolean;
  rank?: boolean;
  rules: MetricKey[];
  caption: string;
  note?: string;
}) {
  return (
    <>
      <Card title={chartTitle} className="mb-5" caption={caption}>
        <HBarChart
          rows={rows}
          name={(x) => x.name}
          series={chart.map((k) => ({
            key: k,
            label: METRICS[k].label,
            color: SERIES[k] ?? "#1570EF",
            value: (x: NamedGroup) => x[k],
            drill: (x: NamedGroup) => drillOf(k, { ...filters, [dim]: x.key }, x.name),
          }))}
        />
      </Card>
      <Card title={tableTitle} caption={`${rows.length} · click a count for its records`} flush>
        <BreakdownTable
          rows={rows}
          rank={rank}
          nameLabel={nameLabel}
          name={(x) => (dim === "country" ? countryName(x.key) || x.name : x.name)}
          columns={metricColumns(dim, filters, columns, { labels: SHORT, totals: totals ?? { activeUnique: r.totals.activeUnique }, totalDrill })}
        />
      </Card>
      {note && <p className="mt-3 text-[12px] text-[#667085]">{note}</p>}
      <HowCounted metrics={rules} />
    </>
  );
}

export function RmTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  if (!r) return <Loading />;
  return (
    <DimensionTab
      r={r}
      filters={filters}
      dim="rm"
      rows={rmRows(r)}
      nameLabel="Relationship Manager"
      tableTitle="All relationship managers"
      chartTitle="RM comparison"
      caption="RM = the partner's BDM"
      chart={["total", "active", "depositPaid", "visaApproved"]}
      columns={["total", "active", "activeUnique", "depositPaid", "visaApproved", "visaRejected"]}
      rank={false}
      rules={["total", "active", "activeUnique", "depositPaid", "visaApproved", "visaRejected"]}
      note="The TOTAL of Active unique counts each student once, so it can be lower than the sum of the rows."
    />
  );
}

export function PartnerTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  if (!r) return <Loading />;
  return (
    <DimensionTab
      r={r}
      filters={filters}
      dim="partner"
      rows={partnerRows(r)}
      nameLabel="Partner"
      tableTitle="All partners"
      chartTitle="Top partners"
      caption="sorted by Deposit Paid, then Active Applications"
      chart={["active", "depositPaid", "visaApproved"]}
      columns={OUTCOMES}
      rules={OUTCOMES}
    />
  );
}

export function CountryTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  if (!r) return <Loading />;
  return (
    <DimensionTab
      r={r}
      filters={filters}
      dim="country"
      rows={countryRows(r)}
      nameLabel="Country"
      tableTitle="All countries"
      chartTitle="Countries by active applications"
      caption="destination: the university's country"
      chart={["active", "conditional", "depositPaid", "visaApproved"]}
      columns={OUTCOMES}
      rules={OUTCOMES}
    />
  );
}

export function UniversityTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  if (!r) return <Loading />;
  const rows = universityRows(r);
  return (
    <DimensionTab
      r={r}
      filters={filters}
      dim="university"
      rows={rows}
      nameLabel="University"
      tableTitle="Universities with offers, deposits or visas"
      chartTitle="Top universities"
      caption="only universities with at least one offer, deposit or visa outcome · sorted by Deposit Paid"
      chart={["conditional", "unconditional", "depositPaid", "visaApproved"]}
      columns={OUTCOMES}
      totals={{ activeUnique: rows.reduce((s, x) => s + x.activeUnique, 0) }}
      totalDrill={false}
      rules={OUTCOMES}
      note={`${r.byDim.university.length - rows.length} universities with applications but no offer, deposit or visa outcome yet are not listed (as in the weekly tracker).`}
    />
  );
}

export function IntakeTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  if (!r) return <Loading />;
  return (
    <DimensionTab
      r={r}
      filters={filters}
      dim="intake"
      rows={intakeRows(r)}
      nameLabel="Intake"
      tableTitle="All intakes"
      chartTitle="Intakes"
      caption="stored intake: deferred, else the course's, else the student's"
      chart={["total", "active", "depositPaid", "visaApproved"]}
      columns={["total", ...OUTCOMES]}
      totals={{ total: r.totals.total, activeUnique: r.totals.activeUnique }}
      rank={false}
      rules={["total", ...OUTCOMES]}
    />
  );
}

// ---------------------------------------------------------------------------
// Counsellor Wise: deposits, visas and shortlisting per CP counsellor
// ---------------------------------------------------------------------------
type CRow = ReturnType<typeof counsellorRows>[number];

export function CounsellorTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  if (!r) return <Loading />;
  const t = r.totals;
  const rows = counsellorRows(r);
  const sl = (metric: "shortlisted" | "partnerShortlistApproved", x: CRow | null) =>
    x ? drillOf(metric, { ...filters, counsellor: x.key }, x.name) : drillOf(metric, filters);
  const columns: Column<CRow>[] = [
    {
      key: "shortlisted",
      label: "Students shortlisted",
      value: (x) => x.shortlisted,
      drill: (x) => sl("shortlisted", x),
      total: r.shortlists.proposed.total,
      strong: true,
      hint: METRICS.shortlisted.rule,
    },
    {
      key: "partnerApproved",
      label: "Partner proposals approved",
      value: (x) => x.partnerApproved,
      drill: (x) => sl("partnerShortlistApproved", x),
      total: r.shortlists.approved.total,
      hint: METRICS.partnerShortlistApproved.rule,
    },
    ...metricColumns<CRow>("counsellor", filters, ["active", "depositPaid", "visaApproved"], { labels: SHORT }),
  ];
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi label="Total Deposit Paid" value={t.depositPaid} icon="deposit" tone="#F79009" drill={drillOf("depositPaid", filters)} />
        <Kpi label="Visa Approved" value={t.visaApproved} icon="check" tone="#12B76A" drill={drillOf("visaApproved", filters)} />
        <Kpi
          label="Students Shortlisted"
          value={r.shortlists.proposed.total}
          icon="university"
          tone="#7F56D9"
          drill={drillOf("shortlisted", filters)}
          sub={`by counsellors · ${periodLabel(filters.from, filters.to)}`}
        />
        <Kpi
          label="Partner proposals approved"
          value={r.shortlists.approved.total}
          icon="approvals"
          tone="#9E77ED"
          drill={drillOf("partnerShortlistApproved", filters)}
          sub="students, approved by a counsellor"
        />
      </div>
      <Card title="Counsellor comparison" className="mb-5" caption="counsellor = the student's Collegepond counsellor; shortlisting = who proposed">
        <HBarChart
          rows={rows.filter((x) => x.key !== "none")}
          name={(x) => x.name}
          series={[
            { key: "shortlisted", label: "Students shortlisted", color: SERIES.shortlisted!, value: (x: CRow) => x.shortlisted, drill: (x: CRow) => sl("shortlisted", x) },
            { key: "depositPaid", label: "Deposit Paid", color: SERIES.depositPaid!, value: (x: CRow) => x.depositPaid, drill: (x: CRow) => drillOf("depositPaid", { ...filters, counsellor: x.key }, x.name) },
            { key: "visaApproved", label: "Visa Approved", color: SERIES.visaApproved!, value: (x: CRow) => x.visaApproved, drill: (x: CRow) => drillOf("visaApproved", { ...filters, counsellor: x.key }, x.name) },
          ]}
        />
      </Card>
      <Card title="Counsellor deposit / visa / shortlisting breakdown" caption="ranked by Deposit Paid, then Visa Approved" flush>
        <BreakdownTable rows={rows} nameLabel="Counsellor" name={(x) => x.name} columns={columns} />
      </Card>
      <HowCounted
        metrics={["shortlisted", "partnerShortlistApproved", "active", "depositPaid", "visaApproved"]}
        notes={[
          "Shortlisting is credited to the counsellor who proposed the programme (or approved the partner's proposal), which can differ from the student's assigned counsellor. Vendor and status filters don't apply to shortlists.",
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Deposit Wise / Visa Wise: student-level lists
// ---------------------------------------------------------------------------
const LIST_LIMIT = 200;

function RecordList({
  filters,
  metric,
  title,
  caption,
  visa,
}: {
  filters: ReportFilters;
  metric: DrillMetric;
  title: (n: number) => string;
  caption: string;
  visa?: boolean;
}) {
  const open = useDrill();
  const q = api.reports.drilldown.useQuery({ filters, metric, page: 1, pageSize: LIST_LIMIT, sort: "submitted", dir: "desc" });
  const rows = q.data?.rows;
  return (
    <Card
      title={q.data ? title(q.data.total) : "Loading…"}
      caption={
        <span className="flex items-center gap-3">
          {caption}
          {q.data && q.data.total > 0 && (
            <button type="button" onClick={() => open(drillOf(metric, filters))} className="font-semibold text-[#1570EF] hover:underline">
              Search &amp; sort →
            </button>
          )}
        </span>
      }
      flush
    >
      {!rows ? (
        <div className="p-5">
          <SkeletonRows rows={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState label="No students for these filters." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-[#F9FAFB] text-left text-[11px] font-semibold tracking-[0.3px] text-[#667085] uppercase">
                {["Sr.", "Student", "University", "Partner", "Intake", "Country", "Counsellor", "RM", "Vendor", visa ? "Visa status" : "Comments"].map((h) => (
                  <th key={h} className="border-b border-[#E4E7EC] px-3 py-2.5 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((x, i) => (
                <tr key={x.appId ?? x.studentId} className="border-b border-[#F2F4F7] align-top last:border-0 hover:bg-[#FCFCFD]">
                  <td className="px-3 py-2 text-xs text-[#98A2B3]">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/students/${x.studentId}?tab=application`} target="_blank" className="font-semibold text-[#101828] hover:text-[#1570EF] hover:underline">
                      {x.studentName}
                    </Link>
                    <div className="text-[11px] text-[#98A2B3]">
                      CP-{x.studentId} · App #{x.appId}
                    </div>
                  </td>
                  <td className="max-w-[220px] px-3 py-2">
                    <div className="font-medium text-[#344054]">{x.university}</div>
                    <div className="text-[11px] text-[#667085]">{x.course}</div>
                  </td>
                  <td className="max-w-[160px] px-3 py-2 text-[#344054]">{x.partner ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{x.intake ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{x.country ? countryName(x.country) : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{x.counsellor ?? <span className="text-[#98A2B3]">Not assigned</span>}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{x.rm ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{x.vendor}</td>
                  <td className="max-w-[300px] px-3 py-2 text-[12px] text-[#475467]">
                    {visa ? (
                      <>
                        <StageBadge status={x.status} />
                        {x.stageAt && <div className="mt-0.5 text-[11px] text-[#98A2B3]">{formatDate(x.stageAt)}</div>}
                      </>
                    ) : (
                      (x.remark ?? <span className="text-[#D0D5DD]">—</span>)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.data && q.data.total > rows.length && (
            <p className="border-t border-[#F2F4F7] px-5 py-3 text-[12px] text-[#667085]">
              Showing the latest {rows.length} of {fmtN(q.data.total)}. Use &ldquo;Search &amp; sort&rdquo; or export for all.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

export function DepositTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  if (!r) return <Loading />;
  const t = r.totals;
  return (
    <>
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi label="Deposit Paid" value={t.depositPaid} icon="deposit" tone="#F79009" drill={drillOf("depositPaid", filters)} sub="at Deposit Paid or Visa Filed" />
        <Kpi label="In process" value={t.depositInProcess} icon="clock" tone="#B54708" drill={drillOf("depositInProcess", filters)} sub="deposit paid, visa not yet filed" />
        <Kpi label="Visa Filed" value={t.visaFiled} icon="visa" tone="#0BA5EC" drill={drillOf("visaFiled", filters)} sub="awaiting the visa decision" />
      </div>
      <RecordList
        filters={filters}
        metric="depositInProcess"
        title={(n) => `Deposit Paid — ${fmtN(n)} student${n === 1 ? "" : "s"} in process (visa not yet filed)`}
        caption="with the latest remark"
      />
      <HowCounted metrics={["depositPaid", "depositInProcess", "visaFiled"]} notes={["Comments are the latest Collegepond note on the student, else the application's notes."]} />
    </>
  );
}

export function VisaTab({ r, filters }: { r?: Report; filters: ReportFilters }) {
  if (!r) return <Loading />;
  const t = r.totals;
  const rows = counsellorRows(r).filter((x) => x.visaApproved + x.visaRejected + x.visaFiled > 0);
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi label="Visa Approved" value={t.visaApproved} icon="check" tone="#12B76A" drill={drillOf("visaApproved", filters)} />
        <Kpi label="Visa Rejected" value={t.visaRejected} icon="trend-down" tone="#F04438" drill={drillOf("visaRejected", filters)} />
        <Kpi
          label="Total Visa Decisions"
          value={t.visaDecisions}
          icon="visa"
          tone="#1570EF"
          drill={drillOf("visaDecisions", filters)}
          sub={t.visaDecisions ? `${Math.round((t.visaApproved / t.visaDecisions) * 100)}% approved` : undefined}
        />
        <Kpi label="Visa Filed" value={t.visaFiled} icon="clock" tone="#0BA5EC" drill={drillOf("visaFiled", filters)} sub="awaiting a decision" />
      </div>
      <Card title="Counsellor wise — visa breakdown" className="mb-5" flush>
        <BreakdownTable
          rows={rows}
          rank={false}
          nameLabel="Counsellor"
          name={(x) => x.name}
          emptyLabel="No visa filed or decided for these filters."
          columns={metricColumns("counsellor", filters, ["visaFiled", "visaApproved", "visaRejected", "visaDecisions"], {
            labels: { ...SHORT, visaDecisions: "Total decisions" },
          })}
        />
      </Card>
      <RecordList
        filters={filters}
        metric="visaDecisions"
        visa
        title={(n) => `Student-level visa detail (${fmtN(n)} record${n === 1 ? "" : "s"})`}
        caption="approved and rejected"
      />
      <HowCounted metrics={["visaApproved", "visaRejected", "visaDecisions", "visaFiled"]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Weekly
// ---------------------------------------------------------------------------
const SUBMITTED = "Submitted date";
const STAGE_NOW = "Submitted date · stage today";
export function WeeklyTab({
  w,
  filters,
  from,
  to,
  setRange,
  loading,
}: {
  w?: Weekly;
  filters: ReportFilters;
  from: string;
  to: string;
  setRange: (from: string, to: string) => void;
  loading: boolean;
}) {
  const days = daysInRange(from, to);
  const base: ReportFilters = { ...filters, from: undefined, to: undefined };
  const cur: ReportFilters = { ...base, from, to };
  const prev: ReportFilters | null = w ? { ...base, from: w.prevFrom, to: w.prevTo } : null;
  const shift = (dir: -1 | 1) => setRange(addDays(from, dir * days), addDays(to, dir * days));
  const btn = "h-9 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] font-medium text-[#344054] hover:bg-[#F9FAFB]";

  const lines: { label: string; metric: DrillMetric; cur: number; prev: number; basis: string }[] = w
    ? [
        { label: "Leads Received", metric: "leads", cur: w.current.leads, prev: w.previous.leads, basis: "Lead date · unique students" },
        { label: "Total Applications Submitted", metric: "total", cur: w.current.totals.total, prev: w.previous.totals.total, basis: SUBMITTED },
        { label: "Total Active Applications", metric: "active", cur: w.current.totals.active, prev: w.previous.totals.active, basis: SUBMITTED },
        { label: "Active Unique Applicants", metric: "activeUnique", cur: w.current.totals.activeUnique, prev: w.previous.totals.activeUnique, basis: SUBMITTED },
        { label: "Applications Submitted (still awaiting decision)", metric: "submitted", cur: w.current.totals.submitted, prev: w.previous.totals.submitted, basis: STAGE_NOW },
        { label: "Conditional Offer Received", metric: "conditional", cur: w.current.totals.conditional, prev: w.previous.totals.conditional, basis: STAGE_NOW },
        { label: "Unconditional Offer Received", metric: "unconditional", cur: w.current.totals.unconditional, prev: w.previous.totals.unconditional, basis: STAGE_NOW },
        { label: "Deposit Paid", metric: "depositPaid", cur: w.current.totals.depositPaid, prev: w.previous.totals.depositPaid, basis: STAGE_NOW },
        { label: "Case Closed", metric: "caseClosed", cur: w.current.totals.caseClosed, prev: w.previous.totals.caseClosed, basis: STAGE_NOW },
        { label: "Rejected by University", metric: "rejected", cur: w.current.totals.rejected, prev: w.previous.totals.rejected, basis: STAGE_NOW },
        { label: "Visa Rejected", metric: "visaRejected", cur: w.current.totals.visaRejected, prev: w.previous.totals.visaRejected, basis: STAGE_NOW },
        { label: "Visa Approved", metric: "visaApproved", cur: w.current.totals.visaApproved, prev: w.previous.totals.visaApproved, basis: STAGE_NOW },
        { label: "Students Shortlisted (counsellors)", metric: "shortlisted", cur: w.current.shortlisted, prev: w.previous.shortlisted, basis: "Shortlist date · unique students" },
      ]
    : [];
  const rmRowsW = w ? rmLeadRows(w) : [];
  const sl = w ? weeklyShortlistRows(w) : [];

  return (
    <>
      {/* Reporting week */}
      <div className="mb-5 rounded-xl border border-[#B2DDFF] bg-[#F5FAFF] p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold tracking-wide text-[#1570EF] uppercase">Reporting week</div>
            <div className="text-lg font-bold text-[#101828]">{periodLabel(from, to)}</div>
            <div className="text-[12px] text-[#667085]">
              {days} day{days === 1 ? "" : "s"} · compared with {w ? periodLabel(w.prevFrom, w.prevTo) : "the previous period"} · leads by lead submitted date, applications by submitted date
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] font-medium text-[#667085]">
              Start date
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => e.target.value && setRange(e.target.value, to < e.target.value ? e.target.value : to)}
                className="mt-0.5 block h-9 rounded-lg border border-[#D0D5DD] bg-white px-2 text-[13px] text-[#344054]"
              />
            </label>
            <label className="text-[11px] font-medium text-[#667085]">
              End date
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => e.target.value && setRange(from > e.target.value ? e.target.value : from, e.target.value)}
                className="mt-0.5 block h-9 rounded-lg border border-[#D0D5DD] bg-white px-2 text-[13px] text-[#344054]"
              />
            </label>
            <button type="button" className={btn} onClick={() => shift(-1)} title="Previous period">
              ← Prev
            </button>
            <button type="button" className={btn} onClick={() => shift(1)} title="Next period">
              Next →
            </button>
            {(["this_week", "last_week", "last_7"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={btn}
                onClick={() => {
                  const rg = presetRange(p);
                  if (rg) setRange(rg.from, rg.to);
                }}
              >
                {p === "this_week" ? "This week" : p === "last_week" ? "Last week" : "Last 7 days"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!w || loading ? (
        <Loading />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi label="Leads Received" value={w.current.leads} delta={w.previous.leads} icon="partners" tone="#0BA5EC" drill={drillOf("leads", cur)} sub="by lead submitted date" />
            <Kpi
              label="Applications Submitted"
              value={w.current.totals.total}
              delta={w.previous.totals.total}
              icon="applications"
              tone="#1570EF"
              drill={drillOf("total", cur)}
              sub="submitted this period, any stage now"
            />
            <Kpi label="Total Active Applications" value={w.current.totals.active} delta={w.previous.totals.active} icon="bolt" tone="#7F56D9" drill={drillOf("active", cur)} />
            <Kpi label="Active Unique Applicants" value={w.current.totals.activeUnique} delta={w.previous.totals.activeUnique} icon="students" tone="#6941C6" drill={drillOf("activeUnique", cur)} />
          </div>

          <div className="mb-5 grid grid-cols-1 gap-5 xl:grid-cols-5">
            <Card title="Weekly metric detail" caption="this period vs previous" className="xl:col-span-3" flush>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-[#F9FAFB] text-left text-[11px] font-semibold tracking-[0.3px] text-[#667085] uppercase">
                      <th className="border-b border-[#E4E7EC] px-4 py-2.5 whitespace-nowrap">Metric</th>
                      <th className="border-b border-[#E4E7EC] px-3 py-2.5 whitespace-nowrap text-right">This period</th>
                      <th className="border-b border-[#E4E7EC] px-3 py-2.5 whitespace-nowrap text-right">Previous</th>
                      <th className="border-b border-[#E4E7EC] px-3 py-2.5 whitespace-nowrap text-right">Change</th>
                      <th className="border-b border-[#E4E7EC] px-3 py-2.5 whitespace-nowrap">Date basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const diff = l.cur - l.prev;
                      return (
                        <tr key={l.label} className="border-b border-[#F2F4F7] last:border-0">
                          <td className="px-4 py-1.5 text-[#344054]">{l.label}</td>
                          <td className="px-3 py-1 text-right">
                            <CountCell value={l.cur} drill={drillOf(l.metric, cur, "this period")} strong />
                          </td>
                          <td className="px-3 py-1 text-right">{prev && <CountCell value={l.prev} drill={drillOf(l.metric, prev, "previous period")} />}</td>
                          <td className={`px-3 py-1.5 text-right text-[12px] font-semibold ${diff > 0 ? "text-[#027A48]" : diff < 0 ? "text-[#B42318]" : "text-[#98A2B3]"}`}>
                            {diff === 0 ? "—" : `${diff > 0 ? "+" : ""}${diff}`}
                          </td>
                          <td className="px-3 py-1.5 text-[11.5px] whitespace-nowrap text-[#98A2B3]">{l.basis}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
            <div className="space-y-5 xl:col-span-2">
              <Card title="RM-wise leads" caption="this period · previous" flush>
                {rmRowsW.length === 0 ? (
                  <EmptyState label="No leads in either period." />
                ) : (
                  <table className="w-full border-collapse text-[13px]">
                    <tbody>
                      {rmRowsW.map((x) => (
                        <tr key={x.key} className="border-b border-[#F2F4F7]">
                          <td className="px-4 py-1.5 font-medium text-[#344054]">{x.name}</td>
                          <td className="px-3 py-1 text-right">
                            <CountCell value={x.leads} drill={drillOf("leads", { ...cur, rm: x.key }, x.name)} strong />
                          </td>
                          <td className="px-3 py-1 text-right text-[12px]">
                            {prev && <CountCell value={x.prev} drill={drillOf("leads", { ...prev, rm: x.key }, `${x.name} · previous period`)} />}
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-[#F9FAFB] font-bold">
                        <td className="px-4 py-2 text-[12px] text-[#344054] uppercase">Total</td>
                        <td className="px-3 py-1 text-right">
                          <CountCell value={w.current.leads} drill={drillOf("leads", cur)} strong />
                        </td>
                        <td className="px-3 py-1 text-right">{prev && <CountCell value={w.previous.leads} drill={drillOf("leads", prev)} />}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </Card>
              <Card title="Counsellor shortlisting" caption="unique students this period" flush>
                {sl.length === 0 ? (
                  <EmptyState label="No programmes shortlisted this period." />
                ) : (
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="bg-[#F9FAFB] text-left text-[10.5px] font-semibold tracking-[0.3px] text-[#667085] uppercase">
                        <th className="px-4 py-2">Counsellor</th>
                        <th className="px-3 py-2 text-right">Shortlisted</th>
                        <th className="px-3 py-2 text-right" title={METRICS.partnerShortlistApproved.rule}>
                          Partner approved
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sl.map((x) => (
                        <tr key={x.key} className="border-b border-[#F2F4F7]">
                          <td className="px-4 py-1.5 font-medium text-[#344054]">{x.name}</td>
                          <td className="px-3 py-1 text-right">
                            <CountCell value={x.shortlisted} drill={drillOf("shortlisted", { ...cur, counsellor: x.key }, x.name)} strong />
                          </td>
                          <td className="px-3 py-1 text-right">
                            <CountCell value={x.partnerApproved} drill={drillOf("partnerShortlistApproved", { ...cur, counsellor: x.key }, x.name)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          </div>

          <Card title={`Trend · last ${w.trend.periods.length} periods of ${days} day${days === 1 ? "" : "s"}`} caption="the selected period is highlighted">
            <TrendChart
              labels={w.trend.periods.map((p) => (days === 1 ? fmtIsoDay(p.to).slice(0, -5) : `${fmtIsoDay(p.from).slice(0, -5)}`))}
              series={[
                { key: "leads", label: "Leads received", color: SERIES.leads!, values: w.trend.leads },
                { key: "submitted", label: "Applications submitted", color: SERIES.total!, values: w.trend.submitted },
                { key: "active", label: "of which active", color: SERIES.active!, values: w.trend.active },
              ]}
            />
          </Card>

          <HowCounted
            metrics={["leads", "total", "active", "activeUnique", "submitted", "conditional", "unconditional", "depositPaid", "visaApproved", "visaRejected", "shortlisted"]}
            notes={[
              "Applications submitted in the period are counted at their stage today (as in the weekly tracker's Data sheet), so a week's figures can still change as those applications move on.",
              "Week-on-week compares with the period of the same length straight before the selected one.",
            ]}
          />
        </>
      )}
    </>
  );
}
