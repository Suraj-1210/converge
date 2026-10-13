import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { PENDING_BANK_WHERE } from "~/server/bank-accounts";
import {
  AdminRole,
  PartnerInvoiceStatus,
  PayoutStatus,
  UserStatus,
  UserType,
} from "~/server/db/enums";

// Live admin notification feed. Rather than a separate event-log table, the bell
// is derived from real, current actionable state — the work actually sitting in
// the system right now. Each signal is included only when its count > 0, so a
// clean queue shows an empty bell instead of fabricated entries. This replaces
// the hardcoded DEFAULT_NOTIFICATIONS that previously rendered (synthetic) in
// prod. The same pending-approvals count also drives the sidebar badge, so the
// two can never disagree.

export type NotificationTone = "blue" | "green" | "orange" | "red" | "gray";

export interface AdminNotification {
  id: string;
  title: string;
  time: string;
  tone: NotificationTone;
  unread: boolean;
  href: string;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// Who verifies partner bank details (same roles as financeProcedure).
const BANK_VERIFIER_ROLES: number[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_MANAGER,
  AdminRole.FINANCE_EXECUTIVE,
];

export const notificationsRouter = createTRPCRouter({
  list: protectedAdminProcedure.query(async ({ ctx }) => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      pendingApprovals,
      pendingPartners,
      payoutsReady,
      invoicesPending,
      newStudents,
      bankPending,
    ] = await Promise.all([
        db.user.count({
          where: {
            type: UserType.AGENCY_COUNSELLOR,
            status: UserStatus.UNDER_REVIEW,
          },
        }),
        // Partner self-signups are agency owners / independent counsellors under
        // review — a DIFFERENT queue than counsellor approvals, surfaced on the
        // Partners page. Kept as its own signal so its notification links there.
        db.user.count({
          where: {
            type: {
              in: [UserType.AGENCY_OWNER, UserType.INDEPENDENT_COUNSELLOR],
            },
            status: UserStatus.UNDER_REVIEW,
          },
        }),
        db.partner_payout.count({
          where: { status: PayoutStatus.READY_TO_PAY },
        }),
        db.invoice.count({
          where: {
            status: {
              in: [
                PartnerInvoiceStatus.SUBMITTED,
                PartnerInvoiceStatus.UNDER_REVIEW,
              ],
            },
          },
        }),
        db.student.count({ where: { created_at: { gte: weekAgo } } }),
        // A partner saved new or changed bank details: finance's alert, shown
        // only to the roles that can verify them.
        BANK_VERIFIER_ROLES.includes(ctx.cpUser.role)
          ? db.partner_bank_account.count({ where: PENDING_BANK_WHERE })
          : Promise.resolve(0),
      ]);

    const notifications: AdminNotification[] = [];

    if (pendingApprovals > 0) {
      notifications.push({
        id: "approvals",
        title: `${plural(pendingApprovals, "counselor approval")} awaiting review`,
        time: "Needs review",
        tone: "orange",
        unread: true,
        href: "/admin/counselor-approvals",
      });
    }
    if (pendingPartners > 0) {
      notifications.push({
        id: "partner-approvals",
        title: `${plural(pendingPartners, "partner application")} awaiting review`,
        time: "Needs review",
        tone: "orange",
        unread: true,
        href: "/admin/partners",
      });
    }
    if (payoutsReady > 0) {
      notifications.push({
        id: "payouts",
        title: `${plural(payoutsReady, "payout")} ready to release`,
        time: "Finance",
        tone: "blue",
        unread: true,
        href: "/admin/reconciliation",
      });
    }
    if (bankPending > 0) {
      notifications.push({
        id: "bank-verifications",
        title: `${plural(bankPending, "partner bank account")} awaiting verification`,
        time: "Finance",
        tone: "orange",
        unread: true,
        href: "/admin/bank-verifications",
      });
    }
    if (invoicesPending > 0) {
      notifications.push({
        id: "invoices",
        title: `${plural(invoicesPending, "partner invoice")} awaiting review`,
        time: "Finance",
        tone: "orange",
        unread: true,
        href: "/admin/invoices",
      });
    }
    if (newStudents > 0) {
      notifications.push({
        id: "students",
        title: `${plural(newStudents, "new student")} added this week`,
        time: "This week",
        tone: "green",
        unread: false,
        href: "/admin/students",
      });
    }

    return {
      notifications,
      badges: {
        approvals: pendingApprovals,
        partners: pendingPartners,
        bankVerifications: bankPending,
      },
    };
  }),
});
