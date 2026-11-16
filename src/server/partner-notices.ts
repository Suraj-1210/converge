import "server-only";
import { db } from "~/server/db";
import {
  DocumentStatus,
  EventRegistrationStatus,
  UniApplicationStatus,
  UserType,
  rejectionReasonText,
} from "~/server/db/enums";
import {
  NOTICE_TRIGGERS,
  NoticeAudience,
  audienceIncludes,
  renderTemplate,
  severityTone,
  type NoticeSeverity,
  type NoticeView,
  type TriggerConfig,
  type TriggerDef,
  type ViewerRole,
} from "~/lib/partner-notices";
import { PARTNER_DOC_SLOTS } from "~/lib/constants/partner-documents";
import { partnerDocLabel } from "~/lib/constants/partner-labels";
import { activeHold } from "~/server/adjustments";
import { independentPayee, orgPayee } from "~/server/payee";
import {
  currentTierFy,
  fyStudentCounts,
  partnerRefForUser,
  partnerTierStatus,
  stepForCount,
  todayIst,
} from "~/server/partner-tiers";

// Important Notices on the partner dashboard (Settings -> Partner Notices).
//
// One registry: each trigger code (~/lib/partner-notices) has an evaluator
// here that returns 0..n notices as placeholder values; the master
// (partner_notice_trigger, no row = defaults) decides whether it runs, its
// wording, severity, order, window and audience. Manual notices
// (partner_manual_notice) are added on top.
//
// Who sees what:
//   owner       agency owner or independent counsellor (the payee)
//   counsellor  an agency counsellor
// Money and account triggers (ownerOnly) NEVER run for a counsellor, whatever
// the master says; their data is the agency's (payeeProcedure semantics).
// Student triggers cover, for an owner, every student of the agency (an
// independent: the students they created) and, for a counsellor, the students
// they handle: student.counsellor_id, or the creator while unassigned (the
// same rule as partner chat).
//
// Cost: one small config read, one manual-notice read, and one query per
// group of enabled triggers, all in parallel. The commission page's own
// procedures run only when a commission/bank trigger is on.

const DAY_MS = 86_400_000;
// A busy agency can have dozens of offers in a fortnight; each trigger shows
// at most this many (newest first).
export const MAX_PER_TRIGGER = 10;

export type NoticeViewer = {
  userId: number;
  orgId: number | null;
  role: ViewerRole;
  // agency owner / independent; false for a counsellor
  isPayee: boolean;
  isIndependent: boolean;
};

// The commission page's numbers, loaded by the caller (it needs the tRPC ctx)
// only when asked. Null when the partner can't use the Commission tab.
export type CommissionData = {
  claims: { status: string; claimableInr: number; paidAt: Date | null }[];
  bank: { hasAccount: boolean; status: string | null; rejectionReason: string | null };
};

type Values = Record<string, string | number>;
type Hit = { key: string; values: Values; href: string; at?: Date };

const formatDate = (d: Date) =>
  d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const formatUtcDate = (d: Date) =>
  d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const formatInr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export async function noticeViewerFor(userId: number): Promise<NoticeViewer | null> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, type: true, is_owner: true, org_id: true },
  });
  if (!u) return null;
  // Same test as payeeProcedure.
  const isOwner = u.type === UserType.AGENCY_OWNER && u.is_owner === 1 && u.org_id !== null;
  const isIndependent = u.type === UserType.INDEPENDENT_COUNSELLOR;
  const isPayee = isOwner || isIndependent;
  return { userId: u.id, orgId: u.org_id, role: isPayee ? "owner" : "counsellor", isPayee, isIndependent };
}

// ---- config ---------------------------------------------------------------------

export type EffectiveTrigger = { def: TriggerDef; config: TriggerConfig; customized: boolean };

export async function effectiveTriggers(): Promise<EffectiveTrigger[]> {
  const rows = await db.partner_notice_trigger.findMany();
  const byCode = new Map(rows.map((r) => [r.code, r]));
  return NOTICE_TRIGGERS.map((def) => {
    const r = byCode.get(def.code);
    if (!r) return { def, config: def.defaults, customized: false };
    return {
      def,
      customized: true,
      config: {
        enabled: r.is_enabled === 1,
        title: r.title_template,
        body: r.body_template,
        severity: r.severity as NoticeSeverity,
        sortOrder: r.sort_order,
        windowDays: def.windowApplies ? (r.window_days ?? def.defaults.windowDays) : null,
        // Locked in code too: a stored audience can't widen an owner-only trigger.
        audience: def.ownerOnly ? NoticeAudience.OWNER : (r.audience as NoticeAudience),
      },
    };
  });
}

// Whether this trigger may run for this viewer at all.
function runsFor(t: EffectiveTrigger, viewer: NoticeViewer): boolean {
  if (!t.config.enabled || !t.def.available) return false;
  if (t.def.ownerOnly && !viewer.isPayee) return false; // the hard rule
  return audienceIncludes(t.config.audience, viewer.role);
}

// ---- evaluators -----------------------------------------------------------------

type Ctx = {
  viewer: NoticeViewer;
  on: Map<string, EffectiveTrigger>; // the triggers that run for this viewer
  commission: () => Promise<CommissionData | null>;
};

const cutoffFor = (ctx: Ctx, code: string): Date | null => {
  const days = ctx.on.get(code)?.config.windowDays;
  return days ? new Date(Date.now() - days * DAY_MS) : null;
};

async function mouHits(ctx: Ctx): Promise<Record<string, Hit[]>> {
  if (!ctx.on.has("mou_signed") && !ctx.on.has("mou_pending")) return {};
  const me = await db.user.findUnique({ where: { id: ctx.viewer.userId }, select: { mou_signed_at: true } });
  if (!me) return {};
  return me.mou_signed_at
    ? { mou_signed: [{ key: "mou", values: { date: formatDate(me.mou_signed_at) }, href: "/partner/account?tab=documents" }] }
    : { mou_pending: [{ key: "mou", values: {}, href: "/mou-signing" }] };
}

async function commissionHits(ctx: Ctx): Promise<Record<string, Hit[]>> {
  const codes = ["commission_claimable", "commission_paid", "bank_missing", "bank_rejected", "bank_pending"];
  if (!codes.some((c) => ctx.on.has(c))) return {};
  const data = await ctx.commission();
  if (!data) return {};
  const { claims, bank } = data;
  const out: Record<string, Hit[]> = {};
  const ready = claims.filter((c) => c.status === "claimable");
  if (ready.length > 0) {
    const total = ready.reduce((s, c) => s + c.claimableInr, 0);
    out.commission_claimable = [
      { key: "claimable", values: { count: ready.length, amount: formatInr(total) }, href: "/partner/commission" },
    ];
  }
  const paidCutoff = cutoffFor(ctx, "commission_paid");
  if (paidCutoff) {
    const paid = claims.filter((c) => c.paidAt && c.paidAt >= paidCutoff);
    if (paid.length > 0) {
      out.commission_paid = [{ key: "paid", values: { count: paid.length }, href: "/partner/commission" }];
    }
  }
  const bankHref = "/partner/account?tab=bank";
  if (!bank.hasAccount) out.bank_missing = [{ key: "bank", values: {}, href: bankHref }];
  else if (bank.status === "rejected") {
    out.bank_rejected = [
      { key: "bank", values: { reason: bank.rejectionReason ?? "Please re-enter them with a valid proof." }, href: bankHref },
    ];
  } else if (bank.status === "pending") out.bank_pending = [{ key: "bank", values: {}, href: bankHref }];
  return out;
}

// Finance's payout hold on this payee (finance adjustments), if one is active.
async function payoutHoldHits(ctx: Ctx): Promise<Record<string, Hit[]>> {
  if (!ctx.on.has("payout_hold")) return {};
  const { orgId, userId, isIndependent } = ctx.viewer;
  const h = await activeHold(!isIndependent && orgId != null ? orgPayee(orgId) : independentPayee(userId));
  if (!h) return {};
  return {
    payout_hold: [
      {
        key: "hold",
        values: { reason: h.reason.trim().replace(/[.\s]+$/, ""), date: formatDate(h.placed_at) },
        href: "/partner/commission",
      },
    ],
  };
}

// An upgrade within the window: the effective tier now vs. the one at the
// start of the window (this FY's count up to then, and an override already set
// by then). Only upgrades are announced; a tier only drops when an override
// lapses or a new FY starts, which isn't news to celebrate.
async function tierHits(ctx: Ctx): Promise<Record<string, Hit[]>> {
  const cutoff = cutoffFor(ctx, "tier_change");
  if (!cutoff) return {};
  const ref = await partnerRefForUser(ctx.viewer.userId);
  if (!ref) return {};
  const fy = currentTierFy();
  const now = await partnerTierStatus(ref, { fy });
  if (!now) return {};
  const counts = await fyStudentCounts(
    { orgIds: ref.orgId != null ? [ref.orgId] : [], independentIds: ref.orgId == null ? [ref.userId] : [] },
    fy,
    { upTo: cutoff },
  );
  const before = (ref.orgId != null ? counts.byOrg.get(ref.orgId) : counts.byIndependent.get(ref.userId))?.size ?? 0;
  let prev = stepForCount(now.ladder, before);
  const o = now.override;
  if (o?.active && o.setAt < cutoff) {
    const os = now.ladder.find((s) => s.id === o.tier.id);
    if (os && (!prev || os.rank > prev.rank)) prev = os;
  }
  if (!prev || now.effective.rank <= prev.rank) return {};
  return {
    tier_change: [
      {
        key: `tier-${now.effective.id}`,
        values: { tier: now.effective.name, previous: prev.name },
        href: "/partner/account?tab=loyalty",
      },
    ],
  };
}

// Documents that live under Bank Details, not Documents (the cancelled cheque).
const NON_ACCOUNT_DOC_TYPES = new Set(
  Object.values(PARTNER_DOC_SLOTS)
    .flat()
    .filter((s) => !s.atSignup)
    .map((s) => s.key),
);

async function documentHits(ctx: Ctx): Promise<Record<string, Hit[]>> {
  const { userId, orgId, isIndependent } = ctx.viewer;
  const agencyOrg = !isIndependent ? orgId : null;
  const out: Record<string, Hit[]> = {};
  const href = "/partner/account?tab=documents";
  const tasks: Promise<void>[] = [];
  if (ctx.on.has("documents_rejected")) {
    tasks.push(
      db.document
        .findMany({
          where: {
            is_most_recent: 1,
            status: DocumentStatus.REJECTED,
            student_id: null,
            application_id: null,
            OR: [{ user_id: userId }, ...(agencyOrg != null ? [{ org_id: agencyOrg }] : [])],
          },
          select: { doc_type: true },
        })
        .then((docs) => {
          const names = [...new Set(docs.filter((d) => !NON_ACCOUNT_DOC_TYPES.has(d.doc_type)).map((d) => partnerDocLabel(d.doc_type)))];
          if (names.length > 0) {
            out.documents_rejected = [{ key: "docs", values: { count: names.length, documents: names.join(", ") }, href }];
          }
        }),
    );
  }
  if (ctx.on.has("gst_reverify") && agencyOrg != null) {
    tasks.push(
      (async () => {
        const cert = await db.document.findFirst({
          where: { org_id: agencyOrg, doc_type: "gst", is_most_recent: 1, student_id: null },
          select: { status: true },
        });
        if (cert?.status !== DocumentStatus.PENDING) return;
        // Pending because the GST number changed (not a first upload).
        const change = await db.audit_log.findFirst({
          where: { org_id: agencyOrg, action: "partner.gst_number_changed" },
          orderBy: { id: "desc" },
          select: { created_at: true },
        });
        if (change) out.gst_reverify = [{ key: "gst", values: { date: formatDate(change.created_at) }, href }];
      })(),
    );
  }
  await Promise.all(tasks);
  return out;
}

async function eventHits(ctx: Ctx): Promise<Record<string, Hit[]>> {
  if (!ctx.on.has("event_invite")) return {};
  const today = new Date(`${todayIst()}T00:00:00.000Z`);
  const regs = await db.event_registration.findMany({
    where: {
      user_id: ctx.viewer.userId,
      status: EventRegistrationStatus.INVITED,
      event: { is_active: 1, event_date: { gte: today } },
    },
    orderBy: { event: { event_date: "asc" } },
    take: MAX_PER_TRIGGER,
    select: { event: { select: { id: true, title: true, event_date: true, location: true, is_virtual: true } } },
  });
  if (regs.length === 0) return {};
  return {
    event_invite: regs.map((r) => ({
      key: `event-${r.event.id}`,
      values: {
        event: r.event.title,
        date: formatUtcDate(r.event.event_date),
        location: r.event.is_virtual === 1 ? "Online" : (r.event.location ?? "Venue to be announced"),
      },
      href: "/partner/events",
    })),
  };
}

// Applications this viewer may hear about (see the header).
function applicationScope(v: NoticeViewer): Record<string, unknown> {
  if (v.isIndependent || v.orgId == null) return { org_id: null, student: { created_by_user_id: v.userId } };
  if (v.isPayee) return { org_id: v.orgId };
  return {
    org_id: v.orgId,
    student: { OR: [{ counsellor_id: v.userId }, { counsellor_id: null, created_by_user_id: v.userId }] },
  };
}

const STAGE_TRIGGERS: [code: string, stage: number][] = [
  ["app_conditional_offer", UniApplicationStatus.CONDITIONAL_OFFER],
  ["app_unconditional_offer", UniApplicationStatus.UNCONDITIONAL_OFFER],
  ["app_deposit", UniApplicationStatus.DEPOSIT_PAID],
  ["app_visa_approved", UniApplicationStatus.VISA_SECURED],
];
// Closed outcomes aren't kept in stage history; the application's own row
// says when it last changed.
const OUTCOME_TRIGGERS: [code: string, status: number][] = [
  ["app_rejected", UniApplicationStatus.REJECTED_BY_UNIVERSITY],
  ["app_visa_refused", UniApplicationStatus.VISA_REJECTED],
];

const APP_SELECT = {
  id: true,
  student_id: true,
  student: { select: { first_name: true, last_name: true } },
  course: { select: { name: true, university: { select: { name: true } } } },
} as const;

type AppRow = {
  id: number;
  student_id: number;
  student: { first_name: string; last_name: string };
  course: { name: string; university: { name: string } };
};

function appValues(a: AppRow, at: Date, days: number): Values {
  return {
    student: `${a.student.first_name} ${a.student.last_name}`.trim(),
    university: a.course.university.name,
    course: a.course.name,
    date: formatDate(at),
    days,
  };
}
const appHref = (a: AppRow) => `/partner/students/${a.student_id}?tab=applications&app=${a.id}`;

async function applicationHits(ctx: Ctx): Promise<Record<string, Hit[]>> {
  const scope = applicationScope(ctx.viewer);
  const out: Record<string, Hit[]> = {};
  const stages = STAGE_TRIGGERS.filter(([c]) => ctx.on.has(c));
  const outcomes = OUTCOME_TRIGGERS.filter(([c]) => ctx.on.has(c));
  const minCutoff = (list: [string, number][]) =>
    new Date(Math.min(...list.map(([c]) => cutoffFor(ctx, c)?.getTime() ?? Date.now())));
  const push = (code: string, h: Hit) => {
    const list = (out[code] ??= []);
    if (list.length < MAX_PER_TRIGGER) list.push(h);
  };

  await Promise.all([
    stages.length > 0 &&
      db.application_stage_history
        .findMany({
          where: {
            stage: { in: stages.map(([, s]) => s) },
            occurred_at: { gte: minCutoff(stages) },
            application: scope,
          },
          orderBy: { occurred_at: "desc" },
          take: MAX_PER_TRIGGER * stages.length * 2,
          select: { stage: true, occurred_at: true, application: { select: APP_SELECT } },
        })
        .then((rows) => {
          for (const r of rows) {
            const code = stages.find(([, s]) => s === r.stage)?.[0];
            const t = code ? ctx.on.get(code) : undefined;
            const cutoff = code ? cutoffFor(ctx, code) : null;
            if (!code || !t || !cutoff || r.occurred_at < cutoff) continue;
            push(code, {
              key: `app-${r.application.id}-${r.stage}`,
              values: appValues(r.application, r.occurred_at, t.config.windowDays ?? 0),
              href: appHref(r.application),
              at: r.occurred_at,
            });
          }
        }),
    outcomes.length > 0 &&
      db.application
        .findMany({
          where: {
            ...scope,
            status: { in: outcomes.map(([, s]) => s) },
            updated_at: { gte: minCutoff(outcomes) },
          },
          orderBy: { updated_at: "desc" },
          take: MAX_PER_TRIGGER * outcomes.length * 2,
          select: { ...APP_SELECT, status: true, updated_at: true, rejection_reason: true, rejection_note: true },
        })
        .then((rows) => {
          for (const r of rows) {
            const code = outcomes.find(([, s]) => s === r.status)?.[0];
            const t = code ? ctx.on.get(code) : undefined;
            const cutoff = code ? cutoffFor(ctx, code) : null;
            if (!code || !t || !cutoff || r.updated_at < cutoff) continue;
            push(code, {
              key: `app-${r.id}-${r.status}`,
              values: {
                ...appValues(r, r.updated_at, t.config.windowDays ?? 0),
                reason: rejectionReasonText(r.rejection_reason, r.rejection_note) ?? "Not given",
              },
              href: appHref(r),
              at: r.updated_at,
            });
          }
        }),
  ]);
  return out;
}

// ---- manual notices -------------------------------------------------------------

export function istToday(): Date {
  return new Date(`${todayIst()}T00:00:00.000Z`);
}

async function manualNotices(viewer: NoticeViewer) {
  const today = istToday();
  const audiences = [NoticeAudience.BOTH, viewer.role === "owner" ? NoticeAudience.OWNER : NoticeAudience.COUNSELLOR];
  const mine = [
    ...(!viewer.isIndependent && viewer.orgId != null ? [{ org_id: viewer.orgId }] : []),
    ...(viewer.isIndependent ? [{ user_id: viewer.userId }] : []),
  ];
  return db.partner_manual_notice.findMany({
    where: {
      is_active: 1,
      audience: { in: audiences },
      starts_on: { lte: today },
      OR: [{ ends_on: null }, { ends_on: { gte: today } }],
      AND: [{ OR: [{ target: { none: {} } }, ...(mine.length ? [{ target: { some: { OR: mine } } }] : [])] }],
    },
    orderBy: [{ sort_order: "asc" }, { starts_on: "desc" }, { id: "desc" }],
    take: 20,
    select: { id: true, title: true, body: true, link_url: true, severity: true, sort_order: true },
  });
}

// ---- entry point ----------------------------------------------------------------

export async function partnerNoticesFor(
  viewer: NoticeViewer,
  commission: () => Promise<CommissionData | null>,
): Promise<NoticeView[]> {
  const [triggers, manual] = await Promise.all([effectiveTriggers(), manualNotices(viewer)]);
  const on = new Map(triggers.filter((t) => runsFor(t, viewer)).map((t) => [t.def.code, t]));
  const ctx: Ctx = { viewer, on, commission };

  const groups = await Promise.all([
    mouHits(ctx),
    commissionHits(ctx),
    payoutHoldHits(ctx),
    tierHits(ctx),
    documentHits(ctx),
    eventHits(ctx),
    applicationHits(ctx),
  ]);

  type Ranked = NoticeView & { order: number; at: number };
  const ranked: Ranked[] = [];
  for (const group of groups) {
    for (const [code, hits] of Object.entries(group)) {
      const t = on.get(code);
      if (!t) continue; // defensive: the evaluator found something for a trigger that's off
      for (const h of hits) {
        const body = t.config.body ? renderTemplate(t.config.body, h.values).trim() : "";
        ranked.push({
          id: `${code}:${h.key}`,
          tone: severityTone(t.config.severity),
          title: renderTemplate(t.config.title, h.values),
          ...(body ? { body } : {}),
          href: h.href,
          order: t.config.sortOrder,
          at: h.at?.getTime() ?? 0,
        });
      }
    }
  }
  for (const m of manual) {
    const external = !!m.link_url && /^https:/i.test(m.link_url);
    ranked.push({
      id: `manual:${m.id}`,
      tone: severityTone(m.severity),
      title: m.title,
      ...(m.body ? { body: m.body } : {}),
      ...(m.link_url ? { href: m.link_url, external } : {}),
      order: m.sort_order,
      at: 0,
    });
  }
  // Display order, then newest first within a trigger.
  ranked.sort((a, b) => a.order - b.order || b.at - a.at);
  return ranked.map((n): NoticeView => ({
    id: n.id,
    tone: n.tone,
    title: n.title,
    ...(n.body ? { body: n.body } : {}),
    ...(n.href ? { href: n.href } : {}),
    ...(n.external ? { external: true } : {}),
  }));
}
