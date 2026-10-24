// Partner chat reply-time rules shared by the server and the inbox (decided
// with Suraj, 24 Oct 2026, from Portal Testing Day 5).
//
//  - Acknowledgements: a short partner message made only of phrases from a
//    small list ("thanks", "ok", 👍 …) doesn't START the reply clock. It stays
//    in the thread like any other message. Super Admin edits the list and the
//    length cap in Settings → TAT Settings.
//  - "No reply needed": a Collegepond user can mark a partner message so it
//    no longer holds the reply clock (and can undo it).
//  - The inbox filters mean exactly CHAT_FILTER_DEFINITIONS below; the bell
//    and TAT Management use the same rules.

export const DEFAULT_ACK_PHRASES: string[] = [
  "thanks",
  "thank you",
  "thanks a lot",
  "thank you so much",
  "thx",
  "ty",
  "ok",
  "okay",
  "ok thanks",
  "okay thanks",
  "ok thank you",
  "noted",
  "got it",
  "sure",
  "great",
  "👍",
  "🙏",
  "👌",
  "✅",
];
export const DEFAULT_ACK_MAX_LENGTH = 40;

// Caps for the editable list.
export const ACK_MAX_PHRASES = 40;
export const ACK_MAX_PHRASE_LENGTH = 30;
export const ACK_MAX_LENGTH_LIMIT = 80;

export interface AckRules {
  phrases: string[];
  maxLength: number;
}

// Lower-case, emoji modifiers removed, punctuation turned into spaces,
// whitespace collapsed. Emoji themselves are kept.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u{1F3FB}-\u{1F3FF}︎️‍]/gu, "")
    .replace(/[.,!?;:'"’“”()\-_~*…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Stored as one phrase per line; NULL/empty → the default list.
export function parseAckPhrases(stored: string | null | undefined): string[] {
  if (stored == null || stored.trim() === "") return DEFAULT_ACK_PHRASES;
  return [
    ...new Set(
      stored
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
}

// Is this partner message only an acknowledgement? Text only (a message with
// a file always counts), at most maxLength characters, and nothing left once
// every listed phrase is taken out ("Ok, thanks! 👍" with "ok", "thanks", 👍).
export function isAcknowledgement(body: string | null | undefined, hasAttachments: boolean, rules: AckRules): boolean {
  if (hasAttachments) return false;
  const raw = (body ?? "").trim();
  if (!raw || [...raw].length > rules.maxLength) return false;
  let text = ` ${normalize(raw)} `;
  const phrases = rules.phrases
    .map(normalize)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (phrases.length === 0) return false;
  for (const p of phrases) {
    const word = /^[\p{L}\p{N} ]+$/u.test(p);
    // Words must match whole words ("ok" isn't removed from "okra"); emoji
    // can sit anywhere.
    text = word ? text.split(` ${p} `).join("  ").split(` ${p} `).join("  ") : text.split(p).join(" ");
  }
  return text.trim() === "";
}

export type ChatInboxFilter = "all" | "unread" | "awaiting" | "overdue";

// One set of definitions for the inbox filters, their tooltips, the bell and
// TAT Management.
export const CHAT_FILTER_DEFINITIONS: Record<ChatInboxFilter, { label: string; staff: string; partner: string }> = {
  all: {
    label: "All",
    staff: "Every conversation you take part in, newest first.",
    partner: "Every conversation you take part in, newest first.",
  },
  unread: {
    label: "Unread",
    staff:
      "Conversations with partner messages you personally haven't opened yet. It's per person: a colleague reading the thread doesn't clear yours, and system lines never count.",
    partner:
      "Conversations with Collegepond messages you haven't opened yet. It's per person, and system lines never count.",
  },
  awaiting: {
    label: "Awaiting reply",
    staff:
      "A partner message is waiting for a Collegepond reply, so the reply clock is running. The clock starts at the first unanswered partner message and stops at any Collegepond reply. Short acknowledgements (\"thanks\", \"ok\", 👍) don't start it, and messages marked \"No reply needed\" don't hold it. Read or not doesn't matter.",
    partner: "",
  },
  overdue: {
    label: "Overdue",
    staff:
      "Awaiting reply for longer than the Chat Response target, counted in business hours only (see Settings → TAT Settings). The bell and TAT Management call these breached.",
    partner: "",
  },
};
