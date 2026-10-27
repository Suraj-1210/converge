"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Modal } from "~/components/ui/modal";
import { PhoneInput } from "~/components/ui/phone-input";
import { StatCard } from "~/components/ui/stat-card";
import { StatusBadge } from "~/components/ui/status-badge";
import { Toast } from "~/components/ui/toast";
import { isValidEmail, isValidPhone, getExpectedPhoneDigits } from "~/lib/utils/validation";
import { AdminRole, AdminRoleLabel } from "~/server/db/enums";
import { api } from "~/trpc/react";
import { Skeleton } from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";
import { TabOverridesModal } from "~/components/admin/tab-overrides-modal";

const SUPER_ADMIN: number = AdminRole.SUPER_ADMIN;

type AdminUser = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  countryCode: string;
  role: number;
  departmentId: number | null;
  department: string | null;
  departmentActive: boolean | null;
  status: "active" | "inactive";
  lastLogin: string | null;
  createdAt: string;
};

type StatusFilter = "all" | "active" | "inactive";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

const STATUS_FILTER_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "all", label: "All Statuses" },
];

const ROLE_OPTIONS = (Object.values(AdminRole) as number[]).map((code) => ({
  value: String(code),
  label: AdminRoleLabel[code as AdminRole],
}));

function formatLastLogin(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ModalState {
  open: boolean;
  editing: AdminUser | null;
}

const emptyForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  countryCode: "+91",
  role: String(AdminRole.COUNSELLOR),
  departmentId: "",
  status: "active" as "active" | "inactive",
};

export default function UsersPage() {
  const utils = api.useUtils();
  const usersQuery = api.users.list.useQuery();
  const meQuery = api.authSession.me.useQuery();
  const isSuperAdmin = meQuery.data?.role === SUPER_ADMIN;
  // Department master (Settings -> Departments). Only Super Admins open the
  // Add/Edit form, and the endpoint is Super Admin only.
  const departmentsQuery = api.departments.list.useQuery(undefined, {
    enabled: isSuperAdmin,
  });

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [search, setSearch] = useState("");

  const [modal, setModal] = useState<ModalState>({ open: false, editing: null });
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };
  // The user whose tabs are being edited (Super Admins always have every tab).
  const [tabsFor, setTabsFor] = useState<number | null>(null);

  const createMut = api.users.create.useMutation({
    onSuccess: () => {
      void utils.users.list.invalidate();
      closeModal();
      showToast("User added successfully");
    },
    onError: (err) => {
      setErrors({ form: err.message });
    },
  });

  const updateMut = api.users.update.useMutation({
    onSuccess: () => {
      void utils.users.list.invalidate();
      closeModal();
      showToast("User updated successfully");
    },
    onError: (err) => {
      setErrors({ form: err.message });
    },
  });

  const setStatusMut = api.users.setStatus.useMutation({
    onSuccess: (data) => {
      void utils.users.list.invalidate();
      showToast(
        `${data.firstName} ${data.lastName} ${data.status === "active" ? "activated" : "deactivated"}`,
      );
    },
  });

  const removeMut = api.users.remove.useMutation({
    onSuccess: () => {
      void utils.users.list.invalidate();
      showToast("User deleted");
    },
    onError: (err) => showToast(err.message),
  });

  // Active departments only; a user already on a since-deactivated one keeps
  // it as an option while being edited, so saving doesn't silently clear it.
  const departmentOptions = useMemo(() => {
    const opts = (departmentsQuery.data ?? [])
      .filter((d) => d.active)
      .map((d) => ({ value: String(d.id), label: d.name }));
    const editing = modal.editing;
    if (
      editing?.departmentId != null &&
      !opts.some((o) => o.value === String(editing.departmentId))
    ) {
      opts.push({
        value: String(editing.departmentId),
        label: `${editing.department ?? "Unknown"} (inactive)`,
      });
    }
    return opts;
  }, [departmentsQuery.data, modal.editing]);

  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
  const total = users.length;
  const activeCount = users.filter((u) => u.status === "active").length;
  const inactiveCount = total - activeCount;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter !== "all" && u.status !== statusFilter) return false;
      if (q) {
        const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
        if (!fullName.includes(q) && !u.email.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [users, statusFilter, search]);

  function openAdd() {
    setForm(emptyForm);
    setErrors({});
    setModal({ open: true, editing: null });
  }

  function openEdit(u: AdminUser) {
    setForm({
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone,
      countryCode: u.countryCode || "+91",
      role: String(u.role),
      departmentId: u.departmentId != null ? String(u.departmentId) : "",
      status: u.status,
    });
    setErrors({});
    setModal({ open: true, editing: u });
  }

  function closeModal() {
    setModal({ open: false, editing: null });
    setErrors({});
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.firstName.trim()) next.firstName = "First name is required";
    if (!form.lastName.trim()) next.lastName = "Last name is required";
    if (!form.email.trim()) next.email = "Email is required";
    else if (!isValidEmail(form.email)) next.email = "Invalid email";

    const phoneDigits = form.phone.replace(/\s/g, "").replace(/[^0-9]/g, "");
    const expected = getExpectedPhoneDigits(form.countryCode);
    if (!phoneDigits) next.phone = "Phone is required";
    else if (!isValidPhone(form.phone, form.countryCode))
      next.phone = `Phone must be ${expected} digits for ${form.countryCode}`;

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleSave() {
    if (!validate()) return;

    const role = Number(form.role);
    const departmentId = form.departmentId ? Number(form.departmentId) : null;

    if (modal.editing) {
      const editing = modal.editing;
      updateMut.mutate({
        id: editing.id,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.replace(/\s/g, ""),
        countryCode: form.countryCode,
        role,
        departmentId,
      });

      // Status changes apply via a separate mutation.
      if (form.status !== editing.status) {
        setStatusMut.mutate({ id: editing.id, active: form.status === "active" });
      }
    } else {
      createMut.mutate({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.replace(/\s/g, ""),
        countryCode: form.countryCode,
        role,
        departmentId,
      });
    }
  }

  function handleDelete(u: AdminUser) {
    if (
      !confirm(
        `Delete ${u.firstName} ${u.lastName}? This permanently removes the account and cannot be undone.`,
      )
    ) {
      return;
    }
    removeMut.mutate({ id: u.id });
  }

  const isSaving = createMut.isPending || updateMut.isPending;

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">User Management</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Manage internal users and their access.
          </p>
        </div>
        {isSuperAdmin && (
          <Button onClick={openAdd} className="!h-[38px] !px-4">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add User
          </Button>
        )}
      </div>

      {/* Stat cards */}
      <Stagger className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FadeUp className="h-full">
          <StatCard label="Total Users" value={total} sub="All admin users" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard
            label="Active"
            value={activeCount}
            valueClassName="text-[#067647]"
            sub="Currently active"
          />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard
            label="Inactive"
            value={inactiveCount}
            valueClassName="text-[#667085]"
            sub="Deactivated accounts"
          />
        </FadeUp>
      </Stagger>

      {/* Filter bar */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-sm text-[#344054] outline-none focus:border-[#1570EF]"
        >
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <div className="flex h-[38px] items-center gap-2 rounded-lg border border-[#D0D5DD] bg-white px-3">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" className="h-4 w-4 stroke-[#98A2B3]">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email..."
            className="w-48 border-none bg-transparent text-sm text-[#344054] outline-none"
          />
        </div>
        <button
          onClick={() => {
            setStatusFilter("active");
            setSearch("");
          }}
          className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
        >
          Reset
        </button>
        <span className="ml-auto text-xs font-medium text-[#98A2B3]">
          Showing {filtered.length} of {total} users
        </span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
        <div className="flex items-center justify-between border-b border-[#E4E7EC] px-5 py-4">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-[#101828]">Team Members</h3>
            <span className="rounded-xl bg-[#EFF8FF] px-2.5 py-0.5 text-xs font-semibold text-[#1570EF]">
              {filtered.length}
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {["Name", "Email", "Department", "Phone", "Last Login", "Status", "Actions"].map((h) => (
                  <th
                    key={h}
                    className="border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-[#667085]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {usersQuery.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-[#F2F4F7] last:border-b-0">
                    {Array.from({ length: 7 }).map((_, c) => (
                      <td key={c} className="px-3.5 py-3.5">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3.5 py-8 text-center text-sm text-[#98A2B3]">
                    No users found
                  </td>
                </tr>
              ) : (
                filtered.map((u) => (
                  <tr
                    key={u.id}
                    className={`border-b border-[#F2F4F7] last:border-b-0 ${
                      u.status === "inactive" ? "[&_td:not(:last-child)]:opacity-60" : ""
                    }`}
                  >
                    <td className="px-3.5 py-3 text-sm font-semibold text-[#344054]">
                      {u.firstName} {u.lastName}
                    </td>
                    <td className="px-3.5 py-3 text-sm text-[#344054]">{u.email}</td>
                    <td className="px-3.5 py-3 text-sm text-[#344054]">
                      {u.department ?? "—"}
                      {u.departmentActive === false && (
                        <span className="ml-1 text-xs text-[#98A2B3]">(inactive)</span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 text-sm text-[#344054]">
                      {u.countryCode} {u.phone}
                    </td>
                    <td className="px-3.5 py-3 text-sm text-[#344054]">
                      {formatLastLogin(u.lastLogin)}
                    </td>
                    <td className="px-3.5 py-3">
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="px-3.5 py-3 text-sm">
                      {isSuperAdmin ? (
                        <>
                          <button
                            onClick={() => openEdit(u)}
                            className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]"
                          >
                            Edit
                          </button>
                          {u.role !== SUPER_ADMIN && (
                            <button
                              onClick={() => setTabsFor(u.id)}
                              className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]"
                            >
                              Tabs
                            </button>
                          )}
                          {u.status === "active" ? (
                            <button
                              onClick={() => setStatusMut.mutate({ id: u.id, active: false })}
                              disabled={setStatusMut.isPending}
                              className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#F04438] hover:bg-[#FEF3F2] disabled:opacity-50"
                            >
                              Deactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => setStatusMut.mutate({ id: u.id, active: true })}
                              disabled={setStatusMut.isPending}
                              className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#F79009] hover:bg-[#FFFAEB] disabled:opacity-50"
                            >
                              Activate
                            </button>
                          )}
                          {u.id !== meQuery.data?.id && (
                            <button
                              onClick={() => handleDelete(u)}
                              disabled={removeMut.isPending}
                              className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50"
                            >
                              Delete
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-[#98A2B3]">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit modal */}
      <Modal
        open={modal.open}
        title={modal.editing ? "Edit User" : "Add User"}
        onClose={closeModal}
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} className="!h-[38px] !px-4">
              Cancel
            </Button>
            <Button onClick={handleSave} loading={isSaving} className="!h-[38px] !px-4">
              Save User
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <FormInput
            label="First Name"
            required
            value={form.firstName}
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            error={!!errors.firstName}
            errorMessage={errors.firstName}
          />
          <FormInput
            label="Last Name"
            required
            value={form.lastName}
            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
            error={!!errors.lastName}
            errorMessage={errors.lastName}
          />
        </div>
        <FormInput
          label="Email"
          required
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          error={!!errors.email}
          errorMessage={errors.email}
        />
        <PhoneInput
          label="Phone"
          required
          countryCode={form.countryCode}
          phone={form.phone}
          onCountryCodeChange={(code) => setForm({ ...form, countryCode: code })}
          onPhoneChange={(phone) => setForm({ ...form, phone })}
          error={!!errors.phone}
          errorMessage={errors.phone}
        />
        <div className="grid grid-cols-2 gap-3">
          <FormSelect
            label="Role"
            options={ROLE_OPTIONS}
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          />
          <FormSelect
            label="Department"
            options={departmentOptions}
            placeholder={departmentsQuery.isLoading ? "Loading…" : "— None —"}
            value={form.departmentId}
            onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
          />
        </div>
        <p className="-mt-1 text-xs text-[#667085]">
          Departments are managed in{" "}
          <Link
            href="/admin/settings?section=departments"
            className="font-semibold text-[#1570EF] hover:underline"
          >
            Settings → Departments
          </Link>
          .
        </p>

        {modal.editing && (
          <FormSelect
            label="Status"
            options={STATUS_OPTIONS}
            value={form.status}
            onChange={(e) =>
              setForm({ ...form, status: e.target.value as "active" | "inactive" })
            }
          />
        )}
        {errors.form && (
          <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">
            {errors.form}
          </div>
        )}
      </Modal>

      <TabOverridesModal
        portal="admin"
        userId={tabsFor}
        onClose={() => setTabsFor(null)}
        toast={showToast}
      />

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </>
  );
}
