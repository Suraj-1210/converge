import { TRPCError } from "@trpc/server";
import { db } from "~/server/db";
import { resolveStorageUrl } from "~/server/storage";
import { partnerTierStatuses, serializeStatus } from "~/server/partner-tiers";
import { type TierStatusView } from "~/lib/partner-tiers";
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

// Files a NEW partner application. Never updates an existing account: it
// used to upsert by email, so an agency counsellor who later filled in the
// public signup form was silently turned into an Independent Counsellor (or
// into an owner who renamed their agency and wiped its documents). The signup
// router refuses registered emails/phones first; this is the backstop.
export async function saveApplication(input: ApplicationInput): Promise<Application> {
  const email = input.email.toLowerCase();
  // An agency owner without an organization would be an orphan owner.
  if (input.role === "agency" && !input.companyName?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Company name is required for an agency." });
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "An account with this email already exists. Please log in to check your application status.",
      });
    }

    let orgId: number | null = null;

    if (input.role === "agency" && input.companyName) {
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
      // No bdm_id: BDMs are assigned internally after signup, never by the
      // applicant.
      ...(input.role === "independent" && input.pan ? { pan: input.pan } : {}),
    };

    const user = await tx.user.create({
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
      // The signup profile photo is also the account's avatar (shown in the
      // portal header and on the admin side), not just a document.
      if (input.documents.profilePhoto) {
        await tx.user.update({
          where: { id: user.id },
          data: { avatar_url: input.documents.profilePhoto },
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
  // A counsellor their agency removed can no longer sign in.
  if (!user || user.deleted_at) return null;

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

export async function markMouSigned(
  userId: number,
  signature: {
    signedAt: Date;
    kind: number;
    data: string;
    signerName: string;
    ip: string | null;
    version: string;
    pdfUrl: string;
  },
): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: {
      mou_signed_at: signature.signedAt,
      mou_pdf_url: signature.pdfUrl,
      mou_signature: signature.data,
      mou_signature_kind: signature.kind,
      mou_signer_name: signature.signerName.slice(0, 101),
      mou_signed_ip: signature.ip?.slice(0, 45) ?? null,
      mou_version: signature.version,
    },
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
  userId: number;
  // Partner Tiers: this FY's tier (automatic, or a Super Admin floor).
  tier: TierStatusView | null;
  bdmId: number | null;
  bdmName: string | null;
  pan: string | null;
  // Display images, already resolved for the browser (null when none).
  avatarUrl: string | null;
  logoUrl: string | null;
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

// Lists partner applications (agency owners and independents). Documents are
// included with id + status so the admin UI can render Verify / Reject
// controls per document without an extra round-trip. Only current documents
// (is_most_recent) — a file an admin replaced is kept but not listed.
export async function listApplications(): Promise<PartnerListing[]> {
  const users = await db.user.findMany({
    // Agency counsellors are not partners in their own right: they're
    // reviewed on Counselor Approvals and belong to their agency's record.
    where: { type: { notIn: [UserType.ADMIN, UserType.AGENCY_COUNSELLOR] } },
    orderBy: { created_at: "desc" },
    take: 500, // M6: defensive cap until cursor pagination lands
    include: {
      organization: true,
      document: { where: { is_most_recent: 1 } },
      collegepond_user_user_bdm_idTocollegepond_user: {
        select: { first_name: true, last_name: true },
      },
    },
  });

  const orgIds = users
    .map((u) => u.org_id)
    .filter((v): v is number => v !== null);

  const tierStatuses = await partnerTierStatuses(
    users.map((u) => ({
      userId: u.id,
      orgId: u.type === UserType.AGENCY_OWNER ? u.org_id : null,
    })),
  );

  const orgDocs = orgIds.length
    ? await db.document.findMany({ where: { org_id: { in: orgIds }, is_most_recent: 1 } })
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
      userId: user.id,
      tier: (() => {
        const t = tierStatuses.get(user.id);
        return t ? serializeStatus(t) : null;
      })(),
      bdmId: user.bdm_id,
      bdmName: bdm ? `${bdm.first_name} ${bdm.last_name}`.trim() : null,
      pan:
        role === "agency"
          ? (user.organization?.pan ?? null)
          : blankToNull(user.pan),
      avatarUrl: resolveStorageUrl(user.avatar_url),
      logoUrl: resolveStorageUrl(user.organization?.logo_url),
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

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

// Approving a partner verifies its documents: every current (is_most_recent)
// document still pending review — personal ones, plus the company's for an
// agency owner — moves to approved, with a partner.documents_approved audit
// entry. Rejected documents stay rejected. Every path where Collegepond
// approves a partner or counsellor calls this in the same transaction as the
// status change, so both happen or neither does. Returns how many changed.
export async function approvePendingPartnerDocuments(
  tx: Tx,
  user: { id: number; type: number; org_id: number | null },
  audit: { byCpUserId: number; reason: string },
): Promise<number> {
  const ownsOrgDocs = user.type === UserType.AGENCY_OWNER && user.org_id != null;
  const pending = await tx.document.findMany({
    where: {
      status: DocumentStatus.PENDING,
      is_most_recent: 1,
      student_id: null,
      OR: [
        { user_id: user.id },
        ...(ownsOrgDocs ? [{ org_id: user.org_id }] : []),
      ],
    },
    select: { id: true, doc_type: true },
  });
  if (pending.length === 0) return 0;
  const { count } = await tx.document.updateMany({
    where: { id: { in: pending.map((d) => d.id) }, status: DocumentStatus.PENDING },
    data: { status: DocumentStatus.APPROVED },
  });
  await tx.audit_log.create({
    data: {
      user_id: user.id,
      org_id: user.org_id,
      action: "partner.documents_approved",
      entity_type: "user",
      entity_id: user.id,
      metadata: {
        reason: audit.reason,
        documentIds: pending.map((d) => d.id),
        docTypes: pending.map((d) => d.doc_type),
        byCpUserId: audit.byCpUserId,
      },
    },
  });
  return count;
}

export async function setApplicationStatus(
  email: string,
  status: ApplicationStatus,
  reason: string | null,
  byCpUserId: number,
): Promise<Application | null> {
  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, type: true, org_id: true, status: true },
  });
  if (!user) return null;

  // Only rejected/inactive carry a reason; clear it on approve/reactivate so a
  // stale reason never lingers on a now-active partner.
  const keepsReason = status === "rejected" || status === "inactive";
  const to = statusCodeFromLabel(status);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        status: to,
        status_reason: keepsReason ? blankToNull(reason) : null,
      },
    });
    await tx.audit_log.create({
      data: {
        user_id: user.id,
        org_id: user.org_id,
        action: "partner.status_updated",
        entity_type: "user",
        entity_id: user.id,
        metadata: {
          from: statusLabelFromCode(user.status),
          to: status,
          reason: keepsReason ? blankToNull(reason) : null,
          byCpUserId,
        },
      },
    });

    // Approving (or reactivating into approved) verifies the partner's pending
    // documents; declining or deactivating leaves documents as they are.
    if (to === UserStatus.APPROVED) {
      await approvePendingPartnerDocuments(tx, user, {
        byCpUserId,
        reason: "Approved with the partner",
      });
    }
  });

  return getApplicationByEmail(email);
}

// A partner's tier is no longer set here: it's computed from the Partner
// Tiers master, with a Super Admin override (routers/partner-tiers.ts).
// user.tier is frozen and no longer written.

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
