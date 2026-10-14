"use client";

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormSelect } from "~/components/ui/form-select";

const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";

type Data = RouterOutputs["counsellingTeams"]["list"];
type Lead = Data["leads"][number];
type Editing = { lead: Lead; memberIds: number[]; primarySpocId: string; autoAssign: boolean };

// Settings -> Counselling Teams. Super Admin only (the parent hides the
// section for everyone else and the API refuses them). Each Counsellor Lead
// gets a team of Counsellors and a primary SPOC. A lead sees their team's
// students, and with Auto Assign on, new students route to the partner's own
// counsellor or else the primary SPOC (src/server/staff-access.ts).
export function CounsellingTeamsPanel({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const listQ = api.counsellingTeams.list.useQuery();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState("");

  const saveMut = api.counsellingTeams.save.useMutation({
    onSuccess: async () => {
      await utils.counsellingTeams.invalidate();
      setEditing(null);
      toast("Team saved");
    },
    onError: (e) => setFormError(e.message),
  });

  const leads = listQ.data?.leads ?? [];
  const counsellors = listQ.data?.counsellors ?? [];
  const leadName = new Map(leads.map((l) => [l.id, l.name]));

  const openEdit = (lead: Lead) => {
    setFormError("");
    setEditing({
      lead,
      memberIds: lead.members.filter((m) => m.active).map((m) => m.id),
      primarySpocId: lead.primarySpocId ? String(lead.primarySpocId) : "",
      autoAssign: lead.autoAssign,
    });
  };

  const toggleMember = (id: number) => {
    if (!editing) return;
    const has = editing.memberIds.includes(id);
    const memberIds = has ? editing.memberIds.filter((x) => x !== id) : [...editing.memberIds, id];
    const spocGone = has && editing.primarySpocId === String(id);
    setEditing({
      ...editing,
      memberIds,
      primarySpocId: spocGone ? "" : editing.primarySpocId,
      autoAssign: spocGone ? false : editing.autoAssign,
    });
  };

  const save = () => {
    if (!editing) return;
    if (editing.autoAssign && !editing.primarySpocId) {
      setFormError("Choose a primary SPOC before turning Auto Assign on.");
      return;
    }
    setFormError("");
    saveMut.mutate({
      leadId: editing.lead.id,
      memberIds: editing.memberIds,
      primarySpocId: editing.primarySpocId ? Number(editing.primarySpocId) : null,
      autoAssign: editing.autoAssign,
    });
  };

  const spocOptions = editing
    ? counsellors
        .filter((c) => editing.memberIds.includes(c.id))
        .map((c) => ({ value: String(c.id), label: c.name }))
    : [];

  return (
    <div className="space-y-6">
      <div className={CARD}>
        <div className="border-b border-[#F2F4F7] px-5 py-4">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-[#101828]">Counselling Teams</h3>
            <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{leads.length}</span>
          </div>
          <p className="mt-0.5 text-sm text-[#667085]">
            Choose which Counsellors report to each Counsellor Lead, and the primary SPOC new leads go to when the lead&apos;s Auto Assign is on.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Counsellor Lead</th>
                <th className={TH}>Team</th>
                <th className={TH}>Primary SPOC</th>
                <th className={TH}>Auto Assign</th>
                <th className={`${TH} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listQ.isLoading ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">Loading teams…</td></tr>
              ) : listQ.error ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#B42318]">{listQ.error.message}</td></tr>
              ) : leads.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">No active Counsellor Leads. Add one on the Users page.</td></tr>
              ) : leads.map((l) => {
                const spoc = l.members.find((m) => m.id === l.primarySpocId);
                return (
                  <tr key={l.id} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={`${TD} font-semibold whitespace-nowrap text-[#101828]`}>{l.name}</td>
                    <td className={TD}>
                      {l.members.length === 0 ? (
                        <span className="text-xs text-[#98A2B3] italic">No counsellors yet</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {l.members.map((m) => (
                            <span key={m.id} className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.active ? "bg-[#F2F4F7] text-[#344054]" : "bg-[#FEF3F2] text-[#B42318]"}`} title={m.active ? undefined : "Inactive user"}>
                              {m.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>{spoc ? spoc.name : <span className="text-xs text-[#98A2B3] italic">Not set</span>}</td>
                    <td className={TD}>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${l.autoAssign ? "bg-[#ECFDF3] text-[#027A48]" : "bg-[#F2F4F7] text-[#667085]"}`}>
                        {l.autoAssign ? "On" : "Off"}
                      </span>
                    </td>
                    <td className={`${TD} text-right`}>
                      <button onClick={() => openEdit(l)} className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]">Edit team</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-[#98A2B3]">
        A Counsellor belongs to one team; adding them here moves them out of any other. Leads can also switch Auto Assign on or off from their own dashboard.
        Auto Assign never overrides a counsellor picked by hand, and only applies to new students.
      </p>

      {editing && (
        <Modal
          open
          title={`${editing.lead.name}'s team`}
          onClose={() => setEditing(null)}
          footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={saveMut.isPending} onClick={save}>Save</Button></>}
        >
          <div>
            <div className="mb-1.5 text-sm font-medium text-[#344054]">Counsellors reporting to {editing.lead.name}</div>
            {counsellors.length === 0 ? (
              <p className="text-sm text-[#98A2B3]">No active Counsellors.</p>
            ) : (
              <div className="max-h-[240px] space-y-1 overflow-y-auto rounded-lg border border-[#E4E7EC] p-2">
                {counsellors.map((c) => {
                  const other = c.leadId !== null && c.leadId !== editing.lead.id ? leadName.get(c.leadId) : undefined;
                  return (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-[#344054] hover:bg-[#F9FAFB]">
                      <input type="checkbox" checked={editing.memberIds.includes(c.id)} onChange={() => toggleMember(c.id)} />
                      <span>{c.name}</span>
                      {other && <span className="text-xs text-[#98A2B3]">· in {other}&apos;s team (will move)</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <FormSelect
            label="Primary SPOC"
            placeholder={spocOptions.length ? "Select a team member" : "Add team members first"}
            options={spocOptions}
            value={editing.primarySpocId}
            onChange={(e) => setEditing({ ...editing, primarySpocId: e.target.value })}
          />
          <label className="flex cursor-pointer items-start gap-2 text-sm text-[#344054]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={editing.autoAssign}
              onChange={(e) => setEditing({ ...editing, autoAssign: e.target.checked })}
            />
            <span>
              <span className="font-medium">Auto Assign new leads</span>
              <span className="block text-xs text-[#667085]">
                New students of {editing.lead.name}&apos;s partners go to the partner&apos;s own counsellor, or else the primary SPOC.
              </span>
            </span>
          </label>
          {formError && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{formError}</div>}
        </Modal>
      )}
    </div>
  );
}
