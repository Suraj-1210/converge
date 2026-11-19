import "server-only";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { AdminRole, MANDATORY_STUDENT_DOCS, ShortlistSource, StudentStatus } from "~/server/db/enums";
import { partnerName } from "~/lib/partner-display";
import { tatStatus } from "~/lib/tat";
import { requireStaffStudent, staffStudentScope, type StaffUser } from "~/server/staff-access";
import { getTatConfig, getTatTarget } from "~/server/tat";
import { responderFor } from "~/server/out-of-office";
import { slaMinutesBetween, slaMinutesIn } from "~/server/working-days";

// Shortlisting TAT (item 10, decided with Suraj 19 Nov 2026), shown on TAT
// Management. The SLA is the 'shortlisting' TAT action target (24h by
// default, Super Admin edits it in Settings -> TAT Settings), measured from
// the student being added by the partner to the shortlist being shared with
// the partner, with Saturday, Sunday and TAT-holiday hours not counted (other hours
// count around the clock: 10 Nov 11:00 → 11 Nov 14:00 = 27h).
//
// Milestones per student (student_shortlisting, first write wins):
//   added                  student.created_at
//   assigned               first counsellor assignment (audit log), or
//                          cp_auto_assigned_at
//   review started         the assigned counsellor first opens the profile
//   review completed       marked by the counsellor
//   documents verified     automatic: when both the passport and the CV
//                          are on the student's profile (the later of the
//                          two first uploads; Suraj, 19 Nov 2026). Student
//                          profile documents have no review step, so this
//                          is "uploaded", not "checked". Marked by hand
//                          only when they aren't both uploaded.
//   shortlisting started   the first university Collegepond shortlists
//   shortlisting completed marked by the counsellor (else = shared)
//   shared                 the shortlist follow-up case opens
//   partner confirmed      the case is confirmed

export const MILESTONE_FIELDS = [
  "assigned_at",
  "review_started_at",
  "review_completed_at",
  "docs_verified_at",
  "shortlisting_started_at",
  "shortlisting_completed_at",
  "shared_at",
  "confirmed_at",
] as const;
export type MilestoneField = (typeof MILESTONE_FIELDS)[number];
// The ones a counsellor marks by hand.
export const MANUAL_MILESTONES = ["review_completed_at", "docs_verified_at", "shortlisting_completed_at"] as const;
export type ManualMilestone = (typeof MANUAL_MILESTONES)[number];

export const SHORTLISTING = "shortlisting";

// First write wins; never throws (it's a side effect of something else).
export async function stampMilestone(studentId: number, field: MilestoneField, at: Date = new Date()): Promise<void> {
  if (!MILESTONE_FIELDS.includes(field)) return;
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO student_shortlisting (student_id, \`${field}\`) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`${field}\` = COALESCE(\`${field}\`, VALUES(\`${field}\`))`,
      studentId,
      at,
    );
  } catch (e) {
    console.error("[shortlisting-tat] stamp failed:", e instanceof Error ? e.message : e);
  }
}

// The assigned counsellor (or whoever covers them) opened the profile:
// profile review started. Never throws.
export async function noteProfileOpened(user: StaffUser, studentId: number) {
  if (user.role !== AdminRole.COUNSELLOR && user.role !== AdminRole.COUNSELLOR_LEAD) return;
  try {
    const s = await db.student.findUnique({ where: { id: studentId }, select: { cp_counsellor_id: true } });
    if (s?.cp_counsellor_id == null) return;
    if (s.cp_counsellor_id !== user.id && (await responderFor(s.cp_counsellor_id)) !== user.id) return;
    const m = await db.student_shortlisting.findUnique({ where: { student_id: studentId }, select: { review_started_at: true } });
    if (m?.review_started_at) return;
    await stampMilestone(studentId, "review_started_at");
  } catch (e) {
    console.error("[shortlisting-tat] profile opened failed:", e instanceof Error ? e.message : e);
  }
}

export async function markMilestone(user: StaffUser, studentId: number, field: ManualMilestone, clear = false) {
  await requireStaffStudent(user, studentId);
  if (!MANUAL_MILESTONES.includes(field)) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown milestone" });
  if (clear) {
    await db.$executeRawUnsafe(`UPDATE student_shortlisting SET \`${field}\` = NULL WHERE student_id = ?`, studentId);
  } else {
    await stampMilestone(studentId, field);
  }
  await db.audit_log.create({
    data: {
      action: clear ? "student.shortlisting_milestone_cleared" : "student.shortlisting_milestone_marked",
      entity_type: "student",
      entity_id: studentId,
      metadata: { field, byCpUserId: user.id },
    },
  });
  return { ok: true as const };
}

// When each student had both mandatory documents (passport and CV) on their
// profile: the later of the two first uploads. Missing = not both yet.
export async function docsInTimes(studentIds: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (studentIds.length === 0) return out;
  const rows = await db.document.groupBy({
    by: ["student_id", "doc_type"],
    where: { student_id: { in: studentIds }, application_id: null, doc_type: { in: [...MANDATORY_STUDENT_DOCS] } },
    _min: { created_at: true },
  });
  const byStudent = new Map<number, Date[]>();
  for (const r of rows) {
    if (r.student_id === null || !r._min.created_at) continue;
    byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r._min.created_at]);
  }
  for (const [id, times] of byStudent) {
    if (times.length >= MANDATORY_STUDENT_DOCS.length) out.set(id, new Date(Math.max(...times.map((t) => t.getTime()))));
  }
  return out;
}

// First assignment time per student (audit log), for those without a stamp.
async function assignmentTimes(studentIds: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (studentIds.length === 0) return out;
  const logs = await db.audit_log.findMany({
    where: {
      entity_type: "student",
      entity_id: { in: studentIds },
      action: { in: ["student.cp_counsellor_assigned", "student.cp_counsellor_auto_assigned"] },
    },
    orderBy: { created_at: "asc" },
    select: { entity_id: true, created_at: true },
  });
  for (const l of logs) if (l.entity_id !== null && !out.has(l.entity_id)) out.set(l.entity_id, l.created_at);
  return out;
}

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();

export type Milestones = {
  added: string;
  assigned: string | null;
  reviewStarted: string | null;
  reviewCompleted: string | null;
  docsVerified: string | null;
  shortlistingStarted: string | null;
  shortlistingCompleted: string | null;
  shared: string | null;
  confirmed: string | null;
};

// One student's milestones (Follow-up History tab).
export async function studentMilestones(user: StaffUser, studentId: number) {
  await requireStaffStudent(user, studentId);
  const [s, m, assigned, target, docsIn] = await Promise.all([
    db.student.findUnique({ where: { id: studentId }, select: { created_at: true, cp_auto_assigned_at: true } }),
    db.student_shortlisting.findUnique({ where: { student_id: studentId } }),
    assignmentTimes([studentId]),
    getTatTarget(SHORTLISTING),
    docsInTimes([studentId]),
  ]);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
  const ms: Milestones = {
    added: s.created_at.toISOString(),
    assigned: iso(m?.assigned_at ?? assigned.get(studentId) ?? s.cp_auto_assigned_at),
    reviewStarted: iso(m?.review_started_at),
    reviewCompleted: iso(m?.review_completed_at),
    docsVerified: iso(docsIn.get(studentId) ?? m?.docs_verified_at),
    shortlistingStarted: iso(m?.shortlisting_started_at),
    shortlistingCompleted: iso(m?.shortlisting_completed_at),
    shared: iso(m?.shared_at),
    confirmed: iso(m?.confirmed_at),
  };
  const end = m?.shared_at ?? new Date();
  const elapsed = await slaMinutesBetween(s.created_at, end);
  return {
    milestones: ms,
    // Filled from the passport + CV uploads (no manual mark needed).
    docsVerifiedAuto: docsIn.has(studentId),
    elapsedMinutes: elapsed,
    shared: !!m?.shared_at,
    slaMinutes: target?.thresholdMinutes ?? null,
    status: target ? tatStatus(elapsed, target) : null,
  };
}

// ---- Report ------------------------------------------------------------------

export type ShortlistingTatFilter = { from: string; to: string; counsellorId?: number };

type Seg = { key: string; label: string; from: keyof Milestones; to: keyof Milestones };
const SEGMENTS: Seg[] = [
  { key: "assignment", label: "Assignment", from: "added", to: "assigned" },
  { key: "review", label: "Profile review", from: "reviewStarted", to: "reviewCompleted" },
  { key: "docs", label: "Documents in (passport + CV)", from: "added", to: "docsVerified" },
  { key: "prep", label: "Shortlist preparation", from: "shortlistingStarted", to: "shortlistingCompleted" },
  { key: "sharing", label: "Sharing", from: "shortlistingCompleted", to: "shared" },
  { key: "confirmation", label: "Partner confirmation", from: "shared", to: "confirmed" },
];

export async function shortlistingTatReport(user: StaffUser, f: ShortlistingTatFilter) {
  const target = await getTatTarget(SHORTLISTING);
  const scope = await staffStudentScope(user);
  const where: Prisma.studentWhereInput = {
    AND: [
      scope,
      // Added by a partner.
      { OR: [{ org_id: { not: null } }, { created_by_user_id: { not: null } }] },
      { created_at: { gte: new Date(`${f.from}T00:00:00+05:30`), lt: new Date(new Date(`${f.to}T00:00:00+05:30`).getTime() + 86_400_000) } },
      ...(f.counsellorId ? [{ cp_counsellor_id: f.counsellorId }] : []),
    ],
  };
  const students = await db.student.findMany({
    where,
    select: {
      id: true,
      first_name: true,
      last_name: true,
      status: true,
      created_at: true,
      inactive_at: true,
      cp_auto_assigned_at: true,
      cp_counsellor_id: true,
      cp_counsellor: { select: { id: true, first_name: true, last_name: true } },
      organization: { select: { name: true, type: true } },
      created_by: { select: { first_name: true, last_name: true } },
      shortlisting: true,
      _count: { select: { application: true } },
    },
    orderBy: { created_at: "desc" },
    take: 3000,
  });
  const ids = students.map((s) => s.id);
  const [assigned, firstProposals, docsIn] = await Promise.all([
    assignmentTimes(ids),
    // Older students without a stamp: their first Collegepond proposal.
    ids.length
      ? db.shortlist.groupBy({
          by: ["student_id"],
          where: { student_id: { in: ids }, added_by: ShortlistSource.COLLEGEPOND },
          _min: { proposed_at: true },
        })
      : [],
    docsInTimes(ids),
  ]);
  const firstProposal = new Map(firstProposals.map((r) => [r.student_id, r._min.proposed_at]));
  const now = new Date();
  const { timezone: tz, holidays } = await getTatConfig();
  const rows = students.map((s) => {
    const m = s.shortlisting;
    const sharedAt = m?.shared_at ?? null;
    const startedAt = m?.shortlisting_started_at ?? firstProposal.get(s.id) ?? null;
    const ms: Record<keyof Milestones, Date | null> = {
      added: s.created_at,
      assigned: m?.assigned_at ?? assigned.get(s.id) ?? s.cp_auto_assigned_at,
      reviewStarted: m?.review_started_at ?? null,
      reviewCompleted: m?.review_completed_at ?? null,
      docsVerified: docsIn.get(s.id) ?? m?.docs_verified_at ?? null,
      shortlistingStarted: startedAt,
      shortlistingCompleted: m?.shortlisting_completed_at ?? sharedAt,
      shared: sharedAt,
      confirmed: m?.confirmed_at ?? null,
    };
    const end = sharedAt ?? now;
    const elapsed = slaMinutesIn(s.created_at, end, tz, holidays);
    const segs: Record<string, number | null> = {};
    for (const seg of SEGMENTS) {
      const a = ms[seg.from];
      const b = ms[seg.to];
      segs[seg.key] = a && b && b >= a ? slaMinutesIn(a, b, tz, holidays) : null;
    }
    // Pending: no shortlist shared yet, still a live lead.
    const pending =
      !sharedAt &&
      !s.inactive_at &&
      s._count.application === 0 &&
      ([StudentStatus.NEW, StudentStatus.INTERESTED, StudentStatus.CONNECTED, StudentStatus.SHORTLISTED] as number[]).includes(s.status);
    return {
      studentId: s.id,
      studentName: fullName(s),
      partner: partnerName(s.organization, s.created_by),
      counsellorId: s.cp_counsellor_id,
      counsellor: s.cp_counsellor ? fullName(s.cp_counsellor) : null,
      addedAt: s.created_at.toISOString(),
      sharedAt: sharedAt?.toISOString() ?? null,
      confirmedAt: ms.confirmed?.toISOString() ?? null,
      elapsedMinutes: elapsed,
      shared: !!sharedAt,
      pending,
      status: target ? tatStatus(elapsed, target) : null,
      segments: segs,
    };
  });
  const shared = rows.filter((r) => r.shared);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const within = target ? shared.filter((r) => r.elapsedMinutes <= target.thresholdMinutes).length : null;
  const byCounsellor = new Map<number, { id: number; name: string; times: number[]; pending: number; within: number }>();
  for (const r of rows) {
    if (r.counsellorId === null) continue;
    const g = byCounsellor.get(r.counsellorId) ?? { id: r.counsellorId, name: r.counsellor ?? "", times: [], pending: 0, within: 0 };
    if (r.shared) {
      g.times.push(r.elapsedMinutes);
      if (target && r.elapsedMinutes <= target.thresholdMinutes) g.within++;
    } else if (r.pending) g.pending++;
    byCounsellor.set(r.counsellorId, g);
  }
  const counsellors = [...byCounsellor.values()]
    .map((g) => ({
      id: g.id,
      name: g.name,
      shared: g.times.length,
      avgMinutes: avg(g.times),
      fastestMinutes: g.times.length ? Math.min(...g.times) : null,
      slowestMinutes: g.times.length ? Math.max(...g.times) : null,
      withinSla: g.within,
      exceedingSla: g.times.length - g.within,
      pending: g.pending,
    }))
    .sort((a, b) => (a.avgMinutes ?? Infinity) - (b.avgMinutes ?? Infinity));
  const pendingRows = rows.filter((r) => r.pending).sort((a, b) => b.elapsedMinutes - a.elapsedMinutes);
  return {
    sla: target ? { minutes: target.thresholdMinutes, warningPct: target.warningPct } : null,
    stats: {
      students: rows.length,
      shared: shared.length,
      avgMinutes: avg(shared.map((r) => r.elapsedMinutes)),
      fastestMinutes: shared.length ? Math.min(...shared.map((r) => r.elapsedMinutes)) : null,
      slowestMinutes: shared.length ? Math.max(...shared.map((r) => r.elapsedMinutes)) : null,
      withinSla: within,
      exceedingSla: within === null ? null : shared.length - within,
      pending: pendingRows.length,
      pendingBreached: target ? pendingRows.filter((r) => r.elapsedMinutes > target.thresholdMinutes).length : null,
    },
    segments: SEGMENTS.map((seg) => {
      const xs = rows.map((r) => r.segments[seg.key]).filter((x): x is number => x !== null && x !== undefined);
      return { key: seg.key, label: seg.label, avgMinutes: avg(xs), count: xs.length };
    }),
    counsellors,
    fastest: counsellors.filter((c) => c.avgMinutes !== null).slice(0, 1)[0] ?? null,
    slowest: counsellors.filter((c) => c.avgMinutes !== null).slice(-1)[0] ?? null,
    pending: pendingRows.slice(0, 200),
    recent: shared.slice(0, 200),
  };
}

// Head Counsellor dashboard: pending shortlists and average turnaround in scope.
export async function shortlistingSummary(user: StaffUser, f: ShortlistingTatFilter) {
  const r = await shortlistingTatReport(user, f);
  return { pending: r.stats.pending, avgMinutes: r.stats.avgMinutes, sla: r.sla };
}
