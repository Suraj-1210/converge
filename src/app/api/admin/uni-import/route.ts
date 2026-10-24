import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { canUseSection } from "~/lib/admin-sections";
import { parseAndValidate } from "~/server/universities/import";

export const runtime = "nodejs";
// Bound a large/zip-bomb import so it can't hold an instance hostage.
export const maxDuration = 60;

const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50 MB

const ALLOWED_CSV_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/octet-stream",
  "",
]);

// Preview endpoint — parses + validates, **no DB writes**. Returns the
// structured preview the client renders in the inline-edit modal.
export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  const claims = token ? await verifySessionJwt(token) : null;
  if (!claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Universities is a lead-and-above section (~/lib/admin-sections).
  if (!canUseSection(claims.role, "universities")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_CSV_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 10 MB)" },
      { status: 413 },
    );
  }
  if (file.type && !ALLOWED_CSV_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type}` },
      { status: 415 },
    );
  }

  // Optional logo ZIP
  const zip = formData.get("zip");
  let zipBuffer: Buffer | undefined;
  if (zip instanceof File && zip.size > 0) {
    if (zip.size > MAX_ZIP_BYTES) {
      return NextResponse.json(
        { error: "ZIP too large (max 50 MB)" },
        { status: 413 },
      );
    }
    zipBuffer = Buffer.from(await zip.arrayBuffer());
  }

  const csvBuffer = Buffer.from(await file.arrayBuffer());
  try {
    const preview = await parseAndValidate(csvBuffer, zipBuffer);
    return NextResponse.json(preview);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Parse failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
