import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_OWNER_SESSION_COOKIE_NAME,
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { UserStatus } from "~/server/db/enums";
import { adminSectionsFor, partnerTabsFor } from "~/server/tab-access";
import { partnerResourceWhere } from "~/server/resources";
import { isPrivateKey, readStoredFile } from "~/server/storage";
import { presignGetUrl, spacesConfigured } from "~/server/storage/spaces";
import { ResourceAction, ResourceKind, isPreviewable } from "~/lib/resources";

// Opens a resource (16 Nov 2026): GET /api/resources/<id>?mode=preview|download|open
//
// Partners (the default): only a resource they may see right now (audience,
// publish / expiry dates, not archived, Resources tab on), always its latest
// version, and every open is logged in resource_download. A Super Admin
// impersonating a partner isn't logged as that partner.
//
// Staff (?as=admin, with the Resources tab): any version (&v=<versionId>), not
// logged, so admins can check and restore old files.
//
// preview: PDFs and images are redirected to the file (shown inline); other
// types download. download: served as an attachment with its original name.
// A link resource redirects to the link.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

type Version = { id: number; file_url: string; file_name: string; mime_type: string };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "preview";
  const jar = await cookies();
  const adminToken = jar.get(SESSION_COOKIE_NAME)?.value;

  if (url.searchParams.get("as") === "admin") {
    const admin = adminToken ? await verifySessionJwt(adminToken) : null;
    if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const row = await db.collegepond_user.findUnique({ where: { id: admin.id }, select: { status: true } });
    if (row?.status !== 1 || !(await adminSectionsFor(admin.id, admin.role)).includes("resources")) {
      return notFound();
    }
    const r = await db.resource.findUnique({
      where: { id },
      select: { kind: true, link_url: true },
    });
    if (!r) return notFound();
    if (r.kind === ResourceKind.LINK) return r.link_url ? NextResponse.redirect(r.link_url, 302) : notFound();
    const vId = Number(url.searchParams.get("v"));
    const version = await db.resource_version.findFirst({
      where: { resource_id: id, ...(Number.isInteger(vId) && vId > 0 ? { id: vId } : {}) },
      orderBy: { version_no: "desc" },
    });
    return version ? serve(version, mode) : notFound();
  }

  const partner = await resolvePartnerSession(
    jar.get(PARTNER_SESSION_COOKIE_NAME)?.value,
    adminToken,
    jar.get(PARTNER_OWNER_SESSION_COOKIE_NAME)?.value,
  );
  if (!partner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await db.user.findUnique({
    where: { id: partner.id },
    select: { id: true, type: true, status: true, deleted_at: true },
  });
  const ownerView = !!partner.ownerImpersonatorId;
  if (
    !me ||
    me.deleted_at ||
    me.status === UserStatus.REJECTED ||
    (me.status === UserStatus.INACTIVE && !ownerView) ||
    !(await partnerTabsFor(me.id, me.type)).includes("resources")
  ) {
    return notFound();
  }

  const r = await db.resource.findFirst({
    where: { AND: [{ id }, partnerResourceWhere(me.type)] },
    select: {
      id: true,
      kind: true,
      link_url: true,
      versions: {
        orderBy: { version_no: "desc" },
        take: 1,
        select: { id: true, file_url: true, file_name: true, mime_type: true },
      },
    },
  });
  if (!r) return notFound();
  const version = r.versions[0] ?? null;
  const isLink = r.kind === ResourceKind.LINK;
  if (isLink ? !r.link_url : !version) return notFound();

  // Who opened it: the partner, or the owner viewing as their counsellor.
  // Not a Super Admin impersonating.
  if (!partner.impersonatorId) {
    const action = isLink
      ? ResourceAction.LINK
      : mode === "preview" && isPreviewable(version!.mime_type)
        ? ResourceAction.PREVIEW
        : ResourceAction.DOWNLOAD;
    try {
      await db.resource_download.create({
        data: {
          resource_id: r.id,
          version_id: isLink ? null : version!.id,
          user_id: partner.ownerImpersonatorId ?? me.id,
          action,
        },
      });
    } catch (e) {
      console.error(`[resources] logging open of ${r.id} failed:`, e);
    }
  }

  if (isLink) return NextResponse.redirect(r.link_url!, 302);
  return serve(version!, mode);
}

async function serve(v: Version, mode: string): Promise<Response> {
  if (mode === "preview" && isPreviewable(v.mime_type)) {
    if (isPrivateKey(v.file_url)) {
      if (!spacesConfigured()) return notFound();
      return NextResponse.redirect(await presignGetUrl(v.file_url), 302);
    }
    // Local dev: "/uploads/..." under ./public. A relative Location keeps the
    // browser on whichever host it used.
    return new Response(null, { status: 302, headers: { Location: v.file_url, "Cache-Control": "no-store" } });
  }
  let body: Buffer;
  try {
    body = await readStoredFile(v.file_url);
  } catch (e) {
    console.error(`[resources] reading ${v.file_url} failed:`, e);
    return notFound();
  }
  const ascii = v.file_name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": v.mime_type,
      "Content-Length": String(body.length),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(v.file_name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
