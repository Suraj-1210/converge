import { accountRouter } from "~/server/api/routers/account";
import { authRouter } from "~/server/api/routers/auth";
import { authSessionRouter } from "~/server/api/routers/auth-session";
import { dashboardRouter } from "~/server/api/routers/dashboard";
import { signupRouter } from "~/server/api/routers/signup";
import { adminAuthRouter } from "~/server/api/routers/admin-auth";
import { usersRouter } from "~/server/api/routers/users";
import { departmentsRouter } from "~/server/api/routers/departments";
import { trancheConditionsRouter } from "~/server/api/routers/tranche-conditions";
import { resourcesRouter } from "~/server/api/routers/resources";
import { resourceCategoriesRouter } from "~/server/api/routers/resource-categories";
import { adjustmentsRouter } from "~/server/api/routers/adjustments";
import { adjustmentReasonsRouter } from "~/server/api/routers/adjustment-reasons";
import { partnerNoticeSettingsRouter } from "~/server/api/routers/partner-notice-settings";
import { partnerTiersRouter } from "~/server/api/routers/partner-tiers";
import { counsellingTeamsRouter } from "~/server/api/routers/counselling-teams";
import { partnersRouter } from "~/server/api/routers/partners";
import { universitiesRouter } from "~/server/api/routers/universities";
import { studentsRouter } from "~/server/api/routers/students";
import { globalSearchRouter } from "~/server/api/routers/global-search";
import { placementsRouter } from "~/server/api/routers/placements";
import { counsellorsRouter } from "~/server/api/routers/counsellors";
import { eventsRouter } from "~/server/api/routers/events";
import { commissionRatesRouter } from "~/server/api/routers/commission-rates";
import { universityBillingRouter } from "~/server/api/routers/university-billing";
import { financeDashboardRouter } from "~/server/api/routers/finance-dashboard";
import { bonusSchemesRouter } from "~/server/api/routers/bonus-schemes";
import { commissionsRouter } from "~/server/api/routers/commissions";
import { partnerCommissionRouter } from "~/server/api/routers/partner-commission";
import { partnerPayoutsRouter } from "~/server/api/routers/partner-payouts";
import { reconciliationRouter } from "~/server/api/routers/reconciliation";
import { bankVerificationRouter } from "~/server/api/routers/bank-verification";
import { settingsRouter } from "~/server/api/routers/settings";
import { auditRouter } from "~/server/api/routers/audit";
import { bdmRouter } from "~/server/api/routers/bdm";
import { bdmCrmRouter } from "~/server/api/routers/bdm-crm";
import { fxRouter } from "~/server/api/routers/fx";
import { geoRouter } from "~/server/api/routers/geo";
import { notificationsRouter } from "~/server/api/routers/notifications";
import { partnerNotificationsRouter } from "~/server/api/routers/partner-notifications";
import { staffNotificationsRouter } from "~/server/api/routers/staff-notifications";
import { outOfOfficeRouter } from "~/server/api/routers/out-of-office";
import { chatRouter } from "~/server/api/routers/chat";
import { partnerChatRouter } from "~/server/api/routers/partner-chat";
import { tatRouter } from "~/server/api/routers/tat";
import { followUpsRouter } from "~/server/api/routers/follow-ups";
import { shortlistFollowUpRouter, tasksRouter } from "~/server/api/routers/tasks";
import { applicationsRouter } from "~/server/api/routers/applications";
import { applicationPipelineRouter } from "~/server/api/routers/application-pipeline";
import { notesRouter } from "~/server/api/routers/notes";
import { impersonationRouter } from "~/server/api/routers/impersonation";
import { tabAccessRouter } from "~/server/api/routers/tab-access";
import { reportsRouter } from "~/server/api/routers/reports";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

export const appRouter = createTRPCRouter({
  globalSearch: globalSearchRouter,
  account: accountRouter,
  auth: authRouter,
  authSession: authSessionRouter,
  impersonation: impersonationRouter,
  signup: signupRouter,
  adminAuth: adminAuthRouter,
  users: usersRouter,
  departments: departmentsRouter,
  trancheConditions: trancheConditionsRouter,
  resources: resourcesRouter,
  resourceCategories: resourceCategoriesRouter,
  adjustments: adjustmentsRouter,
  adjustmentReasons: adjustmentReasonsRouter,
  partnerNoticeSettings: partnerNoticeSettingsRouter,
  partnerTiers: partnerTiersRouter,
  counsellingTeams: counsellingTeamsRouter,
  partners: partnersRouter,
  universities: universitiesRouter,
  students: studentsRouter,
  placements: placementsRouter,
  counsellors: counsellorsRouter,
  events: eventsRouter,
  commissionRates: commissionRatesRouter,
  universityBilling: universityBillingRouter,
  financeDashboard: financeDashboardRouter,
  bonusSchemes: bonusSchemesRouter,
  commissions: commissionsRouter,
  partnerCommission: partnerCommissionRouter,
  partnerPayouts: partnerPayoutsRouter,
  reconciliation: reconciliationRouter,
  bankVerification: bankVerificationRouter,
  settings: settingsRouter,
  audit: auditRouter,
  bdm: bdmRouter,
  bdmCrm: bdmCrmRouter,
  fx: fxRouter,
  geo: geoRouter,
  notifications: notificationsRouter,
  partnerNotifications: partnerNotificationsRouter,
  staffNotifications: staffNotificationsRouter,
  outOfOffice: outOfOfficeRouter,
  chat: chatRouter,
  partnerChat: partnerChatRouter,
  tat: tatRouter,
  followUps: followUpsRouter,
  tasks: tasksRouter,
  shortlistFollowUp: shortlistFollowUpRouter,
  applications: applicationsRouter,
  applicationPipeline: applicationPipelineRouter,
  notes: notesRouter,
  dashboard: dashboardRouter,
  tabAccess: tabAccessRouter,
  reports: reportsRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
