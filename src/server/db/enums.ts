export const OrganizationType = {
  AGENCY: 0,
} as const;
export type OrganizationType =
  (typeof OrganizationType)[keyof typeof OrganizationType];

export const UserType = {
  AGENCY_OWNER: 0,
  AGENCY_COUNSELLOR: 1,
  INDEPENDENT_COUNSELLOR: 2,
  ADMIN: 10,
} as const;
export type UserType = (typeof UserType)[keyof typeof UserType];

export const AdminRole = {
  SUPER_ADMIN: 0,
  FINANCE_MANAGER: 1,
  FINANCE_EXECUTIVE: 2,
  COUNSELLOR_LEAD: 3,
  COUNSELLOR: 4,
  OPERATIONS_LEAD: 5,
  OPERATIONS_EXECUTIVE: 6,
  CONTENT_MANAGER: 7,
  BDM: 8,
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const AdminRoleLabel: Record<AdminRole, string> = {
  [AdminRole.SUPER_ADMIN]: "Super Admin",
  [AdminRole.FINANCE_MANAGER]: "Finance Manager",
  [AdminRole.FINANCE_EXECUTIVE]: "Finance Executive",
  [AdminRole.COUNSELLOR_LEAD]: "Counsellor Lead",
  [AdminRole.COUNSELLOR]: "Counsellor",
  [AdminRole.OPERATIONS_LEAD]: "Operations Lead",
  [AdminRole.OPERATIONS_EXECUTIVE]: "Operations Executive",
  [AdminRole.CONTENT_MANAGER]: "Content Manager",
  [AdminRole.BDM]: "BDM",
};

export const ADMIN_ROLE_CODES = Object.values(AdminRole) as AdminRole[];

export function isAdminRole(value: number): value is AdminRole {
  return ADMIN_ROLE_CODES.includes(value as AdminRole);
}

export const UserStatus = {
  UNDER_REVIEW: 0,
  APPROVED: 1,
  REJECTED: 2,
  INACTIVE: 3,
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const DocumentStatus = {
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

export const ApplicationStatusLabel = {
  [UserStatus.UNDER_REVIEW]: "under_review",
  [UserStatus.APPROVED]: "approved",
  [UserStatus.REJECTED]: "rejected",
  [UserStatus.INACTIVE]: "inactive",
} as const;

export type ApplicationStatus = "under_review" | "approved" | "rejected" | "inactive";

export function statusCodeFromLabel(label: ApplicationStatus): UserStatus {
  switch (label) {
    case "under_review":
      return UserStatus.UNDER_REVIEW;
    case "approved":
      return UserStatus.APPROVED;
    case "rejected":
      return UserStatus.REJECTED;
    case "inactive":
      return UserStatus.INACTIVE;
  }
}

export function statusLabelFromCode(code: number): ApplicationStatus {
  if (code in ApplicationStatusLabel) {
    return ApplicationStatusLabel[code as UserStatus];
  }
  return "under_review";
}

const COUNSELLOR_RANGE_CODES: Record<string, number> = {
  "1 - 5": 1,
  "6 - 10": 2,
  "11 - 15": 3,
  "16 - 25": 4,
  "25+": 5,
};

const VOLUME_RANGE_CODES: Record<string, number> = {
  "1 - 25": 1,
  "26 - 50": 2,
  "51 - 100": 3,
  "101 - 250": 4,
  "250+": 5,
};

export function counsellorRangeToCode(label: string | undefined): number | null {
  if (!label) return null;
  return COUNSELLOR_RANGE_CODES[label] ?? null;
}

export function volumeRangeToCode(label: string | undefined): number | null {
  if (!label) return null;
  return VOLUME_RANGE_CODES[label] ?? null;
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

// 21-value student pipeline status. Codes are grouped in decades so the group
// is recoverable from the code alone (Math.floor(code / 10)). Labels match the
// design mocks exactly (cp-students.html statusGroups).
export const StudentStatus = {
  // Leads (group 0)
  NEW: 0,
  INTERESTED: 1,
  CONNECTED: 2,
  SHORTLISTED: 3,
  NO_INTEREST: 4,
  NO_RESPONSE: 5,
  // Pre-Application / Submission (group 1)
  BEGIN_APPLICATION: 10,
  DOCUMENT_PENDING: 11,
  APP_SUBMITTED: 12,
  APP_UNDER_REVIEW: 13,
  // Offer Stage (group 2)
  CONDITIONAL_OFFER: 20,
  UNCONDITIONAL_OFFER: 21,
  REJECTED_BY_UNIVERSITY: 22,
  // Student Decision (group 3)
  APPLICATION_WITHDRAWAL: 30,
  DECLINED_BY_STUDENT: 31,
  NOT_QUALIFIED: 32,
  // Post-Offer / Conversion (group 4)
  DEPOSIT_PAID: 40,
  VISA_SECURED: 41,
  VISA_REJECTED: 42,
  DEFERRED_TO_NEXT_INTAKE: 43,
  COURSE_CLOSED: 44,
  ENROLLED: 45,
} as const;
export type StudentStatus = (typeof StudentStatus)[keyof typeof StudentStatus];

export const StudentStatusLabel: Record<StudentStatus, string> = {
  [StudentStatus.NEW]: "New",
  [StudentStatus.INTERESTED]: "Interested",
  [StudentStatus.CONNECTED]: "Connected",
  [StudentStatus.SHORTLISTED]: "Shortlisted",
  [StudentStatus.NO_INTEREST]: "No Interest",
  [StudentStatus.NO_RESPONSE]: "No Response",
  [StudentStatus.BEGIN_APPLICATION]: "Begin Application",
  [StudentStatus.DOCUMENT_PENDING]: "Document Pending",
  [StudentStatus.APP_SUBMITTED]: "App Submitted",
  [StudentStatus.APP_UNDER_REVIEW]: "App Under Review",
  [StudentStatus.CONDITIONAL_OFFER]: "Conditional Offer Received",
  [StudentStatus.UNCONDITIONAL_OFFER]: "Unconditional Offer Received",
  [StudentStatus.REJECTED_BY_UNIVERSITY]: "Rejected by University",
  [StudentStatus.APPLICATION_WITHDRAWAL]: "Application Withdrawal",
  [StudentStatus.DECLINED_BY_STUDENT]: "Declined by Student",
  [StudentStatus.NOT_QUALIFIED]: "Not Qualified",
  [StudentStatus.DEPOSIT_PAID]: "Deposit Paid",
  [StudentStatus.VISA_SECURED]: "Visa Secured",
  [StudentStatus.VISA_REJECTED]: "Visa Rejected",
  [StudentStatus.DEFERRED_TO_NEXT_INTAKE]: "Deferred to Next Intake",
  [StudentStatus.COURSE_CLOSED]: "Course Closed",
  [StudentStatus.ENROLLED]: "Enrolled",
};

export const STUDENT_STATUS_CODES = Object.values(
  StudentStatus,
) as StudentStatus[];

// Status group = code decade. Group keys/labels match the mock's tab bar.
export const StudentStatusGroup = {
  LEADS: 0,
  PRE_APPLICATION: 1,
  OFFER: 2,
  DECISION: 3,
  POST_OFFER: 4,
} as const;
export type StudentStatusGroup =
  (typeof StudentStatusGroup)[keyof typeof StudentStatusGroup];

export const StudentStatusGroupLabel: Record<StudentStatusGroup, string> = {
  [StudentStatusGroup.LEADS]: "Leads",
  [StudentStatusGroup.PRE_APPLICATION]: "Pre-Application / Submission",
  [StudentStatusGroup.OFFER]: "Offer Stage",
  [StudentStatusGroup.DECISION]: "Student Decision",
  [StudentStatusGroup.POST_OFFER]: "Post-Offer / Conversion",
};

export function studentStatusGroup(status: number): StudentStatusGroup {
  return Math.floor(status / 10) as StudentStatusGroup;
}

// Seed data uses 1 Male / 2 Female; NULL = not provided. Options mirror the
// profile mock (cp-student-profile.html spGender).
export const Gender = {
  MALE: 1,
  FEMALE: 2,
  NON_BINARY: 3,
  PREFER_NOT_TO_SAY: 4,
} as const;
export type Gender = (typeof Gender)[keyof typeof Gender];

export const GenderLabel: Record<Gender, string> = {
  [Gender.MALE]: "Male",
  [Gender.FEMALE]: "Female",
  [Gender.NON_BINARY]: "Non-Binary",
  [Gender.PREFER_NOT_TO_SAY]: "Prefer not to say",
};

export const GENDER_CODES = Object.values(Gender) as Gender[];

// Student-profile document slots (cp-student-profile Documents tab).
export interface StudentDocType {
  key: string;
  label: string;
  multiple: boolean;
  section: "academic" | "enrollment";
}

export const STUDENT_DOC_TYPES: StudentDocType[] = [
  { key: "sop", label: "Statement of Purpose (SOP)", multiple: false, section: "academic" },
  { key: "lor", label: "Letter of Recommendation (LOR)", multiple: true, section: "academic" },
  { key: "resume", label: "Resume / CV", multiple: false, section: "academic" },
  { key: "backlog", label: "Backlog Certificate", multiple: false, section: "academic" },
  { key: "additional", label: "Additional Documents", multiple: true, section: "academic" },
  { key: "offer_letter", label: "Offer Letter", multiple: true, section: "enrollment" },
  { key: "visa", label: "Visa Copy", multiple: false, section: "enrollment" },
  { key: "deposit_receipt", label: "Deposit Receipt", multiple: false, section: "enrollment" },
  { key: "tuition_receipt", label: "Tuition Payment Receipts", multiple: true, section: "enrollment" },
];

export const STUDENT_DOC_TYPE_KEYS = STUDENT_DOC_TYPES.map((d) => d.key);

// Task priority for student notes/tasks.
export const NotePriority = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
} as const;
export type NotePriority = (typeof NotePriority)[keyof typeof NotePriority];

export const NotePriorityLabel: Record<NotePriority, string> = {
  [NotePriority.LOW]: "Low",
  [NotePriority.MEDIUM]: "Medium",
  [NotePriority.HIGH]: "High",
};

export const NOTE_PRIORITY_CODES = Object.values(NotePriority) as NotePriority[];

// Profile mock's marital status options, in mock order.
export const MaritalStatus = {
  SINGLE: 0,
  MARRIED: 1,
  DIVORCED: 2,
  WIDOWED: 3,
  PREFER_NOT_TO_SAY: 4,
} as const;
export type MaritalStatus = (typeof MaritalStatus)[keyof typeof MaritalStatus];

export const MaritalStatusLabel: Record<MaritalStatus, string> = {
  [MaritalStatus.SINGLE]: "Single",
  [MaritalStatus.MARRIED]: "Married",
  [MaritalStatus.DIVORCED]: "Divorced",
  [MaritalStatus.WIDOWED]: "Widowed",
  [MaritalStatus.PREFER_NOT_TO_SAY]: "Prefer not to say",
};

export const MARITAL_STATUS_CODES = Object.values(
  MaritalStatus,
) as MaritalStatus[];

export const EmergencyRelationship = {
  PARENT: 0,
  SIBLING: 1,
  SPOUSE: 2,
  FRIEND: 3,
  OTHER: 4,
} as const;
export type EmergencyRelationship =
  (typeof EmergencyRelationship)[keyof typeof EmergencyRelationship];

export const EmergencyRelationshipLabel: Record<EmergencyRelationship, string> =
  {
    [EmergencyRelationship.PARENT]: "Parent",
    [EmergencyRelationship.SIBLING]: "Sibling",
    [EmergencyRelationship.SPOUSE]: "Spouse",
    [EmergencyRelationship.FRIEND]: "Friend",
    [EmergencyRelationship.OTHER]: "Other",
  };

export const EMERGENCY_RELATIONSHIP_CODES = Object.values(
  EmergencyRelationship,
) as EmergencyRelationship[];

// Academic Qualification levels (the mock's educationLevelOrder). Distinct
// from CourseLevel below — this is completed education, not intended study.
export const EducationLevel = {
  TENTH: 0,
  TWELFTH: 1,
  UG: 2,
  MASTERS: 3,
  PHD: 4,
} as const;
export type EducationLevel = (typeof EducationLevel)[keyof typeof EducationLevel];

export const EducationLevelLabel: Record<EducationLevel, string> = {
  [EducationLevel.TENTH]: "10th Grade",
  [EducationLevel.TWELFTH]: "12th Grade",
  [EducationLevel.UG]: "Undergraduate",
  [EducationLevel.MASTERS]: "Masters / MBA",
  [EducationLevel.PHD]: "PhD",
};

export const EDUCATION_LEVEL_CODES = Object.values(
  EducationLevel,
) as EducationLevel[];

// 0 Foundation … 5 PhD. Distinct from course.degree_level (which is the
// catalogue's 9-value taxonomy); this is the student's intended level.
export const CourseLevel = {
  FOUNDATION: 0,
  DIPLOMA: 1,
  UG: 2,
  PG: 3,
  MBA: 4,
  PHD: 5,
} as const;
export type CourseLevel = (typeof CourseLevel)[keyof typeof CourseLevel];

export const CourseLevelLabel: Record<CourseLevel, string> = {
  [CourseLevel.FOUNDATION]: "Foundation",
  [CourseLevel.DIPLOMA]: "Diploma",
  [CourseLevel.UG]: "UG",
  [CourseLevel.PG]: "PG",
  [CourseLevel.MBA]: "MBA",
  [CourseLevel.PHD]: "PhD",
};

export const COURSE_LEVEL_CODES = Object.values(CourseLevel) as CourseLevel[];

// Application pipeline: 0–7 are the ordinal happy-path stages; >= 20 are
// terminal/alternative outcomes (non-ordinal).
export const UniApplicationStatus = {
  BEGIN_APPLICATION: 0,
  DOCUMENTS_PENDING: 1,
  APPLICATION_SUBMITTED: 2,
  APPLICATION_UNDER_REVIEW: 3,
  CONDITIONAL_OFFER: 4,
  UNCONDITIONAL_OFFER: 5,
  DEPOSIT_PAID: 6,
  VISA_SECURED: 7,
  // Final happy-path stage: student confirmed enrolled at the university.
  // Set from the Student Placements page once visa is secured.
  ENROLLED: 8,
  REJECTED_BY_UNIVERSITY: 20,
  APPLICATION_WITHDRAWAL: 21,
  DECLINED_BY_STUDENT: 22,
  VISA_REJECTED: 23,
  DEFERRED_TO_NEXT_INTAKE: 24,
  COURSE_CLOSED: 25,
} as const;
export type UniApplicationStatus =
  (typeof UniApplicationStatus)[keyof typeof UniApplicationStatus];

export const UNI_APP_STATUS_CODES = Object.values(
  UniApplicationStatus,
) as UniApplicationStatus[];

// Application status → student pipeline status (the mock's
// STAGE_TO_TABLE_STATUS): the student's table row mirrors their
// furthest-stage application.
export const APP_TO_STUDENT_STATUS: Record<UniApplicationStatus, StudentStatus> = {
  [UniApplicationStatus.BEGIN_APPLICATION]: StudentStatus.BEGIN_APPLICATION,
  [UniApplicationStatus.DOCUMENTS_PENDING]: StudentStatus.DOCUMENT_PENDING,
  [UniApplicationStatus.APPLICATION_SUBMITTED]: StudentStatus.APP_SUBMITTED,
  [UniApplicationStatus.APPLICATION_UNDER_REVIEW]: StudentStatus.APP_UNDER_REVIEW,
  [UniApplicationStatus.CONDITIONAL_OFFER]: StudentStatus.CONDITIONAL_OFFER,
  [UniApplicationStatus.UNCONDITIONAL_OFFER]: StudentStatus.UNCONDITIONAL_OFFER,
  [UniApplicationStatus.DEPOSIT_PAID]: StudentStatus.DEPOSIT_PAID,
  [UniApplicationStatus.VISA_SECURED]: StudentStatus.VISA_SECURED,
  [UniApplicationStatus.ENROLLED]: StudentStatus.ENROLLED,
  [UniApplicationStatus.REJECTED_BY_UNIVERSITY]: StudentStatus.REJECTED_BY_UNIVERSITY,
  [UniApplicationStatus.APPLICATION_WITHDRAWAL]: StudentStatus.APPLICATION_WITHDRAWAL,
  [UniApplicationStatus.DECLINED_BY_STUDENT]: StudentStatus.DECLINED_BY_STUDENT,
  [UniApplicationStatus.VISA_REJECTED]: StudentStatus.VISA_REJECTED,
  [UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE]: StudentStatus.DEFERRED_TO_NEXT_INTAKE,
  [UniApplicationStatus.COURSE_CLOSED]: StudentStatus.COURSE_CLOSED,
};

// Where the stepper shows a terminal outcome when an application has no
// stage history (e.g. seeded rows): the stage the outcome typically lands.
export const TERMINAL_FALLBACK_STAGE: Record<number, UniApplicationStatus> = {
  [UniApplicationStatus.REJECTED_BY_UNIVERSITY]:
    UniApplicationStatus.APPLICATION_UNDER_REVIEW,
  [UniApplicationStatus.APPLICATION_WITHDRAWAL]:
    UniApplicationStatus.DEPOSIT_PAID,
  [UniApplicationStatus.DECLINED_BY_STUDENT]: UniApplicationStatus.DEPOSIT_PAID,
  [UniApplicationStatus.VISA_REJECTED]: UniApplicationStatus.VISA_SECURED,
  [UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE]:
    UniApplicationStatus.VISA_SECURED,
  [UniApplicationStatus.COURSE_CLOSED]: UniApplicationStatus.VISA_SECURED,
};

export const UniApplicationStatusLabel: Record<UniApplicationStatus, string> = {
  [UniApplicationStatus.BEGIN_APPLICATION]: "Begin Application",
  [UniApplicationStatus.DOCUMENTS_PENDING]: "Documents Pending",
  [UniApplicationStatus.APPLICATION_SUBMITTED]: "Application Submitted",
  [UniApplicationStatus.APPLICATION_UNDER_REVIEW]: "Application Under Review",
  [UniApplicationStatus.CONDITIONAL_OFFER]: "Conditional Offer",
  [UniApplicationStatus.UNCONDITIONAL_OFFER]: "Unconditional Offer",
  [UniApplicationStatus.DEPOSIT_PAID]: "Deposit Paid",
  [UniApplicationStatus.VISA_SECURED]: "Visa Secured",
  [UniApplicationStatus.ENROLLED]: "Enrolled",
  [UniApplicationStatus.REJECTED_BY_UNIVERSITY]: "Rejected by University",
  [UniApplicationStatus.APPLICATION_WITHDRAWAL]: "Application Withdrawal",
  [UniApplicationStatus.DECLINED_BY_STUDENT]: "Declined by Student",
  [UniApplicationStatus.VISA_REJECTED]: "Visa Rejected",
  [UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE]: "Deferred to Next Intake",
  [UniApplicationStatus.COURSE_CLOSED]: "Course Closed",
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export const EventType = {
  UNIVERSITY_FAIR: 0,
  WEBINAR: 1,
  WORKSHOP: 2,
  INFO_SESSION: 3,
  PARTNER_MEET: 4,
  OTHER: 5,
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const EventTypeLabel: Record<EventType, string> = {
  [EventType.UNIVERSITY_FAIR]: "University Fair",
  [EventType.WEBINAR]: "Webinar",
  [EventType.WORKSHOP]: "Workshop",
  [EventType.INFO_SESSION]: "Info Session",
  [EventType.PARTNER_MEET]: "Partner Meet",
  [EventType.OTHER]: "Other",
};

export const EVENT_TYPE_CODES = Object.values(EventType) as EventType[];

// event_registration.status — a partner's RSVP state for an event.
export const EventRegistrationStatus = {
  INVITED: 0,
  ACCEPTED: 1,
  DECLINED: 2,
  ATTENDED: 3,
} as const;
export type EventRegistrationStatus =
  (typeof EventRegistrationStatus)[keyof typeof EventRegistrationStatus];

export const EventRegistrationStatusLabel: Record<EventRegistrationStatus, string> = {
  [EventRegistrationStatus.INVITED]: "Invited",
  [EventRegistrationStatus.ACCEPTED]: "Accepted",
  [EventRegistrationStatus.DECLINED]: "Declined",
  [EventRegistrationStatus.ATTENDED]: "Attended",
};

// ---------------------------------------------------------------------------
// Finance / Commission
// ---------------------------------------------------------------------------
// The finance module hangs off a single spine — the per-application `commission`
// record — whose CommissionStatus gates every page. Inbound (university/vendor →
// CP) advances it to RECEIVED; outbound (CP → partner) advances it to DISBURSED.
// All codes are stored as small ints (see the matching @db.UnsignedTinyInt
// columns in schema.prisma / prisma/sql/schema.sql).

// vendor.type — a commission source is either a direct university contract or a
// third-party aggregator (KC/Kaplan, IDP…) from which CP takes a share.
export const VendorType = {
  DIRECT: 0,
  THIRD_PARTY: 1,
} as const;
export type VendorType = (typeof VendorType)[keyof typeof VendorType];

export const VendorTypeLabel: Record<VendorType, string> = {
  [VendorType.DIRECT]: "Direct",
  [VendorType.THIRD_PARTY]: "Third-Party",
};

export const VENDOR_TYPE_CODES = Object.values(VendorType) as VendorType[];

// commission_rate.commission_type — percentage of tuition vs a flat amount.
export const CommissionType = {
  PERCENTAGE: 0,
  FLAT: 1,
} as const;
export type CommissionType = (typeof CommissionType)[keyof typeof CommissionType];

export const CommissionTypeLabel: Record<CommissionType, string> = {
  [CommissionType.PERCENTAGE]: "Percentage",
  [CommissionType.FLAT]: "Flat Amount",
};

export const COMMISSION_TYPE_CODES = Object.values(
  CommissionType,
) as CommissionType[];

// DERIVED display status for the commission spine — NOT stored as a column. A
// commissionStatus() helper computes it from the milestone timestamps
// (collegepond_received_at, partner_paid_at) plus the linked vendor_invoice /
// partner invoice rows: NOT_INVOICED → INVOICED (vendor invoice raised) →
// RECEIVED (CP got paid; unlocks the partner claim) → READY_TO_DISBURSE (partner
// invoice approved) → DISBURSED (payout released).
export const CommissionStatus = {
  NOT_INVOICED: 0,
  INVOICED: 1,
  RECEIVED: 2,
  READY_TO_DISBURSE: 3,
  DISBURSED: 4,
  CANCELLED: 9,
} as const;
export type CommissionStatus =
  (typeof CommissionStatus)[keyof typeof CommissionStatus];

export const CommissionStatusLabel: Record<CommissionStatus, string> = {
  [CommissionStatus.NOT_INVOICED]: "Not Invoiced",
  [CommissionStatus.INVOICED]: "Invoiced",
  [CommissionStatus.RECEIVED]: "Received",
  [CommissionStatus.READY_TO_DISBURSE]: "Ready to Disburse",
  [CommissionStatus.DISBURSED]: "Disbursed",
  [CommissionStatus.CANCELLED]: "Cancelled",
};

export const COMMISSION_STATUS_CODES = Object.values(
  CommissionStatus,
) as CommissionStatus[];

// vendor_invoice.status — CP's invoice TO a vendor/university (inbound).
// OVERDUE is derived (SENT/PARTIAL & due_date < today), never stored.
export const VendorInvoiceStatus = {
  DRAFT: 0,
  SENT: 1,
  PARTIAL_PAYMENT: 2,
  FULLY_PAID: 3,
} as const;
export type VendorInvoiceStatus =
  (typeof VendorInvoiceStatus)[keyof typeof VendorInvoiceStatus];

export const VendorInvoiceStatusLabel: Record<VendorInvoiceStatus, string> = {
  [VendorInvoiceStatus.DRAFT]: "Draft",
  [VendorInvoiceStatus.SENT]: "Sent",
  [VendorInvoiceStatus.PARTIAL_PAYMENT]: "Partial Payment",
  [VendorInvoiceStatus.FULLY_PAID]: "Fully Paid",
};

export const VENDOR_INVOICE_STATUS_CODES = Object.values(
  VendorInvoiceStatus,
) as VendorInvoiceStatus[];

// vendor_invoice_item.variance_reason — required when the entered (expected)
// amount differs from tuition × commission %. Mandatory tuition input is what
// makes this variance tracking possible (call decision, 25 Jun 2026).
export const VarianceReason = {
  NONE: 0,
  SCHOLARSHIP: 1,
  TUITION_INCORRECT: 2,
  LATE_TAGGING: 3,
  OTHER: 4,
} as const;
export type VarianceReason = (typeof VarianceReason)[keyof typeof VarianceReason];

export const VarianceReasonLabel: Record<VarianceReason, string> = {
  [VarianceReason.NONE]: "No variance",
  [VarianceReason.SCHOLARSHIP]: "Scholarship",
  [VarianceReason.TUITION_INCORRECT]: "Tuition Incorrect",
  [VarianceReason.LATE_TAGGING]: "Late Tagging",
  [VarianceReason.OTHER]: "Other",
};

export const VARIANCE_REASON_CODES = Object.values(
  VarianceReason,
) as VarianceReason[];

// Indicative per-currency → INR rates, used ONLY to present cross-currency
// figures (Expected / Outstanding / ageing) in a single ₹ headline. Actual
// money received is always the exact ₹ deposited (recorded at payment time);
// these are display estimates, not booked FX. CP-editable rates can override
// later — for now these are the house defaults.
export const INDICATIVE_FX_RATES: Record<string, number> = {
  USD: 83.5,
  GBP: 105.8,
  EUR: 90.6,
  AUD: 54.2,
  CAD: 61.3,
  NZD: 49.8,
  SGD: 62.1,
  INR: 1,
};
export const toINR = (
  amount: number,
  currency: string | null | undefined,
): number =>
  Math.round(amount * (INDICATIVE_FX_RATES[currency ?? "INR"] ?? 1) * 100) / 100;

// commission_tranche.status — per-tranche lifecycle for tranche-based deals
// (e.g. 90% on enrollment, 10% on completion). "RECEIVED" = available for the
// partner to claim; dimmed/already-paid tranches are PAID.
export const TrancheStatus = {
  UPCOMING: 0,
  NOT_INVOICED: 1,
  AWAITING_PAYMENT: 2,
  RECEIVED: 3,
  PAID: 4,
} as const;
export type TrancheStatus = (typeof TrancheStatus)[keyof typeof TrancheStatus];

export const TrancheStatusLabel: Record<TrancheStatus, string> = {
  [TrancheStatus.UPCOMING]: "Upcoming",
  [TrancheStatus.NOT_INVOICED]: "To be Invoiced",
  [TrancheStatus.AWAITING_PAYMENT]: "Awaiting Payment to CP",
  [TrancheStatus.RECEIVED]: "Available to Claim",
  [TrancheStatus.PAID]: "Paid",
};

export const TRANCHE_STATUS_CODES = Object.values(
  TrancheStatus,
) as TrancheStatus[];

// invoice.status — the PARTNER's invoice TO CP (outbound). Ops moves it
// SUBMITTED → UNDER_REVIEW → APPROVED|PARTIAL_APPROVED|REJECTED; PAID is set
// once Finance releases the payout (see PayoutStatus).
export const PartnerInvoiceStatus = {
  SUBMITTED: 0,
  UNDER_REVIEW: 1,
  APPROVED: 2,
  PARTIAL_APPROVED: 3,
  REJECTED: 4,
  PAID: 5,
} as const;
export type PartnerInvoiceStatus =
  (typeof PartnerInvoiceStatus)[keyof typeof PartnerInvoiceStatus];

export const PartnerInvoiceStatusLabel: Record<PartnerInvoiceStatus, string> = {
  [PartnerInvoiceStatus.SUBMITTED]: "Submitted",
  [PartnerInvoiceStatus.UNDER_REVIEW]: "Under Review",
  [PartnerInvoiceStatus.APPROVED]: "Approved",
  [PartnerInvoiceStatus.PARTIAL_APPROVED]: "Partial Approved",
  [PartnerInvoiceStatus.REJECTED]: "Rejected",
  [PartnerInvoiceStatus.PAID]: "Paid",
};

export const PARTNER_INVOICE_STATUS_CODES = Object.values(
  PartnerInvoiceStatus,
) as PartnerInvoiceStatus[];

// partner_payout.status — the reconciliation/release record. Ops approval lands
// it at APPROVED (pending Finance verification); Finance ticks the 4-point
// checklist → READY_TO_PAY → RELEASED. ON_HOLD / SENT_BACK are side-branches.
export const PayoutStatus = {
  APPROVED: 0,
  READY_TO_PAY: 1,
  RELEASED: 2,
  ON_HOLD: 3,
  SENT_BACK: 4,
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const PayoutStatusLabel: Record<PayoutStatus, string> = {
  [PayoutStatus.APPROVED]: "Pending Verification",
  [PayoutStatus.READY_TO_PAY]: "Ready to Pay",
  [PayoutStatus.RELEASED]: "Released",
  [PayoutStatus.ON_HOLD]: "On Hold",
  [PayoutStatus.SENT_BACK]: "Sent Back",
};

export const PAYOUT_STATUS_CODES = Object.values(PayoutStatus) as PayoutStatus[];

// partner_payout.method — the rail used to release a partner payout. IFSC is
// captured for NEFT/RTGS/IMPS/UPI; SWIFT replaces it for INTERNATIONAL_WIRE.
export const PayoutMethod = {
  NEFT: 0,
  RTGS: 1,
  INTERNATIONAL_WIRE: 2,
  IMPS: 3,
  UPI: 4,
} as const;
export type PayoutMethod = (typeof PayoutMethod)[keyof typeof PayoutMethod];

export const PayoutMethodLabel: Record<PayoutMethod, string> = {
  [PayoutMethod.NEFT]: "NEFT",
  [PayoutMethod.RTGS]: "RTGS",
  [PayoutMethod.INTERNATIONAL_WIRE]: "International Wire",
  [PayoutMethod.IMPS]: "IMPS",
  [PayoutMethod.UPI]: "UPI",
};

export const PAYOUT_METHOD_CODES = Object.values(PayoutMethod) as PayoutMethod[];

// Financial year runs 1 April → 31 March. The code is the starting calendar
// year (e.g. 2026 = "FY 2026-27"). Stats are bucketed by FY via a dropdown, not
// reset/deleted — invoices can be paid up to ~18 months later (call decision).
export function financialYearOf(date: Date): number {
  // getUTCMonth() is 0-based; April = 3.
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  return month >= 3 ? year : year - 1;
}

export function financialYearLabel(fy: number): string {
  return `FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
}

// --- BDM CRM (bdm_prospect / bdm_activity / bdm_task) ----------------------
// Codes mirror the inline comments in prisma/sql/schema.sql. Order follows the
// cp-bdm-performance mock's dropdowns.

export const ProspectSource = {
  COLD_CALL: 0,
  INBOUND_INQUIRY: 1,
  REFERRAL: 2,
  EVENT: 3,
  LINKEDIN: 4,
  OTHER: 5,
} as const;
export type ProspectSource = (typeof ProspectSource)[keyof typeof ProspectSource];

export const ProspectSourceLabel: Record<ProspectSource, string> = {
  [ProspectSource.COLD_CALL]: "Cold Call",
  [ProspectSource.INBOUND_INQUIRY]: "Inbound Inquiry",
  [ProspectSource.REFERRAL]: "Referral",
  [ProspectSource.EVENT]: "Event / Exhibition",
  [ProspectSource.LINKEDIN]: "LinkedIn",
  [ProspectSource.OTHER]: "Other",
};

export const PROSPECT_SOURCE_CODES = Object.values(ProspectSource) as ProspectSource[];

// Pipeline order. LOST is terminal but not last-in-funnel: a lost prospect can
// be re-opened, which is why stage history records from/to.
export const ProspectStage = {
  LEAD: 0,
  CONTACTED: 1,
  MEETING_DONE: 2,
  PROPOSAL_SENT: 3,
  NEGOTIATION: 4,
  ONBOARDING: 5,
  LOST: 6,
} as const;
export type ProspectStage = (typeof ProspectStage)[keyof typeof ProspectStage];

export const ProspectStageLabel: Record<ProspectStage, string> = {
  [ProspectStage.LEAD]: "Lead",
  [ProspectStage.CONTACTED]: "Contacted",
  [ProspectStage.MEETING_DONE]: "Meeting Done",
  [ProspectStage.PROPOSAL_SENT]: "Proposal Sent",
  [ProspectStage.NEGOTIATION]: "Negotiation",
  [ProspectStage.ONBOARDING]: "Onboarding",
  [ProspectStage.LOST]: "Lost",
};

export const PROSPECT_STAGE_CODES = Object.values(ProspectStage) as ProspectStage[];

export const ProspectTemperature = {
  COLD: 0,
  WARM: 1,
  HOT: 2,
} as const;
export type ProspectTemperature = (typeof ProspectTemperature)[keyof typeof ProspectTemperature];

export const ProspectTemperatureLabel: Record<ProspectTemperature, string> = {
  [ProspectTemperature.COLD]: "Cold",
  [ProspectTemperature.WARM]: "Warm",
  [ProspectTemperature.HOT]: "Hot",
};

export const PROSPECT_TEMPERATURE_CODES = Object.values(ProspectTemperature) as ProspectTemperature[];

export const BdmActivityType = {
  CALL: 0,
  EMAIL: 1,
  MEETING: 2,
  NOTE: 3,
} as const;
export type BdmActivityType = (typeof BdmActivityType)[keyof typeof BdmActivityType];

export const BdmActivityTypeLabel: Record<BdmActivityType, string> = {
  [BdmActivityType.CALL]: "Phone Call",
  [BdmActivityType.EMAIL]: "Email",
  [BdmActivityType.MEETING]: "Meeting (In-person / Virtual)",
  [BdmActivityType.NOTE]: "Note / Update",
};

export const BDM_ACTIVITY_TYPE_CODES = Object.values(BdmActivityType) as BdmActivityType[];

// Distinct from NotePriority (Low/Medium/High): the BDM mock uses Normal and
// Urgent, and "Urgent" drives its own count on the tasks panel.
export const BdmTaskPriority = {
  LOW: 0,
  NORMAL: 1,
  URGENT: 2,
} as const;
export type BdmTaskPriority = (typeof BdmTaskPriority)[keyof typeof BdmTaskPriority];

export const BdmTaskPriorityLabel: Record<BdmTaskPriority, string> = {
  [BdmTaskPriority.LOW]: "Low",
  [BdmTaskPriority.NORMAL]: "Normal",
  [BdmTaskPriority.URGENT]: "Urgent",
};

export const BDM_TASK_PRIORITY_CODES = Object.values(BdmTaskPriority) as BdmTaskPriority[];

export const BdmTaskCategory = {
  FOLLOW_UP: 0,
  MEETING_CALL: 1,
  PROPOSAL_DOCUMENT: 2,
  ONBOARDING: 3,
  REVIEW_CHECK_IN: 4,
  OTHER: 5,
} as const;
export type BdmTaskCategory = (typeof BdmTaskCategory)[keyof typeof BdmTaskCategory];

export const BdmTaskCategoryLabel: Record<BdmTaskCategory, string> = {
  [BdmTaskCategory.FOLLOW_UP]: "Follow-up",
  [BdmTaskCategory.MEETING_CALL]: "Meeting / Call",
  [BdmTaskCategory.PROPOSAL_DOCUMENT]: "Proposal / Document",
  [BdmTaskCategory.ONBOARDING]: "Onboarding",
  [BdmTaskCategory.REVIEW_CHECK_IN]: "Review / Check-in",
  [BdmTaskCategory.OTHER]: "Other",
};

export const BDM_TASK_CATEGORY_CODES = Object.values(BdmTaskCategory) as BdmTaskCategory[];
