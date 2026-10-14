"use client";

import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { AdminRole } from "~/server/db/enums";
import { fmtTierDate, tierBadgeStyle, type TierStatusView } from "~/lib/partner-tiers";

// A partner's tier in the admin Partners list: the effective tier, marked when
// a Super Admin override is lifting it.
export function PartnerTierBadge({ tier }: { tier: TierStatusView | null }) {
  if (!tier) return <span className="text-xs text-[#98A2B3]">—</span>;
  const t = tier.effective;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={tierBadgeStyle(t.badgeColor)}
      title={`${tier.label} · ${tier.students} confirmed in ${tier.fyLabel}`}
    >
      {t.name}
      {tier.source === "override" && <span aria-label="set by Super Admin">★</span>}
    </span>
  );
}

// Detail slide-over: the tier, why, and (Super Admin only) the override.
// The override is a floor: the partner gets the higher of it and the automatic
// tier. Everyone else sees it read-only.
export function PartnerTierPanel({
  userId,
  tier,
  onToast,
}: {
  userId: number;
  tier: TierStatusView | null;
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const meQ = api.authSession.me.useQuery();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isSuperAdmin = mounted && meQ.data?.role === AdminRole.SUPER_ADMIN;

  const [editing, setEditing] = useState(false);
  const [tierId, setTierId] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    await utils.partners.list.invalidate();
    await utils.partnerTiers.partnerStatus.invalidate();
  };
  const setMut = api.partnerTiers.setOverride.useMutation({
    onSuccess: async () => { await refresh(); setEditing(false); onToast("Tier override saved"); },
    onError: (e) => setError(e.message),
  });
  const removeMut = api.partnerTiers.removeOverride.useMutation({
    onSuccess: async () => { await refresh(); onToast("Tier override removed"); },
    onError: (e) => onToast(e.message),
  });

  if (!tier) {
    return <div className="text-sm text-[#98A2B3]">Tier unavailable — check Settings → Partner Tiers.</div>;
  }

  const o = tier.override;
  const fyEnd = `${tier.fy + 1}-03-31`;
  const openEdit = () => {
    setError("");
    setTierId(o ? String(o.tier.id) : "");
    setEndsOn(o ? (o.endsOn ?? "") : fyEnd);
    setReason(o?.reason ?? "");
    setEditing(true);
  };
  const save = () => {
    if (!tierId) { setError("Choose a tier"); return; }
    setError("");
    setMut.mutate({ userId, tierId: Number(tierId), endsOn: endsOn || null, reason: reason.trim() || undefined });
  };
  const remove = () => {
    if (!o) return;
    if (!confirm(`Remove the ${o.tier.name} override? The partner goes back to their automatic tier (${tier.computed.name}).`)) return;
    removeMut.mutate({ userId });
  };

  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-[#667085]">Tier</div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
          style={tierBadgeStyle(tier.effective.badgeColor)}
        >
          {tier.effective.icon} {tier.effective.name} · {tier.effective.sharePct}%
        </span>
        {o && <span className="text-sm text-[#344054]">{tier.label}</span>}
      </div>
      <div className="mt-1 text-xs text-[#667085]">
        Automatic: {tier.computed.name} from {tier.students} student{tier.students === 1 ? "" : "s"} confirmed for billing in {tier.fyLabel}
        {tier.next ? ` · ${tier.next.needed} more to reach ${tier.next.step.name}` : ""}
      </div>
      {o && (
        <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${o.active ? "border-[#FEDF89] bg-[#FFFAEB] text-[#93370D]" : "border-[#E4E7EC] bg-[#F9FAFB] text-[#667085]"}`}>
          <span className="font-semibold">
            {o.isMigrated ? "Carried over from the old manual tier" : "Set by Super Admin"}: {o.tier.name}
          </span>
          {o.endsOn ? ` until ${fmtTierDate(o.endsOn)}` : " with no end date"}
          {!o.active && " (ended)"}
          {o.setBy ? ` · by ${o.setBy.name}` : ""} · {fmtTierDate(o.setAt.slice(0, 10))}
          {o.reason && <div className="mt-0.5 italic">“{o.reason}”</div>}
        </div>
      )}

      {isSuperAdmin && !editing && (
        <div className="mt-2 flex gap-3">
          <button type="button" onClick={openEdit} className="cursor-pointer text-xs font-semibold text-[#1570EF] hover:underline">
            {o ? "Change override" : "Set a tier override"}
          </button>
          {o && (
            <button type="button" onClick={remove} disabled={removeMut.isPending} className="cursor-pointer text-xs font-semibold text-[#B42318] hover:underline disabled:opacity-50">
              Remove override
            </button>
          )}
        </div>
      )}

      {isSuperAdmin && editing && (
        <div className="mt-3 space-y-3 rounded-lg border border-[#E4E7EC] p-3">
          <p className="text-xs text-[#667085]">
            The partner gets the higher of this tier and their automatic tier, so they still move up as their student count grows.
          </p>
          <FormSelect
            label="Tier at least"
            value={tierId}
            onChange={(e) => setTierId(e.target.value)}
            placeholder="Choose a tier"
            options={tier.ladder.map((s) => ({ value: String(s.id), label: `${s.name} · ${s.sharePct}%` }))}
          />
          <FormInput
            label="Until (inclusive)"
            type="date"
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
          />
          <p className="-mt-2 text-[11px] text-[#98A2B3]">Defaults to the end of {tier.fyLabel}. Clear it for no end date.</p>
          <FormInput label="Reason (optional)" maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Strategic partner" />
          {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" className="!h-8 !text-[13px]" onClick={() => setEditing(false)}>Cancel</Button>
            <Button className="!h-8 !text-[13px]" loading={setMut.isPending} onClick={save}>Save override</Button>
          </div>
        </div>
      )}
    </div>
  );
}
