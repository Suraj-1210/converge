"use client";

import { Fragment, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { DashboardCard, SkeletonTable, EmptyState } from "~/components/dashboard/widgets";
import { formatDate } from "~/components/dashboard/format";
import { PayeeTags } from "~/components/admin/payee-tags";
import { money } from "~/lib/currency";

type RO = inferRouterOutputs<AppRouter>;
type Collection = RO["universityBilling"]["collections"][number];

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap text-[#667085]";
const TD = "px-3.5 py-3 text-sm whitespace-nowrap text-[#344054]";

const dateTime = (d: Date | string) =>
  new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

// Commission Ledger › Collections: every vendor payment Finance recorded, as
// a collection record. Its tranches stay "Collected, awaiting approval" (not
// claimable) until a Super Admin / Finance Manager approves it here — one at
// a time or in bulk. Finance Executives see the queue read-only.
export function CollectionsTab({ canApprove, onToast }: { canApprove: boolean; onToast: (m: string) => void }) {
  const utils = api.useUtils();
  const q = api.universityBilling.collections.useQuery();
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const [show, setShow] = useState<"pending" | "approved" | "all">("pending");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<number>>(new Set());

  const approve = api.universityBilling.approveCollections.useMutation({
    onSuccess: (r) => {
      void utils.universityBilling.invalidate();
      void utils.commissions.invalidate();
      setSelected(new Set());
      onToast(
        `${r.approved} collection${r.approved === 1 ? "" : "s"} approved — ${r.tranches} tranche${r.tranches === 1 ? " is" : "s are"} now claimable and the partners have been told`,
      );
    },
    onError: (e) => onToast(e.message),
  });

  const pendingCount = rows.filter((r) => r.pending).length;
  const visible = rows.filter((r) => (show === "all" ? true : show === "pending" ? r.pending : !r.pending));
  const selectable = visible.filter((r) => r.pending).map((r) => r.id);
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));
  const toggle = (id: number) =>
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleOpen = (id: number) =>
    setOpen((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const cols = canApprove ? 11 : 10;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {([
          { id: "pending", label: `Awaiting approval (${pendingCount})` },
          { id: "approved", label: "Approved" },
          { id: "all", label: "All" },
        ] as const).map((f) => (
          <button
            key={f.id}
            onClick={() => setShow(f.id)}
            className={`rounded-full border px-3 py-1 text-[13px] font-semibold ${
              show === f.id ? "border-[#1570EF] bg-[#EFF8FF] text-[#1570EF]" : "border-[#D0D5DD] text-[#344054] hover:bg-[#F9FAFB]"
            }`}
          >
            {f.label}
          </button>
        ))}
        {!canApprove && pendingCount > 0 && (
          <span className="text-xs text-[#667085]">A Finance Manager or Super Admin approves collections.</span>
        )}
      </div>
      <DashboardCard title={`Collections (${visible.length})`} bodyClassName="p-0">
        {q.isLoading ? (
          <SkeletonTable rows={5} cols={8} />
        ) : visible.length === 0 ? (
          <EmptyState
            label={
              show === "pending"
                ? "No collections awaiting approval. Payments recorded in University Billing appear here."
                : "No collections yet."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: 1250 }}>
              <thead>
                <tr>
                  {canApprove && (
                    <th className={`${TH} w-10`}>
                      <input
                        type="checkbox"
                        aria-label="Select all awaiting approval"
                        checked={allSelected}
                        disabled={selectable.length === 0}
                        onChange={(e) =>
                          setSelected((p) => {
                            const n = new Set(p);
                            for (const id of selectable) {
                              if (e.target.checked) n.add(id);
                              else n.delete(id);
                            }
                            return n;
                          })
                        }
                      />
                    </th>
                  )}
                  <th className={`${TH} w-8`}></th>
                  <th className={TH}>Payment Date</th>
                  <th className={TH}>Vendor Invoice</th>
                  <th className={TH}>Students</th>
                  <th className={TH}>Claimed vs Received</th>
                  <th className={TH}>Exchange Rate</th>
                  <th className={TH}>INR Equivalent</th>
                  <th className={TH}>Reference</th>
                  <th className={TH}>Recorded</th>
                  <th className={TH}>Approval</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <Fragment key={c.id}>
                    <CollectionRow
                      c={c}
                      canApprove={canApprove}
                      checked={selected.has(c.id)}
                      onCheck={() => toggle(c.id)}
                      open={open.has(c.id)}
                      onToggle={() => toggleOpen(c.id)}
                    />
                    {open.has(c.id) && (
                      <tr className="bg-[#F9FAFB]">
                        <td colSpan={cols} className="px-4 py-3">
                          <CollectionLines c={c} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashboardCard>

      {canApprove && selected.size > 0 && (
        <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-[#E4E7EC] bg-white px-5 py-3 shadow-[0_8px_24px_rgba(16,24,40,0.12)]">
          <span className="text-sm font-semibold text-[#101828]">{selected.size} selected</span>
          <Button
            className="!h-9 !px-4 !text-[13px]"
            loading={approve.isPending}
            onClick={() => approve.mutate({ paymentIds: Array.from(selected) })}
          >
            Approve collection{selected.size === 1 ? "" : "s"}
          </Button>
          <button className="text-[13px] font-semibold text-[#667085] hover:underline" onClick={() => setSelected(new Set())}>
            ✕ Clear
          </button>
        </div>
      )}
    </>
  );
}

function CollectionRow({
  c,
  canApprove,
  checked,
  onCheck,
  open,
  onToggle,
}: {
  c: Collection;
  canApprove: boolean;
  checked: boolean;
  onCheck: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const short = c.amountExpected != null && c.amountReceived < c.amountExpected * 0.99;
  return (
    <tr className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
      {canApprove && (
        <td className={`${TD} w-10`}>
          <input type="checkbox" disabled={!c.pending} checked={checked} onChange={onCheck} aria-label={`Select ${c.invoiceNumber}`} />
        </td>
      )}
      <td className={`${TD} w-8`}>
        <button onClick={onToggle} aria-label="Show students">
          <svg viewBox="0 0 24 24" className={`h-4 w-4 text-[#667085] transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
        </button>
      </td>
      <td className={TD}>{formatDate(c.paymentDate)}</td>
      <td className={TD}>
        <span className="font-semibold text-[#101828]">{c.invoiceNumber}</span>
        <span className="block text-xs text-[#98A2B3]">{c.vendorName}{c.isFinal ? " · final payment" : ""}</span>
      </td>
      <td className={TD}>
        <button className="font-medium text-[#1570EF] hover:underline" onClick={onToggle}>
          {c.lines.length === 0 ? "Part payment" : `${new Set(c.lines.map((l) => l.commissionId)).size} student${new Set(c.lines.map((l) => l.commissionId)).size === 1 ? "" : "s"}`}
        </button>
      </td>
      <td className={TD}>
        <span className="text-[#667085]">{c.amountExpected == null ? "—" : money(c.amountExpected, c.currency)}</span>
        <span className="mx-1 text-[#98A2B3]">→</span>
        <span className={`font-semibold ${short ? "text-[#B42318]" : "text-[#101828]"}`}>{money(c.amountReceived, c.currency)}</span>
        <span className="block text-xs text-[#98A2B3]">{c.currency}{short ? " · less than invoiced" : ""}</span>
      </td>
      <td className={TD}>1 {c.currency} = ₹{c.exchangeRate.toFixed(2)}</td>
      <td className={`${TD} font-semibold text-[#101828]`}>{money(c.amountInr, "INR")}</td>
      <td className={TD}>{c.reference ?? "—"}</td>
      <td className={TD}>
        {c.recordedBy ?? "—"}
        <span className="block text-xs text-[#98A2B3]">{dateTime(c.recordedAt)}</span>
      </td>
      <td className={TD}>
        {c.pending ? (
          <span className="rounded-[10px] bg-[#FFF6ED] px-2.5 py-0.5 text-[11px] font-semibold text-[#B54708]">Awaiting approval</span>
        ) : (
          <>
            <span className="rounded-[10px] bg-[#ECFDF3] px-2.5 py-0.5 text-[11px] font-semibold text-[#067647]">Approved</span>
            <span className="mt-0.5 block text-xs text-[#98A2B3]">
              {c.approvedBy ?? "—"}
              {c.approvedAt ? ` · ${dateTime(c.approvedAt)}` : ""}
            </span>
          </>
        )}
      </td>
    </tr>
  );
}

function CollectionLines({ c }: { c: Collection }) {
  if (c.lines.length === 0) {
    return <p className="text-sm text-[#667085]">Part payment — it completes no tranche, so it unlocks nothing to claim.{c.notes ? ` Note: ${c.notes}` : ""}</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-[#E4E7EC] bg-white">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={TH}>Student</th>
            <th className={TH}>University</th>
            <th className={TH}>Partner</th>
            <th className={TH}>Tranche</th>
            <th className={TH}>Invoiced ({c.currency})</th>
            <th className={TH}>INR</th>
          </tr>
        </thead>
        <tbody>
          {c.lines.map((l, i) => (
            <tr key={`${l.commissionId}-${i}`} className="border-b border-[#F2F4F7] last:border-0">
              <td className={TD}>
                <span className="font-medium text-[#101828]">{l.studentName}</span>
                <span className="block text-xs text-[#98A2B3]">
                  {l.universityStudentId ? `Uni ID ${l.universityStudentId} · ` : "No university ID · "}
                  {l.cpStudentId}
                </span>
              </td>
              <td className={TD}>
                {l.university}
                <span className="block text-xs text-[#98A2B3]">{l.program}</span>
              </td>
              <td className={TD}>
                {l.partner}
                <PayeeTags partnerType={l.partnerType} payeeInactive={l.payeeInactive} />
              </td>
              <td className={TD}>{l.tranche}</td>
              <td className={TD}>{money(l.expected, c.currency)}</td>
              <td className={`${TD} font-semibold text-[#101828]`}>{money(l.amountInr, "INR")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {c.notes && <p className="border-t border-[#F2F4F7] px-3.5 py-2 text-xs text-[#667085]">Note: {c.notes}</p>}
    </div>
  );
}
