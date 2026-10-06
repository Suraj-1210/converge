import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "generated/prisma";
import {
  createTRPCRouter,
  protectedAdminProcedure,
  protectedPartnerProcedure,
} from "~/server/api/trpc";
import { AdminRole } from "~/server/db/enums";
import { resolveStorageUrl } from "~/server/storage";

// M6: defensive cap on unbounded list queries until cursor pagination lands.
// Generous (won't bite at test-data scale); documented in the README notes.
const LIST_CAP = 500;

// Two-letter ISO code for the university's country. We accept either an ISO2
// code or a longer name and normalize to ISO2 server-side, but the form is
// expected to send ISO2 directly.
const ISO2 = z.string().min(2).max(2).transform((v) => v.toUpperCase());

// Codes are now required and standardised to a fixed length so admins can
// rely on `<code>.png` for ZIP logo matching without having to remember
// per-uni length quirks.
const UNI_CODE_REGEX = /^[a-zA-Z0-9]{3}$/;

const universityInput = z.object({
  name: z.string().trim().min(1).max(150),
  // Admin-chosen identifier (e.g. "MIT"). UNIQUE, exactly 3 alphanumeric chars.
  // Used to match ZIP logo filenames and to upsert via bulk import.
  code: z
    .string()
    .trim()
    .regex(UNI_CODE_REGEX, "Code must be exactly 3 alphanumeric characters"),
  city: z.string().trim().min(1).max(100),
  country: ISO2,
  // 0 = Public, 1 = Private. Defaults to public.
  type: z.number().int().min(0).max(1).default(0),
  ranking: z.number().int().nonnegative().max(65535).nullable().optional(),
  appSource: z.string().trim().max(50).nullable().optional(),
  website: z.string().trim().max(255).nullable().optional(),
  logoUrl: z.string().trim().max(255).nullable().optional(),
  isOpen: z.boolean().default(true),
});

const courseInput = z.object({
  universityId: z.number().int().positive(),
  name: z.string().trim().min(1).max(150),
  code: z.string().trim().max(50).nullable().optional(),
  degreeLevel: z.number().int().min(0).max(255),
  durationMonths: z.number().int().min(1).max(120),
  tuitionFee: z.number().nonnegative(),
  currency: z.string().trim().length(3),
  isOpen: z.boolean().default(true),
  url: z.string().trim().min(1).max(255),
  toefl: z.number().nonnegative().nullable().optional(),
  toefl2026: z.number().min(1).max(6).multipleOf(0.5).nullable().optional(),
  ielts: z.number().nonnegative().nullable().optional(),
  det: z.number().int().nonnegative().nullable().optional(),
  pte: z.number().nonnegative().nullable().optional(),
  gre: z.number().int().nonnegative().nullable().optional(),
  gmat: z.number().int().nonnegative().nullable().optional(),
  isStem: z.boolean().default(false),
  intakeMonth: z.string().trim().max(50).nullable().optional(),
  intakeYear: z.number().int().min(2000).max(2099).nullable().optional(),
  isCoopAvailable: z.boolean().default(false),
  hasAppFeeWaiver: z.boolean().default(false),
  appFee: z.number().nonnegative().nullable().optional(),
  applicationDeadline: z.string().trim().nullable().optional(),
  hasTuitionDeposit: z.boolean().default(false),
  hasScholarship: z.boolean().default(false),
  scholarshipAmount: z.number().nonnegative().nullable().optional(),
  minEntryRequirements: z.string().trim().max(2000).nullable().optional(),
  minEntryRequirementsScale: z.string().trim().max(20).nullable().optional(),
  hasFasterTat: z.boolean().default(false),
});

// Shape of a saved Uni Assist filter set (mirrors the page's FilterState).
// Validated on write so junk can't land in the JSON column; kept permissive
// on values since the page re-merges over defaults when loading.
const triState = z.object({ yes: z.boolean(), no: z.boolean() });
const templateFilters = z.object({
  query: z.string().max(200),
  intakeMonths: z.array(z.string().max(10)).max(12),
  intakeYear: z.string().max(4),
  degreeLevel: z.string().max(3),
  countries: z.array(z.string().max(2)).max(60),
  duration: z.string().max(3),
  engTest: z.string().max(10),
  engScore: z.string().max(10),
  stem: triState,
  feeWaiver: triState,
  scholarship: triState,
  open: triState,
  tuitionCurrency: z.string().max(3),
  tuitionMin: z.string().max(20),
  tuitionMax: z.string().max(20),
});

function bool(v: boolean): number {
  return v ? 1 : 0;
}

function toUniversityApi(u: {
  id: number;
  name: string;
  code: string | null;
  city: string | null;
  country: string;
  type: number;
  ranking: number | null;
  app_source: string | null;
  website: string | null;
  logo_url: string | null;
  is_open: number;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: u.id,
    name: u.name,
    code: u.code,
    city: u.city,
    country: u.country,
    type: u.type === 1 ? ("private" as const) : ("public" as const),
    ranking: u.ranking,
    appSource: u.app_source,
    website: u.website,
    logoUrl: resolveStorageUrl(u.logo_url),
    isOpen: u.is_open === 1,
    createdAt: u.created_at.toISOString(),
    updatedAt: u.updated_at.toISOString(),
  };
}

function toCourseApi(c: {
  id: number;
  university_id: number;
  name: string;
  code: string | null;
  degree_level: number | null;
  duration_months: number | null;
  tuition_fee: { toNumber: () => number } | null;
  currency: string | null;
  is_open: number;
  url: string | null;
  toefl: { toNumber: () => number } | null;
  toefl_2026: { toNumber: () => number } | null;
  ielts: { toNumber: () => number } | null;
  det: number | null;
  pte: { toNumber: () => number } | null;
  gre: number | null;
  gmat: number | null;
  is_stem: number | null;
  intake_month: string | null;
  intake_year: number | null;
  is_coop_available: number | null;
  has_app_fee_waiver: number | null;
  app_fee: { toNumber: () => number } | null;
  application_deadline: Date | null;
  has_tuition_deposit: number;
  has_scholarship: number;
  scholarship_amount: { toNumber: () => number } | null;
  min_entry_requirements: string | null;
  min_entry_requirements_scale: string | null;
  has_faster_tat: number | null;
  university?: {
    id: number;
    name: string;
    country: string;
    city: string | null;
    logo_url: string | null;
  } | null;
}) {
  return {
    id: c.id,
    universityId: c.university_id,
    name: c.name,
    code: c.code,
    degreeLevel: c.degree_level,
    durationMonths: c.duration_months,
    tuitionFee: c.tuition_fee?.toNumber() ?? null,
    currency: c.currency,
    isOpen: c.is_open === 1,
    url: c.url,
    toefl: c.toefl?.toNumber() ?? null,
    toefl2026: c.toefl_2026?.toNumber() ?? null,
    ielts: c.ielts?.toNumber() ?? null,
    det: c.det,
    pte: c.pte?.toNumber() ?? null,
    gre: c.gre,
    gmat: c.gmat,
    isStem: c.is_stem === 1,
    intakeMonth: c.intake_month,
    intakeYear: c.intake_year,
    isCoopAvailable: c.is_coop_available === 1,
    hasAppFeeWaiver: c.has_app_fee_waiver === 1,
    appFee: c.app_fee?.toNumber() ?? null,
    applicationDeadline: c.application_deadline
      ? c.application_deadline.toISOString().slice(0, 10)
      : null,
    hasTuitionDeposit: c.has_tuition_deposit === 1,
    hasScholarship: c.has_scholarship === 1,
    scholarshipAmount: c.scholarship_amount?.toNumber() ?? null,
    minEntryRequirements: c.min_entry_requirements,
    minEntryRequirementsScale: c.min_entry_requirements_scale,
    hasFasterTat: c.has_faster_tat === 1,
    university: c.university
      ? {
          id: c.university.id,
          name: c.university.name,
          country: c.university.country,
          city: c.university.city,
          logoUrl: resolveStorageUrl(c.university.logo_url),
        }
      : null,
  };
}

export const universitiesRouter = createTRPCRouter({
  // -------------------------------------------------------------------------
  // Universities
  // -------------------------------------------------------------------------
  listUniversities: protectedAdminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.university.findMany({
      orderBy: { name: "asc" },
      take: LIST_CAP,
      include: { _count: { select: { course: true } } },
    });
    return rows.map((u) => ({
      ...toUniversityApi(u),
      courseCount: u._count.course,
    }));
  }),

  createUniversity: protectedAdminProcedure
    .input(universityInput)
    .mutation(async ({ ctx, input }) => {
      const created = await ctx.db.university.create({
        data: {
          name: input.name,
          code: input.code,
          city: input.city,
          country: input.country,
          type: input.type,
          ranking: input.ranking ?? null,
          app_source: input.appSource ?? null,
          website: input.website ?? null,
          logo_url: input.logoUrl ?? null,
          is_open: bool(input.isOpen),
        },
      });
      return toUniversityApi(created);
    }),

  updateUniversity: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }).merge(universityInput))
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.db.university.update({
        where: { id: input.id },
        data: {
          name: input.name,
          code: input.code,
          city: input.city,
          country: input.country,
          type: input.type,
          ranking: input.ranking ?? null,
          app_source: input.appSource ?? null,
          website: input.website ?? null,
          logo_url: input.logoUrl ?? null,
          is_open: bool(input.isOpen),
        },
      });
      return toUniversityApi(updated);
    }),

  // Lightweight status flip used by the Activate / Deactivate buttons.
  setUniversityOpen: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive(), isOpen: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.db.university.update({
        where: { id: input.id },
        data: { is_open: bool(input.isOpen) },
      });
      return toUniversityApi(updated);
    }),

  deleteUniversity: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // Course FK is ON DELETE RESTRICT; the DB will refuse if any course
      // points at this university. Surface that as a clean error.
      const count = await ctx.db.course.count({
        where: { university_id: input.id },
      });
      if (count > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot delete — ${count} program${count === 1 ? "" : "s"} reference this university.`,
        });
      }
      await ctx.db.university.delete({ where: { id: input.id } });
      return { success: true as const };
    }),

  // -------------------------------------------------------------------------
  // Courses (a.k.a. "Programs")
  // -------------------------------------------------------------------------
  listCourses: protectedAdminProcedure
    .input(
      z
        .object({
          universityId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.course.findMany({
        where: input?.universityId
          ? { university_id: input.universityId }
          : undefined,
        orderBy: [{ university_id: "asc" }, { name: "asc" }],
        take: LIST_CAP,
        include: {
          university: {
            select: {
              id: true,
              name: true,
              country: true,
              city: true,
              logo_url: true,
            },
          },
        },
      });
      return rows.map(toCourseApi);
    }),

  createCourse: protectedAdminProcedure
    .input(courseInput)
    .mutation(async ({ ctx, input }) => {
      const uni = await ctx.db.university.findUnique({
        where: { id: input.universityId },
        select: { id: true },
      });
      if (!uni) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "University not found",
        });
      }
      const created = await ctx.db.course.create({
        data: {
          university_id: input.universityId,
          name: input.name,
          code: input.code,
          degree_level: input.degreeLevel,
          duration_months: input.durationMonths,
          tuition_fee: input.tuitionFee,
          currency: input.currency,
          is_open: bool(input.isOpen),
          url: input.url,
          toefl: input.toefl ?? null,
          toefl_2026: input.toefl2026 ?? null,
          ielts: input.ielts ?? null,
          det: input.det ?? null,
          pte: input.pte ?? null,
          gre: input.gre ?? null,
          gmat: input.gmat ?? null,
          is_stem: bool(input.isStem),
          intake_month: input.intakeMonth ?? null,
          intake_year: input.intakeYear ?? null,
          is_coop_available: bool(input.isCoopAvailable),
          has_app_fee_waiver: bool(input.hasAppFeeWaiver),
          app_fee: input.appFee ?? null,
          application_deadline: input.applicationDeadline ? new Date(input.applicationDeadline) : null,
          has_tuition_deposit: bool(input.hasTuitionDeposit),
          has_scholarship: bool(input.hasScholarship),
          scholarship_amount: input.scholarshipAmount ?? null,
          min_entry_requirements: input.minEntryRequirements ?? null,
          min_entry_requirements_scale: input.minEntryRequirementsScale ?? null,
          has_faster_tat: bool(input.hasFasterTat),
        },
        include: {
          university: {
            select: {
              id: true,
              name: true,
              country: true,
              city: true,
              logo_url: true,
            },
          },
        },
      });
      return toCourseApi(created);
    }),

  // Edit an existing program. Same fields as create (university is fixed).
  updateCourse: protectedAdminProcedure
    .input(courseInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.course.findUnique({
        where: { id: input.id },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Program not found" });
      }
      const updated = await ctx.db.course.update({
        where: { id: input.id },
        data: {
          name: input.name,
          code: input.code,
          degree_level: input.degreeLevel,
          duration_months: input.durationMonths,
          tuition_fee: input.tuitionFee,
          currency: input.currency,
          is_open: bool(input.isOpen),
          url: input.url,
          toefl: input.toefl ?? null,
          toefl_2026: input.toefl2026 ?? null,
          ielts: input.ielts ?? null,
          det: input.det ?? null,
          pte: input.pte ?? null,
          gre: input.gre ?? null,
          gmat: input.gmat ?? null,
          is_stem: bool(input.isStem),
          intake_month: input.intakeMonth ?? null,
          intake_year: input.intakeYear ?? null,
          is_coop_available: bool(input.isCoopAvailable),
          has_app_fee_waiver: bool(input.hasAppFeeWaiver),
          app_fee: input.appFee ?? null,
          application_deadline: input.applicationDeadline ? new Date(input.applicationDeadline) : null,
          has_tuition_deposit: bool(input.hasTuitionDeposit),
          has_scholarship: bool(input.hasScholarship),
          scholarship_amount: input.scholarshipAmount ?? null,
          min_entry_requirements: input.minEntryRequirements ?? null,
          min_entry_requirements_scale: input.minEntryRequirementsScale ?? null,
          has_faster_tat: bool(input.hasFasterTat),
        },
        include: {
          university: {
            select: { id: true, name: true, country: true, city: true, logo_url: true },
          },
        },
      });
      return toCourseApi(updated);
    }),

  // -------------------------------------------------------------------------
  // Partner-facing search (powers /partner/uni-assist)
  // -------------------------------------------------------------------------
  searchPrograms: protectedPartnerProcedure
    .input(
      z
        .object({
          query: z.string().trim().max(200).optional(),
          country: z.string().trim().length(2).optional(),
          intakeYear: z.number().int().min(2000).max(2099).optional(),
          // Three-letter month abbreviation, e.g. "Sep". We LIKE-match against
          // the comma-separated intake_month string.
          intakeMonth: z.string().trim().max(20).optional(),
          degreeLevel: z.number().int().min(0).max(255).optional(),
          // Sort key. "relevance" is the default order (university then name).
          sortBy: z
            .enum(["relevance", "tuition-asc", "tuition-desc", "uni-az"])
            .default("relevance"),
        })
        .default({ sortBy: "relevance" }),
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {};
      if (input.query) {
        // Match either the program name or the parent university's name.
        where.OR = [
          { name: { contains: input.query } },
          { university: { name: { contains: input.query } } },
        ];
      }
      if (input.country) {
        where.university = { country: input.country.toUpperCase() };
      }
      if (input.intakeYear) where.intake_year = input.intakeYear;
      if (input.intakeMonth) {
        where.intake_month = { contains: input.intakeMonth };
      }
      if (input.degreeLevel !== undefined) where.degree_level = input.degreeLevel;

      const orderBy =
        input.sortBy === "tuition-asc"
          ? [{ tuition_fee: "asc" as const }, { name: "asc" as const }]
          : input.sortBy === "tuition-desc"
            ? [{ tuition_fee: "desc" as const }, { name: "asc" as const }]
            : input.sortBy === "uni-az"
              ? [
                  { university: { name: "asc" as const } },
                  { name: "asc" as const },
                ]
              : [
                  { university: { name: "asc" as const } },
                  { name: "asc" as const },
                ];

      const rows = await ctx.db.course.findMany({
        where,
        orderBy,
        take: LIST_CAP,
        include: {
          university: {
            select: {
              id: true,
              name: true,
              country: true,
              city: true,
              logo_url: true,
            },
          },
        },
      });
      return rows.map(toCourseApi);
    }),

  // List of distinct ISO2 countries that currently have universities — used
  // to populate the partner-side Country filter without a separate endpoint.
  listSearchFilters: protectedPartnerProcedure.query(async ({ ctx }) => {
    const unis = await ctx.db.university.findMany({
      select: { country: true },
      distinct: ["country"],
      orderBy: { country: "asc" },
    });
    const years = await ctx.db.course.findMany({
      where: { intake_year: { not: null } },
      select: { intake_year: true },
      distinct: ["intake_year"],
      orderBy: { intake_year: "asc" },
    });
    return {
      countries: unis.map((u) => u.country),
      years: years.map((y) => y.intake_year).filter((y): y is number => y !== null),
    };
  }),

  deleteCourse: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // Restrict if applications point at this course.
      const count = await ctx.db.application.count({
        where: { course_id: input.id },
      });
      if (count > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot delete — ${count} application${count === 1 ? "" : "s"} reference this program.`,
        });
      }
      await ctx.db.course.delete({ where: { id: input.id } });
      return { success: true as const };
    }),

  // -------------------------------------------------------------------------
  // Uni Assist saved search templates (team-wide)
  // -------------------------------------------------------------------------
  listSearchTemplates: protectedAdminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.uni_assist_template.findMany({
      orderBy: { created_at: "desc" },
      include: {
        collegepond_user: { select: { first_name: true, last_name: true } },
      },
    });
    const isSuperAdmin = ctx.cpUser.role === AdminRole.SUPER_ADMIN;
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      filters: t.filters,
      createdBy:
        `${t.collegepond_user.first_name} ${t.collegepond_user.last_name}`.trim(),
      createdAt: t.created_at.toISOString(),
      canDelete: isSuperAdmin || t.collegepond_user_id === ctx.cpUser.id,
    }));
  }),

  createSearchTemplate: protectedAdminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        filters: templateFilters,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await ctx.db.uni_assist_template.create({
        data: {
          name: input.name,
          filters: input.filters as Prisma.InputJsonValue,
          collegepond_user_id: ctx.cpUser.id,
        },
      });
      return { id: created.id };
    }),

  deleteSearchTemplate: protectedAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.uni_assist_template.findUnique({
        where: { id: input.id },
        select: { collegepond_user_id: true },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      }
      const isSuperAdmin = ctx.cpUser.role === AdminRole.SUPER_ADMIN;
      if (!isSuperAdmin && row.collegepond_user_id !== ctx.cpUser.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the template's creator or a super admin can delete it",
        });
      }
      await ctx.db.uni_assist_template.delete({ where: { id: input.id } });
      return { success: true as const };
    }),
});
