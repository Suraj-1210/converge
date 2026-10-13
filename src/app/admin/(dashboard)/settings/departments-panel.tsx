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

type Department = {
  id: number;
  name: string;
  active: boolean;
  sortOrder: number;
  userCount: number;
};

type Editing = { id: number | null; name: string; sortOrder: string };

// Settings -> Departments. Super Admin only (the parent hides the section for
// everyone else and the API refuses them). Departments label internal staff on
// the Users page; they grant no permissions.
export function DepartmentsPanel({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const listQ = api.departments.list.useQuery();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState("");

  const refresh = async () => {
    await utils.departments.list.invalidate();
    await utils.users.list.invalidate();
  };

  const createMut = api.departments.create.useMutation({
    onSuccess: async () => { await refresh(); setEditing(null); toast("Department added"); },
    onError: (e) => setFormError(e.message),
  });
  const updateMut = api.departments.update.useMutation({
    onSuccess: async () => { await refresh(); setEditing(null); toast("Department updated"); },
    onError: (e) => setFormError(e.message),
  });
  const toggleMut = api.departments.update.useMutation({
    onSuccess: async (_d, v) => { await refresh(); toast(v.active ? "Department activated" : "Department deactivated"); },
    onError: (e) => toast(e.message),
  });
  const removeMut = api.departments.remove.useMutation({
    onSuccess: async () => { await refresh(); toast("Department deleted"); },
    onError: (e) => toast(e.message),
  });

  const rows: Department[] = listQ.data ?? [];

  const openAdd = () => { setFormError(""); setEditing({ id: null, name: "", sortOrder: "" }); };
  const openEdit = (d: Department) => { setFormError(""); setEditing({ id: d.id, name: d.name, sortOrder: String(d.sortOrder) }); };

  const save = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setFormError("Department name is required"); return; }
    const sortText = editing.sortOrder.trim();
    const sortOrder = sortText === "" ? undefined : Number(sortText);
    if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0)) {
      setFormError("Display order must be a whole number, 0 or more"); return;
    }
    setFormError("");
    if (editing.id == null) createMut.mutate({ name, sortOrder });
    else updateMut.mutate({ id: editing.id, name, sortOrder });
  };

  const toggle = (d: Department) => {
    if (d.active && d.userCount > 0 && !confirm(
      `Deactivate ${d.name}? The ${d.userCount} user${d.userCount === 1 ? "" : "s"} already in it keep it, but it won't be offered when adding or editing users.`,
    )) return;
    toggleMut.mutate({ id: d.id, active: !d.active });
  };

  const remove = (d: Department) => {
    if (!confirm(`Delete ${d.name}? This permanently removes the department and cannot be undone.`)) return;
    removeMut.mutate({ id: d.id });
  };

  return (
    <div className="space-y-6">
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3 border-b border-[#F2F4F7] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-[#101828]">Departments</h3>
              <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{rows.length}</span>
            </div>
            <p className="mt-0.5 text-sm text-[#667085]">Group internal team members on the Users page. Departments are organisational only — access is still set by each user&apos;s role.</p>
          </div>
          <Button className="!h-9 shrink-0 !text-[13px]" onClick={openAdd}>Add Department</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Display Order</th>
                <th className={TH}>Users</th>
                <th className={TH}>Status</th>
                <th className={`${TH} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listQ.isLoading ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">Loading departments…</td></tr>
              ) : listQ.error ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#B42318]">{listQ.error.message}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">No departments yet</td></tr>
              ) : rows.map((d) => (
                <tr key={d.id} className={`border-b border-[#F2F4F7] last:border-0 ${d.active ? "" : "[&_td:not(:last-child)]:opacity-60"}`}>
                  <td className={`${TD} font-semibold text-[#101828]`}>{d.name}</td>
                  <td className={TD}>{d.sortOrder}</td>
                  <td className={TD}>{d.userCount}</td>
                  <td className={TD}><StatusBadge status={d.active ? "active" : "inactive"} /></td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <button onClick={() => openEdit(d)} className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]">Edit</button>
                    <button
                      onClick={() => toggle(d)}
                      disabled={toggleMut.isPending}
                      className={`ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold disabled:opacity-50 ${d.active ? "text-[#F04438] hover:bg-[#FEF3F2]" : "text-[#F79009] hover:bg-[#FFFAEB]"}`}
                    >
                      {d.active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      onClick={() => remove(d)}
                      disabled={removeMut.isPending || d.userCount > 0}
                      title={d.userCount > 0 ? `Assigned to ${d.userCount} user${d.userCount === 1 ? "" : "s"} — deactivate it instead` : undefined}
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
      <p className="text-xs text-[#98A2B3]">Inactive departments stay on the users already in them but aren&apos;t offered when adding or editing users. A department can only be deleted once no user is in it.</p>

      {editing && (
        <Modal
          open
          title={editing.id == null ? "Add Department" : "Edit Department"}
          onClose={() => setEditing(null)}
          footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={createMut.isPending || updateMut.isPending} onClick={save}>Save</Button></>}
        >
          <FormInput label="Name" required maxLength={100} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <FormInput label="Display order" type="number" min={0} step={1} placeholder={editing.id == null ? "Auto: end of the list" : undefined} value={editing.sortOrder} onChange={(e) => setEditing({ ...editing, sortOrder: e.target.value })} />
          <p className="text-xs text-[#667085]">Lower numbers appear first in the Users form.</p>
          {formError && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{formError}</div>}
        </Modal>
      )}
    </div>
  );
}
