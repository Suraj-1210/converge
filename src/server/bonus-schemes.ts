import "server-only";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import {
  BonusKind,
  INDICATIVE_FX_RATES,
  TrancheKind,
  TrancheStatus,
  UniApplicationStatus,
  UniApplicationStatusLabel,
  financialYearOf,
} from "~/server/db/enums";
import { payeeWhere, type Payee } from "~/server/payee";

// Bonus schemes (16 Nov 2026, Suraj item 7). Two kinds, kept apart:
//
// UNIVERSITY VOLUME BONUS (kind 1, income). Per university contract (direct or
// third-party vendor), counted per intake: the count restarts for each intake.
// A student counts once their commission is approved inside the scheme's
// window. Retroactive is a per-scheme setting: on, every student counted in
// that intake earns the slab once it's reached (5th student → 5 × €500 due);
// off, only students from the threshold on. Collegepond income: no partner
// share, the full amount is billed (no CP share %), on its own vendor invoice
// (Vendor Billing › Volume bonus due), then Record Payment → Collections.
//
// PARTNER INCENTIVE (kind 2, CP-funded). Counted per payee (agency or
// independent): students whose application was SUBMITTED inside the scheme's
// window and match its scope, approved so far, plus this one. No retroactive
// uplift. When several schemes match, the highest pays (Finance can pick
// another or edit the amount, with a reason). 100% to the partner, claimable
// once the student's first base instalment is collected and approved.
//
// Both are flat amounts per student from volume slabs, in the scheme's
// currency. What's applied is stamped on the commission (commission_bonus)
// and its money moves through its own commission_tranche (TrancheKind).

// db or an interactive transaction's client (db is assignable to it).
type Client = Parameters<Parameters<typeof db.$transaction>[0]>[0];
type Decimalish = { toNumber: () => number } | null;
const num = (d: Decimalish): number => (d == null ? 0 : d.toNumber());
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- Intake ------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const INTAKE_SOURCE_SELECT = {
  deferred_intake_month: true,
  deferred_intake_year: true,
  program_start_date: true,
  course: { select: { intake_month: true, intake_year: true } },
} as const;
type IntakeSource = {
  deferred_intake_month: number | null;
  deferred_intake_year: number | null;
  program_start_date: Date | null;
  course: { intake_month: string | null; intake_year: number | null };
};

const pad2 = (n: number) => String(n).padStart(2, "0");
export const intakeKeyFrom = (month: number, year: number) => `${year}-${pad2(month)}`;

/**
 * The intake a student starts in, as "YYYY-MM": a deferral's new intake, else
 * the programme start date, else the course's (first) intake month and year.
 * Null when none is known.
 */
export function intakeKey(app: IntakeSource): string | null {
  if (app.deferred_intake_month && app.deferred_intake_year) {
    return intakeKeyFrom(app.deferred_intake_month, app.deferred_intake_year);
  }
  if (app.program_start_date) {
    const d = app.program_start_date;
    return intakeKeyFrom(d.getUTCMonth() + 1, d.getUTCFullYear());
  }
  const first = app.course.intake_month?.split(/[,/;&]| and /i)[0]?.trim().slice(0, 3).toLowerCase();
  const m = first ? MONTHS.findIndex((x) => x.toLowerCase() === first) + 1 : 0;
  if (m > 0 && app.course.intake_year) return intakeKeyFrom(m, app.course.intake_year);
  return null;
}

/** "2026-09" → "Sep 2026". */
export function intakeLabel(key: string | null | undefined): string {
  if (!key) return "No intake";
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? "?"} ${y}`;
}

// ---- Windows and slabs -------------------------------------------------------

// Scheme dates are calendar days in India; timestamps compare by IST day.
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

type Windowed = { active_from: Date | null; active_to: Date | null };
export function inWindow(s: Windowed, at: Date): boolean {
  const day = istDay(at);
  const from = dateOnly(s.active_from);
  const to = dateOnly(s.active_to);
  return (from == null || day >= from) && (to == null || day <= to);
}

type Slab = { id: number; min_students: number; max_students: number | null; amount_per_student: Decimalish };
export function slabFor<S extends Slab>(slabs: S[], count: number): S | null {
  return (
    slabs
      .filter((s) => count >= s.min_students && (s.max_students == null || count <= s.max_students))
      .sort((a, b) => num(b.amount_per_student) - num(a.amount_per_student))[0] ?? null
  );
}

/** "5–10" / "11+" */
export const slabLabel = (min: number | null, max: number | null) =>
  min == null ? "—" : max == null ? `${min}+` : `${min}–${max}`;

type Scoped = {
  country: string | null;
  university_id: number | null;
  intake_month: number | null;
  intake_year: number | null;
};
function scopeMatches(s: Scoped, c: { country: string | null; universityId: number; intake: string | null }) {
  if (s.country && s.country !== c.country) return false;
  if (s.university_id != null && s.university_id !== c.universityId) return false;
  if (s.intake_month != null || s.intake_year != null) {
    if (!c.intake) return false;
    const [y, m] = c.intake.split("-").map(Number);
    if (s.intake_month != null && s.intake_month !== m) return false;
    if (s.intake_year != null && s.intake_year !== y) return false;
  }
  return true;
}

// ---- FX ----------------------------------------------------------------------

/**
 * INR per 1 unit, for fixing a non-INR incentive's INR when it becomes
 * claimable: the Settings FX rate (manual override, else mid less margin),
 * else the indicative rate.
 */
export async function inrRate(currency: string, client: Client = db): Promise<number> {
  if (currency === "INR") return 1;
  const r = await client.fx_rate.findUnique({ where: { currency } });
  if (r) {
    if (r.manual_rate != null) return num(r.manual_rate);
    return Math.round(num(r.mid_rate) * (1 - num(r.margin_pct) / 100) * 100) / 100;
  }
  return INDICATIVE_FX_RATES[currency] ?? 1;
}
const indicativeInr = (amount: number, currency: string) =>
  amount * (INDICATIVE_FX_RATES[currency] ?? 1);

// ---- Calculation ------------------------------------------------------------

type SchemeRow = Prisma.bonus_schemeGetPayload<{ include: { bonus_scheme_slab: true } }>;

export type BonusPick = {
  schemeId: number;
  schemeName: string;
  currency: string;
  retroactive: boolean;
  slabMin: number;
  slabMax: number | null;
  count: number;
  perStudent: number;
};

// A commission already approved, with what decides whether it counts.
const COUNTED_SELECT = {
  id: true,
  vendor_id: true,
  bonus_intake: true,
  approved_at: true,
  created_at: true,
  application: {
    select: {
      submitted_at: true,
      created_at: true,
      student: { select: { first_name: true, last_name: true } },
      deferred_intake_month: true,
      deferred_intake_year: true,
      program_start_date: true,
      course: {
        select: {
          university_id: true,
          intake_month: true,
          intake_year: true,
          university: { select: { country: true } },
        },
      },
    },
  },
} as const;
type Counted = Prisma.commissionGetPayload<{ select: typeof COUNTED_SELECT }>;
const countedIntake = (c: Counted) => c.bonus_intake ?? intakeKey(c.application);
const approvedAt = (c: Counted) => c.approved_at ?? c.created_at;

export type VolumeContext = {
  contractId: number;
  vendorId: number | null;
  universityId: number;
  intake: string | null;
  at: Date;
};

/**
 * The volume bonus this student earns under its contract (the highest of the
 * contract's active schemes that match), and the earlier students in the same
 * intake it reaches back to on a retroactive scheme. Null when no scheme
 * matches or no slab is reached.
 */
export async function volumeBonusFor(ctx: VolumeContext, client: Client = db) {
  if (!ctx.intake) return null;
  const schemes: SchemeRow[] = (
    await client.bonus_scheme.findMany({
      where: { kind: BonusKind.VOLUME, is_active: 1, contract_id: ctx.contractId },
      include: { bonus_scheme_slab: true },
    })
  ).filter((s) => inWindow(s, ctx.at) && scopeMatches(s, { country: null, universityId: ctx.universityId, intake: ctx.intake }));
  if (schemes.length === 0) return null;
  // Students already approved under this contract (same vendor, same
  // university) in this intake.
  const prior = (
    await client.commission.findMany({
      where: {
        vendor_id: ctx.vendorId,
        application: { course: { university_id: ctx.universityId } },
      },
      select: COUNTED_SELECT,
      orderBy: [{ approved_at: "asc" }, { id: "asc" }],
    })
  ).filter((c) => countedIntake(c) === ctx.intake);

  let best: (BonusPick & { counted: Counted[] }) | null = null;
  for (const s of schemes) {
    const counted = prior.filter((c) => inWindow(s, approvedAt(c)));
    const count = counted.length + 1;
    const slab = slabFor(s.bonus_scheme_slab, count);
    if (!slab || num(slab.amount_per_student) <= 0) continue;
    const pick = {
      schemeId: s.id,
      schemeName: s.name,
      currency: s.currency,
      retroactive: s.retroactive === 1,
      slabMin: slab.min_students,
      slabMax: slab.max_students,
      count,
      perStudent: num(slab.amount_per_student),
      counted,
    };
    if (!best || indicativeInr(pick.perStudent, pick.currency) > indicativeInr(best.perStudent, best.currency)) {
      best = pick;
    }
  }
  if (!best) return null;

  // Retroactive: every earlier student in the intake gets the slab too —
  // added where they have none, raised where theirs is lower and not yet
  // invoiced. One already invoiced at a lower rate is left for Finance (shown
  // as a top-up on the Volume bonus due board), never silently re-billed.
  const backfill: {
    commissionId: number;
    studentName: string;
    current: number | null;
    action: "add" | "raise" | "invoiced";
  }[] = [];
  if (best.retroactive && best.counted.length > 0) {
    const existing = await client.commission_bonus.findMany({
      where: { kind: BonusKind.VOLUME, commission_id: { in: best.counted.map((c) => c.id) } },
      select: {
        commission_id: true,
        amount: true,
        currency: true,
        commission_tranche: { select: { vendor_invoice_item_tranche: { select: { id: true } } } },
      },
    });
    for (const c of best.counted) {
      const e = existing.find((x) => x.commission_id === c.id);
      const name = `${c.application.student.first_name} ${c.application.student.last_name}`.trim();
      if (!e) backfill.push({ commissionId: c.id, studentName: name, current: null, action: "add" });
      else if (e.currency === best.currency && num(e.amount) < best.perStudent) {
        backfill.push({
          commissionId: c.id,
          studentName: name,
          current: num(e.amount),
          action: e.commission_tranche?.vendor_invoice_item_tranche ? "invoiced" : "raise",
        });
      }
    }
  }
  return {
    schemeId: best.schemeId,
    schemeName: best.schemeName,
    currency: best.currency,
    retroactive: best.retroactive,
    slabMin: best.slabMin,
    slabMax: best.slabMax,
    count: best.count,
    perStudent: best.perStudent,
    intake: ctx.intake,
    backfill,
  };
}

export type IncentiveContext = {
  payee: Payee;
  country: string | null;
  universityId: number;
  intake: string | null;
  // When the student's application was submitted (else created).
  submittedAt: Date;
};

/**
 * Every partner-incentive scheme this student qualifies for, highest first
 * (the first is what's applied unless Finance picks another). The count is the
 * payee's students approved so far who also qualify for that scheme, plus
 * this one.
 */
export async function incentiveCandidates(ctx: IncentiveContext, client: Client = db): Promise<BonusPick[]> {
  const scope = { country: ctx.country, universityId: ctx.universityId, intake: ctx.intake };
  const schemes = (
    await client.bonus_scheme.findMany({
      where: { kind: BonusKind.INCENTIVE, is_active: 1 },
      include: { bonus_scheme_slab: true },
    })
  ).filter((s) => inWindow(s, ctx.submittedAt) && scopeMatches(s, scope));
  if (schemes.length === 0) return [];
  const prior = await client.commission.findMany({ where: payeeWhere(ctx.payee), select: COUNTED_SELECT });
  const out: BonusPick[] = [];
  for (const s of schemes) {
    const count =
      prior.filter(
        (c) =>
          inWindow(s, c.application.submitted_at ?? c.application.created_at) &&
          scopeMatches(s, {
            country: c.application.course.university.country,
            universityId: c.application.course.university_id,
            intake: countedIntake(c),
          }),
      ).length + 1;
    const slab = slabFor(s.bonus_scheme_slab, count);
    if (!slab || num(slab.amount_per_student) <= 0) continue;
    out.push({
      schemeId: s.id,
      schemeName: s.name,
      currency: s.currency,
      retroactive: false,
      slabMin: slab.min_students,
      slabMax: slab.max_students,
      count,
      perStudent: num(slab.amount_per_student),
    });
  }
  return out.sort((a, b) => indicativeInr(b.perStudent, b.currency) - indicativeInr(a.perStudent, a.currency));
}

// ---- Stamping (Approve commission) -------------------------------------------

/** Tranche name for a bonus, as Finance and the partner see it. */
export const bonusTrancheName = (kind: number, schemeName: string | null) =>
  `${kind === BonusKind.VOLUME ? "Volume bonus" : "Bonus"}: ${schemeName ?? "manual"}`.slice(0, 100);

async function nextSeq(client: Client, commissionId: number) {
  const last = await client.commission_tranche.findFirst({
    where: { commission_id: commissionId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return (last?.seq ?? 0) + 1;
}

export type StampBonus = {
  kind: BonusKind;
  pick: BonusPick | null;
  amount: number;
  currency: string;
  // Calculated amount (null when no scheme gave one).
  calculated: number | null;
  reason: string | null;
  intake: string | null;
  via?: "approval" | "retroactive";
};

/** Stamp one bonus on a commission: its tranche + the commission_bonus row. */
export async function stampBonus(client: Client, commissionId: number, b: StampBonus, cpUserId: number) {
  const tranche = await client.commission_tranche.create({
    data: {
      commission_id: commissionId,
      seq: await nextSeq(client, commissionId),
      kind: b.kind === BonusKind.VOLUME ? TrancheKind.VOLUME_BONUS : TrancheKind.PARTNER_INCENTIVE,
      name: bonusTrancheName(b.kind, b.pick?.schemeName ?? null),
      amount: b.amount,
      status: TrancheStatus.UPCOMING,
    },
  });
  const row = await client.commission_bonus.create({
    data: {
      commission_id: commissionId,
      kind: b.kind,
      scheme_id: b.pick?.schemeId ?? null,
      scheme_name: b.pick?.schemeName ?? null,
      slab_min: b.pick?.slabMin ?? null,
      slab_max: b.pick?.slabMax ?? null,
      student_count: b.pick?.count ?? null,
      intake: b.intake,
      calculated_amount: b.calculated,
      amount: b.amount,
      currency: b.currency,
      commission_tranche_id: tranche.id,
      is_manual: b.reason ? 1 : 0,
      edit_reason: b.reason,
      via: b.via ?? "approval",
      created_by_cp_user_id: cpUserId,
    },
  });
  await client.audit_log.create({
    data: {
      action: b.kind === BonusKind.VOLUME ? "commission.volume_bonus_stamped" : "commission.partner_incentive_stamped",
      entity_type: "commission",
      entity_id: commissionId,
      metadata: {
        byCpUserId: cpUserId,
        commissionBonusId: row.id,
        trancheId: tranche.id,
        schemeId: b.pick?.schemeId ?? null,
        scheme: b.pick?.schemeName ?? null,
        slab: b.pick ? slabLabel(b.pick.slabMin, b.pick.slabMax) : null,
        count: b.pick?.count ?? null,
        intake: b.intake,
        calculated: b.calculated,
        amount: b.amount,
        currency: b.currency,
        reason: b.reason,
        via: b.via ?? "approval",
      },
    },
  });
  return row;
}

/**
 * Retroactive volume bonus: give the earlier students in the intake the slab
 * just reached (add where missing, raise where lower and not yet invoiced).
 * Re-reads inside the caller's transaction, so it acts on current rows.
 */
export async function applyVolumeBackfill(
  client: Client,
  pick: BonusPick & { intake: string; backfill: { commissionId: number; action: "add" | "raise" | "invoiced" }[] },
  triggeredByCommissionId: number,
  cpUserId: number,
) {
  let added = 0;
  let raised = 0;
  for (const b of pick.backfill) {
    if (b.action === "add") {
      const has = await client.commission_bonus.findUnique({
        where: { commission_id_kind: { commission_id: b.commissionId, kind: BonusKind.VOLUME } },
        select: { id: true },
      });
      if (has) continue;
      await stampBonus(
        client,
        b.commissionId,
        {
          kind: BonusKind.VOLUME,
          pick,
          amount: pick.perStudent,
          currency: pick.currency,
          calculated: pick.perStudent,
          reason: null,
          intake: pick.intake,
          via: "retroactive",
        },
        cpUserId,
      );
      added++;
    } else if (b.action === "raise") {
      const e = await client.commission_bonus.findUnique({
        where: { commission_id_kind: { commission_id: b.commissionId, kind: BonusKind.VOLUME } },
        select: {
          id: true,
          amount: true,
          commission_tranche_id: true,
          commission_tranche: { select: { vendor_invoice_item_tranche: { select: { id: true } } } },
        },
      });
      if (!e || e.commission_tranche?.vendor_invoice_item_tranche || num(e.amount) >= pick.perStudent) continue;
      await client.commission_bonus.update({
        where: { id: e.id },
        data: {
          amount: pick.perStudent,
          calculated_amount: pick.perStudent,
          scheme_id: pick.schemeId,
          scheme_name: pick.schemeName,
          slab_min: pick.slabMin,
          slab_max: pick.slabMax,
          student_count: pick.count,
        },
      });
      if (e.commission_tranche_id) {
        await client.commission_tranche.update({
          where: { id: e.commission_tranche_id },
          data: { amount: pick.perStudent, name: bonusTrancheName(BonusKind.VOLUME, pick.schemeName) },
        });
      }
      await client.audit_log.create({
        data: {
          action: "commission.volume_bonus_raised",
          entity_type: "commission",
          entity_id: b.commissionId,
          metadata: {
            byCpUserId: cpUserId,
            commissionBonusId: e.id,
            from: num(e.amount),
            to: pick.perStudent,
            schemeId: pick.schemeId,
            triggeredByCommissionId,
          },
        },
      });
      raised++;
    }
  }
  return { added, raised };
}

// ---- Release (partner incentive becomes claimable) ----------------------------

/**
 * A partner incentive becomes claimable (RECEIVED) once a base instalment of
 * its commission has been collected and approved. Its INR is fixed now: the
 * amount itself when INR, else at the Settings FX rate. Returns what was
 * released, for the partner notification.
 */
export async function releasePartnerIncentives(client: Client, commissionIds: number[], now: Date) {
  if (commissionIds.length === 0) return [];
  const pending = await client.commission_tranche.findMany({
    where: {
      commission_id: { in: commissionIds },
      kind: TrancheKind.PARTNER_INCENTIVE,
      status: TrancheStatus.UPCOMING,
      commission: {
        commission_tranche: {
          some: { kind: TrancheKind.BASE, status: { in: [TrancheStatus.RECEIVED, TrancheStatus.PAID] } },
        },
      },
    },
    select: { id: true, commission_id: true, name: true, amount: true, commission_bonus: { select: { currency: true } } },
  });
  const out: { commissionId: number; trancheId: number; name: string | null; amountInr: number }[] = [];
  for (const t of pending) {
    const currency = t.commission_bonus?.currency ?? "INR";
    const amountInr = round2(num(t.amount) * (await inrRate(currency, client)));
    const res = await client.commission_tranche.updateMany({
      where: { id: t.id, status: TrancheStatus.UPCOMING },
      data: { status: TrancheStatus.RECEIVED, received_at: now, amount_inr: amountInr },
    });
    if (res.count === 0) continue;
    out.push({ commissionId: t.commission_id, trancheId: t.id, name: t.name, amountInr });
  }
  return out;
}

// ---- Volume bonus due board (Vendor Billing) ---------------------------------

/**
 * Every university volume bonus, grouped as Finance bills them: contract
 * (vendor + university) × intake × currency, e.g. "UCD · Sep 2026 intake ·
 * 5 × €500". Each row says whether it's invoiced, collected, and what Finance
 * should check: a counted student who has since withdrawn or deferred out of
 * the intake, or (retroactive schemes) one invoiced below the rate the intake
 * has since reached.
 */
export async function volumeBonusBoard(client: Client = db) {
  const rows = await client.commission_bonus.findMany({
    where: { kind: BonusKind.VOLUME },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    select: {
      id: true,
      amount: true,
      currency: true,
      intake: true,
      scheme_id: true,
      scheme_name: true,
      slab_min: true,
      slab_max: true,
      student_count: true,
      via: true,
      is_manual: true,
      edit_reason: true,
      created_at: true,
      scheme: { select: { retroactive: true } },
      commission_tranche: {
        select: {
          id: true,
          status: true,
          vendor_invoice_item_tranche: {
            select: {
              vendor_invoice_item: {
                select: { vendor_invoice: { select: { id: true, invoice_number: true, status: true } } },
              },
            },
          },
        },
      },
      commission: {
        select: {
          id: true,
          vendor_id: true,
          tuition_fee: true,
          vendor: { select: { name: true } },
          application: {
            select: {
              status: true,
              university_app_id: true,
              student: { select: { id: true, first_name: true, last_name: true } },
              deferred_intake_month: true,
              deferred_intake_year: true,
              program_start_date: true,
              course: {
                select: {
                  name: true,
                  intake_month: true,
                  intake_year: true,
                  university: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  // The highest per-student amount each scheme has reached in each intake —
  // what a retroactive scheme's earlier students should be on.
  const topRate = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.scheme_id}|${r.intake}`;
    topRate.set(k, Math.max(topRate.get(k) ?? 0, num(r.amount)));
  }
  type Group = {
    key: string;
    vendorId: number | null;
    vendorName: string;
    universityId: number;
    university: string;
    intake: string | null;
    intakeLabel: string;
    currency: string;
    rows: ReturnType<typeof toRow>[];
  };
  const toRow = (r: (typeof rows)[number]) => {
    const app = r.commission.application;
    const inv = r.commission_tranche?.vendor_invoice_item_tranche?.vendor_invoice_item.vendor_invoice ?? null;
    const flags: string[] = [];
    if (app.status !== UniApplicationStatus.ENROLLED) {
      flags.push(`Application is now ${UniApplicationStatusLabel[app.status as UniApplicationStatus] ?? "not enrolled"}`);
    }
    const nowIntake = intakeKey(app);
    if (r.intake && nowIntake && nowIntake !== r.intake) {
      flags.push(`Deferred to ${intakeLabel(nowIntake)} (counted in ${intakeLabel(r.intake)})`);
    }
    const top = topRate.get(`${r.scheme_id}|${r.intake}`) ?? 0;
    const topUp = r.scheme?.retroactive === 1 && inv && top > num(r.amount) ? round2(top - num(r.amount)) : 0;
    if (topUp > 0) flags.push(`Invoiced at a lower rate: top-up of ${topUp} ${r.currency} may be due`);
    const status = r.commission_tranche?.status ?? TrancheStatus.UPCOMING;
    return {
      commissionBonusId: r.id,
      commissionId: r.commission.id,
      trancheId: r.commission_tranche?.id ?? null,
      studentName: `${app.student.first_name} ${app.student.last_name}`.trim(),
      cpStudentId: `CP-${String(app.student.id).padStart(5, "0")}`,
      universityStudentId: app.university_app_id,
      program: app.course.name,
      amount: num(r.amount),
      scheme: r.scheme_name,
      slab: slabLabel(r.slab_min, r.slab_max),
      count: r.student_count,
      via: r.via,
      edited: r.is_manual === 1,
      editReason: r.edit_reason,
      invoice: inv ? { id: inv.id, number: inv.invoice_number, status: inv.status } : null,
      collected: status === TrancheStatus.RECEIVED || status === TrancheStatus.PAID,
      awaitingApproval: status === TrancheStatus.COLLECTED,
      topUp,
      flags,
      approvedAt: r.created_at,
    };
  };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const c = r.commission;
    const uni = c.application.course.university;
    const key = `${c.vendor_id ?? "direct"}|${uni.id}|${r.intake ?? "-"}|${r.currency}`;
    const g =
      groups.get(key) ??
      ({
        key,
        vendorId: c.vendor_id,
        vendorName: c.vendor?.name ?? "Direct",
        universityId: uni.id,
        university: uni.name,
        intake: r.intake,
        intakeLabel: intakeLabel(r.intake),
        currency: r.currency,
        rows: [],
      } satisfies Group);
    g.rows.push(toRow(r));
    groups.set(key, g);
  }
  return Array.from(groups.values()).map((g) => {
    const due = g.rows.filter((r) => r.invoice == null);
    return {
      ...g,
      students: g.rows.length,
      dueCount: due.length,
      dueAmount: round2(due.reduce((s, r) => s + r.amount, 0)),
      invoicedAmount: round2(g.rows.filter((r) => r.invoice).reduce((s, r) => s + r.amount, 0)),
      collectedAmount: round2(g.rows.filter((r) => r.collected).reduce((s, r) => s + r.amount, 0)),
      flagCount: g.rows.filter((r) => r.flags.length > 0).length,
    };
  });
}

// ---- Totals (Finance dashboard) ----------------------------------------------

/**
 * Bonus money by financial year (Apr–Mar, of the approval), kind and currency,
 * for the Finance dashboard. Volume bonus is Collegepond INCOME: accrued
 * (stamped), invoiced, and collected (approved collections, INR). Partner
 * incentive is a Collegepond COST: accrued, claimable/claimed (INR fixed on
 * release) and paid to the partner (INR).
 */
export async function bonusTotals(opts: { fy?: number } = {}, client: Client = db) {
  const rows = await client.commission_bonus.findMany({
    select: {
      kind: true,
      amount: true,
      currency: true,
      created_at: true,
      commission: { select: { approved_at: true, created_at: true } },
      commission_tranche: {
        select: { status: true, amount_inr: true, vendor_invoice_item_tranche: { select: { id: true } } },
      },
    },
  });
  type Line = {
    fy: number;
    kind: BonusKind;
    currency: string;
    students: number;
    accrued: number;
    invoiced: number;
    collectedInr: number;
    claimableInr: number;
    paidInr: number;
  };
  const out = new Map<string, Line>();
  for (const r of rows) {
    const fy = financialYearOf(r.commission.approved_at ?? r.commission.created_at);
    if (opts.fy != null && fy !== opts.fy) continue;
    const key = `${fy}|${r.kind}|${r.currency}`;
    const l =
      out.get(key) ??
      ({ fy, kind: r.kind as BonusKind, currency: r.currency, students: 0, accrued: 0, invoiced: 0, collectedInr: 0, claimableInr: 0, paidInr: 0 } satisfies Line);
    const t = r.commission_tranche;
    const amount = num(r.amount);
    l.students += 1;
    l.accrued += amount;
    if (r.kind === BonusKind.VOLUME) {
      if (t?.vendor_invoice_item_tranche) l.invoiced += amount;
      if (t && (t.status === TrancheStatus.RECEIVED || t.status === TrancheStatus.PAID)) l.collectedInr += num(t.amount_inr);
    } else if (t) {
      if (t.status === TrancheStatus.RECEIVED) l.claimableInr += num(t.amount_inr);
      if (t.status === TrancheStatus.PAID) l.paidInr += num(t.amount_inr);
    }
    out.set(key, l);
  }
  return Array.from(out.values())
    .map((l) => ({
      ...l,
      accrued: round2(l.accrued),
      invoiced: round2(l.invoiced),
      collectedInr: round2(l.collectedInr),
      claimableInr: round2(l.claimableInr),
      paidInr: round2(l.paidInr),
    }))
    .sort((a, b) => a.fy - b.fy || a.kind - b.kind || a.currency.localeCompare(b.currency));
}
