"use client";

import { useState } from "react";
import {
  fmtTierDate,
  tierBadgeStyle,
  tierRangeText,
  type TierStatusView,
  type TierStepView,
} from "~/lib/partner-tiers";

// The partner's loyalty tier, from the Partner Tiers master: automatic from
// the students Collegepond confirmed for billing this financial year, or a
// higher tier Collegepond has set for them.

export function TierBadge({ step, suffix }: { step: TierStepView; suffix?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={tierBadgeStyle(step.badgeColor)}
    >
      {step.icon && <span aria-hidden>{step.icon}</span>} {step.name}
      {suffix ? ` ${suffix}` : ""}
    </span>
  );
}

// One line under the tier name: progress this FY, or why the tier is higher.
export function tierProgressText(s: TierStatusView): string {
  const students = `${s.students} student${s.students === 1 ? "" : "s"} confirmed in ${s.fyLabel}`;
  const next = s.next
    ? ` · ${s.next.needed} more to reach ${s.next.step.name}`
    : " · You've reached the top tier!";
  if (s.source === "override" && s.override) {
    const until = s.override.endsOn ? ` until ${fmtTierDate(s.override.endsOn)}` : "";
    return `${s.effective.name} set by Collegepond${until} · ${students}${next}`;
  }
  return `${students}${next}`;
}

export function CurrentTierLine({ status }: { status: TierStatusView }) {
  const t = status.effective;
  return (
    <div className="flex items-center gap-3">
      {t.icon && (
        <span className="text-2xl" aria-hidden>
          {t.icon}
        </span>
      )}
      <div>
        <div className="text-sm font-bold text-[#101828]">
          Your Current Tier — {t.name} · {t.sharePct}% Commission
        </div>
        <div className="text-xs text-[#667085]">{tierProgressText(status)}</div>
      </div>
    </div>
  );
}

// The tier ladder with each tier's range, share and benefits; the partner's
// own tier is marked.
export function TierLadder({ status }: { status: TierStatusView }) {
  const mine = status.effective;
  const [show, setShow] = useState(mine.id);
  const shown = status.ladder.find((t) => t.id === show) ?? mine;
  return (
    <>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, status.ladder.length)}, minmax(0, 1fr))` }}
      >
        {status.ladder.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setShow(t.id)}
            className={`rounded-lg border p-2 text-center transition ${show === t.id ? "border-[#1570EF] bg-[#EFF8FF]" : "border-[#E4E7EC] hover:bg-[#F9FAFB]"}`}
          >
            {t.icon && <div className="text-xl">{t.icon}</div>}
            <div className="text-xs font-bold text-[#101828]">{t.name}</div>
            <div className="text-[10px] text-[#667085]">{t.sharePct}%</div>
            {t.id === mine.id && (
              <div className="mt-0.5 text-[9px] font-semibold text-[#1570EF]">CURRENT</div>
            )}
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-lg border border-[#E4E7EC] p-4">
        <div className="mb-1 text-sm font-bold text-[#101828]">
          {shown.icon} {shown.name} Tier Benefits
        </div>
        <div className="mb-2 text-xs text-[#667085]">{tierRangeText(shown)} in a financial year</div>
        <ul className="space-y-1.5">
          {[`${shown.sharePct}% of the university commission Collegepond receives`, ...shown.benefits].map(
            (p) => (
              <li key={p} className="flex items-center gap-2 text-sm text-[#344054]">
                <span className="text-[#12B76A]">✓</span> {p}
              </li>
            ),
          )}
        </ul>
        <p className="mt-3 text-[11px] text-[#98A2B3]">
          Your tier is based on the students Collegepond confirms for billing in each financial year
          (1 April – 31 March), and the count starts again on 1 April. Your commission share is fixed
          for each student when they are confirmed.
        </p>
      </div>
    </>
  );
}
