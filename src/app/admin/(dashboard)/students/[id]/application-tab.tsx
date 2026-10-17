"use client";

import Link from "next/link";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { UniLogo } from "~/components/ui/uni-logo";
import {
  UniApplicationStatus,
  UniApplicationStatusLabel,
} from "~/server/db/enums";
import { api } from "~/trpc/react";
import { applicationSummary, splitByClosed } from "~/lib/application-summary";
import {
  COUNTRY_NAME,
  formatDuration,
  formatIntake,
  formatTuition,
} from "../../uni-assist/uni-assist-lib";
import {
  uniAppBadge,
  type AdminStudentFull,
  type ApplicationCard,
  type ShortlistCard,
} from "../lib";
import { LeadPipeline } from "./lead-pipeline";
import {
  APPLICATION_STAGE_ORDER,
  NEGATIVE_CLOSED_STAGES,
  isClosedStage,
  previousStage,
  stageAtLeast,
  stageIndex,
} from "~/lib/application-stages";
import {
  PartnerReportPanel,
  PendingDocsModal,
  PendingDocsPanel,
  type PendingDocPick,
} from "./pipeline-panels";

// ---------------------------------------------------------------------------
// Pipeline config (mirrors the mock's APP_STAGES / STAGE_ALTERNATIVES)
// ---------------------------------------------------------------------------

// Happy-path stages, in pipeline order (codes are not in order: Visa Filed
// is 9, between Deposit Paid 6 and Visa Secured 7).
const PIPELINE_STAGES = APPLICATION_STAGE_ORDER;

interface StageOption {
  label: string;
  kind: "current" | "advance" | "revert" | "terminal";
  // advance/revert: target stage code; terminal: status code (>= 20).
  to?: number;
  negative?: boolean;
}

const STAGE_OPTIONS: Record<number, StageOption[]> = {
  0: [
    { label: "Begin Application", kind: "current" },
    { label: "Advance to Documents Pending", kind: "advance", to: 1 },
  ],
  1: [
    { label: "Documents Pending", kind: "current" },
    { label: "Advance to Application Submitted", kind: "advance", to: 2 },
    { label: "Revert to Begin Application", kind: "revert", to: 0 },
  ],
  2: [
    { label: "Advance to Application Under Review", kind: "advance", to: 3 },
    { label: "Application Submitted", kind: "current" },
    { label: "Revert to Documents Pending", kind: "revert", to: 1 },
  ],
  3: [
    { label: "Application Under Review", kind: "current" },
    { label: "Conditional Offer", kind: "advance", to: 4 },
    { label: "Unconditional Offer", kind: "advance", to: 5 },
    {
      label: "Rejected by University",
      kind: "terminal",
      to: UniApplicationStatus.REJECTED_BY_UNIVERSITY,
      negative: true,
    },
  ],
  4: [
    { label: "Conditional Offer", kind: "current" },
    { label: "Advance to Unconditional Offer", kind: "advance", to: 5 },
    {
      label: "Rejected by University",
      kind: "terminal",
      to: UniApplicationStatus.REJECTED_BY_UNIVERSITY,
      negative: true,
    },
  ],
  5: [
    { label: "Unconditional Offer", kind: "current" },
    { label: "Advance to Deposit Paid", kind: "advance", to: 6 },
    {
      label: "Rejected by University",
      kind: "terminal",
      to: UniApplicationStatus.REJECTED_BY_UNIVERSITY,
      negative: true,
    },
  ],
  6: [
    { label: "Deposit Paid", kind: "current" },
    { label: "Advance to Visa Filed", kind: "advance", to: UniApplicationStatus.VISA_FILED },
    {
      label: "Application Withdrawn",
      kind: "terminal",
      to: UniApplicationStatus.APPLICATION_WITHDRAWAL,
      negative: true,
    },
    {
      label: "Declined by Student",
      kind: "terminal",
      to: UniApplicationStatus.DECLINED_BY_STUDENT,
      negative: true,
    },
  ],
  // Visa Filed: the next step is the visa outcome (17 Oct 2026).
  [UniApplicationStatus.VISA_FILED]: [
    { label: "Visa Filed", kind: "current" },
    { label: "Visa Approved → Visa Secured", kind: "advance", to: UniApplicationStatus.VISA_SECURED },
    {
      label: "Visa Rejected",
      kind: "terminal",
      to: UniApplicationStatus.VISA_REJECTED,
      negative: true,
    },
    {
      label: "Deferred to Next Intake",
      kind: "terminal",
      to: UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE,
    },
    {
      label: "Case Closed",
      kind: "terminal",
      to: UniApplicationStatus.COURSE_CLOSED,
    },
  ],
  7: [
    { label: "Visa Secured", kind: "current" },
    { label: "Advance to Enrolled", kind: "advance", to: 8 },
    {
      label: "Deferred to Next Intake",
      kind: "terminal",
      to: UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE,
    },
    {
      label: "Case Closed",
      kind: "terminal",
      to: UniApplicationStatus.COURSE_CLOSED,
    },
    { label: "Revert to Visa Filed", kind: "revert", to: UniApplicationStatus.VISA_FILED },
  ],
  8: [
    { label: "Enrolled", kind: "current" },
    { label: "Revert to Visa Secured", kind: "revert", to: 7 },
  ],
};

// Negative terminals get the red X treatment; deferred/closed stay neutral.
const NEGATIVE_TERMINALS = new Set<number>(NEGATIVE_CLOSED_STAGES);

// Counsellor Choice options. Static until the commissions module gives
// vendors a table; "Recommended" stays Not Set for the same reason.
const VENDORS: Array<{ name: string; type: "direct" | "third-party" }> = [
  { name: "Direct", type: "direct" },
  { name: "KC Overseas", type: "third-party" },
  { name: "SiUK", type: "third-party" },
  { name: "Kaplan", type: "third-party" },
  { name: "IDP Education", type: "third-party" },
];

const CONDITIONAL_DOC_OPTIONS = [
  "Current Year Transcript",
  "IELTS Score",
  "TOEFL Score",
  "University Degree Certificate",
  "Financial Documents",
];

const DEPOSIT_CURRENCIES = ["USD", "GBP", "AUD", "EUR", "CAD", "INR"];

function stageLabel(status: number): string {
  return (
    (UniApplicationStatusLabel as Record<number, string | undefined>)[status] ??
    `Status ${status}`
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function cardLocation(c: ShortlistCard | ApplicationCard): string {
  const country = COUNTRY_NAME[c.universityCountry] ?? c.universityCountry;
  return c.universityCity ? `${c.universityCity}, ${country}` : country;
}

function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function ApplicationTab({
  student,
  onToast,
}: {
  student: AdminStudentFull;
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const invalidate = () => {
    void utils.students.adminGet.invalidate({ id: student.id });
    void utils.students.adminList.invalidate();
    void utils.students.shortlistsForStudents.invalidate();
  };

  const applyMut = api.students.applyShortlist.useMutation({
    onSuccess: (res, vars) => {
      invalidate();
      const entry = student.shortlists.find(
        (s) => s.courseId === vars.courseId,
      );
      onToast(
        res.created
          ? `Application started for ${entry?.university ?? "course"}`
          : "An application for this course already exists",
      );
    },
    onError: (err) => onToast(err.message),
  });

  const removeShortlistMut = api.students.removeShortlist.useMutation({
    onSuccess: () => {
      invalidate();
      onToast("Removed from shortlist");
    },
    onError: (err) => onToast(err.message),
  });

  const statusCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const a of student.applicationCards) {
      counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    }
    // Pipeline order, closed outcomes last.
    const order = (s: number) => (stageIndex(s) >= 0 ? stageIndex(s) : 100 + s);
    return [...counts.entries()].sort((a, b) => order(a[0]) - order(b[0]));
  }, [student.applicationCards]);

  const shortlistBusy = applyMut.isPending || removeShortlistMut.isPending;
  // Every application stays listed: in progress first, closed below.
  const { open: openApps, closed: closedApps } = splitByClosed(
    student.applicationCards,
  );

  return (
    <>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-lg font-bold text-[#101828]">Applications</h3>
          <span className="text-[13px] text-[#667085]">
            ({student.shortlists.length} shortlisted,{" "}
            {student.applicationCards.length} applied)
          </span>
        </div>
        <Link
          href={`/admin/uni-assist?student=${student.id}`}
          className="flex items-center gap-1.5 rounded-lg border border-[#1570EF] bg-white px-4 py-2 text-[13px] font-semibold text-[#1570EF] hover:bg-[#F0F7FF]"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="h-3.5 w-3.5"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Shortlist via Uni Assist
        </Link>
      </div>

      {/* Lead pipeline (pre-application journey) */}
      <LeadPipeline student={student} onToast={onToast} />

      {/* Shortlisted schools */}
      <div className="mb-6 rounded-[14px] border border-[#E4E7EC] bg-white px-6 py-5">
        <div className="mb-4 flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            fill="#F79009"
            stroke="#F79009"
            strokeWidth={2}
            className="h-4 w-4"
          >
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          <span className="text-sm font-bold text-[#101828]">
            Shortlisted Schools
          </span>
          <span className="rounded-xl bg-[#FFF6ED] px-2 py-0.5 text-xs font-semibold text-[#F79009]">
            {student.shortlists.length}
          </span>
        </div>

        {student.shortlists.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#D0D5DD] px-4 py-8 text-center text-[13px] text-[#98A2B3]">
            No shortlisted schools yet — use Uni Assist to shortlist programs
            for this student.
          </div>
        ) : (
          <div className="space-y-2.5">
            {student.shortlists.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-4 rounded-[10px] border border-[#E4E7EC] px-4 py-3.5"
              >
                <UniLogo
                  name={s.university}
                  logoUrl={s.universityLogoUrl}
                  size={44}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[#101828]">
                    {s.university}
                  </div>
                  <div className="truncate text-[13px] font-medium text-[#1570EF]">
                    {s.program}
                  </div>
                  <CardMeta card={s} location={cardLocation(s)} />
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={shortlistBusy}
                    onClick={() =>
                      applyMut.mutate({
                        studentId: student.id,
                        courseId: s.courseId,
                      })
                    }
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#12B76A] px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-[#0e9f5c] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      className="h-3.5 w-3.5"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Apply
                  </button>
                  <button
                    type="button"
                    disabled={shortlistBusy}
                    onClick={() =>
                      removeShortlistMut.mutate({
                        studentIds: [student.id],
                        courseId: s.courseId,
                      })
                    }
                    className="cursor-pointer rounded-lg border border-[#E4E7EC] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#667085] hover:border-[#FDA29B] hover:bg-[#FEF3F2] hover:text-[#F04438] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* All applications (closed ones included, listed after the rest) */}
      <div className="mb-3 flex items-center gap-3">
        <span className="text-sm font-bold text-[#101828]">Applications</span>
        {student.applicationCards.length > 0 && (
          <span className="text-[13px] text-[#667085]">
            {applicationSummary(student.applicationCards)}
          </span>
        )}
        <div className="h-px flex-1 bg-[#E4E7EC]" />
      </div>

      {statusCounts.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {statusCounts.map(([status, count]) => {
            const badge = uniAppBadge(status);
            return (
              <span
                key={status}
                className="flex items-center gap-1.5 rounded-2xl bg-[#F2F4F7] px-2.5 py-1 text-xs font-medium text-[#344054]"
              >
                <span
                  className="h-[7px] w-[7px] rounded-full"
                  style={{ background: badge.color }}
                />
                {count} {badge.label}
              </span>
            );
          })}
        </div>
      )}

      {student.applicationCards.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#D0D5DD] bg-white px-6 py-10 text-center">
          <div className="text-sm font-semibold text-[#667085]">
            No Applications Yet
          </div>
          <div className="mt-1 text-xs text-[#98A2B3]">
            Shortlist schools via Uni Assist, then click Apply to start
            tracking.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {openApps.map((a) => (
            <AppCard
              key={a.id}
              app={a}
              onToast={onToast}
              invalidate={invalidate}
            />
          ))}
          {closedApps.length > 0 && (
            <div className="flex items-center gap-3 pt-2">
              <span className="text-xs font-semibold tracking-wider text-[#98A2B3] uppercase">
                Closed ({closedApps.length})
              </span>
              <div className="h-px flex-1 bg-[#E4E7EC]" />
            </div>
          )}
          {closedApps.map((a) => (
            <AppCard
              key={a.id}
              app={a}
              onToast={onToast}
              invalidate={invalidate}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Application card
// ---------------------------------------------------------------------------

function AppCard({
  app: a,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const terminal = isClosedStage(a.status);
  const negative = NEGATIVE_TERMINALS.has(a.status);
  const badge = uniAppBadge(a.status);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Moving to (or editing) Documents Pending asks which documents first.
  const [pickDocs, setPickDocs] = useState(false);

  const statusMut = api.students.setApplicationStatus.useMutation({
    onSuccess: (_res, vars) => {
      invalidate();
      setPickDocs(false);
      onToast(
        vars.status === a.status && vars.pendingDocs
          ? "Pending documents updated — the partner has been told"
          : `Status updated to: ${stageLabel(vars.status)}`,
      );
    },
    onError: (err) => onToast(err.message),
  });
  const removeMut = api.students.removeApplication.useMutation({
    onSuccess: () => {
      invalidate();
      onToast("Application removed");
    },
    onError: (err) => onToast(err.message),
  });

  const setStatus = (status: number) => {
    if (status === a.status) return;
    // Entering Documents Pending names the documents (unless reverting
    // back into it with a list already there).
    if (status === UniApplicationStatus.DOCUMENTS_PENDING && a.pendingDocs.length === 0) {
      setPickDocs(true);
      return;
    }
    statusMut.mutate({ applicationId: a.id, status });
  };
  const submitDocs = (picks: PendingDocPick[]) =>
    statusMut.mutate({
      applicationId: a.id,
      status: UniApplicationStatus.DOCUMENTS_PENDING,
      pendingDocs: picks,
    });

  return (
    <div className="rounded-[14px] border border-[#E4E7EC] bg-white p-6 transition-shadow hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-4">
        <UniLogo name={a.university} logoUrl={a.universityLogoUrl} size={48} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-[#101828]">
            {a.university}
          </div>
          <div className="text-[13px] font-medium text-[#1570EF]">
            {a.program}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[#667085]">
            <span className="flex items-center gap-1">
              <PinIcon />
              {cardLocation(a)}
            </span>
            {a.universityAppSource && (
              <AppSourceBadge source={a.universityAppSource} />
            )}
          </div>
          <CardMeta card={a} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="flex items-center gap-1.5 rounded-2xl px-2.5 py-1 text-xs font-semibold whitespace-nowrap"
            style={{ color: badge.color, background: badge.bg }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: badge.color }}
            />
            {badge.label}
          </span>
          {terminal && (
            <button
              type="button"
              disabled={statusMut.isPending}
              onClick={() => setStatus(a.stage)}
              title={`Revert to ${stageLabel(a.stage)}`}
              className="flex cursor-pointer items-center gap-1 rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-[11px] font-medium text-[#667085] hover:border-[#F79009] hover:bg-[#FFF4ED] hover:text-[#DC6803] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RevertIcon />
              Revert to {stageLabel(a.stage)}
            </button>
          )}
          {confirmRemove ? (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="font-medium text-[#B42318]">Remove?</span>
              <button
                type="button"
                disabled={removeMut.isPending}
                onClick={() => removeMut.mutate({ applicationId: a.id })}
                className="cursor-pointer rounded-md bg-[#F04438] px-2 py-1 font-semibold text-white hover:bg-[#d92d20] disabled:opacity-50"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                className="cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2 py-1 font-semibold text-[#344054] hover:bg-[#F9FAFB]"
              >
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              aria-label="Remove application"
              title="Remove application"
              onClick={() => setConfirmRemove(true)}
              className="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-lg border border-[#E4E7EC] bg-white text-[#98A2B3] hover:border-[#FDA29B] hover:bg-[#FEF3F2] hover:text-[#F04438]"
            >
              <TrashIcon />
            </button>
          )}
        </div>
      </div>

      {/* Vendor row */}
      <VendorRow app={a} onToast={onToast} invalidate={invalidate} />

      {/* Portal credentials — only where a university-portal login exists */}
      {a.universityAppSource === "University Portal" && (
        <PortalCredentials app={a} onToast={onToast} invalidate={invalidate} />
      )}

      {/* Application ID capture (from Application Submitted onwards) */}
      {stageAtLeast(a.stage, UniApplicationStatus.APPLICATION_SUBMITTED) && (
        <AppIdSection app={a} onToast={onToast} invalidate={invalidate} />
      )}

      {/* Pipeline stepper */}
      <Stepper app={a} onSelect={setStatus} busy={statusMut.isPending} />

      {/* A partner's Deposit Paid / visa outcome awaiting confirmation */}
      <PartnerReportPanel app={a} onToast={onToast} invalidate={invalidate} />

      {/* Documents named at Documents Pending, ticked as they arrive */}
      {a.status === UniApplicationStatus.DOCUMENTS_PENDING && (
        <PendingDocsPanel
          app={a}
          onEdit={() => setPickDocs(true)}
          onToast={onToast}
          invalidate={invalidate}
        />
      )}
      {pickDocs && (
        <PendingDocsModal
          open
          initial={a.pendingDocs}
          busy={statusMut.isPending}
          onClose={() => setPickDocs(false)}
          onSubmit={submitDocs}
        />
      )}

      {/* Conditional offer document checklist */}
      {a.stage === UniApplicationStatus.CONDITIONAL_OFFER && !terminal && (
        <ConditionalDocs app={a} onToast={onToast} invalidate={invalidate} />
      )}

      {/* Deposit details (from Unconditional Offer onwards) */}
      {stageAtLeast(a.stage, UniApplicationStatus.UNCONDITIONAL_OFFER) && !negative && (
        <DepositDetails app={a} onToast={onToast} invalidate={invalidate} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline stepper with stage dropdowns
// ---------------------------------------------------------------------------

function Stepper({
  app: a,
  onSelect,
  busy,
}: {
  app: ApplicationCard;
  onSelect: (status: number) => void;
  busy: boolean;
}) {
  // The stepper scrolls horizontally, which would clip an absolutely
  // positioned dropdown — so the dropdown is fixed-positioned from the
  // clicked dot's viewport coordinates instead.
  const [open, setOpen] = useState<{
    stage: number;
    x: number;
    y: number;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(null), open !== null);

  // A fixed dropdown doesn't follow its anchor — close on any scroll.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [open]);

  const toggle = (stage: number, e: React.MouseEvent<HTMLElement>) => {
    if (open?.stage === stage) {
      setOpen(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setOpen({ stage, x: r.left + r.width / 2, y: r.bottom + 6 });
  };

  const terminal = isClosedStage(a.status);
  const negative = NEGATIVE_TERMINALS.has(a.status);

  const pick = (option: StageOption) => {
    setOpen(null);
    if (busy) return;
    if (option.kind === "current") onSelect(a.stage);
    else if (option.kind === "terminal") onSelect(option.to!);
    else onSelect(option.to!);
  };

  return (
    <div ref={ref} className="mt-6 flex items-start overflow-x-auto pb-1">
      {PIPELINE_STAGES.map((stage, i) => {
        const done = stageIndex(stage) < stageIndex(a.stage);
        const active = stage === a.stage;
        const reached = done || active;
        const history = a.stageHistory.find((h) => h.stage === stage);

        // The active stage gets the transition dropdown.
        const options = active ? (STAGE_OPTIONS[stage] ?? []) : [];
        const hasExplicitRevert = options.some((o) => o.kind === "revert");
        const interactive = active && options.length > 1;

        const dotClass = active
          ? negative
            ? "border-[#F04438] bg-[#F04438] shadow-[0_0_0_4px_rgba(240,68,56,0.18)]"
            : terminal
              ? "border-[#667085] bg-[#667085] shadow-[0_0_0_4px_rgba(102,112,133,0.18)]"
              : "border-[#1570EF] bg-[#1570EF] shadow-[0_0_0_4px_rgba(21,112,239,0.18)]"
          : done
            ? "border-[#12B76A] bg-[#12B76A]"
            : "border-[#D0D5DD] bg-white";
        const labelClass = active
          ? negative
            ? "font-semibold text-[#B42318]"
            : terminal
              ? "font-semibold text-[#475467]"
              : "font-semibold text-[#1570EF]"
          : done
            ? "font-semibold text-[#027A48]"
            : "font-medium text-[#98A2B3]";

        return (
          <Fragment key={stage}>
            {i > 0 && (
              <div
                className={`mt-[13px] h-0.5 min-w-3 flex-1 ${
                  reached ? "bg-[#12B76A]" : "bg-[#E4E7EC]"
                }`}
              />
            )}
            <div className="relative flex w-[88px] shrink-0 flex-col items-center gap-1.5">
              <button
                type="button"
                disabled={!interactive}
                onClick={(e) => toggle(stage, e)}
                aria-label={
                  interactive
                    ? `Change status from ${stageLabel(stage)}`
                    : stageLabel(stage)
                }
                className={`flex h-7 w-7 items-center justify-center rounded-full border-2 ${dotClass} ${
                  interactive ? "cursor-pointer" : "cursor-default"
                }`}
              >
                {active && negative ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth={2.5}
                    className="h-3.5 w-3.5"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                ) : reached ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth={3}
                    className="h-3.5 w-3.5"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : null}
              </button>

              <button
                type="button"
                disabled={!interactive}
                onClick={(e) => toggle(stage, e)}
                className={`flex items-start justify-center gap-0.5 text-center text-[10px] leading-[1.3] ${labelClass} ${
                  interactive ? "cursor-pointer" : "cursor-default"
                }`}
              >
                {active && terminal ? badgeLabelFor(a.status) : stageLabel(stage)}
                {interactive && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#98A2B3"
                    strokeWidth={2}
                    className="mt-px h-2.5 w-2.5 shrink-0"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                )}
              </button>
              {history && reached && (
                <div
                  className={`text-center text-[10px] ${
                    active && negative ? "text-[#B42318]" : "text-[#98A2B3]"
                  }`}
                >
                  {formatShortDate(history.date)}
                </div>
              )}

              {/* Dropdown — fixed so the scrollable stepper can't clip it */}
              {open?.stage === stage && interactive && (
                <div
                  className="fixed z-[200] min-w-[225px] -translate-x-1/2 rounded-[10px] border border-[#E4E7EC] bg-white p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.14)]"
                  style={{ left: open.x, top: open.y }}
                >
                  {options.map((o) => {
                    const selected =
                      o.kind === "current"
                        ? !terminal
                        : o.kind === "terminal" && o.to === a.status;
                    return (
                      <DropdownItem
                        key={o.label}
                        selected={selected}
                        negative={o.negative}
                        kind={o.kind}
                        onClick={() => pick(o)}
                      >
                        {o.label}
                      </DropdownItem>
                    );
                  })}
                  {previousStage(stage) !== null && !hasExplicitRevert && (
                    <>
                      <div className="my-1 h-px bg-[#F2F4F7]" />
                      <DropdownItem
                        kind="revert"
                        onClick={() => {
                          setOpen(null);
                          onSelect(previousStage(stage)!);
                        }}
                      >
                        Revert to {stageLabel(previousStage(stage)!)}
                      </DropdownItem>
                    </>
                  )}
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function badgeLabelFor(status: number): string {
  return uniAppBadge(status).label;
}

function DropdownItem({
  children,
  onClick,
  selected = false,
  negative = false,
  kind,
}: {
  children: ReactNode;
  onClick: () => void;
  selected?: boolean;
  negative?: boolean;
  kind: StageOption["kind"];
}) {
  const tone = negative
    ? "text-[#B42318] hover:bg-[#FEF3F2]"
    : kind === "advance"
      ? "text-[#1570EF] hover:bg-[#F0F7FF]"
      : kind === "revert"
        ? "text-[#DC6803] hover:bg-[#FFF4ED]"
        : "text-[#344054] hover:bg-[#F0F7FF] hover:text-[#1570EF]";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] whitespace-nowrap ${tone} ${
        selected ? "bg-[#F0F7FF] font-semibold" : "font-medium"
      }`}
    >
      {kind === "advance" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          className="h-3.5 w-3.5 shrink-0"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      ) : kind === "revert" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          className="h-3.5 w-3.5 shrink-0"
        >
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
      ) : selected ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#1570EF"
          strokeWidth={2.5}
          className="h-3.5 w-3.5 shrink-0"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Vendor row (Recommended / Counsellor Choice)
// ---------------------------------------------------------------------------

function VendorRow({
  app: a,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const vendorMut = api.students.setApplicationVendor.useMutation({
    onSuccess: (_res, vars) => {
      invalidate();
      onToast(
        vars.vendor
          ? `Counsellor vendor saved: ${vars.vendor}`
          : "Counsellor vendor cleared",
      );
    },
    onError: (err) => onToast(err.message),
  });

  return (
    <div className="mt-4 flex flex-wrap items-center gap-4 rounded-[10px] border border-[#E4E7EC] bg-[#F9FAFB] px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
          Recommended
        </span>
        {/* Vendor recommendations come from the commissions module — not
            built yet, so this stays Not Set (mock parity). */}
        <span className="text-[13px] font-medium text-[#98A2B3]">Not Set</span>
      </div>
      <div className="h-5 w-px bg-[#E4E7EC]" />
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
          Counsellor Choice
        </span>
        <select
          value={a.counsellorVendor ?? ""}
          disabled={vendorMut.isPending}
          onChange={(e) =>
            vendorMut.mutate({
              applicationId: a.id,
              vendor: e.target.value || null,
            })
          }
          className={`h-[30px] cursor-pointer rounded-md border bg-white px-2 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
            a.counsellorVendor
              ? "border-[#7F56D9] font-semibold text-[#6941C6]"
              : "border-[#D0D5DD] text-[#344054] hover:border-[#7F56D9]"
          }`}
        >
          <option value="">-- Select Vendor --</option>
          {VENDORS.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name} {v.type === "direct" ? "(Direct)" : "(Third Party)"}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Portal credentials (university application-portal login)
// ---------------------------------------------------------------------------

function PortalCredentials({
  app: a,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState(a.portalCredentialUsername ?? "");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const hasCred = !!a.portalCredentialUsername;

  const saveMut = api.students.savePortalCredential.useMutation({
    onSuccess: () => {
      invalidate();
      onToast("Portal credentials saved");
    },
    onError: (err) => onToast(err.message),
  });
  const revealMut = api.students.revealPortalCredential.useMutation({
    onSuccess: (res) => {
      setUsername(res.username);
      setPassword(res.password);
      setShowPw(true);
    },
    onError: (err) => onToast(err.message),
  });

  const save = () => {
    if (!username.trim() || !password) {
      onToast("Please enter both username and password");
      return;
    }
    saveMut.mutate({ applicationId: a.id, username: username.trim(), password });
  };

  return (
    <div className="mt-3 rounded-[10px] border border-[#E4E7EC]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer flex-wrap items-center gap-2 px-4 py-2.5 text-left"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#667085"
          strokeWidth={2}
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="text-[13px] font-semibold text-[#344054]">
          Portal Credentials
        </span>
        {hasCred ? (
          <span className="text-xs font-medium text-[#027A48]">
            🔑 Credentials saved
          </span>
        ) : (
          <span className="text-xs text-[#98A2B3]">
            — No portal credentials ·{" "}
            <span className="font-semibold text-[#1570EF]">Add Credentials</span>
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-[#F2F4F7] px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="w-[80px] text-xs font-medium text-[#667085]">
              Username
            </label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username or email"
              className="h-[34px] min-w-0 flex-1 rounded-md border border-[#D0D5DD] bg-white px-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="w-[80px] text-xs font-medium text-[#667085]">
              Password
            </label>
            <input
              type={showPw ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                hasCred && !password ? "•••••••• (reveal to view)" : "Password"
              }
              className="h-[34px] min-w-0 flex-1 rounded-md border border-[#D0D5DD] bg-white px-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
            />
            {hasCred && !password ? (
              <button
                type="button"
                disabled={revealMut.isPending}
                onClick={() => revealMut.mutate({ applicationId: a.id })}
                className="cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF] disabled:opacity-50"
              >
                {revealMut.isPending ? "Revealing…" : "Reveal"}
              </button>
            ) : (
              <button
                type="button"
                aria-label={showPw ? "Hide password" : "Show password"}
                onClick={() => setShowPw((v) => !v)}
                className="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-[#D0D5DD] bg-white text-[#667085] hover:border-[#1570EF] hover:text-[#1570EF]"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  className="h-3.5 w-3.5"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-[#98A2B3] italic">
              Encrypted at rest — every save and reveal is audit-logged.
            </span>
            <button
              type="button"
              disabled={saveMut.isPending}
              onClick={save}
              className="cursor-pointer rounded-md bg-[#1570EF] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#1058c7] disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Application ID capture
// ---------------------------------------------------------------------------

function AppIdSection({
  app: a,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(a.universityAppId ?? "");

  const saveMut = api.students.setApplicationUniId.useMutation({
    onSuccess: (_res, vars) => {
      invalidate();
      setEditing(false);
      onToast(`Application ID saved: ${vars.universityAppId}`);
    },
    onError: (err) => onToast(err.message),
  });

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      onToast("Please enter an Application ID");
      return;
    }
    saveMut.mutate({ applicationId: a.id, universityAppId: trimmed });
  };

  const hasId = !!a.universityAppId && !editing;

  return (
    <div
      className={`mt-3 flex flex-wrap items-center gap-3 rounded-[10px] border px-4 py-2.5 ${
        a.universityAppId
          ? "border-[#A6F4C5] bg-[#ECFDF3]"
          : "border-[#FEDF89] bg-[#FFFCF5]"
      }`}
    >
      <span className="text-[11px] font-semibold tracking-wider text-[#667085] uppercase">
        {a.universityAppId ? "App ID" : "Application ID / Student ID"}
      </span>
      {hasId ? (
        <>
          <span className="text-[13px] font-bold text-[#027A48]">
            {a.universityAppId}
          </span>
          <button
            type="button"
            aria-label="Edit Application ID"
            onClick={() => {
              setValue(a.universityAppId ?? "");
              setEditing(true);
            }}
            className="cursor-pointer text-[#98A2B3] hover:text-[#667085]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="h-3 w-3"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        </>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            placeholder="Enter university application or student ID"
            className="h-[32px] min-w-0 flex-1 rounded-md border border-[#D0D5DD] bg-white px-2.5 text-[13px] text-[#344054] outline-none focus:border-[#7F56D9] focus:shadow-[0_0_0_3px_rgba(127,86,217,0.12)]"
          />
          <button
            type="button"
            disabled={saveMut.isPending}
            onClick={save}
            className="cursor-pointer rounded-md bg-[#1570EF] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1058c7] disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conditional offer documents checklist
// ---------------------------------------------------------------------------

function ConditionalDocs({
  app: a,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const saved = a.conditionalDocs;
  const savedOther = saved.find((d) => d.startsWith("Other: "));
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(saved.filter((d) => !d.startsWith("Other: "))),
  );
  const [otherChecked, setOtherChecked] = useState(!!savedOther);
  const [otherText, setOtherText] = useState(savedOther?.slice(7) ?? "");

  const saveMut = api.students.setConditionalDocs.useMutation({
    onSuccess: () => {
      invalidate();
      onToast("Conditional offer documents saved");
    },
    onError: (err) => onToast(err.message),
  });

  const persist = (
    nextChecked: Set<string>,
    nextOther: boolean,
    nextOtherText: string,
  ) => {
    const docs = [...nextChecked];
    if (nextOther && nextOtherText.trim()) {
      docs.push(`Other: ${nextOtherText.trim()}`);
    }
    saveMut.mutate({ applicationId: a.id, docs });
  };

  const toggle = (doc: string) => {
    const next = new Set(checked);
    if (next.has(doc)) next.delete(doc);
    else next.add(doc);
    setChecked(next);
    persist(next, otherChecked, otherText);
  };

  return (
    <div className="mt-4 rounded-[10px] border border-[#FEDF89] bg-[#FFFCF5] px-5 py-4">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#B54708]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        Documents Required for Conditional Offer
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CONDITIONAL_DOC_OPTIONS.map((doc) => (
          <label
            key={doc}
            className="flex cursor-pointer items-center gap-2 text-[13px] text-[#344054]"
          >
            <input
              type="checkbox"
              checked={checked.has(doc)}
              onChange={() => toggle(doc)}
              className="h-4 w-4 cursor-pointer accent-[#1570EF]"
            />
            {doc}
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[#344054]">
          <input
            type="checkbox"
            checked={otherChecked}
            onChange={() => {
              const next = !otherChecked;
              setOtherChecked(next);
              persist(checked, next, otherText);
            }}
            className="h-4 w-4 cursor-pointer accent-[#1570EF]"
          />
          Other:
          <input
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onBlur={() => {
              if (otherChecked) persist(checked, otherChecked, otherText);
            }}
            placeholder="Specify requirement"
            className="h-[28px] min-w-0 flex-1 rounded-md border border-[#D0D5DD] bg-white px-2 text-xs text-[#344054] outline-none focus:border-[#1570EF]"
          />
        </label>
      </div>
      <div className="mt-2.5 text-xs text-[#98A2B3] italic">
        Please upload the required documents in the Documents tab.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deposit details
// ---------------------------------------------------------------------------

function DepositDetails({
  app: a,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const [deadline, setDeadline] = useState(a.depositDeadline ?? "");
  const [currency, setCurrency] = useState(a.depositCurrency ?? "USD");
  const [amount, setAmount] = useState(
    a.depositAmount === null ? "" : String(a.depositAmount),
  );

  const saveMut = api.students.setDepositDetails.useMutation({
    onSuccess: () => {
      invalidate();
      onToast("Deposit details saved");
    },
    onError: (err) => onToast(err.message),
  });

  const persist = (d: string, c: string, amt: string) => {
    const parsed = amt.trim() === "" ? null : Number(amt);
    if (parsed !== null && (Number.isNaN(parsed) || parsed < 0)) return;
    saveMut.mutate({
      applicationId: a.id,
      deadline: d || null,
      currency: d || amt ? c : null,
      amount: parsed,
    });
  };

  const warning = useMemo(() => {
    if (!deadline) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dl = new Date(`${deadline}T00:00:00`);
    const diffDays = Math.round(
      (dl.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (diffDays < 0) {
      return {
        tone: "overdue" as const,
        text: `Overdue by ${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? "" : "s"}`,
      };
    }
    if (diffDays <= 7) {
      return {
        tone: "approaching" as const,
        text: `${diffDays} day${diffDays === 1 ? "" : "s"} remaining`,
      };
    }
    return null;
  }, [deadline]);

  return (
    <div className="mt-4 rounded-[10px] border border-[#E4E7EC] bg-[#F9FAFB] px-5 py-4">
      <div className="mb-3 text-[13px] font-bold text-[#101828]">
        💰 Deposit Details
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <DepositField label="Deposit Deadline">
          <input
            type="date"
            value={deadline}
            onChange={(e) => {
              setDeadline(e.target.value);
              persist(e.target.value, currency, amount);
            }}
            className="h-[34px] cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
          />
        </DepositField>
        <DepositField label="Currency">
          <select
            value={currency}
            onChange={(e) => {
              setCurrency(e.target.value);
              persist(deadline, e.target.value, amount);
            }}
            className="h-[34px] cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
          >
            {DEPOSIT_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </DepositField>
        <DepositField label="Amount">
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => persist(deadline, currency, amount)}
            placeholder="0"
            className="h-[34px] w-[120px] rounded-md border border-[#D0D5DD] bg-white px-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
          />
        </DepositField>
        {warning && (
          <span
            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${
              warning.tone === "overdue"
                ? "bg-[#FEF3F2] text-[#B42318]"
                : "bg-[#FFF6ED] text-[#B54708]"
            }`}
          >
            ⚠️ {warning.text}
          </span>
        )}
      </div>
    </div>
  );
}

function DepositField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
      {label}
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function AppSourceBadge({ source }: { source: string }) {
  const tone =
    source === "University Portal"
      ? { icon: "🌐", cls: "bg-[#EFF8FF] text-[#175CD3]" }
      : source === "Agent Portal"
        ? { icon: "🤝", cls: "bg-[#FFF6ED] text-[#B93815]" }
        : { icon: "📄", cls: "bg-[#F2F4F7] text-[#667085]" };
  return (
    <span
      className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${tone.cls}`}
    >
      {tone.icon} {source}
    </span>
  );
}

// Duration / intake / tuition meta line shared by both card kinds.
function CardMeta({
  card,
  location,
}: {
  card: ShortlistCard | ApplicationCard;
  location?: string;
}) {
  const duration = card.durationMonths
    ? formatDuration(card.durationMonths)
    : null;
  const intake = formatIntake(card.intakeMonth, card.intakeYear);
  const tuition = formatTuition(card.tuitionFee, card.currency);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#667085]">
      {location && (
        <Meta>
          <PinIcon />
          {location}
        </Meta>
      )}
      {duration && (
        <Meta>
          <ClockIcon />
          {duration}
        </Meta>
      )}
      {intake && (
        <Meta>
          <CalendarIcon />
          {intake}
        </Meta>
      )}
      {tuition && (
        <Meta>
          <MoneyIcon />
          {tuition}
        </Meta>
      )}
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="flex items-center gap-1">{children}</span>;
}

const metaIconClass = "h-3 w-3 shrink-0";

function PinIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className={metaIconClass}
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className={metaIconClass}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className={metaIconClass}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function MoneyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className={metaIconClass}
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-4 w-4"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function RevertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-3 w-3"
    >
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}
