// Student-level views over the application pipeline, shared by the server
// (which computes them into the student DTOs) and the portals. Agreed with
// Suraj on 17 Oct 2026; the three views read the same data, so they can't
// contradict each other:
//   - each application's stage track (application.status, by stageIndex);
//   - the overall student status (Active / Inactive / Not Processed);
//   - the partner's 5-step lead pipeline, which ends where the application
//     tracks take over.

import {
  EXPECTED_STUDENT_DOC_TYPES,
  StudentOverallStatus,
  StudentStatus,
  UniApplicationStatus,
  studentDocSlot,
  studentStatusGroup,
  StudentStatusGroup,
} from "~/server/db/enums";
import {
  isClosedStage,
  stageAtLeast,
  stageIndex,
  furthestStage,
} from "~/lib/application-stages";

export interface PipelineApp {
  status: number;
  // currentStage(): the happy-path position, also for a closed application.
  stage: number;
}

// The standard checklist (EXPECTED_STUDENT_DOC_TYPES) is complete when each
// expected slot has at least one upload.
export function checklistComplete(docTypes: string[]): boolean {
  const have = new Set(docTypes.map(studentDocSlot));
  return EXPECTED_STUDENT_DOC_TYPES.every((d) => have.has(d.key));
}

// Overall student status. In order:
//   1. a manual Inactive (set by a Collegepond counsellor) wins;
//   2. Inactive when the student has applications and every one is closed;
//   3. Not Processed – Documents Pending when an open application is at
//      Documents Pending, or nothing has been submitted yet and the standard
//      checklist is incomplete;
//   4. otherwise Active (Enrolled students stay Active).
export function overallStudentStatus(s: {
  inactiveAt: string | Date | null;
  apps: PipelineApp[];
  docTypes: string[];
}): StudentOverallStatus {
  if (s.inactiveAt) return StudentOverallStatus.INACTIVE;
  if (s.apps.length > 0 && s.apps.every((a) => isClosedStage(a.status))) {
    return StudentOverallStatus.INACTIVE;
  }
  if (s.apps.some((a) => a.status === UniApplicationStatus.DOCUMENTS_PENDING)) {
    return StudentOverallStatus.DOCS_PENDING;
  }
  const submitted = s.apps.some((a) => stageAtLeast(a.stage, UniApplicationStatus.APPLICATION_SUBMITTED));
  if (!submitted && !checklistComplete(s.docTypes)) return StudentOverallStatus.DOCS_PENDING;
  return StudentOverallStatus.ACTIVE;
}

export const LEAD_PIPELINE_STEPS = [
  "Student Added",
  "University Shortlisted",
  "Application Initiated",
  "Documents Pending",
  "Application Started",
] as const;

// Position (0–4) on the partner's lead pipeline. With applications, from the
// furthest stage any of them reached (the same application the student's
// status mirrors); without, from the student status and shortlist.
//   Begin Application → Application Initiated, Documents Pending →
//   Documents Pending, Application Submitted or beyond → Application Started.
export function leadPipelineStep(s: {
  status: number;
  hasShortlist: boolean;
  apps: PipelineApp[];
}): number {
  if (s.apps.length > 0) {
    const furthest = furthestStage(s.apps.map((a) => a.stage)) ?? UniApplicationStatus.BEGIN_APPLICATION;
    if (stageAtLeast(furthest, UniApplicationStatus.APPLICATION_SUBMITTED)) return 4;
    if (stageIndex(furthest) === stageIndex(UniApplicationStatus.DOCUMENTS_PENDING)) return 3;
    return 2;
  }
  if (studentStatusGroup(s.status) >= StudentStatusGroup.PRE_APPLICATION) {
    if (s.status === StudentStatus.BEGIN_APPLICATION) return 2;
    if (s.status === StudentStatus.DOCUMENT_PENDING) return 3;
    return 4;
  }
  if (s.status === StudentStatus.SHORTLISTED || s.hasShortlist) return 1;
  return 0;
}
