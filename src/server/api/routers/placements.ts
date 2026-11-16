import { adminSectionProcedure, createTRPCRouter } from "~/server/api/trpc";
import { UniApplicationStatus } from "~/server/db/enums";
import { staffApplicationScope } from "~/server/staff-access";
import { intakeLabel } from "~/server/application-deferral";

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
  list: adminSectionProcedure("placements").query(async ({ ctx }) => {
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
        deferred_at: true,
        deferred_intake_month: true,
        deferred_intake_year: true,
        student: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
          },
        },
        course: {
          select: {
            name: true,
            intake_month: true,
            intake_year: true,
            university: { select: { id: true, name: true, country: true } },
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
      // A deferred application starts at its new intake, not the course's.
      const intake =
        a.deferred_at && a.deferred_intake_month && a.deferred_intake_year
          ? intakeLabel(a.deferred_intake_month, a.deferred_intake_year)
          : intakeParts.length > 0
            ? intakeParts.join(" ")
            : null;
      return {
        id: a.id,
        studentId: a.student.id,
        studentName: `${a.student.first_name} ${a.student.last_name}`.trim(),
        email: a.student.email,
        // Destination: the university's country (ISO2).
        country: a.course.university.country,
        university: a.course.university.name,
        program: a.course.name,
        intake,
        vendor: a.counsellor_vendor,
        enrollmentId: a.university_app_id,
        visaDate: a.stage_history[0]?.occurred_at ?? null,
        enrolled: a.status === UniApplicationStatus.ENROLLED,
      };
    });
  }),
});
