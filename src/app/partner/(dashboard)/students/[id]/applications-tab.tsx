"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  UniApplicationStatus,
  UniApplicationStatusLabel,
} from "~/server/db/enums";
import { api } from "~/trpc/react";
import { type AdminStudentFull } from "~/app/admin/(dashboard)/students/lib";
import { appFeeAmount, formatAppFee } from "~/app/admin/(dashboard)/uni-assist/uni-assist-lib";
import {
  ShortlistApprovalNotes,
  ShortlistStatusBadge,
  ShortlistTextDialog,
  shortlistView,
} from "~/components/students/shortlist-approval";
import { applicationSummary, splitByClosed } from "~/lib/application-summary";
import {
  ApplicationUploads,
  DeferralBanner,
  DeferralReportAction,
  PendingDocsChecklist,
  ReportAction,
  ReportStatus,
} from "./pipeline-actions";
import { stageTone } from "~/lib/application-stages";
import { StageTrack } from "~/components/dashboard/stage-track";

type Card = AdminStudentFull["applicationCards"][number];
type Shortlist = AdminStudentFull["shortlists"][number];

const statusLabel = (s: number) =>
  (UniApplicationStatusLabel as Record<number, string | undefined>)[s] ?? "In progress";

function fmtDate(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : null;
}

function money(amount: number | null, currency: string | null) {
  if (amount === null) return null;
  return `${currency ?? ""} ${amount.toLocaleString("en-IN")}`.trim();
}

function intake(c: { intakeMonth: string | null; intakeYear: number | null }) {
  return [c.intakeMonth, c.intakeYear].filter(Boolean).join(" ") || null;
}

// Collegepond runs the applications: portal logins, vendor and status
// controls stay on the admin side. Partners upload the documents named at
// Documents Pending and report Deposit Paid / the visa outcome for
// Collegepond to confirm. `viewerKind` decides whether the commission hint
// shows (owners and independents; commission is hidden from agency
// counsellors).
export function ApplicationsTab({
  student,
  viewerKind,
  onChanged,
  onToast,
  focusAppId,
}: {
  student: AdminStudentFull;
  viewerKind?: "agency" | "counsellor" | "independent";
  onChanged?: () => void;
  onToast?: (msg: string) => void;
  /** From the Applications page: scroll to and highlight this application. */
  focusAppId?: number | null;
}) {
  const changed = onChanged ?? (() => undefined);
  const toast = onToast ?? (() => undefined);
  const cardProps = { studentId: student.id, viewerKind, onChanged: changed, onToast: toast };
  const apps = student.applicationCards;
  // Every application stays listed: in progress first, closed below.
  const { open, closed } = splitByClosed(apps);
  const shortlist = student.shortlists;

  const utils = api.useUtils();
  const refresh = () => {
    changed();
    void utils.students.partnerGet.invalidate({ id: student.id });
    void utils.students.partnerShortlist.invalidate({ studentId: student.id });
  };
  const [dialog, setDialog] = useState<{
    mode: "reject" | "repropose";
    courseId: number;
    subject: string;
  } | null>(null);
  const decide = api.students.partnerDecideShortlist.useMutation({
    onSuccess: (_r, vars) => {
      refresh();
      setDialog(null);
      toast(
        vars.approve
          ? "Approved. Collegepond can now start the application."
          : "Rejected. Collegepond has been told why.",
      );
    },
    onError: (e) => toast(e.message),
  });
  const repropose = api.students.partnerReproposeShortlist.useMutation({
    onSuccess: () => {
      refresh();
      setDialog(null);
      toast("Sent back to Collegepond for approval");
    },
    onError: (e) => toast(e.message),
  });
  const remove = api.students.partnerRemoveShortlist.useMutation({
    onSuccess: () => {
      refresh();
      toast("Removed from shortlist");
    },
    onError: (e) => toast(e.message),
  });
  const busy = decide.isPending || repropose.isPending || remove.isPending;
  const awaitingYou = shortlist.filter((s) => shortlistView(s, "partner").canDecide).length;

  return (
    <div className="space-y-6">
      <section className="rounded-[14px] border border-[#E4E7EC] bg-white p-6">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-[#101828]">
            Applications
            {apps.length > 0 && (
              <span className="ml-2 text-[13px] font-normal text-[#667085]">{applicationSummary(apps)}</span>
            )}
          </h3>
          <span className="text-[12px] text-[#98A2B3]">Updated by Collegepond as each application moves</span>
        </div>
        {apps.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#D0D5DD] px-4 py-6 text-center text-[13px] text-[#98A2B3]">
            No applications yet. Collegepond starts them from the shortlist below.
          </p>
        ) : (
          <ul className="space-y-4">
            {open.map((a) => (
              <ApplicationCard key={a.id} a={a} focused={a.id === focusAppId} {...cardProps} />
            ))}
            {closed.length > 0 && (
              <li className="flex items-center gap-3 pt-2" aria-hidden>
                <span className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
                  Closed ({closed.length})
                </span>
                <span className="h-px flex-1 bg-[#E4E7EC]" />
              </li>
            )}
            {closed.map((a) => (
              <ApplicationCard key={a.id} a={a} focused={a.id === focusAppId} {...cardProps} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-[14px] border border-[#E4E7EC] bg-white p-6">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-[#101828]">
            Shortlist ({shortlist.length})
            {awaitingYou > 0 && (
              <span className="ml-2 rounded-full bg-[#F4F3FF] px-2 py-0.5 text-[12px] font-semibold text-[#5925DC]">
                {awaitingYou} awaiting your approval
              </span>
            )}
          </h3>
          <Link
            href={`/partner/uni-assist?student=${student.id}`}
            className="text-[13px] font-semibold text-[#1570EF] hover:underline"
          >
            Shortlist via Uni Assist
          </Link>
        </div>
        {shortlist.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#D0D5DD] px-4 py-6 text-center text-[13px] text-[#98A2B3]">
            Nothing shortlisted yet. Use Uni Assist to shortlist programs for this student.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {shortlist.map((s) => (
              <ShortlistCard
                key={s.id}
                s={s}
                busy={busy}
                onApprove={() =>
                  decide.mutate({ studentId: student.id, courseId: s.courseId, approve: true })
                }
                onReject={() =>
                  setDialog({
                    mode: "reject",
                    courseId: s.courseId,
                    subject: `${s.university} – ${s.program}, proposed by Collegepond.`,
                  })
                }
                onRepropose={() =>
                  setDialog({
                    mode: "repropose",
                    courseId: s.courseId,
                    subject: `Send ${s.university} – ${s.program} back to Collegepond for approval.`,
                  })
                }
                onRemove={() => remove.mutate({ studentId: student.id, courseId: s.courseId })}
              />
            ))}
          </ul>
        )}
      </section>

      <ShortlistTextDialog
        open={dialog !== null}
        mode={dialog?.mode ?? "reject"}
        subject={dialog?.subject ?? ""}
        busy={decide.isPending || repropose.isPending}
        onClose={() => setDialog(null)}
        onSubmit={(text) => {
          if (!dialog) return;
          if (dialog.mode === "reject") {
            decide.mutate({
              studentId: student.id,
              courseId: dialog.courseId,
              approve: false,
              reason: text,
            });
          } else {
            repropose.mutate({
              studentId: student.id,
              courseId: dialog.courseId,
              note: text || undefined,
            });
          }
        }}
      />
    </div>
  );
}

function UniHead({ c }: { c: Card | Shortlist }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {c.universityLogoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={c.universityLogoUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded-lg border border-[#F2F4F7] bg-white object-contain p-1"
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#F2F4F7] text-sm font-bold text-[#667085]">
          {c.university.charAt(0)}
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-[#101828]">{c.university}</div>
        <div className="truncate text-[13px] text-[#475467]">{c.program}</div>
        <div className="text-[12px] text-[#98A2B3]">
          {[c.universityCity, c.universityCountry, intake(c) && `Intake ${intake(c)}`]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
    </div>
  );
}

function ApplicationCard({
  a,
  focused,
  studentId,
  viewerKind,
  onChanged,
  onToast,
}: {
  a: Card;
  focused?: boolean;
  studentId: number;
  viewerKind?: "agency" | "counsellor" | "independent";
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const enrolled = a.status === UniApplicationStatus.ENROLLED;
  const tone = stageTone(a.status);
  const reachedAt = new Map(a.stageHistory.map((h) => [h.stage, h.date]));
  const facts: [string, string | null][] = [
    ["Application fee", appFeeAmount(a.appFee, a.currency, a.hasAppFeeWaiver)],
    ["Submitted", fmtDate(a.submittedAt)],
    ["Decision", fmtDate(a.decidedAt)],
    ["University application ID", a.universityAppId],
    ["Deposit", money(a.depositAmount, a.depositCurrency)],
    ["Deposit due", fmtDate(a.depositDeadline)],
  ];
  // Opened from the Applications page: bring this one into view, once.
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused]);
  return (
    <li
      ref={ref}
      id={`application-${a.id}`}
      className={`rounded-xl border p-4 transition-shadow ${
        focused ? "border-[#1570EF] shadow-[0_0_0_3px_rgba(21,112,239,0.15)]" : "border-[#E4E7EC]"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <UniHead c={a} />
        <div className="flex shrink-0 items-center gap-2">
          <ReportAction
            app={a}
            onDone={(msg) => {
              onToast(msg);
              onChanged();
            }}
          />
          <DeferralReportAction
            app={a}
            onDone={(msg) => {
              onToast(msg);
              onChanged();
            }}
          />
          <span
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold"
            style={{ color: tone.color, background: tone.bg }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.color }} />
            {statusLabel(a.status)}
          </span>
        </div>
      </div>

      {/* Stage track: the same stages and colours as the counsellor portal. */}
      <div className="mt-4 overflow-x-auto pb-1">
        <StageTrack
          app={a}
          titleFor={(st) => {
            const at = reachedAt.get(st);
            return `${statusLabel(st)}${at ? ` · ${fmtDate(at)}` : ""}`;
          }}
        />
      </div>

      {/* Enrolled is the commission-claim milestone (owners/independents). */}
      {enrolled && (
        <div className="mt-3 rounded-lg bg-[#ECFDF3] px-3.5 py-2 text-[13px] text-[#067647]">
          <span className="font-semibold">Enrolled</span>
          {viewerKind === "agency" || viewerKind === "independent"
            ? " — commission for this student can now be claimed from Commission & Payouts."
            : " — the student is confirmed enrolled at the university."}
        </div>
      )}

      <ReportStatus app={a} />
      <DeferralBanner app={a} />
      <PendingDocsChecklist app={a} studentId={studentId} onChanged={onChanged} onToast={onToast} />
      {/* Offer details first, so they stay in view while documents are uploaded. */}
      {facts.some(([, v]) => v) && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-3">
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">{k}</dt>
                <dd className="truncate text-[#344054]">{v}</dd>
              </div>
            ))}
        </dl>
      )}

      {a.conditionalDocs.length > 0 && (
        <div className="mt-4 rounded-lg bg-[#FFFAEB] px-3.5 py-2.5">
          <div className="text-[12px] font-semibold text-[#B54708]">Conditions to meet for this offer</div>
          <ul className="mt-1 list-disc pl-5 text-[13px] text-[#93370D]">
            {a.conditionalDocs.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      <ApplicationUploads app={a} studentId={studentId} onChanged={onChanged} onToast={onToast} />

    </li>
  );
}

const actionBtn =
  "cursor-pointer rounded-lg border px-3 py-1.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-50";

function ShortlistCard({
  s,
  busy,
  onApprove,
  onReject,
  onRepropose,
  onRemove,
}: {
  s: Shortlist;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRepropose: () => void;
  onRemove: () => void;
}) {
  const view = shortlistView(s, "partner");
  const mine = s.addedBy === "partner";
  const appFee = formatAppFee(s.appFee, s.currency, s.hasAppFeeWaiver);
  const facts = [
    s.tuitionFee !== null ? `Tuition ${money(s.tuitionFee, s.currency)}` : null,
    s.durationMonths ? `${s.durationMonths} months` : null,
    appFee,
  ].filter(Boolean);
  return (
    <li
      className={`rounded-xl border p-4 ${
        view.rejected ? "border-[#FECDCA] bg-[#FFFBFA]" : view.canDecide ? "border-[#D9D6FE]" : "border-[#E4E7EC]"
      }`}
    >
      <UniHead c={s} />
      <div className="mt-3">
        <ShortlistStatusBadge view={view} />
      </div>
      <ShortlistApprovalNotes s={s} viewer="partner" />
      {facts.length > 0 && <div className="mt-2 text-[12px] text-[#667085]">{facts.join(" · ")}</div>}
      {(view.canDecide || view.canRepropose || mine) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {view.canDecide && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onApprove}
                className={`${actionBtn} border-[#ABEFC6] bg-[#ECFDF3] text-[#067647] hover:bg-[#D1FADF]`}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onReject}
                className={`${actionBtn} border-[#FECDCA] bg-white text-[#B42318] hover:bg-[#FEF3F2]`}
              >
                Reject
              </button>
            </>
          )}
          {view.canRepropose && (
            <button
              type="button"
              disabled={busy}
              onClick={onRepropose}
              className={`${actionBtn} border-[#B2DDFF] bg-white text-[#1570EF] hover:bg-[#F0F7FF]`}
            >
              Re-propose
            </button>
          )}
          {mine && (
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              className={`${actionBtn} border-[#E4E7EC] bg-white text-[#667085] hover:bg-[#F9FAFB]`}
            >
              Remove
            </button>
          )}
        </div>
      )}
    </li>
  );
}
