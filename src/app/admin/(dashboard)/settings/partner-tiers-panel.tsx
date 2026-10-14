"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { StatusBadge } from "~/components/ui/status-badge";
import { fmtTierDate, tierBadgeStyle, tierRangeText } from "~/lib/partner-tiers";

const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";
const NUM = "h-9 w-20 rounded-lg border border-[#D0D5DD] bg-white px-2 text-sm text-[#344054] outline-none focus:border-[#1570EF] disabled:bg-[#F9FAFB] disabled:text-[#98A2B3]";

type Tier = {
  id: number;
  name: string;
  displayOrder: number;
  badgeColor: string;
  icon: string | null;
  benefits: string[];
  active: boolean;
  overrideCount: number;
  commissionCount: number;
  ruleCount: number;
};

type Editing = {
  id: number | null;
  name: string;
  displayOrder: string;
  badgeColor: string;
  icon: string;
  benefits: string;
};

// One row of the next-FY schedule editor. Ranges chain: each included tier
// starts right after the previous one ends, the lowest starts at 0 and the
// highest is open-ended, so the editor can't produce gaps or overlaps.
type DraftRow = { tierId: number; include: boolean; max: string; share: string };

function TierPill({ t }: { t: { name: string; badgeColor: string; icon: string | null } }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold" style={tierBadgeStyle(t.badgeColor)}>
      {t.icon && <span aria-hidden>{t.icon}</span>} {t.name}
    </span>
  );
}

// Settings -> Partner Tiers. Super Admin only (the parent hides the section for
// everyone else and the API refuses them).
export function PartnerTiersPanel({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const masterQ = api.partnerTiers.master.useQuery();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState("");

  const refresh = async () => {
    await utils.partnerTiers.invalidate();
    await utils.partners.list.invalidate();
  };
  const createMut = api.partnerTiers.createTier.useMutation({
    onSuccess: async () => { await refresh(); setEditing(null); toast("Tier added"); },
    onError: (e) => setFormError(e.message),
  });
  const updateMut = api.partnerTiers.updateTier.useMutation({
    onSuccess: async () => { await refresh(); setEditing(null); toast("Tier updated"); },
    onError: (e) => setFormError(e.message),
  });
  const activeMut = api.partnerTiers.setTierActive.useMutation({
    onSuccess: async (_d, v) => { await refresh(); toast(v.active ? "Tier activated" : "Tier deactivated"); },
    onError: (e) => toast(e.message),
  });
  const removeMut = api.partnerTiers.removeTier.useMutation({
    onSuccess: async () => { await refresh(); toast("Tier deleted"); },
    onError: (e) => toast(e.message),
  });

  const m = masterQ.data;
  const tiers: Tier[] = useMemo(() => m?.tiers ?? [], [m]);
  const tierById = useMemo(() => new Map(tiers.map((t) => [t.id, t])), [tiers]);
  const currentByTier = useMemo(() => new Map((m?.current ?? []).map((r) => [r.tierId, r])), [m]);

  const openAdd = () => {
    setFormError("");
    setEditing({ id: null, name: "", displayOrder: "", badgeColor: "#344054", icon: "", benefits: "" });
  };
  const openEdit = (t: Tier) => {
    setFormError("");
    setEditing({
      id: t.id,
      name: t.name,
      displayOrder: String(t.displayOrder),
      badgeColor: t.badgeColor,
      icon: t.icon ?? "",
      benefits: t.benefits.join("\n"),
    });
  };
  const save = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setFormError("Tier name is required"); return; }
    const orderText = editing.displayOrder.trim();
    const displayOrder = orderText === "" ? undefined : Number(orderText);
    if (displayOrder !== undefined && (!Number.isInteger(displayOrder) || displayOrder < 0)) {
      setFormError("Display order must be a whole number, 0 or more"); return;
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(editing.badgeColor)) { setFormError("Badge colour must be a hex colour like #1570EF"); return; }
    const benefits = editing.benefits.split("\n").map((b) => b.trim()).filter(Boolean);
    setFormError("");
    const payload = { name, displayOrder, badgeColor: editing.badgeColor, icon: editing.icon.trim() || null, benefits };
    if (editing.id == null) createMut.mutate(payload);
    else updateMut.mutate({ id: editing.id, ...payload });
  };
  const toggle = (t: Tier) => {
    if (t.active && !confirm(`Deactivate ${t.name}? It stays on commissions already confirmed at that tier but can't be put on a ladder or used for an override.`)) return;
    activeMut.mutate({ id: t.id, active: !t.active });
  };
  const remove = (t: Tier) => {
    if (!confirm(`Delete ${t.name}? This permanently removes the tier and cannot be undone.`)) return;
    removeMut.mutate({ id: t.id });
  };

  return (
    <div className="space-y-6">
      {/* ---- Tiers ---- */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3 border-b border-[#F2F4F7] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-[#101828]">Partner Tiers</h3>
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{tiers.length}</span>
            </div>
            <p className="mt-0.5 text-sm text-[#667085]">
              The loyalty programme. A partner&apos;s tier is automatic from the students Finance confirms for billing in the financial year
              {m ? ` (${m.fyLabel})` : ""}. A Super Admin can set a higher tier on the Partners page. Name, colour and benefits apply immediately.
            </p>
          </div>
          <Button className="!h-9 shrink-0 !text-[13px]" onClick={openAdd}>Add Tier</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Tier</th>
                <th className={TH}>Order</th>
                <th className={TH}>{m ? m.fyLabel : "This year"}</th>
                <th className={TH}>Benefits</th>
                <th className={TH}>Used by</th>
                <th className={TH}>Status</th>
                <th className={`${TH} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {masterQ.isLoading ? (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-[#98A2B3]">Loading tiers…</td></tr>
              ) : masterQ.error ? (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-[#B42318]">{masterQ.error.message}</td></tr>
              ) : tiers.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-[#98A2B3]">No tiers yet</td></tr>
              ) : tiers.map((t) => {
                const cur = currentByTier.get(t.id);
                const used = t.overrideCount + t.commissionCount + t.ruleCount > 0;
                return (
                  <tr key={t.id} className={`border-b border-[#F2F4F7] align-top last:border-0 ${t.active ? "" : "[&_td:not(:last-child)]:opacity-60"}`}>
                    <td className={TD}><TierPill t={t} /></td>
                    <td className={TD}>{t.displayOrder}</td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {cur ? (<>{tierRangeText({ minStudents: cur.min, maxStudents: cur.max })}<span className="block text-xs font-semibold text-[#101828]">{cur.share}% share</span></>) : <span className="text-[#98A2B3]">Not on the ladder</span>}
                    </td>
                    <td className={`${TD} max-w-[320px]`}>
                      {t.benefits.length === 0 ? <span className="text-[#98A2B3]">—</span> : (
                        <ul className="list-disc space-y-0.5 pl-4 text-[13px]">{t.benefits.map((b) => <li key={b}>{b}</li>)}</ul>
                      )}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-[13px]`}>
                      {t.overrideCount} override{t.overrideCount === 1 ? "" : "s"}
                      <span className="block text-xs text-[#98A2B3]">{t.commissionCount} commission{t.commissionCount === 1 ? "" : "s"}</span>
                    </td>
                    <td className={TD}><StatusBadge status={t.active ? "active" : "inactive"} /></td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <button onClick={() => openEdit(t)} className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]">Edit</button>
                      <button
                        onClick={() => toggle(t)}
                        disabled={activeMut.isPending}
                        className={`ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold disabled:opacity-50 ${t.active ? "text-[#F04438] hover:bg-[#FEF3F2]" : "text-[#F79009] hover:bg-[#FFFAEB]"}`}
                      >
                        {t.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => remove(t)}
                        disabled={removeMut.isPending || used}
                        title={used ? "Used by a ladder, an override or confirmed commissions — deactivate it instead" : undefined}
                        className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {m && <ScheduleCard master={m} tierById={tierById} toast={toast} onSaved={refresh} />}

      {m && <OverridesCard overrides={m.overrides} />}

      <p className="text-xs text-[#98A2B3]">
        A tier can only be deleted if it was never used. Otherwise deactivate it: take it off next year&apos;s ladder and clear any overrides first.
      </p>

      {editing && (
        <Modal
          open
          title={editing.id == null ? "Add Tier" : "Edit Tier"}
          onClose={() => setEditing(null)}
          footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={createMut.isPending || updateMut.isPending} onClick={save}>Save</Button></>}
        >
          <FormInput label="Name" required maxLength={50} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <div className="grid grid-cols-3 gap-3">
            <FormInput label="Display order" type="number" min={0} step={1} placeholder={editing.id == null ? "Auto" : undefined} value={editing.displayOrder} onChange={(e) => setEditing({ ...editing, displayOrder: e.target.value })} />
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[#344054]">Badge colour</label>
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Badge colour" value={editing.badgeColor} onChange={(e) => setEditing({ ...editing, badgeColor: e.target.value.toUpperCase() })} className="h-10 w-12 cursor-pointer rounded border border-[#D0D5DD]" />
                <input value={editing.badgeColor} maxLength={7} onChange={(e) => setEditing({ ...editing, badgeColor: e.target.value })} className="h-10 w-full rounded-lg border border-[#D0D5DD] px-2 text-sm" />
              </div>
            </div>
            <FormInput label="Icon (emoji)" maxLength={16} value={editing.icon} onChange={(e) => setEditing({ ...editing, icon: e.target.value })} />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[#344054]">Benefits (one per line)</label>
            <textarea
              rows={5}
              value={editing.benefits}
              onChange={(e) => setEditing({ ...editing, benefits: e.target.value })}
              className="w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-sm text-[#344054] outline-none focus:border-[#1570EF]"
            />
            <p className="mt-1 text-xs text-[#667085]">Partners also see the tier&apos;s commission share at the top of this list; don&apos;t repeat it here.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#667085]">
            Preview: <TierPill t={{ name: editing.name || "Tier", badgeColor: /^#[0-9A-Fa-f]{6}$/.test(editing.badgeColor) ? editing.badgeColor : "#344054", icon: editing.icon || null }} />
          </div>
          <p className="text-xs text-[#667085]">Student ranges and the commission share are set per financial year under &ldquo;Ranges &amp; commission share&rdquo;.</p>
          {formError && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{formError}</div>}
        </Modal>
      )}
    </div>
  );
}

type Master = RouterOutputs["partnerTiers"]["master"];

function ScheduleCard({
  master: m,
  tierById,
  toast,
  onSaved,
}: {
  master: Master;
  tierById: Map<number, Tier>;
  toast: (msg: string) => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  // Start from next year's saved schedule, else this year's ladder; tiers not
  // on it are listed (excluded) so they can be added. Order = display order.
  useEffect(() => {
    const base = m.next?.steps ?? m.current;
    const byTier = new Map(base.map((r) => [r.tierId, r]));
    const rows = [...m.tiers]
      .filter((t) => t.active || byTier.has(t.id))
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name))
      .map((t) => {
        const r = byTier.get(t.id);
        return { tierId: t.id, include: !!r, max: r?.max == null ? "" : String(r.max), share: r ? String(r.share) : "" };
      });
    setDraft(rows);
    setDirty(false);
    setError("");
  }, [m]);

  const included = draft.filter((r) => r.include);
  // Each included row's min: 0 for the first, previous max + 1 after that.
  const mins = new Map<number, number | null>();
  {
    let next: number | null = 0;
    included.forEach((r, i) => {
      mins.set(r.tierId, next);
      const isTop = i === included.length - 1;
      const max = r.max.trim() === "" ? NaN : Number(r.max);
      next = !isTop && Number.isInteger(max) ? max + 1 : null;
    });
  }

  const saveMut = api.partnerTiers.saveNextSchedule.useMutation({
    onSuccess: async () => { await onSaved(); toast(`Saved for ${m.nextFyLabel}`); },
    onError: (e) => setError(e.message),
  });
  const clearMut = api.partnerTiers.clearNextSchedule.useMutation({
    onSuccess: async () => { await onSaved(); toast(`${m.fyLabel} ranges will carry forward`); },
    onError: (e) => setError(e.message),
  });

  const update = (tierId: number, patch: Partial<DraftRow>) => {
    setDraft((d) => d.map((r) => (r.tierId === tierId ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const save = () => {
    setError("");
    if (included.length === 0) { setError("Include at least one tier."); return; }
    const steps = [];
    for (let i = 0; i < included.length; i++) {
      const r = included[i]!;
      const name = tierById.get(r.tierId)?.name ?? "Tier";
      const isTop = i === included.length - 1;
      const min = mins.get(r.tierId);
      if (min == null) { setError(`Set a maximum for the tier before ${name}.`); return; }
      const max = isTop ? null : Number(r.max);
      if (!isTop && (r.max.trim() === "" || !Number.isInteger(max) || max! < min)) {
        setError(`${name}: the maximum must be a whole number of at least ${min}.`); return;
      }
      const share = Number(r.share);
      if (r.share.trim() === "" || !Number.isFinite(share) || share < 0 || share > 100) {
        setError(`${name}: the commission share must be between 0 and 100.`); return;
      }
      steps.push({ tierId: r.tierId, minStudents: min, maxStudents: max, sharePct: Math.round(share * 100) / 100 });
    }
    if (!confirm(`Save these ranges and shares for ${m.nextFyLabel}? They apply from 1 April ${m.nextFy}; ${m.fyLabel} is not changed.`)) return;
    saveMut.mutate({ steps });
  };

  return (
    <div className={CARD}>
      <div className="border-b border-[#F2F4F7] px-5 py-4">
        <h3 className="text-[15px] font-semibold text-[#101828]">Ranges &amp; commission share</h3>
        <p className="mt-0.5 text-sm text-[#667085]">
          Student ranges and the partner&apos;s commission share change only from the next financial year, so a year&apos;s rules never move mid-way.
          Each commission keeps the share fixed on it when Finance confirmed it.
        </p>
      </div>
      <div className="grid gap-6 p-5 xl:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-semibold text-[#101828]">{m.fyLabel} <span className="font-normal text-[#667085]">(in effect)</span></div>
          <table className="w-full border-collapse rounded-lg border border-[#E4E7EC]">
            <thead><tr><th className={TH}>Tier</th><th className={TH}>Students</th><th className={TH}>Share</th></tr></thead>
            <tbody>
              {m.current.map((r) => {
                const t = tierById.get(r.tierId);
                return (
                  <tr key={r.tierId} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={TD}>{t ? <TierPill t={t} /> : "—"}</td>
                    <td className={TD}>{tierRangeText({ minStudents: r.min, maxStudents: r.max })}</td>
                    <td className={`${TD} font-semibold`}>{r.share}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div>
          <div className="mb-2 text-sm font-semibold text-[#101828]">
            {m.nextFyLabel}{" "}
            <span className="font-normal text-[#667085]">
              {m.next ? `(saved${m.next.savedBy ? ` by ${m.next.savedBy}` : ""} ${fmtTierDate(m.next.savedAt.slice(0, 10))})` : `(no changes — ${m.fyLabel} carries forward)`}
            </span>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full border-collapse rounded-lg border border-[#E4E7EC]">
            <thead><tr><th className={TH}>On ladder</th><th className={TH}>Tier</th><th className={TH}>From</th><th className={TH}>To</th><th className={TH}>Share %</th></tr></thead>
            <tbody>
              {draft.map((r) => {
                const t = tierById.get(r.tierId);
                const idx = included.findIndex((x) => x.tierId === r.tierId);
                const isTop = r.include && idx === included.length - 1;
                const min = mins.get(r.tierId);
                return (
                  <tr key={r.tierId} className={`border-b border-[#F2F4F7] last:border-0 ${r.include ? "" : "opacity-60"}`}>
                    <td className={TD}>
                      <input type="checkbox" aria-label={`Include ${t?.name ?? "tier"}`} checked={r.include} disabled={!t?.active && !r.include} onChange={(e) => update(r.tierId, { include: e.target.checked })} />
                    </td>
                    <td className={TD}>{t ? <TierPill t={t} /> : "—"}</td>
                    <td className={TD}>{r.include ? (min ?? "—") : ""}</td>
                    <td className={TD}>
                      {!r.include ? "" : isTop ? <span className="text-[13px] text-[#667085]">and above</span> : (
                        <input className={NUM} type="number" min={0} step={1} value={r.max} onChange={(e) => update(r.tierId, { max: e.target.value })} aria-label={`${t?.name ?? "Tier"} maximum`} />
                      )}
                    </td>
                    <td className={TD}>
                      {r.include && <input className={NUM} type="number" min={0} max={100} step={0.5} value={r.share} onChange={(e) => update(r.tierId, { share: e.target.value })} aria-label={`${t?.name ?? "Tier"} share`} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <p className="mt-2 text-xs text-[#667085]">Tiers run in display order. The lowest starts at 0 students (a partner with none this year is in it) and the highest has no maximum.</p>
          {error && <div className="mt-3 rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {m.next && (
              <Button variant="secondary" className="!h-9 !text-[13px]" loading={clearMut.isPending} onClick={() => { if (confirm(`Discard the saved ${m.nextFyLabel} schedule? ${m.fyLabel}'s ranges and shares will carry forward.`)) clearMut.mutate(); }}>
                Discard {m.nextFyLabel} changes
              </Button>
            )}
            <Button className="!h-9 !text-[13px]" disabled={!dirty} loading={saveMut.isPending} onClick={save}>Save for {m.nextFyLabel}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function OverridesCard({ overrides }: { overrides: Master["overrides"] }) {
  return (
    <div className={CARD}>
      <div className="border-b border-[#F2F4F7] px-5 py-4">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold text-[#101828]">Tier overrides</h3>
          <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{overrides.length}</span>
        </div>
        <p className="mt-0.5 text-sm text-[#667085]">
          Partners a Super Admin has set to at least a given tier. They still move up automatically. Change or remove an override from the partner on the Partners page.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead><tr><th className={TH}>Partner</th><th className={TH}>At least</th><th className={TH}>Until</th><th className={TH}>Reason</th><th className={TH}>Set</th></tr></thead>
          <tbody>
            {overrides.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">No overrides</td></tr>
            ) : overrides.map((o) => (
              <tr key={o.userId} className={`border-b border-[#F2F4F7] last:border-0 ${o.active ? "" : "opacity-60"}`}>
                <td className={TD}>
                  <span className="font-semibold text-[#101828]">{o.partner}</span>
                  <span className="block text-xs text-[#98A2B3]">{o.email}{o.independent ? " · independent" : ""}</span>
                </td>
                <td className={TD}>{o.tier}</td>
                <td className={`${TD} whitespace-nowrap`}>{o.endsOn ? fmtTierDate(o.endsOn) : "No end date"}{!o.active && <span className="block text-xs text-[#B42318]">Ended</span>}</td>
                <td className={`${TD} text-[13px]`}>{o.reason ?? "—"}</td>
                <td className={`${TD} whitespace-nowrap text-[13px]`}>
                  {o.isMigrated ? "Carried over from the manual tier" : (o.setBy ?? "Super Admin")}
                  <span className="block text-xs text-[#98A2B3]">{fmtTierDate(o.setAt.slice(0, 10))}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
