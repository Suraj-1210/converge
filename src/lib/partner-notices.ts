// Partner Notices master (Settings -> Partner Notices, 16 Nov 2026): the
// triggers the code implements, their default settings (today's wording) and
// the template renderer. Client-safe: the Settings preview renders templates
// with the same function the partner dashboard's server uses.
//
// The trigger LOGIC (what fires a notice) lives in src/server/partner-notices.ts.
// Admins can only tune these triggers (on/off, wording, severity, order,
// window, audience) and add free-text manual notices; they can't invent new
// trigger logic. A trigger with no partner_notice_trigger row uses DEFAULTS
// below, so this file is also the seed.

export const NoticeSeverity = {
  INFO: 1,
  SUCCESS: 2,
  WARNING: 3,
  ACTION: 4,
} as const;
export type NoticeSeverity = (typeof NoticeSeverity)[keyof typeof NoticeSeverity];

export const NOTICE_SEVERITIES: { value: NoticeSeverity; label: string }[] = [
  { value: NoticeSeverity.INFO, label: "Info" },
  { value: NoticeSeverity.SUCCESS, label: "Success" },
  { value: NoticeSeverity.WARNING, label: "Warning" },
  { value: NoticeSeverity.ACTION, label: "Action needed" },
];

// The dashboard's dot colours (blue / green / amber / red).
export type NoticeTone = "blue" | "green" | "amber" | "red";
export const SEVERITY_TONE: Record<NoticeSeverity, NoticeTone> = {
  [NoticeSeverity.INFO]: "blue",
  [NoticeSeverity.SUCCESS]: "green",
  [NoticeSeverity.WARNING]: "amber",
  [NoticeSeverity.ACTION]: "red",
};
export function severityTone(s: number): NoticeTone {
  return SEVERITY_TONE[s as NoticeSeverity] ?? "blue";
}
export function severityLabel(s: number): string {
  return NOTICE_SEVERITIES.find((x) => x.value === s)?.label ?? "Info";
}

// Who sees a notice. "Owner" means the partner owner: the agency owner or an
// independent counsellor (the payee). Agency counsellors never see money or
// account notices, whatever is saved here (enforced in the server module).
export const NoticeAudience = {
  OWNER: 1,
  COUNSELLOR: 2,
  BOTH: 3,
} as const;
export type NoticeAudience = (typeof NoticeAudience)[keyof typeof NoticeAudience];

export const NOTICE_AUDIENCES: { value: NoticeAudience; label: string }[] = [
  { value: NoticeAudience.OWNER, label: "Owners and independents" },
  { value: NoticeAudience.COUNSELLOR, label: "Agency counsellors" },
  { value: NoticeAudience.BOTH, label: "Owners, independents and agency counsellors" },
];
export function audienceLabel(a: number): string {
  return NOTICE_AUDIENCES.find((x) => x.value === a)?.label ?? "—";
}
// Manual notices word "both" as "all partners".
export const MANUAL_AUDIENCES: { value: NoticeAudience; label: string }[] = [
  { value: NoticeAudience.BOTH, label: "All partners" },
  { value: NoticeAudience.OWNER, label: "Owners and independents" },
  { value: NoticeAudience.COUNSELLOR, label: "Agency counsellors" },
];

export type ViewerRole = "owner" | "counsellor";
export function audienceIncludes(audience: number, role: ViewerRole): boolean {
  if (audience === NoticeAudience.BOTH) return true;
  return role === "owner" ? audience === NoticeAudience.OWNER : audience === NoticeAudience.COUNSELLOR;
}

// ---- templates ----------------------------------------------------------------
//
// {name}    a placeholder value ({count}, {student}, {date}...)
// {a|b}     "a" when {count} is 1, else "b": "{count} {commission is|commissions are} ready"
//
// An unknown {name} is left as typed, so a typo shows up in the preview.

const TOKEN = /\{([^{}]*)\}/g;

export function renderTemplate(template: string, values: Record<string, string | number>): string {
  const count = Number(values.count ?? 1);
  return template.replace(TOKEN, (whole, inner: string) => {
    const bar = inner.indexOf("|");
    if (bar >= 0) return count === 1 ? inner.slice(0, bar) : inner.slice(bar + 1);
    const v = values[inner.trim()];
    return v === undefined ? whole : String(v);
  });
}

// The {name} placeholders a template uses (choices excluded).
export function templatePlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TOKEN)) {
    const inner = m[1] ?? "";
    if (!inner.includes("|")) out.push(inner.trim());
  }
  return out;
}

// ---- the trigger registry -----------------------------------------------------

export type TriggerGroup = "account" | "money" | "student" | "events";
export const TRIGGER_GROUP_LABEL: Record<TriggerGroup, string> = {
  account: "Account",
  money: "Commission & payouts",
  student: "Application milestones",
  events: "Events",
};

export interface TriggerConfig {
  enabled: boolean;
  title: string;
  body: string | null;
  severity: NoticeSeverity;
  sortOrder: number;
  windowDays: number | null;
  audience: NoticeAudience;
}

export interface Placeholder {
  key: string;
  desc: string;
  sample: string | number;
}

export interface TriggerDef {
  code: string;
  label: string; // admin name
  fires: string; // when it fires, for admins
  group: TriggerGroup;
  // Money / account notices: owner and independent only, locked.
  ownerOnly: boolean;
  // False while the data it needs doesn't exist yet (shown, editable, but
  // never fires).
  available: boolean;
  link: string; // where the notice links to, for admins
  placeholders: Placeholder[];
  // The window in days applies ("paid in the last N days").
  windowApplies: boolean;
  defaults: TriggerConfig;
}

const P = {
  count: { key: "count", desc: "How many", sample: 3 },
  days: { key: "days", desc: "The window in days", sample: 14 },
  date: { key: "date", desc: "The date it happened", sample: "12 Nov 2026" },
  student: { key: "student", desc: "Student name", sample: "Aarav Mehta" },
  university: { key: "university", desc: "University", sample: "University of Toronto" },
  course: { key: "course", desc: "Course", sample: "MSc Computer Science" },
} satisfies Record<string, Placeholder>;

const STUDENT_PLACEHOLDERS = [P.student, P.university, P.course, P.date, P.days];

function owner(
  sortOrder: number,
  severity: NoticeSeverity,
  title: string,
  body: string | null,
  windowDays: number | null = null,
): TriggerConfig {
  return { enabled: true, title, body, severity, sortOrder, windowDays, audience: NoticeAudience.OWNER };
}
function both(
  sortOrder: number,
  severity: NoticeSeverity,
  title: string,
  body: string | null,
  windowDays: number | null = null,
): TriggerConfig {
  return { enabled: true, title, body, severity, sortOrder, windowDays, audience: NoticeAudience.BOTH };
}

const S = NoticeSeverity;
const APP_LINK = "The student's Applications tab";

export const NOTICE_TRIGGERS: TriggerDef[] = [
  // ---- account (owner only) ----
  {
    code: "mou_signed",
    label: "MOU signed",
    fires: "The partner has signed their MOU.",
    group: "account",
    ownerOnly: true,
    available: true,
    link: "My Account › Documents",
    placeholders: [{ ...P.date, desc: "Date the MOU was signed" }],
    windowApplies: false,
    defaults: owner(10, S.SUCCESS, "Your MOU is signed", "Signed on {date}. View or download it under My Account → Documents."),
  },
  {
    code: "mou_pending",
    label: "MOU waiting for signature",
    fires: "The partner hasn't signed their MOU yet.",
    group: "account",
    ownerOnly: true,
    available: true,
    link: "MOU signing",
    placeholders: [],
    windowApplies: false,
    defaults: owner(20, S.WARNING, "Your MOU is waiting for your signature", null),
  },
  // ---- money (owner only) ----
  {
    code: "commission_claimable",
    label: "Commissions ready to claim",
    fires: "One or more commissions (or instalments) can be claimed now.",
    group: "money",
    ownerOnly: true,
    available: true,
    link: "Commission",
    placeholders: [P.count, { key: "amount", desc: "Total claimable (INR)", sample: "₹1,25,000" }],
    windowApplies: false,
    defaults: owner(
      30,
      S.SUCCESS,
      "{count} {commission is|commissions are} ready to claim",
      "{amount} available. Raise an invoice from the Commission page.",
    ),
  },
  {
    code: "commission_paid",
    label: "Commissions paid out",
    fires: "Commissions paid to the partner within the window.",
    group: "money",
    ownerOnly: true,
    available: true,
    link: "Commission",
    placeholders: [P.count, { ...P.days, sample: 30 }],
    windowApplies: true,
    defaults: owner(
      40,
      S.INFO,
      "{count} {commission was|commissions were} paid out in the last {days} days",
      "See the payment dates on the Commission page.",
      30,
    ),
  },
  {
    code: "payout_hold",
    label: "Payouts on hold",
    fires: "Finance has put the partner's payouts on hold.",
    group: "money",
    ownerOnly: true,
    available: true,
    link: "Commission",
    placeholders: [
      { key: "reason", desc: "Why, as Finance wrote it", sample: "Pending document verification" },
      { ...P.date, desc: "Date the hold was placed" },
    ],
    windowApplies: false,
    defaults: owner(45, S.ACTION, "Your payouts are on hold", "{reason}. Contact your Relationship Manager for details."),
  },
  {
    code: "bank_missing",
    label: "Add bank details",
    fires: "No payout bank account on file.",
    group: "account",
    ownerOnly: true,
    available: true,
    link: "My Account › Bank",
    placeholders: [],
    windowApplies: false,
    defaults: owner(50, S.WARNING, "Add your bank details to get paid", "Commission can only be paid out to a verified bank account."),
  },
  {
    code: "bank_rejected",
    label: "Bank details need attention",
    fires: "Collegepond rejected the bank details.",
    group: "account",
    ownerOnly: true,
    available: true,
    link: "My Account › Bank",
    placeholders: [
      {
        key: "reason",
        desc: "The rejection reason (or \"Please re-enter them with a valid proof.\")",
        sample: "The cheque is unreadable.",
      },
    ],
    windowApplies: false,
    defaults: owner(51, S.ACTION, "Your bank details need attention", "{reason}"),
  },
  {
    code: "bank_pending",
    label: "Bank details being verified",
    fires: "Bank details are waiting for Collegepond's verification.",
    group: "account",
    ownerOnly: true,
    available: true,
    link: "My Account › Bank",
    placeholders: [],
    windowApplies: false,
    defaults: owner(52, S.INFO, "Your bank details are being verified", null),
  },
  {
    code: "tier_change",
    label: "Tier upgrade",
    fires: "The partner moved up a Partner Tier within the window (automatically or set by a Super Admin).",
    group: "account",
    ownerOnly: true,
    available: true,
    link: "My Account › Loyalty",
    placeholders: [
      { key: "tier", desc: "New tier", sample: "Gold" },
      { key: "previous", desc: "Previous tier", sample: "Silver" },
      P.days,
    ],
    windowApplies: true,
    defaults: owner(
      60,
      S.SUCCESS,
      "You're now a {tier} Partner",
      "You moved up from {previous}. See your new benefits under My Account → Loyalty.",
      14,
    ),
  },
  {
    code: "documents_rejected",
    label: "Account documents rejected",
    fires: "Collegepond rejected one or more of the partner's account documents (PAN, GST certificate…).",
    group: "account",
    ownerOnly: true,
    available: true,
    link: "My Account › Documents",
    placeholders: [P.count, { key: "documents", desc: "The documents' names", sample: "PAN Card, GST Certificate" }],
    windowApplies: false,
    defaults: owner(
      70,
      S.ACTION,
      "{count} account {document needs|documents need} re-uploading",
      "{documents}. Upload a new copy under My Account → Documents.",
    ),
  },
  {
    code: "gst_reverify",
    label: "GST certificate being re-verified",
    fires: "The agency changed its GST number and the certificate is waiting for re-verification.",
    group: "account",
    ownerOnly: true,
    available: true,
    link: "My Account › Documents",
    placeholders: [{ ...P.date, desc: "Date the GST number changed" }],
    windowApplies: false,
    defaults: owner(
      75,
      S.INFO,
      "Your GST certificate is being re-verified",
      "You changed your GST number on {date}. If your certificate shows the old number, upload the new one under My Account → Documents.",
    ),
  },
  // ---- events ----
  {
    code: "event_invite",
    label: "New event invite",
    fires: "The partner user is invited to an upcoming event and hasn't answered yet.",
    group: "events",
    ownerOnly: false,
    available: true,
    link: "Events",
    placeholders: [
      { key: "event", desc: "Event title", sample: "UK Universities Roadshow" },
      { ...P.date, desc: "Event date", sample: "28 Nov 2026" },
      { key: "location", desc: "Venue, or \"Online\"", sample: "Mumbai" },
    ],
    windowApplies: false,
    defaults: both(80, S.INFO, "You're invited: {event}", "{date} · {location}. Let us know if you can make it on the Events page."),
  },
  // ---- application milestones (owner + the student's counsellor) ----
  {
    code: "app_conditional_offer",
    label: "Conditional offer",
    fires: "An application reached Conditional Offer within the window.",
    group: "student",
    ownerOnly: false,
    available: true,
    link: APP_LINK,
    placeholders: STUDENT_PLACEHOLDERS,
    windowApplies: true,
    defaults: both(100, S.SUCCESS, "Conditional offer for {student}", "{university} · {course}", 14),
  },
  {
    code: "app_unconditional_offer",
    label: "Unconditional offer",
    fires: "An application reached Unconditional Offer within the window.",
    group: "student",
    ownerOnly: false,
    available: true,
    link: APP_LINK,
    placeholders: STUDENT_PLACEHOLDERS,
    windowApplies: true,
    defaults: both(110, S.SUCCESS, "Unconditional offer for {student}", "{university} · {course}", 14),
  },
  {
    code: "app_rejected",
    label: "Rejected by university",
    fires: "A university rejected an application within the window.",
    group: "student",
    ownerOnly: false,
    available: true,
    link: APP_LINK,
    placeholders: [
      ...STUDENT_PLACEHOLDERS,
      { key: "reason", desc: "Rejection reason (or \"Not given\")", sample: "English Language Requirements Not Met" },
    ],
    windowApplies: true,
    defaults: both(120, S.WARNING, "{university} rejected {student}'s application", "{course}. Reason: {reason}", 14),
  },
  {
    code: "app_deposit",
    label: "Deposit confirmed",
    fires: "Collegepond confirmed a deposit (Deposit Paid) within the window.",
    group: "student",
    ownerOnly: false,
    available: true,
    link: APP_LINK,
    placeholders: STUDENT_PLACEHOLDERS,
    windowApplies: true,
    defaults: both(130, S.SUCCESS, "Deposit confirmed for {student}", "{university} · {course}", 14),
  },
  {
    code: "app_visa_approved",
    label: "Visa approved",
    fires: "A visa was approved within the window.",
    group: "student",
    ownerOnly: false,
    available: true,
    link: APP_LINK,
    placeholders: STUDENT_PLACEHOLDERS,
    windowApplies: true,
    defaults: both(140, S.SUCCESS, "Visa approved for {student}", "{university} · {course}", 14),
  },
  {
    code: "app_visa_refused",
    label: "Visa refused",
    fires: "A visa was refused within the window.",
    group: "student",
    ownerOnly: false,
    available: true,
    link: APP_LINK,
    placeholders: STUDENT_PLACEHOLDERS,
    windowApplies: true,
    defaults: both(150, S.ACTION, "Visa refused for {student}", "{university} · {course}", 14),
  },
];

export const TRIGGER_BY_CODE = new Map(NOTICE_TRIGGERS.map((t) => [t.code, t]));

export const MAX_WINDOW_DAYS = 365;

// Sample values for the Settings preview.
export function sampleValues(def: TriggerDef, windowDays: number | null): Record<string, string | number> {
  const v: Record<string, string | number> = {};
  for (const p of def.placeholders) v[p.key] = p.sample;
  if (windowDays != null) v.days = windowDays;
  return v;
}

// What a partner sees: one row in Important Notices.
export interface NoticeView {
  id: string;
  tone: NoticeTone;
  title: string;
  body?: string;
  href?: string;
  external?: boolean;
}

// A manual notice's link: a portal path or an https:// URL.
export function isValidNoticeLink(url: string): boolean {
  return (url.startsWith("/") && !url.startsWith("//")) || /^https:\/\/[^\s]+$/i.test(url);
}
