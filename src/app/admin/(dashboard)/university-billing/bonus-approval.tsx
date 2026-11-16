"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { FINANCE_CURRENCIES, money } from "~/lib/currency";

// Approve commission › Base / Bonus / Total (16 Nov 2026, Suraj item 7).
//
// University side: the base commission (as the agreement's rate gives it),
// the university volume bonus (Collegepond income: billed in full on its own
// invoice, no partner share) and their total.
// Partner side: the partner's tier share of the base, the CP-funded partner
// incentive ("Bonus: <scheme>", 100% the partner's, highest matching scheme
// by default) and their total.
// Every figure can be changed; a change needs a reason, which is audited.

type Preview = inferRouterOutputs<AppRouter>["universityBilling"]["approvalPreview"];

export type BonusEdits = {
  base: { on: boolean; amount: string; reason: string };
  volume: { on: boolean; amount: string; reason: string };
  // schemeId "" = the default (highest), "none" = no incentive / manual.
  incentive: { on: boolean; schemeId: string; amount: string; currency: string; reason: string };
};
export const emptyBonusEdits: BonusEdits = {
  base: { on: false, amount: "", reason: "" },
  volume: { on: false, amount: "", reason: "" },
  incentive: { on: false, schemeId: "", amount: "", currency: "INR", reason: "" },
};

const toNum = (s: string) => (s.trim() === "" ? NaN : Number(s));
const r2 = (n: number) => Math.round(n * 100) / 100;

// What Finance has settled on, from the preview + their edits.
export function resolveBonusEdits(p: Preview, e: BonusEdits) {
  const baseCalc = p.gross ?? 0;
  const base = e.base.on ? toNum(e.base.amount) : baseCalc;
  const volCalc = p.volumeBonus?.perStudent ?? 0;
  const volCurrency = p.volumeBonus?.currency ?? p.contractCurrency ?? p.currency;
  const vol = e.volume.on ? toNum(e.volume.amount) : volCalc;
  const top = p.incentives[0] ?? null;
  const chosen =
    !e.incentive.on || e.incentive.schemeId === ""
      ? top
      : e.incentive.schemeId === "none"
        ? null
        : (p.incentives.find((c) => String(c.schemeId) === e.incentive.schemeId) ?? null);
  const incCalc = chosen?.perStudent ?? 0;
  const inc = e.incentive.on && e.incentive.amount.trim() !== "" ? toNum(e.incentive.amount) : incCalc;
  const incCurrency = chosen?.currency ?? (e.incentive.on ? e.incentive.currency : "INR");
  const baseChanged = e.base.on && r2(base) !== r2(baseCalc);
  const volChanged = e.volume.on && r2(vol) !== r2(volCalc);
  const incChanged = e.incentive.on && (r2(inc) !== r2(incCalc) || (chosen?.schemeId ?? null) !== (top?.schemeId ?? null));
  const cpGets = p.cpSharePct == null ? base : r2((base * p.cpSharePct) / 100);
  const shareOfBase = p.sharePct == null ? null : r2((cpGets * p.sharePct) / 100);
  let issue: string | null = null;
  if ([base, vol, inc].some((n) => Number.isNaN(n) || n < 0)) issue = "Enter amounts of 0 or more.";
  else if (baseChanged && e.base.reason.trim().length < 5) issue = "Give a reason for changing the base commission.";
  else if (volChanged && e.volume.reason.trim().length < 5) issue = "Give a reason for changing the volume bonus.";
  else if (incChanged && e.incentive.reason.trim().length < 5) issue = "Give a reason for changing the partner bonus.";
  return {
    base,
    vol,
    volCurrency,
    chosen,
    inc,
    incCurrency,
    cpGets,
    shareOfBase,
    issue,
    // The confirmBilling input.
    payload: {
      ...(baseChanged ? { baseAmount: r2(base), baseReason: e.base.reason.trim() } : {}),
      ...(volChanged ? { volumeBonusAmount: r2(vol), volumeBonusReason: e.volume.reason.trim() } : {}),
      ...(incChanged
        ? {
            incentiveSchemeId: chosen?.schemeId ?? null,
            incentiveAmount: r2(inc),
            incentiveCurrency: (chosen ? undefined : e.incentive.currency) as (typeof FINANCE_CURRENCIES)[number] | undefined,
            incentiveReason: e.incentive.reason.trim(),
          }
        : {}),
    },
  };
}

// "€1,000.00 + ₹15,000.00" when the parts are in different currencies.
function sum(parts: { amount: number; currency: string }[]) {
  const by = new Map<string, number>();
  for (const p of parts) if (p.amount > 0 || parts.length === 1) by.set(p.currency, (by.get(p.currency) ?? 0) + p.amount);
  if (by.size === 0) return money(0, parts[0]?.currency ?? "INR");
  return Array.from(by.entries())
    .map(([c, a]) => money(r2(a), c))
    .join(" + ");
}

const LINK = "text-xs font-semibold text-[#1570EF] hover:underline";

function Row({
  label,
  sub,
  value,
  strong,
  action,
}: {
  label: string;
  sub?: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 py-2 ${strong ? "border-t border-[#E4E7EC]" : ""}`}>
      <div className="min-w-0">
        <div className={`text-sm ${strong ? "font-semibold text-[#101828]" : "text-[#344054]"}`}>{label}</div>
        {sub && <div className="mt-0.5 text-[11px] text-[#667085]">{sub}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {action}
        <div className={`text-right text-sm ${strong ? "font-bold text-[#101828]" : "font-semibold text-[#101828]"}`}>{value}</div>
      </div>
    </div>
  );
}

function EditBox({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 grid grid-cols-1 gap-2 rounded-lg border border-[#D0D5DD] bg-white p-2.5 sm:grid-cols-2">{children}</div>;
}

export function BonusApproval({
  p,
  value,
  onChange,
}: {
  p: Preview;
  value: BonusEdits;
  onChange: (v: BonusEdits) => void;
}) {
  const [showBackfill, setShowBackfill] = useState(false);
  const r = resolveBonusEdits(p, value);
  const set = <K extends keyof BonusEdits>(k: K, patch: Partial<BonusEdits[K]>) =>
    onChange({ ...value, [k]: { ...value[k], ...patch } });
  const vb = p.volumeBonus;
  const backfillAdds = vb?.backfill.filter((b) => b.action !== "invoiced") ?? [];
  const backfillFlagged = vb?.backfill.filter((b) => b.action === "invoiced") ?? [];

  return (
    <div className="space-y-3">
      {/* ---- University side ---- */}
      <div className="rounded-lg border border-[#E4E7EC] px-3.5 py-1.5">
        <div className="pt-1.5 text-[11px] font-semibold tracking-wide text-[#98A2B3] uppercase">University billing</div>
        <Row
          label="Base university commission"
          sub={
            value.base.on
              ? `Calculated ${money(p.gross ?? 0, p.currency)} from the agreement`
              : "As per the university agreement"
          }
          value={money(Number.isNaN(r.base) ? 0 : r.base, p.currency)}
          action={
            <button className={LINK} onClick={() => set("base", { on: !value.base.on, amount: String(p.gross ?? 0) })}>
              {value.base.on ? "Undo" : "Edit"}
            </button>
          }
        />
        {value.base.on && (
          <EditBox>
            <FormInput label={`Base (${p.currency})`} type="number" min={0} step="0.01" value={value.base.amount} onChange={(e) => set("base", { amount: e.target.value })} />
            <FormInput label="Reason" placeholder="e.g. scholarship reduced tuition" value={value.base.reason} onChange={(e) => set("base", { reason: e.target.value })} />
          </EditBox>
        )}
        <Row
          label="University volume bonus"
          sub={
            vb ? (
              <>
                {vb.schemeName} · slab {vb.slab} · student {vb.count} in the {p.intake ?? "—"} intake
                {vb.retroactive && " · retroactive"}
                {backfillAdds.length > 0 && (
                  <>
                    {" · "}
                    <button className="font-semibold text-[#1570EF]" onClick={() => setShowBackfill(!showBackfill)}>
                      +{backfillAdds.length} earlier {backfillAdds.length === 1 ? "student" : "students"}
                    </button>
                  </>
                )}
                <br />
                Collegepond income, invoiced on its own. No partner share.
              </>
            ) : (
              `No volume bonus scheme reached for this contract${p.intake ? ` in the ${p.intake} intake` : ""}.`
            )
          }
          value={money(Number.isNaN(r.vol) ? 0 : r.vol, r.volCurrency)}
          action={
            <button className={LINK} onClick={() => set("volume", { on: !value.volume.on, amount: String(vb?.perStudent ?? 0) })}>
              {value.volume.on ? "Undo" : vb ? "Edit" : "Add"}
            </button>
          }
        />
        {showBackfill && backfillAdds.length > 0 && (
          <ul className="mb-2 rounded-lg bg-[#F9FAFB] px-3 py-2 text-[11px] text-[#475467]">
            {backfillAdds.map((b) => (
              <li key={b.studentName}>
                {b.studentName}: {b.action === "add" ? "adds" : `raises ${money(b.current ?? 0, vb!.currency)} to`} {money(vb!.perStudent, vb!.currency)}
              </li>
            ))}
          </ul>
        )}
        {backfillFlagged.length > 0 && (
          <p className="mb-2 text-[11px] text-[#B54708]">
            {backfillFlagged.length} earlier {backfillFlagged.length === 1 ? "student was" : "students were"} already invoiced at a lower rate. They&apos;re flagged on Vendor Billing › Volume bonus due for a top-up, not re-billed.
          </p>
        )}
        {value.volume.on && (
          <EditBox>
            <FormInput label={`Volume bonus (${r.volCurrency}), 0 = none`} type="number" min={0} step="0.01" value={value.volume.amount} onChange={(e) => set("volume", { amount: e.target.value })} />
            <FormInput label="Reason" value={value.volume.reason} onChange={(e) => set("volume", { reason: e.target.value })} />
          </EditBox>
        )}
        <Row
          strong
          label="Total approved commission"
          sub={p.cpSharePct != null ? `Vendor deal: CP bills its ${p.cpSharePct}% share of the base (${money(r.cpGets, p.currency)}) plus the volume bonus in full` : null}
          value={sum([
            { amount: Number.isNaN(r.base) ? 0 : r.base, currency: p.currency },
            { amount: Number.isNaN(r.vol) ? 0 : r.vol, currency: r.volCurrency },
          ])}
        />
      </div>

      {/* ---- Partner side ---- */}
      <div className="rounded-lg border border-[#E4E7EC] px-3.5 py-1.5">
        <div className="pt-1.5 text-[11px] font-semibold tracking-wide text-[#98A2B3] uppercase">Partner commission</div>
        <Row
          label="Partner's share of the base"
          sub={p.sharePct == null ? "Partner Tiers aren't set up" : `${p.tier ?? "—"} · ${p.sharePct}% of what Collegepond receives`}
          value={r.shareOfBase == null ? "—" : `≈ ${money(r.shareOfBase, p.currency)}`}
        />
        <Row
          label="Additional partner bonus"
          sub={
            r.chosen ? (
              <>
                Bonus: {r.chosen.schemeName} · slab {r.chosen.slab} · student {r.chosen.count} for this partner
                {p.incentives.length > 1 && !value.incentive.on && ` · highest of ${p.incentives.length} matching schemes`}
                <br />
                Collegepond-funded, 100% to the partner, claimable with the first collected instalment.
              </>
            ) : p.incentives.length > 0 ? (
              "No partner bonus applied."
            ) : (
              "No partner incentive scheme matches this student."
            )
          }
          value={money(Number.isNaN(r.inc) ? 0 : r.inc, r.incCurrency)}
          action={
            <button
              className={LINK}
              onClick={() =>
                set("incentive", {
                  on: !value.incentive.on,
                  schemeId: "",
                  amount: "",
                })
              }
            >
              {value.incentive.on ? "Undo" : p.incentives.length > 0 ? "Change" : "Add"}
            </button>
          }
        />
        {value.incentive.on && (
          <EditBox>
            <FormSelect
              label="Scheme"
              options={[
                ...p.incentives.map((c, i) => ({
                  value: i === 0 ? "" : String(c.schemeId),
                  label: `${c.schemeName} · ${money(c.perStudent, c.currency)}${i === 0 ? " (highest)" : ""}`,
                })),
                { value: "none", label: p.incentives.length > 0 ? "None / manual amount" : "Manual amount" },
              ]}
              value={p.incentives.length === 0 && value.incentive.schemeId === "" ? "none" : value.incentive.schemeId}
              onChange={(e) => set("incentive", { schemeId: e.target.value, amount: "" })}
            />
            {!r.chosen && (
              <FormSelect
                label="Currency"
                options={FINANCE_CURRENCIES.map((c) => ({ value: c, label: c }))}
                value={value.incentive.currency}
                onChange={(e) => set("incentive", { currency: e.target.value })}
              />
            )}
            <FormInput
              label={`Amount (${r.incCurrency})`}
              type="number"
              min={0}
              step="0.01"
              placeholder={String(r.chosen?.perStudent ?? 0)}
              value={value.incentive.amount}
              onChange={(e) => set("incentive", { amount: e.target.value })}
            />
            <FormInput label="Reason" value={value.incentive.reason} onChange={(e) => set("incentive", { reason: e.target.value })} />
          </EditBox>
        )}
        <Row
          strong
          label="Total to the partner"
          value={sum([
            { amount: r.shareOfBase ?? 0, currency: p.currency },
            { amount: Number.isNaN(r.inc) ? 0 : r.inc, currency: r.incCurrency },
          ])}
        />
      </div>
    </div>
  );
}
