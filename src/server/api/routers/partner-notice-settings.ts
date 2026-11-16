import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, superAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { UserType } from "~/server/db/enums";
import {
  MAX_WINDOW_DAYS,
  NoticeAudience,
  NoticeSeverity,
  TRIGGER_BY_CODE,
  isValidNoticeLink,
  type TriggerConfig,
} from "~/lib/partner-notices";
import { effectiveTriggers, istToday } from "~/server/partner-notices";

// Settings -> Partner Notices (16 Nov 2026). Super Admin only, reads included.
//
// System triggers: the list is the code's registry (~/lib/partner-notices);
// a save upserts the trigger's partner_notice_trigger row, "reset" deletes it
// so the code's defaults apply again. Owner-only (money / account) triggers
// can't be given another audience: refused here and ignored at read time.
//
// Manual notices: free-text announcements with dates, audience and optional
// partner targets (an agency org or an independent counsellor).

const severity = z.union([
  z.literal(NoticeSeverity.INFO),
  z.literal(NoticeSeverity.SUCCESS),
  z.literal(NoticeSeverity.WARNING),
  z.literal(NoticeSeverity.ACTION),
]);
const audience = z.union([
  z.literal(NoticeAudience.OWNER),
  z.literal(NoticeAudience.COUNSELLOR),
  z.literal(NoticeAudience.BOTH),
]);
const oneLine = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what} is required`)
    .max(max, `${what} is too long (max ${max} characters)`)
    .transform((s) => s.replace(/\s+/g, " "));
const optionalText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `${what} is too long (max ${max} characters)`)
    .transform((s) => (s === "" ? null : s))
    .nullable();
const sortOrder = z.number().int().min(-10000).max(100000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");

function requireTrigger(code: string) {
  const def = TRIGGER_BY_CODE.get(code);
  if (!def) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown trigger." });
  return def;
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const manualInput = z
  .object({
    title: oneLine(200, "Title"),
    body: optionalText(2000, "Message"),
    linkUrl: optionalText(500, "Link"),
    severity,
    audience,
    startsOn: isoDate,
    endsOn: isoDate.nullable(),
    active: z.boolean(),
    sortOrder,
    // Empty = every partner in the audience.
    targets: z
      .array(z.union([z.object({ orgId: z.number().int().positive() }), z.object({ userId: z.number().int().positive() })]))
      .max(500),
  })
  .superRefine((v, c) => {
    if (v.linkUrl && !isValidNoticeLink(v.linkUrl)) {
      c.addIssue({ code: "custom", path: ["linkUrl"], message: "Link must be a portal path (/partner/…) or an https:// address" });
    }
    if (v.endsOn && v.endsOn < v.startsOn) {
      c.addIssue({ code: "custom", path: ["endsOn"], message: "The end date is before the start date" });
    }
  });
type ManualInput = z.infer<typeof manualInput>;

// Targets must be real partners: an agency (org with a live owner) or an
// independent counsellor.
async function checkTargets(targets: ManualInput["targets"]) {
  const orgIds = [...new Set(targets.flatMap((t) => ("orgId" in t ? [t.orgId] : [])))];
  const userIds = [...new Set(targets.flatMap((t) => ("userId" in t ? [t.userId] : [])))];
  const [orgs, users] = await Promise.all([
    orgIds.length ? db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true } }) : [],
    userIds.length
      ? db.user.findMany({
          where: { id: { in: userIds }, type: UserType.INDEPENDENT_COUNSELLOR, deleted_at: null },
          select: { id: true },
        })
      : [],
  ]);
  if (orgs.length !== orgIds.length || users.length !== userIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "One of the selected partners no longer exists." });
  }
  return [...orgIds.map((id) => ({ org_id: id, user_id: null })), ...userIds.map((id) => ({ org_id: null, user_id: id }))];
}

function manualData(v: ManualInput) {
  return {
    title: v.title,
    body: v.body,
    link_url: v.linkUrl,
    severity: v.severity,
    audience: v.audience,
    starts_on: toDate(v.startsOn),
    ends_on: v.endsOn ? toDate(v.endsOn) : null,
    is_active: v.active ? 1 : 0,
    sort_order: v.sortOrder,
  };
}

function configRow(c: TriggerConfig) {
  return {
    is_enabled: c.enabled ? 1 : 0,
    title_template: c.title,
    body_template: c.body,
    severity: c.severity,
    sort_order: c.sortOrder,
    window_days: c.windowDays,
    audience: c.audience,
  };
}

export const partnerNoticeSettingsRouter = createTRPCRouter({
  // Every trigger the code implements, with its effective settings.
  triggers: superAdminProcedure.query(async () => {
    const list = await effectiveTriggers();
    return list.map(({ def, config, customized }) => ({
      code: def.code,
      label: def.label,
      fires: def.fires,
      group: def.group,
      ownerOnly: def.ownerOnly,
      link: def.link,
      placeholders: def.placeholders,
      windowApplies: def.windowApplies,
      defaults: def.defaults,
      config,
      customized,
    }));
  }),

  saveTrigger: superAdminProcedure
    .input(
      z.object({
        code: z.string().max(50),
        enabled: z.boolean(),
        title: oneLine(200, "Title"),
        body: optionalText(1000, "Message"),
        severity,
        sortOrder,
        windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).nullable(),
        audience,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const def = requireTrigger(input.code);
      if (def.ownerOnly && input.audience !== NoticeAudience.OWNER) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Money and account notices are for owners and independents only.",
        });
      }
      if (def.windowApplies && input.windowDays == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Set how many days the notice stays." });
      }
      const config: TriggerConfig = {
        enabled: input.enabled,
        title: input.title,
        body: input.body,
        severity: input.severity,
        sortOrder: input.sortOrder,
        windowDays: def.windowApplies ? input.windowDays : null,
        audience: input.audience,
      };
      const before = await db.partner_notice_trigger.findUnique({ where: { code: def.code } });
      const row = configRow(config);
      await db.partner_notice_trigger.upsert({
        where: { code: def.code },
        create: { code: def.code, ...row },
        update: row,
      });
      await db.audit_log.create({
        data: {
          action: "partner_notice_trigger.updated",
          entity_type: "partner_notice_trigger",
          metadata: { byCpUserId: ctx.cpUser.id, code: def.code, before: before ?? "defaults", after: row },
        },
      });
      return { success: true as const };
    }),

  // Quick on/off from the list.
  setTriggerEnabled: superAdminProcedure
    .input(z.object({ code: z.string().max(50), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const def = requireTrigger(input.code);
      const current = (await effectiveTriggers()).find((t) => t.def.code === def.code)!;
      const row = configRow({ ...current.config, enabled: input.enabled });
      await db.partner_notice_trigger.upsert({
        where: { code: def.code },
        create: { code: def.code, ...row },
        update: { is_enabled: row.is_enabled },
      });
      await db.audit_log.create({
        data: {
          action: input.enabled ? "partner_notice_trigger.enabled" : "partner_notice_trigger.disabled",
          entity_type: "partner_notice_trigger",
          metadata: { byCpUserId: ctx.cpUser.id, code: def.code },
        },
      });
      return { success: true as const };
    }),

  // Back to the code's defaults (today's wording).
  resetTrigger: superAdminProcedure
    .input(z.object({ code: z.string().max(50) }))
    .mutation(async ({ ctx, input }) => {
      const def = requireTrigger(input.code);
      const before = await db.partner_notice_trigger.findUnique({ where: { code: def.code } });
      if (!before) return { success: true as const };
      await db.partner_notice_trigger.delete({ where: { code: def.code } });
      await db.audit_log.create({
        data: {
          action: "partner_notice_trigger.reset",
          entity_type: "partner_notice_trigger",
          metadata: { byCpUserId: ctx.cpUser.id, code: def.code, before },
        },
      });
      return { success: true as const };
    }),

  // ---- manual notices ----

  manualList: superAdminProcedure.query(async () => {
    const rows = await db.partner_manual_notice.findMany({
      orderBy: [{ starts_on: "desc" }, { id: "desc" }],
      include: {
        target: {
          select: {
            org_id: true,
            user_id: true,
            organization: { select: { name: true } },
            user: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });
    const today = istToday();
    return rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      linkUrl: n.link_url,
      severity: n.severity,
      audience: n.audience,
      startsOn: isoOf(n.starts_on)!,
      endsOn: isoOf(n.ends_on),
      active: n.is_active === 1,
      sortOrder: n.sort_order,
      state:
        n.is_active !== 1
          ? ("inactive" as const)
          : n.ends_on && n.ends_on < today
            ? ("expired" as const)
            : n.starts_on > today
              ? ("scheduled" as const)
              : ("live" as const),
      targets: n.target.map((t) =>
        t.org_id != null
          ? { key: `org:${t.org_id}`, label: t.organization?.name ?? `Agency #${t.org_id}` }
          : { key: `user:${t.user_id}`, label: t.user ? `${t.user.first_name} ${t.user.last_name}`.trim() : `Partner #${t.user_id}` },
      ),
    }));
  }),

  // Partners a manual notice can be limited to: agencies (by org) and
  // independent counsellors.
  partnerOptions: superAdminProcedure.query(async () => {
    const [owners, independents] = await Promise.all([
      db.user.findMany({
        where: { type: UserType.AGENCY_OWNER, is_owner: 1, org_id: { not: null }, deleted_at: null },
        select: { org_id: true, first_name: true, last_name: true, organization: { select: { name: true } } },
      }),
      db.user.findMany({
        where: { type: UserType.INDEPENDENT_COUNSELLOR, deleted_at: null },
        select: { id: true, first_name: true, last_name: true },
      }),
    ]);
    const seen = new Set<number>();
    const agencies = owners.flatMap((o) => {
      if (o.org_id == null || seen.has(o.org_id)) return [];
      seen.add(o.org_id);
      const person = `${o.first_name} ${o.last_name}`.trim();
      return [{ key: `org:${o.org_id}`, label: o.organization?.name ? `${o.organization.name} (${person})` : person, kind: "Agency" }];
    });
    const indies = independents.map((u) => ({
      key: `user:${u.id}`,
      label: `${u.first_name} ${u.last_name}`.trim(),
      kind: "Independent",
    }));
    return [...agencies, ...indies].sort((a, b) => a.label.localeCompare(b.label));
  }),

  manualCreate: superAdminProcedure.input(manualInput).mutation(async ({ ctx, input }) => {
    const targets = await checkTargets(input.targets);
    const n = await db.partner_manual_notice.create({
      data: { ...manualData(input), target: { create: targets } },
    });
    await db.audit_log.create({
      data: {
        action: "partner_manual_notice.created",
        entity_type: "partner_manual_notice",
        entity_id: n.id,
        metadata: { byCpUserId: ctx.cpUser.id, title: n.title, targets: targets.length },
      },
    });
    return { id: n.id };
  }),

  manualUpdate: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), notice: manualInput }))
    .mutation(async ({ ctx, input }) => {
      const before = await db.partner_manual_notice.findUnique({ where: { id: input.id } });
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Notice not found." });
      const targets = await checkTargets(input.notice.targets);
      await db.$transaction([
        db.partner_manual_notice_target.deleteMany({ where: { notice_id: input.id } }),
        db.partner_manual_notice.update({
          where: { id: input.id },
          data: { ...manualData(input.notice), target: { create: targets } },
        }),
      ]);
      await db.audit_log.create({
        data: {
          action: "partner_manual_notice.updated",
          entity_type: "partner_manual_notice",
          entity_id: input.id,
          metadata: { byCpUserId: ctx.cpUser.id, before: { title: before.title, active: before.is_active === 1 }, title: input.notice.title, targets: targets.length },
        },
      });
      return { success: true as const };
    }),

  manualRemove: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const n = await db.partner_manual_notice.findUnique({ where: { id: input.id } });
      if (!n) throw new TRPCError({ code: "NOT_FOUND", message: "Notice not found." });
      await db.partner_manual_notice.delete({ where: { id: input.id } });
      await db.audit_log.create({
        data: {
          action: "partner_manual_notice.deleted",
          entity_type: "partner_manual_notice",
          entity_id: n.id,
          metadata: { byCpUserId: ctx.cpUser.id, title: n.title },
        },
      });
      return { success: true as const };
    }),
});
