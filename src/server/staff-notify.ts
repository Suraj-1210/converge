import "server-only";
import { db } from "~/server/db";
import { type NotificationTone } from "~/server/notify";

// Persist an in-app notification for Collegepond staff (cp_notification), the
// staff counterpart of ~/server/notify (partner users). It feeds the admin
// bell next to the live, derived signals (routers/notifications.ts) and the
// history on the admin Notifications page. Never throws: every caller has
// already saved the change it's telling people about.
export async function createStaffNotifications(
  cpUserIds: (number | null | undefined)[],
  n: { type: string; title: string; body?: string | null; link?: string | null; tone?: NotificationTone },
): Promise<void> {
  const ids = [...new Set(cpUserIds.filter((id): id is number => typeof id === "number" && id > 0))];
  if (ids.length === 0) return;
  try {
    await db.cp_notification.createMany({
      data: ids.map((cp_user_id) => ({
        cp_user_id,
        type: n.type,
        title: n.title.slice(0, 255),
        body: n.body ? n.body.slice(0, 500) : null,
        link: n.link ?? null,
        tone: n.tone ?? "blue",
      })),
    });
  } catch (e) {
    console.error("[staff-notify] failed:", e instanceof Error ? e.message : e);
  }
}

// One rolling item per person and link while it's unread (e.g. one per chat
// thread): a newer event updates it instead of adding another row.
export async function upsertStaffNotification(
  cpUserId: number,
  n: { type: string; title: string; body?: string | null; link: string; tone?: NotificationTone },
): Promise<void> {
  try {
    const existing = await db.cp_notification.findFirst({
      where: { cp_user_id: cpUserId, type: n.type, link: n.link, read_at: null },
      select: { id: true },
    });
    if (existing) {
      await db.cp_notification.update({
        where: { id: existing.id },
        data: { title: n.title.slice(0, 255), body: n.body ? n.body.slice(0, 500) : null, created_at: new Date() },
      });
    } else {
      await createStaffNotifications([cpUserId], n);
    }
  } catch (e) {
    console.error("[staff-notify] upsert failed:", e instanceof Error ? e.message : e);
  }
}

// Mark someone's items for a link read (e.g. they opened the chat thread).
export async function markStaffNotificationsRead(cpUserId: number, type: string, link: string): Promise<void> {
  await db.cp_notification.updateMany({
    where: { cp_user_id: cpUserId, type, link, read_at: null },
    data: { read_at: new Date() },
  });
}
