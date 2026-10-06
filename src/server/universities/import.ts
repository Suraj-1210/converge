import path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { db } from "~/server/db";
import { saveBuffer } from "~/server/storage";

// Sheet names in the Master_B2B template. Anything else is ignored.
const SHEET_UNIVERSITY = "University";
const SHEET_COURSE = "Course";

const UNI_HEADERS = {
  id: "id",
  code: "code",
  name: "name",
  city: "city",
  country: "country",
  type: "type",
  ranking: "ranking",
  app_source: "app_source",
  website: "website",
  logo_url: "logo_url",
  is_open: "is_open",
} as const;

const COURSE_HEADERS = {
  id: "id",
  name: "name",
  degree_level: "degree_level",
  duration_months: "duration_months",
  tuition_fee: "tuition_fee",
  currency: "currency",
  is_open: "is_open",
  university_id: "university_id",
  code: "code",
  url: "url",
  toefl: "toefl",
  toefl_2026: "toefl_2026",
  ielts: "ielts",
  det: "det",
  pte: "pte",
  gre: "gre",
  gmat: "gmat",
  application_deadline: "application_deadline",
  is_stem: "is_stem",
  intake_month: "intake_month",
  intake_year: "intake_year",
  is_coop_available: "is_coop_available",
  has_app_fee_waiver: "has_app_fee_waiver",
  app_fee: "app_fee",
  has_tuition_deposit: "has_tuition_deposit",
  has_scholarship: "has_scholarship",
  scholarship_amount: "scholarship_amount",
  min_entry_requirements: "min_entry_requirements",
  min_entry_requirements_scale: "min_entry_requirements_scale",
  has_faster_tat: "has_faster_tat",
} as const;

// =============================================================================
// Public types
// =============================================================================

export type RowStatus = "new" | "update" | "error";

export interface PreviewUniRow {
  /** Stable client-side id used as React key — `u-{rowNum}`. */
  id: string;
  rowNum: number;
  /** The xlsx-internal id from the source sheet (for course → uni FK resolution). */
  xlsxId: number | null;
  data: {
    code: string | null;
    name: string;
    country: string;
    city: string | null;
    type: number;
    ranking: number | null;
    appSource: string | null;
    website: string | null;
    logoUrl: string | null;
    isOpen: boolean;
  };
  /** DB id this row will update; null = INSERT. */
  matchedDbId: number | null;
  /** How the match was determined — informational only. */
  matchedBy: "code" | "name+country" | null;
  status: RowStatus;
  errors: string[];
  /**
   * Logo URL that came from the uploaded ZIP, already saved to /uploads/uni-logos/.
   * Wins over a `logo_url` column in the CSV when both exist.
   */
  logoFromZip: string | null;
}

export interface PreviewCourseRow {
  id: string;
  rowNum: number;
  xlsxId: number | null;
  /** xlsx-internal university id (column "university_Id"). */
  xlsxUniversityId: number | null;
  data: {
    name: string;
    code: string | null;
    degreeLevel: number | null;
    durationMonths: number | null;
    tuitionFee: number | null;
    currency: string | null;
    isOpen: boolean;
    url: string | null;
    toefl: number | null;
    /** TOEFL iBT 2026 band scale, 1-6. */
    toefl2026: number | null;
    ielts: number | null;
    det: number | null;
    pte: number | null;
    gre: number | null;
    gmat: number | null;
    /** YYYY-MM-DD. */
    applicationDeadline: string | null;
    isStem: boolean;
    intakeMonth: string | null;
    intakeYear: number | null;
    isCoopAvailable: boolean;
    hasAppFeeWaiver: boolean;
    appFee: number | null;
    hasTuitionDeposit: boolean;
    hasScholarship: boolean;
    scholarshipAmount: number | null;
    minEntryRequirements: string | null;
    minEntryRequirementsScale: string | null;
    hasFasterTat: boolean;
  };
  matchedDbId: number | null;
  status: RowStatus;
  errors: string[];
}

export interface ImportPreview {
  universities: PreviewUniRow[];
  courses: PreviewCourseRow[];
  /** All ZIP filenames we found (sans extension) — for surfacing unmatched. */
  zipFilenames: string[];
  /** Fatal error: file format unreadable, no recognised sheets, etc. */
  fatalError?: string;
}

export interface ImportSummary {
  universities: { created: number; updated: number };
  courses: { created: number; updated: number };
  errors: Array<{ sheet: "University" | "Course"; row: number; message: string }>;
}

// =============================================================================
// XLSX / CSV parsing helpers
// =============================================================================

type CellValue = string | number | boolean | null | undefined;
type RowMap = Record<string, CellValue>;

function normaliseHeader(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function rowsFromSheet(sheet: XLSX.WorkSheet): RowMap[] {
  const aoa = XLSX.utils.sheet_to_json<CellValue[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
    raw: true,
  });
  if (aoa.length === 0) return [];
  const headerRow = aoa[0] ?? [];
  const headers = headerRow.map((h) =>
    h === null || h === undefined ? "" : normaliseHeader(String(h)),
  );
  const rows: RowMap[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const dataRow = aoa[i] ?? [];
    if (dataRow.every((c) => c === null || c === undefined || c === "")) continue;
    const obj: RowMap = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = dataRow[idx] ?? null;
    });
    rows.push(obj);
  }
  return rows;
}

function asBool(v: CellValue, fallback = false): boolean {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "t"].includes(s)) return true;
  if (["0", "false", "no", "n", "f"].includes(s)) return false;
  return fallback;
}

function asString(v: CellValue, max = 255): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function asInt(v: CellValue): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n =
    typeof v === "number"
      ? v
      : Number(String(v).trim().replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function asDecimal(v: CellValue): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n =
    typeof v === "number"
      ? v
      : Number(String(v).trim().replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return n;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * A date cell: an Excel date, 2027-06-30, 30/06/2027 (day first), 30 June 2027
 * or June 30, 2027. A trailing "*" is ignored. `invalid` is true for text that
 * isn't a date (e.g. "Check programme-specific deadline").
 */
function asDate(v: CellValue): { value: string | null; invalid: boolean } {
  if (v === null || v === undefined || v === "") return { value: null, invalid: false };
  if (typeof v === "number") {
    // Excel stores dates as days since 1899-12-30.
    if (v < 1 || v > 2958465) return { value: null, invalid: true };
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000);
    return { value: dt.toISOString().slice(0, 10), invalid: false };
  }
  const s = String(v).replace(/\*+/g, "").replace(/\s+/g, " ").trim();
  if (!s) return { value: null, invalid: false };
  let m: RegExpMatchArray | null;
  let value: string | null = null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    value = isoDate(+m[1]!, +m[2]!, +m[3]!);
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) {
    value = isoDate(+m[3]!, +m[2]!, +m[1]!);
  } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/i.exec(s))) {
    const mon = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (mon >= 0) value = isoDate(+m[3]!, mon + 1, +m[1]!);
  } else if ((m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s))) {
    const mon = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (mon >= 0) value = isoDate(+m[3]!, mon + 1, +m[2]!);
  }
  return { value, invalid: value === null };
}

function asCountry(v: CellValue): string | null {
  const s = asString(v, 2);
  if (!s) return null;
  return s.toUpperCase();
}

function asTypeCode(v: CellValue): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v === 1 ? 1 : 0;
  return String(v).trim().toLowerCase().startsWith("priv") ? 1 : 0;
}

// =============================================================================
// ZIP unpack — extract logos keyed by filename (without ext)
// =============================================================================

interface ExtractedLogo {
  /** Filename without extension, lowercased. Used to match against uni `code`. */
  key: string;
  /** Saved path under /uploads/uni-logos. */
  url: string;
}

function mimeForExt(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return undefined;
  }
}

async function extractLogos(zipBuffer: Buffer): Promise<ExtractedLogo[]> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const out: ExtractedLogo[] = [];
  const entries = Object.entries(zip.files);
  let totalBytes = 0; // zip-bomb guard: cap cumulative decompressed size
  for (const [name, file] of entries) {
    if (file.dir) continue;
    const base = path.basename(name);
    // Skip macOS metadata + hidden files.
    if (base.startsWith(".") || base.startsWith("_")) continue;
    const ext = path.extname(base).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) continue;
    const stem = base.slice(0, -ext.length).toLowerCase().trim();
    if (!stem) continue;

    const content = await file.async("nodebuffer");
    if (content.length === 0) continue;
    if (content.length > 1024 * 1024) continue; // skip oversized images (>1MB)
    totalBytes += content.length;
    if (totalBytes > 50 * 1024 * 1024) break; // stop if total decompressed > 50MB

    const safeName = stem.replace(/[^a-z0-9._-]/gi, "_");
    // Logos are non-sensitive → public object with a permanent URL.
    const stored = await saveBuffer(content, `uni-logos/${safeName}${ext}`, {
      contentType: mimeForExt(ext),
      public: true,
    });
    out.push({ key: stem, url: stored.url });
  }
  return out;
}

// =============================================================================
// Parse + validate (no DB writes)
// =============================================================================

export async function parseAndValidate(
  csvBuffer: Buffer,
  zipBuffer?: Buffer,
): Promise<ImportPreview> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(csvBuffer, { type: "buffer" });
  } catch (e) {
    return {
      universities: [],
      courses: [],
      zipFilenames: [],
      fatalError: `Could not parse spreadsheet: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }

  const uniSheet = wb.Sheets[SHEET_UNIVERSITY];
  const courseSheet = wb.Sheets[SHEET_COURSE];

  if (!uniSheet && !courseSheet) {
    return {
      universities: [],
      courses: [],
      zipFilenames: [],
      fatalError: `File must contain a "${SHEET_UNIVERSITY}" or "${SHEET_COURSE}" sheet.`,
    };
  }

  // Optional ZIP — extract logos in parallel with parsing.
  let logos: ExtractedLogo[] = [];
  if (zipBuffer) {
    try {
      logos = await extractLogos(zipBuffer);
    } catch (e) {
      console.error("Logo ZIP extract failed:", e);
    }
  }
  const logoByKey = new Map(logos.map((l) => [l.key, l.url]));

  // Pre-fetch all existing universities so we can match by code or
  // (name, country) without N round-trips.
  const allUnis = await db.university.findMany({
    select: { id: true, code: true, name: true, country: true },
  });
  const dbByCode = new Map<string, number>();
  const dbByNameCountry = new Map<string, number>();
  for (const u of allUnis) {
    if (u.code) dbByCode.set(u.code.toLowerCase(), u.id);
    dbByNameCountry.set(`${u.name.toLowerCase()}|${u.country}`, u.id);
  }

  // ---- Universities ----
  const universities: PreviewUniRow[] = [];
  const seenCodesInCsv = new Map<string, number>(); // code → first row that used it
  if (uniSheet) {
    const rows = rowsFromSheet(uniSheet);
    rows.forEach((r, i) => {
      const rowNum = i + 2;
      const errors: string[] = [];
      const code = asString(r[UNI_HEADERS.code], 50);
      const name = asString(r[UNI_HEADERS.name], 150);
      const country = asCountry(r[UNI_HEADERS.country]);
      const xlsxId = asInt(r[UNI_HEADERS.id]);

      if (!name) errors.push("name is required");
      if (country?.length !== 2)
        errors.push("country must be a 2-letter ISO code (e.g. US, GB, IN)");
      if (!asString(r[UNI_HEADERS.city], 100)) errors.push("city is required");

      // Code is required + must be exactly 3 alphanumeric chars.
      if (!code) {
        errors.push("code is required");
      } else if (!/^[a-zA-Z0-9]{3}$/.test(code)) {
        errors.push("code must be exactly 3 alphanumeric characters");
      } else {
        const codeKey = code.toLowerCase();
        const firstRow = seenCodesInCsv.get(codeKey);
        if (firstRow !== undefined) {
          errors.push(`duplicate code in this file (also used by row ${firstRow})`);
        } else {
          seenCodesInCsv.set(codeKey, rowNum);
        }
      }

      // Match against DB.
      let matchedDbId: number | null = null;
      let matchedBy: "code" | "name+country" | null = null;
      if (code) {
        const dbId = dbByCode.get(code.toLowerCase());
        if (dbId !== undefined) {
          matchedDbId = dbId;
          matchedBy = "code";
        }
      }
      if (!matchedDbId && name && country) {
        const dbId = dbByNameCountry.get(`${name.toLowerCase()}|${country}`);
        if (dbId !== undefined) {
          matchedDbId = dbId;
          matchedBy = "name+country";
        }
      }

      // Logo from ZIP wins over CSV value.
      const logoFromZip = code ? (logoByKey.get(code.toLowerCase()) ?? null) : null;

      const status: RowStatus =
        errors.length > 0 ? "error" : matchedDbId ? "update" : "new";

      universities.push({
        id: `u-${rowNum}`,
        rowNum,
        xlsxId,
        data: {
          code,
          name: name ?? "",
          country: country ?? "",
          city: asString(r[UNI_HEADERS.city], 100),
          type: asTypeCode(r[UNI_HEADERS.type]),
          ranking: asInt(r[UNI_HEADERS.ranking]),
          appSource: asString(r[UNI_HEADERS.app_source], 50),
          website: asString(r[UNI_HEADERS.website], 255),
          logoUrl: logoFromZip ?? asString(r[UNI_HEADERS.logo_url], 255),
          isOpen: asBool(r[UNI_HEADERS.is_open], true),
        },
        matchedDbId,
        matchedBy,
        status,
        errors,
        logoFromZip,
      });
    });
  }

  // ---- Courses ----
  const courses: PreviewCourseRow[] = [];
  if (courseSheet) {
    // For course code dedupe + DB collision detection.
    const dbCourseCodes = new Map<string, number>();
    const allCourses = await db.course.findMany({
      where: { code: { not: null } },
      select: { id: true, code: true },
    });
    for (const c of allCourses) {
      if (c.code) dbCourseCodes.set(c.code.toLowerCase(), c.id);
    }
    const seenCourseCodes = new Map<string, number>();

    const rows = rowsFromSheet(courseSheet);
    rows.forEach((r, i) => {
      const rowNum = i + 2;
      const errors: string[] = [];
      const name = asString(r[COURSE_HEADERS.name], 150);
      const code = asString(r[COURSE_HEADERS.code], 50);
      const xlsxId = asInt(r[COURSE_HEADERS.id]);
      const xlsxUniversityId = asInt(r[COURSE_HEADERS.university_id]);

      if (!name) errors.push("name is required");
      if (xlsxUniversityId === null) errors.push("university_Id is required");
      if (asInt(r[COURSE_HEADERS.degree_level]) === null)
        errors.push("degree_level is required");
      if (asInt(r[COURSE_HEADERS.duration_months]) === null)
        errors.push("duration_months is required");
      if (asDecimal(r[COURSE_HEADERS.tuition_fee]) === null)
        errors.push("tuition_fee is required");
      if (!asString(r[COURSE_HEADERS.currency], 3))
        errors.push("currency is required");
      if (!asString(r[COURSE_HEADERS.url], 255)) errors.push("url is required");
      const toefl2026 = asDecimal(r[COURSE_HEADERS.toefl_2026]);
      if (toefl2026 !== null && (toefl2026 < 1 || toefl2026 > 6 || (toefl2026 * 2) % 1 !== 0))
        errors.push("toefl_2026 must be a band from 1 to 6 in steps of 0.5 (use toefl for 0-120 scores)");
      const deadline = asDate(r[COURSE_HEADERS.application_deadline]);
      if (deadline.invalid)
        errors.push("application_deadline must be a date such as 2027-06-30, or left blank");

      if (code) {
        const codeKey = code.toLowerCase();
        const firstRow = seenCourseCodes.get(codeKey);
        if (firstRow !== undefined) {
          errors.push(`duplicate code in this file (also used by row ${firstRow})`);
        } else {
          seenCourseCodes.set(codeKey, rowNum);
        }
      }

      let matchedDbId: number | null = null;
      if (code) {
        const dbId = dbCourseCodes.get(code.toLowerCase());
        if (dbId !== undefined) matchedDbId = dbId;
      }

      const status: RowStatus =
        errors.length > 0 ? "error" : matchedDbId ? "update" : "new";

      courses.push({
        id: `c-${rowNum}`,
        rowNum,
        xlsxId,
        xlsxUniversityId,
        data: {
          name: name ?? "",
          code,
          degreeLevel: asInt(r[COURSE_HEADERS.degree_level]),
          durationMonths: asInt(r[COURSE_HEADERS.duration_months]),
          tuitionFee: asDecimal(r[COURSE_HEADERS.tuition_fee]),
          currency: asString(r[COURSE_HEADERS.currency], 3),
          isOpen: asBool(r[COURSE_HEADERS.is_open], true),
          url: asString(r[COURSE_HEADERS.url], 255),
          toefl: asDecimal(r[COURSE_HEADERS.toefl]),
          toefl2026,
          ielts: asDecimal(r[COURSE_HEADERS.ielts]),
          det: asInt(r[COURSE_HEADERS.det]),
          pte: asDecimal(r[COURSE_HEADERS.pte]),
          gre: asInt(r[COURSE_HEADERS.gre]),
          gmat: asInt(r[COURSE_HEADERS.gmat]),
          applicationDeadline: deadline.value,
          isStem: asBool(r[COURSE_HEADERS.is_stem]),
          intakeMonth: asString(r[COURSE_HEADERS.intake_month], 50),
          intakeYear: asInt(r[COURSE_HEADERS.intake_year]),
          isCoopAvailable: asBool(r[COURSE_HEADERS.is_coop_available]),
          hasAppFeeWaiver: asBool(r[COURSE_HEADERS.has_app_fee_waiver]),
          appFee: asDecimal(r[COURSE_HEADERS.app_fee]),
          hasTuitionDeposit: asBool(r[COURSE_HEADERS.has_tuition_deposit]),
          hasScholarship: asBool(r[COURSE_HEADERS.has_scholarship]),
          scholarshipAmount: asDecimal(r[COURSE_HEADERS.scholarship_amount]),
          minEntryRequirements: asString(r[COURSE_HEADERS.min_entry_requirements], 2000),
          minEntryRequirementsScale: asString(
            r[COURSE_HEADERS.min_entry_requirements_scale],
            20,
          ),
          hasFasterTat: asBool(r[COURSE_HEADERS.has_faster_tat]),
        },
        matchedDbId,
        status,
        errors,
      });
    });
  }

  return {
    universities,
    courses,
    zipFilenames: logos.map((l) => l.key),
  };
}

// =============================================================================
// Commit (writes to DB)
// =============================================================================

export async function commitImport(
  preview: ImportPreview,
): Promise<ImportSummary> {
  const errors: ImportSummary["errors"] = [];
  const summary: ImportSummary = {
    universities: { created: 0, updated: 0 },
    courses: { created: 0, updated: 0 },
    errors,
  };

  // Track xlsxId → dbId for course FK resolution. Seed it with rows that
  // already matched an existing university (their dbId is known up-front).
  const xlsxToDbId = new Map<number, number>();
  for (const u of preview.universities) {
    if (u.xlsxId !== null && u.matchedDbId !== null) {
      xlsxToDbId.set(u.xlsxId, u.matchedDbId);
    }
  }

  // ---- Universities ----
  for (const row of preview.universities) {
    if (row.status === "error") continue;
    if (row.errors.length > 0) {
      errors.push({
        sheet: "University",
        row: row.rowNum,
        message: row.errors.join("; "),
      });
      continue;
    }
    if (row.data.city === null) {
      errors.push({
        sheet: "University",
        row: row.rowNum,
        message: "city is required",
      });
      continue;
    }
    const data = {
      name: row.data.name,
      code: row.data.code,
      city: row.data.city,
      country: row.data.country,
      type: row.data.type,
      ranking: row.data.ranking,
      app_source: row.data.appSource,
      website: row.data.website,
      logo_url: row.data.logoUrl,
      is_open: row.data.isOpen ? 1 : 0,
    };
    try {
      let dbId: number;
      if (row.matchedDbId !== null) {
        await db.university.update({ where: { id: row.matchedDbId }, data });
        summary.universities.updated++;
        dbId = row.matchedDbId;
      } else {
        const created = await db.university.create({ data, select: { id: true } });
        summary.universities.created++;
        dbId = created.id;
      }
      if (row.xlsxId !== null) xlsxToDbId.set(row.xlsxId, dbId);
    } catch (e) {
      errors.push({
        sheet: "University",
        row: row.rowNum,
        message: e instanceof Error ? e.message : "Insert failed",
      });
    }
  }

  // ---- Courses ----
  for (const row of preview.courses) {
    if (row.status === "error") continue;
    if (row.errors.length > 0) {
      errors.push({
        sheet: "Course",
        row: row.rowNum,
        message: row.errors.join("; "),
      });
      continue;
    }
    if (row.xlsxUniversityId === null) {
      errors.push({
        sheet: "Course",
        row: row.rowNum,
        message: "university_Id is required",
      });
      continue;
    }
    const universityId = xlsxToDbId.get(row.xlsxUniversityId);
    if (!universityId) {
      errors.push({
        sheet: "Course",
        row: row.rowNum,
        message: `No matching University row for university_Id=${row.xlsxUniversityId}`,
      });
      continue;
    }
    const { degreeLevel, durationMonths, tuitionFee, currency, url } = row.data;
    if (
      degreeLevel === null ||
      durationMonths === null ||
      tuitionFee === null ||
      currency === null ||
      url === null
    ) {
      errors.push({
        sheet: "Course",
        row: row.rowNum,
        message:
          "Missing required field (degree level, duration, tuition, currency, or url)",
      });
      continue;
    }
    const data = {
      university_id: universityId,
      name: row.data.name,
      code: row.data.code,
      degree_level: degreeLevel,
      duration_months: durationMonths,
      tuition_fee: tuitionFee,
      currency: currency,
      is_open: row.data.isOpen ? 1 : 0,
      url: url,
      toefl: row.data.toefl,
      toefl_2026: row.data.toefl2026,
      ielts: row.data.ielts,
      det: row.data.det,
      pte: row.data.pte,
      gre: row.data.gre,
      gmat: row.data.gmat,
      application_deadline: row.data.applicationDeadline
        ? new Date(`${row.data.applicationDeadline}T00:00:00Z`)
        : null,
      is_stem: row.data.isStem ? 1 : 0,
      intake_month: row.data.intakeMonth,
      intake_year: row.data.intakeYear,
      is_coop_available: row.data.isCoopAvailable ? 1 : 0,
      has_app_fee_waiver: row.data.hasAppFeeWaiver ? 1 : 0,
      app_fee: row.data.appFee,
      has_tuition_deposit: row.data.hasTuitionDeposit ? 1 : 0,
      has_scholarship: row.data.hasScholarship ? 1 : 0,
      scholarship_amount: row.data.scholarshipAmount,
      min_entry_requirements: row.data.minEntryRequirements,
      min_entry_requirements_scale: row.data.minEntryRequirementsScale,
      has_faster_tat: row.data.hasFasterTat ? 1 : 0,
    };
    try {
      if (row.matchedDbId !== null) {
        await db.course.update({ where: { id: row.matchedDbId }, data });
        summary.courses.updated++;
      } else {
        await db.course.create({ data });
        summary.courses.created++;
      }
    } catch (e) {
      errors.push({
        sheet: "Course",
        row: row.rowNum,
        message: e instanceof Error ? e.message : "Insert failed",
      });
    }
  }

  return summary;
}
