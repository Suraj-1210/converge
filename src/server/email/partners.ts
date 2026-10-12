import "server-only";
import { db } from "~/server/db";
import { UserStatus } from "~/server/db/enums";
import { sendEmail } from "./index";
import type { EmailMessage, PartnerRef } from "./templates";
import {
  notificationPrefCode,
  type NotificationPrefKey,
} from "~/lib/constants/notification-prefs";

// Who at a partner receives an operational email, and a best-effort sender.
// These emails follow an admin action that has already been saved, so a mail
// failure is logged and never thrown back at the admin.

export interface Recipient extends PartnerRef {
  id: number;
  email: string;
}

// Approved partner users only: someone still under review, rejected or
// deactivated shouldn't get student or payout updates.
const active = { status: UserStatus.APPROVED } as const;

function toRecipient(u: {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  organization: { name: string } | null;
}): Recipient {
  return {
    id: u.id,
    email: u.email,
    name: `${u.first_name} ${u.last_name}`.trim(),
    company: u.organization?.name ?? null,
  };
}

const userSelect = {
  id: true,
  email: true,
  first_name: true,
  last_name: true,
  organization: { select: { name: true } },
} as const;

function dedupe(list: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The owner(s) of an agency: commission claims and payouts are theirs.
export async function orgOwnerRecipients(orgId: number): Promise<Recipient[]> {
  const owners = await db.user.findMany({
    where: { org_id: orgId, is_owner: 1, ...active },
    select: userSelect,
  });
  return dedupe(owners.map(toRecipient));
}

// A student's partner side: the agency owner(s) plus the partner counsellor
// handling the student (for an independent counsellor, the one who created it).
export async function studentPartnerRecipients(studentId: number): Promise<Recipient[]> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { org_id: true, counsellor_id: true, created_by_user_id: true },
  });
  if (!student) return [];
  const ids = [student.counsellor_id, student.created_by_user_id].filter(
    (x): x is number => x != null,
  );
  const [owners, handlers] = await Promise.all([
    student.org_id ? orgOwnerRecipients(student.org_id) : Promise.resolve([]),
    ids.length
      ? db.user.findMany({ where: { id: { in: ids }, ...active }, select: userSelect })
      : Promise.resolve([]),
  ]);
  return dedupe([...owners, ...handlers.map(toRecipient)]);
}

// Recipients who switched this email off in their notification preferences.
async function optedOut(recipients: Recipient[], pref: NotificationPrefKey): Promise<Set<number>> {
  if (recipients.length === 0) return new Set();
  const rows = await db.notification_preference.findMany({
    where: {
      user_id: { in: recipients.map((r) => r.id) },
      notification_type: notificationPrefCode(pref),
      via_email: 0,
    },
    select: { user_id: true },
  });
  return new Set(rows.map((r) => r.user_id));
}

// Sends `build(recipient)` to each recipient. Returns how many went out; logs
// failures (with `context`, never the address) instead of throwing.
// `pref`: the notification preference that governs this email — anyone who
// turned it off is skipped. Omit it only for account-critical emails.
export async function emailPartners(
  recipients: Recipient[],
  build: (r: Recipient) => EmailMessage,
  context: string,
  pref?: NotificationPrefKey,
): Promise<number> {
  const skip = pref ? await optedOut(recipients, pref) : new Set<number>();
  if (skip.size) console.log(`[email] ${context}: ${skip.size} recipient(s) opted out (${pref})`);
  let sent = 0;
  for (const r of recipients.filter((x) => !skip.has(x.id))) {
    try {
      await sendEmail(r.email, build(r));
      sent++;
    } catch (e) {
      console.error(`[email] ${context} failed:`, e instanceof Error ? e.message : e);
    }
  }
  if (recipients.length === 0) {
    console.log(`[email] ${context}: no active partner recipients`);
  }
  return sent;
}
