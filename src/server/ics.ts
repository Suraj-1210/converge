import "server-only";

// iCalendar (RFC 5545) events for follow-up calendar invites. No OAuth
// calendar sync: the invite travels as an email attachment (Gmail / Outlook
// add it to the counsellor's calendar) or a downloaded .ics file.
//
//   METHOD:REQUEST  an invite, or an update of one: same UID, higher SEQUENCE
//   METHOD:CANCEL   removes the event (same UID, SEQUENCE at least the last one)
//   METHOD:PUBLISH  a plain "add to calendar" download
//
// Events are all-day on the follow-up's date: a date key has no time of day
// and an all-day event needs no time zone. TRANSP:TRANSPARENT keeps it from
// blocking the counsellor's time.

export type IcsMethod = "REQUEST" | "CANCEL" | "PUBLISH";

export interface IcsEvent {
  uid: string;
  sequence: number;
  date: string; // YYYY-MM-DD
  summary: string;
  description: string;
  url?: string;
  organizer: { name: string; email: string };
  attendee?: { name: string; email: string } | null;
}

// TEXT values: backslash, semicolon, comma and newlines are escaped.
function text(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// Parameter values (CN=…) can't hold quotes; quote them when they contain
// separators.
function param(s: string): string {
  const clean = s.replace(/["\r\n]/g, "");
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

// Lines longer than 75 octets are folded (CRLF + space), never inside a
// multi-byte UTF-8 character.
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curLen + n > limit) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const compactDate = (key: string) => key.replace(/-/g, "");
function nextDay(key: string): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildIcs(method: IcsMethod, e: IcsEvent, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Collegepond//Converge follow-ups//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${compactDate(e.date)}`,
    `DTEND;VALUE=DATE:${compactDate(nextDay(e.date))}`,
    `SUMMARY:${text(e.summary)}`,
    `DESCRIPTION:${text(e.description)}`,
    ...(e.url ? [`URL:${e.url}`] : []),
    `ORGANIZER;CN=${param(e.organizer.name)}:mailto:${e.organizer.email}`,
    ...(e.attendee && method !== "PUBLISH"
      ? [
          `ATTENDEE;CN=${param(e.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${e.attendee.email}`,
        ]
      : []),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

// The bare address in "Name <addr@host>" (or the string itself).
export function emailAddress(from: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1]!.trim() || m[2]!.trim(), email: m[2]!.trim() };
  return { name: from.trim(), email: from.trim() };
}
