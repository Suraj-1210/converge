import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { PENDING_BANK_WHERE } from "~/server/bank-accounts";
import { flushPartnerUpdateEmails, partnerEditedStudentIds } from "~/server/student-changes";
import { shortlistBellItems } from "~/server/shortlist-approval";
import { bdmUserScope, staffStudentScope } from "~/server/staff-access";
import { staffChatSignals } from "~/server/partner-chat";
import {
  AdminRole,
  DocumentStatus,
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

// Who reviews partner edits to student profiles.
const COUNSELLING_ROLES: number[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.COUNSELLOR_LEAD,
  AdminRole.COUNSELLOR,
];

// Who verifies partner bank details (same roles as financeProcedure).
const BANK_VERIFIER_ROLES: number[] = [
  AdminRole.SUPER_ADMIN,
  AdminRole.FINANCE_MANAGER,
  AdminRole.FINANCE_EXECUTIVE,
];

export const notificationsRouter = createTRPCRouter({
  list: protectedAdminProcedure.query(async ({ ctx }) => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Student counts follow the admin Students list's visibility.
    const studentScope = await staffStudentScope(ctx.cpUser);
    // The bell polls, so it also sends any partner-edit emails whose burst
    // has ended (a backstop for the in-process timer after a restart).
    void flushPartnerUpdateEmails();
    const seesPartnerEdits = COUNSELLING_ROLES.includes(ctx.cpUser.role);
    // A BDM's partner signals cover only the partners they are BDM of, and
    // the finance queues aren't theirs (staff-access.ts).
    const isBdm = ctx.cpUser.role === AdminRole.BDM;
    const partnerUsers = await bdmUserScope(ctx.cpUser);

    const [
      pendingApprovals,
      pendingPartners,
      payoutsReady,
      invoicesPending,
      newStudents,
      bankPending,
      partnerEdited,
      chat,
      partnerDocsPending,
    ] = await Promise.all([
        db.user.count({
          where: {
            AND: [partnerUsers],
            type: UserType.AGENCY_COUNSELLOR,
            status: UserStatus.UNDER_REVIEW,
          },
        }),
        // Partner self-signups are agency owners / independent counsellors under
        // review — a DIFFERENT queue than counsellor approvals, surfaced on the
        // Partners page. Kept as its own signal so its notification links there.
        db.user.count({
          where: {
            AND: [partnerUsers],
            type: {
              in: [UserType.AGENCY_OWNER, UserType.INDEPENDENT_COUNSELLOR],
            },
            status: UserStatus.UNDER_REVIEW,
          },
        }),
        isBdm
          ? Promise.resolve(0)
          : db.partner_payout.count({
              where: { status: PayoutStatus.READY_TO_PAY },
            }),
        isBdm
          ? Promise.resolve(0)
          : db.invoice.count({
              where: {
                status: {
                  in: [
                    PartnerInvoiceStatus.SUBMITTED,
                    PartnerInvoiceStatus.UNDER_REVIEW,
                  ],
                },
              },
            }),
        db.student.count({ where: { AND: [studentScope], created_at: { gte: weekAgo } } }),
        // A partner saved new or changed bank details: finance's alert, shown
        // only to the roles that can verify them.
        BANK_VERIFIER_ROLES.includes(ctx.cpUser.role)
          ? db.partner_bank_account.count({ where: PENDING_BANK_WHERE })
          : Promise.resolve(0),
        // Students a partner edited that nobody here has reviewed yet, within
        // the same visibility as the admin Students list.
        seesPartnerEdits ? partnerEditedStudentIds(studentScope) : Promise.resolve([] as number[]),
        // Partner chat: unread threads and replies due or overdue (TAT), for
        // the student's counsellor, their lead and Super Admins only.
        staffChatSignals(ctx.cpUser, studentScope),
        // An approved partner's KYC document back at Pending: a GST
        // certificate after the owner changed the GST number, or a file
        // uploaded on a partner's behalf. (Applicants' documents are reviewed
        // with their application instead.)
        db.document.count({
          where: {
            AND: isBdm
              ? [{ OR: [{ user: partnerUsers }, { organization: { user: { some: partnerUsers } } }] }]
              : [],
            status: DocumentStatus.PENDING,
            is_most_recent: 1,
            student_id: null,
            OR: [
              { user: { status: UserStatus.APPROVED, deleted_at: null } },
              {
                organization: {
                  user: { some: { is_owner: 1, status: UserStatus.APPROVED, deleted_at: null } },
                },
              },
            ],
          },
        }),
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
    if (partnerDocsPending > 0) {
      notifications.push({
        id: "partner-documents",
        title: `${plural(partnerDocsPending, "partner document")} awaiting verification`,
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
    if (partnerEdited.length > 0) {
      notifications.push({
        id: "partner-edits",
        title: `${plural(partnerEdited.length, "student")} updated by partners`,
        time: "Needs review",
        tone: "orange",
        unread: true,
        href:
          partnerEdited.length === 1
            ? `/admin/students/${partnerEdited[0]!}`
            : "/admin/students?partnerEdits=1",
      });
    }
    notifications.push(...chat.items);
    // University shortlist approvals waiting on Collegepond (Phase 3B).
    if (seesPartnerEdits) {
      notifications.push(...(await shortlistBellItems(studentScope)));
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
        partnerChat: chat.unreadThreads,
      },
    };
  }),
});
