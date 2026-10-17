"use client";

import Link from "next/link";
import { UniApplicationStatusLabel } from "~/server/db/enums";
import { type AdminStudentFull } from "~/app/admin/(dashboard)/students/lib";
import { applicationSummary, splitByClosed } from "~/lib/application-summary";
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

// Read-only for partners: Collegepond runs the applications. Portal logins,
// vendor and status controls stay on the admin side.
export function ApplicationsTab({ student }: { student: AdminStudentFull }) {
  const apps = student.applicationCards;
  // Every application stays listed: in progress first, closed below.
  const { open, closed } = splitByClosed(apps);
  const shortlist = student.shortlists;

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
              <ApplicationCard key={a.id} a={a} />
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
              <ApplicationCard key={a.id} a={a} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-[14px] border border-[#E4E7EC] bg-white p-6">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-[#101828]">Shortlist ({shortlist.length})</h3>
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
              <ShortlistCard key={s.id} s={s} />
            ))}
          </ul>
        )}
      </section>
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

function ApplicationCard({ a }: { a: Card }) {
  const tone = stageTone(a.status);
  const reachedAt = new Map(a.stageHistory.map((h) => [h.stage, h.date]));
  const facts: [string, string | null][] = [
    ["Submitted", fmtDate(a.submittedAt)],
    ["Decision", fmtDate(a.decidedAt)],
    ["University application ID", a.universityAppId],
    ["Deposit", money(a.depositAmount, a.depositCurrency)],
    ["Deposit due", fmtDate(a.depositDeadline)],
  ];
  return (
    <li className="rounded-xl border border-[#E4E7EC] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <UniHead c={a} />
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold"
          style={{ color: tone.color, background: tone.bg }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.color }} />
          {statusLabel(a.status)}
        </span>
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
    </li>
  );
}

function ShortlistCard({ s }: { s: Shortlist }) {
  return (
    <li className="rounded-xl border border-[#E4E7EC] p-4">
      <UniHead c={s} />
      {s.tuitionFee !== null && (
        <div className="mt-3 text-[12px] text-[#667085]">
          Tuition {money(s.tuitionFee, s.currency)}
          {s.durationMonths ? ` · ${s.durationMonths} months` : ""}
        </div>
      )}
    </li>
  );
}
