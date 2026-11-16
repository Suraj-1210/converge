"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { SkeletonTable, EmptyState } from "~/components/dashboard/widgets";
import { countryName, formatDate } from "~/components/dashboard/format";
import { AdminRole, BonusKind } from "~/server/db/enums";
import { FINANCE_CURRENCIES, money } from "~/lib/currency";

// Commission Rates › Bonus Schemes (16 Nov 2026, Suraj item 7). Two kinds:
//   University volume bonus — the university / vendor pays Collegepond extra
//     per student once a contract's intake reaches a slab. Income; billed on
//     its own invoice; no partner share. Direct and vendor contracts alike.
//   Partner incentive — Collegepond pays the partner extra per student. On the
//     partner's commission and payout only. Highest matching scheme wins.
// Each scheme is saved on its own; once used its terms are locked (duplicate
// it to change them). Every finance role reads; SA / Finance Manager edit.

type Scheme = inferRouterOutputs<AppRouter>["bonusSchemes"]["list"][number];
type Kind = 1 | 2;

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054] align-top";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATE: Record<Scheme["state"], { label: string; tone: string }> = {
  live: { label: "Live", tone: "bg-[#ECFDF3] text-[#067647]" },
  upcoming: { label: "Upcoming", tone: "bg-[#EFF8FF] text-[#1570EF]" },
  ended: { label: "Ended", tone: "bg-[#F2F4F7] text-[#667085]" },
  off: { label: "Off", tone: "bg-[#FEF3F2] text-[#B42318]" },
};

const slabText = (s: { minStudents: number; maxStudents: number | null }) =>
  s.maxStudents == null ? `${s.minStudents}+` : `${s.minStudents}–${s.maxStudents}`;
const windowText = (s: { activeFrom: string | null; activeTo: string | null }) =>
  !s.activeFrom && !s.activeTo
    ? "Any time"
    : `${s.activeFrom ? formatDate(s.activeFrom) : "…"} – ${s.activeTo ? formatDate(s.activeTo) : "open"}`;
const intakeText = (m: number | null, y: number | null) =>
  m == null && y == null ? "Any intake" : `${m ? MONTHS[m - 1] : "Any month"} ${y ?? "(any year)"}`;

export default function BonusSchemesPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const canEdit = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const listQ = api.bonusSchemes.list.useQuery();
  const utils = api.useUtils();
  const [kind, setKind] = useState<Kind>(BonusKind.INCENTIVE);
  const [editing, setEditing] = useState<{ scheme: Scheme | null; kind: Kind } | null>(null);
  const [toast, setToast] = useState("");
  const show = (m: string) => setToast(m);
  const onErr = (e: { message: string }) => show(e.message);
  const done = (m: string) => () => {
    void utils.bonusSchemes.invalidate();
    show(m);
  };
  const setActive = api.bonusSchemes.setActive.useMutation({ onSuccess: done("Saved"), onError: onErr });
  const duplicate = api.bonusSchemes.duplicate.useMutation({ onSuccess: done("Duplicated — it starts switched off"), onError: onErr });
  const remove = api.bonusSchemes.remove.useMutation({ onSuccess: done("Scheme deleted"), onError: onErr });

  const all = useMemo(() => listQ.data ?? [], [listQ.data]);
  const rows = all.filter((s) => s.kind === kind);
  const imported = all.filter((s) => s.importedFromTiers && !s.isActive && s.used === 0);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/commission-rates" className="text-xs font-semibold text-[#1570EF] hover:underline">
            ← Commission Rates
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-[#101828]">Bonus Schemes</h1>
          <p className="mt-1 max-w-3xl text-sm text-[#667085]">
            Flat amounts per student by volume slab. Each scheme is kept on record: once it has been applied, its terms are locked. Duplicate it to change them, then end the old one.
          </p>
        </div>
        {mounted && canEdit && (
          <Button onClick={() => setEditing({ scheme: null, kind })}>
            Add {kind === BonusKind.VOLUME ? "volume bonus" : "partner incentive"}
          </Button>
        )}
      </div>

      <div className="mb-4 flex gap-2 border-b border-[#E4E7EC]">
        {([
          { id: BonusKind.INCENTIVE, label: "Partner incentives", hint: "CP pays the partner" },
          { id: BonusKind.VOLUME, label: "University volume bonuses", hint: "University pays CP" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setKind(t.id)}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-semibold transition ${
              kind === t.id ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"
            }`}
          >
            {t.label} <span className="ml-1 text-[11px] font-normal text-[#98A2B3]">{t.hint}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 rounded-lg bg-[#F9FAFB] px-4 py-3 text-xs text-[#475467]">
        {kind === BonusKind.INCENTIVE ? (
          <>
            <b>Partner incentive:</b> Collegepond-funded, 100% to the partner, shown as &quot;Bonus: &lt;scheme&gt;&quot; on their statement, claim, invoice and payout. A student qualifies if their application was <b>submitted</b> inside the scheme&apos;s dates and matches its country / university / intake. The slab is the partner&apos;s count of qualifying approved students, this one included. No uplift for earlier students. If several schemes match, the highest applies (Finance can change it at Approve commission). Claimable once the student&apos;s first instalment is collected and approved.
          </>
        ) : (
          <>
            <b>University volume bonus:</b> Collegepond income. It is billed to the university or vendor in full (no CP share) on its own invoice from University Billing › Vendor Billing › Volume bonus due. The partner gets no share. The count is per contract per <b>intake</b>, of students whose commission is approved inside the scheme&apos;s dates. <b>Retroactive:</b> once a slab is reached, every student counted in that intake earns it. Otherwise only students from the threshold on.
          </>
        )}
      </div>

      {kind === BonusKind.VOLUME && imported.length > 0 && (
        <div className="mb-4 rounded-lg border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3 text-xs text-[#B54708]">
          {imported.length} {imported.length === 1 ? "scheme was" : "schemes were"} copied from the old Commission Rates volume bonus tiers, switched off. Check each one&apos;s currency, dates and retroactive rule, then switch it on.
        </div>
      )}

      {!mounted || listQ.isLoading ? (
        <SkeletonTable rows={4} cols={6} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-[#E4E7EC] bg-white">
          <EmptyState
            label={`${kind === BonusKind.VOLUME ? "No volume bonus schemes yet." : "No partner incentive schemes yet."} ${canEdit ? "Add one to start applying it at Approve commission." : "Finance Managers add schemes here."}`}
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[#E4E7EC] bg-white">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Scheme</th>
                <th className={TH}>{kind === BonusKind.VOLUME ? "Contract" : "Scope"}</th>
                <th className={TH}>Dates</th>
                <th className={TH}>Slabs (per student)</th>
                <th className={TH}>Applied</th>
                <th className={TH}>Status</th>
                {canEdit && <th className={TH}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b border-[#F2F4F7] last:border-0">
                  <td className={TD}>
                    <div className="font-semibold text-[#101828]">{s.name}</div>
                    <div className="text-[11px] text-[#98A2B3]">
                      {s.currency}
                      {s.kind === BonusKind.VOLUME && (s.retroactive ? " · retroactive" : " · from threshold on")}
                    </div>
                    {s.notes && <div className="mt-0.5 max-w-xs text-[11px] text-[#667085]">{s.notes}</div>}
                  </td>
                  <td className={TD}>
                    {s.kind === BonusKind.VOLUME ? (
                      <>
                        <div>{s.contractLabel ?? "—"}</div>
                        <div className="text-[11px] text-[#98A2B3]">{intakeText(s.intakeMonth, s.intakeYear)}</div>
                      </>
                    ) : (
                      <>
                        <div>{s.country ? countryName(s.country) : "Any country"}</div>
                        <div className="text-[11px] text-[#98A2B3]">
                          {s.university ?? "Any university"} · {intakeText(s.intakeMonth, s.intakeYear)}
                        </div>
                      </>
                    )}
                  </td>
                  <td className={TD}>{windowText(s)}</td>
                  <td className={TD}>
                    {s.slabs.map((b) => (
                      <div key={b.minStudents}>
                        {slabText(b)} students · <b>{money(b.amountPerStudent, s.currency)}</b>
                      </div>
                    ))}
                  </td>
                  <td className={TD}>
                    {s.used === 0 ? (
                      <span className="text-[#98A2B3]">Not yet</span>
                    ) : (
                      <>
                        <div>{s.used} {s.used === 1 ? "student" : "students"}</div>
                        <div className="text-[11px] text-[#98A2B3]">{money(s.totalApplied, s.currency)}</div>
                      </>
                    )}
                  </td>
                  <td className={TD}>
                    <span className={`rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${STATE[s.state].tone}`}>{STATE[s.state].label}</span>
                    {s.used > 0 && <div className="mt-1 text-[11px] text-[#98A2B3]">🔒 terms locked</div>}
                  </td>
                  {canEdit && (
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <button className="mr-3 text-xs font-semibold text-[#1570EF] hover:underline" onClick={() => setEditing({ scheme: s, kind: s.kind as Kind })}>
                        Edit
                      </button>
                      <button className="mr-3 text-xs font-semibold text-[#1570EF] hover:underline" onClick={() => duplicate.mutate({ id: s.id })}>
                        Duplicate
                      </button>
                      <button
                        className="mr-3 text-xs font-semibold text-[#1570EF] hover:underline"
                        onClick={() => setActive.mutate({ id: s.id, isActive: !s.isActive })}
                      >
                        {s.isActive ? "Switch off" : "Switch on"}
                      </button>
                      {s.used === 0 && (
                        <button
                          className="text-xs font-semibold text-[#D92D20] hover:underline"
                          onClick={() => {
                            if (window.confirm(`Delete "${s.name}"? It hasn't been applied to anyone.`)) remove.mutate({ id: s.id });
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SchemeModal
          scheme={editing.scheme}
          kind={editing.kind}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null);
            void utils.bonusSchemes.invalidate();
            show(m);
          }}
        />
      )}
      <Toast message={toast} open={toast !== ""} onClose={() => setToast("")} />
    </div>
  );
}

type SlabDraft = { min: string; max: string; amount: string };

function SchemeModal({
  scheme,
  kind,
  onClose,
  onSaved,
}: {
  scheme: Scheme | null;
  kind: Kind;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const optsQ = api.bonusSchemes.options.useQuery();
  const locked = (scheme?.used ?? 0) > 0;
  const [name, setName] = useState(scheme?.name ?? "");
  const [currency, setCurrency] = useState(scheme?.currency ?? (kind === BonusKind.INCENTIVE ? "INR" : ""));
  const [from, setFrom] = useState(scheme?.activeFrom ?? "");
  const [to, setTo] = useState(scheme?.activeTo ?? "");
  const [contractId, setContractId] = useState(scheme?.contractId ? String(scheme.contractId) : "");
  const [country, setCountry] = useState(scheme?.country ?? "");
  const [universityId, setUniversityId] = useState(scheme?.universityId && kind === BonusKind.INCENTIVE ? String(scheme.universityId) : "");
  const [month, setMonth] = useState(scheme?.intakeMonth ? String(scheme.intakeMonth) : "");
  const [year, setYear] = useState(scheme?.intakeYear ? String(scheme.intakeYear) : "");
  const [retro, setRetro] = useState(scheme?.retroactive ?? false);
  const [active, setActive] = useState(scheme?.isActive ?? true);
  const [notes, setNotes] = useState(scheme?.notes ?? "");
  const [slabs, setSlabs] = useState<SlabDraft[]>(
    scheme?.slabs.map((s) => ({ min: String(s.minStudents), max: s.maxStudents == null ? "" : String(s.maxStudents), amount: String(s.amountPerStudent) })) ?? [
      { min: "1", max: "", amount: "" },
    ],
  );
  const [err, setErr] = useState("");
  const create = api.bonusSchemes.create.useMutation({ onSuccess: () => onSaved("Scheme added"), onError: (e) => setErr(e.message) });
  const update = api.bonusSchemes.update.useMutation({ onSuccess: () => onSaved("Scheme saved"), onError: (e) => setErr(e.message) });
  const contracts = optsQ.data?.contracts ?? [];
  const universities = optsQ.data?.universities ?? [];

  // A new volume scheme takes its contract's currency.
  const pickContract = (id: string) => {
    setContractId(id);
    const c = contracts.find((x) => String(x.id) === id);
    if (c?.currency && !scheme) setCurrency(c.currency);
  };
  const setSlab = (i: number, patch: Partial<SlabDraft>) => setSlabs((prev) => prev.map((s, k) => (k === i ? { ...s, ...patch } : s)));

  const submit = () => {
    setErr("");
    if (!currency) return setErr("Pick the currency.");
    const parsed = slabs.map((s) => ({
      minStudents: Number(s.min),
      maxStudents: s.max.trim() === "" ? null : Number(s.max),
      amountPerStudent: Number(s.amount),
    }));
    if (parsed.some((s) => !Number.isInteger(s.minStudents) || s.minStudents < 1 || !(s.amountPerStudent > 0))) {
      return setErr("Each slab needs a minimum of 1 or more and an amount above 0.");
    }
    const input = {
      kind,
      name: name.trim(),
      currency: currency as (typeof FINANCE_CURRENCIES)[number],
      activeFrom: from || null,
      activeTo: to || null,
      contractId: kind === BonusKind.VOLUME && contractId ? Number(contractId) : null,
      country: kind === BonusKind.INCENTIVE && country ? country : null,
      universityId: kind === BonusKind.INCENTIVE && universityId ? Number(universityId) : null,
      intakeMonth: month ? Number(month) : null,
      intakeYear: year ? Number(year) : null,
      retroactive: retro,
      isActive: active,
      notes: notes.trim() || null,
      slabs: parsed,
    };
    if (scheme) update.mutate({ ...input, id: scheme.id });
    else create.mutate(input);
  };

  const L = locked; // terms locked: only name, end date, notes, on/off
  return (
    <Modal
      open
      title={`${scheme ? "Edit" : "Add"} ${kind === BonusKind.VOLUME ? "university volume bonus" : "partner incentive"}`}
      width="w-[680px]"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={create.isPending || update.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      {L && (
        <p className="rounded-lg bg-[#FFFAEB] px-3 py-2 text-xs text-[#B54708]">
          Applied to {scheme!.used} {scheme!.used === 1 ? "student" : "students"}, so its terms are locked. You can rename it, set an end date, edit notes or switch it off. To change anything else, duplicate it.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <FormInput label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === BonusKind.VOLUME ? "e.g. UCD Sep 2026 volume bonus" : "e.g. Ireland Sep intake push"} />
        </div>
        <FormSelect
          label="Currency"
          required
          disabled={L}
          placeholder="Pick…"
          options={FINANCE_CURRENCIES.map((c) => ({ value: c, label: c }))}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        />
      </div>
      {kind === BonusKind.VOLUME ? (
        <FormSelect
          label="University contract"
          required
          disabled={L}
          placeholder={optsQ.isLoading ? "Loading…" : "Pick the contract (direct or vendor)…"}
          options={contracts.map((c) => ({ value: String(c.id), label: c.label }))}
          value={contractId}
          onChange={(e) => pickContract(e.target.value)}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormSelect
            label="Country"
            disabled={L}
            options={[{ value: "", label: "Any country" }, ...(optsQ.data?.countries ?? []).map((c) => ({ value: c, label: countryName(c) }))]}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          />
          <FormSelect
            label="University"
            disabled={L}
            options={[
              { value: "", label: "Any university" },
              ...universities.filter((u) => !country || u.country === country).map((u) => ({ value: String(u.id), label: u.name })),
            ]}
            value={universityId}
            onChange={(e) => setUniversityId(e.target.value)}
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <FormSelect
          label="Intake month"
          disabled={L}
          options={[{ value: "", label: "Any" }, ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))]}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
        <FormInput label="Intake year" type="number" placeholder="Any" disabled={L} value={year} onChange={(e) => setYear(e.target.value)} />
        <FormInput label={kind === BonusKind.VOLUME ? "Approved from" : "Submitted from"} type="date" disabled={L} value={from} onChange={(e) => setFrom(e.target.value)} />
        <FormInput label={kind === BonusKind.VOLUME ? "Approved to" : "Submitted to"} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-[#344054]">
          Slabs: number of students → amount per student{currency ? ` (${currency})` : ""}
        </div>
        <div className="space-y-2">
          {slabs.map((s, i) => (
            <div key={i} className="flex items-end gap-2">
              <FormInput label={i === 0 ? "From" : undefined} type="number" min={1} disabled={L} value={s.min} onChange={(e) => setSlab(i, { min: e.target.value })} />
              <FormInput label={i === 0 ? "To (blank = no limit)" : undefined} type="number" min={1} disabled={L} value={s.max} onChange={(e) => setSlab(i, { max: e.target.value })} />
              <FormInput label={i === 0 ? "Per student" : undefined} type="number" min={0} step="0.01" disabled={L} value={s.amount} onChange={(e) => setSlab(i, { amount: e.target.value })} />
              {!L && slabs.length > 1 && (
                <button className="mb-2.5 text-xs font-semibold text-[#D92D20]" onClick={() => setSlabs((prev) => prev.filter((_, k) => k !== i))}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        {!L && (
          <button
            className="mt-2 text-xs font-semibold text-[#1570EF] hover:underline"
            onClick={() => {
              const last = slabs[slabs.length - 1];
              const nextMin = last?.max ? String(Number(last.max) + 1) : "";
              setSlabs([...slabs, { min: nextMin, max: "", amount: "" }]);
            }}
          >
            + Add slab
          </button>
        )}
      </div>
      {kind === BonusKind.VOLUME && (
        <label className={`flex items-start gap-2 text-sm text-[#344054] ${L ? "opacity-60" : ""}`}>
          <input type="checkbox" className="mt-1" disabled={L} checked={retro} onChange={(e) => setRetro(e.target.checked)} />
          <span>
            <b>Retroactive</b>: once a slab is reached, every student counted in that intake earns it (e.g. on the 5th student, 5 × the amount is due). Off = only students from the threshold on.
          </span>
        </label>
      )}
      <label className="flex items-center gap-2 text-sm text-[#344054]">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Switched on (applied at Approve commission while inside its dates)
      </label>
      <FormTextarea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. approved by Suraj, email 16 Nov" />
      {err && <p className="text-xs font-medium text-[#F04438]">{err}</p>}
    </Modal>
  );
}
