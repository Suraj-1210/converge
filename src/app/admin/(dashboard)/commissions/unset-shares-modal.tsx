"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3 py-2.5 text-[13px] text-[#344054] whitespace-nowrap";
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

// Commissions confirmed before Partner Tiers have no stamped partner share, so
// partners can't claim them (the old code paid them as 100%). Finance previews
// the share each would get — the partner's tier when the row was confirmed —
// picks rows, confirms, and applies. Each stamped row is audit-logged.
export function UnsetSharesModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const utils = api.useUtils();
  const previewQ = api.commissions.unsetSharePreview.useQuery();
  const rows = useMemo(() => previewQ.data ?? [], [previewQ.data]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");

  // Default: every row that has a share to apply.
  useEffect(() => {
    setPicked(new Set(rows.filter((r) => r.afterSharePct != null).map((r) => r.commissionId)));
  }, [rows]);

  const stamp = api.commissions.stampUnsetShares.useMutation({
    onSuccess: async (r) => {
      await utils.commissions.invalidate();
      onDone(`Partner share set on ${r.stamped} commission${r.stamped === 1 ? "" : "s"}${r.skipped ? ` · ${r.skipped} skipped` : ""}`);
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const chosen = rows.filter((r) => picked.has(r.commissionId));
  const before = chosen.reduce((s, r) => s + r.beforeShareInr, 0);
  const after = chosen.reduce((s, r) => s + (r.afterShareInr ?? 0), 0);
  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Modal
      open
      title="Set partner share on older commissions"
      width="w-[1000px]"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!checked || chosen.length === 0}
            loading={stamp.isPending}
            onClick={() => {
              setError("");
              stamp.mutate({ commissionIds: chosen.map((r) => r.commissionId), confirm: true });
            }}
          >
            Apply to {chosen.length} commission{chosen.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-[#475467]">
        These were confirmed for billing before Partner Tiers, so they have no partner share and partners can&apos;t claim them. Each gets the share of
        the tier the partner had when it was confirmed (that year&apos;s ranges, students confirmed up to then, and any override). The share is fixed on the
        row once applied. Invoices partners already raised are not changed.
      </p>
      {previewQ.isLoading ? (
        <div className="py-8 text-center text-sm text-[#98A2B3]">Working out the shares…</div>
      ) : previewQ.error ? (
        <div className="py-8 text-center text-sm text-[#B42318]">{previewQ.error.message}</div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-[#98A2B3]">Every commission has a partner share. Nothing to do.</div>
      ) : (
        <div className="max-h-[50vh] overflow-auto rounded-lg border border-[#E4E7EC]">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} w-8`} />
                <th className={TH}>Student</th>
                <th className={TH}>Partner</th>
                <th className={TH}>Confirmed</th>
                <th className={`${TH} text-right`}>Commission (INR)</th>
                <th className={`${TH} text-right`}>Before: no share (paid as 100%)</th>
                <th className={`${TH} text-right`}>After</th>
                <th className={`${TH} text-right`}>Already invoiced</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.commissionId} className="border-b border-[#F2F4F7] last:border-0">
                  <td className={TD}>
                    <input
                      type="checkbox"
                      aria-label={`Include ${r.studentName}`}
                      disabled={r.afterSharePct == null}
                      checked={picked.has(r.commissionId)}
                      onChange={() => toggle(r.commissionId)}
                    />
                  </td>
                  <td className={`${TD} font-medium text-[#101828]`}>{r.studentName}</td>
                  <td className={TD}>{r.partner}</td>
                  <td className={TD}>{day(r.confirmedAt)}</td>
                  <td className={`${TD} text-right`}>{inr(r.grossInr)}</td>
                  <td className={`${TD} text-right text-[#98A2B3]`}>{inr(r.beforeShareInr)}</td>
                  <td className={`${TD} text-right font-semibold`}>
                    {r.afterSharePct == null ? (
                      <span className="text-[#B42318]">No tier ladder</span>
                    ) : (
                      <>
                        {inr(r.afterShareInr ?? 0)}
                        <span className="block text-[11px] font-normal text-[#667085]">
                          {r.afterTier} · {r.afterSharePct}% · {r.fyStudents} student{r.fyStudents === 1 ? "" : "s"}
                        </span>
                      </>
                    )}
                  </td>
                  <td className={`${TD} text-right ${r.claimedInr > 0 ? "text-[#B54708]" : "text-[#98A2B3]"}`}>
                    {r.claimedInr > 0 ? inr(r.claimedInr) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {chosen.length > 0 && (
        <div className="mt-3 text-sm text-[#344054]">
          Selected: partner share of the full commission goes from <b>{inr(before)}</b> (100%) to <b>{inr(after)}</b>.
        </div>
      )}
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-[#344054]">
        <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        I&apos;ve checked these amounts. Apply the partner share to the selected commissions.
      </label>
      {error && <div className="mt-3 rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
    </Modal>
  );
}
