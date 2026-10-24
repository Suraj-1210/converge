import { z } from "zod";
import {
  createTRPCRouter,
  publicProcedure,
  superAdminProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";

// System-wide settings live in `system_config` (key → JSON). Defaults mirror the
// Settings page's initial state so a fresh install renders sensibly.
const GENERAL_DEFAULT = {
  companyName: "Collegepond",
  adminLogoUrl: "",
  partnerLogoUrl: "",
  currency: "INR",
  ayStartMonth: "April",
  dateFormat: "DD/MM/YYYY",
  timeZone: "Asia/Kolkata (IST, UTC+5:30)",
};
const NOTIFS_DEFAULT = {
  email: true,
  appStatus: true,
  invoice: true,
  payment: true,
  events: true,
  system: false,
};

const generalInput = z.object({
  companyName: z.string().trim().min(1).max(120),
  adminLogoUrl: z.string().trim().max(500),
  partnerLogoUrl: z.string().trim().max(500),
  currency: z.string().trim().max(10),
  ayStartMonth: z.string().trim().max(20),
  dateFormat: z.string().trim().max(20),
  timeZone: z.string().trim().max(60),
});
const notifsInput = z.object({
  email: z.boolean(),
  appStatus: z.boolean(),
  invoice: z.boolean(),
  payment: z.boolean(),
  events: z.boolean(),
  system: z.boolean(),
});

// Read a config row, merged over defaults (so newly-added keys fill in).
async function readConfig<T extends object>(key: string, fallback: T): Promise<T> {
  const row = await db.system_config.findUnique({ where: { config_key: key } });
  if (!row) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value) as object) };
  } catch {
    return fallback;
  }
}
async function writeConfig(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await db.system_config.upsert({
    where: { config_key: key },
    create: { config_key: key, value: json },
    update: { value: json },
  });
}

export const settingsRouter = createTRPCRouter({
  // Real DB counts for the Settings → Data Management "Data Statistics" panel.
  dataStats: superAdminProcedure.query(async () => {
    const [universities, programs, students, invoices, events] = await Promise.all([
      db.university.count(),
      db.course.count(),
      db.student.count(),
      db.invoice.count(),
      db.event.count(),
    ]);
    return { universities, programs, students, invoices, events };
  }),

  // System-wide general + notification settings (DB-backed; was localStorage).
  getConfig: superAdminProcedure.query(async () => {
    const [general, notifications] = await Promise.all([
      readConfig("general", GENERAL_DEFAULT),
      readConfig("notifications", NOTIFS_DEFAULT),
    ]);
    return { general, notifications };
  }),

  // Public: just the app logo URLs, so both the admin and partner sidebars can
  // render the configured logo without needing an admin session.
  branding: publicProcedure.query(async () => {
    const g = await readConfig("general", GENERAL_DEFAULT);
    return { adminLogoUrl: g.adminLogoUrl, partnerLogoUrl: g.partnerLogoUrl };
  }),

  saveGeneral: superAdminProcedure
    .input(generalInput)
    .mutation(async ({ ctx, input }) => {
      await writeConfig("general", input);
      await db.audit_log.create({
        data: {
          action: "settings.general_updated",
          entity_type: "system_config",
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true as const };
    }),

  saveNotifications: superAdminProcedure
    .input(notifsInput)
    .mutation(async ({ ctx, input }) => {
      await writeConfig("notifications", input);
      await db.audit_log.create({
        data: {
          action: "settings.notifications_updated",
          entity_type: "system_config",
          metadata: { byCpUserId: ctx.cpUser.id },
        },
      });
      return { ok: true as const };
    }),
});
