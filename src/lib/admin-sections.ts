import { AdminRole } from "~/server/db/enums";

// The sections (sidebar tabs) of the admin portal and who may use them.
//
// ADMIN_SECTION_ROLES is the BUILT-IN default (decided with Suraj, 24 Oct
// 2026). A Super Admin can change it per user type and per user (Settings →
// Tab Access, Users → Tabs; 27 Oct 2026). What a user actually gets is
// resolved per tab by ~/server/tab-access:
//
//   their override ?? their type's saved default ?? ADMIN_SECTION_ROLES
//
// That one effective set drives the sidebar, the page gate in DashboardShell
// and the server (adminSectionProcedure, and API_SECTIONS below, enforced in
// protectedAdminProcedure in ~/server/api/trpc), so hiding a page and
// refusing its data can't drift apart.
//
// Built-in defaults (BDM and Counsellor TAT revised 27 Oct):
//   Counsellor / Ops Executive (4, 6) → Dashboard, Students, Applications,
//                                       Uni Assist, Events (+ Partner Chat
//                                       and TAT: 4)
//   Counsellor Lead / Ops Lead (3, 5) → that, plus Partners, Student
//                                       Placements, Counselor Approvals,
//                                       Universities, TAT, Partner Chat
//   BDM (8)                           → Partners, Student Placements,
//                                       Universities, BDM Performance, plus
//                                       Counselor Approvals and the Commission
//                                       Ledger view-only; no Partner Chat/TAT.
//                                       Its data is scoped to the partners it
//                                       is BDM of (~/server/staff-access).
//   Finance, Content (1, 2, 7)        → what they had before
//   Users, Settings, Audit Logs        → Super Admin only, not switchable
//
// Switching a tab on opens its pages; it never widens whose data the user
// sees (staff-access scoping still applies, and tabs whose data isn't scoped
// can't be granted beyond GRANTABLE_ROLES) or what they may do there
// (approvals stay with their roles: financeManagerProcedure).

export type AdminSection =
  | "partners"
  | "students"
  | "applications"
  | "placements"
  | "counsellorApprovals"
  | "partnerChat"
  | "tat"
  | "uniAssist"
  | "notes"
  | "bdm"
  | "commissionRates"
  | "universityBilling"
  | "commissions"
  | "invoices"
  | "reconciliation"
  | "bankVerifications"
  | "universities"
  | "events"
  | "system";

const {
  SUPER_ADMIN,
  FINANCE_MANAGER,
  FINANCE_EXECUTIVE,
  COUNSELLOR_LEAD,
  COUNSELLOR,
  OPERATIONS_LEAD,
  CONTENT_MANAGER,
  BDM,
} = AdminRole;

const EVERYONE: number[] = Object.values(AdminRole);

// Everyone except the plain counsellor roles (Counsellor, Ops Executive).
const ABOVE_COUNSELLOR: number[] = [
  SUPER_ADMIN,
  FINANCE_MANAGER,
  FINANCE_EXECUTIVE,
  COUNSELLOR_LEAD,
  OPERATIONS_LEAD,
  CONTENT_MANAGER,
  BDM,
];

const FINANCE: number[] = [SUPER_ADMIN, FINANCE_MANAGER, FINANCE_EXECUTIVE];

export const ADMIN_SECTION_ROLES: Record<AdminSection, number[]> = {
  partners: ABOVE_COUNSELLOR,
  students: EVERYONE,
  applications: EVERYONE,
  placements: ABOVE_COUNSELLOR,
  counsellorApprovals: ABOVE_COUNSELLOR,
  partnerChat: [SUPER_ADMIN, COUNSELLOR_LEAD, OPERATIONS_LEAD, COUNSELLOR],
  tat: [SUPER_ADMIN, COUNSELLOR_LEAD, OPERATIONS_LEAD, COUNSELLOR],
  uniAssist: EVERYONE,
  notes: ABOVE_COUNSELLOR,
  bdm: [SUPER_ADMIN, BDM],
  commissionRates: FINANCE,
  universityBilling: FINANCE,
  commissions: [...FINANCE, BDM],
  invoices: FINANCE,
  reconciliation: FINANCE,
  bankVerifications: FINANCE,
  universities: ABOVE_COUNSELLOR,
  events: EVERYONE,
  system: [SUPER_ADMIN],
};

// The tabs a Super Admin can switch, in sidebar order. Not here: Dashboard
// (everyone's landing page), Notes (hidden page) and System (Users, Settings,
// Audit Logs), which stay at their built-in default.
export const SWITCHABLE_SECTIONS: { section: AdminSection; label: string; group: string }[] = [
  { section: "partners", label: "Partners", group: "Operations" },
  { section: "students", label: "Students", group: "Operations" },
  { section: "applications", label: "Applications", group: "Operations" },
  { section: "placements", label: "Student Placements", group: "Operations" },
  { section: "counsellorApprovals", label: "Counselor Approvals", group: "Operations" },
  { section: "partnerChat", label: "Partner Chat", group: "Operations" },
  { section: "tat", label: "TAT Management", group: "Operations" },
  { section: "uniAssist", label: "Uni Assist", group: "Operations" },
  { section: "bdm", label: "BDM Performance", group: "Business Dev" },
  { section: "commissionRates", label: "Commission Rates", group: "Finance" },
  { section: "universityBilling", label: "University Billing", group: "Finance" },
  { section: "commissions", label: "Commission Ledger", group: "Finance" },
  { section: "invoices", label: "Invoices & Payouts", group: "Finance" },
  { section: "reconciliation", label: "Reconciliation", group: "Finance" },
  { section: "bankVerifications", label: "Bank Verifications", group: "Finance" },
  { section: "universities", label: "Universities", group: "Content" },
  { section: "events", label: "Events", group: "Content" },
];

const SWITCHABLE = new Set<AdminSection>(SWITCHABLE_SECTIONS.map((s) => s.section));

export function isSwitchableSection(value: string): value is AdminSection {
  return SWITCHABLE.has(value as AdminSection);
}

// Tabs that can be switched off for anyone but on only for these roles,
// because their data isn't scoped for anyone else and switching a tab on
// must never widen whose data a user sees:
//   Partner Chat → mirrors CHAT_STAFF_ROLES in ~/server/partner-chat-access
//                  (no BDM chat, 27 Oct)
//   BDM Performance → bdmPerformanceProcedure (a BDM sees only their own)
//   Finance pages → financeProcedure (org-wide money data); the Commission
//                  Ledger also for BDMs, view-only over their own partners
const GRANTABLE_ROLES: Partial<Record<AdminSection, number[]>> = {
  partnerChat: [SUPER_ADMIN, COUNSELLOR_LEAD, OPERATIONS_LEAD, COUNSELLOR],
  bdm: [SUPER_ADMIN, BDM],
  commissionRates: FINANCE,
  universityBilling: FINANCE,
  commissions: [...FINANCE, BDM],
  invoices: FINANCE,
  reconciliation: FINANCE,
  bankVerifications: FINANCE,
};

// May this role have the tab switched on at all?
export function canGrantSection(role: number, section: AdminSection): boolean {
  return GRANTABLE_ROLES[section]?.includes(role) ?? true;
}

// Super Admins always have every tab: nobody can switch them off, so a Super
// Admin can't lock themselves (or the last other one) out.
export function isLockedRole(role: number): boolean {
  return role === SUPER_ADMIN;
}

// Roles that may open a section but not change anything in it. The server
// refuses their writes (requireSectionEdit in ~/server/staff-access); pages
// hide the action buttons via canEditSection. Whether they may open the
// section at all is their effective tabs; this only takes away editing.
export const ADMIN_SECTION_READ_ONLY: Partial<Record<AdminSection, number[]>> = {
  counsellorApprovals: [BDM],
  commissions: [BDM],
};

export function canEditSection(role: number, section: AdminSection): boolean {
  return !ADMIN_SECTION_READ_ONLY[section]?.includes(role);
}

export function builtInSection(role: number, section: AdminSection): boolean {
  return ADMIN_SECTION_ROLES[section].includes(role);
}

// Effective sections for one user: per switchable tab, their override ?? their
// type's saved default ?? the built-in default. Everything else is built-in.
export function resolveSections(
  role: number,
  typeDefaults: ReadonlyMap<string, boolean>,
  overrides: ReadonlyMap<string, boolean>,
): AdminSection[] {
  return (Object.keys(ADMIN_SECTION_ROLES) as AdminSection[]).filter((section) => {
    if (isLockedRole(role) || !SWITCHABLE.has(section)) return builtInSection(role, section);
    const on = overrides.get(section) ?? typeDefaults.get(section) ?? builtInSection(role, section);
    return on && canGrantSection(role, section);
  });
}

export function hasSection(sections: readonly AdminSection[] | undefined, section: AdminSection): boolean {
  return !!sections?.includes(section);
}

// Admin pages by path prefix. Anything not listed (Dashboard, Notifications)
// is open to every admin.
const PATH_SECTIONS: [prefix: string, section: AdminSection][] = [
  ["/admin/partners", "partners"],
  ["/admin/students", "students"],
  ["/admin/applications", "applications"],
  ["/admin/student-placements", "placements"],
  ["/admin/counselor-approvals", "counsellorApprovals"],
  ["/admin/uni-assist", "uniAssist"],
  ["/admin/universities", "universities"],
  ["/admin/events", "events"],
  ["/admin/notes-reminders", "notes"],
  ["/admin/partner-chat", "partnerChat"],
  ["/admin/tat-management", "tat"],
  ["/admin/bdm-performance", "bdm"],
  ["/admin/commission-rates", "commissionRates"],
  ["/admin/university-billing", "universityBilling"],
  ["/admin/commissions", "commissions"],
  ["/admin/invoices", "invoices"],
  ["/admin/reconciliation", "reconciliation"],
  ["/admin/bank-verifications", "bankVerifications"],
  ["/admin/users", "system"],
  ["/admin/settings", "system"],
  ["/admin/audit-logs", "system"],
];

export function sectionForPath(pathname: string): AdminSection | null {
  const hit = PATH_SECTIONS.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  return hit ? hit[1] : null;
}

export function canAccessAdminPath(sections: readonly AdminSection[] | undefined, pathname: string): boolean {
  const section = sectionForPath(pathname);
  return section === null || hasSection(sections, section);
}

// Admin API procedures that serve one tab's pages, by tRPC path ("router."
// for a whole router, "router.prefix*" for a group of procedures).
// protectedAdminProcedure refuses them while the tab is off, on top of
// whatever role rule the procedure has. Procedures shared by
// several tabs (student shortlists, a student's applications, bank review on
// Partners…) aren't listed: they follow the pages that use them.
// Routers built on adminSectionProcedure (partners, placements, counsellors,
// universities, tat, users) are gated there instead.
const API_SECTIONS: [path: string, section: AdminSection][] = [
  ["students.adminList", "students"],
  ["students.listOrgs", "students"],
  ["students.bulkUpdateStatus", "students"],
  ["students.adminGet", "students"],
  ["applications.", "applications"],
  ["universities.listSearchTemplates", "uniAssist"],
  ["universities.createSearchTemplate", "uniAssist"],
  ["universities.deleteSearchTemplate", "uniAssist"],
  ["universities.uniAssistMoney", "uniAssist"],
  ["events.", "events"],
  ["partnerChat.staff*", "partnerChat"],
  ["bdm.overview", "bdm"],
  ["bdmCrm.", "bdm"],
  ["commissionRates.", "commissionRates"],
  ["universityBilling.", "universityBilling"],
  ["commissions.", "commissions"],
  ["partnerPayouts.", "invoices"],
  ["reconciliation.listPending", "reconciliation"],
  ["reconciliation.verify", "reconciliation"],
  ["reconciliation.release", "reconciliation"],
  ["reconciliation.hold", "reconciliation"],
  ["reconciliation.sendBack", "reconciliation"],
  ["reconciliation.completed", "reconciliation"],
  ["reconciliation.stats", "reconciliation"],
  ["bankVerification.list", "bankVerifications"],
  ["bankVerification.counts", "bankVerifications"],
];

export function sectionForProcedure(path: string): AdminSection | null {
  const hit = API_SECTIONS.find(([p]) => matchesPath(p, path));
  return hit ? hit[1] : null;
}

function matchesPath(pattern: string, path: string): boolean {
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return pattern.endsWith(".") ? path.startsWith(pattern) : path === pattern;
}
