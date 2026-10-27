import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  partnerSelfProcedure,
  protectedAdminProcedure,
  superAdminProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { ADMIN_ROLE_CODES, AdminRoleLabel, isAdminRole } from "~/server/db/enums";
import {
  SWITCHABLE_SECTIONS,
  builtInSection,
  canGrantSection,
  isLockedRole,
  isSwitchableSection,
} from "~/lib/admin-sections";
import {
  PARTNER_TYPES,
  SWITCHABLE_PARTNER_TABS,
  builtInPartnerTab,
  canGrantPartnerTab,
  isPartnerTab,
} from "~/lib/partner-tabs";
import { type TabPortal, cachedAdminSections, cachedPartnerTabs } from "~/server/tab-access";

// Super Admin's tab switches (27 Oct 2026): a default tab set per user type
// (Settings → Tab Access) and per-user overrides (Users → Tabs, Partners →
// Tabs). Rows are stored only where they differ from what they'd otherwise
// inherit, so "reset" is just deleting them. Every change is audit-logged.

const portalInput = z.enum(["admin", "partner"]);

type Cell = { tab: string; builtIn: boolean; grantable: boolean };

// The switchable tabs of one user type, with their built-in default and
// whether the server can serve that tab to the type at all.
function cellsFor(portal: TabPortal, type: number): Cell[] {
  if (portal === "admin") {
    return SWITCHABLE_SECTIONS.map(({ section }) => ({
      tab: section,
      builtIn: builtInSection(type, section),
      grantable: !isLockedRole(type) && canGrantSection(type, section),
    }));
  }
  return SWITCHABLE_PARTNER_TABS.map(({ tab }) => ({
    tab,
    builtIn: builtInPartnerTab(type, tab),
    grantable: canGrantPartnerTab(type, tab),
  }));
}

function isUserType(portal: TabPortal, type: number): boolean {
  return portal === "admin" ? isAdminRole(type) : PARTNER_TYPES.some((t) => t.type === type);
}

function isTab(portal: TabPortal, tab: string): boolean {
  return portal === "admin" ? isSwitchableSection(tab) : isPartnerTab(tab);
}

async function savedDefaults(portal: TabPortal, type: number): Promise<Map<string, boolean>> {
  const rows = await db.cp_tab_default.findMany({
    where: { portal, user_type: type },
    select: { tab: true, enabled: true },
  });
  return new Map(rows.filter((r) => isTab(portal, r.tab)).map((r) => [r.tab, r.enabled === 1]));
}

// A type's default for each tab: saved ?? built in (never on where the type
// can't be given it).
function typeValue(cell: Cell, saved: ReadonlyMap<string, boolean>): boolean {
  return (saved.get(cell.tab) ?? cell.builtIn) && cell.grantable;
}

// The user a per-user override is for: a staff user (not a Super Admin, who
// always has every tab) or a partner user.
async function overrideTarget(portal: TabPortal, userId: number) {
  if (portal === "admin") {
    const u = await db.collegepond_user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, first_name: true, last_name: true },
    });
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    if (isLockedRole(u.role)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Super Admins always have every tab.",
      });
    }
    return { id: u.id, type: u.role, name: `${u.first_name} ${u.last_name}`.trim() };
  }
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, type: true, first_name: true, last_name: true, deleted_at: true },
  });
  if (!u || u.deleted_at || !isUserType("partner", u.type)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Partner not found" });
  }
  return { id: u.id, type: u.type, name: `${u.first_name} ${u.last_name}`.trim() };
}

const ownerWhere = (portal: TabPortal, userId: number) =>
  portal === "admin" ? { cp_user_id: userId } : { user_id: userId };

export const tabAccessRouter = createTRPCRouter({
  // The signed-in staff user's effective tabs: the sidebar and page gate.
  mine: protectedAdminProcedure.query(async ({ ctx }) => ({
    sections: [...(await cachedAdminSections(ctx.tabAccess, ctx.cpUser))],
  })),

  // The signed-in partner's effective tabs. Readable at any status, like
  // auth.me, so the shell can render for an account under review.
  partnerMine: partnerSelfProcedure.query(async ({ ctx }) => {
    const u = await ctx.db.user.findUnique({
      where: { id: ctx.cpPartner.id },
      select: { type: true },
    });
    if (!u) throw new TRPCError({ code: "UNAUTHORIZED", message: "Not signed in" });
    return { tabs: [...(await cachedPartnerTabs(ctx.tabAccess, { id: ctx.cpPartner.id, type: u.type }))] };
  }),

  // Settings → Tab Access: every user type × switchable tab.
  typeDefaults: superAdminProcedure.input(z.object({ portal: portalInput })).query(async ({ input }) => {
    const types =
      input.portal === "admin"
        ? ADMIN_ROLE_CODES.map((role) => ({ type: role as number, label: AdminRoleLabel[role] }))
        : PARTNER_TYPES;
    return Promise.all(
      types.map(async ({ type, label }) => {
        const saved = await savedDefaults(input.portal, type);
        return {
          type,
          label,
          locked: input.portal === "admin" && isLockedRole(type),
          cells: cellsFor(input.portal, type).map((c) => ({
            ...c,
            value: typeValue(c, saved),
          })),
        };
      }),
    );
  }),

  // Saves one portal's grid. A cell equal to the built-in default is stored as
  // nothing (so later changes to the built-in default still reach it).
  saveTypeDefaults: superAdminProcedure
    .input(
      z.object({
        portal: portalInput,
        types: z
          .array(z.object({ type: z.number().int(), tabs: z.record(z.string(), z.boolean()) }))
          .max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const by = ctx.cpUser.realId ?? ctx.cpUser.id;
      let changedTypes = 0;
      for (const { type, tabs } of input.types) {
        if (!isUserType(input.portal, type)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown user type" });
        }
        if (input.portal === "admin" && isLockedRole(type)) continue;
        const saved = await savedDefaults(input.portal, type);
        const changes: { tab: string; from: boolean; to: boolean }[] = [];
        for (const cell of cellsFor(input.portal, type)) {
          const want = tabs[cell.tab];
          if (want === undefined || !cell.grantable) continue;
          const from = typeValue(cell, saved);
          if (want !== from) changes.push({ tab: cell.tab, from, to: want });
          const key = { portal: input.portal, user_type: type, tab: cell.tab };
          if (want === cell.builtIn) {
            await db.cp_tab_default.deleteMany({ where: key });
          } else {
            await db.cp_tab_default.upsert({
              where: { portal_user_type_tab: key },
              create: { ...key, enabled: want ? 1 : 0, updated_by_cp_user_id: by },
              update: { enabled: want ? 1 : 0, updated_by_cp_user_id: by },
            });
          }
        }
        if (changes.length === 0) continue;
        changedTypes++;
        await db.audit_log.create({
          data: {
            action: "tab_access.type_default_saved",
            entity_type: input.portal === "admin" ? "admin_role" : "partner_type",
            entity_id: type,
            metadata: { byCpUserId: by, portal: input.portal, changes },
          },
        });
      }
      return { changedTypes };
    }),

  // Users → Tabs (staff) / Partners → Tabs (partner users): one user's tabs.
  userOverrides: superAdminProcedure
    .input(z.object({ portal: portalInput, userId: z.number().int() }))
    .query(async ({ input }) => {
      const target = await overrideTarget(input.portal, input.userId);
      const saved = await savedDefaults(input.portal, target.type);
      const rows = await db.cp_tab_override.findMany({
        where: ownerWhere(input.portal, target.id),
        select: { tab: true, enabled: true },
      });
      const overrides = new Map(rows.map((r) => [r.tab, r.enabled === 1]));
      const labels = new Map<string, string>(
        input.portal === "admin"
          ? SWITCHABLE_SECTIONS.map((s) => [s.section, s.label])
          : SWITCHABLE_PARTNER_TABS.map((t) => [t.tab, t.label]),
      );
      return {
        name: target.name,
        typeLabel:
          input.portal === "admin"
            ? isAdminRole(target.type)
              ? AdminRoleLabel[target.type]
              : ""
            : (PARTNER_TYPES.find((t) => t.type === target.type)?.label ?? ""),
        tabs: cellsFor(input.portal, target.type).map((c) => {
          const typeDefault = typeValue(c, saved);
          const override = c.grantable ? overrides.get(c.tab) : undefined;
          return {
            tab: c.tab,
            label: labels.get(c.tab) ?? c.tab,
            grantable: c.grantable,
            typeDefault,
            overridden: override !== undefined,
            value: override ?? typeDefault,
          };
        }),
      };
    }),

  // Saves one user's tabs. A tab equal to their type's default is stored as
  // nothing, i.e. it follows the type; reset = send the type defaults (or
  // `reset: true`).
  saveUserOverrides: superAdminProcedure
    .input(
      z.object({
        portal: portalInput,
        userId: z.number().int(),
        tabs: z.record(z.string(), z.boolean()),
        reset: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const by = ctx.cpUser.realId ?? ctx.cpUser.id;
      const target = await overrideTarget(input.portal, input.userId);
      const saved = await savedDefaults(input.portal, target.type);
      const where = ownerWhere(input.portal, target.id);
      const existing = new Map(
        (await db.cp_tab_override.findMany({ where, select: { tab: true, enabled: true } })).map(
          (r) => [r.tab, r.enabled === 1],
        ),
      );
      const changes: { tab: string; from: boolean; to: boolean }[] = [];
      for (const cell of cellsFor(input.portal, target.type)) {
        const typeDefault = typeValue(cell, saved);
        const from = (cell.grantable ? existing.get(cell.tab) : undefined) ?? typeDefault;
        const want = input.reset ? typeDefault : input.tabs[cell.tab];
        if (want === undefined || !cell.grantable) continue;
        if (want !== from) changes.push({ tab: cell.tab, from, to: want });
        if (want === typeDefault) {
          await db.cp_tab_override.deleteMany({ where: { ...where, tab: cell.tab } });
        } else if (existing.has(cell.tab)) {
          await db.cp_tab_override.updateMany({
            where: { ...where, tab: cell.tab },
            data: { enabled: want ? 1 : 0, updated_by_cp_user_id: by },
          });
        } else {
          await db.cp_tab_override.create({
            data: { ...where, tab: cell.tab, enabled: want ? 1 : 0, updated_by_cp_user_id: by },
          });
        }
      }
      if (changes.length > 0) {
        await db.audit_log.create({
          data: {
            action: input.reset ? "tab_access.user_override_reset" : "tab_access.user_override_saved",
            entity_type: input.portal === "admin" ? "cp_user" : "user",
            entity_id: target.id,
            metadata: { byCpUserId: by, portal: input.portal, name: target.name, changes },
          },
        });
      }
      return { changed: changes.length };
    }),
});

