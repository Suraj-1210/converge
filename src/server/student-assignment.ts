import "server-only";
import { db } from "~/server/db";
import { createNotifications } from "~/server/notify";
import { appUrl, sendEmail, studentsAssignedEmail } from "~/server/email";
import {
  DEFAULT_NOTIFICATION_PREF,
  notificationPrefCode,
  type NotificationPref,
} from "~/lib/constants/notification-prefs";

// Telling a counsellor that students were assigned to them. Governed by the
// agency OWNER's "Notify my counsellors…" preference (My Account), not the
// counsellor's own: it is the owner's call how their team is told. No saved
// row = on.

export async function assignmentNotifyPref(
  ownerId: number,
): Promise<NotificationPref> {
  const row = await db.notification_preference.findUnique({
    where: {
      user_id_notification_type: {
        user_id: ownerId,
        notification_type: notificationPrefCode("team.assign"),
      },
    },
    select: { via_email: true, via_in_app: true },
  });
  return row
    ? { email: row.via_email === 1, inApp: row.via_in_app === 1 }
    : { ...DEFAULT_NOTIFICATION_PREF };
}

const fullName = (u: { first_name: string; last_name: string }) =>
  `${u.first_name} ${u.last_name}`.trim();

// One in-app notification and one email per call, listing every student, so
// a bulk assignment doesn't flood the counsellor. Never throws: the
// assignment is already saved, so a failed notification is only logged.
export async function notifyStudentsAssigned(args: {
  ownerId: number;
  counsellor: {
    id: number;
    first_name: string;
    last_name: string;
    email: string;
  };
  studentIds: number[];
}): Promise<{ inApp: boolean; email: boolean }> {
  const sent = { inApp: false, email: false };
  try {
    if (args.studentIds.length === 0 || args.counsellor.id === args.ownerId)
      return sent;
    const pref = await assignmentNotifyPref(args.ownerId);
    if (!pref.inApp && !pref.email) return sent;

    const [students, owner] = await Promise.all([
      db.student.findMany({
        where: { id: { in: args.studentIds } },
        select: { id: true, first_name: true, last_name: true },
        orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      }),
      db.user.findUnique({
        where: { id: args.ownerId },
        select: { first_name: true, last_name: true },
      }),
    ]);
    if (students.length === 0) return sent;
    const names = students.map(fullName);
    const one = students.length === 1 ? students[0]! : null;
    // A single student opens straight in its panel; several land on the list.
    const link = one
      ? `/partner/students?student=${one.id}`
      : "/partner/students";
    const by = owner ? fullName(owner) : "Your agency owner";

    if (pref.inApp) {
      try {
        const listed = names.slice(0, 5).join(", ");
        await createNotifications([args.counsellor.id], {
          type: "student.assigned",
          title: one
            ? `${names[0]} was assigned to you`
            : `${names.length} students were assigned to you`,
          body: one
            ? `Assigned by ${by}.`
            : `${listed}${names.length > 5 ? ` and ${names.length - 5} more` : ""}. Assigned by ${by}.`,
          link,
          tone: "blue",
        });
        sent.inApp = true;
      } catch (e) {
        console.error(
          "[assign] in-app notification failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (pref.email) {
      try {
        await sendEmail(
          args.counsellor.email,
          studentsAssignedEmail(
            { name: fullName(args.counsellor) },
            { assignedBy: by, students: names, link },
            appUrl(),
          ),
        );
        sent.email = true;
      } catch (e) {
        console.error(
          "[assign] email failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }
  } catch (e) {
    console.error(
      "[assign] notification failed:",
      e instanceof Error ? e.message : e,
    );
  }
  return sent;
}
