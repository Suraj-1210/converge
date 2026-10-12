import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  MOU_COLLEGEPOND_ENTITY,
  MOU_SECTIONS,
  MouSignatureKind,
  type MouInline,
} from "~/lib/constants/mou";

// Renders the executed partner MOU (the agreed text plus the partner's details
// and signature) as an A4 PDF. signMou renders it once and stores that frozen
// copy; /api/mou serves it (or renders one for MOUs signed before copies were
// kept).

// The user fields an executed MOU is built from.
export const MOU_USER_SELECT = {
  first_name: true,
  last_name: true,
  email: true,
  phone: true,
  address: true,
  city: true,
  state: true,
  country: true,
  org_id: true,
  mou_signed_at: true,
  mou_signature: true,
  mou_signature_kind: true,
  mou_signer_name: true,
  mou_signed_ip: true,
  mou_version: true,
  mou_pdf_url: true,
  organization: { select: { name: true, address: true, city: true, state: true, country: true } },
} as const;

interface MouUserRow {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  country: string;
  mou_signature: string | null;
  mou_signature_kind: number | null;
  mou_signer_name: string | null;
  mou_signed_ip: string | null;
  mou_version: string | null;
  organization: { name: string; address: string | null; city: string | null; state: string | null; country: string | null } | null;
}

export function executedMouFor(row: MouUserRow, signedAt: Date): ExecutedMou {
  const org = row.organization;
  const place = org?.address ? org : row;
  const address = [place.address, place.city, place.state, countryName(place.country)]
    .filter(Boolean)
    .join(", ");
  return {
    partnerName: `${row.first_name} ${row.last_name}`.trim(),
    businessName: org?.name ?? null,
    email: row.email,
    phone: row.phone,
    address,
    signedAt,
    signerName: row.mou_signer_name,
    signature: row.mou_signature,
    signatureKind: row.mou_signature_kind,
    signedIp: row.mou_signed_ip,
    version: row.mou_version,
  };
}

export function mouFileName(mou: ExecutedMou): string {
  const who = (mou.businessName ?? mou.partnerName).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `Collegepond-MOU-${who || "Partner"}.pdf`;
}

function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export interface ExecutedMou {
  partnerName: string;
  businessName: string | null;
  email: string;
  phone: string;
  address: string;
  signedAt: Date;
  signerName: string | null;
  signature: string | null;
  signatureKind: number | null;
  signedIp: string | null;
  version: string | null;
}

const A4 = { w: 595.28, h: 841.89 };
const M = { x: 56, top: 64, bottom: 64 };
const WIDTH = A4.w - M.x * 2;
const INK = rgb(0.063, 0.094, 0.157); // #101828
const BODY = rgb(0.204, 0.251, 0.329); // #344054
const MUTED = rgb(0.4, 0.439, 0.522); // #667085
const BRAND = rgb(0.082, 0.439, 0.937); // #1570EF
const RULE = rgb(0.894, 0.906, 0.925); // #E4E7EC

const IST = "Asia/Kolkata";
const fmtDateTime = (d: Date) =>
  `${d.toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })} IST`;
const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "long", year: "numeric" });

interface Run {
  text: string;
  font: PDFFont;
}

export async function renderExecutedMou(mou: ExecutedMou): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Collegepond Partner MOU - ${mou.businessName ?? mou.partnerName}`);
  pdf.setAuthor("Collegepond");
  pdf.setSubject("Memorandum of Understanding (executed copy)");
  pdf.setCreationDate(new Date());

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const script = await pdf.embedFont(StandardFonts.TimesRomanBoldItalic);

  // The standard fonts only cover Latin-1 (WinAnsi); swap anything else so a
  // name in another script degrades to "?" instead of failing the download.
  const safe = (s: string, font: PDFFont) =>
    [...s.normalize("NFC")]
      .map((ch) => {
        try {
          font.encodeText(ch);
          return ch;
        } catch {
          return "?";
        }
      })
      .join("");

  let page: PDFPage = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - M.top;

  const ensure = (h: number) => {
    if (y - h < M.bottom) {
      page = pdf.addPage([A4.w, A4.h]);
      y = A4.h - M.top;
    }
  };

  // Word-wraps runs of mixed fonts into lines no wider than `width`.
  function layout(runs: Run[], size: number, width: number) {
    const words: Run[] = [];
    for (const r of runs) {
      for (const w of safe(r.text, r.font).split(/\s+/).filter(Boolean)) words.push({ text: w, font: r.font });
    }
    const space = regular.widthOfTextAtSize(" ", size);
    const lines: Run[][] = [];
    let line: Run[] = [];
    let lineW = 0;
    for (const w of words) {
      const ww = w.font.widthOfTextAtSize(w.text, size);
      if (line.length && lineW + space + ww > width) {
        lines.push(line);
        line = [];
        lineW = 0;
      }
      lineW += (line.length ? space : 0) + ww;
      line.push(w);
    }
    if (line.length) lines.push(line);
    return lines;
  }

  function paragraph(
    runs: Run[],
    opts: { size?: number; color?: ReturnType<typeof rgb>; indent?: number; gap?: number; bullet?: boolean } = {},
  ) {
    const size = opts.size ?? 10;
    const lead = size * 1.45;
    const x0 = M.x + (opts.indent ?? 0);
    for (const [i, line] of layout(runs, size, WIDTH - (opts.indent ?? 0)).entries()) {
      ensure(lead);
      if (opts.bullet && i === 0) {
        page.drawText("•", { x: M.x + 4, y: y - size, size, font: regular, color: opts.color ?? BODY });
      }
      let x = x0;
      for (const w of line) {
        page.drawText(w.text, { x, y: y - size, size, font: w.font, color: opts.color ?? BODY });
        x += w.font.widthOfTextAtSize(w.text, size) + regular.widthOfTextAtSize(" ", size);
      }
      y -= lead;
    }
    y -= opts.gap ?? 6;
  }

  const text = (s: string, font: PDFFont, size: number, color = INK, x = M.x) => {
    page.drawText(safe(s, font), { x, y: y - size, size, font, color });
  };
  const rule = () => {
    page.drawLine({ start: { x: M.x, y }, end: { x: A4.w - M.x, y }, thickness: 0.75, color: RULE });
  };

  // ---- Heading ----
  text("Collegepond", bold, 20, BRAND);
  y -= 30;
  text("Memorandum of Understanding", bold, 16);
  y -= 22;
  text("Partner Agreement - executed copy", regular, 10, MUTED);
  y -= 22;
  rule();
  y -= 16;

  // ---- Parties ----
  text("BETWEEN", bold, 8, MUTED);
  y -= 14;
  paragraph([{ text: MOU_COLLEGEPOND_ENTITY, font: bold }, { text: '("Collegepond")', font: regular }], { gap: 8 });
  text("AND", bold, 8, MUTED);
  y -= 14;
  const partnerLabel = mou.businessName
    ? `${mou.businessName}, represented by ${mou.partnerName}`
    : mou.partnerName;
  paragraph([{ text: partnerLabel, font: bold }, { text: '("Partner")', font: regular }], { gap: 2 });
  for (const line of [mou.address, `${mou.email}  |  ${mou.phone}`].filter(Boolean)) {
    paragraph([{ text: line, font: regular }], { size: 9, color: MUTED, gap: 0 });
  }
  y -= 14;
  rule();
  y -= 18;

  // ---- Terms ----
  MOU_SECTIONS.forEach((s, i) => {
    ensure(40);
    paragraph([{ text: `${i + 1}. ${s.title}`, font: bold }], { size: 11.5, color: INK, gap: 4 });
    for (const b of s.blocks) {
      if (b.kind === "p") {
        paragraph([{ text: b.text, font: regular }]);
      } else {
        for (const item of b.items) {
          const runs: Run[] = typeof item === "string" ? [{ text: item, font: regular }] : inlineRuns(item);
          paragraph(runs, { indent: 14, gap: 2, bullet: true });
        }
        y -= 4;
      }
    }
    y -= 8;
  });

  function inlineRuns(item: Exclude<MouInline, string>): Run[] {
    return [{ text: item.bold, font: bold }, { text: item.text, font: regular }];
  }

  // ---- Execution ----
  ensure(210);
  y -= 6;
  rule();
  y -= 18;
  text("EXECUTION", bold, 8, MUTED);
  y -= 16;
  paragraph(
    [
      {
        text: `This MOU was accepted and signed digitally by the Partner through the Collegepond Partner Portal on ${fmtDate(mou.signedAt)}, and took effect from that date.`,
        font: regular,
      },
    ],
    { gap: 12 },
  );

  // Signature box
  const boxH = 74;
  const boxW = 240;
  page.drawRectangle({ x: M.x, y: y - boxH, width: boxW, height: boxH, borderColor: RULE, borderWidth: 1, color: rgb(0.98, 0.984, 0.988) });
  if (mou.signature && mou.signatureKind === MouSignatureKind.DRAWN) {
    try {
      const png = await pdf.embedPng(mou.signature);
      const scale = Math.min((boxW - 20) / png.width, (boxH - 12) / png.height, 1);
      const w = png.width * scale;
      const h = png.height * scale;
      page.drawImage(png, { x: M.x + (boxW - w) / 2, y: y - boxH + (boxH - h) / 2, width: w, height: h });
    } catch {
      page.drawText("[signature image unavailable]", { x: M.x + 12, y: y - boxH / 2 - 4, size: 9, font: regular, color: MUTED });
    }
  } else if (mou.signature) {
    const sig = safe(mou.signature, script);
    let size = 24;
    while (size > 10 && script.widthOfTextAtSize(sig, size) > boxW - 20) size -= 1;
    page.drawText(sig, { x: M.x + 12, y: y - boxH / 2 - size / 3, size, font: script, color: BRAND });
  } else {
    page.drawText("Signed electronically", { x: M.x + 12, y: y - boxH / 2 + 4, size: 10, font: bold, color: BODY });
    page.drawText("(signature image not retained for MOUs signed", { x: M.x + 12, y: y - boxH / 2 - 10, size: 7.5, font: regular, color: MUTED });
    page.drawText("before 12 Oct 2026)", { x: M.x + 12, y: y - boxH / 2 - 20, size: 7.5, font: regular, color: MUTED });
  }

  // Signer details to the right of the box
  const dx = M.x + boxW + 20;
  const details: [string, string][] = [
    ["Signed by", mou.signerName ?? mou.partnerName],
    ["On behalf of", mou.businessName ?? "Self (independent partner)"],
    ["Date & time", fmtDateTime(mou.signedAt)],
    ["Method", mou.signatureKind === MouSignatureKind.TYPED ? "Typed signature" : mou.signatureKind === MouSignatureKind.DRAWN ? "Drawn signature" : "Electronic acceptance"],
    ...(mou.signedIp ? ([["IP address", mou.signedIp]] as [string, string][]) : []),
  ];
  let dy = y;
  for (const [k, v] of details) {
    page.drawText(k.toUpperCase(), { x: dx, y: dy - 7, size: 6.5, font: bold, color: MUTED });
    page.drawText(safe(v, regular), { x: dx, y: dy - 18, size: 9, font: regular, color: INK });
    dy -= 22;
  }
  page.drawText("Partner signature", { x: M.x, y: y - boxH - 14, size: 8, font: regular, color: MUTED });
  y = Math.min(y - boxH - 14, dy) - 20;

  // ---- Footer on every page ----
  const pages = pdf.getPages();
  const footer = safe(
    `Collegepond Partner MOU${mou.version ? ` v${mou.version}` : ""} - ${mou.businessName ?? mou.partnerName}`,
    regular,
  );
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M.x, y: 44 }, end: { x: A4.w - M.x, y: 44 }, thickness: 0.5, color: RULE });
    p.drawText(footer, { x: M.x, y: 30, size: 7.5, font: regular, color: MUTED });
    const pg = `Page ${i + 1} of ${pages.length}`;
    p.drawText(pg, { x: A4.w - M.x - regular.widthOfTextAtSize(pg, 7.5), y: 30, size: 7.5, font: regular, color: MUTED });
  });

  return pdf.save();
}
