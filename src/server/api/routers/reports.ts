import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminSectionProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  appByDimension,
  appTotals,
  drilldown,
  filterOptions,
  funnel,
  leadCount,
  leadsByRm,
  shortlistsByCounsellor,
  trend,
  vendorSources,
} from "~/server/reports";
import {
  DRILL_SORTS,
  FUNNEL_STEPS,
  METRICS,
  addDays,
  daysInRange,
  previousPeriod,
  type Dimension,
  type DrillMetric,
  type ReportFilters,
} from "~/lib/reports";

// ---------------------------------------------------------------------------
// Reports & Analytics — Super Admin only (Suraj, 16 Nov 2026). The "reports"
// section is built in for Super Admins and not switchable (~/lib/admin-
// sections), and every procedure here is also listed in API_SECTIONS.
// Read-only and live: every call queries the portal tables; nothing is
// stored. Metric definitions: ~/lib/reports; SQL: ~/server/reports.
// ---------------------------------------------------------------------------

const reportsProcedure = adminSectionProcedure("reports");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opt = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const filtersSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  intake: opt(60),
  country: opt(3),
  partner: opt(12),
  rm: opt(12),
  counsellor: opt(12),
  university: opt(12),
  vendor: opt(150),
  status: opt(3),
});

function checkRange(from: string | undefined, to: string | undefined) {
  if (!from && !to) return;
  if (!from || !to || from > to || daysInRange(from, to) > 3700) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a valid date range." });
  }
}

const DIMENSIONS: Dimension[] = ["partner", "rm", "counsellor", "country", "university", "intake", "vendor"];
const DRILL_METRICS = [...Object.keys(METRICS), ...FUNNEL_STEPS.map((s) => s.key)] as [DrillMetric, ...DrillMetric[]];

export const reportsRouter = createTRPCRouter({
  options: reportsProcedure.query(() => filterOptions()),

  // Every tab but Weekly: totals, the stage funnel, each "X Wise" grouping,
  // leads, counsellor shortlisting and the vendor source split, for one set
  // of filters (the date range = application submitted date).
  report: reportsProcedure.input(z.object({ filters: filtersSchema })).query(async ({ input }) => {
    const f: ReportFilters = input.filters;
    checkRange(f.from, f.to);
    const [totals, stages, sources, leads, proposed, approved, ...groups] = await Promise.all([
      appTotals(f),
      funnel(f),
      vendorSources(f),
      leadCount(f),
      shortlistsByCounsellor(f, "proposed"),
      shortlistsByCounsellor(f, "approved"),
      ...DIMENSIONS.map((d) => appByDimension(f, d)),
    ]);
    const byDim = Object.fromEntries(DIMENSIONS.map((d, i) => [d, groups[i]!])) as Record<
      Dimension,
      Awaited<ReturnType<typeof appByDimension>>
    >;
    return {
      generatedAt: new Date().toISOString(),
      totals,
      funnel: stages,
      vendorSources: sources,
      leads,
      shortlists: { proposed, approved },
      byDim,
    };
  }),

  // The Weekly tab: its own start / end dates (leads by added date,
  // applications by submitted date), the period straight before it, and a
  // trend of the last 8 periods of the same length.
  weekly: reportsProcedure
    .input(z.object({ filters: filtersSchema, from: isoDate, to: isoDate }))
    .query(async ({ input }) => {
      checkRange(input.from, input.to);
      const days = daysInRange(input.from, input.to);
      if (days > 366) throw new TRPCError({ code: "BAD_REQUEST", message: "The weekly report covers up to a year." });
      const base: ReportFilters = { ...input.filters, from: undefined, to: undefined };
      const cur: ReportFilters = { ...base, from: input.from, to: input.to };
      const prevRange = previousPeriod(input.from, input.to);
      const prev: ReportFilters = { ...base, ...prevRange };
      const BUCKETS = 8;
      const [curTotals, prevTotals, curLeads, prevLeads, rmLeads, prevRmLeads, proposed, prevProposed, approved, series] =
        await Promise.all([
          appTotals(cur),
          appTotals(prev),
          leadCount(cur),
          leadCount(prev),
          leadsByRm(cur),
          leadsByRm(prev),
          shortlistsByCounsellor(cur, "proposed"),
          shortlistsByCounsellor(prev, "proposed"),
          shortlistsByCounsellor(cur, "approved"),
          trend(base, input.to, days, BUCKETS),
        ]);
      const periods = Array.from({ length: BUCKETS }, (_, i) => {
        const to = addDays(input.to, -(BUCKETS - 1 - i) * days);
        return { from: addDays(to, -(days - 1)), to };
      });
      return {
        generatedAt: new Date().toISOString(),
        from: input.from,
        to: input.to,
        prevFrom: prevRange.from,
        prevTo: prevRange.to,
        current: { totals: curTotals, leads: curLeads, shortlisted: proposed.total },
        previous: { totals: prevTotals, leads: prevLeads, shortlisted: prevProposed.total },
        rmLeads,
        prevRmLeads,
        shortlists: { proposed, approved },
        trend: { periods, ...series },
      };
    }),

  // The records behind any count: the same filters plus one metric (a
  // grouping's row is just one more filter, e.g. partner = "o12").
  drilldown: reportsProcedure
    .input(
      z.object({
        filters: filtersSchema,
        metric: z.enum(DRILL_METRICS),
        search: z.string().max(100).optional(),
        sort: z.enum(DRILL_SORTS).optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        page: z.number().int().min(1).max(100000).default(1),
        pageSize: z.number().int().min(1).max(5000).default(25),
      }),
    )
    .query(({ input }) => {
      checkRange(input.filters.from, input.filters.to);
      return drilldown(input);
    }),
});
