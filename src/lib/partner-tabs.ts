import { UserType } from "~/server/db/enums";

// The tabs of the partner portal and which partner user types get them: the
// partner counterpart of ~/lib/admin-sections. PARTNER_TAB_TYPES is the
// built-in default; a Super Admin can change it per type and per user
// (Settings → Tab Access; 27 Oct 2026). Effective access is resolved per tab
// by ~/server/tab-access the same way:
//
//   the user's override ?? their type's saved default ?? PARTNER_TAB_TYPES
//
// and drives the partner sidebar, the page gate in PartnerDashboardShell and
// the server (API_TABS below, enforced in protectedPartnerProcedure).
//
// Dashboard is everyone's landing page and isn't switchable. Switching a tab
// on never widens what a partner may see or do: Counsellors stays the agency
// owner's (agencyOwnerProcedure) and Commission the payee's (payeeProcedure),
// so those can be switched off but not on for other types.

export type PartnerTab =
  | "students"
  | "applications"
  | "chat"
  | "uniAssist"
  | "counsellors"
  | "commission"
  | "resources"
  | "events"
  | "account";

const { AGENCY_OWNER, AGENCY_COUNSELLOR, INDEPENDENT_COUNSELLOR } = UserType;

export const PARTNER_TYPES: { type: number; label: string }[] = [
  { type: AGENCY_OWNER, label: "Agency Owner" },
  { type: AGENCY_COUNSELLOR, label: "Agency Counsellor" },
  { type: INDEPENDENT_COUNSELLOR, label: "Independent Counsellor" },
];

const ALL: number[] = [AGENCY_OWNER, AGENCY_COUNSELLOR, INDEPENDENT_COUNSELLOR];

export const PARTNER_TAB_TYPES: Record<PartnerTab, number[]> = {
  students: ALL,
  applications: ALL,
  chat: ALL,
  uniAssist: ALL,
  counsellors: [AGENCY_OWNER],
  // Commission is the agency's money: not for an agency's counsellors.
  commission: [AGENCY_OWNER, INDEPENDENT_COUNSELLOR],
  resources: ALL,
  events: ALL,
  account: ALL,
};

// Types the server can serve a tab to at all (see the header).
const GRANTABLE_TYPES: Partial<Record<PartnerTab, number[]>> = {
  counsellors: [AGENCY_OWNER],
  commission: [AGENCY_OWNER, INDEPENDENT_COUNSELLOR],
};

export function canGrantPartnerTab(type: number, tab: PartnerTab): boolean {
  return GRANTABLE_TYPES[tab]?.includes(type) ?? true;
}

// In sidebar order.
export const SWITCHABLE_PARTNER_TABS: { tab: PartnerTab; label: string }[] = [
  { tab: "students", label: "Students" },
  { tab: "applications", label: "Applications" },
  { tab: "chat", label: "Chat" },
  { tab: "uniAssist", label: "Uni Assist" },
  { tab: "counsellors", label: "Counsellors" },
  { tab: "commission", label: "Commission" },
  { tab: "resources", label: "Resources" },
  { tab: "events", label: "Upcoming Events" },
  { tab: "account", label: "Account" },
];

const TABS = new Set<string>(SWITCHABLE_PARTNER_TABS.map((t) => t.tab));

export function isPartnerTab(value: string): value is PartnerTab {
  return TABS.has(value);
}

export function builtInPartnerTab(type: number, tab: PartnerTab): boolean {
  return PARTNER_TAB_TYPES[tab].includes(type);
}

export function resolvePartnerTabs(
  type: number,
  typeDefaults: ReadonlyMap<string, boolean>,
  overrides: ReadonlyMap<string, boolean>,
): PartnerTab[] {
  return SWITCHABLE_PARTNER_TABS.map((t) => t.tab).filter((tab) => {
    const on = overrides.get(tab) ?? typeDefaults.get(tab) ?? builtInPartnerTab(type, tab);
    return on && canGrantPartnerTab(type, tab);
  });
}

const PATH_TABS: [prefix: string, tab: PartnerTab][] = [
  ["/partner/students", "students"],
  ["/partner/applications", "applications"],
  ["/partner/chat", "chat"],
  ["/partner/uni-assist", "uniAssist"],
  ["/partner/counsellors", "counsellors"],
  ["/partner/commission", "commission"],
  ["/partner/resources", "resources"],
  ["/partner/events", "events"],
  ["/partner/account", "account"],
];

export function partnerTabForPath(pathname: string): PartnerTab | null {
  const hit = PATH_TABS.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  return hit ? hit[1] : null;
}

// Partner API procedures that serve one tab's pages, by tRPC path ("router."
// for a whole router, "router.prefix*" for a group of procedures). Shared
// ones (the student list behind Uni Assist and assigning, a student's record,
// the payout bank account on Account…) follow the pages that use them and
// aren't listed.
const API_TABS: [path: string, tab: PartnerTab][] = [
  ["partnerChat.partner*", "chat"],
  ["universities.searchPrograms", "uniAssist"],
  ["universities.listSearchFilters", "uniAssist"],
  ["universities.partnerUniAssistMoney", "uniAssist"],
  ["counsellors.sendContactOtp", "counsellors"],
  ["counsellors.verifyContactOtp", "counsellors"],
  ["counsellors.addCounsellor", "counsellors"],
  ["counsellors.updateCounsellor", "counsellors"],
  ["counsellors.deactivateCounsellor", "counsellors"],
  ["counsellors.reactivateCounsellor", "counsellors"],
  ["counsellors.removeCounsellor", "counsellors"],
  ["partnerCommission.listClaimable", "commission"],
  ["partnerCommission.generateInvoice", "commission"],
  ["partnerCommission.taxPreview", "commission"],
  ["partnerCommission.studentDetail", "commission"],
  ["partnerCommission.yearlyStats", "commission"],
  ["partnerCommission.invoiceHistory", "commission"],
  ["events.forPartners", "events"],
  ["events.rsvp", "events"],
  ["account.", "account"],
];

export function partnerTabForProcedure(path: string): PartnerTab | null {
  const hit = API_TABS.find(([p]) => matchesPath(p, path));
  return hit ? hit[1] : null;
}

function matchesPath(pattern: string, path: string): boolean {
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return pattern.endsWith(".") ? path.startsWith(pattern) : path === pattern;
}
