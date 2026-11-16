import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "~/env";
import { db } from "~/server/db";
import type { Prisma } from "../../generated/prisma";
import { UserStatus, UserType } from "~/server/db/enums";
import { createNotifications } from "~/server/notify";
import { appUrl, resourcePublishedEmail } from "~/server/email";
import { emailPartners } from "~/server/email/partners";
import { builtInPartnerTab, canGrantPartnerTab } from "~/lib/partner-tabs";
import {
  RESOURCE_FILE_TYPES,
  ResourceAudience,
  ResourceKind,
  type ResourceFileType,
  audienceLabel,
  todayIstIso,
} from "~/lib/resources";

// Resources library (Admin > Resources, Partner > Resources; 16 Nov 2026).
// The partner-side rules live here so the tRPC router, the file route
// (/api/resources/[id]) and Uni Assist all apply the same ones:
//   - audience: all partners / owners + independents / agency counsellors;
//   - live: not archived, publish_on <= today <= expires_on (India dates);
//   - a file resource needs at least one version.
//
// Publishing: the first time a resource is live it is "announced": the
// resource.published event (audit_log action RESOURCE_PUBLISHED_EVENT) is
// written once. If "Notify partners" is ticked, its audience gets a bell, and
// if it is also Important, an email. resource_notification records who had
// which, claimed per channel, so a re-save or a second sweep never resends.

// For the Partner Notices triggers (another session): one audit_log row per
// resource, entity_type "resource", when it first goes live.
export const RESOURCE_PUBLISHED_EVENT = "resource.published";

// ─── Dates ───────────────────────────────────────────────────────────────────

// A DATE column value for "YYYY-MM-DD" (Prisma maps DATE to UTC midnight).
export function dateFromIso(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function isoFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayIst(): Date {
  return dateFromIso(todayIstIso());
}

export type ResourceStatus = "scheduled" | "live" | "expired" | "archived";

export function resourceStatus(r: {
  archived_at: Date | null;
  publish_on: Date;
  expires_on: Date | null;
}): ResourceStatus {
  if (r.archived_at) return "archived";
  const today = todayIst().getTime();
  if (r.publish_on.getTime() > today) return "scheduled";
  if (r.expires_on && r.expires_on.getTime() < today) return "expired";
  return "live";
}

// ─── Who sees what ───────────────────────────────────────────────────────────

export function audiencesForUserType(type: number): number[] {
  return type === UserType.AGENCY_COUNSELLOR
    ? [ResourceAudience.ALL, ResourceAudience.AGENCY_COUNSELLORS]
    : [ResourceAudience.ALL, ResourceAudience.OWNERS_AND_INDEPENDENTS];
}

function userTypesForAudience(audience: number): number[] {
  if (audience === ResourceAudience.AGENCY_COUNSELLORS) return [UserType.AGENCY_COUNSELLOR];
  if (audience === ResourceAudience.OWNERS_AND_INDEPENDENTS) {
    return [UserType.AGENCY_OWNER, UserType.INDEPENDENT_COUNSELLOR];
  }
  return [UserType.AGENCY_OWNER, UserType.AGENCY_COUNSELLOR, UserType.INDEPENDENT_COUNSELLOR];
}

// Live resources: not archived, inside their dates, and (for a file) with a
// file. Shared by every partner read.
export function liveResourceWhere(): Prisma.resourceWhereInput {
  const today = todayIst();
  return {
    archived_at: null,
    publish_on: { lte: today },
    AND: [
      { OR: [{ expires_on: null }, { expires_on: { gte: today } }] },
      { OR: [{ kind: ResourceKind.LINK }, { versions: { some: {} } }] },
    ],
  };
}

// What one partner user may see: live, and meant for their type.
export function partnerResourceWhere(userType: number): Prisma.resourceWhereInput {
  return { ...liveResourceWhere(), audience: { in: audiencesForUserType(userType) } };
}

// ─── Files ───────────────────────────────────────────────────────────────────

const has = (buf: Buffer, s: string, enc: BufferEncoding = "latin1") =>
  buf.includes(Buffer.from(s, enc));

// The file's real type from its bytes. Office files are recognised by their
// container (ZIP for .docx/.pptx/.xlsx, OLE for .doc/.ppt/.xls) plus the part
// or stream that only that application writes. The extension must agree, so
// a renamed file is refused rather than served under the wrong type.
export function sniffResourceFile(buf: Buffer, fileName: string): ResourceFileType | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  let type: ResourceFileType | null = null;
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") type = "pdf";
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) type = "jpg";
  else if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    type = "png";
  } else if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    // ZIP: entry names are stored uncompressed in each local header.
    if (!has(buf, "[Content_Types].xml")) return null;
    if (has(buf, "word/document")) type = "docx";
    else if (has(buf, "ppt/presentation")) type = "pptx";
    else if (has(buf, "xl/workbook")) type = "xlsx";
  } else if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) {
    // OLE compound file: directory entry names are UTF-16LE.
    if (has(buf, "WordDocument", "utf16le")) type = "doc";
    else if (has(buf, "PowerPoint Document", "utf16le")) type = "ppt";
    else if (has(buf, "Workbook", "utf16le") || has(buf, "Book", "utf16le")) type = "xls";
  }
  if (!type) return null;
  return (RESOURCE_FILE_TYPES[type].exts as readonly string[]).includes(ext) ? type : null;
}

export function sanitizeResourceFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}

// The upload route stores the file, then hands the browser a signed receipt;
// resources.adminCreate / adminAddVersion accept a file only with a valid
// one, so a caller can't point a resource at an arbitrary stored object.
export interface UploadReceipt {
  url: string;
  fileName: string;
  mime: string;
  size: number;
  by: number;
  exp: number;
}

function sign(payload: string): string {
  return createHmac("sha256", `resource-upload:${env.AUTH_SECRET}`).update(payload).digest("base64url");
}

export function signUploadReceipt(r: Omit<UploadReceipt, "exp">): string {
  const payload = Buffer.from(
    JSON.stringify({ ...r, exp: Date.now() + 6 * 60 * 60 * 1000 }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyUploadReceipt(token: string, cpUserId: number): UploadReceipt | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const r = JSON.parse(Buffer.from(payload, "base64url").toString()) as UploadReceipt;
    if (r.by !== cpUserId || r.exp < Date.now()) return null;
    return r;
  } catch {
    return null;
  }
}

// ─── Announcing ──────────────────────────────────────────────────────────────

// Approved partner users in the audience who have the Resources tab:
// override ?? type default ?? built-in (~/lib/partner-tabs), resolved in bulk.
async function audienceUserIds(audience: number): Promise<number[]> {
  const types = userTypesForAudience(audience);
  const [users, defaults, overrides] = await Promise.all([
    db.user.findMany({
      where: { type: { in: types }, status: UserStatus.APPROVED, deleted_at: null },
      select: { id: true, type: true },
    }),
    db.cp_tab_default.findMany({
      where: { portal: "partner", tab: "resources" },
      select: { user_type: true, enabled: true },
    }),
    db.cp_tab_override.findMany({
      where: { tab: "resources", user_id: { not: null } },
      select: { user_id: true, enabled: true },
    }),
  ]);
  const typeOn = new Map(defaults.map((d) => [d.user_type, d.enabled === 1]));
  const userOn = new Map(overrides.map((o) => [o.user_id!, o.enabled === 1]));
  return users
    .filter((u) => {
      const on = userOn.get(u.id) ?? typeOn.get(u.type) ?? builtInPartnerTab(u.type, "resources");
      return on && canGrantPartnerTab(u.type, "resources");
    })
    .map((u) => u.id);
}

// Claims the given channel for every recipient not yet sent it, and returns
// the ones this call claimed (a concurrent call claims a disjoint set).
async function claim(resourceId: number, userIds: number[], channel: "bell" | "email"): Promise<number[]> {
  if (userIds.length === 0) return [];
  const batch = randomUUID();
  const now = new Date();
  await db.resource_notification.updateMany({
    where:
      channel === "bell"
        ? { resource_id: resourceId, user_id: { in: userIds }, bell_at: null }
        : { resource_id: resourceId, user_id: { in: userIds }, email_at: null },
    data: channel === "bell" ? { bell_at: now, bell_batch: batch } : { email_at: now, email_batch: batch },
  });
  const rows = await db.resource_notification.findMany({
    where: channel === "bell" ? { bell_batch: batch } : { email_batch: batch },
    select: { user_id: true },
  });
  return rows.map((r) => r.user_id);
}

export interface AnnounceResult {
  published: boolean;
  bells: number;
  emails: number;
}

// Idempotent: call after every save and from the sweep. Emails go out in the
// background (the bell rows are already written), so a large audience never
// holds up the admin's save.
export async function announceResource(resourceId: number): Promise<AnnounceResult> {
  const result: AnnounceResult = { published: false, bells: 0, emails: 0 };
  const r = await db.resource.findFirst({
    where: { id: resourceId, ...liveResourceWhere() },
    select: {
      id: true,
      title: true,
      description: true,
      audience: true,
      is_important: true,
      notify_partners: true,
      announced_at: true,
      category_id: true,
      university_id: true,
      publish_on: true,
      category: { select: { name: true } },
    },
  });
  if (!r) return result;

  if (!r.announced_at) {
    const won = await db.resource.updateMany({
      where: { id: r.id, announced_at: null },
      data: { announced_at: new Date() },
    });
    if (won.count === 1) {
      result.published = true;
      await db.audit_log.create({
        data: {
          action: RESOURCE_PUBLISHED_EVENT,
          entity_type: "resource",
          entity_id: r.id,
          metadata: {
            title: r.title,
            categoryId: r.category_id,
            category: r.category.name,
            audience: r.audience,
            important: r.is_important === 1,
            notified: r.notify_partners === 1,
            universityId: r.university_id,
            publishOn: isoFromDate(r.publish_on),
          },
        },
      });
    }
  }

  if (r.notify_partners !== 1) return result;

  const recipients = await audienceUserIds(r.audience);
  if (recipients.length === 0) return result;
  await db.resource_notification.createMany({
    data: recipients.map((user_id) => ({ resource_id: r.id, user_id })),
    skipDuplicates: true,
  });

  const link = `/partner/resources?r=${r.id}`;
  const bellIds = await claim(r.id, recipients, "bell");
  await createNotifications(bellIds, {
    type: "resource",
    title: r.is_important === 1 ? `Important: ${r.title}` : `New resource: ${r.title}`,
    body: r.description?.slice(0, 300) ?? `${r.category.name} · ${audienceLabel(r.audience)}`,
    link,
    tone: r.is_important === 1 ? "orange" : "blue",
  });
  result.bells = bellIds.length;

  if (r.is_important === 1) {
    const emailIds = await claim(r.id, recipients, "email");
    result.emails = emailIds.length;
    if (emailIds.length > 0) {
      const users = await db.user.findMany({
        where: { id: { in: emailIds } },
        select: {
          id: true,
          email: true,
          first_name: true,
          last_name: true,
          organization: { select: { name: true } },
        },
      });
      const url = `${appUrl().replace(/\/+$/, "")}${link}`;
      void emailPartners(
        users.map((u) => ({
          id: u.id,
          email: u.email,
          name: `${u.first_name} ${u.last_name}`.trim(),
          company: u.organization?.name ?? null,
        })),
        (p) =>
          resourcePublishedEmail(p, {
            title: r.title,
            description: r.description,
            category: r.category.name,
            url,
          }),
        `resource ${r.id} published`,
      ).catch((e) => console.error(`[resources] email for ${r.id} failed:`, e));
    }
  }
  return result;
}

// Resources whose publish date has arrived since they were saved. Run by
// /api/cron/resources and, throttled, whenever someone opens a Resources page,
// so a scheduled resource is announced even without a scheduler.
export async function announceDueResources(): Promise<{ announced: number }> {
  const due = await db.resource.findMany({
    where: { ...liveResourceWhere(), announced_at: null },
    select: { id: true },
    take: 200,
  });
  let announced = 0;
  for (const { id } of due) {
    try {
      if ((await announceResource(id)).published) announced++;
    } catch (e) {
      console.error(`[resources] announcing ${id} failed:`, e);
    }
  }
  return { announced };
}

let lastSweep = 0;
export function sweepDueResourcesSoon(): void {
  const now = Date.now();
  if (now - lastSweep < 5 * 60 * 1000) return;
  lastSweep = now;
  void announceDueResources().catch((e) => console.error("[resources] sweep failed:", e));
}
