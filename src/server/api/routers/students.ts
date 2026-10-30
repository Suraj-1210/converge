import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  agencyOwnerProcedure,
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { notifyStudentsAssigned } from "~/server/student-assignment";
import {
  notifyColleagueApplicationAction,
  notifyColleagueCourseAction,
  notifyCounsellorAssignment,
} from "~/server/counsellor-notify";
import {
  hasPartnerSide,
  notifyCollegepondOfDecision,
  notifyCollegepondOfProposal,
  notifyPartnerOfDecision,
  notifyPartnerOfProposal,
} from "~/server/shortlist-approval";
import {
  academicsSnapshot,
  diffSnapshots,
  pendingPartnerUpdates,
  profileSnapshot,
  recordPartnerChange,
  testsSnapshot,
  workSnapshot,
  type ChangeSection,
  type Snapshot,
} from "~/server/student-changes";
import {
  findVisibleStudent,
  partnerScope,
  requireOrgCounsellor,
  requireVisibleStudent,
} from "~/server/partner-access";
import {
  autoAssignStudents,
  bdmOrgScope,
  bdmUserScope,
  canSeeStudent,
  isCounsellingRole,
  requireAssignableCounsellor,
  requireStaffApplication,
  requireStaffNote,
  requireStaffStudent,
  requireStaffOrg,
  requireStaffPartnerUser,
  requireStaffStudents,
  staffStudentScope,
  type StaffUser,
} from "~/server/staff-access";
import { decryptSecret, encryptSecret } from "~/server/crypto";
import {
  contractForVendor,
  defaultVendorFor,
} from "~/server/universities/default-vendor";
import { db } from "~/server/db";
import { resolveStorageUrl } from "~/server/storage";
import {
  syncStudentStatusFromApplications,
  transitionApplication,
} from "~/server/application-transitions";
import { parsePendingDocs } from "~/server/pending-docs";
import { intakeLabel as deferralIntakeLabel } from "~/server/application-deferral";
import { currentStage } from "~/lib/application-stages";
import { leadPipelineStep, overallStudentStatus } from "~/lib/student-pipeline";
import { partnerLabel, partnerName } from "~/lib/partner-display";

// M6: defensive cap on unbounded list queries until cursor pagination lands.
const LIST_CAP = 500;

const isMultiDocType = (key: string) => STUDENT_DOC_TYPES.find((d) => d.key === key)?.multiple ?? true;
import {
  AdminRole,
  COURSE_LEVEL_CODES,
  DocumentStatus,
  EDUCATION_LEVEL_CODES,
  EMERGENCY_RELATIONSHIP_CODES,
  GENDER_CODES,
  MARITAL_STATUS_CODES,
  NOTE_PRIORITY_CODES,
  STUDENT_DOC_TYPES,
  STUDENT_STATUS_CODES,
  ShortlistApproval,
  ShortlistSource,
  StudentStatus,
  PartnerReportStatus,
  UNI_APP_STATUS_CODES,
  UniApplicationStatus,
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

const studentInclude = {
  organization: {
    select: {
      id: true,
      name: true,
      type: true,
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
  // An independent counsellor's student has no org: they're its partner.
  created_by: { select: { first_name: true, last_name: true } },
  cp_counsellor: { select: { id: true, first_name: true, last_name: true } },
  application: {
    select: {
      id: true,
      status: true,
      stage_history: { select: { stage: true } },
      counsellor_vendor: true,
      course: {
        select: {
          id: true,
          name: true,
          university: { select: { id: true, name: true } },
        },
      },
    },
  },
  // Overall status (document checklist) and the partner lead pipeline.
  document: { where: { is_most_recent: 1 }, select: { doc_type: true } },
  _count: { select: { shortlist: true } },
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
  const pipelineApps = s.application.map((a) => ({
    status: a.status,
    stage: currentStage(a.status, a.stage_history),
  }));
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
    // The org's name, or the independent counsellor's (partner filters).
    orgName: partnerName(s.organization, s.created_by),
    // "EduBridge · Agency" / "Aishwarya Rai" (~/lib/partner-display).
    partnerLabel: partnerLabel(s.organization, s.created_by),
    counsellorId: s.counsellor_id,
    counsellorName: s.user ? fullName(s.user) : null,
    cpCounsellorId: s.cp_counsellor_id,
    cpCounsellorName: s.cp_counsellor ? fullName(s.cp_counsellor) : null,
    // Auto-assign picked the counsellor (cleared by any manual assignment).
    cpAutoAssigned: s.cp_counsellor_id !== null && s.cp_auto_assigned_at !== null,
    bdmName: bdm ? fullName(bdm) : null,
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
    applications: s.application.map((a) => ({
      id: a.id,
      status: a.status,
      stage: currentStage(a.status, a.stage_history),
      program: a.course.name,
      university: a.course.university.name,
      // Counsellor's vendor pick (admin Students list). Collegepond-internal:
      // hideVendor() blanks it on every partner payload.
      counsellorVendor: a.counsellor_vendor,
    })),
    // Overall student status (Students tab) and the partner lead pipeline
    // step: src/lib/student-pipeline.ts.
    overallStatus: overallStudentStatus({
      inactiveAt: s.inactive_at,
      apps: pipelineApps,
      docTypes: s.document.map((d) => d.doc_type),
    }),
    inactive: s.inactive_at
      ? { at: s.inactive_at.toISOString(), reason: s.inactive_reason, note: s.inactive_note }
      : null,
    leadStep: leadPipelineStep({
      status: s.status,
      hasShortlist: s._count.shortlist > 0,
      apps: pipelineApps,
    }),
  };
}

// The application vendor never reaches the partner portal.
function hideVendor<T extends { counsellorVendor: string | null }>(apps: T[]): T[] {
  return apps.map((a) => ({ ...a, counsellorVendor: null }));
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
  app_fee: true,
  has_app_fee_waiver: true,
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
  app_fee: { toNumber: () => number } | null;
  has_app_fee_waiver: number | null;
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
    // Application fee in the course currency (null = not recorded).
    appFee: c.app_fee === null ? null : c.app_fee.toNumber(),
    hasAppFeeWaiver: c.has_app_fee_waiver === 1,
    university: c.university.name,
    universityCity: c.university.city,
    universityCountry: c.university.country,
    universityLogoUrl: resolveStorageUrl(c.university.logo_url),
    universityAppSource: c.university.app_source,
  };
}

// Shortlisting moves fresh leads to the Shortlisted stage (mock behaviour).
// Deliberate flags (No Interest / No Response) stay put. Shared by the admin
// and partner shortlist actions.
async function markStudentsShortlisted(studentIds: number[]) {
  await db.student.updateMany({
    where: {
      id: { in: studentIds },
      status: {
        in: [StudentStatus.NEW, StudentStatus.INTERESTED, StudentStatus.CONNECTED],
      },
    },
    data: { status: StudentStatus.SHORTLISTED },
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

// The Collegepond counsellor a staff-created student starts with. A
// hand-picked one must be within the creator's reach; a Counsellor's own new
// students default to them. null = let auto-assign route it.
async function initialCpCounsellor(user: StaffUser, picked: number | null | undefined) {
  if (picked) return (await requireAssignableCounsellor(user, picked)).id;
  return user.role === AdminRole.COUNSELLOR ? user.id : null;
}

// After auto-assign: a counselling user must not create students they then
// can't see, so anything still outside their scope is assigned to them.
async function keepVisibleToCreator(user: StaffUser, ids: number[]) {
  if (!isCounsellingRole(user.role) || ids.length === 0) return;
  const scope = await staffStudentScope(user);
  const visible = await db.student.findMany({
    where: { AND: [{ id: { in: ids } }, scope] },
    select: { id: true },
  });
  const seen = new Set(visible.map((v) => v.id));
  const hidden = ids.filter((id) => !seen.has(id));
  if (hidden.length) {
    await db.student.updateMany({
      where: { id: { in: hidden }, cp_counsellor_id: null },
      data: { cp_counsellor_id: user.id },
    });
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
  // No longer asked on any form (Day 5 testing); new students default to 1
  // and a profile save leaves the stored answer alone.
  applyThroughCp: z.boolean().optional(),
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
// `excludeId`: the student being edited, who can't clash with themselves
// (otherwise their own phone matches first and hides a real email clash).
async function findDuplicate(
  email: string,
  countryCode: string,
  phone: string,
  where: Record<string, unknown>,
  excludeId?: number,
) {
  // phone is NOT NULL, so every student is a phone-match candidate; we scan the
  // whole in-scope set and match by email or phone-digits in JS below.
  const candidates = await db.student.findMany({
    where: excludeId ? { AND: [where, { id: { not: excludeId } }] } : where,
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      organization: { select: { name: true, type: true } },
      created_by: { select: { first_name: true, last_name: true } },
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
    orgName: partnerLabel(match.organization, match.created_by),
    matchedOn:
      match.email?.toLowerCase() === email.toLowerCase()
        ? ("email" as const)
        : ("phone" as const),
  };
}

// A BDM checking for duplicates learns only that the student exists under
// another partner, never who it is (BDM segregation, staff-access.ts).
async function staffDuplicate(
  user: StaffUser,
  dup: Awaited<ReturnType<typeof findDuplicate>>,
) {
  if (!dup || user.role !== AdminRole.BDM || (await canSeeStudent(user, dup.id))) return dup;
  return { ...dup, id: 0, name: "Another partner's student", email: "—", phone: "—", orgName: "—" };
}

// Partner-facing DTO: same as toApi minus CP-internal assignment fields.
function toPartnerApi(s: DbStudent) {
  const { cpCounsellorId, cpCounsellorName, cpAutoAssigned, bdmName, ...rest } = toApi(s);
  void cpCounsellorId;
  void cpCounsellorName;
  void cpAutoAssigned;
  void bdmName;
  // The partner sees that (and why) a student is Inactive, not the note,
  // and never the application vendor.
  return {
    ...rest,
    applications: hideVendor(rest.applications),
    inactive: rest.inactive ? { ...rest.inactive, note: null } : null,
  };
}

// Shortlist rows as the profile pages show them, with the approval state.
const shortlistCardSelect = {
  id: true,
  created_at: true,
  added_by: true,
  approval_status: true,
  proposed_at: true,
  proposal_note: true,
  decided_at: true,
  reject_reason: true,
  collegepond_user: { select: { first_name: true, last_name: true } },
  added_by_user: { select: { first_name: true, last_name: true } },
  decided_by_user: { select: { first_name: true, last_name: true } },
  decided_by_cp_user: { select: { first_name: true, last_name: true } },
  course: { select: courseCardSelect },
} as const;

type Who = { first_name: string; last_name: string } | null;

function toShortlistCard(r: {
  id: number;
  created_at: Date;
  added_by: number;
  approval_status: number;
  proposed_at: Date;
  proposal_note: string | null;
  decided_at: Date | null;
  reject_reason: string | null;
  collegepond_user: Who;
  added_by_user: Who;
  decided_by_user: Who;
  decided_by_cp_user: Who;
  course: Parameters<typeof toCourseCard>[0];
}) {
  const byPartner = r.added_by === ShortlistSource.PARTNER;
  return {
    id: r.id,
    shortlistedAt: r.created_at.toISOString(),
    addedBy: byPartner ? ("partner" as const) : ("collegepond" as const),
    addedByName: byPartner
      ? r.added_by_user
        ? fullName(r.added_by_user)
        : "Partner"
      : r.collegepond_user
        ? fullName(r.collegepond_user)
        : "Collegepond",
    approvalStatus: r.approval_status,
    proposedAt: r.proposed_at.toISOString(),
    proposalNote: r.proposal_note,
    decidedAt: r.decided_at?.toISOString() ?? null,
    decidedBy: r.decided_by_user
      ? ("partner" as const)
      : r.decided_by_cp_user
        ? ("collegepond" as const)
        : null,
    decidedByName: r.decided_by_user
      ? fullName(r.decided_by_user)
      : r.decided_by_cp_user
        ? fullName(r.decided_by_cp_user)
        : null,
    rejectReason: r.reject_reason,
    ...toCourseCard(r.course),
  };
}

// Why Apply is refused for a shortlist row that isn't approved yet.
function applyBlockedMessage(row: { added_by: number; approval_status: number }): string {
  const byPartner = row.added_by === ShortlistSource.PARTNER;
  if (row.approval_status === ShortlistApproval.REJECTED) {
    return byPartner
      ? "Collegepond rejected this partner proposal. Approve it before starting an application."
      : "The partner rejected this university. Re-propose it and wait for their approval, or pick another.";
  }
  return byPartner
    ? "The partner proposed this university. Approve it before starting an application."
    : "Waiting for the partner to approve this university before an application can start.";
}

const decisionInput = z
  .object({
    studentId: z.number().int().positive(),
    courseId: z.number().int().positive(),
    approve: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.approve || (v.reason ?? "").length >= 3, {
    message: "Give a reason for the rejection",
    path: ["reason"],
  });

const reproposeInput = z.object({
  studentId: z.number().int().positive(),
  courseId: z.number().int().positive(),
  note: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Profile saves, shared by the admin and partner profile pages
// ---------------------------------------------------------------------------

const profileUpdateInput = createFields.extend({
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
});

// The Personal Information save, shared by the admin and partner profile.
async function applyProfileUpdate(input: z.infer<typeof profileUpdateInput>) {
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
      ...(input.applyThroughCp !== undefined && {
        apply_through_cp: input.applyThroughCp ? 1 : 0,
      }),
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
  return updated;
}

const educationInput = z.object({
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
});

// Academic Qualification save (replace-all), shared by admin and partner.
async function applyEducation(input: z.infer<typeof educationInput>) {
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
}

const workInput = z.object({
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
});

// Work Experience save (replace-all), shared by admin and partner.
async function applyWorkExperience(input: z.infer<typeof workInput>) {
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
}

const testsInput = z.object({
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
});

// Tests save (replace-all), shared by admin and partner.
async function applyTestScores(input: z.infer<typeof testsInput>) {
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
}

// Full profile for /admin/students/[id] (and, trimmed by
// toPartnerFull, /partner/students/[id]): the list DTO plus rich application
// and shortlist cards (course + university meta).
async function loadStudentFull(id: number) {
  const s = await db.student.findUnique({
    where: { id },
    include: studentInclude,
  });
  if (!s) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
  }
  const [applications, shortlists] = await Promise.all([
    db.application.findMany({
      where: { student_id: id },
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
        pending_docs: true,
        deposit_deadline: true,
        deposit_amount: true,
        deposit_currency: true,
        deferred_intake_month: true,
        deferred_intake_year: true,
        deferred_from_intake: true,
        deferred_at: true,
        deferred_note: true,
        // The newest partner report (pending, or how the last one ended).
        partner_report: {
          orderBy: { created_at: "desc" },
          take: 1,
          select: {
            id: true,
            target_status: true,
            status: true,
            note: true,
            decision_note: true,
            created_at: true,
            decided_at: true,
            deferred_intake_month: true,
            deferred_intake_year: true,
            document: { select: { id: true, file_name: true, file_url: true } },
          },
        },
        stage_history: {
          orderBy: { stage: "asc" },
          select: { stage: true, occurred_at: true },
        },
        portal_credential: { select: { username: true } },
        course: { select: courseCardSelect },
      },
    }),
    db.shortlist.findMany({
      where: { student_id: id },
      orderBy: { created_at: "desc" },
      select: shortlistCardSelect,
    }),
  ]);
  const [contacts, education, work, tests, notes, documents] =
    await Promise.all([
      db.student_emergency_contact.findMany({
        where: { student_id: id },
        orderBy: { id: "asc" },
      }),
      db.student_education.findMany({
        where: { student_id: id },
        orderBy: { level: "desc" },
      }),
      db.student_work_experience.findMany({
        where: { student_id: id },
        orderBy: [{ start_year: "desc" }, { start_month: "desc" }],
      }),
      db.student_test_score.findMany({
        where: { student_id: id },
        orderBy: [{ test: "asc" }, { attempt: "asc" }],
      }),
      db.student_note.findMany({
        where: { student_id: id },
        orderBy: { created_at: "desc" },
        include: {
          collegepond_user: {
            select: { first_name: true, last_name: true },
          },
        },
      }),
      db.document.findMany({
        where: { student_id: id },
        orderBy: { created_at: "desc" },
      }),
    ]);
  // Who verified or rejected each application document (admin view only).
  const reviewerIds = [
    ...new Set(
      documents.flatMap((d) => (d.application_id && d.reviewed_by_cp_user_id ? [d.reviewed_by_cp_user_id] : [])),
    ),
  ];
  const reviewers = reviewerIds.length
    ? await db.collegepond_user.findMany({
        where: { id: { in: reviewerIds } },
        select: { id: true, first_name: true, last_name: true },
      })
    : [];
  const reviewerName = new Map(reviewers.map((r) => [r.id, fullName(r)]));
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
      applicationId: d.application_id,
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
      // Named at Documents Pending; ticked off as they're uploaded.
      pendingDocs: parsePendingDocs(a.pending_docs),
      partnerReport: toReportCard(a.partner_report[0]),
      depositDeadline: a.deposit_deadline
        ? a.deposit_deadline.toISOString().slice(0, 10)
        : null,
      depositAmount:
        a.deposit_amount === null ? null : a.deposit_amount.toNumber(),
      depositCurrency: a.deposit_currency,
      // Deferred to a later intake; the application stays open.
      deferral:
        a.deferred_at && a.deferred_intake_month && a.deferred_intake_year
          ? {
              intake: deferralIntakeLabel(a.deferred_intake_month, a.deferred_intake_year),
              from: a.deferred_from_intake,
              at: a.deferred_at.toISOString(),
              note: a.deferred_note,
            }
          : null,
      // What the partner uploaded for this application after Deposit Paid
      // (deposit slip, TT copy, visa documents, visa approved copy), with
      // Collegepond's verification. Every version, newest first: `current`
      // is false once a newer upload replaced a single-slot document.
      applicationDocs: documents
        .filter((d) => d.application_id === a.id)
        .map((d) => ({
          id: d.id,
          docType: d.doc_type,
          fileName: d.file_name,
          fileUrl: resolveStorageUrl(d.file_url),
          createdAt: d.created_at.toISOString(),
          current: d.is_most_recent === 1 || isMultiDocType(d.doc_type),
          reviewedAt: d.reviewed_at?.toISOString() ?? null,
          reviewedBy: d.reviewed_by_cp_user_id ? (reviewerName.get(d.reviewed_by_cp_user_id) ?? null) : null,
          review:
            d.status === DocumentStatus.APPROVED
              ? ("verified" as const)
              : d.status === DocumentStatus.REJECTED
                ? ("rejected" as const)
                : ("pending" as const),
          reviewNote: d.review_note,
        })),
      stageHistory: a.stage_history.map((h) => ({
        stage: h.stage,
        date: h.occurred_at.toISOString(),
      })),
      // Username only — the password never leaves the server unencrypted
      // except through the audited reveal mutation.
      portalCredentialUsername: a.portal_credential?.username ?? null,
      ...toCourseCard(a.course),
    })),
    shortlists: shortlists.map(toShortlistCard),
  };
}

// The newest partner report on an application, for its card.
function toReportCard(
  r:
    | {
        id: number;
        target_status: number;
        status: number;
        note: string | null;
        decision_note: string | null;
        created_at: Date;
        decided_at: Date | null;
        deferred_intake_month: number | null;
        deferred_intake_year: number | null;
        document: { id: number; file_name: string; file_url: string } | null;
      }
    | undefined,
) {
  if (!r) return null;
  return {
    id: r.id,
    targetStatus: r.target_status,
    // A reported deferral's new intake.
    deferredIntake:
      r.deferred_intake_month && r.deferred_intake_year
        ? deferralIntakeLabel(r.deferred_intake_month, r.deferred_intake_year)
        : null,
    status: r.status,
    pending: r.status === PartnerReportStatus.PENDING,
    note: r.note,
    decisionNote: r.decision_note,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
    document: r.document
      ? {
          id: r.document.id,
          fileName: r.document.file_name,
          fileUrl: resolveStorageUrl(r.document.file_url),
        }
      : null,
  };
}

// The partner's view of the full profile: same shape as the admin one, with
// Collegepond-internal details blanked (staff notes, CP counsellor and BDM,
// application vendor, portal login).
function toPartnerFull(full: Awaited<ReturnType<typeof loadStudentFull>>) {
  return {
    ...full,
    cpCounsellorId: null,
    cpCounsellorName: null,
    cpAutoAssigned: false,
    bdmName: null,
    notes: [],
    inactive: full.inactive ? { ...full.inactive, note: null } : null,
    partnerUpdates: [] as Awaited<ReturnType<typeof pendingPartnerUpdates>>,
    applications: hideVendor(full.applications),
    applicationCards: full.applicationCards.map((a) => ({
      ...a,
      counsellorVendor: null,
      portalCredentialUsername: null,
      applicationDocs: a.applicationDocs.map((d) => ({ ...d, reviewedBy: null })),
    })),
    // Partners see "Collegepond", never which staff member proposed/decided.
    shortlists: full.shortlists.map((s) => ({
      ...s,
      addedByName: s.addedBy === "collegepond" ? "Collegepond" : s.addedByName,
      decidedByName: s.decidedBy === "collegepond" ? "Collegepond" : s.decidedByName,
    })),
  };
}

// Runs a partner's save between two snapshots of the section and records
// the difference for Collegepond (nothing when the save changed nothing).
async function partnerEdit<T>(
  partnerUserId: number,
  studentId: number,
  section: ChangeSection,
  snapshot: (id: number) => Promise<Snapshot>,
  save: () => Promise<T>,
): Promise<T> {
  const before = await snapshot(studentId);
  const result = await save();
  const after = await snapshot(studentId);
  await recordPartnerChange(studentId, partnerUserId, section, diffSnapshots(before, after));
  return result;
}

// Whose a student added on the admin side is: an agency (orgId), or an
// independent counsellor (independentUserId), stored the way a partner-created
// independent student is (no org, created_by_user_id = them). Exactly one.
const partnerPick = {
  orgId: z.number().int().positive().optional(),
  independentUserId: z.number().int().positive().optional(),
  cpCounsellorId: z.number().int().positive().nullable().optional(),
};
const onePartner = (v: { orgId?: number; independentUserId?: number }) =>
  (v.orgId === undefined) !== (v.independentUserId === undefined);
const ONE_PARTNER_MESSAGE = { message: "Choose one partner: an agency or an independent counsellor." };

async function studentOwnerFields(input: {
  orgId?: number;
  independentUserId?: number;
}): Promise<{ org_id: number | null; created_by_user_id?: number }> {
  if (input.orgId !== undefined) return { org_id: input.orgId };
  const u = await db.user.findFirst({
    where: {
      id: input.independentUserId,
      type: UserType.INDEPENDENT_COUNSELLOR,
      status: UserStatus.APPROVED,
      deleted_at: null,
      org_id: null,
    },
    select: { id: true },
  });
  if (!u) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That independent counsellor isn't an approved, active partner.",
    });
  }
  return { org_id: null, created_by_user_id: u.id };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const studentsRouter = createTRPCRouter({
  // Lightweight list for pickers (e.g. the Uni Assist student selector).
  listLite: protectedAdminProcedure.query(async ({ ctx }) => {
    const rows = await db.student.findMany({
      where: await staffStudentScope(ctx.cpUser),
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      take: LIST_CAP,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        organization: { select: { name: true, type: true } },
        created_by: { select: { first_name: true, last_name: true } },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      firstName: s.first_name,
      lastName: s.last_name,
      orgName: partnerLabel(s.organization, s.created_by),
    }));
  }),

  // ---- Admin (cross-partner) ----------------------------------------------

  adminList: protectedAdminProcedure.query(async ({ ctx }) => {
    const rows = await db.student.findMany({
      // Counsellors see only their students (src/server/staff-access.ts).
      where: await staffStudentScope(ctx.cpUser),
      orderBy: { updated_at: "desc" },
      take: LIST_CAP,
      include: studentInclude,
    });
    // Counted over the listed students only, so any scoping of this list
    // (e.g. a counsellor seeing just their own students) carries through.
    const pending = await db.student_partner_update.groupBy({
      by: ["student_id"],
      where: { reviewed_at: null, student_id: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const updates = new Map(pending.map((p) => [p.student_id, p._count._all]));
    // partnerEditCount: partner edits nobody at Collegepond has reviewed yet.
    return rows.map((s) => ({ ...toApi(s), partnerEditCount: updates.get(s.id) ?? 0 }));
  }),

  // Partner picker (Add Student, Bulk Import): every agency, plus every
  // approved independent counsellor, who has no organization (27 Oct: they
  // were missing). A BDM gets only their own partners. `key` is the option
  // value: "org-<id>" or "ind-<user id>".
  listOrgs: protectedAdminProcedure.query(async ({ ctx }) => {
    const [orgs, independents] = await Promise.all([
      db.organization.findMany({
        where: await bdmOrgScope(ctx.cpUser),
        orderBy: { name: "asc" },
        select: { id: true, name: true, type: true },
      }),
      db.user.findMany({
        where: {
          AND: [
            { type: UserType.INDEPENDENT_COUNSELLOR, status: UserStatus.APPROVED, deleted_at: null, org_id: null },
            await bdmUserScope(ctx.cpUser),
          ],
        },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
        select: { id: true, first_name: true, last_name: true },
      }),
    ]);
    return [
      ...orgs.map((o) => ({ key: `org-${o.id}`, kind: "agency" as const, id: o.id, name: partnerLabel(o, null) })),
      ...independents.map((u) => ({ key: `ind-${u.id}`, kind: "independent" as const, id: u.id, name: partnerLabel(null, u) })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }),

  adminCreate: protectedAdminProcedure
    .input(
      createFields.extend(partnerPick).refine(onePartner, ONE_PARTNER_MESSAGE),
    )
    .mutation(async ({ ctx, input }) => {
      // A BDM may add students only for their own partners.
      if (input.orgId !== undefined) await requireStaffOrg(ctx.cpUser, input.orgId);
      else await requireStaffPartnerUser(ctx.cpUser, input.independentUserId!);
      const owner = await studentOwnerFields(input);
      const cpCounsellorId = await initialCpCounsellor(ctx.cpUser, input.cpCounsellorId);
      const duplicate = await staffDuplicate(
        ctx.cpUser,
        await findDuplicate(input.email, input.countryCode, input.phone, {}),
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
          apply_through_cp: input.applyThroughCp === false ? 0 : 1,
          ...owner,
          cp_counsellor_id: cpCounsellorId,
        },
        select: { id: true },
      });
      if (cpCounsellorId === null) {
        await autoAssignStudents([created.id]);
        await keepVisibleToCreator(ctx.cpUser, [created.id]);
      } else {
        void notifyCounsellorAssignment({
          studentIds: [created.id],
          newCounsellorId: cpCounsellorId,
          previous: new Map(),
          actorCpUserId: ctx.cpUser.id,
        });
      }
      const student = await db.student.findUniqueOrThrow({
        where: { id: created.id },
        include: studentInclude,
      });
      return { ok: true as const, student: toApi(student) };
    }),

  // Bulk-create students from a parsed CSV. Rows are validated client-side; the
  // server re-validates the shape, then skips any row whose email/phone already
  // exists (or repeats earlier in the same file) and createMany's the rest.
  bulkImport: protectedAdminProcedure
    .input(
      z
        .object({ ...partnerPick, rows: z.array(createFields).min(1).max(500) })
        .refine(onePartner, ONE_PARTNER_MESSAGE),
    )
    .mutation(async ({ ctx, input }) => {
      // A BDM may add students only for their own partners.
      if (input.orgId !== undefined) await requireStaffOrg(ctx.cpUser, input.orgId);
      else await requireStaffPartnerUser(ctx.cpUser, input.independentUserId!);
      const owner = await studentOwnerFields(input);
      const cpCounsellorId = await initialCpCounsellor(ctx.cpUser, input.cpCounsellorId);
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
        org_id: number | null;
        created_by_user_id?: number;
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
          apply_through_cp: r.applyThroughCp === false ? 0 : 1,
          ...owner,
          cp_counsellor_id: cpCounsellorId,
        });
      });

      if (toCreate.length > 0) {
        await db.student.createMany({ data: toCreate });
        if (cpCounsellorId === null) {
          // createMany returns no ids; emails are unique, so look them up.
          const ids = (
            await db.student.findMany({
              where: { email: { in: toCreate.map((r) => r.email) } },
              select: { id: true },
            })
          ).map((r) => r.id);
          await autoAssignStudents(ids);
          await keepVisibleToCreator(ctx.cpUser, ids);
        } else {
          const ids = (
            await db.student.findMany({
              where: { email: { in: toCreate.map((r) => r.email) } },
              select: { id: true },
            })
          ).map((r) => r.id);
          void notifyCounsellorAssignment({
            studentIds: ids,
            newCounsellorId: cpCounsellorId,
            previous: new Map(),
            actorCpUserId: ctx.cpUser.id,
          });
        }
      }

      return { created: toCreate.length, skipped };
    }),

  // Full profile for /admin/students/[id], plus partner edits awaiting review.
  adminGet: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.id);
      const full = await loadStudentFull(input.id);
      return { ...full, partnerUpdates: await pendingPartnerUpdates(input.id) };
    }),

  // Clears the "updated by a partner" banner and bell item for a student.
  markPartnerUpdatesReviewed: protectedAdminProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      const r = await db.student_partner_update.updateMany({
        where: { student_id: input.studentId, reviewed_at: null },
        data: { reviewed_at: new Date(), reviewed_by_cp_user_id: ctx.cpUser.id },
      });
      if (r.count > 0) {
        await db.audit_log.create({
          data: {
            action: "student.partner_edits_reviewed",
            entity_type: "student",
            entity_id: input.studentId,
            metadata: { byCpUserId: ctx.cpUser.id, count: r.count },
          },
        });
      }
      return { reviewed: r.count };
    }),

  adminUpdate: protectedAdminProcedure
    .input(profileUpdateInput)
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.id);
      const duplicate = await staffDuplicate(
        ctx.cpUser,
        await findDuplicate(input.email, input.countryCode, input.phone, {}, input.id),
      );
      if (duplicate) {
        return { ok: false as const, duplicate };
      }
      const updated = await applyProfileUpdate(input);
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
    .input(educationInput)
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      await applyEducation(input);
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
    .input(workInput)
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      await applyWorkExperience(input);
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
    .input(testsInput)
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      await applyTestScores(input);
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
      await requireStaffStudent(ctx.cpUser, input.studentId);
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
    .mutation(async ({ ctx, input }) => {
      await requireStaffNote(ctx.cpUser, input.id);
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
    .mutation(async ({ ctx, input }) => {
      await requireStaffNote(ctx.cpUser, input.id);
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
      await requireStaffStudent(ctx.cpUser, doc.student_id);
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

  // Flat (studentId, courseId) pairs for the Uni Assist page's button state,
  // with who proposed each and where its approval stands.
  shortlistsForStudents: protectedAdminProcedure
    .input(
      z.object({
        studentIds: z.array(z.number().int().positive()).max(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.studentIds.length === 0) return [];
      const rows = await db.shortlist.findMany({
        where: {
          student_id: { in: input.studentIds },
          student: await staffStudentScope(ctx.cpUser),
        },
        select: { student_id: true, course_id: true, added_by: true, approval_status: true },
      });
      return rows.map((r) => ({
        studentId: r.student_id,
        courseId: r.course_id,
        byPartner: r.added_by === ShortlistSource.PARTNER,
        approvalStatus: r.approval_status,
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
      await requireStaffStudents(ctx.cpUser, input.studentIds);
      const course = await db.course.findUnique({
        where: { id: input.courseId },
        select: { id: true },
      });
      if (!course) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      }
      const [students, existing] = await Promise.all([
        db.student.findMany({
          where: { id: { in: input.studentIds } },
          select: { id: true, org_id: true, created_by_user_id: true },
        }),
        db.shortlist.findMany({
          where: { student_id: { in: input.studentIds }, course_id: input.courseId },
          select: { id: true, student_id: true, added_by: true, approval_status: true },
        }),
      ]);
      const taken = new Set(existing.map((r) => r.student_id));
      const fresh = students.filter((s) => !taken.has(s.id));
      // The partner approves a Collegepond proposal; a student with nobody on
      // the partner side has no one to ask, so theirs is approved at once.
      const now = new Date();
      const result = await db.shortlist.createMany({
        data: fresh.map((s) => {
          const ask = hasPartnerSide(s);
          return {
            student_id: s.id,
            course_id: input.courseId,
            collegepond_user_id: ctx.cpUser.id,
            added_by: ShortlistSource.COLLEGEPOND,
            approval_status: ask ? ShortlistApproval.PENDING : ShortlistApproval.APPROVED,
            decided_at: ask ? null : now,
            decided_by_cp_user_id: ask ? null : ctx.cpUser.id,
          };
        }),
        skipDuplicates: true,
      });
      // Shortlisting a program the partner already proposed approves it.
      const partnerPicks = existing.filter(
        (r) =>
          r.added_by === ShortlistSource.PARTNER &&
          r.approval_status !== ShortlistApproval.APPROVED,
      );
      if (partnerPicks.length > 0) {
        await db.shortlist.updateMany({
          where: { id: { in: partnerPicks.map((r) => r.id) } },
          data: {
            approval_status: ShortlistApproval.APPROVED,
            decided_at: now,
            decided_by_cp_user_id: ctx.cpUser.id,
            decided_by_user_id: null,
            reject_reason: null,
          },
        });
      }
      await markStudentsShortlisted(input.studentIds);
      await db.audit_log.createMany({
        data: [
          ...fresh.map((s) => ({
            action: "student.shortlisted",
            entity_type: "student",
            entity_id: s.id,
            metadata: {
              courseId: input.courseId,
              byCpUserId: ctx.cpUser.id,
              approval: hasPartnerSide(s) ? "pending" : "approved (no partner)",
            },
          })),
          ...partnerPicks.map((r) => ({
            action: "student.shortlist_approved",
            entity_type: "student",
            entity_id: r.student_id,
            metadata: { courseId: input.courseId, byCpUserId: ctx.cpUser.id, via: "shortlisted" },
          })),
        ],
      });
      const asked = fresh.filter(hasPartnerSide);
      void Promise.all([
        ...asked.map((s) =>
          notifyPartnerOfProposal({ studentId: s.id, courseIds: [input.courseId] }),
        ),
        ...partnerPicks.map((r) =>
          notifyPartnerOfDecision({ studentId: r.student_id, courseId: input.courseId, approved: true }),
        ),
        // The students' counsellors, when a colleague did it.
        notifyColleagueCourseAction(input.studentIds, ctx.cpUser.id, "Shortlisted", input.courseId),
      ]);
      return {
        added: result.count,
        awaitingPartner: asked.length,
        approvedPartnerPicks: partnerPicks.length,
      };
    }),

  // Approve or reject a program the PARTNER proposed (Collegepond's side of
  // the approval; the partner decides on Collegepond's proposals).
  decideShortlist: protectedAdminProcedure
    .input(decisionInput)
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      const row = await db.shortlist.findUnique({
        where: {
          student_id_course_id: { student_id: input.studentId, course_id: input.courseId },
        },
        select: { id: true, added_by: true, approval_status: true },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Shortlist entry not found" });
      }
      if (row.added_by !== ShortlistSource.PARTNER) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Collegepond proposed this university, so the partner approves or rejects it.",
        });
      }
      const reason = input.approve ? null : (input.reason ?? null);
      const result = await db.shortlist.updateMany({
        where: { id: row.id, approval_status: ShortlistApproval.PENDING },
        data: {
          approval_status: input.approve ? ShortlistApproval.APPROVED : ShortlistApproval.REJECTED,
          decided_at: new Date(),
          decided_by_cp_user_id: ctx.cpUser.id,
          decided_by_user_id: null,
          reject_reason: reason,
        },
      });
      if (result.count === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This proposal has already been decided.",
        });
      }
      await db.audit_log.create({
        data: {
          action: input.approve ? "student.shortlist_approved" : "student.shortlist_rejected",
          entity_type: "student",
          entity_id: input.studentId,
          metadata: { courseId: input.courseId, byCpUserId: ctx.cpUser.id, reason },
        },
      });
      void notifyPartnerOfDecision({
        studentId: input.studentId,
        courseId: input.courseId,
        approved: input.approve,
        reason,
      });
      void notifyColleagueCourseAction(
        [input.studentId],
        ctx.cpUser.id,
        input.approve ? "Approved the partner's pick" : "Rejected the partner's pick",
        input.courseId,
      );
      return { ok: true as const };
    }),

  // Send a Collegepond proposal the partner rejected back for approval.
  reproposeShortlist: protectedAdminProcedure
    .input(reproposeInput)
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      const row = await db.shortlist.findUnique({
        where: {
          student_id_course_id: { student_id: input.studentId, course_id: input.courseId },
        },
        select: { id: true, added_by: true, reject_reason: true },
      });
      if (row?.added_by !== ShortlistSource.COLLEGEPOND) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Shortlist entry not found" });
      }
      const note = input.note === "" ? null : (input.note ?? null);
      const result = await db.shortlist.updateMany({
        where: { id: row.id, approval_status: ShortlistApproval.REJECTED },
        data: {
          approval_status: ShortlistApproval.PENDING,
          collegepond_user_id: ctx.cpUser.id,
          proposed_at: new Date(),
          proposal_note: note,
          decided_at: null,
          decided_by_user_id: null,
          decided_by_cp_user_id: null,
          reject_reason: null,
        },
      });
      if (result.count === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a rejected university can be re-proposed.",
        });
      }
      await db.audit_log.create({
        data: {
          action: "student.shortlist_reproposed",
          entity_type: "student",
          entity_id: input.studentId,
          metadata: {
            courseId: input.courseId,
            byCpUserId: ctx.cpUser.id,
            note,
            previousReason: row.reject_reason,
          },
        },
      });
      void notifyPartnerOfProposal({
        studentId: input.studentId,
        courseIds: [input.courseId],
        note,
        reproposed: true,
      });
      void notifyColleagueCourseAction([input.studentId], ctx.cpUser.id, "Re-proposed", input.courseId);
      return { ok: true as const };
    }),

  removeShortlist: protectedAdminProcedure
    .input(
      z.object({
        studentIds: z.array(z.number().int().positive()).min(1).max(50),
        courseId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudents(ctx.cpUser, input.studentIds);
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
      if (result.count > 0) {
        void notifyColleagueCourseAction(input.studentIds, ctx.cpUser.id, "Removed from the shortlist:", input.courseId);
      }
      return { removed: result.count };
    }),

  // "Apply" on a shortlisted card: creates the application (Begin
  // Application) and consumes the shortlist row. Refused until the other
  // side has approved the shortlist entry. This is the only path that
  // creates an application.
  applyShortlist: protectedAdminProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        courseId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaffStudent(ctx.cpUser, input.studentId);
      const student = await db.student.findUnique({
        where: { id: input.studentId },
        select: { id: true, org_id: true, status: true },
      });
      if (!student) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
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

      const entry = await db.shortlist.findUnique({
        where: {
          student_id_course_id: { student_id: input.studentId, course_id: input.courseId },
        },
        select: { added_by: true, approval_status: true },
      });
      if (!entry) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Shortlist this program for the student before applying.",
        });
      }
      if (entry.approval_status !== ShortlistApproval.APPROVED) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: applyBlockedMessage(entry),
        });
      }

      // Counsellor Choice starts as the university's default vendor
      // (Commission Rates); the counsellor can change it on the card.
      const course = await db.course.findUnique({
        where: { id: input.courseId },
        select: { university_id: true },
      });
      const vendor = course ? await defaultVendorFor(course.university_id) : null;
      const app = await db.application.create({
        data: {
          student_id: input.studentId,
          course_id: input.courseId,
          // NULL for an independent counsellor's student; billing pays the
          // independent who created the student (src/server/payee.ts).
          org_id: student.org_id,
          counsellor_vendor: vendor?.name ?? null,
          commission_contract_id: vendor?.contractId ?? null,
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
      void notifyColleagueApplicationAction(app.id, ctx.cpUser.id, "Started an application");
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
        // Required when moving to Documents Pending: what is still needed.
        pendingDocs: z
          .array(
            z.object({
              key: z.string().trim().min(1).max(50),
              label: z.string().trim().max(120).nullish(),
            }),
          )
          .max(20)
          .nullish(),
        // The university's Student ID: required for an offer if not saved yet.
        universityAppId: z.string().trim().max(100).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      // Stage history, dates, pending documents, student status, partner
      // notifications and audit all live in the shared transition.
      const res = await transitionApplication({
        actor: { cpUserId: ctx.cpUser.id },
        applicationId: input.applicationId,
        targetStatus: input.status,
        pendingDocs: input.pendingDocs ?? null,
        universityAppId: input.universityAppId ?? null,
      });
      return { status: res.status };
    }),

  setApplicationUniId: protectedAdminProcedure
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        universityAppId: z.string().trim().max(100).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
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
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      const current = await db.application.findUnique({
        where: { id: input.applicationId },
        select: { course: { select: { university_id: true } } },
      });
      // Link the university × vendor contract behind the choice, if any.
      const contractId =
        input.vendor && current
          ? await contractForVendor(current.course.university_id, input.vendor)
          : null;
      await db.application.update({
        where: { id: input.applicationId },
        data: { counsellor_vendor: input.vendor, commission_contract_id: contractId },
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
    .mutation(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
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
    .mutation(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      await db.application.update({
        where: { id: input.applicationId },
        data: {
          deposit_deadline: input.deadline ? new Date(input.deadline) : null,
          deposit_currency: input.currency,
          deposit_amount: input.amount,
        },
      });
      void notifyColleagueApplicationAction(input.applicationId, ctx.cpUser.id, "Updated the deposit details");
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
      await requireStaffApplication(ctx.cpUser, input.applicationId);
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
      await requireStaffApplication(ctx.cpUser, input.applicationId);
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
      await requireStaffApplication(ctx.cpUser, input.applicationId);
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
      await requireStaffStudents(ctx.cpUser, input.ids);
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
      // Only students the assigner can see, only to someone in their team
      // (counselling roles); a manual pick replaces any auto-assignment.
      await requireStaffStudents(ctx.cpUser, input.ids);
      const counsellor = await requireAssignableCounsellor(ctx.cpUser, input.cpCounsellorId);
      const before = await db.student.findMany({
        where: { id: { in: input.ids } },
        select: { id: true, cp_counsellor_id: true },
      });
      const result = await db.student.updateMany({
        where: { id: { in: input.ids } },
        data: { cp_counsellor_id: counsellor.id, cp_auto_assigned_at: null },
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
      // The new counsellor and any previous one, unless they made the change.
      void notifyCounsellorAssignment({
        studentIds: input.ids,
        newCounsellorId: counsellor.id,
        previous: new Map(before.map((b) => [b.id, b.cp_counsellor_id])),
        actorCpUserId: ctx.cpUser.id,
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
            apply_through_cp: input.applyThroughCp === false ? 0 : 1,
            org_id: user.org_id,
            created_by_user_id: user.id,
            counsellor_id:
              user.type === UserType.AGENCY_COUNSELLOR ? user.id : null,
          },
          include: studentInclude,
        });
        // Route it to a Collegepond counsellor when the partner's lead has
        // Auto Assign on (src/server/staff-access.ts).
        await autoAssignStudents([created.id]);
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

  // ---- Partner shortlists (/partner/uni-assist) ---------------------------
  // Anyone who can see the student (owner, assigned counsellor, the
  // independent who created them) may shortlist programs for them, and
  // approve or reject what Collegepond proposes; another agency's student is
  // "not found". A partner's pick (added_by PARTNER) waits for Collegepond's
  // approval. Partners can remove only their own picks: Collegepond's stay.

  partnerShortlist: protectedPartnerProcedure
    .input(z.object({ studentId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      const rows = await db.shortlist.findMany({
        where: { student_id: input.studentId },
        select: { course_id: true, added_by: true, approval_status: true },
      });
      return rows.map((r) => ({
        courseId: r.course_id,
        byCollegepond: r.added_by === ShortlistSource.COLLEGEPOND,
        approvalStatus: r.approval_status,
      }));
    }),

  partnerAddShortlist: protectedPartnerProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        courseId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const student = await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      const course = await db.course.findUnique({
        where: { id: input.courseId },
        select: { id: true },
      });
      if (!course) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      }
      const existing = await db.shortlist.findUnique({
        where: {
          student_id_course_id: { student_id: student.id, course_id: course.id },
        },
        select: { id: true, added_by: true, approval_status: true, collegepond_user_id: true },
      });
      if (existing) {
        // Shortlisting a program Collegepond proposed approves it.
        if (
          existing.added_by === ShortlistSource.COLLEGEPOND &&
          existing.approval_status !== ShortlistApproval.APPROVED
        ) {
          await db.shortlist.update({
            where: { id: existing.id },
            data: {
              approval_status: ShortlistApproval.APPROVED,
              decided_at: new Date(),
              decided_by_user_id: ctx.cpPartner.id,
              decided_by_cp_user_id: null,
              reject_reason: null,
            },
          });
          await db.audit_log.create({
            data: {
              user_id: ctx.cpPartner.id,
              org_id: student.org_id,
              action: "student.shortlist_approved",
              entity_type: "student",
              entity_id: student.id,
              metadata: { courseId: course.id, byPartnerUserId: ctx.cpPartner.id, via: "shortlisted" },
            },
          });
          void notifyCollegepondOfDecision({
            studentId: student.id,
            courseId: course.id,
            partnerUserId: ctx.cpPartner.id,
            proposerCpUserId: existing.collegepond_user_id,
            approved: true,
          });
          return { added: 0, approved: 1 };
        }
        return { added: 0, approved: 0 };
      }
      const result = await db.shortlist.createMany({
        data: [
          {
            student_id: student.id,
            course_id: course.id,
            added_by: ShortlistSource.PARTNER,
            added_by_user_id: ctx.cpPartner.id,
            approval_status: ShortlistApproval.PENDING,
          },
        ],
        skipDuplicates: true,
      });
      if (result.count > 0) {
        await markStudentsShortlisted([student.id]);
        await db.audit_log.create({
          data: {
            user_id: ctx.cpPartner.id,
            org_id: student.org_id,
            action: "student.shortlisted",
            entity_type: "student",
            entity_id: student.id,
            metadata: { courseId: course.id, byPartnerUserId: ctx.cpPartner.id, approval: "pending" },
          },
        });
        void notifyCollegepondOfProposal({
          studentId: student.id,
          courseId: course.id,
          partnerUserId: ctx.cpPartner.id,
        });
      }
      return { added: result.count, approved: 0 };
    }),

  // Approve or reject a program COLLEGEPOND proposed for the student.
  partnerDecideShortlist: protectedPartnerProcedure
    .input(decisionInput)
    .mutation(async ({ ctx, input }) => {
      const student = await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      const row = await db.shortlist.findUnique({
        where: {
          student_id_course_id: { student_id: student.id, course_id: input.courseId },
        },
        select: { id: true, added_by: true, collegepond_user_id: true },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Shortlist entry not found" });
      }
      if (row.added_by !== ShortlistSource.COLLEGEPOND) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You proposed this university, so Collegepond approves or rejects it.",
        });
      }
      const reason = input.approve ? null : (input.reason ?? null);
      const result = await db.shortlist.updateMany({
        where: { id: row.id, approval_status: ShortlistApproval.PENDING },
        data: {
          approval_status: input.approve ? ShortlistApproval.APPROVED : ShortlistApproval.REJECTED,
          decided_at: new Date(),
          decided_by_user_id: ctx.cpPartner.id,
          decided_by_cp_user_id: null,
          reject_reason: reason,
        },
      });
      if (result.count === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This university has already been approved or rejected.",
        });
      }
      await db.audit_log.create({
        data: {
          user_id: ctx.cpPartner.id,
          org_id: student.org_id,
          action: input.approve ? "student.shortlist_approved" : "student.shortlist_rejected",
          entity_type: "student",
          entity_id: student.id,
          metadata: { courseId: input.courseId, byPartnerUserId: ctx.cpPartner.id, reason },
        },
      });
      void notifyCollegepondOfDecision({
        studentId: student.id,
        courseId: input.courseId,
        partnerUserId: ctx.cpPartner.id,
        proposerCpUserId: row.collegepond_user_id,
        approved: input.approve,
        reason,
      });
      return { ok: true as const };
    }),

  // Send the partner's own pick that Collegepond rejected back for approval.
  partnerReproposeShortlist: protectedPartnerProcedure
    .input(reproposeInput)
    .mutation(async ({ ctx, input }) => {
      const student = await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      const row = await db.shortlist.findUnique({
        where: {
          student_id_course_id: { student_id: student.id, course_id: input.courseId },
        },
        select: { id: true, added_by: true, reject_reason: true },
      });
      if (row?.added_by !== ShortlistSource.PARTNER) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Shortlist entry not found" });
      }
      const note = input.note === "" ? null : (input.note ?? null);
      const result = await db.shortlist.updateMany({
        where: { id: row.id, approval_status: ShortlistApproval.REJECTED },
        data: {
          approval_status: ShortlistApproval.PENDING,
          added_by_user_id: ctx.cpPartner.id,
          proposed_at: new Date(),
          proposal_note: note,
          decided_at: null,
          decided_by_user_id: null,
          decided_by_cp_user_id: null,
          reject_reason: null,
        },
      });
      if (result.count === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a rejected university can be re-proposed.",
        });
      }
      await db.audit_log.create({
        data: {
          user_id: ctx.cpPartner.id,
          org_id: student.org_id,
          action: "student.shortlist_reproposed",
          entity_type: "student",
          entity_id: student.id,
          metadata: {
            courseId: input.courseId,
            byPartnerUserId: ctx.cpPartner.id,
            note,
            previousReason: row.reject_reason,
          },
        },
      });
      void notifyCollegepondOfProposal({
        studentId: student.id,
        courseId: input.courseId,
        partnerUserId: ctx.cpPartner.id,
        note,
        reproposed: true,
      });
      return { ok: true as const };
    }),

  partnerRemoveShortlist: protectedPartnerProcedure
    .input(
      z.object({
        studentId: z.number().int().positive(),
        courseId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const student = await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      const result = await db.shortlist.deleteMany({
        where: {
          student_id: student.id,
          course_id: input.courseId,
          added_by: ShortlistSource.PARTNER,
        },
      });
      if (result.count === 0) {
        const byCollegepond = await db.shortlist.count({
          where: { student_id: student.id, course_id: input.courseId },
        });
        if (byCollegepond > 0) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Collegepond shortlisted this program, so only Collegepond can remove it.",
          });
        }
        return { removed: 0 };
      }
      await db.audit_log.create({
        data: {
          user_id: ctx.cpPartner.id,
          org_id: student.org_id,
          action: "student.shortlist_removed",
          entity_type: "student",
          entity_id: student.id,
          metadata: { courseId: input.courseId, byPartnerUserId: ctx.cpPartner.id },
        },
      });
      return { removed: result.count };
    }),

  // ---- Partner student profile (/partner/students/[id]) -------------------
  // Anyone who can see the student may view and edit the profile (owner,
  // assigned counsellor, the independent who created them), including after
  // applications are submitted. Every edit is diffed and reported to
  // Collegepond's counselling team (src/server/student-changes.ts).

  partnerGet: protectedPartnerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.id);
      return toPartnerFull(await loadStudentFull(input.id));
    }),

  partnerUpdate: protectedPartnerProcedure
    .input(profileUpdateInput)
    .mutation(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.id);
      // Email is unique across Collegepond. Name the clash only when it is a
      // student this partner can already see; another agency's stays hidden.
      const duplicate = await findDuplicate(
        input.email,
        input.countryCode,
        input.phone,
        {},
        input.id,
      );
      if (duplicate) {
        if (await findVisibleStudent(ctx.cpPartner.id, duplicate.id)) {
          return { ok: false as const, duplicate };
        }
        throw new TRPCError({
          code: "CONFLICT",
          message: `Another student on Collegepond already uses this ${
            duplicate.matchedOn === "email" ? "email address" : "phone number"
          }.`,
        });
      }
      const updated = await partnerEdit(ctx.cpPartner.id, input.id, "profile", profileSnapshot, () =>
        applyProfileUpdate(input),
      );
      // Same type as adminUpdate's result (the shared form takes either).
      const base = toApi(updated);
      const student: ReturnType<typeof toApi> = {
        ...base,
        cpCounsellorId: null,
        cpCounsellorName: null,
        bdmName: null,
        applications: hideVendor(base.applications),
      };
      return { ok: true as const, student };
    }),

  partnerSaveEducation: protectedPartnerProcedure
    .input(educationInput)
    .mutation(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      await partnerEdit(ctx.cpPartner.id, input.studentId, "academics", academicsSnapshot, () =>
        applyEducation(input),
      );
      return { ok: true };
    }),

  partnerSaveWorkExperience: protectedPartnerProcedure
    .input(workInput)
    .mutation(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      await partnerEdit(ctx.cpPartner.id, input.studentId, "work", workSnapshot, () =>
        applyWorkExperience(input),
      );
      return { ok: true };
    }),

  partnerSaveTestScores: protectedPartnerProcedure
    .input(testsInput)
    .mutation(async ({ ctx, input }) => {
      await requireVisibleStudent(ctx.cpPartner.id, input.studentId);
      await partnerEdit(ctx.cpPartner.id, input.studentId, "tests", testsSnapshot, () =>
        applyTestScores(input),
      );
      return { ok: true };
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
