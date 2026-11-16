import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionJwt } from "~/server/auth/jwt";
import { db } from "~/server/db";
import { canSeeStudent } from "~/server/staff-access";
import { followUpIcsFile } from "~/server/follow-ups";

// "Add to calendar" on an application follow-up (Application tab): the
// follow-up as an .ics file (METHOD:PUBLISH, same UID as the emailed invite).
// Any staff user who can see the student, like the panel itself.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  const claims = token ? await verifySessionJwt(token) : null;
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: raw } = await params;
  const id = Number(raw);
  const notFound = () => NextResponse.json({ error: "Follow-up not found" }, { status: 404 });
  if (!Number.isInteger(id) || id <= 0) return notFound();

  const f = await db.application_follow_up.findUnique({
    where: { id },
    select: { application: { select: { student_id: true } } },
  });
  // Outside the staff user's scope looks exactly like a missing follow-up.
  if (!f || !(await canSeeStudent(claims, f.application.student_id))) return notFound();

  const file = await followUpIcsFile(id);
  if (!file) return notFound();
  return new NextResponse(file.ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
