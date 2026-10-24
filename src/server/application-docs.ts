import "server-only";
import { db } from "~/server/db";
import { appUrl, applicationStatusEmail } from "~/server/email";
import { emailPartners, studentPartnerRecipients } from "~/server/email/partners";
import { createNotifications } from "~/server/notify";
import { responderFor } from "~/server/out-of-office";
import { createStaffNotifications } from "~/server/staff-notify";

// Notifications for the documents a partner uploads for one application
// after Deposit Paid (src/lib/application-uploads.ts). The partner-change
// digest email (student-changes.ts) still goes out too; these are the
// in-app items. Fire-and-forget: the upload or review is already saved.

async function context(applicationId: number) {
  return db.application.findUnique({
    where: { id: applicationId },
    select: {
      student_id: true,
      student: { select: { first_name: true, last_name: true, cp_counsellor_id: true } },
      course: { select: { name: true, university: { select: { name: true } } } },
    },
  });
}

// The student's Collegepond counsellor (or whoever covers while they're out
// of office) gets an in-app item to verify the upload.
export async function notifyApplicationUpload(applicationId: number, label: string, fileName: string) {
  try {
    const a = await context(applicationId);
    if (!a?.student.cp_counsellor_id) return;
    const to = await responderFor(a.student.cp_counsellor_id);
    const studentName = `${a.student.first_name} ${a.student.last_name}`.trim();
    await createStaffNotifications([to], {
      type: "application.partner_upload",
      title: `${studentName}: ${label} uploaded, please verify`,
      body: `${a.course.university.name} – ${a.course.name} · ${fileName}`,
      link: `/admin/students/${a.student_id}?tab=application`,
      tone: "orange",
    });
  } catch (e) {
    console.error("[notify] application upload failed:", e instanceof Error ? e.message : e);
  }
}

// A rejected upload goes back to the partner with the reason.
export async function notifyApplicationDocRejected(applicationId: number, label: string, reason: string) {
  try {
    const a = await context(applicationId);
    if (!a) return;
    const recipients = await studentPartnerRecipients(a.student_id);
    const studentName = `${a.student.first_name} ${a.student.last_name}`.trim();
    const path = `/partner/students/${a.student_id}?tab=applications`;
    await createNotifications(
      recipients.map((r) => r.id),
      {
        type: "application.document_rejected",
        title: `${studentName}: ${label} not accepted`,
        body: `${a.course.university.name}: ${reason}`,
        link: path,
        tone: "red",
      },
    );
    await emailPartners(
      recipients,
      (r) =>
        applicationStatusEmail(
          r,
          {
            studentName,
            university: a.course.university.name,
            program: a.course.name,
            status: `${label} not accepted`,
            note: `Collegepond could not accept the ${label.toLowerCase()} you uploaded: ${reason}. Please upload it again.`,
            path,
          },
          appUrl(),
        ),
      "application-document-rejected",
      "app.status",
    );
  } catch (e) {
    console.error("[email] application document rejected failed:", e instanceof Error ? e.message : e);
  }
}
