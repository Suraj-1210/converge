"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { StatusBadge } from "~/components/ui/status-badge";

const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";
const ARROW = "cursor-pointer rounded px-1.5 py-0.5 text-xs text-[#475467] hover:bg-[#F2F4F7] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent";

type Reason = {
  id: number;
  name: string;
  active: boolean;
  sortOrder: number;
  useCount: number;
};

type Editing = { id: number | null; name: string };

// Settings -> Adjustment Reasons. Super Admin only (the parent hides the
// section for everyone else and the API refuses them). These are the options
// of the "Reason" dropdown on a finance adjustment (Finance > Adjustments).
export function AdjustmentReasonsPanel({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const listQ = api.adjustmentReasons.list.useQuery();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState("");

  const refresh = async () => {
    await utils.adjustmentReasons.list.invalidate();
    await utils.adjustments.reasons.invalidate();
    await utils.commissionRates.listContracts.invalidate();
  };

  const createMut = api.adjustmentReasons.create.useMutation({
    onSuccess: async () => { await refresh(); setEditing(null); toast("Reason added"); },
    onError: (e) => setFormError(e.message),
  });
  const updateMut = api.adjustmentReasons.update.useMutation({
    onSuccess: async () => { await refresh(); setEditing(null); toast("Reason updated"); },
    onError: (e) => setFormError(e.message),
  });
  const toggleMut = api.adjustmentReasons.update.useMutation({
    onSuccess: async (_d, v) => { await refresh(); toast(v.active ? "Reason activated" : "Reason deactivated"); },
    onError: (e) => toast(e.message),
  });
  const moveMut = api.adjustmentReasons.move.useMutation({
    onSuccess: refresh,
    onError: (e) => toast(e.message),
  });
  const removeMut = api.adjustmentReasons.remove.useMutation({
    onSuccess: async () => { await refresh(); toast("Reason deleted"); },
    onError: (e) => toast(e.message),
  });

  const rows: Reason[] = listQ.data ?? [];

  const openAdd = () => { setFormError(""); setEditing({ id: null, name: "" }); };
  const openEdit = (c: Reason) => { setFormError(""); setEditing({ id: c.id, name: c.name }); };

  const save = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setFormError("Reason name is required"); return; }
    setFormError("");
    if (editing.id == null) createMut.mutate({ name });
    else updateMut.mutate({ id: editing.id, name });
  };

  const toggle = (c: Reason) => {
    if (c.active && c.useCount > 0 && !confirm(
      `Deactivate ${c.name}? The ${c.useCount} adjustment${c.useCount === 1 ? "" : "s"} using it keep it, but it won't be offered for new adjustments.`,
    )) return;
    toggleMut.mutate({ id: c.id, active: !c.active });
  };

  const remove = (c: Reason) => {
    if (!confirm(`Delete ${c.name}? This permanently removes the reason and cannot be undone.`)) return;
    removeMut.mutate({ id: c.id });
  };

  const editingRow = editing?.id != null ? rows.find((r) => r.id === editing.id) : undefined;

  return (
    <div className="space-y-6">
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3 border-b border-[#F2F4F7] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-[#101828]">Adjustment Reasons</h3>
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{rows.length}</span>
            </div>
            <p className="mt-0.5 text-sm text-[#667085]">The choices for an adjustment&apos;s &ldquo;Reason&rdquo; (Finance &rsaquo; Adjustments), in the order shown here. Staff-only: partners never see the reason.</p>
          </div>
          <Button className="!h-9 shrink-0 !text-[13px]" onClick={openAdd}>Add Reason</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} w-16`}>Order</th>
                <th className={TH}>Name</th>
                <th className={TH}>Adjustments</th>
                <th className={TH}>Status</th>
                <th className={`${TH} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listQ.isLoading ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">Loading reasons…</td></tr>
              ) : listQ.error ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#B42318]">{listQ.error.message}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">No reasons yet</td></tr>
              ) : rows.map((c, i) => (
                <tr key={c.id} className={`border-b border-[#F2F4F7] last:border-0 ${c.active ? "" : "[&_td:not(:last-child):not(:first-child)]:opacity-60"}`}>
                  <td className={`${TD} whitespace-nowrap`}>
                    <button
                      aria-label={`Move ${c.name} up`}
                      className={ARROW}
                      disabled={i === 0 || moveMut.isPending}
                      onClick={() => moveMut.mutate({ id: c.id, direction: "up" })}
                    >
                      ▲
                    </button>
                    <button
                      aria-label={`Move ${c.name} down`}
                      className={ARROW}
                      disabled={i === rows.length - 1 || moveMut.isPending}
                      onClick={() => moveMut.mutate({ id: c.id, direction: "down" })}
                    >
                      ▼
                    </button>
                  </td>
                  <td className={`${TD} font-semibold text-[#101828]`}>{c.name}</td>
                  <td className={TD}>{c.useCount}</td>
                  <td className={TD}><StatusBadge status={c.active ? "active" : "inactive"} /></td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <button onClick={() => openEdit(c)} className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]">Rename</button>
                    <button
                      onClick={() => toggle(c)}
                      disabled={toggleMut.isPending}
                      className={`ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold disabled:opacity-50 ${c.active ? "text-[#F04438] hover:bg-[#FEF3F2]" : "text-[#F79009] hover:bg-[#FFFAEB]"}`}
                    >
                      {c.active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      onClick={() => remove(c)}
                      disabled={removeMut.isPending || c.useCount > 0}
                      title={c.useCount > 0 ? `Used by ${c.useCount} adjustment${c.useCount === 1 ? "" : "s"}. Deactivate it instead` : undefined}
                      className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-[#98A2B3]">Inactive reasons stay on the adjustments already using them but aren&apos;t offered for new ones. A reason can only be deleted while no adjustment uses it. Renaming a reason renames it everywhere.</p>

      {editing && (
        <Modal
          open
          title={editing.id == null ? "Add Reason" : "Rename Reason"}
          onClose={() => setEditing(null)}
          footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={createMut.isPending || updateMut.isPending} onClick={save}>Save</Button></>}
        >
          <FormInput label="Name" required maxLength={150} placeholder="e.g. After Semester 1" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          {editingRow && editingRow.useCount > 0 && (
            <p className="text-xs text-[#667085]">
              {editingRow.useCount} adjustment{editingRow.useCount === 1 ? " uses" : "s use"} this reason; the new name will show on {editingRow.useCount === 1 ? "it" : "all of them"}.
            </p>
          )}
          {formError && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{formError}</div>}
        </Modal>
      )}
    </div>
  );
}
