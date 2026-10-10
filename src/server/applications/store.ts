import { db } from "~/server/db";
import { resolveStorageUrl } from "~/server/storage";
import {
  DocumentStatus,
  OrganizationType,
  UserStatus,
  UserType,
  counsellorRangeToCode,
  statusCodeFromLabel,
  statusLabelFromCode,
  volumeRangeToCode,
  type ApplicationStatus,
} from "~/server/db/enums";

export type { ApplicationStatus } from "~/server/db/enums";

export interface Application {
  applicationId: string;
  email: string;
  role: "agency" | "independent";
  firstName: string;
  lastName: string;
  phone: string;
  countryCode: string;
  companyName?: string;
  companyWebsite?: string;
  country?: string;
  state?: string;
  city?: string;
  companyAddress?: string;
  numCounselors?: string;
  annualVolume?: string;
  // Agency only. Undefined for organizations that predate the question being
  // asked — that's distinct from an explicit "no".
  gstRegistered?: boolean;
  documents?: Record<string, string>;
  status: ApplicationStatus;
  mouSignedAt?: string | null;
  submittedAt: string;
  updatedAt: string;
}

type ApplicationInput = Omit<
  Application,
  "applicationId" | "status" | "submittedAt" | "updatedAt"
> & {
  // Normalised and validated by the signup router (~/lib/utils/pan). Stored on
  // the organization for an agency, on the user for an independent.
  pan?: string;
};

function generateTrackingId(): string {
  return `#CP-${new Date().getFullYear()}-${String(
    Math.floor(Math.random() * 999999),
  ).padStart(6, "0")}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function randomSuffix(len = 6): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

// Trim → treat blank as null (columns like state/address are NOT NULL and can
// hold "", which we surface as null). `??`-friendly for the lint rule.
function blankToNull(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t && t.length > 0 ? t : null;
}

// First non-blank of the candidates, else null.
function firstNonBlank(
  ...values: (string | null | undefined)[]
): string | null {
  for (const v of values) {
    const t = blankToNull(v);
    if (t) return t;
  }
  return null;
}

// A slot name from signup ("companyPan", "aadhaar", etc.) → whether the doc
// belongs to the organization (true) or the user (false). Personal identity
// docs stay on the user even when uploaded during an agency signup.
const ORG_DOC_SLOTS = new Set([
  "companyPan",
  "cancelledCheque", // business bank account for agencies
  "partnershipDocs",
  "logo",
  "gst",
]);

function isOrgDoc(role: "agency" | "independent", slot: string): boolean {
  if (role === "independent") return false;
  return ORG_DOC_SLOTS.has(slot);
}

// TINYINT column, nullable: undefined means "never asked" and must not be
// written as 0 (which would claim the agency answered "not registered").
function boolToTinyint(value: boolean | undefined): number | null | undefined {
  return value === undefined ? undefined : value ? 1 : 0;
}

function fileNameFromUrl(url: string): string {
  const last = url.split("/").pop() ?? url;
  return last.split("?")[0] ?? last;
}

export async function saveApplication(input: ApplicationInput): Promise<Application> {
  const email = input.email.toLowerCase();

  return db.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });

    let orgId: number | null = null;

    if (input.role === "agency" && input.companyName) {
      if (existing?.org_id) {
        await tx.organization.update({
          where: { id: existing.org_id },
          data: {
            name: input.companyName,
            website: input.companyWebsite ?? null,
            address: input.companyAddress ?? null,
            city: input.city ?? null,
            state: input.state ?? null,
            country: input.country ?? null,
            num_counsellors: counsellorRangeToCode(input.numCounselors),
            annual_student_volume: volumeRangeToCode(input.annualVolume),
            gst_registered: boolToTinyint(input.gstRegistered),
            // Re-applying without a PAN keeps the one already on file.
            ...(input.pan ? { pan: input.pan } : {}),
          },
        });
        orgId = existing.org_id;
      } else {
        let urlIdentifier = slugify(input.companyName);
        if (!urlIdentifier) urlIdentifier = `org-${randomSuffix()}`;
        const taken = await tx.organization.findUnique({
          where: { url_identifier: urlIdentifier },
          select: { id: true },
        });
        if (taken) urlIdentifier = `${urlIdentifier}-${randomSuffix()}`;

        const newOrg = await tx.organization.create({
          data: {
            name: input.companyName,
            type: OrganizationType.AGENCY,
            url_identifier: urlIdentifier,
            website: input.companyWebsite ?? null,
            address: input.companyAddress ?? null,
            city: input.city ?? null,
            state: input.state ?? null,
            country: input.country ?? null,
            num_counsellors: counsellorRangeToCode(input.numCounselors),
            annual_student_volume: volumeRangeToCode(input.annualVolume),
            gst_registered: boolToTinyint(input.gstRegistered) ?? null,
            pan: input.pan ?? null,
            is_verified: 0,
          },
        });
        orgId = newOrg.id;
      }
    }

    const userType =
      input.role === "agency"
        ? UserType.AGENCY_OWNER
        : UserType.INDEPENDENT_COUNSELLOR;

    const baseUserFields = {
      first_name: input.firstName,
      last_name: input.lastName,
      phone: `${input.countryCode}${input.phone}`,
      type: userType,
      is_owner: input.role === "agency" ? 1 : 0,
      org_id: orgId,
      // user.address/city/state/country are NOT NULL. Agencies collect these in
      // the company step; the independent signup flow does NOT capture an address
      // yet, so those fall back to "" to satisfy the constraint. TODO: add an
      // address step to the independent flow to store real values.
      country: input.country ?? "",
      state: input.state ?? "",
      city: input.city ?? "",
      address: input.companyAddress ?? "",
      // BDMs are assigned internally after signup, never by the applicant, so
      // a re-application leaves any existing assignment alone.
      ...(input.role === "independent" && input.pan ? { pan: input.pan } : {}),
    };

    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: baseUserFields,
        })
      : await tx.user.create({
          data: {
            ...baseUserFields,
            email,
            tracking_id: generateTrackingId(),
            status: UserStatus.UNDER_REVIEW,
            is_email_verified: 1,
            is_phone_verified: 1,
          },
        });

    if (input.documents) {
      await tx.document.deleteMany({ where: { user_id: user.id } });
      if (orgId) {
        await tx.document.deleteMany({ where: { org_id: orgId } });
      }

      const rows = Object.entries(input.documents)
        .filter(([, url]) => !!url)
        .map(([slot, url]) => {
          const orgDoc = isOrgDoc(input.role, slot);
          return {
            file_name: fileNameFromUrl(url),
            file_url: url,
            doc_type: slot,
            status: DocumentStatus.PENDING,
            is_org_document: orgDoc ? 1 : 0,
            user_id: orgDoc ? null : user.id,
            org_id: orgDoc ? orgId : null,
          };
        });

      if (rows.length) {
        await tx.document.createMany({ data: rows });
      }

      if (orgId && input.documents.logo) {
        await tx.organization.update({
          where: { id: orgId },
          data: { logo_url: input.documents.logo },
        });
      }
    }

    return toApplication(user, orgId, input);
  });
}

export async function getApplicationByEmail(
  email: string,
): Promise<Application | null> {
  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    include: {
      organization: true,
      document: true,
    },
  });
  if (!user) return null;

  const docs: Record<string, string> = {};
  for (const d of user.document) docs[d.doc_type] = resolveStorageUrl(d.file_url);

  // Also pull documents linked to the org (for agencies)
  if (user.org_id) {
    const orgDocs = await db.document.findMany({
      where: { org_id: user.org_id },
    });
    for (const d of orgDocs) docs[d.doc_type] = resolveStorageUrl(d.file_url);
  }

  const role: "agency" | "independent" =
    user.type === UserType.AGENCY_OWNER ? "agency" : "independent";

  const countryCode = user.phone.startsWith("+")
    ? user.phone.slice(0, user.phone.length - 10)
    : "";
  const phone = user.phone.replace(countryCode, "");

  return {
    applicationId: user.tracking_id ?? "",
    email: user.email,
    role,
    firstName: user.first_name,
    lastName: user.last_name,
    phone,
    countryCode,
    companyName: user.organization?.name,
    companyWebsite: user.organization?.website ?? undefined,
    country: user.country ?? user.organization?.country ?? undefined,
    state: user.state ?? user.organization?.state ?? undefined,
    city: user.city ?? user.organization?.city ?? undefined,
    companyAddress: user.organization?.address ?? undefined,
    gstRegistered:
      user.organization?.gst_registered == null
        ? undefined
        : user.organization.gst_registered === 1,
    documents: Object.keys(docs).length ? docs : undefined,
    status: statusLabelFromCode(user.status),
    mouSignedAt: user.mou_signed_at?.toISOString() ?? null,
    submittedAt: user.created_at.toISOString(),
    updatedAt: user.updated_at.toISOString(),
  };
}

export async function markMouSigned(userId: number): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { mou_signed_at: new Date() },
  });
}

export async function recordPartnerLogin(userId: number): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { last_login_at: new Date() },
  });
}

// Document status flag exposed to the admin UI. Mirrors DocumentStatus but as
// strings so the API surface doesn't leak the integer codes.
export type PartnerDocStatus = "pending" | "approved" | "rejected";

export interface PartnerDocument {
  id: number;
  type: string;
  url: string;
  fileName: string;
  status: PartnerDocStatus;
}

export interface PartnerListing {
  applicationId: string;
  email: string;
  role: "agency" | "independent";
  firstName: string;
  lastName: string;
  phone: string;
  countryCode: string;
  companyName?: string;
  city?: string;
  status: ApplicationStatus;
  submittedAt: string;
  updatedAt: string;
  documents: PartnerDocument[];
  // Partner-management extras surfaced in the table + detail slide-over.
  tier: number;
  bdmId: number | null;
  bdmName: string | null;
  pan: string | null;
  gstNumber: string | null;
  // null = the agency was never asked (predates the signup question).
  gstRegistered: boolean | null;
  statusReason: string | null;
  website: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  numCounsellors: number | null;
  annualStudentVolume: number | null;
  mouSignedAt: string | null;
  lastLoginAt: string | null;
}

function mapDocStatus(code: number): PartnerDocStatus {
  if (code === DocumentStatus.APPROVED) return "approved";
  if (code === DocumentStatus.REJECTED) return "rejected";
  return "pending";
}

// Lists partner applications (any user that isn't an admin). Documents are
// included with id + status so the admin UI can render Verify / Reject
// controls per document without an extra round-trip.
export async function listApplications(): Promise<PartnerListing[]> {
  const users = await db.user.findMany({
    where: { type: { not: UserType.ADMIN } },
    orderBy: { created_at: "desc" },
    take: 500, // M6: defensive cap until cursor pagination lands
    include: {
      organization: true,
      document: true,
      collegepond_user_user_bdm_idTocollegepond_user: {
        select: { first_name: true, last_name: true },
      },
    },
  });

  const orgIds = users
    .map((u) => u.org_id)
    .filter((v): v is number => v !== null);

  const orgDocs = orgIds.length
    ? await db.document.findMany({ where: { org_id: { in: orgIds } } })
    : [];
  const orgDocsByOrgId = new Map<number, typeof orgDocs>();
  for (const d of orgDocs) {
    if (d.org_id == null) continue;
    const list = orgDocsByOrgId.get(d.org_id) ?? [];
    list.push(d);
    orgDocsByOrgId.set(d.org_id, list);
  }

  return users.map((user) => {
    const documents: PartnerDocument[] = [];
    for (const d of user.document) {
      documents.push({
        id: d.id,
        type: d.doc_type,
        url: resolveStorageUrl(d.file_url),
        fileName: d.file_name,
        status: mapDocStatus(d.status),
      });
    }
    if (user.org_id) {
      for (const d of orgDocsByOrgId.get(user.org_id) ?? []) {
        documents.push({
          id: d.id,
          type: d.doc_type,
          url: resolveStorageUrl(d.file_url),
          fileName: d.file_name,
          status: mapDocStatus(d.status),
        });
      }
    }

    const role: "agency" | "independent" =
      user.type === UserType.AGENCY_OWNER ? "agency" : "independent";

    const countryCode = user.phone.startsWith("+")
      ? user.phone.slice(0, user.phone.length - 10)
      : "";
    const phone = user.phone.replace(countryCode, "");

    const bdm = user.collegepond_user_user_bdm_idTocollegepond_user;

    return {
      applicationId: user.tracking_id ?? "",
      email: user.email,
      role,
      firstName: user.first_name,
      lastName: user.last_name,
      phone,
      countryCode,
      companyName: user.organization?.name ?? undefined,
      city: user.city ?? user.organization?.city ?? undefined,
      status: statusLabelFromCode(user.status),
      submittedAt: user.created_at.toISOString(),
      updatedAt: user.updated_at.toISOString(),
      documents,
      tier: user.tier,
      bdmId: user.bdm_id,
      bdmName: bdm ? `${bdm.first_name} ${bdm.last_name}`.trim() : null,
      pan:
        role === "agency"
          ? (user.organization?.pan ?? null)
          : blankToNull(user.pan),
      gstNumber: user.organization?.gst_number ?? null,
      gstRegistered:
        user.organization?.gst_registered == null
          ? null
          : user.organization.gst_registered === 1,
      statusReason: user.status_reason,
      website: user.organization?.website ?? null,
      state: firstNonBlank(user.state, user.organization?.state),
      country: firstNonBlank(user.country, user.organization?.country),
      address: firstNonBlank(user.address, user.organization?.address),
      numCounsellors: user.organization?.num_counsellors ?? null,
      annualStudentVolume: user.organization?.annual_student_volume ?? null,
      mouSignedAt: user.mou_signed_at?.toISOString() ?? null,
      lastLoginAt: user.last_login_at?.toISOString() ?? null,
    };
  });
}

export async function setDocumentStatus(
  documentId: number,
  status: PartnerDocStatus,
): Promise<void> {
  const code =
    status === "approved"
      ? DocumentStatus.APPROVED
      : status === "rejected"
        ? DocumentStatus.REJECTED
        : DocumentStatus.PENDING;
  await db.document.update({
    where: { id: documentId },
    data: { status: code },
  });
}

export async function setApplicationStatus(
  email: string,
  status: ApplicationStatus,
  reason?: string | null,
): Promise<Application | null> {
  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true },
  });
  if (!user) return null;

  // Only rejected/inactive carry a reason; clear it on approve/reactivate so a
  // stale reason never lingers on a now-active partner.
  const keepsReason = status === "rejected" || status === "inactive";
  await db.user.update({
    where: { id: user.id },
    data: {
      status: statusCodeFromLabel(status),
      status_reason: keepsReason ? blankToNull(reason) : null,
    },
  });

  return getApplicationByEmail(email);
}

// Set a partner's tier (0=Silver … 4=Diamond — see TIER_LABELS in the UI).
export async function setPartnerTier(
  email: string,
  tier: number,
): Promise<void> {
  await db.user.update({
    where: { email: email.toLowerCase() },
    data: { tier },
  });
}

// Reassign (or clear) the BDM (a cp_user) who owns this partner relationship.
export async function setPartnerBdm(
  email: string,
  bdmId: number | null,
): Promise<void> {
  await db.user.update({
    where: { email: email.toLowerCase() },
    data: { bdm_id: bdmId },
  });
}

// The partner's PAN holder rule: an agency owner enters the company / firm /
// proprietor PAN, an independent counsellor their personal one.
export async function partnerPanHolder(
  email: string,
): Promise<"agency" | "individual" | null> {
  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { type: true },
  });
  if (!user) return null;
  return user.type === UserType.AGENCY_OWNER ? "agency" : "individual";
}

// Update a partner's PAN: on the linked organization for an agency, on the
// user row for an independent. `pan` must already be validated (~/lib/utils/pan).
export async function setPartnerPan(
  email: string,
  pan: string | null,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, type: true, org_id: true },
  });
  if (!user) return false;
  if (user.type === UserType.AGENCY_OWNER) {
    if (!user.org_id) return false;
    await db.organization.update({
      where: { id: user.org_id },
      data: { pan: blankToNull(pan) },
    });
  } else {
    await db.user.update({ where: { id: user.id }, data: { pan: blankToNull(pan) } });
  }
  return true;
}

function toApplication(
  user: { id: number; email: string; tracking_id: string | null; status: number; created_at: Date; updated_at: Date; type: number; first_name: string; last_name: string },
  _orgId: number | null,
  input: ApplicationInput,
): Application {
  return {
    applicationId: user.tracking_id ?? "",
    email: user.email,
    role: input.role,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    countryCode: input.countryCode,
    companyName: input.companyName,
    companyWebsite: input.companyWebsite,
    country: input.country,
    state: input.state,
    city: input.city,
    companyAddress: input.companyAddress,
    numCounselors: input.numCounselors,
    annualVolume: input.annualVolume,
    gstRegistered: input.gstRegistered,
    documents: input.documents,
    status: statusLabelFromCode(user.status),
    submittedAt: user.created_at.toISOString(),
    updatedAt: user.updated_at.toISOString(),
  };
}
