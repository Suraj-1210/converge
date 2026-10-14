import "server-only";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { UserType } from "~/server/db/enums";
import { fmtTierDate as fmtDay, type TierStatusView } from "~/lib/partner-tiers";

// Partner Tiers (loyalty programme): the one place a partner's tier is worked
// out. Every screen (partner dashboard, Commission/Account pages, admin
// Partners, BDM Performance, admin dashboard) and billing confirmation read it
// from here, and the master lives in Settings -> Partner Tiers.
//
// The rule (Suraj, 14 Oct 2026):
// - A partner is an agency (its owner holds the override) or an independent
//   counsellor.
// - Their count is the DISTINCT students Finance confirmed for billing (a
//   commission row exists) in the current financial year, 1 April - 31 March
//   IST, by confirmation date. Deleted commissions stop counting.
// - The computed tier is the step of that FY's ladder whose range holds the
//   count (0 students = the bottom tier).
// - A Super Admin override is a FLOOR: the partner gets the higher of the
//   override and the computed tier. It can carry an end date (inclusive).
// - Display data (name, colour, icon, benefits) applies immediately. The
//   ranges and commission share for FY X are the partner_tier_rule rows of the
//   latest fy <= X, so a Super Admin's range/share edits (written for the next
//   FY) never change the current year.

export interface TierInfo {
  id: number;
  name: string;
  displayOrder: number;
  badgeColor: string;
  icon: string | null;
  benefits: string[];
  active: boolean;
}

export interface LadderStep extends TierInfo {
  rank: number; // 0 = bottom of this FY's ladder
  minStudents: number;
  maxStudents: number | null; // null = no upper limit
  sharePct: number;
}

export interface Ladder {
  fy: number; // the FY the ladder is for
  ruleFy: number | null; // the FY whose rule rows it uses (null = no rules at all)
  steps: LadderStep[];
}

export interface TierOverride {
  tier: TierInfo;
  endsOn: string | null; // YYYY-MM-DD, inclusive
  reason: string | null;
  isMigrated: boolean;
  setAt: Date;
  setBy: { id: number; name: string } | null;
  active: boolean; // false once ends_on has passed
}

export interface PartnerTierStatus {
  fy: number;
  students: number;
  computed: LadderStep;
  effective: LadderStep;
  source: "computed" | "override";
  override: TierOverride | null;
  // Next step above the effective tier, and how many more students reach it.
  next: { step: LadderStep; needed: number } | null;
  ladder: LadderStep[];
}

export interface PartnerRef {
  userId: number; // agency owner or independent counsellor
  orgId: number | null; // null for an independent
}

// ---- financial year (IST) -----------------------------------------------------

const IST_OFFSET_MS = 330 * 60 * 1000;

// FY start year for a moment, in IST: 2026 = 1 Apr 2026 - 31 Mar 2027.
export function tierFyOf(date: Date): number {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
}

export function currentTierFy(now = new Date()): number {
  return tierFyOf(now);
}

// [start, end) of a financial year as instants.
export function fyWindow(fy: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(fy, 3, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(fy + 1, 3, 1) - IST_OFFSET_MS),
  };
}

export function fyLabel(fy: number): string {
  return `FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
}

// Today in IST as YYYY-MM-DD (override end dates are IST calendar days).
export function todayIst(now = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// 31 March that ends the given FY.
export function fyEndDate(fy: number): string {
  return `${fy + 1}-03-31`;
}

const dateOnly = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

// ---- master -------------------------------------------------------------------

type TierRow = {
  id: number;
  name: string;
  display_order: number;
  badge_color: string;
  icon: string | null;
  benefits: Prisma.JsonValue;
  is_active: number;
};

export function benefitsOf(v: Prisma.JsonValue): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function toTierInfo(t: TierRow): TierInfo {
  return {
    id: t.id,
    name: t.name,
    displayOrder: t.display_order,
    badgeColor: t.badge_color,
    icon: t.icon,
    benefits: benefitsOf(t.benefits),
    active: t.is_active === 1,
  };
}

const TIER_SELECT = {
  id: true,
  name: true,
  display_order: true,
  badge_color: true,
  icon: true,
  benefits: true,
  is_active: true,
} as const;

// The FY whose rows make up the ladder for `fy`: the latest rule fy <= fy, or
// the earliest one when fy predates every rule (so older years still resolve).
async function ruleFyFor(fy: number): Promise<number | null> {
  const atOrBefore = await db.partner_tier_rule.aggregate({
    where: { fy: { lte: fy } },
    _max: { fy: true },
  });
  if (atOrBefore._max.fy != null) return atOrBefore._max.fy;
  const earliest = await db.partner_tier_rule.aggregate({ _min: { fy: true } });
  return earliest._min.fy ?? null;
}

// The ladder for a FY, bottom tier first. Rule rows only, so a tier is on it
// exactly when that FY's schedule includes it.
export async function ladderFor(fy: number): Promise<Ladder> {
  const ruleFy = await ruleFyFor(fy);
  if (ruleFy == null) return { fy, ruleFy, steps: [] };
  const rows = await db.partner_tier_rule.findMany({
    where: { fy: ruleFy },
    orderBy: { min_students: "asc" },
    select: {
      min_students: true,
      max_students: true,
      share_pct: true,
      tier: { select: TIER_SELECT },
    },
  });
  return {
    fy,
    ruleFy,
    steps: rows.map((r, rank) => ({
      ...toTierInfo(r.tier),
      rank,
      minStudents: r.min_students,
      maxStudents: r.max_students,
      sharePct: Number(r.share_pct),
    })),
  };
}

// The step whose range holds `students`. Below the bottom (shouldn't happen —
// the bottom starts at 0) is the bottom; above every bounded range is the top.
export function stepForCount(steps: LadderStep[], students: number): LadderStep | null {
  if (steps.length === 0) return null;
  for (const s of steps) {
    if (students >= s.minStudents && (s.maxStudents == null || students <= s.maxStudents)) return s;
  }
  return students < steps[0]!.minStudents ? steps[0]! : steps[steps.length - 1]!;
}

// Checks a FY schedule before it's saved: starts at 0, contiguous, no
// overlaps, open-ended top, shares within 0-100. Returns an error message or null.
export function validateSchedule(
  steps: { name: string; minStudents: number; maxStudents: number | null; sharePct: number }[],
): string | null {
  if (steps.length === 0) return "The ladder needs at least one tier.";
  const sorted = [...steps].sort((a, b) => a.minStudents - b.minStudents);
  if (sorted[0]!.minStudents !== 0) {
    return `The lowest tier (${sorted[0]!.name}) must start at 0 students, so every partner has a tier.`;
  }
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    const isTop = i === sorted.length - 1;
    if (!Number.isFinite(s.sharePct) || s.sharePct < 0 || s.sharePct > 100) {
      return `${s.name}: the commission share must be between 0 and 100%.`;
    }
    if (isTop) {
      if (s.maxStudents != null) return `${s.name} is the top tier, so it can't have a maximum.`;
    } else {
      if (s.maxStudents == null) return `${s.name}: only the top tier can be open-ended.`;
      if (s.maxStudents < s.minStudents) return `${s.name}: the maximum is below the minimum.`;
      const next = sorted[i + 1]!;
      if (next.minStudents !== s.maxStudents + 1) {
        return `${next.name} must start at ${s.maxStudents + 1} (right after ${s.name} ends at ${s.maxStudents}) — ranges can't overlap or leave gaps.`;
      }
    }
  }
  return null;
}

// ---- counting -----------------------------------------------------------------

// Distinct students Finance confirmed for billing in `fy`, per agency.
// `upTo` limits it to confirmations at or before that moment.
export async function fyStudentCounts(
  orgIds: number[],
  fy: number,
  opts: { upTo?: Date } = {},
): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  if (orgIds.length === 0) return out;
  const { start, end } = fyWindow(fy);
  const rows = await db.commission.findMany({
    where: {
      org_id: { in: orgIds },
      created_at: { gte: start, lt: end, ...(opts.upTo ? { lte: opts.upTo } : {}) },
    },
    select: { org_id: true, application: { select: { student_id: true } } },
  });
  for (const r of rows) {
    const set = out.get(r.org_id) ?? new Set<number>();
    set.add(r.application.student_id);
    out.set(r.org_id, set);
  }
  return out;
}

// ---- status -------------------------------------------------------------------

type OverrideRow = {
  user_id: number;
  ends_on: Date | null;
  reason: string | null;
  is_migrated: number;
  set_at: Date;
  tier: TierRow;
  set_by: { id: number; first_name: string; last_name: string } | null;
};

const OVERRIDE_SELECT = {
  user_id: true,
  ends_on: true,
  reason: true,
  is_migrated: true,
  set_at: true,
  tier: { select: TIER_SELECT },
  set_by: { select: { id: true, first_name: true, last_name: true } },
} as const;

function toOverride(o: OverrideRow, today: string): TierOverride {
  const endsOn = dateOnly(o.ends_on);
  return {
    tier: toTierInfo(o.tier),
    endsOn,
    reason: o.reason,
    isMigrated: o.is_migrated === 1,
    setAt: o.set_at,
    setBy: o.set_by ? { id: o.set_by.id, name: `${o.set_by.first_name} ${o.set_by.last_name}`.trim() } : null,
    active: endsOn == null || endsOn >= today,
  };
}

function statusFrom(
  ladder: Ladder,
  students: number,
  override: TierOverride | null,
): PartnerTierStatus | null {
  const computed = stepForCount(ladder.steps, students);
  if (!computed) return null;
  // The override counts only while active and while its tier is on this FY's
  // ladder (a tier dropped from the ladder can't be ranked against the rest).
  const overrideStep =
    override?.active ? (ladder.steps.find((s) => s.id === override.tier.id) ?? null) : null;
  const useOverride = overrideStep != null && overrideStep.rank > computed.rank;
  const effective = useOverride ? overrideStep : computed;
  const nextStep = ladder.steps.find((s) => s.rank > effective.rank && s.minStudents > students) ?? null;
  return {
    fy: ladder.fy,
    students,
    computed,
    effective,
    source: useOverride ? "override" : "computed",
    override,
    next: nextStep ? { step: nextStep, needed: nextStep.minStudents - students } : null,
    ladder: ladder.steps,
  };
}

// Tier status for many partners at once (admin lists). Keyed by userId.
export async function partnerTierStatuses(
  refs: PartnerRef[],
  opts: { fy?: number } = {},
): Promise<Map<number, PartnerTierStatus>> {
  const fy = opts.fy ?? currentTierFy();
  const out = new Map<number, PartnerTierStatus>();
  if (refs.length === 0) return out;
  const ladder = await ladderFor(fy);
  const orgIds = [...new Set(refs.map((r) => r.orgId).filter((x): x is number => x != null))];
  const [counts, overrides] = await Promise.all([
    fyStudentCounts(orgIds, fy),
    db.partner_tier_override.findMany({
      where: { user_id: { in: refs.map((r) => r.userId) } },
      select: OVERRIDE_SELECT,
    }),
  ]);
  const today = todayIst();
  const overrideByUser = new Map(overrides.map((o) => [o.user_id, toOverride(o, today)]));
  for (const r of refs) {
    const students = r.orgId != null ? (counts.get(r.orgId)?.size ?? 0) : 0;
    const status = statusFrom(ladder, students, overrideByUser.get(r.userId) ?? null);
    if (status) out.set(r.userId, status);
  }
  return out;
}

export async function partnerTierStatus(
  ref: PartnerRef,
  opts: { fy?: number } = {},
): Promise<PartnerTierStatus | null> {
  return (await partnerTierStatuses([ref], opts)).get(ref.userId) ?? null;
}

// The partner who holds an agency's tier: its (live) owner.
export async function partnerRefForOrg(orgId: number): Promise<PartnerRef | null> {
  const owner = await db.user.findFirst({
    where: { org_id: orgId, is_owner: 1, type: UserType.AGENCY_OWNER, deleted_at: null },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return owner ? { userId: owner.id, orgId } : null;
}

// For any partner user (owner, counsellor, independent): whose tier applies.
export async function partnerRefForUser(userId: number): Promise<PartnerRef | null> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, type: true, org_id: true },
  });
  if (!u) return null;
  if (u.type === UserType.INDEPENDENT_COUNSELLOR) return { userId: u.id, orgId: null };
  if (u.org_id == null) return null;
  return (await partnerRefForOrg(u.org_id)) ?? { userId: u.id, orgId: u.org_id };
}

// The share to stamp on a commission Finance is confirming for `orgId` now.
// The student being confirmed counts toward the tier (the 11th student is the
// first at Gold). Returns null when no ladder is configured.
export async function shareForConfirmation(
  orgId: number,
  studentId: number,
  opts: { at?: Date } = {},
): Promise<{ tier: LadderStep; sharePct: number; students: number; source: "computed" | "override" } | null> {
  const at = opts.at ?? new Date();
  const fy = tierFyOf(at);
  const ladder = await ladderFor(fy);
  if (ladder.steps.length === 0) return null;
  const ref = await partnerRefForOrg(orgId);
  const counts = await fyStudentCounts([orgId], fy, { upTo: at });
  const set = counts.get(orgId) ?? new Set<number>();
  set.add(studentId);
  const ov = ref
    ? await db.partner_tier_override.findUnique({ where: { user_id: ref.userId }, select: OVERRIDE_SELECT })
    : null;
  const status = statusFrom(ladder, set.size, ov ? toOverride(ov, todayIst(at)) : null);
  if (!status) return null;
  return {
    tier: status.effective,
    sharePct: status.effective.sharePct,
    students: set.size,
    source: status.source,
  };
}

// Plain-language label for admin screens, e.g.
// "Gold (set by Super Admin until 31 Mar 2027) · automatic: Silver".
export function describeTier(s: PartnerTierStatus): string {
  if (!s.override) return s.effective.name;
  const o = s.override;
  const until = o.endsOn ? ` until ${fmtDay(o.endsOn)}` : "";
  const by = o.isMigrated ? "carried over from the manual tier" : "set by Super Admin";
  if (!o.active) return `${s.computed.name} · override ${o.tier.name} ended ${o.endsOn ? fmtDay(o.endsOn) : ""}`.trim();
  if (s.source === "override") return `${s.effective.name} (${by}${until}) · automatic: ${s.computed.name}`;
  return `${s.effective.name} · override ${o.tier.name} (${by}${until}) is below the automatic tier`;
}

// Wire shape for the client (dates as strings).
export function serializeStatus(s: PartnerTierStatus): TierStatusView {
  return {
    fy: s.fy,
    fyLabel: fyLabel(s.fy),
    students: s.students,
    computed: s.computed,
    effective: s.effective,
    source: s.source,
    override: s.override
      ? { ...s.override, setAt: s.override.setAt.toISOString() }
      : null,
    next: s.next,
    ladder: s.ladder,
    label: describeTier(s),
  };
}
