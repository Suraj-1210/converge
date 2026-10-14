import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  agencyOwnerProcedure,
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { notifyStudentsAssigned } from "~/server/student-assignment";
import { partnerScope, requireOrgCounsellor, requireVisibleStudent } from "~/server/partner-access";
import { decryptSecret, encryptSecret } from "~/server/crypto";
import { db } from "~/server/db";
import { resolveStorageUrl } from "~/server/storage";
import { appUrl, applicationStatusEmail } from "~/server/email";
import { emailPartners, studentPartnerRecipients } from "~/server/email/partners";

// M6: defensive cap on unbounded list queries until cursor pagination lands.
const LIST_CAP = 500;
import {
  APP_TO_STUDENT_STATUS,
  COURSE_LEVEL_CODES,
  EDUCATION_LEVEL_CODES,
  EMERGENCY_RELATIONSHIP_CODES,
  GENDER_CODES,
  MARITAL_STATUS_CODES,
  NOTE_PRIORITY_CODES,
  STUDENT_STATUS_CODES,
  StudentStatus,
  TERMINAL_FALLBACK_STAGE,
  UNI_APP_STATUS_CODES,
  UniApplicationStatus,
  UniApplicationStatusLabel,
  UserStatus,
  UserType,
  type CourseLevel,
  type EducationLevel,
  type EmergencyRelationship,
  type Gender,
  type MaritalStatus,
  type NotePriority,
} from "~/server/db/enums";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

// Partner email for a student's application moving to `status`.
async function notifyApplicationStatus(applicationId: number, status: number): Promise<void> {
  try {
    const a = await db.application.findUnique({
      where: { id: applicationId },
      select: {
        student_id: true,
        student: { select: { first_name: true, last_name: true } },
        course: { select: { name: true, university: { select: { name: true } } } },
      },
    });
    if (!a) return;
    const recipients = await studentPartnerRecipients(a.student_id);
    const label = UniApplicationStatusLabel[status as UniApplicationStatus] ?? "Updated";
    await emailPartners(
      recipients,
      (r) =>
        applicationStatusEmail(
          r,
          {
            studentName: `${a.student.first_name} ${a.student.last_name}`.trim(),
            university: a.course.university.name,
            program: a.course.name,
            status: label,
          },
          appUrl(),
        ),
      "application-status",
      // Offers have their own toggle ("Offer Letter Received").
      status === UniApplicationStatus.CONDITIONAL_OFFER ||
        status === UniApplicationStatus.UNCONDITIONAL_OFFER
        ? "app.offer"
        : "app.status",
    );
  } catch (e) {
    console.error("[email] application-status lookup failed:", e instanceof Error ? e.message : e);
  }
}

const studentInclude = {
  organization: {
    select: {
      id: true,
      name: true,
      // Org owner carries the BDM linkage; surfaced as the student's BDM.
      user: {
        where: { is_owner: 1 },
        select: {
          collegepond_user_user_bdm_idTocollegepond_user: {
            select: { first_name: true, last_name: true },
          },
        },
        take: 1,
      },
    },
  },
  user: { select: { id: true, first_name: true, last_name: true } },
  cp_counsellor: { select: { id: true, first_name: true, last_name: true } },
  application: {
    select: {
      id: true,
      status: true,
      course: {
        select: {
          id: true,
          name: true,
          university: { select: { id: true, name: true } },
        },
      },
    },
  },
} as const;

type DbStudent = NonNullable<
  Awaited<
    ReturnType<typeof db.student.findFirst<{ include: typeof studentInclude }>>
  >
>;

function fullName(p: { first_name: string; last_name: string }): string {
  return `${p.first_name} ${p.last_name}`.trim();
}

function toApi(s: DbStudent) {
  const owner = s.organization?.user[0];
  const bdm = owner?.collegepond_user_user_bdm_idTocollegepond_user ?? null;
  return {
    id: s.id,
    firstName: s.first_name,
    lastName: s.last_name,
    email: s.email,
    phone: s.phone,
    country: s.country,
    intake: s.intake,
    dateOfBirth: s.date_of_birth
      ? s.date_of_birth.toISOString().slice(0, 10)
      : null,
    gender: s.gender,
    nationality: s.nationality,
    middleName: s.middle_name,
    maritalStatus: s.marital_status,
    mailingAddress1: s.mailing_address1,
    mailingAddress2: s.mailing_address2,
    mailingCity: s.mailing_city,
    mailingState: s.mailing_state,
    mailingCountry: s.mailing_country,
    mailingPostal: s.mailing_postal,
    permanentSameAsMailing: s.permanent_same_as_mailing === 1,
    permanentAddress1: s.permanent_address1,
    permanentAddress2: s.permanent_address2,
    permanentCity: s.permanent_city,
    permanentState: s.permanent_state,
    permanentCountry: s.permanent_country,
    permanentPostal: s.permanent_postal,
    dualCitizenship: s.dual_citizenship === null ? null : s.dual_citizenship === 1,
    passportNumber: s.passport_number,
    passportExpiry: s.passport_expiry
      ? s.passport_expiry.toISOString().slice(0, 10)
      : null,
    visaRefused: s.visa_refused === null ? null : s.visa_refused === 1,
    visaRefusedDetails: s.visa_refused_details,
    criminalRecord: s.criminal_record === null ? null : s.criminal_record === 1,
    criminalRecordDetails: s.criminal_record_details,
    medicalCondition:
      s.medical_condition === null ? null : s.medical_condition === 1,
    medicalConditionDetails: s.medical_condition_details,
    highestEducationLevel: s.highest_education_level,
    status: s.status,
    courseLevel: s.course_level,
    interestedProgram: s.interested_program,
    educationLoan: s.education_loan === null ? null : s.education_loan === 1,
    applyThroughCp: s.apply_through_cp === null ? null : s.apply_through_cp === 1,
    orgId: s.org_id,
    orgName: s.organization?.name ?? "Independent",
    counsellorId: s.counsellor_id,
    counsellorName: s.user ? fullName(s.user) : null,
    cpCounsellorId: s.cp_counsellor_id,
    cpCounsellorName: s.cp_counsellor ? fullName(s.cp_counsellor) : null,
    bdmName: bdm ? fullName(bdm) : null,
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
    applications: s.application.map((a) => ({
      id: a.id,
      status: a.status,
      program: a.course.name,
      university: a.course.university.name,
    })),
  };
}

// Course + university details for the profile page's Application tab cards
// (both shortlist entries and applications render the same meta line).
const courseCardSelect = {
  id: true,
  name: true,
  degree_level: true,
  duration_months: true,
  tuition_fee: true,
  currency: true,
  intake_month: true,
  intake_year: true,
  university: {
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      logo_url: true,
      app_source: true,
    },
  },
} as const;

function toCourseCard(c: {
  id: number;
  name: string;
  degree_level: number | null;
  duration_months: number | null;
  tuition_fee: { toNumber: () => number } | null;
  currency: string | null;
  intake_month: string | null;
  intake_year: number | null;
  university: {
    id: number;
    name: string;
    city: string | null;
    country: string;
    logo_url: string | null;
    app_source: string | null;
  };
}) {
  return {
    courseId: c.id,
    program: c.name,
    degreeLevel: c.degree_level,
    durationMonths: c.duration_months,
    tuitionFee: c.tuition_fee === null ? null : c.tuition_fee.toNumber(),
    currency: c.currency,
    intakeMonth: c.intake_month,
    intakeYear: c.intake_year,
    university: c.university.name,
    universityCity: c.university.city,
    universityCountry: c.university.country,
    universityLogoUrl: resolveStorageUrl(c.university.logo_url),
    universityAppSource: c.university.app_source,
  };
}

// Current happy-path stage (0–7) of an application: the status itself when
// on the happy path, else the furthest stage reached per history, else a
// sensible default for the terminal outcome.
function currentStage(
  status: number,
  history: Array<{ stage: number }>,
): number {
  if (status <= UniApplicationStatus.ENROLLED) return status;
  if (history.length > 0) return Math.max(...history.map((h) => h.stage));
  return (
    TERMINAL_FALLBACK_STAGE[status] ?? UniApplicationStatus.VISA_SECURED
  );
}

// Mirrors the student's pipeline status from their furthest active
// application (the mock's syncAppStatusToStudentTable). No-op for students
// with no applications.
async function syncStudentStatusFromApplications(studentId: number) {
  const apps = await db.application.findMany({
    where: { student_id: studentId },
    select: { status: true },
  });
  if (apps.length === 0) return;
  const active = apps.filter((a) => a.status < 20);
  const primary =
    active.length > 0
      ? active.reduce((best, a) => (a.status > best.status ? a : best))
      : apps[0]!;
  const mapped =
    APP_TO_STUDENT_STATUS[primary.status as UniApplicationStatus];
  if (mapped === undefined) return;
  await db.student.update({
    where: { id: studentId },
    data: { status: mapped },
  });
}

const studentStatusSchema = z
  .number()
  .int()
  .refine((v) => STUDENT_STATUS_CODES.includes(v as StudentStatus), {
    message: "Invalid status",
  });

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");

const educationLevelSchema = z
  .number()
  .int()
  .refine((v) => EDUCATION_LEVEL_CODES.includes(v as EducationLevel), {
    message: "Invalid education level",
  });

const notePrioritySchema = z
  .number()
  .int()
  .refine((v) => NOTE_PRIORITY_CODES.includes(v as NotePriority), {
    message: "Invalid priority",
  });

function boolToInt(v: boolean | null): number | null {
  return v === null ? null : v ? 1 : 0;
}

async function requireStudent(id: number) {
  const s = await db.student.findUnique({ where: { id }, select: { id: true } });
  if (!s) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
  }
}

const createFields = z.object({
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  email: z.string().trim().email().max(255),
  countryCode: z.string().trim().min(1).max(5),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9 ]{7,15}$/, "Phone must be 7–15 digits"),
  // Destination country of interest (ISO2).
  country: z.string().trim().length(2).transform((v) => v.toUpperCase()),
  intake: z.string().trim().min(1).max(20),
  // date_of_birth is NOT NULL in the DB, so it's required at creation.
  dateOfBirth: dateStringSchema,
  courseLevel: z
    .number()
    .int()
    .refine((v) => COURSE_LEVEL_CODES.includes(v as CourseLevel), {
      message: "Invalid course level",
    }),
  interestedProgram: z.string().trim().min(1).max(100),
  educationLoan: z.boolean(),
  applyThroughCp: z.boolean(),
});

function normalizePhone(countryCode: string, phone: string): string {
  return `${countryCode} ${phone.replace(/\s+/g, " ").trim()}`;
}

function phoneDigits(stored: string | null): string {
  return (stored ?? "").replace(/[^0-9]/g, "");
}

// Duplicate = same email (case-insensitive) OR same phone (digits-only).
// Returns the matching student row or null. `where` narrows the search scope
// (partners only collide within their own visible set; admin checks globally).
async function findDuplicate(
  email: string,
  countryCode: string,
  phone: string,
  where: Record<string, unknown>,
) {
  // phone is NOT NULL, so every student is a phone-match candidate; we scan the
  // whole in-scope set and match by email or phone-digits in JS below.
  const candidates = await db.student.findMany({
    where,
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      organization: { select: { name: true } },
    },
  });
  const targetDigits = phoneDigits(normalizePhone(countryCode, phone));
  const match = candidates.find(
    (c) =>
      c.email?.toLowerCase() === email.toLowerCase() ||
      (targetDigits.length > 0 && phoneDigits(c.phone) === targetDigits),
  );
  if (!match) return null;
  return {
    id: match.id,
    name: fullName(match),
    email: match.email,
    phone: match.phone,
    orgName: match.organization?.name ?? "Independent",
    matchedOn:
      match.email?.toLowerCase() === email.toLowerCase()
        ? ("email" as const)
        : ("phone" as const),
  };
}

// Partner-facing DTO: same as toApi minus CP-internal assignment fields.
function toPartnerApi(s: DbStudent) {
  const { cpCounsellorId, cpCounsellorName, bdmName, ...rest } = toApi(s);
  void cpCounsellorId;
  void cpCounsellorName;
  void bdmName;
  return rest;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const studentsRouter = createTRPCRouter({
  // Lightweight list for pickers (e.g. the Uni Assist student selector).
  listLite: protectedAdminProcedure.query(async () => {
    const rows = await db.student.findMany({
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      take: LIST_CAP,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        organization: { select: { name: true } },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      firstName: s.first_name,
      lastName: s.last_name,
      orgName: s.organization?.name ?? "Independent",
    }));
  }),

  // ---- Admin (cross-partner) ----------------------------------------------

  adminList: protectedAdminProcedure.query(async () => {
    const rows = await db.student.findMany({
      orderBy: { updated_at: "desc" },
      take: LIST_CAP,
      include: studentInclude,
    });
    return rows.map(toApi);
  }),

  // Org options for the admin Add Student "Partner" picker.
  listOrgs: protectedAdminProcedure.query(async () => {
    const rows = await db.organization.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    return rows;
  }),

  adminCreate: protectedAdminProcedure
    .input(
      createFields.extend({
        orgId: z.number().int().positive(),
        cpCounsellorId: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const duplicate = await findDuplicate(
        input.email,
        input.countryCode,
        input.phone,
        {},
      );
      if (duplicate) return { ok: false as const, duplicate };

      const created = await db.student.create({
        data: {
          first_name: input.firstName,
          last_name: input.lastName,
          email: input.email.toLowerCase(),
          phone: normalizePhone(input.countryCode, input.phone),
          country: input.country,
          intake: input.intake,
          date_of_birth: new Date(input.dateOfBirth),
          status: 0,
          course_level: input.courseLevel,
          interested_program: input.interestedProgram,
          education_loan: input.educationLoan ? 1 : 0,
          apply_through_cp: input.applyThroughCp ? 1 : 0,
          org_id: input.orgId,
          cp_counsellor_id: input.cpCounsellorId ?? null,
        },
        include: studentInclude,
      });
      return { ok: true as const, student: toApi(created) };
    }),

  // Bulk-create students from a parsed CSV. Rows are validated client-side; the
  // server re-validates the shape, then skips any row whose email/phone already
  // exists (or repeats earlier in the same file) and createMany's the rest.
  bulkImport: protectedAdminProcedure
    .input(
      z.object({
        orgId: z.number().int().positive(),
        cpCounsellorId: z.number().int().positive().nullable().optional(),
        rows: z.array(createFields).min(1).max(500),
      }),
    )
    .mutation(async ({ input }) => {
      // One pass over existing students to detect duplicates by email or by
      // phone digits, instead of a full scan per row.
      const existing = await db.student.findMany({
        select: { email: true, phone: true },
      });
      const seenEmails = new Set<string>();
      const seenPhones = new Set<string>();
      for (const s of existing) {
        if (s.email) seenEmails.add(s.email.toLowerCase());
        const d = phoneDigits(s.phone);
        if (d) seenPhones.add(d);
      }

      const toCreate: {
        first_name: string;
        last_name: string;
        email: string;
        phone: string;
        country: string;
        intake: string;
        date_of_birth: Date;
        status: number;
        course_level: number;
        interested_program: string;
        education_loan: number;
        apply_through_cp: number;
        org_id: number;
        cp_counsellor_id: number | null;
      }[] = [];
      const skipped: { row: number; email: string; reason: string }[] = [];

      input.rows.forEach((r, i) => {
        const email = r.email.toLowerCase();
        const phone = normalizePhone(r.countryCode, r.phone);
        const digits = phoneDigits(phone);
        if (seenEmails.has(email)) {
          skipped.push({ row: i + 1, email, reason: "Duplicate email" });
          return;
        }
        if (digits && seenPhones.has(digits)) {
          skipped.push({ row: i + 1, email, reason: "Duplicate phone" });
          return;
        }
        seenEmails.add(email);
        if (digits) seenPhones.add(digits);
        toCreate.push({
          first_name: r.firstName,
          last_name: r.lastName,
          email,
          phone,
          country: r.country,
          intake: r.intake,
          date_of_birth: new Date(r.dateOfBirth),
          status: 0,
          course_level: r.courseLevel,
          interested_program: r.interestedProgram,
          education_loan: r.educationLoan ? 1 : 0,
          apply_through_cp: r.applyThroughCp ? 1 : 0,
          org_id: input.orgId,
          cp_counsellor_id: input.cpCounsellorId ?? null,
        });
      });

      if (toCreate.length > 0) {
        await db.student.createMany({ data: toCreate });
      }

      return { created: toCreate.length, skipped };
    }),

  // Full profile for /admin/students/[id]: the list DTO plus rich application
  // and shortlist cards (course + university meta).
  adminGet: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const s = await db.student.findUnique({
        where: { id: input.id },
        include: studentInclude,
      });
      if (!s) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
      }
      const [applications, shortlists] = await Promise.all([
        db.application.findMany({
          where: { student_id: input.id },
          orderBy: { created_at: "asc" },
          select: {
            id: true,
            status: true,
            created_at: true,
            submitted_at: true,
            decided_at: true,
            university_app_id: true,
            counsellor_vendor: true,
            conditional_docs: true,
            deposit_deadline: true,
            deposit_amount: true,
            deposit_currency: true,
            stage_history: {
              orderBy: { stage: "asc" },
              select: { stage: true, occurred_at: true },
            },
            portal_credential: { select: { username: true } },
            course: { select: courseCardSelect },
          },
        }),
        db.shortlist.findMany({
          where: { student_id: input.id },
          orderBy: { created_at: "desc" },
          select: { id: true, created_at: true, course: { select: courseCardSelect } },
        }),
      ]);
      const [contacts, education, work, tests, notes, documents] =
        await Promise.all([
          db.student_emergency_contact.findMany({
            where: { student_id: input.id },
            orderBy: { id: "asc" },
          }),
          db.student_education.findMany({
            where: { student_id: input.id },
            orderBy: { level: "desc" },
          }),
          db.student_work_experience.findMany({
            where: { student_id: input.id },
            orderBy: [{ start_year: "desc" }, { start_month: "desc" }],
          }),
          db.student_test_score.findMany({
            where: { student_id: input.id },
            orderBy: [{ test: "asc" }, { attempt: "asc" }],
          }),
          db.student_note.findMany({
            where: { student_id: input.id },
            orderBy: { created_at: "desc" },
            include: {
              collegepond_user: {
                select: { first_name: true, last_name: true },
              },
            },
          }),
          db.document.findMany({
            where: { student_id: input.id },
            orderBy: { created_at: "desc" },
          }),
        ]);
      return {
        ...toApi(s),
        notes: notes.map((n) => ({
          id: n.id,
          body: n.body,
          isTask: n.is_task === 1,
          dueDate: n.due_date ? n.due_date.toISOString().slice(0, 10) : null,
          priority: n.priority,
          isDone: n.is_done === 1,
          createdAt: n.created_at.toISOString(),
          author: n.collegepond_user ? fullName(n.collegepond_user) : null,
        })),
        documents: documents.map((d) => ({
          id: d.id,
          docType: d.doc_type,
          fileName: d.file_name,
          fileUrl: resolveStorageUrl(d.file_url),
          mimeType: d.mime_type,
          sizeBytes: d.size_bytes,
          isMostRecent: d.is_most_recent === 1,
          createdAt: d.created_at.toISOString(),
        })),
        emergencyContacts: contacts.map((c) => ({
          id: c.id,
          relationship: c.relationship,
          name: c.name,
          email: c.email,
          phone: c.phone,
        })),
        educationRows: education.map((e) => ({
          level: e.level,
          country: e.country,
          board: e.board,
          state: e.state,
          qualification: e.qualification,
          institution: e.institution,
          city: e.city,
          gradingSystem: e.grading_system,
          scale: e.scale,
          score: e.score,
          language: e.language,
          passMonth: e.pass_month,
          passYear: e.pass_year,
          major: e.major,
          researchTopic: e.research_topic,
          predictedScore: e.predicted_score,
        })),
        workExperience: work.map((w) => ({
          id: w.id,
          company: w.company,
          jobTitle: w.job_title,
          employmentType: w.employment_type,
          industry: w.industry,
          startMonth: w.start_month,
          startYear: w.start_year,
          endMonth: w.end_month,
          endYear: w.end_year,
          currentlyWorking: w.currently_working === 1,
          city: w.city,
          country: w.country,
          description: w.description,
        })),
        testScores: tests.map((t) => ({
          test: t.test,
          attempt: t.attempt,
          scores: (t.scores ?? {}) as Record<string, number>,
          testDate: t.test_date ? t.test_date.toISOString().slice(0, 10) : null,
        })),
        applicationCards: applications.map((a) => ({
          id: a.id,
          status: a.status,
          stage: currentStage(a.status, a.stage_history),
          createdAt: a.created_at.toISOString(),
          submittedAt: a.submitted_at?.toISOString() ?? null,
          decidedAt: a.decided_at?.toISOString() ?? null,
          universityAppId: a.university_app_id,
          counsellorVendor: a.counsellor_vendor,
          conditionalDocs: Array.isArray(a.conditional_docs)
            ? (a.conditional_docs as string[])
            : [],
          depositDeadline: a.deposit_deadline
            ? a.deposit_deadline.toISOString().slice(0, 10)
            : null,
          depositAmount:
            a.deposit_amount === null ? null : a.deposit_amount.toNumber(),
          depositCurrency: a.deposit_currency,
          stageHistory: a.stage_history.map((h) => ({
            stage: h.stage,
            date: h.occurred_at.toISOString(),
          })),
          // Username only — the password never leaves the server unencrypted
          // except through the audited reveal mutation.
          portalCredentialUsername: a.portal_credential?.username ?? null,
          ...toCourseCard(a.course),
        })),
        shortlists: shortlists.map((r) => ({
          id: r.id,
          shortlistedAt: r.created_at.toISOString(),
          ...toCourseCard(r.course),
        })),
      };
    }),

  adminUpdate: protectedAdminProcedure
    .input(
      createFields.extend({
        id: z.number().int().positive(),
        gender: z
          .number()
          .int()
          .refine((v) => GENDER_CODES.includes(v as Gender), {
            message: "Invalid gender",
          })
          .nullable(),
        nationality: z
          .string()
          .trim()
          .length(2)
          .transform((v) => v.toUpperCase())
          .nullable(),
        middleName: z.string().trim().max(50).nullable(),
        maritalStatus: z
          .number()
          .int()
          .refine((v) => MARITAL_STATUS_CODES.includes(v as MaritalStatus), {
            message: "Invalid marital status",
          })
          .nullable(),
        mailingAddress1: z.string().trim().max(255).nullable(),
        mailingAddress2: z.string().trim().max(255).nullable(),
        mailingCity: z.string().trim().max(100).nullable(),
        mailingState: z.string().trim().max(100).nullable(),
        mailingCountry: z.string().trim().max(50).nullable(),
        mailingPostal: z.string().trim().max(20).nullable(),
        permanentSameAsMailing: z.boolean(),
        permanentAddress1: z.string().trim().max(255).nullable(),
        permanentAddress2: z.string().trim().max(255).nullable(),
        permanentCity: z.string().trim().max(100).nullable(),
        permanentState: z.string().trim().max(100).nullable(),
        permanentCountry: z.string().trim().max(50).nullable(),
        permanentPostal: z.string().trim().max(20).nullable(),
        dualCitizenship: z.boolean().nullable(),
        passportNumber: z.string().trim().max(20).nullable(),
        passportExpiry: dateStringSchema.nullable(),
        visaRefused: z.boolean().nullable(),
        visaRefusedDetails: z.string().trim().max(500).nullable(),
        criminalRecord: z.boolean().nullable(),
        criminalRecordDetails: z.string().trim().max(500).nullable(),
        medicalCondition: z.boolean().nullable(),
        medicalConditionDetails: z.string().trim().max(500).nullable(),
        emergencyContacts: z
          .array(
            z.object({
              relationship: z
                .number()
                .int()
                .refine(
                  (v) =>
                    EMERGENCY_RELATIONSHIP_CODES.includes(
                      v as EmergencyRelationship,
                    ),
                  { message: "Invalid relationship" },
                ),
              name: z.string().trim().min(1).max(100),
              email: z.string().trim().email().max(255).nullable(),
              phone: z.string().trim().max(45).nullable(),
            }),
          )
          .max(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db.student.findUnique({
        where: { id: input.id },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
      }
      const duplicate = await findDuplicate(
        input.email,
        input.countryCode,
        input.phone,
        {},
      );
      if (duplicate && duplicate.id !== input.id) {
        return { ok: false as const, duplicate };
      }
      // "Same as mailing" copies the values so the permanent address stays
      // meaningful if the flag is later unchecked (mock behaviour).
      const perm = input.permanentSameAsMailing
        ? {
            address1: input.mailingAddress1,
            address2: input.mailingAddress2,
            city: input.mailingCity,
            state: input.mailingState,
            country: input.mailingCountry,
            postal: input.mailingPostal,
          }
        : {
            address1: input.permanentAddress1,
            address2: input.permanentAddress2,
            city: input.permanentCity,
            state: input.permanentState,
            country: input.permanentCountry,
            postal: input.permanentPostal,
          };
      const updated = await db.student.update({
        where: { id: input.id },
        data: {
          first_name: input.firstName,
          last_name: input.lastName,
          email: input.email.toLowerCase(),
          phone: normalizePhone(input.countryCode, input.phone),
          date_of_birth: new Date(input.dateOfBirth),
          gender: input.gender,
          nationality: input.nationality,
          country: input.country,
          intake: input.intake,
          course_level: input.courseLevel,
          interested_program: input.interestedProgram,
          education_loan: input.educationLoan ? 1 : 0,
          apply_through_cp: input.applyThroughCp ? 1 : 0,
          middle_name: input.middleName,
          marital_status: input.maritalStatus,
          mailing_address1: input.mailingAddress1,
          mailing_address2: input.mailingAddress2,
          mailing_city: input.mailingCity,
          mailing_state: input.mailingState,
          mailing_country: input.mailingCountry,
          mailing_postal: input.mailingPostal,
          permanent_same_as_mailing: input.permanentSameAsMailing ? 1 : 0,
          permanent_address1: perm.address1,
          permanent_address2: perm.address2,
          permanent_city: perm.city,
          permanent_state: perm.state,
          permanent_country: perm.country,
          permanent_postal: perm.postal,
          dual_citizenship: boolToInt(input.dualCitizenship),
          passport_number: input.passportNumber,
          passport_expiry: input.passportExpiry
            ? new Date(input.passportExpiry)
            : null,
          visa_refused: boolToInt(input.visaRefused),
          visa_refused_details: input.visaRefused
            ? input.visaRefusedDetails
            : null,
          criminal_record: boolToInt(input.criminalRecord),
          criminal_record_details: input.criminalRecord
            ? input.criminalRecordDetails
            : null,
          medical_condition: boolToInt(input.medicalCondition),
          medical_condition_details: input.medicalCondition
            ? input.medicalConditionDetails
            : null,
        },
        include: studentInclude,
      });
      await db.student_emergency_contact.deleteMany({
        where: { student_id: input.id },
      });
      if (input.emergencyContacts.length > 0) {
        await db.student_emergency_contact.createMany({
          data: input.emergencyContacts.map((c) => ({
            student_id: input.id,
            relationship: c.relationship,
            name: c.name,
            email: c.email,
            phone: c.phone,
          })),
        });
      }
      await db.audit_log.create({
        data: {
          action: "student.profile_updated",
          entity_type: "student",
          entity_id: input.id,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true as const, student: toApi(updated) };
    }),

  // Academic Qualification sub-tab: replace-all per student (the form is
  // the full state — one entry per education level).
  saveEducation: protectedAdminProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        highestLevel: educationLevelSchema.nullable(),
        entries: z
          .array(
            z.object({
              level: educationLevelSchema,
              country: z.string().trim().max(50).nullable(),
              board: z.string().trim().max(100).nullable(),
              state: z.string().trim().max(50).nullable(),
              qualification: z.string().trim().max(100).nullable(),
              institution: z.string().trim().max(150).nullable(),
              city: z.string().trim().max(100).nullable(),
              gradingSystem: z.string().trim().max(20).nullable(),
              scale: z.string().trim().max(50).nullable(),
              score: z.string().trim().max(20).nullable(),
              language: z.string().trim().max(30).nullable(),
              passMonth: z.number().int().min(1).max(12).nullable(),
              passYear: z.number().int().min(1950).max(2100).nullable(),
              major: z.string().trim().max(100).nullable(),
              researchTopic: z.string().trim().max(255).nullable(),
              predictedScore: z.string().trim().max(20).nullable(),
            }),
          )
          .max(5),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStudent(input.studentId);
      await db.student.update({
        where: { id: input.studentId },
        data: { highest_education_level: input.highestLevel },
      });
      await db.student_education.deleteMany({
        where: { student_id: input.studentId },
      });
      if (input.entries.length > 0) {
        await db.student_education.createMany({
          data: input.entries.map((e) => ({
            student_id: input.studentId,
            level: e.level,
            country: e.country,
            board: e.board,
            state: e.state,
            qualification: e.qualification,
            institution: e.institution,
            city: e.city,
            grading_system: e.gradingSystem,
            scale: e.scale,
            score: e.score,
            language: e.language,
            pass_month: e.passMonth,
            pass_year: e.passYear,
            major: e.major,
            research_topic: e.researchTopic,
            predicted_score: e.predictedScore,
          })),
        });
      }
      await db.audit_log.create({
        data: {
          action: "student.academics_updated",
          entity_type: "student",
          entity_id: input.studentId,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),

  saveWorkExperience: protectedAdminProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        entries: z
          .array(
            z.object({
              company: z.string().trim().min(1).max(150),
              jobTitle: z.string().trim().max(100).nullable(),
              employmentType: z.string().trim().max(20).nullable(),
              industry: z.string().trim().max(50).nullable(),
              startMonth: z.number().int().min(1).max(12),
              startYear: z.number().int().min(1950).max(2100),
              endMonth: z.number().int().min(1).max(12).nullable(),
              endYear: z.number().int().min(1950).max(2100).nullable(),
              currentlyWorking: z.boolean(),
              city: z.string().trim().max(100).nullable(),
              country: z.string().trim().max(50).nullable(),
              description: z.string().trim().max(1000).nullable(),
            }),
          )
          .max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStudent(input.studentId);
      await db.student_work_experience.deleteMany({
        where: { student_id: input.studentId },
      });
      if (input.entries.length > 0) {
        await db.student_work_experience.createMany({
          data: input.entries.map((w) => ({
            student_id: input.studentId,
            company: w.company,
            job_title: w.jobTitle,
            employment_type: w.employmentType,
            industry: w.industry,
            start_month: w.startMonth,
            start_year: w.startYear,
            end_month: w.currentlyWorking ? null : w.endMonth,
            end_year: w.currentlyWorking ? null : w.endYear,
            currently_working: w.currentlyWorking ? 1 : 0,
            city: w.city,
            country: w.country,
            description: w.description,
          })),
        });
      }
      await db.audit_log.create({
        data: {
          action: "student.work_experience_updated",
          entity_type: "student",
          entity_id: input.studentId,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),

  saveTestScores: protectedAdminProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        entries: z
          .array(
            z.object({
              test: z.string().trim().min(1).max(20),
              attempt: z.number().int().min(1).max(10),
              scores: z.record(z.string(), z.number()),
              testDate: dateStringSchema.nullable(),
            }),
          )
          .max(40),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStudent(input.studentId);
      await db.student_test_score.deleteMany({
        where: { student_id: input.studentId },
      });
      if (input.entries.length > 0) {
        await db.student_test_score.createMany({
          data: input.entries.map((t) => ({
            student_id: input.studentId,
            test: t.test,
            attempt: t.attempt,
            scores: t.scores,
            test_date: t.testDate ? new Date(t.testDate) : null,
          })),
        });
      }
      await db.audit_log.create({
        data: {
          action: "student.tests_updated",
          entity_type: "student",
          entity_id: input.studentId,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),

  // ---- Tasks & Notes --------------------------------------------------------

  addNote: protectedAdminProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        body: z.string().trim().min(1).max(1000),
        isTask: z.boolean(),
        dueDate: dateStringSchema.nullable(),
        priority: notePrioritySchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStudent(input.studentId);
      const note = await db.student_note.create({
        data: {
          student_id: input.studentId,
          body: input.body,
          is_task: input.isTask ? 1 : 0,
          due_date:
            input.isTask && input.dueDate ? new Date(input.dueDate) : null,
          priority: input.isTask ? input.priority : null,
          collegepond_user_id: ctx.cpUser.id,
        },
      });
      return { id: note.id };
    }),

  updateNote: protectedAdminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        body: z.string().trim().min(1).max(1000).optional(),
        isTask: z.boolean().optional(),
        dueDate: dateStringSchema.nullable().optional(),
        priority: notePrioritySchema.nullable().optional(),
        isDone: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const note = await db.student_note.findUnique({
        where: { id: input.id },
        select: { id: true },
      });
      if (!note) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found" });
      }
      await db.student_note.update({
        where: { id: input.id },
        data: {
          body: input.body,
          is_task: input.isTask === undefined ? undefined : input.isTask ? 1 : 0,
          due_date:
            input.dueDate === undefined
              ? undefined
              : input.dueDate
                ? new Date(input.dueDate)
                : null,
          priority: input.priority,
          is_done: input.isDone === undefined ? undefined : input.isDone ? 1 : 0,
        },
      });
      return { ok: true };
    }),

  deleteNote: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.student_note.deleteMany({ where: { id: input.id } });
      return { ok: true };
    }),

  // ---- Documents -------------------------------------------------------------

  // Uploads go through /api/admin/student-doc (multipart); this removes the
  // DB row (the file stays on disk — no orphan-cleanup story yet).
  deleteDocument: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const doc = await db.document.findUnique({
        where: { id: input.id },
        select: { id: true, student_id: true, doc_type: true },
      });
      if (!doc?.student_id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
      }
      await db.document.delete({ where: { id: doc.id } });
      await db.audit_log.create({
        data: {
          action: "student.document_removed",
          entity_type: "student",
          entity_id: doc.student_id,
          metadata: { docType: doc.doc_type, byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),

  // ---- Shortlists (Uni Assist) ---------------------------------------------

  // Flat (studentId, courseId) pairs for the Uni Assist page's button state.
  shortlistsForStudents: protectedAdminProcedure
    .input(
      z.object({
        studentIds: z.array(z.number().int().positive()).max(200),
      }),
    )
    .query(async ({ input }) => {
      if (input.studentIds.length === 0) return [];
      const rows = await db.shortlist.findMany({
        where: { student_id: { in: input.studentIds } },
        select: { student_id: true, course_id: true },
      });
      return rows.map((r) => ({
        studentId: r.student_id,
        courseId: r.course_id,
      }));
    }),

  addShortlist: protectedAdminProcedure
    .input(
      z.object({
        studentIds: z.array(z.number().int().positive()).min(1).max(50),
        courseId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const course = await db.course.findUnique({
        where: { id: input.courseId },
        select: { id: true },
      });
      if (!course) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      }
      const result = await db.shortlist.createMany({
        data: input.studentIds.map((student_id) => ({
          student_id,
          course_id: input.courseId,
          collegepond_user_id: ctx.cpUser.id,
        })),
        skipDuplicates: true,
      });
      // Shortlisting moves fresh leads to the Shortlisted stage (mock
      // behaviour). Deliberate flags (No Interest / No Response) stay put.
      await db.student.updateMany({
        where: {
          id: { in: input.studentIds },
          status: {
            in: [
              StudentStatus.NEW,
              StudentStatus.INTERESTED,
              StudentStatus.CONNECTED,
            ],
          },
        },
        data: { status: StudentStatus.SHORTLISTED },
      });
      await db.audit_log.createMany({
        data: input.studentIds.map((id) => ({
          action: "student.shortlisted",
          entity_type: "student",
          entity_id: id,
          metadata: { courseId: input.courseId, byCpUserId: ctx.cpUser.id },
        })),
      });
      return { added: result.count };
    }),

  removeShortlist: protectedAdminProcedure
    .input(
      z.object({
        studentIds: z.array(z.number().int().positive()).min(1).max(50),
        courseId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await db.shortlist.deleteMany({
        where: {
          student_id: { in: input.studentIds },
          course_id: input.courseId,
        },
      });
      await db.audit_log.createMany({
        data: input.studentIds.map((id) => ({
          action: "student.shortlist_removed",
          entity_type: "student",
          entity_id: id,
          metadata: { courseId: input.courseId, byCpUserId: ctx.cpUser.id },
        })),
      });
      return { removed: result.count };
    }),

  // "Apply" on a shortlisted card: creates the application (Begin
  // Application) and consumes the shortlist row.
  applyShortlist: protectedAdminProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        courseId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const student = await db.student.findUnique({
        where: { id: input.studentId },
        select: { id: true, org_id: true, status: true },
      });
      if (!student) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
      }
      // application.org_id is NOT NULL — independent-counsellor students
      // can't carry applications until that linkage is modelled.
      if (student.org_id === null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This student has no partner organization, so an application can't be created yet.",
        });
      }
      const consumeShortlist = () =>
        db.shortlist.deleteMany({
          where: { student_id: input.studentId, course_id: input.courseId },
        });

      const existing = await db.application.findFirst({
        where: { student_id: input.studentId, course_id: input.courseId },
        select: { id: true },
      });
      if (existing) {
        await consumeShortlist();
        return { applicationId: existing.id, created: false };
      }

      const app = await db.application.create({
        data: {
          student_id: input.studentId,
          course_id: input.courseId,
          org_id: student.org_id,
          status: UniApplicationStatus.BEGIN_APPLICATION,
          stage_history: {
            create: { stage: UniApplicationStatus.BEGIN_APPLICATION },
          },
        },
      });
      await consumeShortlist();
      if (student.status < StudentStatus.BEGIN_APPLICATION) {
        await db.student.update({
          where: { id: student.id },
          data: { status: StudentStatus.BEGIN_APPLICATION },
        });
      }
      await db.audit_log.create({
        data: {
          action: "student.application_created",
          entity_type: "student",
          entity_id: input.studentId,
          metadata: {
            applicationId: app.id,
            courseId: input.courseId,
            byCpUserId: ctx.cpUser.id,
          },
        },
      });
      return { applicationId: app.id, created: true };
    }),

  // ---- Application pipeline (profile page) ---------------------------------

  // Advance / revert / mark-terminal from the pipeline stepper dropdowns.
  // Maintains stage history (dates + position), submitted/decided
  // timestamps, and mirrors the student's pipeline status.
  setApplicationStatus: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        status: z
          .number()
          .int()
          .refine(
            (v) => UNI_APP_STATUS_CODES.includes(v as UniApplicationStatus),
            { message: "Invalid application status" },
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const app = await db.application.findUnique({
        where: { id: input.applicationId },
        select: {
          id: true,
          status: true,
          student_id: true,
          submitted_at: true,
          decided_at: true,
          stage_history: { select: { stage: true } },
        },
      });
      if (!app) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Application not found",
        });
      }
      const target = input.status;
      const stageBefore = currentStage(app.status, app.stage_history);
      const upsertStage = (stage: number, bumpDate: boolean) =>
        db.application_stage_history.upsert({
          where: {
            application_id_stage: {
              application_id: app.id,
              stage,
            },
          },
          create: { application_id: app.id, stage },
          update: bumpDate ? { occurred_at: new Date() } : {},
        });

      if (target <= UniApplicationStatus.ENROLLED) {
        if (target < stageBefore) {
          // Revert: drop history above the target (undo an accidental
          // advance), keep the target entry's original date.
          await db.application_stage_history.deleteMany({
            where: { application_id: app.id, stage: { gt: target } },
          });
          await upsertStage(target, false);
        } else {
          // Advance (or re-confirm the current stage / clear a terminal).
          await upsertStage(target, target > stageBefore);
        }
      } else {
        // Terminal outcome — make sure the stage position survives.
        await upsertStage(stageBefore, false);
      }

      const offerOrRejection =
        target === UniApplicationStatus.CONDITIONAL_OFFER ||
        target === UniApplicationStatus.UNCONDITIONAL_OFFER ||
        target === UniApplicationStatus.REJECTED_BY_UNIVERSITY;
      await db.application.update({
        where: { id: app.id },
        data: {
          status: target,
          submitted_at:
            target >= UniApplicationStatus.APPLICATION_SUBMITTED
              ? (app.submitted_at ?? new Date())
              : null,
          decided_at: offerOrRejection
            ? (app.decided_at ?? new Date())
            : target < UniApplicationStatus.CONDITIONAL_OFFER
              ? null
              : app.decided_at,
        },
      });
      await syncStudentStatusFromApplications(app.student_id);

      // Tell the partner — but not for a revert (an admin undoing a mistake)
      // or a no-op re-save. Fire-and-forget: the status change is saved.
      const isRevert = target <= UniApplicationStatus.ENROLLED && target < stageBefore;
      if (target !== app.status && !isRevert) {
        void notifyApplicationStatus(app.id, target);
      }

      await db.audit_log.create({
        data: {
          action: "application.status_updated",
          entity_type: "application",
          entity_id: app.id,
          metadata: {
            from: app.status,
            to: target,
            studentId: app.student_id,
            byCpUserId: ctx.cpUser.id,
          },
        },
      });
      return { status: target };
    }),

  setApplicationUniId: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        universityAppId: z.string().trim().max(100).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db.application.update({
        where: { id: input.applicationId },
        data: { university_app_id: input.universityAppId },
      });
      await db.audit_log.create({
        data: {
          action: "application.uni_id_saved",
          entity_type: "application",
          entity_id: input.applicationId,
          metadata: {
            universityAppId: input.universityAppId,
            byCpUserId: ctx.cpUser.id,
          },
        },
      });
      return { ok: true };
    }),

  setApplicationVendor: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        vendor: z.string().trim().max(100).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db.application.update({
        where: { id: input.applicationId },
        data: { counsellor_vendor: input.vendor },
      });
      await db.audit_log.create({
        data: {
          action: "application.vendor_selected",
          entity_type: "application",
          entity_id: input.applicationId,
          metadata: { vendor: input.vendor, byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),

  setConditionalDocs: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        docs: z.array(z.string().trim().min(1).max(120)).max(20),
      }),
    )
    .mutation(async ({ input }) => {
      await db.application.update({
        where: { id: input.applicationId },
        data: { conditional_docs: input.docs },
      });
      return { ok: true };
    }),

  setDepositDetails: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        deadline: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date")
          .nullable(),
        currency: z.string().trim().length(3).nullable(),
        amount: z.number().nonnegative().max(99_999_999).nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await db.application.update({
        where: { id: input.applicationId },
        data: {
          deposit_deadline: input.deadline ? new Date(input.deadline) : null,
          deposit_currency: input.currency,
          deposit_amount: input.amount,
        },
      });
      return { ok: true };
    }),

  // ---- Portal credentials ----------------------------------------------------

  savePortalCredential: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        username: z.string().trim().min(1).max(255),
        password: z.string().min(1).max(255),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const app = await db.application.findUnique({
        where: { id: input.applicationId },
        select: { id: true, student_id: true },
      });
      if (!app) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Application not found",
        });
      }
      const password_enc = encryptSecret(input.password);
      await db.application_portal_credential.upsert({
        where: { application_id: app.id },
        create: { application_id: app.id, username: input.username, password_enc },
        update: { username: input.username, password_enc },
      });
      await db.audit_log.create({
        data: {
          action: "application.credential_saved",
          entity_type: "application",
          entity_id: app.id,
          metadata: { studentId: app.student_id, byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true };
    }),

  // Decrypts on demand; every reveal is audit-logged so credential access
  // stays traceable.
  revealPortalCredential: protectedAdminProcedure
    .input(z.object({ applicationId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const cred = await db.application_portal_credential.findUnique({
        where: { application_id: input.applicationId },
      });
      if (!cred) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No credentials saved for this application",
        });
      }
      await db.audit_log.create({
        data: {
          action: "application.credential_viewed",
          entity_type: "application",
          entity_id: input.applicationId,
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { username: cred.username, password: decryptSecret(cred.password_enc) };
    }),

  removeApplication: protectedAdminProcedure
    .input(z.object({ applicationId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const app = await db.application.findUnique({
        where: { id: input.applicationId },
        select: { id: true, student_id: true, course_id: true },
      });
      if (!app) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Application not found",
        });
      }
      try {
        await db.application.delete({ where: { id: app.id } });
      } catch {
        // Commission/invoice rows block the cascade.
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This application has commission or invoice records and can't be removed.",
        });
      }
      await syncStudentStatusFromApplications(app.student_id);
      await db.audit_log.create({
        data: {
          action: "application.removed",
          entity_type: "application",
          entity_id: app.id,
          metadata: {
            studentId: app.student_id,
            courseId: app.course_id,
            byCpUserId: ctx.cpUser.id,
          },
        },
      });
      return { ok: true };
    }),

  bulkUpdateStatus: protectedAdminProcedure
    .input(
      z.object({
        ids: z.array(z.number().int().positive()).min(1).max(200),
        status: studentStatusSchema,
        note: z.string().trim().max(500).optional(),
        effectiveDate: z.string().trim().max(10).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await db.student.updateMany({
        where: { id: { in: input.ids } },
        data: { status: input.status },
      });
      // audit_log.user_id references partner users, not staff — the actor
      // goes in metadata instead.
      await db.audit_log.createMany({
        data: input.ids.map((id) => ({
          action: "student.status_updated",
          entity_type: "student",
          entity_id: id,
          metadata: {
            status: input.status,
            note: input.note ?? null,
            effectiveDate: input.effectiveDate ?? null,
            byCpUserId: ctx.cpUser.id,
          },
        })),
      });
      return { updated: result.count };
    }),

  assignCpCounsellor: protectedAdminProcedure
    .input(
      z.object({
        ids: z.array(z.number().int().positive()).min(1).max(200),
        cpCounsellorId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const counsellor = await db.collegepond_user.findUnique({
        where: { id: input.cpCounsellorId },
        select: { id: true, first_name: true, last_name: true, status: true },
      });
      if (counsellor?.status !== 1) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Counsellor not found" });
      }
      const result = await db.student.updateMany({
        where: { id: { in: input.ids } },
        data: { cp_counsellor_id: input.cpCounsellorId },
      });
      await db.audit_log.createMany({
        data: input.ids.map((id) => ({
          action: "student.cp_counsellor_assigned",
          entity_type: "student",
          entity_id: id,
          metadata: {
            cpCounsellorId: input.cpCounsellorId,
            byCpUserId: ctx.cpUser.id,
          },
        })),
      });
      return { updated: result.count, counsellorName: fullName(counsellor) };
    }),

  // ---- Partner (org-scoped) ------------------------------------------------

  partnerList: protectedPartnerProcedure.query(async ({ ctx }) => {
    const { where } = await partnerScope(ctx.cpPartner.id);
    const rows = await db.student.findMany({
      where,
      orderBy: { updated_at: "desc" },
      take: LIST_CAP,
      include: studentInclude,
    });
    // Partners don't see CP-internal assignment details.
    return rows.map(toPartnerApi);
  }),

  partnerCreate: protectedPartnerProcedure
    .input(createFields)
    .mutation(async ({ ctx, input }) => {
      const { user, where } = await partnerScope(ctx.cpPartner.id);
      const duplicate = await findDuplicate(
        input.email,
        input.countryCode,
        input.phone,
        // Collision check within the org (or own students for independents).
        user.org_id === null ? { created_by_user_id: user.id } : { org_id: user.org_id },
      );
      if (duplicate) return { ok: false as const, duplicate };
      void where;

      try {
        const created = await db.student.create({
          data: {
            first_name: input.firstName,
            last_name: input.lastName,
            email: input.email.toLowerCase(),
            phone: normalizePhone(input.countryCode, input.phone),
            country: input.country,
            intake: input.intake,
            date_of_birth: new Date(input.dateOfBirth),
            status: 0,
            course_level: input.courseLevel,
            interested_program: input.interestedProgram,
            education_loan: input.educationLoan ? 1 : 0,
            apply_through_cp: input.applyThroughCp ? 1 : 0,
            org_id: user.org_id,
            created_by_user_id: user.id,
            counsellor_id:
              user.type === UserType.AGENCY_COUNSELLOR ? user.id : null,
          },
          include: studentInclude,
        });
        return { ok: true as const, student: toPartnerApi(created) };
      } catch (e) {
        // student.email is globally UNIQUE, but findDuplicate above is
        // org-scoped — a collision with a student in another org slips through
        // and surfaces as a Prisma P2002. Return a neutral conflict instead of
        // a 500, and don't leak the other org's record.
        if (
          e &&
          typeof e === "object" &&
          "code" in e &&
          (e as { code?: string }).code === "P2002"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A student with this email address already exists.",
          });
        }
        throw e;
      }
    }),

  // A student's documents, for anyone who can see the student (owner, the
  // assigned counsellor, the independent who created them). Uploads go
  // through /api/partner/student-doc with the same check.
  partnerDocuments: protectedPartnerProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      const docs = await db.document.findMany({
        where: { student_id: input.studentId },
        orderBy: { created_at: "desc" },
      });
      return docs.map((d) => ({
        id: d.id,
        docType: d.doc_type,
        fileName: d.file_name,
        fileUrl: resolveStorageUrl(d.file_url),
        sizeBytes: d.size_bytes,
        isMostRecent: d.is_most_recent === 1,
        createdAt: d.created_at.toISOString(),
      }));
    }),

  // Who the owner can route students to, with how many each holds now, so the
  // Assign dialog can show the workload: the owner ("Me"), every active
  // counsellor, and how many are still unassigned.
  partnerAssignees: agencyOwnerProcedure.query(async ({ ctx }) => {
    const [owner, counsellors, counts] = await Promise.all([
      db.user.findUnique({
        where: { id: ctx.owner.id },
        select: { first_name: true, last_name: true },
      }),
      db.user.findMany({
        where: {
          type: UserType.AGENCY_COUNSELLOR,
          org_id: ctx.owner.orgId,
          status: UserStatus.APPROVED,
          deleted_at: null,
        },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
        select: { id: true, first_name: true, last_name: true },
      }),
      db.student.groupBy({
        by: ["counsellor_id"],
        where: { org_id: ctx.owner.orgId },
        _count: { _all: true },
      }),
    ]);
    const count = new Map(counts.map((c) => [c.counsellor_id, c._count._all]));
    return {
      owner: {
        id: ctx.owner.id,
        name: owner ? fullName(owner) : "Me",
        studentCount: count.get(ctx.owner.id) ?? 0,
      },
      counsellors: counsellors.map((c) => ({
        id: c.id,
        name: fullName(c),
        studentCount: count.get(c.id) ?? 0,
      })),
      unassigned: count.get(null) ?? 0,
    };
  }),

  // Route students to one of the owner's own counsellors, or to the owner
  // themselves (counsellorId null → stored as the owner's id, shown as "You";
  // a student with no one at all is "Unassigned"). Only students of the
  // owner's org, only active counsellors of the same org; anything else is
  // refused as not found. Counsellors can't call this (agencyOwnerProcedure).
  partnerAssignCounsellor: agencyOwnerProcedure
    .input(
      z.object({
        studentIds: z.array(z.number().int().positive()).min(1).max(500),
        counsellorId: z.number().int().positive().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.studentIds)];
      const students = await db.student.findMany({
        where: { id: { in: ids }, org_id: ctx.owner.orgId },
        select: { id: true, counsellor_id: true },
      });
      if (students.length !== ids.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
      }
      const counsellor =
        input.counsellorId === null || input.counsellorId === ctx.owner.id
          ? null
          : await requireOrgCounsellor(ctx.owner.orgId, input.counsellorId, { assignable: true });
      const target = counsellor?.id ?? ctx.owner.id;

      const changed = students.filter((s) => s.counsellor_id !== target);
      if (changed.length > 0) {
        await db.student.updateMany({
          where: { id: { in: changed.map((s) => s.id) }, org_id: ctx.owner.orgId },
          data: { counsellor_id: target },
        });
        await db.audit_log.createMany({
          data: changed.map((s) => ({
            action: "student.counsellor_assigned",
            entity_type: "student",
            entity_id: s.id,
            metadata: { byPartnerUserId: ctx.owner.id, from: s.counsellor_id, to: target },
          })),
        });
        if (counsellor) {
          // Fire-and-forget: the assignment is saved whatever happens here.
          void notifyStudentsAssigned({
            ownerId: ctx.owner.id,
            counsellor,
            studentIds: changed.map((s) => s.id),
          });
        }
      }
      return {
        updated: changed.length,
        counsellorName: counsellor ? fullName(counsellor) : null,
      };
    }),
});
