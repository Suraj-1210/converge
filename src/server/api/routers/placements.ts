import { createTRPCRouter, protectedAdminProcedure } from "~/server/api/trpc";
import { UniApplicationStatus } from "~/server/db/enums";
import { staffApplicationScope } from "~/server/staff-access";

// ---------------------------------------------------------------------------
// Student Placements — applications that have reached Visa Secured. Ops
// confirms the student actually enrolled (status VISA_SECURED → ENROLLED) and
// captures the university enrollment ID. Status changes and the enrollment-ID
// save reuse studentsRouter.setApplicationStatus / setApplicationUniId.
// ---------------------------------------------------------------------------

const PLACEMENT_STATUSES = [
  UniApplicationStatus.VISA_SECURED,
  UniApplicationStatus.ENROLLED,
];

export const placementsRouter = createTRPCRouter({
  list: protectedAdminProcedure.query(async ({ ctx }) => {
    const apps = await ctx.db.application.findMany({
      where: {
        AND: [await staffApplicationScope(ctx.cpUser)],
        status: { in: PLACEMENT_STATUSES },
      },
      orderBy: [{ status: "asc" }, { updated_at: "desc" }],
      select: {
        id: true,
        status: true,
        university_app_id: true,
        counsellor_vendor: true,
        student: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            country: true,
          },
        },
        course: {
          select: {
            name: true,
            intake_month: true,
            intake_year: true,
            university: { select: { id: true, name: true } },
          },
        },
        // The date the visa was secured (placement queue entry time).
        stage_history: {
          where: { stage: UniApplicationStatus.VISA_SECURED },
          select: { occurred_at: true },
          take: 1,
        },
      },
    });

    return apps.map((a) => {
      const intakeParts = [a.course.intake_month, a.course.intake_year].filter(
        Boolean,
      );
      return {
        id: a.id,
        studentId: a.student.id,
        studentName: `${a.student.first_name} ${a.student.last_name}`.trim(),
        email: a.student.email,
        country: a.student.country,
        university: a.course.university.name,
        program: a.course.name,
        intake: intakeParts.length > 0 ? intakeParts.join(" ") : null,
        vendor: a.counsellor_vendor,
        enrollmentId: a.university_app_id,
        visaDate: a.stage_history[0]?.occurred_at ?? null,
        enrolled: a.status === UniApplicationStatus.ENROLLED,
      };
    });
  }),
});
