import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { db } from "~/server/db";
import { AdjustmentDirection, AdjustmentSide, AdjustmentStatus, financialYearLabel } from "~/server/db/enums";
import { payeeOf } from "~/server/payee";
import { appUrl, adjustmentNoteEmail, sendEmail } from "~/server/email";
import { payeeRecipients } from "~/server/email/partners";
import { createNotifications } from "~/server/notify";
import type { Tx } from "~/server/adjustments";

// The Adjustment Note (16 Nov 2026, Suraj chose "PDF + email"): a numbered
// document for every APPROVED partner-side adjustment, ADJ/<FY>/<seq>, emailed
// to the payee when a Super Admin approves it and downloadable from the
// partner's Commission page (/api/adjustment-note/<id>).
//
// It carries ONLY what the partner may see: "Adjustment", the amount, the
// date, the student / commission it relates to, and Finance's partner-facing
// note. Never the reason category, the internal note or the evidence.
//
// No GST on it: whether the partner must raise a GST credit note against their
// earlier tax invoice (and how a fraud recovery is treated) is with the CA.
// The note is rendered on demand from the approved row, which never changes.

// The claim invoices' recipient (partner-commission.ts CP), so the note reads
// as the counterpart to the partner's own invoices.
const CP = {
  name: "Collegepond Counsellors Pvt Ltd",
  address:
    "ML Spaces Unit 204, Opp. Old Jain Mandir, DS Road, Vile Parle West, Mumbai, Maharashtra 400056",
};

const fyShort = (fy: number) => `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;

/** Inside the approval transaction: the next number for the FY, ADJ/2026-27/0001. */
export async function assignNoteNumber(tx: Tx, adjustmentId: number, fy: number): Promise<string> {
  // Lock the FY's numbered rows so two approvals can't take the same number
  // (uq_adjustment_note_seq is the backstop).
  const rows = await tx.$queryRawUnsafe<{ m: number | null }[]>(
    "SELECT MAX(note_seq) AS m FROM adjustment WHERE note_fy = ? FOR UPDATE",
    fy,
  );
  const seq = Number(rows[0]?.m ?? 0) + 1;
  const number = `ADJ/${fyShort(fy)}/${String(seq).padStart(4, "0")}`;
  await tx.adjustment.update({
    where: { id: adjustmentId },
    data: { note_fy: fy, note_seq: seq, note_number: number },
  });
  return number;
}

const NOTE_SELECT = {
  id: true,
  side: true,
  status: true,
  direction: true,
  amount: true,
  currency: true,
  adjustment_date: true,
  decided_at: true,
  partner_note: true,
  note_number: true,
  note_fy: true,
  org_id: true,
  payee_user_id: true,
  organization: { select: { name: true, address: true, city: true, state: true, gst_number: true, pan: true } },
  payee_user: { select: { first_name: true, last_name: true, pan: true, email: true } },
  commission: {
    select: {
      application: {
        select: {
          student: { select: { id: true, first_name: true, last_name: true } },
          course: { select: { name: true, university: { select: { name: true } } } },
        },
      },
    },
  },
  commission_tranche: { select: { seq: true, name: true } },
} as const;

export type NoteRow = NonNullable<Awaited<ReturnType<typeof loadNote>>>;

/** An approved, numbered partner-side adjustment, or null. */
export async function loadNote(adjustmentId: number) {
  const a = await db.adjustment.findUnique({ where: { id: adjustmentId }, select: NOTE_SELECT });
  if (a?.side !== AdjustmentSide.PARTNER || a.status !== AdjustmentStatus.APPROVED || !a.note_number) return null;
  return a;
}

export const noteFileName = (n: { note_number: string | null }) =>
  `Adjustment-Note-${(n.note_number ?? "draft").replace(/[^A-Za-z0-9-]/g, "-")}.pdf`;

const A4 = { w: 595.28, h: 841.89 };
const MX = 56;
const WIDTH = A4.w - MX * 2;
const INK = rgb(0.063, 0.094, 0.157);
const BODY = rgb(0.204, 0.251, 0.329);
const MUTED = rgb(0.4, 0.439, 0.522);
const BRAND = rgb(0.082, 0.439, 0.937);
const RULE = rgb(0.894, 0.906, 0.925);
const IST = "Asia/Kolkata";
const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "long", year: "numeric" });
// The standard fonts are WinAnsi-only, so no ₹ sign.
const money = (n: number, ccy: string) =>
  `${ccy === "INR" ? "INR" : ccy} ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function renderAdjustmentNote(a: NoteRow): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Adjustment Note ${a.note_number}`);
  pdf.setAuthor("Collegepond");
  pdf.setCreationDate(a.decided_at ?? new Date());
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - 64;

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
  const wrap = (text: string, font: PDFFont, size: number, width: number): string[] => {
    const out: string[] = [];
    for (const para of safe(text, font).split(/\r?\n/)) {
      let line = "";
      for (const w of para.split(/\s+/)) {
        const next = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(next, size) > width && line) {
          out.push(line);
          line = w;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  };
  const text = (p: PDFPage, s: string, x: number, size: number, font: PDFFont, color = BODY) =>
    p.drawText(safe(s, font), { x, y, size, font, color });

  // Header
  text(page, "Collegepond", MX, 20, bold, BRAND);
  const title = "ADJUSTMENT NOTE";
  page.drawText(title, { x: A4.w - MX - bold.widthOfTextAtSize(title, 14), y: y + 4, size: 14, font: bold, color: INK });
  y -= 18;
  for (const l of wrap(`${CP.name}, ${CP.address}`, regular, 9, WIDTH * 0.6)) {
    text(page, l, MX, 9, regular, MUTED);
    y -= 12;
  }
  y -= 10;
  page.drawLine({ start: { x: MX, y }, end: { x: A4.w - MX, y }, thickness: 1, color: RULE });
  y -= 24;

  // Meta + party
  const isDeduction = a.direction !== AdjustmentDirection.CREDIT;
  const payee = payeeOf(a);
  const partyName =
    payee.orgId != null
      ? (a.organization?.name ?? "Partner")
      : `${a.payee_user?.first_name ?? ""} ${a.payee_user?.last_name ?? ""}`.trim() || "Partner";
  const partyLines = [
    partyName,
    ...(a.organization
      ? [[a.organization.address, a.organization.city, a.organization.state].filter(Boolean).join(", ")].filter(Boolean)
      : []),
    ...(a.organization?.gst_number ? [`GSTIN: ${a.organization.gst_number}`] : []),
  ];
  const meta: [string, string][] = [
    ["Note number", a.note_number ?? "-"],
    ["Date", fmtDate(a.decided_at ?? a.adjustment_date)],
    ["Financial year", a.note_fy != null ? financialYearLabel(a.note_fy) : "-"],
    ["Type", isDeduction ? "Deduction (recovered from payouts)" : "Credit (added to payouts)"],
  ];
  const top = y;
  text(page, "To", MX, 9, bold, MUTED);
  y -= 14;
  for (const l of partyLines) {
    for (const w of wrap(l, regular, 10, WIDTH * 0.5)) {
      text(page, w, MX, 10, w === partyName ? bold : regular, INK);
      y -= 13;
    }
  }
  const leftEnd = y;
  y = top;
  for (const [k, v] of meta) {
    text(page, k, MX + WIDTH * 0.58, 9, regular, MUTED);
    text(page, v, MX + WIDTH * 0.58 + 80, 9, bold, INK);
    y -= 14;
  }
  y = Math.min(leftEnd, y) - 20;

  // The line
  page.drawRectangle({ x: MX, y: y - 6, width: WIDTH, height: 22, color: rgb(0.976, 0.98, 0.984) });
  text(page, "Description", MX + 8, 9, bold, MUTED);
  const amtHead = "Amount";
  page.drawText(amtHead, { x: A4.w - MX - 8 - bold.widthOfTextAtSize(amtHead, 9), y, size: 9, font: bold, color: MUTED });
  y -= 28;
  const app = a.commission?.application;
  const desc = [
    "Adjustment",
    app
      ? `${app.student.first_name} ${app.student.last_name} (CP-${String(app.student.id).padStart(5, "0")}), ${app.course.university.name}${a.commission_tranche ? `, ${a.commission_tranche.name ?? `Instalment ${a.commission_tranche.seq}`}` : ""}`
      : null,
  ].filter((x): x is string => !!x);
  const amount = Number(a.amount);
  const amtText = `${isDeduction ? "- " : "+ "}${money(amount, a.currency)}`;
  page.drawText(amtText, { x: A4.w - MX - 8 - bold.widthOfTextAtSize(amtText, 11), y, size: 11, font: bold, color: INK });
  for (const [i, d] of desc.entries()) {
    for (const w of wrap(d, i === 0 ? bold : regular, i === 0 ? 11 : 9, WIDTH * 0.62)) {
      text(page, w, MX + 8, i === 0 ? 11 : 9, i === 0 ? bold : regular, i === 0 ? INK : BODY);
      y -= i === 0 ? 15 : 12;
    }
  }
  y -= 6;
  page.drawLine({ start: { x: MX, y }, end: { x: A4.w - MX, y }, thickness: 1, color: RULE });
  y -= 18;
  const totalLabel = isDeduction ? "Total to be deducted from your payouts" : "Total to be added to your next payout";
  text(page, totalLabel, MX + 8, 10, bold, INK);
  const totalText = money(amount, a.currency);
  page.drawText(totalText, { x: A4.w - MX - 8 - bold.widthOfTextAtSize(totalText, 12), y, size: 12, font: bold, color: INK });
  y -= 30;

  if (a.partner_note) {
    text(page, "Note from Collegepond Finance", MX, 9, bold, MUTED);
    y -= 14;
    for (const w of wrap(a.partner_note, regular, 10, WIDTH)) {
      text(page, w, MX, 10, regular, BODY);
      y -= 13;
    }
    y -= 12;
  }
  const how = isDeduction
    ? "This amount is recovered from your next commission payout. If that payout is smaller, the remaining balance is carried forward and recovered from the following payouts. Please keep raising your commission invoices as usual; the adjustment is applied when Collegepond pays."
    : "This amount is added to your next commission payout.";
  for (const w of wrap(how, regular, 9, WIDTH)) {
    text(page, w, MX, 9, regular, MUTED);
    y -= 12;
  }

  // Footer
  y = 56;
  text(page, `Questions? Reply to the email this note came with, or contact support@collegepond.com.`, MX, 8, regular, MUTED);
  y -= 11;
  text(page, `${a.note_number} - generated by the Collegepond Partner Portal`, MX, 8, regular, MUTED);
  return pdf.save();
}

/**
 * After approval (fire-and-forget, already saved): an in-app notification and
 * the email with the note attached, to the payee's recipients.
 */
export function sendAdjustmentNote(adjustmentId: number): Promise<void> {
  return (async () => {
    const a = await loadNote(adjustmentId);
    if (!a) return;
    const payee = payeeOf(a);
    const rs = await payeeRecipients({ orgId: payee.orgId, userId: payee.userId });
    const isCredit = a.direction === AdjustmentDirection.CREDIT;
    await createNotifications(
      rs.map((r) => r.id),
      {
        type: "commission.adjustment",
        title: `Adjustment Note ${a.note_number}`,
        body: `${isCredit ? "Credit" : "Deduction"} of ₹${Number(a.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}${a.partner_note ? `: ${a.partner_note.slice(0, 120)}` : ""}`,
        link: "/partner/commission",
        tone: isCredit ? "green" : "orange",
      },
    );
    const pdf = Buffer.from(await renderAdjustmentNote(a));
    // Account-critical: sent to every active recipient, whatever their
    // notification preferences.
    let sent = 0;
    for (const r of rs) {
      try {
        await sendEmail(
          r.email,
          adjustmentNoteEmail(
            r,
            { noteNumber: a.note_number!, kind: isCredit ? "credit" : "deduction", amountInr: Number(a.amount), note: a.partner_note },
            appUrl(),
          ),
          { attachments: [{ fileName: noteFileName(a), contentType: "application/pdf", data: pdf }] },
        );
        sent++;
      } catch (e) {
        console.error("[email] adjustment-note failed:", e instanceof Error ? e.message : e);
      }
    }
    if (rs.length === 0) console.log("[email] adjustment-note: no active partner recipients");
    console.log(`[email] adjustment-note ${a.note_number}: sent ${sent}`);
  })().catch((e) => console.error("[notify] adjustment-note failed:", e));
}
