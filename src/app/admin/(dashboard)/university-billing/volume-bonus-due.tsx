"use client";

import { useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { money } from "~/lib/currency";

// Vendor Billing › Volume bonus due (16 Nov 2026). University volume bonuses
// grouped as Finance bills them — contract × intake × currency, e.g.
// "UCD · Direct · Sep 2026 intake · 5 × €500". Each is billed on its own
// vendor invoice (never mixed with base instalments), then collected through
// Record Payment → Collections like any instalment. Counted students who have
// since withdrawn or deferred, and retroactive top-ups on bonuses already
// invoiced, are flagged for Finance rather than re-billed.

type Group = inferRouterOutputs<AppRouter>["bonusSchemes"]["volumeBonusDue"][number];

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3 py-2.5 text-sm text-[#344054]";
const todayInput = () => new Date().toISOString().slice(0, 10);
const plusDaysInput = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

export function VolumeBonusDue({
  canEdit,
  onJumpToInvoice,
}: {
  canEdit: boolean;
  onJumpToInvoice: (invoiceId: number) => void;
}) {
  const q = api.bonusSchemes.volumeBonusDue.useQuery();
  const [open, setOpen] = useState<string | null>(null);
  const [invoicing, setInvoicing] = useState<Group | null>(null);
  const [msg, setMsg] = useState("");
  const groups = useMemo(() => q.data ?? [], [q.data]);
  if (q.isLoading || groups.length === 0) return null;
  const due = groups.filter((g) => g.dueCount > 0);
  const flags = groups.reduce((s, g) => s + g.flagCount, 0);

  return (
    <div className="rounded-xl border border-[#E4E7EC] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F2F4F7] px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-[#101828]">🎁 Volume bonus due</div>
          <div className="text-xs text-[#667085]">
            University volume bonuses, billed on their own invoice. Collegepond income: no partner share.
            {due.length > 0 ? ` ${due.length} to invoice.` : " Nothing to invoice."}
            {flags > 0 && <span className="font-semibold text-[#B54708]"> {flags} to check.</span>}
          </div>
        </div>
        {msg && <span className="text-xs font-medium text-[#067647]">{msg}</span>}
      </div>
      <div className="divide-y divide-[#F2F4F7]">
        {groups.map((g) => {
          const isOpen = open === g.key;
          const perStudent = Array.from(new Set(g.rows.filter((r) => !r.invoice).map((r) => r.amount)));
          return (
            <div key={g.key}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <button className="min-w-0 text-left" onClick={() => setOpen(isOpen ? null : g.key)}>
                  <div className="text-sm font-semibold text-[#101828]">
                    {isOpen ? "▾" : "▸"} {g.university} · {g.vendorName} · {g.intakeLabel} intake
                  </div>
                  <div className="text-xs text-[#667085]">
                    {g.students} {g.students === 1 ? "student" : "students"}
                    {g.dueCount > 0 &&
                      ` · due ${perStudent.length === 1 ? `${g.dueCount} × ${money(perStudent[0]!, g.currency)} = ` : ""}${money(g.dueAmount, g.currency)}`}
                    {g.invoicedAmount > 0 && ` · invoiced ${money(g.invoicedAmount, g.currency)}`}
                    {g.collectedAmount > 0 && ` · collected ${money(g.collectedAmount, g.currency)}`}
                    {g.flagCount > 0 && <span className="font-semibold text-[#B54708]"> · ⚠ {g.flagCount} to check</span>}
                  </div>
                </button>
                {canEdit && g.dueCount > 0 && (
                  <Button className="!h-9 !px-4 !text-[13px]" onClick={() => setInvoicing(g)}>
                    Invoice {money(g.dueAmount, g.currency)}
                  </Button>
                )}
              </div>
              {isOpen && (
                <div className="overflow-x-auto px-4 pb-3">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={TH}>Student</th>
                        <th className={TH}>Scheme · slab</th>
                        <th className={`${TH} text-right`}>Bonus</th>
                        <th className={TH}>Invoice</th>
                        <th className={TH}>Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r) => (
                        <tr key={r.commissionBonusId} className="border-b border-[#F2F4F7] last:border-0">
                          <td className={TD}>
                            <div className="font-medium text-[#101828]">{r.studentName}</div>
                            <div className="text-[11px] text-[#98A2B3]">
                              {r.cpStudentId}
                              {r.universityStudentId ? ` · ${r.universityStudentId}` : ""}
                            </div>
                          </td>
                          <td className={TD}>
                            {r.scheme ?? "Manual"} · {r.slab}
                            {r.count != null && <span className="text-[#98A2B3]"> · #{r.count}</span>}
                            {r.via === "retroactive" && <span className="ml-1 rounded bg-[#F4F3FF] px-1.5 text-[10px] font-semibold text-[#5925DC]">retroactive</span>}
                            {r.edited && <div className="text-[11px] text-[#667085]">Edited: {r.editReason}</div>}
                          </td>
                          <td className={`${TD} text-right font-semibold`}>{money(r.amount, g.currency)}</td>
                          <td className={TD}>
                            {r.invoice ? (
                              <button className="text-xs font-semibold text-[#1570EF] hover:underline" onClick={() => onJumpToInvoice(r.invoice!.id)}>
                                {r.invoice.number}
                              </button>
                            ) : (
                              <span className="text-xs text-[#98A2B3]">Not invoiced</span>
                            )}
                            {r.collected && <div className="text-[11px] font-semibold text-[#067647]">Collected</div>}
                            {r.awaitingApproval && <div className="text-[11px] text-[#B54708]">Collected · awaiting approval</div>}
                          </td>
                          <td className={`${TD} text-xs text-[#B54708]`}>
                            {r.flags.length === 0 ? <span className="text-[#98A2B3]">—</span> : r.flags.map((f) => <div key={f}>⚠ {f}</div>)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {invoicing && (
        <VolumeBonusInvoiceModal
          group={invoicing}
          onClose={() => setInvoicing(null)}
          onDone={(m) => {
            setInvoicing(null);
            setMsg(m);
          }}
        />
      )}
    </div>
  );
}

function VolumeBonusInvoiceModal({
  group,
  onClose,
  onDone,
}: {
  group: Group;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const due = group.rows.filter((r) => !r.invoice);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(due.filter((r) => r.flags.length === 0).map((r) => r.commissionBonusId)));
  const [number, setNumber] = useState("");
  const [date, setDate] = useState(todayInput());
  const [dueDate, setDueDate] = useState(plusDaysInput(30));
  const [notes, setNotes] = useState(`Volume bonus · ${group.university} · ${group.intakeLabel} intake`);
  const [err, setErr] = useState("");
  const create = api.bonusSchemes.createVolumeBonusInvoice.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.bonusSchemes.invalidate(), utils.universityBilling.invalidate(), utils.commissions.invalidate()]);
      onDone(`Invoice ${number} created`);
    },
    onError: (e) => setErr(e.message),
  });
  const total = due.filter((r) => picked.has(r.commissionBonusId)).reduce((s, r) => s + r.amount, 0);
  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Modal
      open
      title="Invoice volume bonus"
      width="w-[620px]"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={create.isPending}
            disabled={picked.size === 0 || !number.trim()}
            onClick={() =>
              create.mutate({
                commissionBonusIds: Array.from(picked),
                invoiceNumber: number.trim(),
                invoiceDate: date,
                dueDate: dueDate || undefined,
                notes: notes.trim() || undefined,
              })
            }
          >
            Create invoice · {money(Math.round(total * 100) / 100, group.currency)}
          </Button>
        </>
      }
    >
      <p className="text-sm text-[#475467]">
        {group.university} · {group.vendorName} · {group.intakeLabel} intake. Billed in {group.currency}, in full (no CP share), on its own invoice.
      </p>
      <div className="max-h-[260px] overflow-y-auto rounded-lg border border-[#E4E7EC]">
        {due.map((r) => (
          <label key={r.commissionBonusId} className="flex cursor-pointer items-start gap-3 border-b border-[#F2F4F7] px-3 py-2 last:border-0">
            <input type="checkbox" className="mt-1" checked={picked.has(r.commissionBonusId)} onChange={() => toggle(r.commissionBonusId)} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[#101828]">{r.studentName}</div>
              <div className="text-[11px] text-[#667085]">
                {r.scheme ?? "Manual"} · slab {r.slab}
              </div>
              {r.flags.map((f) => (
                <div key={f} className="text-[11px] text-[#B54708]">⚠ {f}</div>
              ))}
            </div>
            <div className="text-sm font-semibold text-[#101828]">{money(r.amount, group.currency)}</div>
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormInput label="Invoice number" required value={number} onChange={(e) => setNumber(e.target.value)} />
        <FormInput label="Invoice date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <FormInput label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <FormTextarea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <p className="text-xs font-medium text-[#F04438]">{err}</p>}
    </Modal>
  );
}
