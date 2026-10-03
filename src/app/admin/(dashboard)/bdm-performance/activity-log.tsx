"use client";

import { useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { BDM_ACTIVITY_TYPE_CODES, BdmActivityType, BdmActivityTypeLabel } from "~/server/db/enums";
import {
  ActivityItem,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  EmptyState,
  PersonSelect,
  TargetSelect,
  codesWithLabels,
  parseTarget,
  todayIst,
  type Notify,
  type Option,
  type PartnerOption,
} from "./crm-ui";

type Scope = { bdmId?: number };

// Same order as the mock's type pills.
const TYPE_PILLS: { label: string; type?: number }[] = [
  { label: "All" },
  { label: "Calls", type: BdmActivityType.CALL },
  { label: "Meetings", type: BdmActivityType.MEETING },
  { label: "Emails", type: BdmActivityType.EMAIL },
  { label: "Notes", type: BdmActivityType.NOTE },
];
const TYPE_OPTIONS = codesWithLabels(BDM_ACTIVITY_TYPE_CODES, BdmActivityTypeLabel);

// The page reads the same query for the tab count, so keep the input identical.
export const activityListInput = (scope: Scope) => ({ ...scope, limit: 200 });

export function ActivityLog({
  scope,
  isSuperAdmin,
  defaultBdmId,
  bdms,
  partners,
  prospects,
  notify,
}: {
  scope: Scope;
  isSuperAdmin: boolean;
  defaultBdmId?: number;
  bdms: Option[];
  partners: PartnerOption[];
  prospects: Option[];
  notify: Notify;
}) {
  const listQ = api.bdmCrm.activity.list.useQuery(activityListInput(scope));
  const [type, setType] = useState<number | undefined>(undefined);
  const [target, setTarget] = useState("");
  const [logging, setLogging] = useState(false);

  const rows = useMemo(() => {
    const t = parseTarget(target);
    return (listQ.data ?? []).filter((a) => {
      if (type != null && a.type !== type) return false;
      if (!t) return true;
      if ("organizationId" in t) return a.target?.kind === "partner" && a.target.id === t.organizationId;
      return a.target?.kind === "prospect" && a.target.id === t.prospectId;
    });
  }, [listQ.data, type, target]);

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-3 border-b border-[#E4E7EC] px-5 py-4">
        <h3 className="text-[15px] font-semibold text-[#101828]">Activity Log</h3>
        <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{rows.length}</span>
        <button onClick={() => setLogging(true)} className={`ml-auto ${BTN_PRIMARY}`}>+ Log Activity</button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-b border-[#F2F4F7] px-5 py-3">
        <div className="flex flex-wrap gap-1.5">
          {TYPE_PILLS.map((p) => {
            const on = type === p.type;
            return (
              <button
                key={p.label}
                onClick={() => setType(p.type)}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold ${on ? "bg-[#1570EF] text-white" : "bg-[#F2F4F7] text-[#344054] hover:bg-[#E4E7EC]"}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto w-72">
          <TargetSelect label="" required={false} allLabel="All Partners & Prospects" value={target} onChange={setTarget} partners={partners} prospects={prospects} />
        </div>
      </div>

      {listQ.isLoading ? (
        <div className="px-5 py-8 text-center text-[13px] text-[#98A2B3]">Loading...</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={listQ.data?.length ? "No activity matches these filters" : "No activity logged yet"}
          body={listQ.data?.length ? "Try a different type or partner." : "Record calls, emails, meetings and notes with \"Log Activity\"."}
        />
      ) : (
        <div className="divide-y divide-[#F2F4F7]">
          {rows.map((a) => (
            <ActivityItem key={a.id} a={a} showBdm={isSuperAdmin} />
          ))}
        </div>
      )}

      {logging && (
        <LogActivityModal
          isSuperAdmin={isSuperAdmin}
          defaultBdmId={defaultBdmId}
          bdms={bdms}
          partners={partners}
          prospects={prospects}
          notify={notify}
          onClose={() => setLogging(false)}
        />
      )}
    </div>
  );
}

export function LogActivityModal({
  isSuperAdmin,
  defaultBdmId,
  bdms,
  partners,
  prospects,
  initialTarget = "",
  notify,
  onClose,
}: {
  isSuperAdmin: boolean;
  defaultBdmId?: number;
  bdms: Option[];
  partners: PartnerOption[];
  prospects: Option[];
  initialTarget?: string;
  notify: Notify;
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const today = todayIst();
  const [f, setF] = useState({
    type: "",
    target: initialTarget,
    occurredOn: today,
    durationMins: "",
    summary: "",
    followUpDate: "",
    bdmId: defaultBdmId != null ? String(defaultBdmId) : "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const log = api.bdmCrm.activity.log.useMutation({
    onSuccess: (r) => {
      void utils.bdmCrm.invalidate();
      notify(r.prospectFollowUpSet ? "Activity logged · prospect's next follow-up updated" : "Activity logged");
      onClose();
    },
    onError: (e) => notify(e.message),
  });
  const target = parseTarget(f.target);
  const missing = f.type === "" || !target || !f.occurredOn || !f.summary.trim();
  const submit = () => {
    if (missing || !target) return;
    log.mutate({
      type: Number(f.type),
      target,
      occurredOn: f.occurredOn,
      durationMins: f.durationMins === "" ? undefined : Number(f.durationMins),
      summary: f.summary,
      followUpDate: f.followUpDate || undefined,
      bdmId: isSuperAdmin && f.bdmId !== "" ? Number(f.bdmId) : undefined,
    });
  };
  return (
    <Modal
      open
      title="Log Activity"
      onClose={onClose}
      width="w-[600px]"
      footer={
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
          <button onClick={submit} disabled={log.isPending || missing} className={BTN_PRIMARY}>{log.isPending ? "Saving..." : "Log Activity"}</button>
        </>
      }
    >
      <div className="flex gap-3">
        <FormSelect label="Type" required value={f.type} onChange={set("type")} options={TYPE_OPTIONS} placeholder="Select type..." />
        <FormInput label="Date" required type="date" value={f.occurredOn} max={today} onChange={set("occurredOn")} />
      </div>
      <TargetSelect value={f.target} onChange={(v) => setF((s) => ({ ...s, target: v }))} partners={partners} prospects={prospects} />
      <FormTextarea label="Summary" required value={f.summary} onChange={set("summary")} rows={4} maxLength={1000} placeholder="What was discussed, outcomes, next steps" />
      <div className="flex gap-3">
        <FormInput label="Duration (minutes)" type="number" min={0} max={1440} value={f.durationMins} onChange={set("durationMins")} placeholder="e.g., 30" />
        <FormInput label="Follow-up date" type="date" min={f.occurredOn} value={f.followUpDate} onChange={set("followUpDate")} />
      </div>
      {isSuperAdmin && <PersonSelect label="Performed by" includeMe value={f.bdmId} onChange={(v) => setF((s) => ({ ...s, bdmId: v }))} bdms={bdms} />}
    </Modal>
  );
}
