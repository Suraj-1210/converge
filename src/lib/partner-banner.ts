// A partner dashboard slide as the client renders it (built server-side in
// src/server/partner-banners.ts). Shared by the dashboard carousel and the
// admin preview.

export type BannerSlide =
  | {
      id: number;
      kind: "event";
      title: string;
      summary: string | null;
      imageUrl: string | null; // wide 1600×400 graphic; null → built from the event
      event: {
        id: number;
        eventType: number;
        date: string; // "Mon, 12 Jan 2027"
        time: string | null; // "10:00 AM – 12:00 PM IST"
        place: string | null; // "Online" or the venue
        organizer: string | null;
        posterUrl: string | null; // image poster only (a PDF has no thumbnail)
        registrationUrl: string | null;
      };
    }
  | {
      id: number;
      kind: "info";
      title: string;
      summary: string | null;
      imageUrl: string | null;
      details: string | null;
      linkUrl: string | null;
      linkLabel: string | null;
    };

export const BANNER_IMAGE_HINT = "Wide image, 1600 × 400 px (4:1), JPG or PNG";

// Rich-ish text for information pop-ups: blank lines split paragraphs, lines
// starting "- ", "* " or "• " are bullets. Plain text in, blocks out — never
// HTML, so nothing an admin types can inject markup.
export type TextBlock = { p: string } | { list: string[] };

export function parseRichText(src: string | null | undefined): TextBlock[] {
  if (!src) return [];
  const blocks: TextBlock[] = [];
  for (const chunk of src.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let para: string[] = [];
    let list: string[] = [];
    const flushPara = () => {
      if (para.length) blocks.push({ p: para.join(" ") });
      para = [];
    };
    const flushList = () => {
      if (list.length) blocks.push({ list });
      list = [];
    };
    for (const l of lines) {
      const m = /^(?:[-*•])\s+(.*)$/.exec(l);
      if (m) {
        flushPara();
        list.push(m[1]!);
      } else {
        flushList();
        para.push(l);
      }
    }
    flushPara();
    flushList();
  }
  return blocks;
}

// Only http(s) links are followed from admin-entered URLs.
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}
