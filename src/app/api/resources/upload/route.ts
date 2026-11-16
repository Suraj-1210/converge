import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { db } from "~/server/db";
import { adminSectionsFor } from "~/server/tab-access";
import { saveBuffer } from "~/server/storage";
import { sanitizeResourceFileName, signUploadReceipt, sniffResourceFile } from "~/server/resources";
import { RESOURCE_FILE_TYPES, RESOURCE_MAX_BYTES } from "~/lib/resources";

// Admin > Resources file upload (16 Nov 2026). Separate from /api/upload: a
// bigger limit (25 MB) and Office types, for staff with the Resources tab
// only. The file is checked by its bytes (sniffResourceFile), stored PRIVATE
// under resources/ (Spaces in production, ./public/uploads locally), and the
// response carries a signed receipt that resources.adminCreate /
// adminAddVersion require. Partners never read the object directly: they go
// through /api/resources/[id], which checks audience and dates and logs it.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const jar = await cookies();
  const admin = await verifySessionJwt(jar.get(SESSION_COOKIE_NAME)?.value ?? "");
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await db.collegepond_user.findUnique({ where: { id: admin.id }, select: { status: true } });
  if (row?.status !== 1 || !(await adminSectionsFor(admin.id, admin.role)).includes("resources")) {
    return NextResponse.json({ error: "You don't have access to Resources." }, { status: 403 });
  }

  // Refuse an oversized body before reading it.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > RESOURCE_MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "File too large (25 MB max)" }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (file.size > RESOURCE_MAX_BYTES) {
    return NextResponse.json({ error: "File too large (25 MB max)" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const type = sniffResourceFile(buffer, file.name);
  if (!type) {
    return NextResponse.json(
      {
        error:
          "Unsupported file. Upload a PDF, PowerPoint, Word or Excel file, or a JPG / PNG image, with its usual extension.",
      },
      { status: 415 },
    );
  }

  const mime = RESOURCE_FILE_TYPES[type].mime;
  const fileName = sanitizeResourceFileName(file.name);
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const key = `resources/${month}/${randomUUID()}-${fileName}`;
  let url: string;
  try {
    url = (await saveBuffer(buffer, key, { contentType: mime, public: false })).url;
  } catch (e) {
    console.error("[resources/upload] storage error:", e);
    const notConfigured = e instanceof Error && /spaces is not configured/i.test(e.message);
    return NextResponse.json(
      {
        error: notConfigured
          ? "File storage isn't set up on the server yet — please contact support."
          : "Couldn't save the file. Please try again, or contact support if it persists.",
      },
      { status: 500 },
    );
  }

  const displayName = file.name.replace(/\\/g, "/").split("/").pop()?.slice(0, 255) ?? fileName;
  return NextResponse.json({
    upload: signUploadReceipt({ url, fileName: displayName, mime, size: file.size, by: admin.id }),
    fileName: displayName,
    mime,
    size: file.size,
  });
}
