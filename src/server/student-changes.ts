import "server-only";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import {
  AdminRole,
  CourseLevelLabel,
  EducationLevelLabel,
  EmergencyRelationshipLabel,
  GenderLabel,
  MaritalStatusLabel,
  STUDENT_DOC_TYPES,
} from "~/server/db/enums";
import { appUrl, partnerProfileUpdatedEmail, sendEmail } from "~/server/email";
import { studentPartner } from "~/server/staff-access";
// Plain option data (no React), shared with the profile form's test editor.
import { ALL_TESTS } from "~/app/admin/(dashboard)/students/[id]/profile-lib";

// Partner-portal edits to a student's profile, as a field-level diff, so
// Collegepond's counselling team hears about them (decided with Suraj,
// 14 Oct 2026):
//   - every change is a student_partner_update row (also the audit trail);
//   - one email per burst of edits to the student's Collegepond counsellor;
//     with none, the partner's Counsellor Lead (who can see the student); with
//     no lead either, every Counsellor Lead;
//   - an admin-bell item until someone marks the changes reviewed.
//
// A section is snapshotted as { "Human label": "display value" } before and
// after the save; the diff is the labels whose values differ.

export type Snapshot = Record<string, string | null>;
export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}
export type ChangeSection = "profile" | "academics" | "work" | "tests" | "documents";

export const SECTION_LABEL: Record<ChangeSection, string> = {
  profile: "Personal information",
  academics: "Academic qualification",
  work: "Work experience",
  tests: "Tests",
  documents: "Documents",
};

const MAX_VALUE = 120;
const MAX_CHANGES = 60;

function show(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v as string | number | boolean);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
}
const yesNo = (v: number | null) => (v === null ? null : v === 1 ? "Yes" : "No");
const label = (map: Record<number, string>, v: number | null) =>
  v === null ? null : (map[v] ?? String(v));

export function diffSnapshots(before: Snapshot, after: Snapshot): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const out: FieldChange[] = [];
  for (const k of keys) {
    const from = before[k] ?? null;
    const to = after[k] ?? null;
    if (from !== to) out.push({ field: k, from, to });
  }
  return out.slice(0, MAX_CHANGES);
}

// ---- Snapshots --------------------------------------------------------------

export async function profileSnapshot(studentId: number): Promise<Snapshot> {
  const s = await db.student.findUnique({
    where: { id: studentId },
    include: { emergency_contact: { orderBy: { id: "asc" } } },
  });
  if (!s) return {};
  const snap: Snapshot = {
    "First name": show(s.first_name),
    "Middle name": show(s.middle_name),
    "Last name": show(s.last_name),
    Email: show(s.email),
    Phone: show(s.phone),
    "Date of birth": show(s.date_of_birth),
    Gender: label(GenderLabel, s.gender),
    Nationality: show(s.nationality),
    "Marital status": label(MaritalStatusLabel, s.marital_status),
    "Destination country": show(s.country),
    Intake: show(s.intake),
    "Course level": label(CourseLevelLabel, s.course_level),
    "Interested program": show(s.interested_program),
    "Education loan": yesNo(s.education_loan),
    "Apply through Collegepond": yesNo(s.apply_through_cp),
    "Mailing address": show(
      [s.mailing_address1, s.mailing_address2, s.mailing_city, s.mailing_state, s.mailing_country, s.mailing_postal]
        .filter(Boolean)
        .join(", "),
    ),
    "Permanent address": show(
      [s.permanent_address1, s.permanent_address2, s.permanent_city, s.permanent_state, s.permanent_country, s.permanent_postal]
        .filter(Boolean)
        .join(", "),
    ),
    "Dual citizenship": yesNo(s.dual_citizenship),
    "Passport number": show(s.passport_number),
    "Passport expiry": show(s.passport_expiry),
    "Visa refused": yesNo(s.visa_refused),
    "Visa refusal details": show(s.visa_refused_details),
    "Criminal record": yesNo(s.criminal_record),
    "Criminal record details": show(s.criminal_record_details),
    "Medical condition": yesNo(s.medical_condition),
    "Medical condition details": show(s.medical_condition_details),
  };
  s.emergency_contact.forEach((c, i) => {
    snap[`Emergency contact ${i + 1}`] = show(
      [label(EmergencyRelationshipLabel, c.relationship), c.name, c.email, c.phone].filter(Boolean).join(" · "),
    );
  });
  return snap;
}

const EDU_FIELDS: [keyof EduRow, string][] = [
  ["qualification", "Qualification"],
  ["institution", "Institution"],
  ["board", "Board / University"],
  ["country", "Country"],
  ["state", "State"],
  ["city", "City"],
  ["major", "Major"],
  ["grading_system", "Grading system"],
  ["scale", "Scale"],
  ["score", "Score"],
  ["predicted_score", "Predicted score"],
  ["language", "Medium"],
  ["research_topic", "Research topic"],
];
type EduRow = NonNullable<Awaited<ReturnType<typeof db.student_education.findFirst>>>;

export async function academicsSnapshot(studentId: number): Promise<Snapshot> {
  const [s, rows] = await Promise.all([
    db.student.findUnique({ where: { id: studentId }, select: { highest_education_level: true } }),
    db.student_education.findMany({ where: { student_id: studentId } }),
  ]);
  const snap: Snapshot = {
    "Highest education": label(EducationLevelLabel, s?.highest_education_level ?? null),
  };
  for (const r of rows) {
    const lvl = label(EducationLevelLabel, r.level) ?? `Level ${r.level}`;
    for (const [k, name] of EDU_FIELDS) snap[`${lvl} · ${name}`] = show(r[k]);
    snap[`${lvl} · Passed`] = r.pass_year ? `${r.pass_month ? `${r.pass_month}/` : ""}${r.pass_year}` : null;
  }
  return snap;
}

export async function workSnapshot(studentId: number): Promise<Snapshot> {
  const rows = await db.student_work_experience.findMany({ where: { student_id: studentId } });
  const snap: Snapshot = {};
  for (const w of rows) {
    // Keyed by employer + start, so an edited role diffs field by field.
    const key = `${w.company} (from ${w.start_month}/${w.start_year})`;
    snap[`${key} · Job title`] = show(w.job_title);
    snap[`${key} · Employment type`] = show(w.employment_type);
    snap[`${key} · Industry`] = show(w.industry);
    snap[`${key} · Until`] = w.currently_working === 1 ? "Present" : w.end_year ? `${w.end_month ?? ""}/${w.end_year}` : null;
    snap[`${key} · Location`] = show([w.city, w.country].filter(Boolean).join(", "));
    snap[`${key} · Description`] = show(w.description);
  }
  return snap;
}

export async function testsSnapshot(studentId: number): Promise<Snapshot> {
  const rows = await db.student_test_score.findMany({ where: { student_id: studentId } });
  const snap: Snapshot = {};
  for (const t of rows) {
    const def = ALL_TESTS.find((d) => d.key === t.test);
    const name = `${def?.label ?? t.test} #${t.attempt}`;
    const scores = (t.scores ?? {}) as Record<string, number>;
    for (const [k, v] of Object.entries(scores)) {
      const f = def?.fields.find((x) => x.id === k);
      snap[`${name} · ${f?.label ?? k}`] = show(v);
    }
    snap[`${name} · Test date`] = show(t.test_date);
  }
  return snap;
}

// Document uploads are reported as plain "added" lines.
export function documentChange(docType: string, fileName: string): FieldChange {
  const fixed = STUDENT_DOC_TYPES.find((d) => d.key === docType);
  return { field: fixed?.label ?? docType, from: null, to: fileName };
}

// ---- Recording + the counselling team's email --------------------------------

// Quiet period that closes a burst of edits, and the longest a change waits.
const QUIET_MS = 10 * 60 * 1000;
const MAX_HOLD_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setTimeout> | null = null;

// Records a partner's edit (nothing if it changed nothing) and arranges the
// email. Never throws: the edit itself is already saved.
export async function recordPartnerChange(
  studentId: number,
  partnerUserId: number,
  section: ChangeSection,
  changes: FieldChange[],
): Promise<void> {
  try {
    if (changes.length === 0) return;
    await db.student_partner_update.create({
      data: { student_id: studentId, user_id: partnerUserId, section, changes: changes as object[] },
    });
    await db.audit_log.create({
      data: {
        action: "student.partner_edit",
        entity_type: "student",
        entity_id: studentId,
        metadata: { byPartnerUserId: partnerUserId, section, changes: changes as object[] },
      },
    });
    scheduleFlush();
    void flushPartnerUpdateEmails();
  } catch (e) {
    console.error("[partner-edit] record failed:", e instanceof Error ? e.message : e);
  }
}

function scheduleFlush() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushPartnerUpdateEmails();
  }, QUIET_MS + 5_000);
  // Don't keep a process alive just for this.
  timer.unref?.();
}

const fullName = (u: { first_name: string; last_name: string }) =>
  `${u.first_name} ${u.last_name}`.trim();

// Emails every student whose burst of partner edits is over (quiet for
// QUIET_MS) or has waited MAX_HOLD_MS. Safe to call often and concurrently:
// rows are claimed (emailed_at set) before sending, so nothing goes twice.
// Runs from the edit itself, a timer, and the admin bell's polling, so a
// restart that drops the timer only delays an email.
export async function flushPartnerUpdateEmails(now = new Date()): Promise<number> {
  let sent = 0;
  try {
    const pending = await db.student_partner_update.findMany({
      where: { emailed_at: null },
      orderBy: { created_at: "asc" },
      select: { id: true, student_id: true, user_id: true, section: true, changes: true, created_at: true },
      take: 500,
    });
    const byStudent = new Map<number, typeof pending>();
    for (const r of pending) byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r]);

    for (const [studentId, rows] of byStudent) {
      const newest = rows[rows.length - 1]!.created_at.getTime();
      const oldest = rows[0]!.created_at.getTime();
      const due = now.getTime() - newest >= QUIET_MS || now.getTime() - oldest >= MAX_HOLD_MS;
      if (!due) continue;

      const claim = await db.student_partner_update.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, emailed_at: null },
        data: { emailed_at: now },
      });
      if (claim.count !== rows.length) continue; // another flush has these

      try {
        await emailCounsellingTeam(studentId, rows);
        sent++;
      } catch (e) {
        console.error("[partner-edit] email failed:", e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.error("[partner-edit] flush failed:", e instanceof Error ? e.message : e);
  }
  return sent;
}

async function emailCounsellingTeam(
  studentId: number,
  rows: { user_id: number | null; section: string; changes: unknown; created_at: Date }[],
) {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      first_name: true,
      last_name: true,
      org_id: true,
      created_by_user_id: true,
      cp_counsellor: { select: { email: true, first_name: true, last_name: true, status: true } },
    },
  });
  if (!student) return;

  // The student's Collegepond counsellor; with none (or inactive), the
  // partner's Counsellor Lead; with no active lead, every Lead.
  const cp = student.cp_counsellor?.status === 1 ? student.cp_counsellor : null;
  const leadId = cp ? null : ((await studentPartner(student))?.lead_counsellor_id ?? null);
  const lead = leadId
    ? await db.collegepond_user.findFirst({
        where: { id: leadId, status: 1 },
        select: { email: true, first_name: true, last_name: true },
      })
    : null;
  const recipients = cp
    ? [cp]
    : lead
      ? [lead]
      : await db.collegepond_user.findMany({
          where: { role: AdminRole.COUNSELLOR_LEAD, status: 1 },
          select: { email: true, first_name: true, last_name: true },
        });
  if (recipients.length === 0) {
    console.log(`[partner-edit] student ${studentId}: no Collegepond counsellor or lead to email`);
    return;
  }

  const partnerIds = [...new Set(rows.map((r) => r.user_id).filter((x): x is number => x !== null))];
  const partners = await db.user.findMany({
    where: { id: { in: partnerIds } },
    select: { first_name: true, last_name: true, organization: { select: { name: true } } },
  });
  const by = partners.map((p) => (p.organization ? `${fullName(p)} (${p.organization.name})` : fullName(p)));

  // Net change per field across the burst: first "from", last "to".
  const sections: { title: string; lines: string[] }[] = [];
  for (const sec of Object.keys(SECTION_LABEL) as ChangeSection[]) {
    const net = new Map<string, FieldChange>();
    for (const r of rows.filter((x) => x.section === sec)) {
      for (const c of r.changes as FieldChange[]) {
        const prev = net.get(c.field);
        net.set(c.field, { field: c.field, from: prev ? prev.from : c.from, to: c.to });
      }
    }
    const lines = [...net.values()]
      .filter((c) => c.from !== c.to)
      .map((c) => formatChange(c, sec));
    if (lines.length) sections.push({ title: SECTION_LABEL[sec], lines });
  }
  if (sections.length === 0) return;

  const name = fullName(student);
  for (const r of recipients) {
    await sendEmail(
      r.email,
      partnerProfileUpdatedEmail(
        { name: fullName(r) },
        { studentName: name, studentId, updatedBy: by, sections },
        appUrl(),
      ),
    );
  }
}

export function formatChange(c: FieldChange, section?: string): string {
  if (section === "documents") return `${c.field} uploaded: ${c.to ?? ""}`;
  if (c.from === null) return `${c.field}: added "${c.to}"`;
  if (c.to === null) return `${c.field}: removed (was "${c.from}")`;
  return `${c.field}: "${c.from}" → "${c.to}"`;
}

// ---- Admin side --------------------------------------------------------------

// Students (within `studentWhere`, the same filter as the admin Students
// list) that have partner changes nobody has reviewed: the admin-bell item.
// Pass that list's scoping here so a scoped user only counts their own.
export async function partnerEditedStudentIds(
  studentWhere: Prisma.studentWhereInput = {},
): Promise<number[]> {
  const rows = await db.student_partner_update.groupBy({
    by: ["student_id"],
    where: { reviewed_at: null, student: studentWhere },
  });
  return rows.map((r) => r.student_id);
}

// Unreviewed partner changes for one student, newest first, for the banner
// on the admin profile.
export async function pendingPartnerUpdates(studentId: number) {
  const rows = await db.student_partner_update.findMany({
    where: { student_id: studentId, reviewed_at: null },
    orderBy: { created_at: "desc" },
    take: 50,
  });
  const ids = [...new Set(rows.map((r) => r.user_id).filter((x): x is number => x !== null))];
  const users = ids.length
    ? await db.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, first_name: true, last_name: true, organization: { select: { name: true } } },
      })
    : [];
  return rows.map((r) => {
    const u = users.find((x) => x.id === r.user_id);
    return {
      id: r.id,
      section: SECTION_LABEL[r.section as ChangeSection] ?? r.section,
      by: u ? fullName(u) : "A partner",
      agency: u?.organization?.name ?? null,
      at: r.created_at.toISOString(),
      changes: (r.changes as unknown as FieldChange[]).map((c) => formatChange(c, r.section)),
    };
  });
}
