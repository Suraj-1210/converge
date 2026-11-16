"use client";

// Exports of a report tab: XLSX laid out like the reference workbook (title,
// subtitle, section headings, KPI rows, tables with a TOTAL row), CSV, and
// a PDF drawn with pdf-lib. Every tab is first turned into a ReportDoc, so
// the three formats carry the same figures as the screen.

import type * as XlsxLib from "xlsx";
import { countryName, formatDate, stageLabel } from "~/components/dashboard/format";
import { StudentStatusLabel } from "~/server/db/enums";
import {
  FUNNEL_STEPS,
  METRICS,
  NONE,
  SUMMARY_METRICS,
  UniStatusOptions,
  periodLabel,
  type ReportFilters,
  type ReportTab,
} from "~/lib/reports";
import {
  counsellorRows,
  countryRows,
  intakeRows,
  partnerRows,
  rmLeadRows,
  rmRows,
  universityRows,
  vendorRows,
  weeklyShortlistRows,
  type DrillRows,
  type Report,
  type Weekly,
} from "./derive";

type Cell = string | number;

export type Block =
  | { kind: "kpis"; items: { label: string; value: number }[] }
  | { kind: "table"; heading?: string; head: string[]; rows: Cell[][]; total?: Cell[] }
  | { kind: "note"; text: string };

export interface ReportDoc {
  sheet: string;
  title: string;
  subtitle: string;
  blocks: Block[];
}

// Names for the filter ids, for subtitles and drill-down headers.
export interface FilterNames {
  partners: Map<string, string>;
  rms: Map<string, string>;
  counsellors: Map<string, string>;
  universities: Map<string, string>;
}

export const fileStamp = () => new Date().toISOString().slice(0, 10);

// "Intake: Fall 2027 · Partner: EduBridge" (or "All partners, …").
export function filterSummary(f: ReportFilters, n: FilterNames, short = false): string {
  const parts: string[] = [];
  const unassigned = (v: string | undefined, m: Map<string, string>) => (v === NONE ? "Unassigned" : (m.get(v ?? "") ?? v));
  if (f.intake) parts.push(`Intake: ${f.intake === NONE ? "Not set" : f.intake}`);
  if (f.country) parts.push(`Country: ${countryName(f.country)}`);
  if (f.partner) parts.push(`Partner: ${f.partner === NONE ? "None" : (n.partners.get(f.partner) ?? f.partner)}`);
  if (f.rm) parts.push(`RM: ${unassigned(f.rm, n.rms)}`);
  if (f.counsellor) parts.push(`Counsellor: ${unassigned(f.counsellor, n.counsellors)}`);
  if (f.university) parts.push(`University: ${n.universities.get(f.university) ?? f.university}`);
  if (f.vendor) parts.push(`Vendor: ${f.vendor}`);
  if (f.status) parts.push(`Status: ${UniStatusOptions.find((s) => String(s.value) === f.status)?.label ?? f.status}`);
  if (parts.length === 0) return short ? "No filters" : "All intakes, countries, partners, RMs, counsellors, universities and vendors";
  return parts.join(" · ");
}

const d = (v: string | null) => (v ? formatDate(v) : "");

// Drill-down rows as a table (drill-down CSV, Deposit / Visa student detail).
export function drillTable(kind: string, rows: DrillRows): { head: string[]; rows: Cell[][] } {
  const app = kind === "app" || kind === "student";
  const head = [
    "Student",
    "Student ID",
    ...(app ? ["Application ID"] : []),
    "Partner",
    ...(kind === "lead" ? [] : ["University", "Course"]),
    "Intake",
    "Country",
    kind === "shortlist" ? "Shortlisted by" : "Counsellor",
    "RM",
    ...(app ? ["Vendor"] : []),
    "Lead date",
    ...(app ? ["Submitted"] : []),
    ...(kind === "shortlist" ? ["Shortlisted"] : []),
    app ? "Stage" : "Student status",
    ...(app ? ["Stage since"] : []),
    "Latest remark",
  ];
  const body = rows.map((r) => [
    r.studentName,
    `CP-${r.studentId}`,
    ...(app ? [r.appId ?? ""] : []),
    r.partner ?? "",
    ...(kind === "lead" ? [] : [r.university ?? "", r.course ?? ""]),
    r.intake ?? "",
    r.country ? countryName(r.country) : "",
    r.counsellor ?? "Not assigned",
    r.rm ?? "",
    ...(app ? [r.vendor ?? ""] : []),
    d(r.leadAt),
    ...(app ? [d(r.submittedAt)] : []),
    ...(kind === "shortlist" ? [d(r.stageAt)] : []),
    app ? stageLabel(r.status) : ((StudentStatusLabel as Record<number, string | undefined>)[r.status] ?? ""),
    ...(app ? [d(r.stageAt)] : []),
    r.remark ?? "",
  ]);
  return { head, rows: body };
}

// ---------------------------------------------------------------------------
// Tab → ReportDoc
// ---------------------------------------------------------------------------
const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);

export function buildDoc(
  tab: ReportTab,
  ctx: {
    report?: Report;
    weekly?: Weekly;
    depositRows?: DrillRows;
    visaRows?: DrillRows;
    filters: ReportFilters;
    names: FilterNames;
  },
): ReportDoc | null {
  const { report: r, weekly: w, filters, names } = ctx;
  const gen = `Generated ${formatDate(new Date())} ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
  const sub = (period: string, extra?: string) =>
    [extra, period, filterSummary(filters, names), gen].filter(Boolean).join("  |  ");
  const period = periodLabel(filters.from, filters.to);
  const outcomes = (rows: { active: number; activeUnique: number; conditional: number; unconditional: number; depositPaid: number; visaApproved: number; visaRejected: number; name: string }[], rank = true) =>
    rows.map((x, i) => [
      ...(rank ? [i + 1] : []),
      x.name,
      x.active,
      x.activeUnique,
      x.conditional,
      x.unconditional,
      x.depositPaid,
      x.visaApproved,
      x.visaRejected,
    ]);
  const outcomeHead = ["Active Applications", "Active Unique Applicants", "Conditional Offer", "Unconditional Offer", "Deposit Paid", "Visa Approved", "Visa Rejected"];
  const outcomeTotal = (rows: { active: number; conditional: number; unconditional: number; depositPaid: number; visaApproved: number; visaRejected: number }[], unique: number, rank = true): Cell[] => [
    ...(rank ? [""] : []),
    "TOTAL",
    sum(rows, (x) => x.active),
    unique,
    sum(rows, (x) => x.conditional),
    sum(rows, (x) => x.unconditional),
    sum(rows, (x) => x.depositPaid),
    sum(rows, (x) => x.visaApproved),
    sum(rows, (x) => x.visaRejected),
  ];

  if (tab === "weekly") {
    if (!w) return null;
    const c = w.current.totals;
    const p = w.previous.totals;
    const wk = `${formatDate(w.from)} to ${formatDate(w.to)}`;
    const line = (label: string, cur: number, prev: number, basis: string): Cell[] => [label, cur, prev, cur - prev, basis];
    const rmRowsW = rmLeadRows(w);
    const sl = weeklyShortlistRows(w);
    return {
      sheet: "Weekly",
      title: `WEEKLY REPORT  ·  ${wk}`,
      subtitle: [
        "All params by Application Submitted Date  |  Leads by Lead Submitted Date",
        `Compared with ${formatDate(w.prevFrom)} to ${formatDate(w.prevTo)}`,
        filterSummary({ ...filters, from: undefined, to: undefined }, names),
        gen,
      ].join("  |  "),
      blocks: [
        {
          kind: "kpis",
          items: [
            { label: "Leads Received (Lead Sub Date)", value: w.current.leads },
            { label: "Total Active Applications", value: c.active },
            { label: "Active Unique Applicants", value: c.activeUnique },
            { label: "App Submitted", value: c.submitted },
            { label: "Conditional Offer", value: c.conditional },
            { label: "Unconditional Offer", value: c.unconditional },
            { label: "Deposit Paid", value: c.depositPaid },
            { label: "Visa Approved", value: c.visaApproved },
            { label: "Visa Rejected", value: c.visaRejected },
          ],
        },
        {
          kind: "table",
          heading: "WEEKLY METRIC DETAIL",
          head: ["Metric", "Count", "Previous period", "Change", "Date Basis"],
          rows: [
            line("Leads Received", w.current.leads, w.previous.leads, "Lead Submitted Date (unique students)"),
            line("Total Applications Submitted", c.total, p.total, "Application Submitted Date"),
            line("Total Active Applications", c.active, p.active, "Application Submitted Date"),
            line("Active Unique Applicants", c.activeUnique, p.activeUnique, "Application Submitted Date"),
            line("Applications Submitted", c.submitted, p.submitted, "Application Submitted Date"),
            line("Conditional Offer Received", c.conditional, p.conditional, "Application Submitted Date"),
            line("Unconditional Offer Received", c.unconditional, p.unconditional, "Application Submitted Date"),
            line("Deposit Paid", c.depositPaid, p.depositPaid, "Application Submitted Date"),
            line("Case Closed", c.caseClosed, p.caseClosed, "Application Submitted Date"),
            line("Rejected by University", c.rejected, p.rejected, "Application Submitted Date"),
            line("Visa Rejected", c.visaRejected, p.visaRejected, "Application Submitted Date"),
            line("Visa Approved", c.visaApproved, p.visaApproved, "Application Submitted Date"),
            line("Students Shortlisted (counsellors)", w.current.shortlisted, w.previous.shortlisted, "Shortlist date"),
          ],
        },
        {
          kind: "table",
          heading: "RM WISE LEADS (this period)",
          head: ["Relationship Manager", "Leads (Lead Sub Date)", "Previous period"],
          rows: rmRowsW.map((x) => [x.name, x.leads, x.prev]),
          total: ["TOTAL", sum(rmRowsW, (x) => x.leads), sum(rmRowsW, (x) => x.prev)],
        },
        {
          kind: "table",
          heading: "COUNSELLOR SHORTLISTING (this period)",
          head: ["Counsellor", "Students Shortlisted", "Partner proposals approved"],
          rows: sl.map((x) => [x.name, x.shortlisted, x.partnerApproved]),
          total: ["TOTAL (distinct students)", w.shortlists.proposed.total, w.shortlists.approved.total],
        },
      ],
    };
  }

  if (!r) return null;
  const t = r.totals;

  switch (tab) {
    case "overview": {
      const vr = vendorRows(r);
      return {
        sheet: "Overview",
        title: "CONVERGE  ·  B2B APPLICATION REPORT",
        subtitle: sub(period, "Overview Summary"),
        blocks: [
          {
            kind: "kpis",
            items: [
              { label: "Total Applications", value: t.total },
              { label: "Total Active Applications", value: t.active },
              { label: "Active Unique Applicants", value: t.activeUnique },
              { label: "Leads Received", value: r.leads },
            ],
          },
          {
            kind: "kpis",
            items: [
              { label: "Deposit Paid", value: t.depositPaid },
              { label: "Visa Approved", value: t.visaApproved },
              { label: "Visa Rejected", value: t.visaRejected },
              { label: "Defer Count (to next intake)", value: t.deferred },
              { label: "Visa Filed", value: t.visaFiled },
            ],
          },
          {
            kind: "table",
            heading: "FULL METRIC SUMMARY",
            head: ["Metric", "Count"],
            rows: SUMMARY_METRICS.map((k) => [METRICS[k].label, t[k as keyof typeof t]]),
          },
          {
            kind: "table",
            heading: "STAGE FUNNEL (applications that reached each stage)",
            head: ["Stage", "Applications"],
            rows: FUNNEL_STEPS.map((s) => [s.label, r.funnel[s.key]]),
          },
          {
            kind: "table",
            heading: "PROCESSING VENDOR",
            head: ["Vendor", "Applications", "Active", "Offers", "Deposit Paid", "Visa Approved"],
            rows: vr.map((x) => [x.name, x.total, x.active, x.conditional + x.unconditional, x.depositPaid, x.visaApproved]),
            total: [
              "TOTAL",
              t.total,
              t.active,
              t.conditional + t.unconditional,
              t.depositPaid,
              t.visaApproved,
            ],
          },
          {
            kind: "note",
            text: `Vendor source: ${r.vendorSources.contract} from the commission contract, ${r.vendorSources.text} from the counsellor's typed vendor, ${r.vendorSources.none} not set. 'Active' = Application Submitted or later (up to Visa Approved / Enrolled), student not marked Inactive. 'Active Unique Applicants' counts each active student once.`,
          },
        ],
      };
    }
    case "rm": {
      const rows = rmRows(r);
      return {
        sheet: "RM Wise",
        title: "RELATIONSHIP MANAGER WISE",
        subtitle: sub(period, "Overall · Active · Unique · Deposit · Visa"),
        blocks: [
          {
            kind: "table",
            heading: "RM PERFORMANCE SUMMARY",
            head: ["Relationship Manager", "Overall Applications", "Active Applications", "Active Unique Applicants", "Deposit Paid", "Visa Approved", "Visa Rejected"],
            rows: rows.map((x) => [x.name, x.total, x.active, x.activeUnique, x.depositPaid, x.visaApproved, x.visaRejected]),
            total: ["TOTAL", t.total, t.active, t.activeUnique, t.depositPaid, t.visaApproved, t.visaRejected],
          },
        ],
      };
    }
    case "counsellor": {
      const rows = counsellorRows(r);
      return {
        sheet: "Counsellor Wise",
        title: "COUNSELLOR WISE  —  DEPOSIT, VISA & SHORTLISTING",
        subtitle: sub(period),
        blocks: [
          {
            kind: "kpis",
            items: [
              { label: "Total Deposit Paid", value: t.depositPaid },
              { label: "Visa Approved", value: t.visaApproved },
              { label: "Students Shortlisted", value: r.shortlists.proposed.total },
            ],
          },
          {
            kind: "table",
            heading: "COUNSELLOR DEPOSIT / VISA / SHORTLISTING BREAKDOWN",
            head: ["Rank", "Counsellor", "Students Shortlisted", "Partner proposals approved", "Active Applications", "Deposit Paid", "Visa Approved"],
            rows: rows.map((x, i) => [i + 1, x.name, x.shortlisted, x.partnerApproved, x.active, x.depositPaid, x.visaApproved]),
            total: ["", "TOTAL", r.shortlists.proposed.total, r.shortlists.approved.total, t.active, t.depositPaid, t.visaApproved],
          },
        ],
      };
    }
    case "partner": {
      const rows = partnerRows(r);
      return {
        sheet: "Partner Wise",
        title: "PARTNER WISE  —  SORTED BY DEPOSIT PAID (Descending)",
        subtitle: sub(period, "Sorted by Deposit Paid, then Active Applications"),
        blocks: [
          { kind: "table", heading: "ALL PARTNERS — FULL LIST", head: ["Rank", "Partner Name", ...outcomeHead], rows: outcomes(rows), total: outcomeTotal(rows, t.activeUnique) },
        ],
      };
    }
    case "country": {
      const rows = countryRows(r);
      return {
        sheet: "Country Wise",
        title: "COUNTRY WISE  —  ACTIVE APPLICATIONS (Descending)",
        subtitle: sub(period, "Sorted by Active Applications"),
        blocks: [{ kind: "table", heading: "ALL COUNTRIES", head: ["Rank", "Country", ...outcomeHead], rows: outcomes(rows), total: outcomeTotal(rows, t.activeUnique) }],
      };
    }
    case "university": {
      const rows = universityRows(r);
      return {
        sheet: "University Wise",
        title: "UNIVERSITY WISE  —  SORTED BY DEPOSIT PAID (Descending)",
        subtitle: sub(period, "Only universities with ≥1 Offer, Deposit or Visa"),
        blocks: [
          {
            kind: "table",
            heading: "UNIVERSITIES WITH OFFERS / DEPOSITS",
            head: ["Rank", "University Name", "Active", ...outcomeHead.slice(1)],
            rows: outcomes(rows),
            total: outcomeTotal(rows, sum(rows, (x) => x.activeUnique)),
          },
        ],
      };
    }
    case "intake": {
      const rows = intakeRows(r);
      return {
        sheet: "Intake Wise",
        title: "INTAKE WISE",
        subtitle: sub(period, "Stored intake: deferred intake, else the course's, else the student's"),
        blocks: [
          {
            kind: "table",
            heading: "BY INTAKE",
            head: ["Intake", "Total Applications", ...outcomeHead],
            rows: rows.map((x) => [x.name, x.total, ...outcomes([x], false)[0]!.slice(1)]),
            total: ["TOTAL", t.total, ...outcomeTotal(rows, t.activeUnique, false).slice(1)],
          },
        ],
      };
    }
    case "deposit": {
      const list = ctx.depositRows ?? [];
      return {
        sheet: "Deposit Wise",
        title: "DEPOSIT PAID  —  STUDENT DETAIL",
        subtitle: sub(period, "University · Partner · Intake · Country · Counsellor · RM"),
        blocks: [
          {
            kind: "kpis",
            items: [
              { label: "Deposit Paid", value: t.depositPaid },
              { label: "In process (visa not filed)", value: t.depositInProcess },
              { label: "Visa Filed", value: t.visaFiled },
            ],
          },
          {
            kind: "table",
            heading: `Deposit Paid — ${list.length} students in process (visa not yet filed)`,
            head: ["Sr. No.", "Student Name", "University", "Partner", "Intended Intake", "Country", "Counsellor", "RM", "Vendor", "Comments"],
            rows: list.map((x, i) => [
              i + 1,
              x.studentName,
              x.university ?? "",
              x.partner ?? "",
              x.intake ?? "",
              x.country ? countryName(x.country) : "",
              x.counsellor ?? "Not assigned",
              x.rm ?? "",
              x.vendor ?? "",
              x.remark ?? "",
            ]),
          },
        ],
      };
    }
    case "visa": {
      const list = ctx.visaRows ?? [];
      const crow = counsellorRows(r).filter((x) => x.visaApproved + x.visaRejected > 0);
      return {
        sheet: "Visa Wise",
        title: "VISA REPORT  —  APPROVED & REJECTED",
        subtitle: sub(period, "Visa Decisions · Counsellor Breakdown · Student Detail"),
        blocks: [
          {
            kind: "kpis",
            items: [
              { label: "Visa Approved", value: t.visaApproved },
              { label: "Visa Rejected", value: t.visaRejected },
              { label: "Total Visa Decisions", value: t.visaApproved + t.visaRejected },
              { label: "Visa Filed", value: t.visaFiled },
            ],
          },
          {
            kind: "table",
            heading: "COUNSELLOR WISE — VISA BREAKDOWN",
            head: ["Counsellor", "Visa Approved", "Visa Rejected", "Total Decisions"],
            rows: crow.map((x) => [x.name, x.visaApproved, x.visaRejected, x.visaApproved + x.visaRejected]),
            total: ["TOTAL", t.visaApproved, t.visaRejected, t.visaApproved + t.visaRejected],
          },
          {
            kind: "table",
            heading: `STUDENT-LEVEL VISA DETAIL  (${list.length} records)`,
            head: ["Sr. No.", "Student Name", "University", "Country", "Partner", "Counsellor", "RM", "Vendor", "Visa Status"],
            rows: list.map((x, i) => [
              i + 1,
              x.studentName,
              x.university ?? "",
              x.country ? countryName(x.country) : "",
              x.partner ?? "",
              x.counsellor ?? "Not assigned",
              x.rm ?? "",
              x.vendor ?? "",
              stageLabel(x.status),
            ]),
          },
        ],
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------
function csvField(v: Cell): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(blob: Blob, file: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(file: string, rows: Cell[][]) {
  const csv = "﻿" + rows.map((r) => r.map(csvField).join(",")).join("\r\n");
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), file);
}

export function docToCsvRows(doc: ReportDoc): Cell[][] {
  const out: Cell[][] = [[doc.title], [doc.subtitle], []];
  for (const b of doc.blocks) {
    if (b.kind === "kpis") out.push(b.items.map((i) => i.label), b.items.map((i) => i.value), []);
    else if (b.kind === "note") out.push([b.text], []);
    else out.push(...(b.heading ? [[b.heading]] : []), b.head, ...b.rows, ...(b.total ? [b.total] : []), []);
  }
  return out;
}

// Rows of cells per doc, starting at column B like the workbook.
function docToSheet(XLSX: typeof XlsxLib, doc: ReportDoc) {
  const aoa: Cell[][] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const width = Math.max(
    2,
    ...doc.blocks.map((b) => (b.kind === "kpis" ? b.items.length : b.kind === "table" ? b.head.length : 1)),
  );
  const row = (cells: Cell[]) => aoa.push(["", ...cells]);
  const mergeRow = () => merges.push({ s: { r: aoa.length - 1, c: 1 }, e: { r: aoa.length - 1, c: width } });
  row([doc.title]);
  mergeRow();
  row([doc.subtitle]);
  mergeRow();
  row([]);
  for (const b of doc.blocks) {
    if (b.kind === "kpis") {
      row(b.items.map((i) => i.label));
      row(b.items.map((i) => i.value));
    } else if (b.kind === "note") {
      row([b.text]);
      mergeRow();
    } else {
      if (b.heading) {
        row([b.heading]);
        mergeRow();
      }
      row(b.head);
      for (const r of b.rows) row(r);
      if (b.total) row(b.total);
    }
    row([]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  const cols: { wch: number }[] = [{ wch: 2 }];
  for (let c = 1; c <= width; c++) {
    let w = 10;
    for (const r of aoa.slice(3)) {
      const v = r[c];
      if (v !== undefined && v !== "") w = Math.max(w, Math.min(48, String(v).length + 2));
    }
    cols.push({ wch: w });
  }
  ws["!cols"] = cols;
  return ws;
}

export async function xlsxBytes(docs: ReportDoc[]): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  for (const doc of docs) XLSX.utils.book_append_sheet(wb, docToSheet(XLSX, doc), doc.sheet.slice(0, 31));
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

export async function downloadXlsx(file: string, docs: ReportDoc[]) {
  const bytes = await xlsxBytes(docs);
  download(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), file);
}

// PDF (A4 landscape) with pdf-lib: title, subtitle, KPI tiles, tables with
// a repeated header row on page breaks. Standard fonts are WinAnsi, so
// anything outside it is swapped for a close ASCII form.
const WIN_ANSI_EXTRA = "–—‘’“”•…·€";
function pdfText(s: Cell): string {
  return String(s)
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/[↑↓]/g, "")
    .replace(/₹/g, "Rs ")
    .replace(/[\r\n\t]+/g, " ")
    .split("")
    .map((ch) => {
      const c = ch.charCodeAt(0);
      return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch) ? ch : "?";
    })
    .join("");
}

export async function downloadPdf(file: string, doc: ReportDoc) {
  const bytes = await pdfBytes(doc);
  download(new Blob([bytes as BlobPart], { type: "application/pdf" }), file);
}

export async function pdfBytes(doc: ReportDoc): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.title);
  pdf.setCreator("Converge · Reports & Analytics");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 842;
  const H = 595;
  const M = 32;
  const blue = rgb(0x15 / 255, 0x70 / 255, 0xef / 255);
  const ink = rgb(0x10 / 255, 0x18 / 255, 0x28 / 255);
  const grey = rgb(0x66 / 255, 0x70 / 255, 0x85 / 255);
  const line = rgb(0xe4 / 255, 0xe7 / 255, 0xec / 255);
  const head = rgb(0xf2 / 255, 0xf4 / 255, 0xf7 / 255);

  let page = pdf.addPage([W, H]);
  let y = H - M;
  const fit = (s: string, f: typeof font, size: number, max: number) => {
    let t = pdfText(s);
    if (f.widthOfTextAtSize(t, size) <= max) return t;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > max) t = t.slice(0, -1);
    return `${t}…`;
  };
  const wrap = (s: string, f: typeof font, size: number, max: number) => {
    const words = pdfText(s).split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > max && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const need = (h: number) => {
    if (y - h < M) newPage();
  };

  page.drawText(fit(doc.title, bold, 15, W - 2 * M), { x: M, y: y - 15, size: 15, font: bold, color: blue });
  y -= 24;
  for (const l of wrap(doc.subtitle, font, 8.5, W - 2 * M)) {
    page.drawText(l, { x: M, y: y - 9, size: 8.5, font, color: grey });
    y -= 12;
  }
  y -= 4;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.5, color: blue });
  y -= 14;

  for (const b of doc.blocks) {
    if (b.kind === "note") {
      const lines = wrap(b.text, font, 8, W - 2 * M);
      need(lines.length * 11 + 6);
      for (const l of lines) {
        page.drawText(l, { x: M, y: y - 8, size: 8, font, color: grey });
        y -= 11;
      }
      y -= 8;
      continue;
    }
    if (b.kind === "kpis") {
      const gap = 8;
      const per = Math.min(6, b.items.length);
      const bw = (W - 2 * M - gap * (per - 1)) / per;
      for (let i = 0; i < b.items.length; i += per) {
        need(52);
        b.items.slice(i, i + per).forEach((k, j) => {
          const x = M + j * (bw + gap);
          page.drawRectangle({ x, y: y - 46, width: bw, height: 46, borderColor: line, borderWidth: 1, color: rgb(1, 1, 1) });
          page.drawText(fit(k.label.toUpperCase(), bold, 7, bw - 16), { x: x + 8, y: y - 14, size: 7, font: bold, color: grey });
          page.drawText(k.value.toLocaleString("en-IN"), { x: x + 8, y: y - 37, size: 17, font: bold, color: ink });
        });
        y -= 56;
      }
      y -= 4;
      continue;
    }
    // Table: widths from content, capped, scaled to the page.
    const all = [b.head, ...b.rows, ...(b.total ? [b.total] : [])];
    const n = b.head.length;
    const natural = Array.from({ length: n }, (_, c) =>
      Math.min(
        200,
        Math.max(28, ...all.slice(0, 200).map((r, i) => (i === 0 ? bold : font).widthOfTextAtSize(pdfText(r[c] ?? ""), 8) + 10)),
      ),
    );
    // Fill the page, but don't stretch a narrow table more than 2x.
    const scale = Math.min(2, (W - 2 * M) / natural.reduce((s, x) => s + x, 0));
    const widths = natural.map((x) => x * scale);
    const TW = widths.reduce((s, x) => s + x, 0);
    const isNum = Array.from({ length: n }, (_, c) => b.rows.length > 0 && b.rows.every((r) => typeof r[c] === "number"));
    const RH = 15;
    const drawRow = (cells: Cell[], f: typeof font, fill?: ReturnType<typeof rgb>) => {
      need(RH);
      if (fill) page.drawRectangle({ x: M, y: y - RH, width: TW, height: RH, color: fill });
      let x = M;
      cells.forEach((cell, c) => {
        const t = fit(String(cell), f, 8, widths[c]! - 8);
        const tw = f.widthOfTextAtSize(t, 8);
        page.drawText(t, { x: isNum[c] ? x + widths[c]! - 4 - tw : x + 4, y: y - 10.5, size: 8, font: f, color: ink });
        x += widths[c]!;
      });
      page.drawLine({ start: { x: M, y: y - RH }, end: { x: M + TW, y: y - RH }, thickness: 0.5, color: line });
      y -= RH;
    };
    if (b.heading) {
      need(RH * 3 + 14);
      page.drawText(fit(b.heading, bold, 10, W - 2 * M), { x: M, y: y - 10, size: 10, font: bold, color: blue });
      y -= 16;
    }
    drawRow(b.head, bold, head);
    for (const r of b.rows) {
      if (y - RH < M) {
        newPage();
        drawRow(b.head, bold, head);
      }
      drawRow(r, font);
    }
    if (b.total) drawRow(b.total, bold, head);
    if (b.rows.length === 0) {
      need(RH);
      page.drawText("No records for these filters.", { x: M + 4, y: y - 10.5, size: 8, font, color: grey });
      y -= RH;
    }
    y -= 14;
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) =>
    p.drawText(`Converge · Reports & Analytics · page ${i + 1} of ${pages.length}`, { x: M, y: 14, size: 7, font, color: grey }),
  );
  return pdf.save();
}
