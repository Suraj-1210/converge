// SQL for Reports & Analytics (Super Admin). Every figure on every tab,
// drill-down and export is built from the pieces in this file, so a filter
// means the same thing everywhere:
//
//   appConds / leadConds / shortlistConds  the filters, per source table
//   metricCond                             one condition per metric
//                                          (stage lists in ~/lib/reports)
//
// All values are bound with positional `?` placeholders ($queryRawUnsafe):
// Prisma.join inside IN () matched nothing in `next dev` (see CLAUDE notes).
// The only interpolated text is code constants (stage codes, column names).

import { db } from "~/server/db";
import { APPLICATION_STAGE_ORDER } from "~/lib/application-stages";
import { ShortlistApproval, ShortlistSource, UniApplicationStatus as S, UserType } from "~/server/db/enums";
import {
  ACTIVE_STAGES,
  APP_METRIC_KEYS,
  FUNNEL_STEPS,
  METRICS,
  NONE,
  VENDOR_DIRECT,
  VENDOR_NOT_SET,
  isIsoDate,
  istRangeToUtc,
  type AppCounts,
  type AppMetricKey,
  type Dimension,
  type DrillMetric,
  type DrillSort,
  type FunnelKey,
  type ReportFilters,
} from "~/lib/reports";

type Params = unknown[];
interface Where {
  conds: string[];
  params: Params;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? v.toString() : null;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : str(v));

async function q<T>(sql: string, params: Params): Promise<T[]> {
  return db.$queryRawUnsafe<T[]>(sql, ...params);
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

// Position on the happy path, 1 = Begin Application … 10 = Enrolled; 0 for a
// closed outcome. Stage codes are not in pipeline order (Visa Filed = 9).
const RANK_LIST = APPLICATION_STAGE_ORDER.join(", ");
const rankOf = (col: string) => `FIELD(${col}, ${RANK_LIST})`;
const rankOfStage = (code: number) => APPLICATION_STAGE_ORDER.indexOf(code as S) + 1;

const personName = (alias: string) => `NULLIF(TRIM(CONCAT(${alias}.first_name, ' ', ${alias}.last_name)), '')`;

// The partner a student belongs to: their agency / institution, or the
// independent counsellor who added them. The RM is that partner's BDM
// (user.bdm_id on the agency owner or the independent; ~/server/staff-access).
const PARTNER_JOINS = `
  LEFT JOIN organization o ON o.id = s.org_id
  LEFT JOIN \`user\` ind ON s.org_id IS NULL AND ind.id = s.created_by_user_id
  LEFT JOIN (
    SELECT org_id, MIN(bdm_id) AS bdm_id FROM \`user\`
    WHERE type = ${UserType.AGENCY_OWNER} AND org_id IS NOT NULL AND bdm_id IS NOT NULL
    GROUP BY org_id
  ) orm ON orm.org_id = s.org_id
  LEFT JOIN cp_user rmu ON rmu.id = COALESCE(orm.bdm_id, ind.bdm_id)`;

const MONTH_NAMES = "'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'";
const STUDENT_INTAKE = `NULLIF(TRIM(s.intake), '')`;
const COURSE_INTAKE = `NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(c.intake_month), ''), c.intake_year)), '')`;

const E = {
  partnerKey: `(CASE WHEN s.org_id IS NOT NULL THEN CONCAT('o', s.org_id) WHEN s.created_by_user_id IS NOT NULL THEN CONCAT('u', s.created_by_user_id) END)`,
  partnerLabel: `COALESCE(o.name, ${personName("ind")})`,
  rm: `COALESCE(orm.bdm_id, ind.bdm_id)`,
  rmLabel: personName("rmu"),
  counsellorLabel: personName("cu"),
  studentIntake: STUDENT_INTAKE,
  courseIntake: COURSE_INTAKE,
  // As Student Placements: a deferred application's new intake, else the
  // course's; the student's own intake when the course has none.
  appIntake: `COALESCE(
      CASE WHEN a.deferred_at IS NOT NULL AND a.deferred_intake_month BETWEEN 1 AND 12 AND a.deferred_intake_year IS NOT NULL
        THEN CONCAT(ELT(a.deferred_intake_month, ${MONTH_NAMES}), ' ', a.deferred_intake_year) END,
      ${COURSE_INTAKE}, ${STUDENT_INTAKE})`,
  // Processing vendor: the commission contract's vendor (no vendor on the
  // contract = Direct), else the counsellor's free-text vendor, else Not set.
  vendor: `(CASE WHEN cc.id IS NOT NULL THEN COALESCE(v.name, '${VENDOR_DIRECT}')
    WHEN NULLIF(TRIM(a.counsellor_vendor), '') IS NOT NULL THEN TRIM(a.counsellor_vendor)
    ELSE '${VENDOR_NOT_SET}' END)`,
  vendorSource: `(CASE WHEN cc.id IS NOT NULL THEN 'contract'
    WHEN NULLIF(TRIM(a.counsellor_vendor), '') IS NOT NULL THEN 'text' ELSE 'none' END)`,
  // Furthest stage the application reached: current stage, stage history,
  // or Submitted when it has a submitted date (closed rows keep theirs).
  reached: `GREATEST(${rankOf("a.status")}, COALESCE(h.r, 0), IF(a.submitted_at IS NULL, 0, ${rankOfStage(S.APPLICATION_SUBMITTED)}))`,
  // Latest Collegepond note on the student, else the application's notes.
  remark: (withApp: boolean) =>
    `COALESCE((SELECT sn.body FROM student_note sn WHERE sn.student_id = s.id AND sn.is_task = 0
      ORDER BY sn.created_at DESC, sn.id DESC LIMIT 1)${withApp ? ", NULLIF(TRIM(a.notes), '')" : ""})`,
};

const HISTORY_JOIN = `LEFT JOIN (
    SELECT application_id, MAX(${rankOf("stage")}) AS r FROM application_stage_history GROUP BY application_id
  ) h ON h.application_id = a.id`;

const appFrom = (withHistory = false) => `
  FROM application a
  JOIN student s ON s.id = a.student_id
  JOIN course c ON c.id = a.course_id
  JOIN university un ON un.id = c.university_id
  LEFT JOIN commission_contract cc ON cc.id = a.commission_contract_id
  LEFT JOIN vendor v ON v.id = cc.vendor_id
  LEFT JOIN cp_user cu ON cu.id = s.cp_counsellor_id
  ${PARTNER_JOINS}
  ${withHistory ? HISTORY_JOIN : ""}`;

const LEAD_FROM = `
  FROM student s
  LEFT JOIN cp_user cu ON cu.id = s.cp_counsellor_id
  ${PARTNER_JOINS}`;

// Shortlists: "proposed" = programmes a Collegepond counsellor proposed (the
// counsellor's shortlisting work); "approved" = partner proposals a
// counsellor approved. Kept apart, never added together.
type ShortlistKind = "proposed" | "approved";
const SHORTLIST = {
  proposed: {
    cp: "sh.collegepond_user_id",
    date: "sh.created_at",
    base: `sh.added_by = ${ShortlistSource.COLLEGEPOND} AND sh.collegepond_user_id IS NOT NULL`,
  },
  approved: {
    cp: "sh.decided_by_cp_user_id",
    date: "sh.decided_at",
    base: `sh.added_by = ${ShortlistSource.PARTNER} AND sh.approval_status = ${ShortlistApproval.APPROVED} AND sh.decided_by_cp_user_id IS NOT NULL`,
  },
} as const;

const shortlistFrom = (kind: ShortlistKind) => `
  FROM shortlist sh
  JOIN student s ON s.id = sh.student_id
  JOIN course c ON c.id = sh.course_id
  JOIN university un ON un.id = c.university_id
  LEFT JOIN cp_user cu ON cu.id = ${SHORTLIST[kind].cp}
  ${PARTNER_JOINS}`;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const FALSE = "1 = 0";

function idValue(v: string): number | null {
  return /^\d{1,9}$/.test(v) ? Number(v) : null;
}

function addDates(w: Where, col: string, f: ReportFilters) {
  if (!isIsoDate(f.from) || !isIsoDate(f.to)) return;
  const { start, end } = istRangeToUtc(f.from, f.to);
  w.conds.push(`${col} >= ? AND ${col} < ?`);
  w.params.push(start, end);
}

// "none" = unassigned (NULL); otherwise an id.
function addIdOrNone(w: Where, expr: string, v: string | undefined) {
  if (!v) return;
  if (v === NONE) return void w.conds.push(`${expr} IS NULL`);
  const id = idValue(v);
  if (id === null) return void w.conds.push(FALSE);
  w.conds.push(`${expr} = ?`);
  w.params.push(id);
}

function addText(w: Where, expr: string, v: string | undefined) {
  if (!v) return;
  if (v === NONE) return void w.conds.push(`${expr} IS NULL`);
  w.conds.push(`${expr} = ?`);
  w.params.push(v);
}

function addPartnerRm(w: Where, f: ReportFilters) {
  if (f.partner) {
    const m = /^([ou])(\d{1,9})$/.exec(f.partner);
    if (f.partner === NONE) w.conds.push(`${E.partnerKey} IS NULL`);
    else if (!m) w.conds.push(FALSE);
    else if (m[1] === "o") {
      w.conds.push("s.org_id = ?");
      w.params.push(Number(m[2]));
    } else {
      w.conds.push("s.org_id IS NULL AND s.created_by_user_id = ?");
      w.params.push(Number(m[2]));
    }
  }
  addIdOrNone(w, E.rm, f.rm);
}

// Application-side filters that don't depend on the student (university,
// vendor, status): shared by the application rows and the lead EXISTS.
function addAppOnly(w: Where, f: ReportFilters) {
  addIdOrNone(w, "un.id", f.university);
  addText(w, E.vendor, f.vendor);
  if (f.status) {
    const code = idValue(f.status);
    if (code === null) w.conds.push(FALSE);
    else {
      w.conds.push("a.status = ?");
      w.params.push(code);
    }
  }
}

// Applications: the date range applies to the submitted date.
export function appConds(f: ReportFilters): Where {
  const w: Where = { conds: [], params: [] };
  addDates(w, "a.submitted_at", f);
  addText(w, E.appIntake, f.intake);
  addText(w, "un.country", f.country);
  addPartnerRm(w, f);
  addIdOrNone(w, "s.cp_counsellor_id", f.counsellor);
  addAppOnly(w, f);
  return w;
}

// Leads (students added by partners): the date range applies to the date the
// student was added; intake and country are the student's own. University,
// vendor and status narrow leads to students with a matching application.
export function leadConds(f: ReportFilters): Where {
  const w: Where = { conds: ["(s.org_id IS NOT NULL OR s.created_by_user_id IS NOT NULL)"], params: [] };
  addDates(w, "s.created_at", f);
  addText(w, E.studentIntake, f.intake);
  addText(w, "s.country", f.country);
  addPartnerRm(w, f);
  addIdOrNone(w, "s.cp_counsellor_id", f.counsellor);
  if (f.university || f.vendor || f.status) {
    const inner: Where = { conds: [], params: [] };
    addAppOnly(inner, f);
    w.conds.push(`EXISTS (SELECT 1 FROM application a
      JOIN course c ON c.id = a.course_id JOIN university un ON un.id = c.university_id
      LEFT JOIN commission_contract cc ON cc.id = a.commission_contract_id
      LEFT JOIN vendor v ON v.id = cc.vendor_id
      WHERE a.student_id = s.id AND ${inner.conds.join(" AND ")})`);
    w.params.push(...inner.params);
  }
  return w;
}

// Shortlists: the counsellor filter is the counsellor who shortlisted (or
// approved). Vendor and status don't apply to a shortlist.
export function shortlistConds(f: ReportFilters, kind: ShortlistKind): Where {
  const k = SHORTLIST[kind];
  const w: Where = { conds: [k.base], params: [] };
  addDates(w, k.date, f);
  addText(w, `COALESCE(${E.courseIntake}, ${E.studentIntake})`, f.intake);
  addText(w, "un.country", f.country);
  addPartnerRm(w, f);
  addIdOrNone(w, k.cp, f.counsellor);
  addIdOrNone(w, "un.id", f.university);
  return w;
}

const whereSql = (w: Where) => (w.conds.length ? `WHERE ${w.conds.join(" AND ")}` : "");

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const isFunnel = (m: DrillMetric): m is FunnelKey => FUNNEL_STEPS.some((s) => s.key === m);

export function metricCond(m: AppMetricKey | FunnelKey): string {
  if (isFunnel(m)) {
    const step = FUNNEL_STEPS.find((s) => s.key === m)!;
    return `${E.reached} >= ${rankOfStage(step.minStage)}`;
  }
  switch (m) {
    case "total":
      return "1 = 1";
    case "active":
    case "activeUnique":
      return `(s.inactive_at IS NULL AND a.status IN (${ACTIVE_STAGES.join(", ")}))`;
    case "deferred":
      return `(a.deferred_at IS NOT NULL OR a.status = ${S.DEFERRED_TO_NEXT_INTAKE})`;
    default: {
      const stages = METRICS[m].stages;
      return stages?.length ? `a.status IN (${stages.join(", ")})` : FALSE;
    }
  }
}

const METRIC_COLUMNS = APP_METRIC_KEYS.map((k) =>
  METRICS[k].level === "student"
    ? `COUNT(DISTINCT CASE WHEN ${metricCond(k)} THEN a.student_id END) AS ${k}`
    : `SUM(CASE WHEN ${metricCond(k)} THEN 1 ELSE 0 END) AS ${k}`,
).join(",\n    ");

function countsOf(r: Record<string, unknown>): AppCounts {
  return Object.fromEntries(APP_METRIC_KEYS.map((k) => [k, num(r[k])])) as AppCounts;
}

export interface GroupRow {
  key: string;
  label: string;
}

// Group key + label per dimension. NULL keys come back as "none".
const DIM: Record<Dimension, { key: string; label: string }> = {
  partner: { key: E.partnerKey, label: E.partnerLabel },
  rm: { key: E.rm, label: E.rmLabel },
  counsellor: { key: "s.cp_counsellor_id", label: E.counsellorLabel },
  country: { key: "un.country", label: "un.country" },
  university: { key: "un.id", label: "un.name" },
  intake: { key: E.appIntake, label: E.appIntake },
  vendor: { key: E.vendor, label: E.vendor },
};

export async function appTotals(f: ReportFilters): Promise<AppCounts> {
  const w = appConds(f);
  const [row] = await q<Record<string, unknown>>(`SELECT ${METRIC_COLUMNS} ${appFrom()} ${whereSql(w)}`, w.params);
  return countsOf(row ?? {});
}

export async function appByDimension(f: ReportFilters, dim: Dimension): Promise<(GroupRow & AppCounts)[]> {
  const w = appConds(f);
  const d = DIM[dim];
  const rows = await q<Record<string, unknown>>(
    `SELECT ${d.key} AS k, MAX(${d.label}) AS label, ${METRIC_COLUMNS} ${appFrom()} ${whereSql(w)} GROUP BY 1`,
    w.params,
  );
  return rows.map((r) => ({ key: str(r.k) ?? NONE, label: str(r.label) ?? "", ...countsOf(r) }));
}

export async function funnel(f: ReportFilters): Promise<Record<FunnelKey, number>> {
  const w = appConds(f);
  const cols = FUNNEL_STEPS.map((s) => `SUM(CASE WHEN ${metricCond(s.key)} THEN 1 ELSE 0 END) AS ${s.key}`).join(", ");
  const [row] = await q<Record<string, unknown>>(`SELECT ${cols} ${appFrom(true)} ${whereSql(w)}`, w.params);
  return Object.fromEntries(FUNNEL_STEPS.map((s) => [s.key, num(row?.[s.key])])) as Record<FunnelKey, number>;
}

// How each application's vendor was worked out (counts for the hub).
export async function vendorSources(f: ReportFilters): Promise<{ contract: number; text: number; none: number }> {
  const w = appConds(f);
  const rows = await q<{ k: string; n: unknown }>(
    `SELECT ${E.vendorSource} AS k, COUNT(*) AS n ${appFrom()} ${whereSql(w)} GROUP BY 1`,
    w.params,
  );
  const by = Object.fromEntries(rows.map((r) => [r.k, num(r.n)]));
  return { contract: by.contract ?? 0, text: by.text ?? 0, none: by.none ?? 0 };
}

export async function leadCount(f: ReportFilters): Promise<number> {
  const w = leadConds(f);
  const [row] = await q<{ n: unknown }>(`SELECT COUNT(*) AS n ${LEAD_FROM} ${whereSql(w)}`, w.params);
  return num(row?.n);
}

export async function leadsByRm(f: ReportFilters): Promise<(GroupRow & { leads: number })[]> {
  const w = leadConds(f);
  const rows = await q<Record<string, unknown>>(
    `SELECT ${E.rm} AS k, MAX(${E.rmLabel}) AS label, COUNT(*) AS n ${LEAD_FROM} ${whereSql(w)} GROUP BY 1`,
    w.params,
  );
  return rows.map((r) => ({ key: str(r.k) ?? NONE, label: str(r.label) ?? "", leads: num(r.n) }));
}

// Distinct students shortlisted, per counsellor, plus the overall distinct
// count (a student shortlisted by two counsellors counts once overall).
export async function shortlistsByCounsellor(
  f: ReportFilters,
  kind: ShortlistKind,
): Promise<{ total: number; rows: (GroupRow & { students: number })[] }> {
  const w = shortlistConds(f, kind);
  const from = shortlistFrom(kind);
  const [rows, [tot]] = await Promise.all([
    q<Record<string, unknown>>(
      `SELECT ${SHORTLIST[kind].cp} AS k, MAX(${E.counsellorLabel}) AS label, COUNT(DISTINCT s.id) AS n ${from} ${whereSql(w)} GROUP BY 1`,
      w.params,
    ),
    q<{ n: unknown }>(`SELECT COUNT(DISTINCT s.id) AS n ${from} ${whereSql(w)}`, w.params),
  ]);
  return {
    total: num(tot?.n),
    rows: rows.map((r) => ({ key: str(r.k) ?? NONE, label: str(r.label) ?? "", students: num(r.n) })),
  };
}

// Leads and submitted / active applications per period of `days` days, for
// `buckets` periods ending on `to` (the Weekly trend chart).
export async function trend(
  f: ReportFilters,
  to: string,
  days: number,
  buckets: number,
): Promise<{ leads: number[]; submitted: number[]; active: number[] }> {
  const { start: endStart } = istRangeToUtc(to, to);
  const end = new Date(endStart.getTime() + 86_400_000);
  const span = days * 86_400;
  const start = new Date(end.getTime() - buckets * span * 1000);
  const range = { from: undefined, to: undefined };
  const wa = appConds({ ...f, ...range });
  const wl = leadConds({ ...f, ...range });
  const bucket = (col: string) => `FLOOR(TIMESTAMPDIFF(SECOND, ?, ${col}) / ${span})`;
  const [apps, leads] = await Promise.all([
    q<{ b: unknown; n: unknown; act: unknown }>(
      `SELECT ${bucket("a.submitted_at")} AS b, COUNT(*) AS n, SUM(CASE WHEN ${metricCond("active")} THEN 1 ELSE 0 END) AS act
       ${appFrom()} ${whereSql({ conds: [...wa.conds, "a.submitted_at >= ? AND a.submitted_at < ?"], params: [] })} GROUP BY 1`,
      [start, ...wa.params, start, end],
    ),
    q<{ b: unknown; n: unknown }>(
      `SELECT ${bucket("s.created_at")} AS b, COUNT(*) AS n
       ${LEAD_FROM} ${whereSql({ conds: [...wl.conds, "s.created_at >= ? AND s.created_at < ?"], params: [] })} GROUP BY 1`,
      [start, ...wl.params, start, end],
    ),
  ]);
  const series = () => Array.from({ length: buckets }, () => 0);
  const out = { leads: series(), submitted: series(), active: series() };
  for (const r of apps) {
    const i = num(r.b);
    if (i >= 0 && i < buckets) {
      out.submitted[i] = num(r.n);
      out.active[i] = num(r.act);
    }
  }
  for (const r of leads) {
    const i = num(r.b);
    if (i >= 0 && i < buckets) out.leads[i] = num(r.n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drill-down: the records behind any count
// ---------------------------------------------------------------------------

export type DrillKind = "app" | "student" | "lead" | "shortlist";

export interface DrillRow {
  appId: number | null;
  studentId: number;
  studentName: string;
  partner: string | null;
  university: string | null;
  course: string | null;
  intake: string | null;
  country: string | null;
  counsellor: string | null;
  rm: string | null;
  vendor: string | null;
  leadAt: string | null;
  submittedAt: string | null;
  // Date the current stage was reached (applications), or the shortlist /
  // approval date (shortlists).
  stageAt: string | null;
  // Application status (app/student kinds) or student status (lead/shortlist).
  status: number;
  remark: string | null;
  // Applications (student kind), all applications (lead), or programmes
  // shortlisted in the period (shortlist).
  count: number;
}

const SORT_SQL: Record<DrillSort, string> = {
  student: "t.firstName {d}, t.lastName {d}",
  partner: "t.partner {d}",
  university: "t.university {d}, t.course {d}",
  intake: "t.intake {d}",
  country: "t.country {d}",
  counsellor: "t.counsellor {d}",
  rm: "t.rm {d}",
  vendor: "t.vendor {d}",
  lead: "t.leadAt {d}",
  submitted: "t.submittedAt {d}",
  stage: "t.stageRank {d}, t.status {d}",
  stageAt: "t.stageAt {d}",
};

export function drillKind(m: DrillMetric): DrillKind {
  if (isFunnel(m)) return "app";
  const level = METRICS[m].level;
  return level === "app" ? "app" : level;
}

function searchCond(term: string | undefined, withCourse: boolean, withApp: boolean): Where | null {
  const t = term?.trim().slice(0, 100);
  if (!t) return null;
  const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const conds = ["CONCAT(s.first_name, ' ', s.last_name) LIKE ?", "s.email LIKE ?", `COALESCE(${E.partnerLabel}, '') LIKE ?`];
  const params: Params = [like, like, like];
  if (withCourse) {
    conds.push("un.name LIKE ?", "c.name LIKE ?");
    params.push(like, like);
  }
  const id = /^(?:cp-?|app-?|#)?(\d{1,9})$/i.exec(t);
  if (id) {
    conds.push("s.id = ?");
    params.push(Number(id[1]));
    if (withApp) {
      conds.push("a.id = ?");
      params.push(Number(id[1]));
    }
  }
  return { conds: [`(${conds.join(" OR ")})`], params };
}

export async function drilldown(input: {
  filters: ReportFilters;
  metric: DrillMetric;
  search?: string;
  sort?: DrillSort;
  dir?: "asc" | "desc";
  page: number;
  pageSize: number;
}): Promise<{ kind: DrillKind; total: number; rows: DrillRow[] }> {
  const kind = drillKind(input.metric);
  const f = input.filters;
  let inner: string;
  let w: Where;

  if (kind === "app" || kind === "student") {
    w = appConds(f);
    w.conds.push(metricCond(input.metric as AppMetricKey | FunnelKey));
    const s = searchCond(input.search, true, true);
    if (s) {
      w.conds.push(...s.conds);
      w.params.push(...s.params);
    }
    const perStudent =
      kind === "student"
        ? `ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY ${rankOf("a.status")} DESC, a.submitted_at DESC, a.id DESC) AS rn,
           COUNT(*) OVER (PARTITION BY s.id) AS cnt`
        : "1 AS rn, 1 AS cnt";
    inner = `SELECT a.id AS appId, s.id AS studentId, s.first_name AS firstName, s.last_name AS lastName,
        ${E.partnerLabel} AS partner, un.name AS university, c.name AS course, ${E.appIntake} AS intake,
        un.country AS country, ${E.counsellorLabel} AS counsellor, ${E.rmLabel} AS rm, ${E.vendor} AS vendor,
        s.created_at AS leadAt, a.submitted_at AS submittedAt,
        (SELECT MAX(hx.occurred_at) FROM application_stage_history hx WHERE hx.application_id = a.id AND hx.stage = a.status) AS stageAt,
        a.status AS status, ${rankOf("a.status")} AS stageRank, ${E.remark(true)} AS remark, ${perStudent}
      ${appFrom(isFunnel(input.metric))} ${whereSql(w)}`;
  } else if (kind === "lead") {
    w = leadConds(f);
    const s = searchCond(input.search, false, false);
    if (s) {
      w.conds.push(...s.conds);
      w.params.push(...s.params);
    }
    inner = `SELECT NULL AS appId, s.id AS studentId, s.first_name AS firstName, s.last_name AS lastName,
        ${E.partnerLabel} AS partner, NULL AS university, NULL AS course, ${E.studentIntake} AS intake,
        s.country AS country, ${E.counsellorLabel} AS counsellor, ${E.rmLabel} AS rm, NULL AS vendor,
        s.created_at AS leadAt, NULL AS submittedAt, NULL AS stageAt, s.status AS status, s.status AS stageRank,
        ${E.remark(false)} AS remark, 1 AS rn,
        (SELECT COUNT(*) FROM application ax WHERE ax.student_id = s.id) AS cnt
      ${LEAD_FROM} ${whereSql(w)}`;
  } else {
    const sk: ShortlistKind = input.metric === "partnerShortlistApproved" ? "approved" : "proposed";
    w = shortlistConds(f, sk);
    const s = searchCond(input.search, true, false);
    if (s) {
      w.conds.push(...s.conds);
      w.params.push(...s.params);
    }
    const date = SHORTLIST[sk].date;
    inner = `SELECT NULL AS appId, s.id AS studentId, s.first_name AS firstName, s.last_name AS lastName,
        ${E.partnerLabel} AS partner, un.name AS university, c.name AS course,
        COALESCE(${E.courseIntake}, ${E.studentIntake}) AS intake, un.country AS country,
        ${E.counsellorLabel} AS counsellor, ${E.rmLabel} AS rm, NULL AS vendor,
        s.created_at AS leadAt, NULL AS submittedAt, ${date} AS stageAt, s.status AS status, s.status AS stageRank,
        ${E.remark(false)} AS remark,
        ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY ${date} DESC, sh.id DESC) AS rn,
        COUNT(*) OVER (PARTITION BY s.id) AS cnt
      ${shortlistFrom(sk)} ${whereSql(w)}`;
  }

  const fallbackSort: DrillSort = kind === "app" || kind === "student" ? "submitted" : kind === "lead" ? "lead" : "stageAt";
  const dir = input.dir === "asc" ? "ASC" : "DESC";
  const order = SORT_SQL[input.sort ?? fallbackSort].replaceAll("{d}", dir);
  const pageSize = Math.min(Math.max(input.pageSize, 1), 5000);
  const offset = Math.max(input.page - 1, 0) * pageSize;

  const [rows, [tot]] = await Promise.all([
    q<Record<string, unknown>>(
      `SELECT * FROM (${inner}) t WHERE t.rn = 1 ORDER BY ${order}, t.studentId DESC, t.appId DESC LIMIT ? OFFSET ?`,
      [...w.params, pageSize, offset],
    ),
    q<{ n: unknown }>(`SELECT COUNT(*) AS n FROM (${inner}) t WHERE t.rn = 1`, w.params),
  ]);

  return {
    kind,
    total: num(tot?.n),
    rows: rows.map((r) => ({
      appId: r.appId == null ? null : num(r.appId),
      studentId: num(r.studentId),
      studentName: `${str(r.firstName) ?? ""} ${str(r.lastName) ?? ""}`.trim(),
      partner: str(r.partner),
      university: str(r.university),
      course: str(r.course),
      intake: str(r.intake),
      country: str(r.country),
      counsellor: str(r.counsellor),
      rm: str(r.rm),
      vendor: str(r.vendor),
      leadAt: iso(r.leadAt),
      submittedAt: iso(r.submittedAt),
      stageAt: iso(r.stageAt),
      status: num(r.status),
      remark: str(r.remark),
      count: num(r.cnt),
    })),
  };
}

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

export interface Option {
  value: string;
  label: string;
}

export async function filterOptions(): Promise<{
  partners: Option[];
  rms: Option[];
  counsellors: Option[];
  universities: Option[];
  countries: string[];
  intakes: string[];
  vendors: string[];
}> {
  const [partners, rms, counsellors, universities, countries, intakes, vendors] = await Promise.all([
    q<{ k: string; label: string | null; indep: unknown }>(
      `SELECT ${E.partnerKey} AS k, MAX(${E.partnerLabel}) AS label, MAX(s.org_id IS NULL) AS indep
       FROM student s ${PARTNER_JOINS} WHERE ${E.partnerKey} IS NOT NULL GROUP BY 1`,
      [],
    ),
    q<{ id: number; label: string | null }>(
      `SELECT rmu.id AS id, ${E.rmLabel} AS label FROM cp_user rmu
       WHERE rmu.id IN (SELECT bdm_id FROM \`user\` WHERE bdm_id IS NOT NULL)`,
      [],
    ),
    q<{ id: number; label: string | null }>(
      `SELECT cu.id AS id, ${E.counsellorLabel} AS label FROM cp_user cu
       WHERE cu.id IN (SELECT cp_counsellor_id FROM student WHERE cp_counsellor_id IS NOT NULL)
          OR cu.id IN (SELECT collegepond_user_id FROM shortlist WHERE collegepond_user_id IS NOT NULL)
          OR cu.id IN (SELECT decided_by_cp_user_id FROM shortlist WHERE decided_by_cp_user_id IS NOT NULL)`,
      [],
    ),
    q<{ id: number; name: string }>(
      `SELECT un.id AS id, un.name AS name FROM university un
       WHERE un.id IN (SELECT c.university_id FROM application a JOIN course c ON c.id = a.course_id)
          OR un.id IN (SELECT c.university_id FROM shortlist sh JOIN course c ON c.id = sh.course_id)`,
      [],
    ),
    q<{ k: string }>(
      `SELECT DISTINCT un.country AS k FROM application a JOIN course c ON c.id = a.course_id JOIN university un ON un.id = c.university_id
       UNION SELECT DISTINCT s.country FROM student s WHERE s.country <> ''`,
      [],
    ),
    q<{ k: string | null }>(
      `SELECT DISTINCT ${E.appIntake} AS k ${appFrom()}
       UNION SELECT DISTINCT ${E.studentIntake} FROM student s`,
      [],
    ),
    q<{ k: string }>(
      `SELECT DISTINCT ${E.vendor} AS k ${appFrom()} UNION SELECT name FROM vendor`,
      [],
    ),
  ]);
  const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label);
  const names = new Map<string, number>();
  for (const p of partners) names.set(p.label ?? "", (names.get(p.label ?? "") ?? 0) + 1);
  const vendorSet = new Set(vendors.map((v) => v.k));
  vendorSet.add(VENDOR_DIRECT);
  vendorSet.add(VENDOR_NOT_SET);
  return {
    partners: partners
      .map((p) => {
        const label = p.label ?? "Unnamed partner";
        // An agency and an independent with the same name stay tellable apart.
        return { value: p.k, label: (names.get(p.label ?? "") ?? 0) > 1 && num(p.indep) ? `${label} (Independent)` : label };
      })
      .sort(byLabel),
    rms: rms.map((r) => ({ value: String(r.id), label: r.label ?? `User ${r.id}` })).sort(byLabel),
    counsellors: counsellors.map((r) => ({ value: String(r.id), label: r.label ?? `User ${r.id}` })).sort(byLabel),
    universities: universities.map((u) => ({ value: String(u.id), label: u.name })).sort(byLabel),
    countries: [...new Set(countries.map((c) => c.k).filter(Boolean))].sort(),
    intakes: [...new Set(intakes.map((i) => i.k).filter((x): x is string => !!x))],
    vendors: [...vendorSet].filter(Boolean).sort((a, b) => a.localeCompare(b)),
  };
}
