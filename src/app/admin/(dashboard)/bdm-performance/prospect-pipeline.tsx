"use client";

import { useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { SkeletonTable } from "~/components/dashboard/widgets";
import {
  PROSPECT_SOURCE_CODES,
  PROSPECT_STAGE_CODES,
  PROSPECT_TEMPERATURE_CODES,
  ProspectSourceLabel,
  ProspectStage,
  ProspectStageLabel,
  ProspectTemperatureLabel,
} from "~/server/db/enums";
import {
  ActivityItem,
  Avatar,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  EmptyState,
  PersonSelect,
  SELECT,
  STAGE_BADGE,
  TD,
  TEMP_STYLE,
  TH,
  codesWithLabels,
  daysAgo,
  fmtDay,
  type Notify,
  type Option,
  type PartnerOption,
} from "./crm-ui";

type Prospect = RouterOutputs["bdmCrm"]["prospect"]["list"][number];
type Scope = { bdmId?: number };

const CLOSED: number[] = [ProspectStage.CONVERTED, ProspectStage.LOST];
const STAGE_OPTIONS = codesWithLabels(PROSPECT_STAGE_CODES, ProspectStageLabel);
const SOURCE_OPTIONS = codesWithLabels(PROSPECT_SOURCE_CODES, ProspectSourceLabel);
const TEMP_OPTIONS = codesWithLabels(PROSPECT_TEMPERATURE_CODES, ProspectTemperatureLabel);

export function ProspectPipeline({
  scope,
  isSuperAdmin,
  defaultBdmId,
  bdms,
  partners,
  notify,
}: {
  scope: Scope;
  isSuperAdmin: boolean;
  defaultBdmId?: number;
  bdms: Option[];
  partners: PartnerOption[];
  notify: Notify;
}) {
  const utils = api.useUtils();
  const listQ = api.bdmCrm.prospect.list.useQuery(scope);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("open");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Prospect | null>(null);
  const [viewing, setViewing] = useState<Prospect | null>(null);
  const [moving, setMoving] = useState<{ p: Prospect; to: number } | null>(null);
  const [converting, setConverting] = useState<Prospect | null>(null);

  const setTemp = api.bdmCrm.prospect.update.useMutation({
    onSuccess: () => void utils.bdmCrm.prospect.invalidate(),
    onError: (e) => notify(e.message),
  });

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (listQ.data ?? []).filter((p) => {
      const matches = !s || [p.agencyName, p.contactName ?? "", p.city ?? ""].some((v) => v.toLowerCase().includes(s));
      const inStage = stageFilter === "" || (stageFilter === "open" ? !CLOSED.includes(p.stage) : p.stage === Number(stageFilter));
      return matches && inStage;
    });
  }, [listQ.data, search, stageFilter]);

  const onStagePick = (p: Prospect, value: string) => {
    const to = Number(value);
    if (to === p.stage) return;
    if (to === ProspectStage.CONVERTED) setConverting(p);
    else setMoving({ p, to });
  };

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-3 border-b border-[#E4E7EC] px-5 py-4">
        <h3 className="text-[15px] font-semibold text-[#101828]">Prospect Pipeline</h3>
        <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{rows.length}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agency, contact, city"
            className="h-9 w-56 rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]"
          />
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="h-9 rounded-lg border border-[#D0D5DD] px-3 text-sm text-[#344054] outline-none focus:border-[#1570EF]">
            <option value="open">Open stages</option>
            <option value="">All stages</option>
            {STAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button onClick={() => setCreating(true)} className={BTN_PRIMARY}>+ New Prospect</button>
        </div>
      </div>

      <div className="overflow-x-auto">
        {listQ.isLoading ? (
          <div className="p-4"><SkeletonTable rows={5} cols={7} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={listQ.data?.length ? "No prospects match these filters" : "No prospects yet"}
            body={listQ.data?.length ? "Try a different search or stage." : "Add an agency you're courting with \"New Prospect\"."}
          />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Agency</th>
                <th className={TH}>City</th>
                <th className={TH}>Temp</th>
                <th className={TH}>Stage</th>
                <th className={TH}>Days in Stage</th>
                <th className={TH}>Last Activity</th>
                <th className={TH}>Next Follow-up</th>
                <th className={TH}>Flag</th>
                {isSuperAdmin && <th className={TH}>BDM</th>}
                <th className={TH}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const temp = p.temperature != null ? TEMP_STYLE[p.temperature] : undefined;
                return (
                  <tr key={p.id} className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#F9FAFB]">
                    <td className={TD}>
                      <button onClick={() => setViewing(p)} className="flex items-center gap-2.5 text-left">
                        <Avatar name={p.agencyName} />
                        <span>
                          <span className="block font-semibold text-[#1570EF]">{p.agencyName}</span>
                          <span className="block text-[11px] text-[#98A2B3]">{p.contactName ?? "No contact yet"}</span>
                        </span>
                      </button>
                    </td>
                    <td className={TD}>{p.city ?? "—"}</td>
                    <td className={TD}>
                      <select
                        value={p.temperature ?? ""}
                        disabled={setTemp.isPending}
                        onChange={(e) => setTemp.mutate({ id: p.id, temperature: e.target.value === "" ? null : Number(e.target.value) })}
                        className={`h-7 rounded-full border px-2 text-[11px] font-semibold outline-none ${temp?.wrap ?? "border-[#E4E7EC] bg-white text-[#98A2B3]"}`}
                      >
                        <option value="">—</option>
                        {TEMP_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className={TD}>
                      {p.stage === ProspectStage.CONVERTED ? (
                        <span className="text-[11px] font-semibold text-[#027A48]" title={p.convertedOrg?.name}>Converted ✓</span>
                      ) : p.stage === ProspectStage.LOST ? (
                        <span className="text-[11px] text-[#98A2B3]">Lost</span>
                      ) : (
                        <select
                          value={p.stage}
                          onChange={(e) => onStagePick(p, e.target.value)}
                          className={`h-7 rounded-full border border-transparent px-2 text-[11px] font-semibold outline-none hover:border-[#98A2B3] ${STAGE_BADGE[p.stage] ?? ""}`}
                        >
                          {STAGE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className={TD}><span className="font-semibold text-[#101828]">{p.daysInStage}d</span></td>
                    <td className={`${TD} text-[12px] text-[#667085]`}>{p.lastActivity ? daysAgo(p.lastActivity) : "—"}</td>
                    <td className={`${TD} text-[12px] ${p.followUpDue ? "font-semibold text-[#B42318]" : ""}`}>{fmtDay(p.nextFollowUp)}</td>
                    <td className={TD}>
                      {p.flag === "atRisk" ? (
                        <span className="rounded-lg bg-[#FEF3F2] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#B42318]">At Risk</span>
                      ) : p.flag === "stale" ? (
                        <span className="rounded-lg bg-[#FFF6ED] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#B54708]">Stale</span>
                      ) : null}
                    </td>
                    {isSuperAdmin && <td className={`${TD} text-[12px]`}>{p.bdmName}</td>}
                    <td className={TD}>
                      <div className="flex gap-1.5">
                        <button onClick={() => setViewing(p)} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]">View</button>
                        <button onClick={() => setEditing(p)} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]">Edit</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {(creating || editing) && (
        <ProspectFormModal
          prospect={editing}
          isSuperAdmin={isSuperAdmin}
          defaultBdmId={defaultBdmId}
          bdms={bdms}
          notify={notify}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
      {moving && <AdvanceStageModal p={moving.p} to={moving.to} notify={notify} onClose={() => setMoving(null)} />}
      {converting && <ConvertModal p={converting} partners={partners} notify={notify} onClose={() => setConverting(null)} />}
      {viewing && (
        <ProspectDetailModal
          p={viewing}
          scope={scope}
          showBdm={isSuperAdmin}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
        />
      )}
    </div>
  );
}

function ProspectFormModal({
  prospect,
  isSuperAdmin,
  defaultBdmId,
  bdms,
  notify,
  onClose,
}: {
  prospect: Prospect | null;
  isSuperAdmin: boolean;
  defaultBdmId?: number;
  bdms: Option[];
  notify: Notify;
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const editing = prospect != null;
  const [f, setF] = useState({
    agencyName: prospect?.agencyName ?? "",
    contactName: prospect?.contactName ?? "",
    email: prospect?.email ?? "",
    phone: prospect?.phone ?? "",
    city: prospect?.city ?? "",
    source: prospect ? String(prospect.source) : "",
    temperature: prospect?.temperature != null ? String(prospect.temperature) : "",
    nextFollowUp: prospect?.nextFollowUp ?? "",
    notes: prospect?.notes ?? "",
    bdmId: defaultBdmId != null ? String(defaultBdmId) : "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const done = (msg: string) => {
    void utils.bdmCrm.invalidate();
    notify(msg);
    onClose();
  };
  const create = api.bdmCrm.prospect.create.useMutation({ onSuccess: () => done("Prospect created"), onError: (e) => notify(e.message) });
  const update = api.bdmCrm.prospect.update.useMutation({ onSuccess: () => done("Prospect updated"), onError: (e) => notify(e.message) });
  const busy = create.isPending || update.isPending;
  const missing = !f.agencyName.trim() || f.source === "" || (isSuperAdmin && !editing && f.bdmId === "");

  const submit = () => {
    if (missing) return;
    const common = {
      agencyName: f.agencyName,
      contactName: f.contactName,
      email: f.email,
      phone: f.phone,
      city: f.city,
      source: Number(f.source),
      notes: f.notes,
    };
    if (editing) {
      update.mutate({
        id: prospect.id,
        ...common,
        temperature: f.temperature === "" ? null : Number(f.temperature),
        nextFollowUp: f.nextFollowUp === "" ? null : f.nextFollowUp,
      });
    } else {
      create.mutate({
        ...common,
        temperature: f.temperature === "" ? undefined : Number(f.temperature),
        nextFollowUp: f.nextFollowUp || undefined,
        bdmId: isSuperAdmin ? Number(f.bdmId) : undefined,
      });
    }
  };

  return (
    <Modal
      open
      title={editing ? `Edit ${prospect.agencyName}` : "Create New Prospect"}
      onClose={onClose}
      width="w-[600px]"
      footer={
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
          <button onClick={submit} disabled={busy || missing} className={BTN_PRIMARY}>{busy ? "Saving..." : editing ? "Save Changes" : "Create Prospect"}</button>
        </>
      }
    >
      <FormInput label="Agency Name" required value={f.agencyName} onChange={set("agencyName")} placeholder="e.g., Bright Future Education" maxLength={255} />
      <div className="flex gap-3">
        <FormInput label="Contact Name" value={f.contactName} onChange={set("contactName")} placeholder="Full name" maxLength={255} />
        <FormInput label="City" value={f.city} onChange={set("city")} placeholder="e.g., Mumbai" maxLength={120} />
      </div>
      <div className="flex gap-3">
        <FormInput label="Phone" value={f.phone} onChange={set("phone")} placeholder="+91 XXXXX XXXXX" maxLength={20} />
        <FormInput label="Email" type="email" value={f.email} onChange={set("email")} placeholder="contact@agency.com" maxLength={255} />
      </div>
      <div className="flex gap-3">
        <FormSelect label="Source" required value={f.source} onChange={set("source")} options={SOURCE_OPTIONS} placeholder="Select source..." />
        <FormSelect label="Temperature" value={f.temperature} onChange={set("temperature")} options={TEMP_OPTIONS} placeholder="Not set" />
      </div>
      <div className="flex gap-3">
        <FormInput label="Next Follow-up" type="date" value={f.nextFollowUp} onChange={set("nextFollowUp")} />
        {isSuperAdmin && !editing ? (
          <PersonSelect label="BDM" required includeMe={false} value={f.bdmId} onChange={(v) => setF((s) => ({ ...s, bdmId: v }))} bdms={bdms} />
        ) : (
          <div className="flex-1" />
        )}
      </div>
      <FormTextarea label="Notes" value={f.notes} onChange={set("notes")} rows={3} maxLength={1000} />
    </Modal>
  );
}

function AdvanceStageModal({ p, to, notify, onClose }: { p: Prospect; to: number; notify: Notify; onClose: () => void }) {
  const utils = api.useUtils();
  const [note, setNote] = useState("");
  const [temperature, setTemperature] = useState("");
  const move = api.bdmCrm.prospect.advanceStage.useMutation({
    onSuccess: () => {
      void utils.bdmCrm.invalidate();
      notify(`Moved to ${ProspectStageLabel[to as ProspectStage]}`);
      onClose();
    },
    onError: (e) => notify(e.message),
  });
  return (
    <Modal
      open
      title="Advance Stage"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
          <button
            onClick={() => move.mutate({ id: p.id, toStage: to, note, temperature: temperature === "" ? undefined : Number(temperature) })}
            disabled={move.isPending}
            className={BTN_PRIMARY}
          >
            {move.isPending ? "Saving..." : "Confirm Stage Change"}
          </button>
        </>
      }
    >
      <p className="text-sm text-[#344054]">
        Move <span className="font-semibold text-[#101828]">{p.agencyName}</span> from{" "}
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STAGE_BADGE[p.stage] ?? ""}`}>{p.stageLabel}</span> to{" "}
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STAGE_BADGE[to] ?? ""}`}>{ProspectStageLabel[to as ProspectStage]}</span>
      </p>
      {to === ProspectStage.LOST && <p className="rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">This closes the prospect. It can be reopened later from its detail view.</p>}
      <FormTextarea label="Note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} placeholder="Add a note for this stage change..." />
      <FormSelect label="Temperature" value={temperature} onChange={(e) => setTemperature(e.target.value)} options={TEMP_OPTIONS} placeholder="Keep current" />
    </Modal>
  );
}

function ConvertModal({ p, partners, notify, onClose }: { p: Prospect; partners: PartnerOption[]; notify: Notify; onClose: () => void }) {
  const utils = api.useUtils();
  const [orgId, setOrgId] = useState("");
  const convert = api.bdmCrm.prospect.convert.useMutation({
    onSuccess: () => {
      void utils.bdmCrm.invalidate();
      notify(`${p.agencyName} marked as converted`);
      onClose();
    },
    onError: (e) => notify(e.message),
  });
  return (
    <Modal
      open
      title="Convert to Partner"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
          <button onClick={() => convert.mutate({ id: p.id, organizationId: Number(orgId) })} disabled={convert.isPending || orgId === ""} className={BTN_PRIMARY}>
            {convert.isPending ? "Saving..." : "Convert"}
          </button>
        </>
      }
    >
      <p className="text-sm text-[#344054]">
        Link <span className="font-semibold text-[#101828]">{p.agencyName}</span> to the partner organization it became. The prospect moves to Converted and keeps its history.
      </p>
      {partners.length === 0 ? (
        <p className="rounded-lg bg-[#FFFAEB] px-3 py-2 text-[13px] text-[#B54708]">No partner organizations are available to link. Onboard the partner first, then convert.</p>
      ) : (
        <div className="flex flex-col">
          <label className="mb-1.5 text-[13px] font-medium text-[#344054]">Partner organization <span className="text-[#F04438]">*</span></label>
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className={SELECT}>
            <option value="">Select partner...</option>
            {partners.map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.name}
                {o.city && o.city !== "—" ? ` (${o.city})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
    </Modal>
  );
}

function ProspectDetailModal({
  p,
  scope,
  showBdm,
  onClose,
  onEdit,
}: {
  p: Prospect;
  scope: Scope;
  showBdm: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  const utils = api.useUtils();
  const historyQ = api.bdmCrm.prospect.history.useQuery({ id: p.id });
  const actsQ = api.bdmCrm.activity.list.useQuery({ ...scope, prospectId: p.id, limit: 50 });
  const [reopenTo, setReopenTo] = useState(String(ProspectStage.CONTACTED));
  const reopen = api.bdmCrm.prospect.advanceStage.useMutation({
    onSuccess: () => {
      void utils.bdmCrm.invalidate();
      onClose();
    },
  });
  const temp = p.temperature != null ? TEMP_STYLE[p.temperature] : undefined;
  const facts: [string, string][] = [
    ["Contact", p.contactName ?? "—"],
    ["Phone", p.phone ?? "—"],
    ["Email", p.email ?? "—"],
    ["City", p.city ?? "—"],
    ["Source", p.sourceLabel],
    ["Next follow-up", fmtDay(p.nextFollowUp)],
    ["Added", fmtDay(p.createdAt.slice(0, 10))],
    ...(showBdm ? ([["BDM", p.bdmName]] as [string, string][]) : []),
  ];
  return (
    <Modal
      open
      title={p.agencyName}
      onClose={onClose}
      width="w-[680px]"
      footer={
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Close</button>
          <button onClick={onEdit} className={BTN_PRIMARY}>Edit Details</button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STAGE_BADGE[p.stage] ?? ""}`}>{p.stageLabel}</span>
        {p.temperatureLabel && (
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${temp?.wrap ?? ""}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${temp?.dot ?? ""}`} />
            {p.temperatureLabel}
          </span>
        )}
        <span className="text-[12px] text-[#667085]">{p.daysInStage}d in stage</span>
        {p.convertedOrg && <span className="text-[12px] font-semibold text-[#027A48]">Partner: {p.convertedOrg.name}</span>}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-lg bg-[#F9FAFB] p-4">
        {facts.map(([k, v]) => (
          <div key={k}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#98A2B3]">{k}</div>
            <div className="break-words text-[13px] text-[#101828]">{v}</div>
          </div>
        ))}
      </div>
      {p.notes && <div className="whitespace-pre-wrap rounded-lg border border-[#E4E7EC] p-3 text-[13px] text-[#344054]">{p.notes}</div>}

      {p.stage === ProspectStage.LOST && (
        <div className="flex items-end gap-2 rounded-lg border border-[#E4E7EC] p-3">
          <div className="flex flex-1 flex-col">
            <label className="mb-1.5 text-[13px] font-medium text-[#344054]">Reopen at stage</label>
            <select value={reopenTo} onChange={(e) => setReopenTo(e.target.value)} className={SELECT}>
              {STAGE_OPTIONS.filter((o) => !CLOSED.includes(Number(o.value))).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => reopen.mutate({ id: p.id, toStage: Number(reopenTo), note: "Reopened" })}
            disabled={reopen.isPending}
            className={BTN_SECONDARY}
          >
            Reopen
          </button>
        </div>
      )}

      <div>
        <div className="mb-2 text-[13px] font-semibold text-[#101828]">Stage history</div>
        {historyQ.isLoading ? (
          <div className="text-[13px] text-[#98A2B3]">Loading...</div>
        ) : (
          <ol className="space-y-2 border-l-2 border-[#E4E7EC] pl-4">
            {(historyQ.data ?? []).map((h) => (
              <li key={h.id} className="text-[13px]">
                <span className="font-semibold text-[#101828]">{h.fromLabel ? `${h.fromLabel} → ${h.toLabel}` : h.toLabel}</span>
                <span className="text-[#98A2B3]"> · {fmtDay(h.changedAt.slice(0, 10))}{h.changedBy ? ` · ${h.changedBy}` : ""}</span>
                {h.note && <div className="text-[#667085]">{h.note}</div>}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div>
        <div className="mb-1 text-[13px] font-semibold text-[#101828]">Recent activity</div>
        {actsQ.isLoading ? (
          <div className="text-[13px] text-[#98A2B3]">Loading...</div>
        ) : (actsQ.data ?? []).length === 0 ? (
          <div className="text-[13px] text-[#98A2B3]">No activity logged yet.</div>
        ) : (
          <div className="-mx-5 divide-y divide-[#F2F4F7]">
            {(actsQ.data ?? []).map((a) => (
              <ActivityItem key={a.id} a={a} showBdm={showBdm} showTarget={false} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
