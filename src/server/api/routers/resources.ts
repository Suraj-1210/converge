import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  adminSectionProcedure,
  createTRPCRouter,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { type Prisma } from "generated/prisma";
import { AdminRole } from "~/server/db/enums";
import { bdmUserScope, isCounsellingRole, staffPartnerScope } from "~/server/staff-access";
import {
  announceResource,
  dateFromIso,
  isoFromDate,
  partnerResourceWhere,
  resourceStatus,
  sweepDueResourcesSoon,
  verifyUploadReceipt,
} from "~/server/resources";
import { resolveStorageUrl } from "~/server/storage";
import { ResourceAudience, ResourceKind, isNewResource } from "~/lib/resources";

// Resources library (16 Nov 2026).
//
// admin*   Admin > Resources: the "resources" tab (adminSectionProcedure, plus
//          "resources.admin*" in API_SECTIONS). Built-in for Super Admin and
//          BDM; a Super Admin can switch it on for other roles.
// partner* Partner > Resources and the Uni Assist "Brochures & resources"
//          popover: the partner "resources" tab ("resources.partner*" in
//          API_TABS). Audience and publish / expiry dates are enforced here
//          (partnerResourceWhere), not in the page.
//
// Files are uploaded through /api/resources/upload, which returns a signed
// receipt; opening a file or link goes through /api/resources/[id], which
// re-checks visibility and logs it in resource_download.

const resourcesAdmin = adminSectionProcedure("resources");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");

const fields = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title is too long"),
  description: z.string().trim().max(2000, "Description is too long").optional().nullable(),
  categoryId: z.number().int().positive(),
  universityId: z.number().int().positive().nullable().optional(),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Pick a country")
    .transform((s) => s.toUpperCase())
    .nullable()
    .optional(),
  audience: z.nativeEnum(ResourceAudience),
  linkUrl: z
    .string()
    .trim()
    .max(1000, "Link is too long")
    .url("Enter a full link, starting with https://")
    .refine((s) => /^https?:\/\//i.test(s), "Enter a full link, starting with https://")
    .nullable()
    .optional(),
  publishOn: isoDate,
  expiresOn: isoDate.nullable().optional(),
  pinned: z.boolean(),
  important: z.boolean(),
  notify: z.boolean(),
});

type Fields = z.infer<typeof fields>;

async function checkFields(f: Fields, kind: number, opts: { categoryId?: number } = {}) {
  if (f.expiresOn && f.expiresOn < f.publishOn) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The expiry date must be on or after the publish date." });
  }
  if (kind === ResourceKind.LINK && !f.linkUrl) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the link." });
  }
  const cat = await db.resource_category.findUnique({
    where: { id: f.categoryId },
    select: { is_active: true },
  });
  // A resource already filed under a now-inactive category may keep it.
  if (!cat || (cat.is_active !== 1 && opts.categoryId !== f.categoryId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Pick an active category." });
  }
  if (f.universityId) {
    const uni = await db.university.findUnique({ where: { id: f.universityId }, select: { id: true } });
    if (!uni) throw new TRPCError({ code: "BAD_REQUEST", message: "University not found." });
  }
}

function columns(f: Fields, kind: number) {
  return {
    title: f.title,
    description: f.description?.trim() ? f.description.trim() : null,
    category_id: f.categoryId,
    university_id: f.universityId ?? null,
    country: f.country ?? null,
    audience: f.audience,
    link_url: kind === ResourceKind.LINK ? (f.linkUrl ?? null) : null,
    publish_on: dateFromIso(f.publishOn),
    expires_on: f.expiresOn ? dateFromIso(f.expiresOn) : null,
    is_pinned: f.pinned ? 1 : 0,
    is_important: f.important ? 1 : 0,
    notify_partners: f.notify ? 1 : 0,
  };
}

function receiptOrThrow(token: string, cpUserId: number) {
  const r = verifyUploadReceipt(token, cpUserId);
  if (!r) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The upload has expired. Please choose the file again." });
  }
  return r;
}

// Announce after a save; a failure here must not undo the save.
async function announceQuietly(id: number) {
  try {
    return await announceResource(id);
  } catch (e) {
    console.error(`[resources] announce ${id} failed:`, e);
    return null;
  }
}

async function cpUserNames(ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.collegepond_user.findMany({
    where: { id: { in: unique } },
    select: { id: true, first_name: true, last_name: true },
  });
  return new Map(rows.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]));
}

async function universityMap(ids: (number | null)[]) {
  const unique = [...new Set(ids.filter((x): x is number => x != null))];
  if (unique.length === 0) return new Map<number, { id: number; name: string; country: string; logoUrl: string | null }>();
  const rows = await db.university.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, country: true, logo_url: true },
  });
  return new Map(
    rows.map((u) => [u.id, { id: u.id, name: u.name, country: u.country, logoUrl: resolveStorageUrl(u.logo_url) }]),
  );
}

// Partner users whose downloads this staff user may see by name: a BDM their
// own partners, a counsellor role their own; others everyone. Switching the
// tab on never widens whose data someone sees.
async function downloaderScope(user: { id: number; role: number }): Promise<Prisma.userWhereInput> {
  if (user.role === AdminRole.BDM) return bdmUserScope(user);
  if (isCounsellingRole(user.role)) return staffPartnerScope(user);
  return {};
}

const latestVersion = { orderBy: { version_no: "desc" as const }, take: 1 };

const versionSelect = {
  id: true,
  version_no: true,
  file_name: true,
  mime_type: true,
  size_bytes: true,
} as const;

async function partnerType(userId: number): Promise<number> {
  const me = await db.user.findUnique({ where: { id: userId }, select: { type: true } });
  if (!me) throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
  return me.type;
}

export const resourcesRouter = createTRPCRouter({
  // ─── Admin ────────────────────────────────────────────────────────────────

  adminCategories: resourcesAdmin.query(async () => {
    const rows = await db.resource_category.findMany({
      orderBy: [{ sort_order: "asc" }, { name: "asc" }],
      select: { id: true, name: true, is_active: true },
    });
    return rows.map((c) => ({ id: c.id, name: c.name, active: c.is_active === 1 }));
  }),

  adminUniversities: resourcesAdmin.query(async () => {
    const rows = await db.university.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, country: true },
    });
    return rows;
  }),

  adminList: resourcesAdmin.query(async () => {
    sweepDueResourcesSoon();
    const rows = await db.resource.findMany({
      orderBy: [{ is_pinned: "desc" }, { publish_on: "desc" }, { id: "desc" }],
      include: {
        category: { select: { id: true, name: true } },
        versions: { ...latestVersion, select: versionSelect },
      },
    });
    const ids = rows.map((r) => r.id);
    const [totals, perUser, unis] = await Promise.all([
      ids.length
        ? db.resource_download.groupBy({ by: ["resource_id"], where: { resource_id: { in: ids } }, _count: { _all: true } })
        : [],
      ids.length
        ? db.resource_download.groupBy({ by: ["resource_id", "user_id"], where: { resource_id: { in: ids } } })
        : [],
      universityMap(rows.map((r) => r.university_id)),
    ]);
    const total = new Map(totals.map((t) => [t.resource_id, t._count._all]));
    const unique = new Map<number, number>();
    for (const u of perUser) unique.set(u.resource_id, (unique.get(u.resource_id) ?? 0) + 1);
    return rows.map((r) => {
      const v = r.versions[0];
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        university: r.university_id ? (unis.get(r.university_id) ?? null) : null,
        country: r.country,
        audience: r.audience,
        kind: r.kind,
        linkUrl: r.link_url,
        publishOn: isoFromDate(r.publish_on),
        expiresOn: r.expires_on ? isoFromDate(r.expires_on) : null,
        pinned: r.is_pinned === 1,
        important: r.is_important === 1,
        notify: r.notify_partners === 1,
        announced: r.announced_at != null,
        status: resourceStatus(r),
        file: v
          ? { versionId: v.id, version: v.version_no, name: v.file_name, mime: v.mime_type, size: v.size_bytes }
          : null,
        downloads: total.get(r.id) ?? 0,
        downloaders: unique.get(r.id) ?? 0,
        updatedAt: r.updated_at,
      };
    });
  }),

  // One resource: its versions (every upload, with who uploaded it and how
  // often each was opened) and who opened it.
  adminGet: resourcesAdmin
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const r = await db.resource.findUnique({
        where: { id: input.id },
        include: {
          category: { select: { id: true, name: true } },
          versions: { orderBy: { version_no: "desc" } },
        },
      });
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Resource not found." });

      const scope = await downloaderScope(ctx.cpUser);
      const [byVersion, byUser, notified] = await Promise.all([
        db.resource_download.groupBy({
          by: ["version_id"],
          where: { resource_id: r.id },
          _count: { _all: true },
        }),
        db.resource_download.groupBy({
          by: ["user_id"],
          where: { resource_id: r.id },
          _count: { _all: true },
          _max: { created_at: true },
        }),
        db.resource_notification.aggregate({
          where: { resource_id: r.id },
          _count: { bell_at: true, email_at: true },
        }),
      ]);
      const users = byUser.length
        ? await db.user.findMany({
            where: { AND: [{ id: { in: byUser.map((u) => u.user_id) } }, scope] },
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
              type: true,
              organization: { select: { name: true } },
            },
          })
        : [];
      const userById = new Map(users.map((u) => [u.id, u]));
      const names = await cpUserNames([
        r.created_by_cp_user_id,
        ...(r.updated_by_cp_user_id ? [r.updated_by_cp_user_id] : []),
        ...r.versions.map((v) => v.uploaded_by_cp_user_id),
      ]);
      const versionCount = new Map(byVersion.map((v) => [v.version_id, v._count._all]));
      const versionNo = new Map(r.versions.map((v) => [v.id, v.version_no]));
      const unis = await universityMap([r.university_id]);

      const downloaders = byUser
        .filter((u) => userById.has(u.user_id))
        .map((u) => {
          const p = userById.get(u.user_id)!;
          return {
            userId: p.id,
            name: `${p.first_name} ${p.last_name}`.trim(),
            email: p.email,
            type: p.type,
            organization: p.organization?.name ?? null,
            count: u._count._all,
            lastAt: u._max.created_at,
          };
        })
        .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));

      return {
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        university: r.university_id ? (unis.get(r.university_id) ?? null) : null,
        universityId: r.university_id,
        country: r.country,
        audience: r.audience,
        kind: r.kind,
        linkUrl: r.link_url,
        publishOn: isoFromDate(r.publish_on),
        expiresOn: r.expires_on ? isoFromDate(r.expires_on) : null,
        pinned: r.is_pinned === 1,
        important: r.is_important === 1,
        notify: r.notify_partners === 1,
        announcedAt: r.announced_at,
        archivedAt: r.archived_at,
        status: resourceStatus(r),
        createdBy: names.get(r.created_by_cp_user_id) ?? null,
        createdAt: r.created_at,
        updatedBy: r.updated_by_cp_user_id ? (names.get(r.updated_by_cp_user_id) ?? null) : null,
        updatedAt: r.updated_at,
        versions: r.versions.map((v, i) => ({
          id: v.id,
          version: v.version_no,
          current: i === 0,
          fileName: v.file_name,
          mime: v.mime_type,
          size: v.size_bytes,
          uploadedBy: names.get(v.uploaded_by_cp_user_id) ?? null,
          uploadedAt: v.created_at,
          restoredFrom: v.restored_from_id ? (versionNo.get(v.restored_from_id) ?? null) : null,
          opens: versionCount.get(v.id) ?? 0,
        })),
        totalOpens: byUser.reduce((s, u) => s + u._count._all, 0),
        totalDownloaders: byUser.length,
        hiddenDownloaders: byUser.length - downloaders.length,
        linkOpens: versionCount.get(null) ?? 0,
        downloaders,
        notifiedBell: notified._count.bell_at,
        notifiedEmail: notified._count.email_at,
      };
    }),

  adminCreate: resourcesAdmin
    .input(
      fields.extend({
        kind: z.nativeEnum(ResourceKind),
        upload: z.string().max(4000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await checkFields(input, input.kind);
      const file = input.kind === ResourceKind.FILE ? (input.upload ? receiptOrThrow(input.upload, ctx.cpUser.id) : null) : null;
      if (input.kind === ResourceKind.FILE && !file) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a file to upload." });
      }
      const r = await db.resource.create({
        data: {
          ...columns(input, input.kind),
          kind: input.kind,
          created_by_cp_user_id: ctx.cpUser.id,
          ...(file
            ? {
                versions: {
                  create: {
                    version_no: 1,
                    file_url: file.url,
                    file_name: file.fileName,
                    mime_type: file.mime,
                    size_bytes: file.size,
                    uploaded_by_cp_user_id: ctx.cpUser.id,
                  },
                },
              }
            : {}),
        },
      });
      await db.audit_log.create({
        data: {
          action: "resource.created",
          entity_type: "resource",
          entity_id: r.id,
          metadata: { byCpUserId: ctx.cpUser.id, title: r.title, kind: r.kind, audience: r.audience },
        },
      });
      const announced = await announceQuietly(r.id);
      return { id: r.id, announced };
    }),

  // Edit the details. Ticking "Notify partners" (or "Important") on a live
  // resource notifies whoever hasn't had that channel yet; nobody twice.
  adminUpdate: resourcesAdmin
    .input(fields.extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const before = await db.resource.findUnique({ where: { id: input.id } });
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Resource not found." });
      await checkFields(input, before.kind, { categoryId: before.category_id });
      const r = await db.resource.update({
        where: { id: input.id },
        data: { ...columns(input, before.kind), updated_by_cp_user_id: ctx.cpUser.id },
      });
      await db.audit_log.create({
        data: {
          action: "resource.updated",
          entity_type: "resource",
          entity_id: r.id,
          metadata: {
            byCpUserId: ctx.cpUser.id,
            before: {
              title: before.title,
              audience: before.audience,
              publishOn: isoFromDate(before.publish_on),
              expiresOn: before.expires_on ? isoFromDate(before.expires_on) : null,
            },
            after: {
              title: r.title,
              audience: r.audience,
              publishOn: isoFromDate(r.publish_on),
              expiresOn: r.expires_on ? isoFromDate(r.expires_on) : null,
            },
          },
        },
      });
      const announced = await announceQuietly(r.id);
      return { id: r.id, announced };
    }),

  // Replace the file: a new version; partners get it from now on. Doesn't
  // notify anyone again.
  adminAddVersion: resourcesAdmin
    .input(z.object({ id: z.number().int().positive(), upload: z.string().max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const file = receiptOrThrow(input.upload, ctx.cpUser.id);
      const r = await db.resource.findUnique({ where: { id: input.id }, select: { id: true, kind: true } });
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Resource not found." });
      if (r.kind !== ResourceKind.FILE) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A link resource has no file." });
      }
      const v = await db.$transaction(async (tx) => {
        const max = await tx.resource_version.aggregate({ where: { resource_id: r.id }, _max: { version_no: true } });
        const created = await tx.resource_version.create({
          data: {
            resource_id: r.id,
            version_no: (max._max.version_no ?? 0) + 1,
            file_url: file.url,
            file_name: file.fileName,
            mime_type: file.mime,
            size_bytes: file.size,
            uploaded_by_cp_user_id: ctx.cpUser.id,
          },
        });
        await tx.resource.update({ where: { id: r.id }, data: { updated_by_cp_user_id: ctx.cpUser.id } });
        return created;
      });
      await db.audit_log.create({
        data: {
          action: "resource.version_added",
          entity_type: "resource",
          entity_id: r.id,
          metadata: { byCpUserId: ctx.cpUser.id, version: v.version_no, fileName: v.file_name },
        },
      });
      // The first file of a resource saved without one makes it live.
      await announceQuietly(r.id);
      return { version: v.version_no };
    }),

  // Bring an older file back: added as a new version, so history stays a
  // straight line and partners get it as the latest.
  adminRestoreVersion: resourcesAdmin
    .input(z.object({ id: z.number().int().positive(), versionId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const old = await db.resource_version.findFirst({ where: { id: input.versionId, resource_id: input.id } });
      if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found." });
      const v = await db.$transaction(async (tx) => {
        const max = await tx.resource_version.aggregate({ where: { resource_id: input.id }, _max: { version_no: true } });
        if (max._max.version_no === old.version_no) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That is already the current version." });
        }
        const created = await tx.resource_version.create({
          data: {
            resource_id: input.id,
            version_no: (max._max.version_no ?? 0) + 1,
            file_url: old.file_url,
            file_name: old.file_name,
            mime_type: old.mime_type,
            size_bytes: old.size_bytes,
            restored_from_id: old.id,
            uploaded_by_cp_user_id: ctx.cpUser.id,
          },
        });
        await tx.resource.update({ where: { id: input.id }, data: { updated_by_cp_user_id: ctx.cpUser.id } });
        return created;
      });
      await db.audit_log.create({
        data: {
          action: "resource.version_restored",
          entity_type: "resource",
          entity_id: input.id,
          metadata: { byCpUserId: ctx.cpUser.id, restoredVersion: old.version_no, newVersion: v.version_no },
        },
      });
      return { version: v.version_no };
    }),

  // Archive hides a resource from partners at once (download history stays);
  // unarchive brings it back within its dates.
  adminSetArchived: resourcesAdmin
    .input(z.object({ id: z.number().int().positive(), archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const r = await db.resource.update({
        where: { id: input.id },
        data: { archived_at: input.archived ? new Date() : null, updated_by_cp_user_id: ctx.cpUser.id },
      });
      await db.audit_log.create({
        data: {
          action: input.archived ? "resource.archived" : "resource.unarchived",
          entity_type: "resource",
          entity_id: r.id,
          metadata: { byCpUserId: ctx.cpUser.id, title: r.title },
        },
      });
      if (!input.archived) await announceQuietly(r.id);
      return { success: true as const };
    }),

  // ─── Partner ──────────────────────────────────────────────────────────────

  // Everything this partner may see right now, pinned first, then newest.
  // The library is small, so search and filters run in the page.
  partnerList: protectedPartnerProcedure.query(async ({ ctx }) => {
    sweepDueResourcesSoon();
    const type = await partnerType(ctx.cpPartner.id);
    const rows = await db.resource.findMany({
      where: partnerResourceWhere(type),
      orderBy: [{ is_pinned: "desc" }, { publish_on: "desc" }, { id: "desc" }],
      take: 1000,
      include: {
        category: { select: { id: true, name: true } },
        versions: { ...latestVersion, select: versionSelect },
      },
    });
    const unis = await universityMap(rows.map((r) => r.university_id));
    return rows.map((r) => {
      const v = r.versions[0];
      const publishOn = isoFromDate(r.publish_on);
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        university: r.university_id ? (unis.get(r.university_id) ?? null) : null,
        country: r.country ?? (r.university_id ? (unis.get(r.university_id)?.country ?? null) : null),
        kind: r.kind,
        linkHost: r.kind === ResourceKind.LINK && r.link_url ? safeHost(r.link_url) : null,
        publishOn,
        isNew: isNewResource(publishOn),
        pinned: r.is_pinned === 1,
        important: r.is_important === 1,
        file: v ? { name: v.file_name, mime: v.mime_type, size: v.size_bytes, version: v.version_no } : null,
      };
    });
  }),

  // Uni Assist: the resources tagged with each of these universities, in one
  // query for the whole visible page of results.
  partnerByUniversity: protectedPartnerProcedure
    .input(z.object({ universityIds: z.array(z.number().int().positive()).max(500) }))
    .query(async ({ ctx, input }) => {
      const ids = [...new Set(input.universityIds)];
      if (ids.length === 0) return {} as Record<number, PartnerUniResource[]>;
      const type = await partnerType(ctx.cpPartner.id);
      const rows = await db.resource.findMany({
        where: { AND: [partnerResourceWhere(type), { university_id: { in: ids } }] },
        orderBy: [{ is_pinned: "desc" }, { publish_on: "desc" }, { id: "desc" }],
        include: {
          category: { select: { name: true } },
          versions: { ...latestVersion, select: { mime_type: true } },
        },
      });
      const out: Record<number, PartnerUniResource[]> = {};
      for (const r of rows) {
        (out[r.university_id!] ??= []).push({
          id: r.id,
          title: r.title,
          category: r.category.name,
          kind: r.kind,
          mime: r.versions[0]?.mime_type ?? null,
          isNew: isNewResource(isoFromDate(r.publish_on)),
        });
      }
      return out;
    }),
});

type PartnerUniResource = {
  id: number;
  title: string;
  category: string;
  kind: number;
  mime: string | null;
  isNew: boolean;
};

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

