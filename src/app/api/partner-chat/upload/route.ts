import { TRPCError } from "@trpc/server";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PARTNER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  resolvePartnerSession,
  verifySessionJwt,
} from "~/server/auth/jwt";
import { db } from "~/server/db";
import { UserStatus } from "~/server/db/enums";
import { type ChatActor, createAttachment } from "~/server/partner-chat";
import { requirePartnerChatStudent, requireStaffChatStudent } from "~/server/partner-chat-access";

export const runtime = "nodejs";
export const maxDuration = 30;

// Attach a file to a partner-chat message. Multipart fields: side ("partner"
// for the partner portal, "staff" for the admin portal), studentId, file.
// The file is stored privately and returned as an attachment id, which the
// partnerChat.*Send mutation then sends. Same size and type rules as student
// documents (10 MB; PDF, DOC, DOCX, JPG, PNG). Who may attach follows the
// chat's participants (src/server/partner-chat-access.ts).
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const side = form.get("side");
  const studentId = Number(form.get("studentId"));
  const file = form.get("file");
  if (side !== "partner" && side !== "staff") return NextResponse.json({ error: "Invalid side" }, { status: 400 });
  if (!Number.isInteger(studentId) || studentId <= 0) return NextResponse.json({ error: "Invalid student id" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const jar = await cookies();
  const adminToken = jar.get(SESSION_COOKIE_NAME)?.value;
  let actor: ChatActor;
  try {
    if (side === "staff") {
      const claims = adminToken ? await verifySessionJwt(adminToken) : null;
      if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const me = await db.collegepond_user.findUnique({ where: { id: claims.id }, select: { status: true } });
      if (me?.status !== 1) return NextResponse.json({ error: "This account is no longer active." }, { status: 401 });
      await requireStaffChatStudent(claims, studentId);
      actor = { side: "staff", id: claims.id, role: claims.role, impersonatorId: claims.realId ?? null };
    } else {
      const partner = await resolvePartnerSession(jar.get(PARTNER_SESSION_COOKIE_NAME)?.value, adminToken);
      if (!partner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const me = await db.user.findUnique({ where: { id: partner.id }, select: { status: true, deleted_at: true } });
      if (!me || me.deleted_at || me.status === UserStatus.REJECTED || me.status === UserStatus.INACTIVE) {
        return NextResponse.json({ error: "This account is no longer active." }, { status: 401 });
      }
      await requirePartnerChatStudent(partner.id, studentId);
      actor = { side: "partner", id: partner.id, impersonatorId: partner.impersonatorId ?? null };
    }
  } catch (e) {
    if (e instanceof TRPCError) {
      return NextResponse.json({ error: e.message }, { status: e.code === "FORBIDDEN" ? 403 : 404 });
    }
    throw e;
  }

  const res = await createAttachment(actor, studentId, file);
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res);
}
