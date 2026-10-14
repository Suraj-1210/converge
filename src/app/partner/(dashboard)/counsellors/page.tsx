"use client";

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { UserStatus } from "~/server/db/enums";
import { formatDate } from "~/components/dashboard/format";
import { EmptyState, SkeletonTable } from "~/components/dashboard/widgets";
import { Modal } from "~/components/ui/modal";
import { PhoneInput } from "~/components/ui/phone-input";
import { Toast } from "~/components/ui/toast";
import {
  ContactVerification,
  emailError,
  nameError,
  phoneError,
  type Channel,
  type Proofs,
} from "./contact-verify";

type Counsellor = RouterOutputs["counsellors"]["myCounsellors"][number];

const STATUS: Record<number, { label: string; cls: string }> = {
  [UserStatus.UNDER_REVIEW]: {
    label: "Pending Approval",
    cls: "bg-[#FFF6ED] text-[#B93815]",
  },
  [UserStatus.APPROVED]: { label: "Active", cls: "bg-[#ECFDF3] text-[#027A48]" },
  [UserStatus.REJECTED]: { label: "Rejected", cls: "bg-[#FEF3F2] text-[#B42318]" },
  [UserStatus.INACTIVE]: { label: "Deactivated", cls: "bg-[#F2F4F7] text-[#344054]" },
};

type Form = { firstName: string; lastName: string; email: string; countryCode: string; phone: string };
const EMPTY: Form = { firstName: "", lastName: "", email: "", countryCode: "+91", phone: "" };

const inputCls = (bad: boolean) =>
  `h-[38px] w-full rounded-lg border px-3 text-[13px] text-[#101828] outline-none focus:border-[#1570EF] ${bad ? "border-[#F04438]" : "border-[#D0D5DD]"}`;
const labelCls = "mb-1.5 block text-[13px] font-medium text-[#344054]";
const Req = () => <span className="text-[#F04438]">*</span>;

function formErrors(f: Form) {
  return {
    firstName: nameError(f.firstName),
    lastName: nameError(f.lastName),
    email: emailError(f.email),
    phone: phoneError(f.phone, f.countryCode),
  };
}

// Name / email / phone fields with required markers and inline errors (shown
// once a field is touched, or for every field after a save attempt).
function CounsellorFields({
  form,
  set,
  showAll,
}: {
  form: Form;
  set: (k: keyof Form, v: string) => void;
  showAll: boolean;
}) {
  const [touched, setTouched] = useState<Partial<Record<keyof Form, boolean>>>({});
  const errs = formErrors(form);
  const show = (k: keyof typeof errs) => (showAll || touched[k] ? errs[k] : "");
  const touch = (k: keyof Form) => () => setTouched((t) => ({ ...t, [k]: true }));
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {(["firstName", "lastName"] as const).map((k) => (
        <div key={k}>
          <label className={labelCls}>
            {k === "firstName" ? "First name" : "Last name"} <Req />
          </label>
          <input
            className={inputCls(!!show(k))}
            value={form[k]}
            maxLength={50}
            onChange={(e) => set(k, e.target.value)}
            onBlur={touch(k)}
            placeholder={k === "firstName" ? "Priya" : "Mehta"}
          />
          {show(k) && <p className="mt-1 text-[12px] text-[#F04438]">{show(k)}</p>}
        </div>
      ))}
      <div>
        <label className={labelCls}>
          Email <Req />
        </label>
        <input
          className={inputCls(!!show("email"))}
          type="email"
          value={form.email}
          maxLength={255}
          onChange={(e) => set("email", e.target.value)}
          onBlur={touch("email")}
          placeholder="priya@agency.com"
        />
        {show("email") && <p className="mt-1 text-[12px] text-[#F04438]">{show("email")}</p>}
      </div>
      <div onBlur={touch("phone")}>
        <PhoneInput
          label="Mobile number"
          required
          countryCode={form.countryCode}
          phone={form.phone}
          onCountryCodeChange={(v) => set("countryCode", v)}
          onPhoneChange={(v) => set("phone", v)}
          error={!!show("phone")}
          errorMessage={show("phone") || undefined}
        />
      </div>
    </div>
  );
}

export default function PartnerCounsellorsPage() {
  const me = api.auth.me.useQuery(undefined, { retry: false });
  const isOwner = me.data?.kind === "agency";
  const { data, isLoading, error } = api.counsellors.myCounsellors.useQuery(undefined, {
    enabled: isOwner,
    retry: false,
  });
  const utils = api.useUtils();
  const [toast, setToast] = useState("");
  const [editing, setEditing] = useState<Counsellor | null>(null);
  const [offboard, setOffboard] = useState<{ c: Counsellor; mode: "deactivate" | "remove" } | null>(null);

  const reactivate = api.counsellors.reactivateCounsellor.useMutation({
    onSuccess: (_r, v) => {
      const c = rows.find((r) => r.id === v.counsellorId);
      setToast(`${c?.name ?? "Counsellor"} reactivated`);
      void utils.counsellors.myCounsellors.invalidate();
    },
    onError: (e) => setToast(e.message),
  });

  if (me.data && !isOwner) {
    return (
      <div className="rounded-xl border border-[#E4E7EC] bg-white p-6 text-sm text-[#475467]">
        Only your agency&apos;s owner can manage counsellors.
      </div>
    );
  }

  const rows = data ?? [];
  const pending = rows.filter((r) => r.status === UserStatus.UNDER_REVIEW).length;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Counsellors</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Add the counsellors in your agency. Their email and phone are verified when you add
          them, and Collegepond reviews them before they go active.
        </p>
      </div>

      <AddCounsellorCard
        onAdded={(name) => {
          setToast(`${name} added — pending Collegepond approval`);
          void utils.counsellors.myCounsellors.invalidate();
        }}
      />

      {/* List */}
      <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
        <div className="flex items-center justify-between border-b border-[#E4E7EC] px-5 py-4">
          <h2 className="text-[15px] font-semibold text-[#101828]">Your Counsellors</h2>
          <span className="text-[13px] text-[#667085]">
            {rows.length} total{pending > 0 ? ` · ${pending} pending` : ""}
          </span>
        </div>
        {error ? (
          <div className="p-5 text-[13px] text-[#B42318]">{error.message}</div>
        ) : isLoading || me.isLoading ? (
          <SkeletonTable rows={4} cols={6} />
        ) : rows.length === 0 ? (
          <div className="p-5">
            <EmptyState label="No counsellors yet — add your first above." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[#E4E7EC] bg-[#F9FAFB] text-left text-[11px] font-semibold tracking-wide text-[#667085] uppercase">
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5">Phone</th>
                  <th className="px-4 py-2.5">Students</th>
                  <th className="px-4 py-2.5">Added</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const st = STATUS[c.status] ?? {
                    label: "Unknown",
                    cls: "bg-[#F2F4F7] text-[#344054]",
                  };
                  const inactive = c.status === UserStatus.INACTIVE;
                  return (
                    <tr
                      key={c.id}
                      className="border-b border-[#F2F4F7] text-[13px] last:border-0 hover:bg-[#FAFBFC]"
                    >
                      <td className="px-4 py-3 font-medium text-[#101828]">{c.name}</td>
                      <td className="px-4 py-3 text-[#475467]">{c.email}</td>
                      <td className="px-4 py-3 text-[#475467]">{c.phone}</td>
                      <td className="px-4 py-3 text-[#475467]">{c.studentCount}</td>
                      <td className="px-4 py-3 text-[#475467]">{formatDate(c.createdAt)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${st.cls}`}
                        >
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-3 text-[12px] font-semibold whitespace-nowrap">
                          <button
                            type="button"
                            className="text-[#1570EF] hover:underline"
                            onClick={() => setEditing(c)}
                          >
                            Edit
                          </button>
                          {inactive ? (
                            <button
                              type="button"
                              className="text-[#027A48] hover:underline disabled:opacity-50"
                              disabled={reactivate.isPending}
                              onClick={() => reactivate.mutate({ counsellorId: c.id })}
                            >
                              Reactivate
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="text-[#B54708] hover:underline"
                              onClick={() => setOffboard({ c, mode: "deactivate" })}
                            >
                              Deactivate
                            </button>
                          )}
                          <button
                            type="button"
                            className="text-[#B42318] hover:underline"
                            onClick={() => setOffboard({ c, mode: "remove" })}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <EditCounsellorModal
          counsellor={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setToast(`${editing.name}'s details saved`);
            setEditing(null);
            void utils.counsellors.myCounsellors.invalidate();
          }}
        />
      )}
      {offboard && (
        <OffboardModal
          counsellor={offboard.c}
          mode={offboard.mode}
          others={rows.filter((r) => r.id !== offboard.c.id && r.status === UserStatus.APPROVED)}
          onClose={() => setOffboard(null)}
          onDone={(moved) => {
            const what = offboard.mode === "remove" ? "removed" : "deactivated";
            setToast(
              `${offboard.c.name} ${what}${moved > 0 ? ` · ${moved} student${moved === 1 ? "" : "s"} reassigned` : ""}`,
            );
            setOffboard(null);
            void utils.counsellors.myCounsellors.invalidate();
            void utils.students.partnerList.invalidate();
          }}
        />
      )}
      <Toast message={toast} open={toast !== ""} onClose={() => setToast("")} />
    </>
  );
}

function AddCounsellorCard({ onAdded }: { onAdded: (name: string) => void }) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [proofs, setProofs] = useState<Proofs>({});
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  // Remounts the field/verification state after a successful add.
  const [round, setRound] = useState(0);
  const add = api.counsellors.addCounsellor.useMutation({
    onSuccess: () => {
      onAdded(`${form.firstName.trim()} ${form.lastName.trim()}`);
      setForm(EMPTY);
      setProofs({});
      setAttempted(false);
      setError("");
      setRound((r) => r + 1);
    },
    onError: (e) => setError(e.message),
  });
  const set = (k: keyof Form, v: string) => setForm((s) => ({ ...s, [k]: v }));
  const valid = Object.values(formErrors(form)).every((e) => e === "");
  const verified = !!proofs.email && !!proofs.phone;

  return (
    // #add-counsellor: the Students page's Assign dialog links here.
    <div id="add-counsellor" className="mb-6 scroll-mt-6 rounded-xl border border-[#E4E7EC] bg-white p-5">
      <h2 className="mb-1 text-sm font-semibold text-[#101828]">Add a counsellor</h2>
      <p className="mb-4 text-[12px] text-[#667085]">
        Fields marked <Req /> are required. Have the counsellor with you: they&apos;ll receive a
        code by email and by SMS to confirm their details.
      </p>
      <CounsellorFields key={round} form={form} set={set} showAll={attempted} />
      <div className="mt-4">
        <ContactVerification
          key={round}
          contact={form}
          channels={["email", "phone"]}
          proofs={proofs}
          onProofs={setProofs}
        />
      </div>
      {error !== "" && <p className="mt-3 text-[13px] text-[#F04438]">{error}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={add.isPending || (attempted && (!valid || !verified))}
          onClick={() => {
            setAttempted(true);
            if (!valid) return setError("Please fix the highlighted fields.");
            if (!verified) return setError("Verify the counsellor's email and phone first.");
            setError("");
            add.mutate({
              firstName: form.firstName.trim(),
              lastName: form.lastName.trim(),
              email: form.email.trim(),
              countryCode: form.countryCode,
              phone: form.phone.trim(),
              proofs: { email: proofs.email!, phone: proofs.phone! },
            });
          }}
          className="h-9 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1260d4] disabled:opacity-50"
        >
          {add.isPending ? "Adding…" : "Add Counsellor"}
        </button>
        <span className="text-[12px] text-[#98A2B3]">
          New counsellors show as Pending Approval until Collegepond reviews them.
        </span>
      </div>
    </div>
  );
}

function EditCounsellorModal({
  counsellor,
  onClose,
  onSaved,
}: {
  counsellor: Counsellor;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Form>({
    firstName: counsellor.firstName,
    lastName: counsellor.lastName,
    email: counsellor.email,
    countryCode: counsellor.phoneParts.countryCode || "+91",
    phone: counsellor.phoneParts.phone,
  });
  const [proofs, setProofs] = useState<Proofs>({});
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const save = api.counsellors.updateCounsellor.useMutation({
    onSuccess: onSaved,
    onError: (e) => setError(e.message),
  });
  const set = (k: keyof Form, v: string) => setForm((s) => ({ ...s, [k]: v }));

  // Only a changed email / phone needs verifying again.
  const changed: Channel[] = [];
  if (form.email.trim().toLowerCase() !== counsellor.email.toLowerCase()) changed.push("email");
  if (`${form.countryCode}${form.phone}`.replace(/\D/g, "") !== counsellor.phone.replace(/\D/g, "")) {
    changed.push("phone");
  }
  const valid = Object.values(formErrors(form)).every((e) => e === "");
  const verified = changed.every((ch) => !!proofs[ch]);

  return (
    <Modal
      open
      title={`Edit ${counsellor.name}`}
      onClose={onClose}
      width="w-[620px]"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-[#D0D5DD] px-4 text-[13px] font-semibold text-[#344054]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => {
              setAttempted(true);
              if (!valid) return setError("Please fix the highlighted fields.");
              if (!verified) return setError("Verify the new contact details first.");
              setError("");
              save.mutate({
                counsellorId: counsellor.id,
                firstName: form.firstName.trim(),
                lastName: form.lastName.trim(),
                email: form.email.trim(),
                countryCode: form.countryCode,
                phone: form.phone.trim(),
                proofs,
              });
            }}
            className="h-9 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1260d4] disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      }
    >
      <div className="p-6">
        <CounsellorFields form={form} set={set} showAll={attempted} />
        {changed.length > 0 && (
          <div className="mt-4">
            <ContactVerification
              contact={form}
              channels={changed}
              counsellorId={counsellor.id}
              proofs={proofs}
              onProofs={setProofs}
            />
          </div>
        )}
        {error && <p className="mt-3 text-[13px] text-[#F04438]">{error}</p>}
      </div>
    </Modal>
  );
}

// Deactivate or remove a counsellor. Their students must go somewhere: the
// owner by default, or another active counsellor.
function OffboardModal({
  counsellor,
  mode,
  others,
  onClose,
  onDone,
}: {
  counsellor: Counsellor;
  mode: "deactivate" | "remove";
  others: Counsellor[];
  onClose: () => void;
  onDone: (movedStudents: number) => void;
}) {
  const [target, setTarget] = useState<string>("owner");
  const [error, setError] = useState("");
  const opts = { onSuccess: (r: { movedStudents: number }) => onDone(r.movedStudents), onError: (e: { message: string }) => setError(e.message) };
  const deactivate = api.counsellors.deactivateCounsellor.useMutation(opts);
  const remove = api.counsellors.removeCounsellor.useMutation(opts);
  const busy = deactivate.isPending || remove.isPending;
  const n = counsellor.studentCount;

  return (
    <Modal
      open
      title={mode === "remove" ? `Remove ${counsellor.name}?` : `Deactivate ${counsellor.name}?`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-[#D0D5DD] px-4 text-[13px] font-semibold text-[#344054]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const input = {
                counsellorId: counsellor.id,
                reassignTo: target === "owner" ? null : Number(target),
              };
              if (mode === "remove") remove.mutate(input);
              else deactivate.mutate(input);
            }}
            className={`h-9 rounded-lg px-4 text-[13px] font-semibold text-white disabled:opacity-50 ${mode === "remove" ? "bg-[#D92D20] hover:bg-[#B42318]" : "bg-[#DC6803] hover:bg-[#B54708]"}`}
          >
            {busy ? "Working…" : mode === "remove" ? "Remove counsellor" : "Deactivate"}
          </button>
        </div>
      }
    >
      <div className="space-y-4 p-6 text-[13px] text-[#475467]">
        <p>
          {mode === "remove"
            ? "They'll be signed out, can't sign in again, and disappear from your team list. Their email and phone stay registered with Collegepond, so contact us if they need to come back."
            : "They'll be signed out and can't sign in until you reactivate them."}
        </p>
        {n > 0 ? (
          <div>
            <label className={labelCls}>
              Hand their {n} student{n === 1 ? "" : "s"} to <Req />
            </label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-[38px] w-full rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#101828] outline-none focus:border-[#1570EF]"
            >
              <option value="owner">Me (agency owner)</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p>They have no students assigned.</p>
        )}
        {error && <p className="text-[#F04438]">{error}</p>}
      </div>
    </Modal>
  );
}
