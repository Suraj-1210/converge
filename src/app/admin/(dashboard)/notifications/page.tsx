"use client";

import { NotificationsPage } from "~/components/notifications/notifications-page";

// Admin portal: the full notifications page behind the bell's "View all".
export default function AdminNotificationsPage() {
  return <NotificationsPage side="admin" />;
}
