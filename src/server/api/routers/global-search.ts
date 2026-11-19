import { z } from "zod";
import { type Prisma } from "../../../../generated/prisma";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { partnerScope } from "~/server/partner-access";
import { staffStudentScope } from "~/server/staff-access";

// The global search bar in the top bar of both portals (19 Nov). Finds
// students by CP Student ID (pasted as CP-10042, CP10042, cp 10042 or just
// 10042), name, email or phone, within exactly the students this user may see
// on their Students page: staff through staffStudentScope (counsellor, team,
// BDM portfolio), partners through partnerScope (agency, own students). The
// procedures also sit behind the Students tab switch (API_SECTIONS /
// API_TABS), so a user without that tab gets nothing.

const LIMIT = 8;
const input = z.object({ q: z.string().trim().max(100) });

// "CP-10042", "cp10042", "CP 010042" → 10042.
const CP_ID = /^cp[\s-]*0*(\d{1,9})$/i;

function matchWhere(raw: string): Prisma.studentWhereInput | null {
  const q = raw.trim();
  const cp = CP_ID.exec(q);
  if (cp) return { id: Number(cp[1]) };
  const or: Prisma.studentWhereInput[] = [];
  if (/^\d{1,9}$/.test(q)) or.push({ id: Number(q) });
  const digits = q.replace(/[\s()+-]/g, "");
  if (/^\d{5,}$/.test(digits)) or.push({ phone: { contains: digits } });
  if (q.length >= 2) {
    // Every word must hit the first name, last name or email ("aarav sh").
    const words = q.split(/\s+/).filter(Boolean).slice(0, 4);
    or.push({
      AND: words.map((w) => ({
        OR: [
          { first_name: { contains: w } },
          { last_name: { contains: w } },
          { email: { contains: w } },
        ],
      })),
    });
  }
  return or.length ? { OR: or } : null;
}

async function find(scope: Prisma.studentWhereInput, q: string, withPartner: boolean) {
  const match = matchWhere(q);
  if (!match) return [];
  const rows = await db.student.findMany({
    where: { AND: [scope, match] },
    orderBy: { updated_at: "desc" },
    take: LIMIT,
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      organization: { select: { name: true } },
      created_by: { select: { first_name: true, last_name: true } },
    },
  });
  // An exact CP ID hit goes first.
  const asId = Number(CP_ID.exec(q.trim())?.[1] ?? q.trim());
  rows.sort((a, b) => Number(b.id === asId) - Number(a.id === asId));
  return rows.map((r) => ({
    id: r.id,
    name: `${r.first_name} ${r.last_name}`.trim(),
    cpStudentId: `CP-${r.id}`,
    email: r.email,
    // Staff see whose student it is: the agency, or the independent partner.
    partner: withPartner
      ? (r.organization?.name ??
        (r.created_by ? `${r.created_by.first_name} ${r.created_by.last_name}`.trim() : null))
      : null,
  }));
}

export const globalSearchRouter = createTRPCRouter({
  adminStudents: protectedAdminProcedure.input(input).query(async ({ ctx, input }) => {
    return find(await staffStudentScope(ctx.cpUser), input.q, true);
  }),

  partnerStudents: protectedPartnerProcedure.input(input).query(async ({ ctx, input }) => {
    const { where } = await partnerScope(ctx.cpPartner.id);
    return find(where as Prisma.studentWhereInput, input.q, false);
  }),
});
