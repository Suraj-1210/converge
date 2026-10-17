import { LEAD_PIPELINE_STEPS } from "~/lib/student-pipeline";
import { StudentOverallStatus, UniApplicationStatusLabel } from "~/server/db/enums";
import { furthestStage, stageAtLeast } from "~/lib/application-stages";
import { UniApplicationStatus } from "~/server/db/enums";

// The partner's per-student lead pipeline (17 Oct 2026): Student Added →
// University Shortlisted → Application Initiated → Documents Pending →
// Application Started. Past Application Started, each application's own
// stage track takes over; the furthest stage is named beside the last step.
// An Inactive student (manual, or every application closed) gets an
// "Inactive / Closed" badge.

export interface LeadPipelineStudent {
  leadStep: number;
  overallStatus: StudentOverallStatus;
  applications: { status: number; stage: number }[];
}

function furthestBeyondStart(s: LeadPipelineStudent): string | null {
  const f = furthestStage(s.applications.map((a) => a.stage));
  if (f === null || !stageAtLeast(f, UniApplicationStatus.APPLICATION_UNDER_REVIEW)) return null;
  return UniApplicationStatusLabel[f];
}

export function LeadPipelineBar({ student: s }: { student: LeadPipelineStudent }) {
  const inactive = s.overallStatus === StudentOverallStatus.INACTIVE;
  const beyond = furthestBeyondStart(s);
  return (
    <div className="mb-6 rounded-[14px] border border-[#E4E7EC] bg-white px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-[#101828]">Student pipeline</span>
        {inactive && (
          <span className="rounded-2xl bg-[#F2F4F7] px-2.5 py-0.5 text-[11px] font-semibold text-[#475467]">
            Inactive / Closed
          </span>
        )}
        {beyond && !inactive && (
          <span className="rounded-2xl bg-[#EFF8FF] px-2.5 py-0.5 text-[11px] font-semibold text-[#175CD3]">
            Furthest application: {beyond}
          </span>
        )}
      </div>
      <ol className="flex items-start" aria-label="Student pipeline">
        {LEAD_PIPELINE_STEPS.map((label, i) => {
          const done = i < s.leadStep;
          const current = i === s.leadStep;
          const reached = done || current;
          const tone = inactive
            ? reached
              ? "border-[#98A2B3] bg-[#98A2B3]"
              : "border-[#D0D5DD] bg-white"
            : done
              ? "border-[#12B76A] bg-[#12B76A]"
              : current
                ? "border-[#1570EF] bg-[#1570EF] shadow-[0_0_0_4px_rgba(21,112,239,0.18)]"
                : "border-[#D0D5DD] bg-white";
          return (
            <li key={label} className="flex min-w-0 flex-1 items-start">
              {i > 0 && (
                <div
                  className={`mt-[11px] h-0.5 min-w-2 flex-1 ${
                    reached ? (inactive ? "bg-[#D0D5DD]" : "bg-[#12B76A]") : "bg-[#E4E7EC]"
                  }`}
                />
              )}
              <div className="flex w-[84px] shrink-0 flex-col items-center gap-1.5 text-center">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${tone}`}>
                  {reached && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3} className="h-3 w-3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span
                  className={`text-[11px] leading-tight ${
                    current && !inactive
                      ? "font-semibold text-[#1570EF]"
                      : done
                        ? "font-medium text-[#344054]"
                        : "text-[#98A2B3]"
                  }`}
                >
                  {label}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// One-line form for the Students list.
export function LeadPipelineCompact({ student: s }: { student: LeadPipelineStudent }) {
  const inactive = s.overallStatus === StudentOverallStatus.INACTIVE;
  const label = LEAD_PIPELINE_STEPS[s.leadStep] ?? LEAD_PIPELINE_STEPS[0];
  return (
    <div className="min-w-[140px]" title={`${label} (step ${s.leadStep + 1} of ${LEAD_PIPELINE_STEPS.length})`}>
      <div className="flex gap-0.5" aria-hidden>
        {LEAD_PIPELINE_STEPS.map((step, i) => (
          <span
            key={step}
            className={`h-1.5 flex-1 rounded-full ${
              i <= s.leadStep ? (inactive ? "bg-[#98A2B3]" : "bg-[#1570EF]") : "bg-[#EAECF0]"
            }`}
          />
        ))}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px]">
        <span className={inactive ? "text-[#667085]" : "font-medium text-[#344054]"}>{label}</span>
        {inactive && (
          <span className="rounded-full bg-[#F2F4F7] px-1.5 text-[10px] font-semibold text-[#475467]">
            Inactive / Closed
          </span>
        )}
      </div>
    </div>
  );
}
