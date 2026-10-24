import { AdminRole } from "~/server/db/enums";

// Which admin roles may use each section of the admin portal (decided with
// Suraj, 24 Oct 2026). One table drives the sidebar, the page gate in
// DashboardShell and the server (adminSectionProcedure in ~/server/api/trpc),
// so hiding a page and refusing its data can't drift apart.
//
//   Counsellor / Ops Executive (4, 6) → Dashboard, Students, Applications,
//                                       Uni Assist, Events (+ Partner Chat: 4)
//   Counsellor Lead / Ops Lead (3, 5) → that, plus Partners, Student
//                                       Placements, Counselor Approvals,
//                                       Universities, TAT, Partner Chat
//   Finance, BDM, Content (1, 2, 8, 7) → what they had before
//   Users, Settings, Audit Logs        → Super Admin only
//
// Partner Chat follows the chat module's own participant rule
// (CHAT_STAFF_ROLES in ~/server/partner-chat-access).

export type AdminSection =
  | "partners"
  | "placements"
  | "counsellorApprovals"
  | "universities"
  | "notes"
  | "partnerChat"
  | "tat"
  | "bdm"
  | "finance"
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

export const ADMIN_SECTION_ROLES: Record<AdminSection, number[]> = {
  partners: ABOVE_COUNSELLOR,
  placements: ABOVE_COUNSELLOR,
  counsellorApprovals: ABOVE_COUNSELLOR,
  universities: ABOVE_COUNSELLOR,
  notes: ABOVE_COUNSELLOR,
  partnerChat: [SUPER_ADMIN, COUNSELLOR_LEAD, OPERATIONS_LEAD, COUNSELLOR],
  tat: [SUPER_ADMIN, COUNSELLOR_LEAD, OPERATIONS_LEAD],
  bdm: [SUPER_ADMIN, BDM],
  finance: [SUPER_ADMIN, FINANCE_MANAGER, FINANCE_EXECUTIVE],
  system: [SUPER_ADMIN],
};

export function canUseSection(role: number, section: AdminSection): boolean {
  return ADMIN_SECTION_ROLES[section].includes(role);
}

// Admin pages by path prefix. Anything not listed (Dashboard, Students,
// Applications, Uni Assist, Events) is open to every admin role.
const PATH_SECTIONS: [prefix: string, section: AdminSection][] = [
  ["/admin/partners", "partners"],
  ["/admin/student-placements", "placements"],
  ["/admin/counselor-approvals", "counsellorApprovals"],
  ["/admin/universities", "universities"],
  ["/admin/notes-reminders", "notes"],
  ["/admin/partner-chat", "partnerChat"],
  ["/admin/tat-management", "tat"],
  ["/admin/bdm-performance", "bdm"],
  ["/admin/commission-rates", "finance"],
  ["/admin/university-billing", "finance"],
  ["/admin/commissions", "finance"],
  ["/admin/invoices", "finance"],
  ["/admin/reconciliation", "finance"],
  ["/admin/bank-verifications", "finance"],
  ["/admin/users", "system"],
  ["/admin/settings", "system"],
  ["/admin/audit-logs", "system"],
];

export function sectionForPath(pathname: string): AdminSection | null {
  const hit = PATH_SECTIONS.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  return hit ? hit[1] : null;
}

export function canAccessAdminPath(role: number, pathname: string): boolean {
  const section = sectionForPath(pathname);
  return section === null || canUseSection(role, section);
}
