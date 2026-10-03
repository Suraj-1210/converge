import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { bdmPerformanceProcedure, createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { AdminRole } from "~/server/db/enums";

// application.status (UniApplicationStatus): 0 begin · 1 docs · 2 submitted · 3 review ·
// 4 conditional offer · 5 unconditional offer · 6 deposit · 7 visa · 8 enrolled · 20+ terminal.
const ACTIVE_APP = { lt: 20 };
const DEPOSIT_STATUSES = [6, 7, 8];
function pipeSegment(status: number): "leads" | "preapp" | "submitted" | "offer" | "deposit" | null {
  if (status === 0) return "leads";
  if (status === 1) return "preapp";
  if (status === 2 || status === 3) return "submitted";
  if (status === 4 || status === 5) return "offer";
  if (status >= 6 && status <= 8) return "deposit";
  return null;
}

// Partner status from the owner user's account status (UserStatus 0/1/2/3).
function partnerStatus(userStatus: number): "Active" | "Pending" | "Deactivated" {
  if (userStatus === 1) return "Active";
  if (userStatus === 0) return "Pending";
  return "Deactivated";
}
// user.tier is a raw int with no canonical taxonomy — map it to the 5-tier display scale.
const TIER_NAMES = ["Silver", "Gold", "Platinum", "Titanium", "Diamond"] as const;
const tierLabel = (tier: number) => TIER_NAMES[Math.max(0, Math.min(TIER_NAMES.length - 1, tier))]!;

const MS_DAY = 86_400_000;
function daysSince(d: Date | null): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / MS_DAY));
}

export const bdmRouter = createTRPCRouter({
  // BDM selector — staff with the BDM role + their assigned-partner counts.
  bdms: protectedAdminProcedure.query(async () => {
    const [staff, owners] = await Promise.all([
      db.collegepond_user.findMany({
        where: { role: AdminRole.BDM, status: 1 },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
        select: { id: true, first_name: true, last_name: true },
      }),
      db.user.findMany({ where: { is_owner: 1, org_id: { not: null }, bdm_id: { not: null } }, select: { bdm_id: true } }),
    ]);
    const counts = new Map<number, number>();
    for (const o of owners) if (o.bdm_id != null) counts.set(o.bdm_id, (counts.get(o.bdm_id) ?? 0) + 1);
    return {
      total: owners.length,
      bdms: staff.map((s) => ({ id: s.id, name: `${s.first_name} ${s.last_name}`.trim(), partnerCount: counts.get(s.id) ?? 0 })),
    };
  }),

  overview: bdmPerformanceProcedure
    .input(z.object({ bdmId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) => {
      // A BDM sees only their own portfolio. The page hides the BDM selector
      // for them, but that is presentation: the server enforces it. Asking for
      // another BDM is refused, and asking for "all" narrows to themselves.
      const isBdm = ctx.cpUser.role === AdminRole.BDM;
      if (isBdm && input?.bdmId != null && input.bdmId !== ctx.cpUser.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only view your own portfolio." });
      }
      const bdmId = isBdm ? ctx.cpUser.id : input?.bdmId;
      // The leaderboard ranks every BDM by revenue, so only Super Admin gets it.
      const showLeaderboard = ctx.cpUser.role === AdminRole.SUPER_ADMIN;

      const orgs = await db.organization.findMany({ select: { id: true, name: true, city: true, country: true } });
      const orgIds = orgs.map((o) => o.id);
      if (orgIds.length === 0) return { stats: { partners: 0, revenue: 0 }, partners: [], leaderboard: [] };

      const [users, studentG, appG, depoG, commG, pipeG, lastG] = await Promise.all([
        // Representative user per org (owner first), carrying bdm/tier/status.
        db.user.findMany({ where: { org_id: { in: orgIds } }, select: { org_id: true, is_owner: true, bdm_id: true, tier: true, status: true }, orderBy: [{ is_owner: "desc" }, { id: "asc" }] }),
        db.student.groupBy({ by: ["org_id"], _count: { id: true } }),
        db.application.groupBy({ by: ["org_id"], where: { status: ACTIVE_APP }, _count: { id: true } }),
        db.application.groupBy({ by: ["org_id"], where: { status: { in: DEPOSIT_STATUSES } }, _count: { id: true } }),
        db.commission.groupBy({ by: ["org_id"], _sum: { commision_amount: true } }),
        db.application.groupBy({ by: ["org_id", "status"], where: { status: ACTIVE_APP }, _count: { id: true } }),
        db.application.groupBy({ by: ["org_id"], _max: { updated_at: true } }),
      ]);

      const repByOrg = new Map<number, { bdm_id: number | null; tier: number; status: number }>();
      for (const u of users) if (u.org_id != null && !repByOrg.has(u.org_id)) repByOrg.set(u.org_id, { bdm_id: u.bdm_id, tier: u.tier, status: u.status });
      const num = <T extends { org_id: number | null }>(g: T[], pick: (x: T) => number) => { const m = new Map<number, number>(); for (const r of g) if (r.org_id != null) m.set(r.org_id, pick(r)); return m; };
      const students = num(studentG, (r) => r._count.id);
      const apps = num(appG, (r) => r._count.id);
      const deposits = num(depoG, (r) => r._count.id);
      const revenue = num(commG, (r) => Number(r._sum.commision_amount ?? 0));
      const lastAct = new Map<number, Date | null>();
      for (const r of lastG) if (r.org_id != null) lastAct.set(r.org_id, r._max.updated_at);
      const pipe = new Map<number, { leads: number; preapp: number; submitted: number; offer: number; deposit: number }>();
      for (const r of pipeG) {
        if (r.org_id == null) continue;
        const seg = pipeSegment(r.status);
        if (!seg) continue;
        const cur = pipe.get(r.org_id) ?? { leads: 0, preapp: 0, submitted: 0, offer: 0, deposit: 0 };
        cur[seg] += r._count.id;
        pipe.set(r.org_id, cur);
      }

      let partners = orgs.map((o) => {
        const rep = repByOrg.get(o.id);
        const a = apps.get(o.id) ?? 0;
        const d = deposits.get(o.id) ?? 0;
        const rev = revenue.get(o.id) ?? 0;
        return {
          id: o.id,
          name: o.name,
          city: o.city ?? "—",
          country: o.country ?? null,
          bdmId: rep?.bdm_id ?? null,
          tier: rep?.tier ?? 0,
          tierLabel: tierLabel(rep?.tier ?? 0),
          status: partnerStatus(rep?.status ?? 0),
          students: students.get(o.id) ?? 0,
          apps: a,
          deposits: d,
          conversion: a > 0 ? Math.round((d / a) * 100) : 0,
          revenue: rev,
          lastActDays: daysSince(lastAct.get(o.id) ?? null),
          pipe: pipe.get(o.id) ?? { leads: 0, preapp: 0, submitted: 0, offer: 0, deposit: 0 },
        };
      });

      // Leaderboard (all BDMs, active partners only), Super Admin only. Computed
      // before the BDM filter so it always ranks everyone.
      const staff = showLeaderboard
        ? await db.collegepond_user.findMany({ where: { role: AdminRole.BDM }, select: { id: true, first_name: true, last_name: true } })
        : [];
      const leaderboard = staff
        .map((s) => {
          const mine = partners.filter((p) => p.bdmId === s.id && p.status === "Active");
          return {
            id: s.id,
            name: `${s.first_name} ${s.last_name}`.trim(),
            partners: mine.length,
            students: mine.reduce((sum, p) => sum + p.students, 0),
            revenue: mine.reduce((sum, p) => sum + p.revenue, 0),
          };
        })
        .filter((l) => l.partners > 0)
        .sort((a, b) => b.revenue - a.revenue);

      // "BDM Performance" counts only BDM-MANAGED partners: a specific BDM's
      // partners when one is selected, else every partner that has ANY BDM
      // assigned. Unassigned orgs would otherwise inflate the KPIs/portfolio and
      // contradict the BDM-scoped leaderboard. (Assign a BDM from the Partners
      // page to bring an org in here.)
      partners =
        bdmId != null
          ? partners.filter((p) => p.bdmId === bdmId)
          : partners.filter((p) => p.bdmId != null);
      partners.sort((a, b) => b.revenue - a.revenue);

      return {
        stats: { partners: partners.length, revenue: partners.reduce((s, p) => s + p.revenue, 0) },
        partners,
        leaderboard,
      };
    }),
});
