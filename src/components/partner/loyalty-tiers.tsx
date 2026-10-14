"use client";

import { useState } from "react";
import {
  PARTNER_TIERS,
  RELATIONSHIP_MANAGER_LABEL,
  partnerTier,
} from "~/lib/constants/partner-relationship";

// The partner's current tier (user.tier, set by Collegepond) as a banner line.
// No targets or "N more to reach" copy: thresholds haven't been decided, and
// the tier only changes when Collegepond changes it.
export function CurrentTierLine({ tier }: { tier: number }) {
  const t = partnerTier(tier);
  return (
    <div className="flex items-center gap-3">
      <span className="text-2xl" aria-hidden>
        {t.icon}
      </span>
      <div>
        <div className="text-sm font-bold text-[#101828]">Your Current Tier — {t.name}</div>
        <div className="text-xs text-[#667085]">
          Your tier is set by Collegepond. Ask your {RELATIONSHIP_MANAGER_LABEL} about moving up.
        </div>
      </div>
    </div>
  );
}

// The tier ladder with each tier's benefits; the partner's own is marked.
export function TierLadder({ current }: { current: number }) {
  const mine = partnerTier(current);
  const [show, setShow] = useState(mine.name);
  const shown = PARTNER_TIERS.find((t) => t.name === show) ?? mine;
  return (
    <>
      <div className="grid grid-cols-5 gap-2">
        {PARTNER_TIERS.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => setShow(t.name)}
            className={`rounded-lg border p-2 text-center transition ${show === t.name ? "border-[#1570EF] bg-[#EFF8FF]" : "border-[#E4E7EC] hover:bg-[#F9FAFB]"}`}
          >
            <div className="text-xl">{t.icon}</div>
            <div className="text-xs font-bold text-[#101828]">{t.name}</div>
            {t.name === mine.name && (
              <div className="mt-0.5 text-[9px] font-semibold text-[#1570EF]">CURRENT</div>
            )}
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-lg border border-[#E4E7EC] p-4">
        <div className="mb-2 text-sm font-bold text-[#101828]">
          {shown.icon} {shown.name} Tier Benefits
        </div>
        <ul className="space-y-1.5">
          {shown.perks.map((p) => (
            <li key={p} className="flex items-center gap-2 text-sm text-[#344054]">
              <span className="text-[#12B76A]">✓</span> {p}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
