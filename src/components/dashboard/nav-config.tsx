import { type ReactNode } from "react";
import { type AdminSection } from "~/lib/admin-sections";
import {
  ApprovalsIcon,
  AuditLogIcon,
  BankIcon,
  BarChartIcon,
  BillingIcon,
  CalendarIcon,
  ChatIcon,
  ClockIcon,
  CommissionIcon,
  DashboardIcon,
  InvoiceIcon,
  PartnersIcon,
  PlacementsIcon,
  ReconciliationIcon,
  SearchIcon,
  SettingsIcon,
  StudentsIcon,
  UsersIcon,
} from "./nav-icons";

export type AdminRole =
  | "super_admin"
  | "bdm"
  | "ops_team_lead"
  | "ops_counselor"
  | "finance_mgr"
  | "finance_exec"
  | "content_mgr";

export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  badgeKey?: string;
  disabled?: boolean;
  /** Hidden from the sidebar entirely — kept in the config so it's trivial to
   *  re-enable later (the route/page still exists). Filtered out in Sidebar. */
  hidden?: boolean;
  roles?: AdminRole[];
  /** Portal section the item belongs to: only the roles allowed that section
   *  in ~/lib/admin-sections see it (the server and the page gate in
   *  DashboardShell use the same table). Unset = every admin role. */
  section?: AdminSection;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export interface RoleOption {
  value: AdminRole;
  name: string;
  label: string;
}

export const ROLE_OPTIONS: RoleOption[] = [
  { value: "super_admin", name: "Suraj Bajaj", label: "Super Admin" },
  { value: "bdm", name: "Aarav Kulkarni", label: "BDM" },
  { value: "ops_team_lead", name: "Priya Mehta", label: "Ops Team Lead" },
  { value: "ops_counselor", name: "Rahul Verma", label: "Ops Counselor" },
  { value: "finance_mgr", name: "Neha Sharma", label: "Finance Mgr" },
  { value: "finance_exec", name: "Amit Patel", label: "Finance Exec" },
  { value: "content_mgr", name: "Kavita Rao", label: "Content Mgr" },
];

// Maps the numeric AdminRole code (src/server/db/enums.ts) to the sidebar's
// string role. Ops/counsellor variants collapse to the nearest sidebar bucket;
// only the finance/admin gate is exercised today.
export function navRoleFromCode(code: number): AdminRole | null {
  switch (code) {
    case 0:
      return "super_admin";
    case 1:
      return "finance_mgr";
    case 2:
      return "finance_exec";
    case 3:
    case 5:
      return "ops_team_lead";
    case 4:
    case 6:
      return "ops_counselor";
    case 7:
      return "content_mgr";
    case 8:
      return "bdm";
    default:
      return null;
  }
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Operations",
    items: [
      { label: "Dashboard", href: "/admin/dashboard", icon: <DashboardIcon /> },
      {
        label: "Partners",
        href: "/admin/partners",
        icon: <PartnersIcon />,
        badgeKey: "partners",
        section: "partners",
      },
      { label: "Students", href: "/admin/students", icon: <StudentsIcon /> },
      { label: "Applications", href: "/admin/applications", icon: <InvoiceIcon /> },
      {
        label: "Student Placements",
        href: "/admin/student-placements",
        icon: <PlacementsIcon />,
        section: "placements",
      },
      {
        label: "Counselor Approvals",
        href: "/admin/counselor-approvals",
        icon: <ApprovalsIcon />,
        badgeKey: "approvals",
        section: "counsellorApprovals",
      },
      // Partner chat inbox: Super Admin, Counsellor Lead, Counsellor.
      {
        label: "Partner Chat",
        href: "/admin/partner-chat",
        icon: <ChatIcon />,
        badgeKey: "partnerChat",
        section: "partnerChat",
      },
      // TAT Management: real data for Chat Response (partner chat); the other
      // actions are still dev-only samples. Super Admin, Operations Lead,
      // Counsellor Lead.
      {
        label: "TAT Management",
        href: "/admin/tat-management",
        icon: <ClockIcon />,
        section: "tat",
      },
      // Deprecated in favour of TAT Management (itself deferred to phase 2).
      // Hidden from the nav; set `hidden: false` to restore.
      {
        label: "Notes & Reminders",
        href: "/admin/notes-reminders",
        icon: <ClockIcon />,
        hidden: true,
        section: "notes",
      },
      { label: "Uni Assist", href: "/admin/uni-assist", icon: <SearchIcon /> },
    ],
  },
  {
    label: "Business Dev",
    items: [
      {
        label: "BDM Performance",
        href: "/admin/bdm-performance",
        icon: <BarChartIcon />,
        section: "bdm",
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        label: "Commission Rates",
        href: "/admin/commission-rates",
        icon: <CommissionIcon />,
        section: "finance",
      },
      {
        label: "University Billing",
        href: "/admin/university-billing",
        icon: <BillingIcon />,
        section: "finance",
      },
      {
        label: "Commission Ledger",
        href: "/admin/commissions",
        icon: <AuditLogIcon />,
        section: "finance",
      },
      {
        label: "Invoices & Payouts",
        href: "/admin/invoices",
        icon: <InvoiceIcon />,
        section: "finance",
      },
      {
        label: "Reconciliation",
        href: "/admin/reconciliation",
        icon: <ReconciliationIcon />,
        section: "finance",
      },
      {
        label: "Bank Verifications",
        href: "/admin/bank-verifications",
        icon: <BankIcon />,
        badgeKey: "bankVerifications",
        section: "finance",
      },
    ],
  },
  {
    label: "Content",
    items: [
      {
        label: "Universities",
        href: "/admin/universities",
        icon: <StudentsIcon />,
        section: "universities",
      },
      { label: "Events", href: "/admin/events", icon: <CalendarIcon /> },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Reports",
        href: "/admin/reports",
        icon: <BarChartIcon />,
        disabled: true,
        section: "system",
      },
      { label: "Users", href: "/admin/users", icon: <UsersIcon />, section: "system" },
      { label: "Settings", href: "/admin/settings", icon: <SettingsIcon />, section: "system" },
      { label: "Audit Logs", href: "/admin/audit-logs", icon: <AuditLogIcon />, section: "system" },
    ],
  },
];
