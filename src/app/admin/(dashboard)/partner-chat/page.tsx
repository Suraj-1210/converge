"use client";

import { PartnerChatInbox } from "~/components/partner-chat/inbox";

// Admin portal: partner chats within this staff user's student scope
// (counsellor, Counselling Lead, Super Admin; other roles are refused).
export default function AdminPartnerChatPage() {
  return <PartnerChatInbox side="staff" />;
}
