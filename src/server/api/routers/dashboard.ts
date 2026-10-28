import { TRPCError } from "@trpc/server";
import {
  createCallerFactory,
  createTRPCRouter,
  payeeProcedure,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { partnerCommissionRouter } from "~/server/api/routers/partner-commission";
import { type db as appDb } from "~/server/db";
import {
  AdminRole,
  StudentOverallStatus,
  UniApplicationStatus,
  UserStatus,
  UserType,
} from "~/server/db/enums";
import { currentStage, isClosedStage, stageAtLeast, stageIndex } from "~/lib/application-stages";
import { overallStudentStatus } from "~/lib/student-pipeline";
import {
  isCounsellingRole,
  isScopedStaffRole,
  staffApplicationScope,
  staffPartnerScope,
  staffStudentScope,
} from "~/server/staff-access";
import {
  partnerRefForUser,
  partnerTierStatus,
  partnerTierStatuses,
  serializeStatus,
} from "~/server/partner-tiers";

// ---------------------------------------------------------------------------
// Dashboard aggregations.
//   adminStats   — admin dashboard. Portal-wide for Super Admin and the
//                  non-counselling roles; a Counsellor / Counsellor Lead sees
//                  only their own students, applications and partners, and a
//                  BDM only the partners they are BDM of
//                  (src/server/staff-access.ts). Recent Activity is the
//                  global feed for Super Admin and the user's own actions for
//                  everyone else.
//   counsellorStats — the Counsellor / Counsellor Lead dashboard (27 Oct):
//                  student tiles and the student and application pipelines,
//                  over the same students.
//   partnerStats — scoped to the signed-in partner's org (or, for independent
//                  counsellors with no org, the students they created).
//
// Milestone KPIs use the happy-path ordering of UniApplicationStatus
// (offer 4/5 → deposit 6 → visa filed 9 → visa 7 → enrolled 8; codes are not
// in order, see ~/lib/application-stages). "Offers"/"Deposits" count apps at
// that stage OR beyond, so a deposit-paid app still counts as having an offer.
// "Visas" means secured: a filed visa is not yet a visa.
// Terminal outcomes (>=20: rejected/withdrawn/etc.) are intentionally excluded.
// ---------------------------------------------------------------------------

const OFFER_OR_BEYOND = [
  UniApplicationStatus.CONDITIONAL_OFFER,
  UniApplicationStatus.UNCONDITIONAL_OFFER,
  UniApplicationStatus.DEPOSIT_PAID,
  UniApplicationStatus.VISA_FILED,
  UniApplicationStatus.VISA_SECURED,
  UniApplicationStatus.ENROLLED,
];
const DEPOSIT_OR_BEYOND = [
  UniApplicationStatus.DEPOSIT_PAID,
  UniApplicationStatus.VISA_FILED,
  UniApplicationStatus.VISA_SECURED,
  UniApplicationStatus.ENROLLED,
];
const VISA_OR_BEYOND = [
  UniApplicationStatus.VISA_SECURED,
  UniApplicationStatus.ENROLLED,
];

type PrismaDb = typeof appDb;

// Trend pill shape returned with each admin KPI (null = nothing to compare).
type Trend = { value: string; dir: "up" | "down" } | null;

// The "applications by country" figure over a scoped set of students (the
// global one is a single GROUP BY in SQL).
async function applicationsByCountryScoped(
  db: PrismaDb,
  studentScope: Awaited<ReturnType<typeof staffStudentScope>>,
): Promise<{ country: string; count: bigint }[]> {
  const rows = await db.student.findMany({
    where: { AND: [studentScope], application: { some: {} } },
    select: { country: true, _count: { select: { application: true } } },
  });
  const byCountry = new Map<string, number>();
  for (const r of rows) {
    byCountry.set(r.country, (byCountry.get(r.country) ?? 0) + r._count.application);
  }
  return [...byCountry.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([country, count]) => ({ country, count: BigInt(count) }));
}

export const dashboardRouter = createTRPCRouter({
  // ===== Admin overview =====
  adminStats: protectedAdminProcedure.query(async ({ ctx }) => {
    const { db } = ctx;
    const me = ctx.cpUser;
    const scoped = isScopedStaffRole(me.role);
    // One visibility rule for every figure below ({} = everything).
    const [studentScope, appScope, partnerScope] = await Promise.all([
      staffStudentScope(me),
      staffApplicationScope(me),
      staffPartnerScope(me),
    ]);
    const partnerWhere = { AND: [partnerScope], type: { not: UserType.ADMIN } };
    const commissionScope = scoped ? { application: appScope } : {};
    // Top Partners: a counsellor's ranking covers only their own partners.
    const myOrgIds = scoped
      ? [
          ...new Set(
            (await db.user.findMany({ where: partnerScope, select: { org_id: true } }))
              .map((u) => u.org_id)
              .filter((x): x is number => x !== null),
          ),
        ]
      : null;
    // Recent Activity: Super Admin sees everyone; anyone else their own
    // actions, including ones a Super Admin took while impersonating them.
    const activityWhere =
      me.role === AdminRole.SUPER_ADMIN
        ? {}
        : {
            OR: [
              { metadata: { path: "$.byCpUserId", equals: me.id } },
              {
                AND: [
                  { metadata: { path: "$.impersonation.kind", equals: "staff" } },
                  { metadata: { path: "$.impersonation.id", equals: me.id } },
                ],
              },
            ],
          };

    // Time windows for month-over-month / year-over-year trend pills.
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const lastYearStart = new Date(now.getFullYear() - 1, 0, 1);
    const lastYearToDate = new Date(
      now.getFullYear() - 1,
      now.getMonth(),
      now.getDate(),
    );

    const [
      partners,
      partnersThisMonth,
      students,
      studentsThisMonth,
      studentsLastMonth,
      applicationsActive,
      appsThisMonth,
      appsLastMonth,
      pendingApprovals,
      queueRaw,
      topOrgsRaw,
      appByOrgRaw,
      depByOrgRaw,
      revByOrgRaw,
      appByCourse,
      byCountryRows,
      revYtdAgg,
      revLastYtdAgg,
      recent,
    ] = await Promise.all([
      db.user.count({ where: partnerWhere }),
      db.user.count({
        where: { ...partnerWhere, created_at: { gte: monthStart } },
      }),
      db.student.count({ where: studentScope }),
      db.student.count({ where: { AND: [studentScope], created_at: { gte: monthStart } } }),
      db.student.count({
        where: { AND: [studentScope], created_at: { gte: lastMonthStart, lt: monthStart } },
      }),
      // "Active" applications = anything not in a terminal outcome (>=20).
      db.application.count({ where: { AND: [appScope], status: { lt: 20 } } }),
      db.application.count({ where: { AND: [appScope], created_at: { gte: monthStart } } }),
      db.application.count({
        where: { AND: [appScope], created_at: { gte: lastMonthStart, lt: monthStart } },
      }),
      db.user.count({
        where: { ...partnerWhere, status: UserStatus.UNDER_REVIEW },
      }),
      db.application.groupBy({ by: ["status"], where: appScope, _count: true }),
      db.student.groupBy({
        by: ["org_id"],
        where: { org_id: myOrgIds ? { in: myOrgIds } : { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 8,
      }),
      db.application.groupBy({ by: ["org_id"], _count: { id: true } }),
      db.application.groupBy({
        by: ["org_id"],
        where: { status: { in: DEPOSIT_OR_BEYOND } },
        _count: { id: true },
      }),
      db.commission.groupBy({
        by: ["org_id"],
        _sum: { commision_amount: true },
      }),
      db.application.groupBy({
        by: ["course_id"],
        where: appScope,
        _count: { course_id: true },
      }),
      // Applications by destination country (student.country, ISO2).
      scoped
        ? applicationsByCountryScoped(db, studentScope)
        : db.$queryRaw<{ country: string; count: bigint }[]>`
            SELECT s.country AS country, COUNT(*) AS count
            FROM application a
            JOIN student s ON a.student_id = s.id
            GROUP BY s.country
            ORDER BY count DESC
            LIMIT 6`,
      db.commission.aggregate({
        _sum: { commision_amount: true },
        where: { ...commissionScope, created_at: { gte: yearStart } },
      }),
      db.commission.aggregate({
        _sum: { commision_amount: true },
        where: { ...commissionScope, created_at: { gte: lastYearStart, lt: lastYearToDate } },
      }),
      db.audit_log.findMany({
        where: activityWhere,
        orderBy: { created_at: "desc" },
        take: 8,
        select: {
          id: true,
          action: true,
          entity_type: true,
          created_at: true,
        },
      }),
    ]);

    // Trend pill — % change vs the comparison window. null when nothing to compare.
    const trend = (cur: number, prev: number): Trend => {
      if (prev === 0) return cur === 0 ? null : { value: "New", dir: "up" };
      const p = Math.round(((cur - prev) / prev) * 1000) / 10;
      return { value: `${p >= 0 ? "+" : ""}${p}%`, dir: p >= 0 ? "up" : "down" };
    };

    const revenueYtd = Number(revYtdAgg._sum.commision_amount ?? 0);
    const revenueLastYtd = Number(revLastYtdAgg._sum.commision_amount ?? 0);

    // Application queue — count per stage, in pipeline order, closed last.
    const queueOrder = (s: number) => (stageIndex(s) >= 0 ? stageIndex(s) : 100 + s);
    const applicationQueue = queueRaw
      .map((g) => ({ status: g.status, count: g._count }))
      .sort((a, b) => queueOrder(a.status) - queueOrder(b.status));

    // Top partners — students from topOrgsRaw, enriched with apps/deposits/revenue.
    // Agencies only: an independent counsellor's applications and
    // commissions have no org_id, so their null-key groups are skipped.
    const topOrgs = topOrgsRaw.filter(
      (g): g is typeof g & { org_id: number } => g.org_id !== null,
    );
    const orgs = topOrgs.length
      ? await db.organization.findMany({
          where: { id: { in: topOrgs.map((g) => g.org_id) } },
          select: { id: true, name: true, city: true },
        })
      : [];
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const appByOrg = new Map<number, number>();
    for (const g of appByOrgRaw) if (g.org_id != null) appByOrg.set(g.org_id, g._count.id);
    const depByOrg = new Map<number, number>();
    for (const g of depByOrgRaw) if (g.org_id != null) depByOrg.set(g.org_id, g._count.id);
    const revByOrg = new Map<number, number>();
    for (const g of revByOrgRaw)
      if (g.org_id != null) revByOrg.set(g.org_id, Number(g._sum.commision_amount ?? 0));
    // Partner Tiers: the agency's tier this FY (automatic, or a Super Admin
    // floor), held by its owner.
    const owners = topOrgs.length
      ? await db.user.findMany({
          where: {
            org_id: { in: topOrgs.map((g) => g.org_id) },
            is_owner: 1,
            type: UserType.AGENCY_OWNER,
            deleted_at: null,
          },
          select: { id: true, org_id: true },
        })
      : [];
    const tierStatuses = await partnerTierStatuses(
      owners.map((o) => ({ userId: o.id, orgId: o.org_id })),
    );
    const tierByOrg = new Map<number, ReturnType<typeof serializeStatus>>();
    for (const o of owners) {
      const t = o.org_id != null ? tierStatuses.get(o.id) : undefined;
      if (t) tierByOrg.set(o.org_id!, serializeStatus(t));
    }
    const topPartners = topOrgs.map((g) => ({
      orgId: g.org_id,
      tier: tierByOrg.get(g.org_id) ?? null,
      name: orgById.get(g.org_id)?.name ?? "—",
      city: orgById.get(g.org_id)?.city ?? null,
      students: g._count.id,
      applications: appByOrg.get(g.org_id) ?? 0,
      deposits: depByOrg.get(g.org_id) ?? 0,
      revenue: revByOrg.get(g.org_id) ?? 0,
    }));

    // Top universities — applications grouped by course, rolled up to university.
    const courses = appByCourse.length
      ? await db.course.findMany({
          where: { id: { in: appByCourse.map((g) => g.course_id) } },
          select: { id: true, university_id: true },
        })
      : [];
    const courseUni = new Map(courses.map((c) => [c.id, c.university_id]));
    const uniCount = new Map<number, number>();
    for (const g of appByCourse) {
      const uid = courseUni.get(g.course_id);
      if (uid == null) continue;
      uniCount.set(uid, (uniCount.get(uid) ?? 0) + g._count.course_id);
    }
    const unis = uniCount.size
      ? await db.university.findMany({
          where: { id: { in: [...uniCount.keys()] } },
          select: { id: true, name: true },
        })
      : [];
    const uniName = new Map(unis.map((u) => [u.id, u.name]));
    const topUniversities = [...uniCount.entries()]
      .map(([id, count]) => ({ id, name: uniName.get(id) ?? "—", applications: count }))
      .sort((a, b) => b.applications - a.applications)
      .slice(0, 6);

    const applicationsByCountry = byCountryRows.map((r) => ({
      country: r.country,
      count: Number(r.count),
    }));

    const recentActivity = recent.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      at: r.created_at,
    }));

    return {
      kpis: {
        students: {
          value: students,
          trend: trend(studentsThisMonth, studentsLastMonth),
        },
        applications: {
          value: applicationsActive,
          trend: trend(appsThisMonth, appsLastMonth),
        },
        partners: {
          value: partners,
          trend:
            partnersThisMonth > 0
              ? { value: `+${partnersThisMonth} new`, dir: "up" as const }
              : null,
        },
        revenue: { value: revenueYtd, trend: trend(revenueYtd, revenueLastYtd) },
        pendingApprovals,
      },
      applicationQueue,
      topPartners,
      topUniversities,
      applicationsByCountry,
      recentActivity,
    };
  }),

  // ===== Counsellor overview =====
  // Tiles: Total Students, Active Students (overall status Active), Active
  // Applicants (an open application), Visa Approved (an application at Visa
  // Approved or Enrolled). Student Pipeline = the overall student status
  // (~/lib/student-pipeline). Application Pipeline = open applications by
  // stage, each counted once: a deferred one (deferred_intake_* set) under
  // Deferred to Next Intake, Under Review with Submitted, Enrolled with Visa
  // Approved; earlier stages aren't part of it.
  counsellorStats: protectedAdminProcedure.query(async ({ ctx }) => {
    if (!isCounsellingRole(ctx.cpUser.role)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "For counsellors only." });
    }
    const students = await ctx.db.student.findMany({
      where: await staffStudentScope(ctx.cpUser),
      select: {
        inactive_at: true,
        application: {
          select: {
            status: true,
            deferred_intake_month: true,
            stage_history: { select: { stage: true } },
          },
        },
        document: { where: { is_most_recent: 1 }, select: { doc_type: true } },
      },
    });

    const S = UniApplicationStatus;
    const pipelineKey: Partial<Record<number, number>> = {
      [S.APPLICATION_SUBMITTED]: S.APPLICATION_SUBMITTED,
      [S.APPLICATION_UNDER_REVIEW]: S.APPLICATION_SUBMITTED,
      [S.CONDITIONAL_OFFER]: S.CONDITIONAL_OFFER,
      [S.UNCONDITIONAL_OFFER]: S.UNCONDITIONAL_OFFER,
      [S.DEPOSIT_PAID]: S.DEPOSIT_PAID,
      [S.VISA_FILED]: S.VISA_FILED,
      [S.VISA_SECURED]: S.VISA_SECURED,
      [S.ENROLLED]: S.VISA_SECURED,
    };
    const appCounts = new Map<number, number>();
    const bump = (k: number) => appCounts.set(k, (appCounts.get(k) ?? 0) + 1);
    const studentCounts = { active: 0, inactive: 0, docsPending: 0 };
    let activeApplicants = 0;
    let visaApproved = 0;

    for (const s of students) {
      const overall = overallStudentStatus({
        inactiveAt: s.inactive_at,
        apps: s.application.map((a) => ({ status: a.status, stage: currentStage(a.status, a.stage_history) })),
        docTypes: s.document.map((d) => d.doc_type),
      });
      if (overall === StudentOverallStatus.ACTIVE) studentCounts.active++;
      else if (overall === StudentOverallStatus.INACTIVE) studentCounts.inactive++;
      else studentCounts.docsPending++;

      const open = s.application.filter((a) => !isClosedStage(a.status));
      if (open.length > 0) activeApplicants++;
      if (s.application.some((a) => stageAtLeast(a.status, S.VISA_SECURED))) visaApproved++;
      for (const a of open) {
        if (a.deferred_intake_month != null) bump(S.DEFERRED_TO_NEXT_INTAKE);
        else if (pipelineKey[a.status] !== undefined) bump(pipelineKey[a.status]!);
      }
    }

    return {
      tiles: {
        totalStudents: students.length,
        activeStudents: studentCounts.active,
        activeApplicants,
        visaApproved,
      },
      studentPipeline: studentCounts,
      applicationPipeline: [
        S.APPLICATION_SUBMITTED,
        S.CONDITIONAL_OFFER,
        S.UNCONDITIONAL_OFFER,
        S.DEPOSIT_PAID,
        S.VISA_FILED,
        S.VISA_SECURED,
        S.DEFERRED_TO_NEXT_INTAKE,
      ].map((status) => ({ status, count: appCounts.get(status) ?? 0 })),
    };
  }),

  // ===== Partner overview =====
  partnerStats: protectedPartnerProcedure.query(async ({ ctx }) => {
    const { db } = ctx;
    const me = await db.user.findUnique({
      where: { id: ctx.cpPartner.id },
      select: {
        id: true,
        org_id: true,
        is_owner: true,
        bdm_id: true,
        counsellor_id: true,
        lead_counsellor_id: true,
      },
    });
    if (!me) return null;

    // Collegepond assigns the counsellor, counsellor lead and BDM on the agency
    // owner. An agency staff member sees their owner's team.
    let team = me;
    if (me.org_id && !me.is_owner) {
      const owner = await db.user.findFirst({
        where: { org_id: me.org_id, is_owner: 1 },
        select: { id: true, org_id: true, is_owner: true, bdm_id: true, counsellor_id: true, lead_counsellor_id: true },
      });
      if (owner) team = owner;
    }
    const staffIds = [team.counsellor_id, team.lead_counsellor_id, team.bdm_id].filter(
      (x): x is number => x != null,
    );

    // Agency partners scope by org; independents by the students they created.
    const appWhere = me.org_id
      ? { org_id: me.org_id }
      : { student: { created_by_user_id: me.id } };
    const studentWhere = me.org_id
      ? { org_id: me.org_id }
      : { created_by_user_id: me.id };

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

    const [
      applications,
      offers,
      deposits,
      visas,
      studentsThisYear,
      recentRaw,
      eventsRaw,
      staff,
    ] = await Promise.all([
      db.application.count({ where: appWhere }),
      db.application.count({
        where: { ...appWhere, status: { in: OFFER_OR_BEYOND } },
      }),
      db.application.count({
        where: { ...appWhere, status: { in: DEPOSIT_OR_BEYOND } },
      }),
      db.application.count({
        where: { ...appWhere, status: { in: VISA_OR_BEYOND } },
      }),
      db.student.count({
        where: { ...studentWhere, created_at: { gte: yearStart } },
      }),
      db.application.findMany({
        where: appWhere,
        orderBy: { created_at: "desc" },
        take: 5,
        select: {
          id: true,
          status: true,
          created_at: true,
          student: { select: { first_name: true, last_name: true } },
          course: { select: { university: { select: { name: true } } } },
        },
      }),
      db.event.findMany({
        where: { is_active: 1, event_date: { gte: todayStart } },
        orderBy: { event_date: "asc" },
        take: 4,
        select: {
          id: true,
          title: true,
          event_date: true,
          location: true,
          is_virtual: true,
        },
      }),
      staffIds.length
        ? db.collegepond_user.findMany({
            where: { id: { in: staffIds }, status: 1 },
            select: { id: true, first_name: true, last_name: true, phone: true },
          })
        : Promise.resolve([]),
    ]);
    const person = (id: number | null) => {
      const p = id != null ? staff.find((s) => s.id === id) : undefined;
      return p ? { name: `${p.first_name} ${p.last_name}`.trim(), phone: p.phone } : null;
    };
    // Counsellor first, counsellor lead second — shown without role labels so
    // partners don't default to contacting the lead.
    const contacts = [person(team.counsellor_id), person(team.lead_counsellor_id)].filter(
      (c, i, all): c is { name: string; phone: string } =>
        c != null && all.findIndex((o) => o?.name === c.name) === i,
    );

    return {
      kpis: { applications, offers, deposits, visas },
      recentApplications: recentRaw.map((a) => ({
        id: a.id,
        status: a.status,
        at: a.created_at,
        student: `${a.student.first_name} ${a.student.last_name}`.trim(),
        university: a.course.university.name,
      })),
      events: eventsRaw.map((e) => ({
        id: e.id,
        title: e.title,
        date: e.event_date,
        location: e.location,
        isVirtual: e.is_virtual === 1,
      })),
      contacts,
      // The team's BDM, shown to partners as their Relationship Manager.
      relationshipManager: person(team.bdm_id),
      studentsThisYear,
    };
  }),

  // ===== Partner owner only =====
  // The tier and the Important Notices (MOU, commission and payout-account
  // updates) belong to the partner owner: the agency owner or the independent.
  // Agency counsellors get FORBIDDEN from payeeProcedure. The client hides
  // these for them too, but this is the enforcement.

  // The partner's loyalty tier from the Partner Tiers master: automatic from
  // this FY's confirmed students, or a higher tier a Super Admin set.
  partnerTier: payeeProcedure.query(async ({ ctx }) => {
    const ref = await partnerRefForUser(ctx.payee.id);
    if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
    const status = await partnerTierStatus(ref);
    if (!status) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Partner tiers aren't set up yet." });
    }
    return serializeStatus(status);
  }),

  partnerNotices: payeeProcedure.query(async ({ ctx }) => {
    const me = await ctx.db.user.findUnique({
      where: { id: ctx.payee.id },
      select: { mou_signed_at: true },
    });
    if (!me) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });

    const notices: OwnerNotice[] = [];
    notices.push(
      me.mou_signed_at
        ? {
            id: "mou",
            tone: "green",
            title: "Your MOU is signed",
            body: `Signed on ${formatNoticeDate(me.mou_signed_at)}. View or download it under My Account → Documents.`,
            href: "/partner/account?tab=documents",
          }
        : {
            id: "mou",
            tone: "amber",
            title: "Your MOU is waiting for your signature",
            href: "/mou-signing",
          },
    );

    // Commission and payout account belong to an organization. An independent
    // without one has neither yet, so there's nothing to report.
    if (ctx.payee.orgId != null) {
      // The Commission page's own procedures, so the numbers always match it.
      const commission = createCallerFactory(partnerCommissionRouter)(ctx);
      const [claims, bank] = await Promise.all([
        commission.listClaimable(),
        commission.bankAccount(),
      ]);
      const ready = claims.filter((c) => c.status === "claimable");
      if (ready.length > 0) {
        const total = ready.reduce((s, c) => s + c.claimableInr, 0);
        notices.push({
          id: "commission-claimable",
          tone: "green",
          title: `${ready.length} commission${ready.length === 1 ? " is" : "s are"} ready to claim`,
          body: `${formatInr(total)} available. Raise an invoice from the Commission page.`,
          href: "/partner/commission",
        });
      }
      const monthAgo = Date.now() - 30 * 86_400_000;
      const paid = claims.filter((c) => c.paidAt && c.paidAt.getTime() >= monthAgo);
      if (paid.length > 0) {
        notices.push({
          id: "commission-paid",
          tone: "blue",
          title: `${paid.length} commission${paid.length === 1 ? " was" : "s were"} paid out in the last 30 days`,
          body: "See the payment dates on the Commission page.",
          href: "/partner/commission",
        });
      }
      if (!bank.hasAccount) {
        notices.push({
          id: "bank",
          tone: "amber",
          title: "Add your bank details to get paid",
          body: "Commission can only be paid out to a verified bank account.",
          href: "/partner/account?tab=bank",
        });
      } else if (bank.status === "rejected") {
        notices.push({
          id: "bank",
          tone: "red",
          title: "Your bank details need attention",
          body: bank.rejectionReason ?? "Please re-enter them with a valid proof.",
          href: "/partner/account?tab=bank",
        });
      } else if (bank.status === "pending") {
        notices.push({
          id: "bank",
          tone: "blue",
          title: "Your bank details are being verified",
          href: "/partner/account?tab=bank",
        });
      }
    }

    return notices;
  }),
});

type OwnerNotice = {
  id: string;
  tone: "green" | "amber" | "red" | "blue";
  title: string;
  body?: string;
  href?: string;
};

const formatNoticeDate = (d: Date) =>
  d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const formatInr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
