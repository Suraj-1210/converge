import { accountRouter } from "~/server/api/routers/account";
import { authRouter } from "~/server/api/routers/auth";
import { authSessionRouter } from "~/server/api/routers/auth-session";
import { dashboardRouter } from "~/server/api/routers/dashboard";
import { signupRouter } from "~/server/api/routers/signup";
import { adminAuthRouter } from "~/server/api/routers/admin-auth";
import { usersRouter } from "~/server/api/routers/users";
import { partnersRouter } from "~/server/api/routers/partners";
import { universitiesRouter } from "~/server/api/routers/universities";
import { studentsRouter } from "~/server/api/routers/students";
import { placementsRouter } from "~/server/api/routers/placements";
import { counsellorsRouter } from "~/server/api/routers/counsellors";
import { eventsRouter } from "~/server/api/routers/events";
import { commissionRatesRouter } from "~/server/api/routers/commission-rates";
import { universityBillingRouter } from "~/server/api/routers/university-billing";
import { commissionsRouter } from "~/server/api/routers/commissions";
import { partnerCommissionRouter } from "~/server/api/routers/partner-commission";
import { partnerPayoutsRouter } from "~/server/api/routers/partner-payouts";
import { reconciliationRouter } from "~/server/api/routers/reconciliation";
import { settingsRouter } from "~/server/api/routers/settings";
import { auditRouter } from "~/server/api/routers/audit";
import { bdmRouter } from "~/server/api/routers/bdm";
import { bdmCrmRouter } from "~/server/api/routers/bdm-crm";
import { fxRouter } from "~/server/api/routers/fx";
import { geoRouter } from "~/server/api/routers/geo";
import { notificationsRouter } from "~/server/api/routers/notifications";
import { partnerNotificationsRouter } from "~/server/api/routers/partner-notifications";
import { chatRouter } from "~/server/api/routers/chat";
import { applicationsRouter } from "~/server/api/routers/applications";
import { notesRouter } from "~/server/api/routers/notes";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

export const appRouter = createTRPCRouter({
  account: accountRouter,
  auth: authRouter,
  authSession: authSessionRouter,
  signup: signupRouter,
  adminAuth: adminAuthRouter,
  users: usersRouter,
  partners: partnersRouter,
  universities: universitiesRouter,
  students: studentsRouter,
  placements: placementsRouter,
  counsellors: counsellorsRouter,
  events: eventsRouter,
  commissionRates: commissionRatesRouter,
  universityBilling: universityBillingRouter,
  commissions: commissionsRouter,
  partnerCommission: partnerCommissionRouter,
  partnerPayouts: partnerPayoutsRouter,
  reconciliation: reconciliationRouter,
  settings: settingsRouter,
  audit: auditRouter,
  bdm: bdmRouter,
  bdmCrm: bdmCrmRouter,
  fx: fxRouter,
  geo: geoRouter,
  notifications: notificationsRouter,
  partnerNotifications: partnerNotificationsRouter,
  chat: chatRouter,
  applications: applicationsRouter,
  notes: notesRouter,
  dashboard: dashboardRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
