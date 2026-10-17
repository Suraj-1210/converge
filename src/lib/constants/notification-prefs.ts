// Partner notification preferences (My Account → Notification Preferences).
// Shared by the toggle screen and the server so a toggle and the email it
// controls agree. `code` is notification_preference.notification_type — never
// renumber one; retired types just disappear from the list.
//
// `email` says whether an email is actually sent for this today; the other
// toggles are saved and take effect once their email exists. via_sms stays 0
// (no WhatsApp notifications).
//
// `inApp` rows also get an in-app toggle (via_in_app); every other in-app
// notification is always shown. `ownerOnly` rows are agency-owner settings,
// hidden from (and refused for) counsellors and independents.
// Account-critical emails (login codes, application decisions, document and
// more-info requests, deactivation) are always sent and have no toggle.

export interface NotificationPrefRow {
  key: string;
  code: number;
  label: string;
  email: boolean;
  inApp?: boolean;
  ownerOnly?: boolean;
  hint?: string;
}

export const NOTIFICATION_PREF_GROUPS: { title: string; rows: NotificationPrefRow[] }[] = [
  {
    title: "Application Updates",
    rows: [
      { key: "app.new", code: 0, label: "New Application Submitted", email: false },
      { key: "app.status", code: 1, label: "Application Status Change", email: true },
      { key: "app.doc", code: 2, label: "Document Uploaded by Partner", email: false },
      { key: "app.offer", code: 3, label: "Offer Letter Received", email: true },
      {
        key: "app.shortlist",
        code: 13,
        label: "University Shortlist Proposals & Decisions",
        email: true,
        inApp: true,
        hint: "When Collegepond proposes a university for your student, or approves or rejects one you proposed.",
      },
    ],
  },
  {
    title: "Financial",
    rows: [
      { key: "fin.commission", code: 4, label: "Commission Credited", email: true },
      { key: "fin.invoice", code: 5, label: "Commission Claim Approved / Not Approved", email: true },
      { key: "fin.payment", code: 6, label: "Payment Reminder", email: false },
    ],
  },
  {
    title: "Messages",
    rows: [
      {
        key: "chat.message",
        code: 12,
        label: "New chat messages from Collegepond",
        email: true,
        inApp: true,
        hint: "A bell notification for each new message, and an email if one stays unread for 15 minutes.",
      },
    ],
  },
  {
    title: "Events",
    rows: [{ key: "evt.reminder", code: 7, label: "Upcoming Event Reminder", email: false }],
  },
  {
    // Read on the owner's account, but the notifications go to counsellors.
    title: "My Team",
    rows: [
      {
        key: "team.assign",
        code: 11,
        label: "Notify my counsellors when students are assigned to them",
        email: true,
        inApp: true,
        ownerOnly: true,
        hint: "One notification per assignment, listing the students. Applies to all your counsellors.",
      },
    ],
  },
  {
    title: "System",
    rows: [
      { key: "sys.feature", code: 8, label: "New Feature Announcements", email: false },
      { key: "sys.maintenance", code: 9, label: "System Maintenance Alerts", email: false },
      { key: "sys.report", code: 10, label: "Monthly Performance Report", email: false },
    ],
  },
];

export const NOTIFICATION_PREF_ROWS = NOTIFICATION_PREF_GROUPS.flatMap((g) => g.rows);

export type NotificationPrefKey =
  | "app.new" | "app.status" | "app.doc" | "app.offer" | "app.shortlist"
  | "fin.commission" | "fin.invoice" | "fin.payment"
  | "evt.reminder"
  | "team.assign"
  | "chat.message"
  | "sys.feature" | "sys.maintenance" | "sys.report";

export function notificationPrefCode(key: NotificationPrefKey): number {
  const row = NOTIFICATION_PREF_ROWS.find((r) => r.key === key);
  if (!row) throw new Error(`Unknown notification preference ${key}`);
  return row.code;
}

// With no saved row, every channel is on.
export const DEFAULT_NOTIFICATION_PREF = { email: true, inApp: true } as const;

export type NotificationPref = { email: boolean; inApp: boolean };

// The groups a partner of this kind sees: owner-only rows are dropped for
// everyone but agency owners, and a group left empty disappears.
export function notificationPrefGroupsFor(isOwner: boolean) {
  return NOTIFICATION_PREF_GROUPS.map((g) => ({
    ...g,
    rows: g.rows.filter((r) => isOwner || !r.ownerOnly),
  })).filter((g) => g.rows.length > 0);
}
