import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { UniApplicationStatusLabel } from "~/server/db/enums";
import { requireStaffApplication, staffApplicationScope } from "~/server/staff-access";

const PAGE_SIZE = 20;
const MS_DAY = 86_400_000;
// application.status: 0–8 happy path (active), 20+ terminal (closed).
const IN_PROGRESS = [0, 1, 2, 3];
const OFFERS = [4, 5];
const DEPOSITS = [6, 7];
const ENROLLED = [8];

export const applicationsRouter = createTRPCRouter({
  // Dropdown options: partners that have applications + the stage labels.
  filters: protectedAdminProcedure.query(async ({ ctx }) => {
    const orgs = await db.organization.findMany({
      where: { application: { some: await staffApplicationScope(ctx.cpUser) } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return {
      partners: orgs.map((o) => ({ id: o.id, name: o.name })),
      statuses: Object.entries(UniApplicationStatusLabel).map(([code, label]) => ({ code: Number(code), label })),
    };
  }),

  list: protectedAdminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        status: z.number().int().optional(),
        orgId: z.number().int().optional(),
        search: z.string().optional(),
        scope: z.enum(["active", "closed", "all"]).default("active"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const search = input.search?.trim();
      // Counsellors see only their students' applications (staff-access.ts).
      const scope = await staffApplicationScope(ctx.cpUser);
      const where = {
        AND: [scope],
        ...(input.status != null
          ? { status: input.status }
          : input.scope === "active"
            ? { status: { lt: 20 } }
            : input.scope === "closed"
              ? { status: { gte: 20 } }
              : {}),
        ...(input.orgId ? { org_id: input.orgId } : {}),
        ...(search ? { student: { OR: [{ first_name: { contains: search } }, { last_name: { contains: search } }] } } : {}),
      };

      const [total, rows, byStatus] = await Promise.all([
        db.application.count({ where }),
        db.application.findMany({
          where,
          orderBy: { created_at: "desc" },
          skip: (input.page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          select: {
            id: true,
            status: true,
            created_at: true,
            university_app_id: true,
            student: { select: { id: true, first_name: true, last_name: true, country: true, cp_counsellor_id: true } },
            course: { select: { name: true, intake_month: true, intake_year: true, university: { select: { name: true, country: true } } } },
            organization: { select: { name: true } },
          },
        }),
        db.application.groupBy({ by: ["status"], where: scope, _count: { id: true } }),
      ]);

      const cpIds = Array.from(new Set(rows.map((r) => r.student.cp_counsellor_id).filter((x): x is number => x != null)));
      const cps = cpIds.length
        ? await db.collegepond_user.findMany({ where: { id: { in: cpIds } }, select: { id: true, first_name: true, last_name: true } })
        : [];
      const cpMap = new Map(cps.map((c) => [c.id, `${c.first_name} ${c.last_name}`.trim()]));

      const countByStatus = new Map(byStatus.map((g) => [g.status, g._count.id]));
      const sumOf = (codes: number[]) => codes.reduce((s, c) => s + (countByStatus.get(c) ?? 0), 0);
      const active = Array.from(countByStatus.entries()).filter(([s]) => s < 20).reduce((s, [, n]) => s + n, 0);

      return {
        page: input.page,
        pageSize: PAGE_SIZE,
        total,
        stats: {
          active,
          inProgress: sumOf(IN_PROGRESS),
          offers: sumOf(OFFERS),
          deposits: sumOf(DEPOSITS),
          enrolled: sumOf(ENROLLED),
        },
        rows: rows.map((r) => ({
          id: r.id,
          studentId: r.student.id,
          student: `${r.student.first_name} ${r.student.last_name}`.trim(),
          partner: r.organization.name,
          university: r.course.university.name,
          program: r.course.name,
          status: r.status,
          stage: UniApplicationStatusLabel[r.status as keyof typeof UniApplicationStatusLabel] ?? `Stage ${r.status}`,
          intake: [r.course.intake_month, r.course.intake_year].filter(Boolean).join(" ") || "—",
          country: r.course.university.country ?? r.student.country ?? null,
          processor: r.student.cp_counsellor_id != null ? (cpMap.get(r.student.cp_counsellor_id) ?? null) : null,
          days: Math.floor((Date.now() - r.created_at.getTime()) / MS_DAY),
          appRef: r.university_app_id,
        })),
      };
    }),

  // Quick-look drawer payload for one application (peek without leaving the
  // filtered list; the "Open full profile" link goes to the full page).
  detail: protectedAdminProcedure
    .input(z.object({ applicationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireStaffApplication(ctx.cpUser, input.applicationId);
      const a = await db.application.findUnique({
        where: { id: input.applicationId },
        select: {
          id: true,
          status: true,
          university_app_id: true,
          created_at: true,
          student: {
            select: {
              id: true, first_name: true, last_name: true,
              email: true, phone: true, country: true, cp_counsellor_id: true,
            },
          },
          course: {
            select: {
              name: true, intake_month: true, intake_year: true,
              university: { select: { name: true, country: true } },
            },
          },
          stage_history: { select: { stage: true, occurred_at: true } },
        },
      });
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

      const [docs, cp] = await Promise.all([
        db.document.findMany({
          where: { student_id: a.student.id },
          select: { id: true, doc_type: true, file_name: true, status: true },
          orderBy: { id: "asc" },
        }),
        a.student.cp_counsellor_id != null
          ? db.collegepond_user.findUnique({
              where: { id: a.student.cp_counsellor_id },
              select: { first_name: true, last_name: true },
            })
          : Promise.resolve(null),
      ]);

      return {
        applicationId: a.id,
        studentId: a.student.id,
        studentName: `${a.student.first_name} ${a.student.last_name}`.trim(),
        email: a.student.email,
        phone: a.student.phone,
        country: a.student.country ?? a.course.university.country ?? null,
        university: a.course.university.name,
        program: a.course.name,
        intake: [a.course.intake_month, a.course.intake_year].filter(Boolean).join(" ") || "—",
        status: a.status,
        universityAppId: a.university_app_id,
        processor: cp ? `${cp.first_name} ${cp.last_name}`.trim() : null,
        timeline: [...a.stage_history]
          .sort((x, y) => x.stage - y.stage)
          .map((h) => ({
            stage: h.stage,
            label: UniApplicationStatusLabel[h.stage as keyof typeof UniApplicationStatusLabel] ?? `Stage ${h.stage}`,
            at: h.occurred_at,
          })),
        documents: docs.map((d) => ({ id: d.id, name: d.file_name, type: d.doc_type, status: d.status })),
      };
    }),
});
