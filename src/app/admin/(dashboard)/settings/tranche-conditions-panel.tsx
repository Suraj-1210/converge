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

type Condition = {
  id: number;
  name: string;
  active: boolean;
  sortOrder: number;
  trancheCount: number;
};

type Editing = { id: number | null; name: string };

// Settings -> Tranche Conditions. Super Admin only (the parent hides the
// section for everyone else and the API refuses them). These are the options
// of the "Condition" dropdown on a tranche (Commission Rates).
export function TrancheConditionsPanel({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const listQ = api.trancheConditions.list.useQuery();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState("");

  const refresh = async () => {
    await utils.trancheConditions.list.invalidate();
    await utils.commissionRates.trancheConditions.invalidate();
    await utils.commissionRates.listContracts.invalidate();
  };

  const createMut = api.trancheConditions.create.useMutation({
    onSuccess: async () => { await refresh(); setEditing(null); toast("Condition added"); },
    onError: (e) => setFormError(e.message),
  });
  const updateMut = api.trancheConditions.update.useMutation({
    onSuccess: async () => { await refresh(); setEditing(null); toast("Condition updated"); },
    onError: (e) => setFormError(e.message),
  });
  const toggleMut = api.trancheConditions.update.useMutation({
    onSuccess: async (_d, v) => { await refresh(); toast(v.active ? "Condition activated" : "Condition deactivated"); },
    onError: (e) => toast(e.message),
  });
  const moveMut = api.trancheConditions.move.useMutation({
    onSuccess: refresh,
    onError: (e) => toast(e.message),
  });
  const removeMut = api.trancheConditions.remove.useMutation({
    onSuccess: async () => { await refresh(); toast("Condition deleted"); },
    onError: (e) => toast(e.message),
  });

  const rows: Condition[] = listQ.data ?? [];

  const openAdd = () => { setFormError(""); setEditing({ id: null, name: "" }); };
  const openEdit = (c: Condition) => { setFormError(""); setEditing({ id: c.id, name: c.name }); };

  const save = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setFormError("Condition name is required"); return; }
    setFormError("");
    if (editing.id == null) createMut.mutate({ name });
    else updateMut.mutate({ id: editing.id, name });
  };

  const toggle = (c: Condition) => {
    if (c.active && c.trancheCount > 0 && !confirm(
      `Deactivate ${c.name}? The ${c.trancheCount} tranche${c.trancheCount === 1 ? "" : "s"} using it keep it, but it won't be offered when adding or editing a tranche.`,
    )) return;
    toggleMut.mutate({ id: c.id, active: !c.active });
  };

  const remove = (c: Condition) => {
    if (!confirm(`Delete ${c.name}? This permanently removes the condition and cannot be undone.`)) return;
    removeMut.mutate({ id: c.id });
  };

  const editingRow = editing?.id != null ? rows.find((r) => r.id === editing.id) : undefined;

  return (
    <div className="space-y-6">
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3 border-b border-[#F2F4F7] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-[#101828]">Tranche Conditions</h3>
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{rows.length}</span>
            </div>
            <p className="mt-0.5 text-sm text-[#667085]">The choices for a tranche&apos;s &ldquo;Condition&rdquo; on Commission Rates, in the order shown here.</p>
          </div>
          <Button className="!h-9 shrink-0 !text-[13px]" onClick={openAdd}>Add Condition</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} w-16`}>Order</th>
                <th className={TH}>Name</th>
                <th className={TH}>Tranches</th>
                <th className={TH}>Status</th>
                <th className={`${TH} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listQ.isLoading ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">Loading conditions…</td></tr>
              ) : listQ.error ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#B42318]">{listQ.error.message}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">No conditions yet</td></tr>
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
                  <td className={TD}>{c.trancheCount}</td>
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
                      disabled={removeMut.isPending || c.trancheCount > 0}
                      title={c.trancheCount > 0 ? `Used by ${c.trancheCount} tranche${c.trancheCount === 1 ? "" : "s"}. Deactivate it instead` : undefined}
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
      <p className="text-xs text-[#98A2B3]">Inactive conditions stay on the tranches already using them but aren&apos;t offered for new choices. A condition can only be deleted once no tranche uses it. Renaming a condition renames it on every tranche that uses it.</p>

      {editing && (
        <Modal
          open
          title={editing.id == null ? "Add Condition" : "Rename Condition"}
          onClose={() => setEditing(null)}
          footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={createMut.isPending || updateMut.isPending} onClick={save}>Save</Button></>}
        >
          <FormInput label="Name" required maxLength={150} placeholder="e.g. After Semester 1" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          {editingRow && editingRow.trancheCount > 0 && (
            <p className="text-xs text-[#667085]">
              {editingRow.trancheCount} tranche{editingRow.trancheCount === 1 ? " uses" : "s use"} this condition; the new name will show on {editingRow.trancheCount === 1 ? "it" : "all of them"}.
            </p>
          )}
          {formError && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{formError}</div>}
        </Modal>
      )}
    </div>
  );
}
