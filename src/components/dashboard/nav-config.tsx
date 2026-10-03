import { type ReactNode } from "react";
import {
  ApprovalsIcon,
  AuditLogIcon,
  BarChartIcon,
  BillingIcon,
  CalendarIcon,
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

// Finance section is visible only to finance staff + admins; everyone else has
// it hidden from the sidebar (the server also blocks the calls).
const FINANCE_NAV_ROLES: AdminRole[] = [
  "super_admin",
  "finance_mgr",
  "finance_exec",
];

// BDM Performance: BDMs and Super Admin only (the server also blocks the calls).
const BDM_NAV_ROLES: AdminRole[] = ["super_admin", "bdm"];

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
      },
      { label: "Students", href: "/admin/students", icon: <StudentsIcon /> },
      { label: "Applications", href: "/admin/applications", icon: <InvoiceIcon /> },
      {
        label: "Student Placements",
        href: "/admin/student-placements",
        icon: <PlacementsIcon />,
      },
      {
        label: "Counselor Approvals",
        href: "/admin/counselor-approvals",
        icon: <ApprovalsIcon />,
        badgeKey: "approvals",
      },
      // TAT Management — HIDDEN for now (gated off until the feature is ready).
      // The route/page at /admin/tat-management still exists and stays admin-gated;
      // set `hidden: false` (or delete the flag) to bring the tab back in the nav.
      {
        label: "TAT Management",
        href: "/admin/tat-management",
        icon: <ClockIcon />,
        hidden: true,
      },
      // Deprecated in favour of TAT Management (itself deferred to phase 2).
      // Hidden from the nav; set `hidden: false` to restore.
      {
        label: "Notes & Reminders",
        href: "/admin/notes-reminders",
        icon: <ClockIcon />,
        hidden: true,
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
        roles: BDM_NAV_ROLES,
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
        roles: FINANCE_NAV_ROLES,
      },
      {
        label: "University Billing",
        href: "/admin/university-billing",
        icon: <BillingIcon />,
        roles: FINANCE_NAV_ROLES,
      },
      {
        label: "Commission Ledger",
        href: "/admin/commissions",
        icon: <AuditLogIcon />,
        roles: FINANCE_NAV_ROLES,
      },
      {
        label: "Invoices & Payouts",
        href: "/admin/invoices",
        icon: <InvoiceIcon />,
        roles: FINANCE_NAV_ROLES,
      },
      {
        label: "Reconciliation",
        href: "/admin/reconciliation",
        icon: <ReconciliationIcon />,
        roles: FINANCE_NAV_ROLES,
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
      },
      { label: "Users", href: "/admin/users", icon: <UsersIcon /> },
      { label: "Settings", href: "/admin/settings", icon: <SettingsIcon /> },
      { label: "Audit Logs", href: "/admin/audit-logs", icon: <AuditLogIcon /> },
    ],
  },
];
