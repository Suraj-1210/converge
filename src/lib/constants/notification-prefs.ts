// Partner notification preferences (My Account → Notification Preferences).
// Shared by the toggle screen and the server so a toggle and the email it
// controls agree. `code` is notification_preference.notification_type — never
// renumber one; retired types just disappear from the list.
//
// `email` says whether an email is actually sent for this today; the other
// toggles are saved and take effect once their email exists. Email is the only
// channel (no WhatsApp notifications), so via_sms stays 0.
// Account-critical emails (login codes, application decisions, document and
// more-info requests, deactivation) are always sent and have no toggle.

export interface NotificationPrefRow {
  key: string;
  code: number;
  label: string;
  email: boolean;
}

export const NOTIFICATION_PREF_GROUPS: { title: string; rows: NotificationPrefRow[] }[] = [
  {
    title: "Application Updates",
    rows: [
      { key: "app.new", code: 0, label: "New Application Submitted", email: false },
      { key: "app.status", code: 1, label: "Application Status Change", email: true },
      { key: "app.doc", code: 2, label: "Document Uploaded by Partner", email: false },
      { key: "app.offer", code: 3, label: "Offer Letter Received", email: true },
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
    title: "Events",
    rows: [{ key: "evt.reminder", code: 7, label: "Upcoming Event Reminder", email: false }],
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
  | "app.new" | "app.status" | "app.doc" | "app.offer"
  | "fin.commission" | "fin.invoice" | "fin.payment"
  | "evt.reminder"
  | "sys.feature" | "sys.maintenance" | "sys.report";

export function notificationPrefCode(key: NotificationPrefKey): number {
  const row = NOTIFICATION_PREF_ROWS.find((r) => r.key === key);
  if (!row) throw new Error(`Unknown notification preference ${key}`);
  return row.code;
}

// With no saved row, email is on.
export const DEFAULT_NOTIFICATION_PREF = { email: true } as const;
