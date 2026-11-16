"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Toast } from "~/components/ui/toast";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { DashboardCard, EmptyState, SkeletonTable } from "~/components/dashboard/widgets";
import { PayeeTags } from "~/components/admin/payee-tags";
import { AdjustmentStatus, AdminRole } from "~/server/db/enums";
import { FINANCE_CURRENCIES } from "~/lib/currency";

// Finance › Adjustments (16 Nov 2026). Deductions and credits on university
// receivables and partner payables, and payee payout holds.
//   - Any finance role raises a draft (with evidence); ONLY a Super Admin
//     approves or rejects it.
//   - Nothing is automatic between the sides: "Raise matching partner
//     deduction" only pre-fills a new draft.
//   - Payout holds: Finance Manager / Super Admin.
// The reason, internal note and evidence are staff-only; the partner sees
// "Adjustment" with the partner note and the Adjustment Note PDF.

type Row = RouterOutputs["adjustments"]["list"][number];
type Hold = RouterOutputs["adjustments"]["holds"][number];
type Tab = "draft" | "approved" | "rejected" | "all" | "holds";
type PayeeRef = { orgId: number } | { userId: number };

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054] align-top";
const LABEL = "mb-1.5 block text-[13px] font-medium text-[#344054]";
const TEXTAREA = "w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-sm text-[#101828] outline-none focus:border-[#84CAFF] focus:ring-4 focus:ring-[#D1E9FF]";

const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
const money = (n: number, ccy: string) =>
  `${ccy === "INR" ? "₹" : `${ccy} `}${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

function StatusPill({ status }: { status: number }) {
  const map: Record<number, [string, string]> = {
    [AdjustmentStatus.DRAFT]: ["Awaiting approval", "bg-[#FFFAEB] text-[#B54708]"],
    [AdjustmentStatus.APPROVED]: ["Approved", "bg-[#ECFDF3] text-[#027A48]"],
    [AdjustmentStatus.REJECTED]: ["Rejected", "bg-[#FEF3F2] text-[#B42318]"],
  };
  const [label, cls] = map[status] ?? ["—", "bg-[#F2F4F7] text-[#344054]"];
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>;
}

function HoldBadge({ title }: { title?: string }) {
  return (
    <span title={title} className="ml-1.5 inline-block rounded-[10px] bg-[#FEF3F2] px-2 py-0.5 align-middle text-[10px] font-semibold text-[#B42318]">
      On hold
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 text-[#667085] transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

async function uploadEvidence(file: File): Promise<{ url: string; name: string }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("folder", "adjustment-evidence");
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new Error(body.error ?? "Upload failed");
  return { url: body.url, name: file.name };
}

// Same gate as /api/files: a private Spaces key is served through it; a local
// dev upload is a plain /uploads path.
const fileHref = (url: string) => (url.startsWith("/") || url.startsWith("http") ? url : `/api/files/${url}`);

export default function AdjustmentsPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const isFinance = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER || role === AdminRole.FINANCE_EXECUTIVE;
  const isSuperAdmin = role === AdminRole.SUPER_ADMIN;
  const canHold = role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [tab, setTab] = useState<Tab>("draft");
  const [side, setSide] = useState<"all" | "university" | "partner">("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [creating, setCreating] = useState<Prefill | null>(null);
  const [deciding, setDeciding] = useState<{ row: Row; kind: "approve" | "reject" } | null>(null);
  const [placingHold, setPlacingHold] = useState(false);
  const [lifting, setLifting] = useState<Hold | null>(null);

  const utils = api.useUtils();
  const listQ = api.adjustments.list.useQuery(
    { status: tab === "holds" ? "all" : tab, side },
    { enabled: isFinance && tab !== "holds" },
  );
  const summaryQ = api.adjustments.summary.useQuery(undefined, { enabled: isFinance });
  const holdsQ = api.adjustments.holds.useQuery(undefined, { enabled: isFinance });
  const refresh = async () => {
    await Promise.all([utils.adjustments.invalidate(), utils.universityBilling.invalidate(), utils.reconciliation.invalidate(), utils.partnerPayouts.invalidate()]);
  };

  const rows = useMemo(() => {
    const all = listQ.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.reason, r.counterparty, r.payee?.partner, r.student?.name, r.student?.cpStudentId, r.vendorInvoice, r.noteNumber, r.internalNote, r.partnerNote, `#${r.id}`]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [listQ.data, search]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!mounted || meQ.isLoading) {
    return (
      <DashboardCard title="Adjustments" bodyClassName="p-0">
        <SkeletonTable rows={6} cols={7} />
      </DashboardCard>
    );
  }
  if (!isFinance) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-[#E4E7EC] bg-white px-8 py-12 text-center">
          <h2 className="text-lg font-bold text-[#101828]">Access Restricted</h2>
          <p className="mt-2 text-sm text-[#667085]">Adjustments are available to Finance and Super Admins only.</p>
        </div>
      </div>
    );
  }

  const s = summaryQ.data;
  const activeHolds = (holdsQ.data ?? []).filter((h) => h.active);
  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: "draft", label: "Awaiting approval", count: s?.drafts },
    { id: "approved", label: "Approved" },
    { id: "rejected", label: "Rejected" },
    { id: "all", label: "All" },
    { id: "holds", label: "Payout holds", count: activeHolds.length },
  ];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Adjustments</h1>
          <p className="mt-1 max-w-3xl text-sm text-[#667085]">
            Deductions and credits on what universities owe us and what we owe partners. Finance raises a draft; only a Super Admin
            approves it. Originals are never edited: university adjustments reduce the invoice (or stand as a credit on the next one),
            partner adjustments are netted off the partner&apos;s next payout.
          </p>
        </div>
        <div className="flex gap-2">
          {canHold && (
            <Button variant="secondary" className="!h-9 !text-[13px]" onClick={() => setPlacingHold(true)}>
              Put payee on hold
            </Button>
          )}
          <Button className="!h-9 !text-[13px]" onClick={() => setCreating({})}>
            New adjustment
          </Button>
        </div>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-[#E4E7EC] bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-[#667085]">Awaiting a Super Admin</div>
          <div className="mt-1 text-2xl font-bold text-[#101828]">{s?.drafts ?? "—"}</div>
        </div>
        <div className="rounded-xl border border-[#E4E7EC] bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-[#667085]">Partner deductions to recover</div>
          <div className="mt-1 text-2xl font-bold text-[#101828]">{s ? money(s.partnerToRecoverInr, "INR") : "—"}</div>
          {s && s.partnerCreditsDueInr > 0 && <div className="text-xs text-[#667085]">Credits to pay: {money(s.partnerCreditsDueInr, "INR")}</div>}
        </div>
        <div className="rounded-xl border border-[#E4E7EC] bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-[#667085]">University credits waiting for the next invoice</div>
          {s && s.standingUniversity.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-[#344054]">
              {s.standingUniversity.map((b) => (
                <li key={`${b.vendorId ?? `u${b.universityId}`}${b.currency}`}>
                  <span className="font-semibold">{b.name}</span>: {b.deduction > 0 && `−${money(b.deduction, b.currency)}`}
                  {b.credit > 0 && ` +${money(b.credit, b.currency)}`}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-1 text-2xl font-bold text-[#101828]">{s ? "None" : "—"}</div>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2 border-b border-[#E4E7EC]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 pb-2.5 text-sm font-semibold ${tab === t.id ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}
          >
            {t.label}
            {t.count ? <span className="ml-1.5 rounded-full bg-[#F2F4F7] px-2 py-0.5 text-xs text-[#344054]">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {tab === "holds" ? (
        <HoldsTable holds={holdsQ.data} loading={holdsQ.isLoading} canHold={canHold} onLift={setLifting} />
      ) : (
        <DashboardCard
          title={tab === "draft" ? "Awaiting approval" : tab === "approved" ? "Approved" : tab === "rejected" ? "Rejected" : "All adjustments"}
          bodyClassName="p-0"
          headerRight={
            <div className="flex flex-wrap gap-2">
              <select value={side} onChange={(e) => setSide(e.target.value as typeof side)} className="h-9 rounded-lg border border-[#D0D5DD] px-2 text-sm">
                <option value="all">Both sides</option>
                <option value="university">University side</option>
                <option value="partner">Partner side</option>
              </select>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search student, partner, reason, note…"
                className="h-9 w-64 rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#84CAFF]"
              />
            </div>
          }
        >
          {listQ.isLoading ? (
            <SkeletonTable rows={5} cols={8} />
          ) : rows.length === 0 ? (
            <EmptyState label={tab === "draft" ? "Nothing is waiting for approval." : "Raise one with New adjustment."} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse">
                <thead>
                  <tr>
                    <th className={TH} />
                    <th className={TH}>#</th>
                    <th className={TH}>Date</th>
                    <th className={TH}>Side · type</th>
                    <th className={TH}>With</th>
                    <th className={TH}>Student</th>
                    <th className={TH}>Reason</th>
                    <th className={`${TH} text-right`}>Amount</th>
                    <th className={`${TH} text-right`}>Balance</th>
                    <th className={TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Fragment key={r.id}>
                      <tr className="cursor-pointer border-b border-[#F2F4F7] hover:bg-[#F9FAFB]" onClick={() => toggle(r.id)}>
                        <td className={TD}><Chevron open={expanded.has(r.id)} /></td>
                        <td className={TD}>#{r.id}</td>
                        <td className={TD}>{fmtDate(r.date)}</td>
                        <td className={TD}>
                          <div className="font-medium text-[#101828]">{r.side === "university" ? "University" : "Partner"}</div>
                          <div className={`text-xs ${r.direction === "deduction" ? "text-[#B42318]" : "text-[#027A48]"}`}>{r.direction === "deduction" ? "Deduction" : "Credit"}</div>
                        </td>
                        <td className={TD}>
                          {r.side === "partner" && r.payee ? (
                            <>
                              {r.payee.partner}
                              <PayeeTags partnerType={r.payee.partnerType} payeeInactive={r.payee.payeeInactive} />
                              {r.payeeOnHold && <HoldBadge title="Payouts to this partner are on hold" />}
                            </>
                          ) : (
                            (r.counterparty ?? "—")
                          )}
                          {r.vendorInvoice && <div className="text-xs text-[#667085]">Invoice {r.vendorInvoice}</div>}
                        </td>
                        <td className={TD}>
                          {r.student ? (
                            <>
                              {r.student.name}
                              <div className="text-xs text-[#667085]">{r.student.cpStudentId}{r.tranche ? ` · ${r.tranche}` : ""}</div>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={TD}>{r.reason}</td>
                        <td className={`${TD} text-right font-semibold whitespace-nowrap`}>
                          {r.direction === "deduction" ? "−" : "+"}{money(r.amount, r.currency)}
                        </td>
                        <td className={`${TD} text-right whitespace-nowrap`}>{r.balance == null ? "—" : money(r.balance, r.currency)}</td>
                        <td className={TD}><StatusPill status={r.status} /></td>
                      </tr>
                      {expanded.has(r.id) && (
                        <tr className="border-b border-[#E4E7EC] bg-[#FCFCFD]">
                          <td />
                          <td colSpan={9} className="px-3.5 py-4">
                            <Detail
                              r={r}
                              isSuperAdmin={isSuperAdmin}
                              onDecide={(kind) => setDeciding({ row: r, kind })}
                              onMatch={() =>
                                setCreating({
                                  side: "partner",
                                  commissionId: r.commissionId ?? undefined,
                                  reasonId: r.reasonId,
                                  sourceAdjustmentId: r.id,
                                  label: `Matching partner deduction for university adjustment #${r.id}`,
                                })
                              }
                              onChanged={async (msg) => { await refresh(); setToast(msg); }}
                            />
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
      )}

      {creating && (
        <NewAdjustmentModal
          prefill={creating}
          onClose={() => setCreating(null)}
          onCreated={async (id) => {
            setCreating(null);
            await refresh();
            setTab("draft");
            setToast(`Adjustment #${id} raised. A Super Admin approves it.`);
          }}
        />
      )}
      {deciding && (
        <DecideModal
          row={deciding.row}
          kind={deciding.kind}
          onClose={() => setDeciding(null)}
          onDone={async (msg) => { setDeciding(null); await refresh(); setToast(msg); }}
        />
      )}
      {placingHold && (
        <PlaceHoldModal onClose={() => setPlacingHold(false)} onDone={async () => { setPlacingHold(false); await refresh(); setToast("Payee put on payout hold"); setTab("holds"); }} />
      )}
      {lifting && (
        <LiftHoldModal hold={lifting} onClose={() => setLifting(null)} onDone={async () => { setLifting(null); await refresh(); setToast("Hold lifted"); }} />
      )}
      <Toast message={toast ?? ""} open={toast != null} onClose={() => setToast(null)} />
    </div>
  );
}

// ---- detail ------------------------------------------------------------------

function Detail({
  r,
  isSuperAdmin,
  onDecide,
  onMatch,
  onChanged,
}: {
  r: Row;
  isSuperAdmin: boolean;
  onDecide: (kind: "approve" | "reject") => void;
  onMatch: () => void;
  onChanged: (msg: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const addEvidence = api.adjustments.addEvidence.useMutation();
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const up = await uploadEvidence(file);
      await addEvidence.mutateAsync({ adjustmentId: r.id, url: up.url, name: up.name });
      await onChanged("Evidence added");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };
  const K = "text-xs font-semibold uppercase tracking-wider text-[#667085]";
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="space-y-3 text-sm text-[#344054]">
        <div>
          <div className={K}>Internal note (staff only)</div>
          <div className="mt-0.5 whitespace-pre-wrap">{r.internalNote ?? "—"}</div>
        </div>
        {r.side === "partner" && (
          <div>
            <div className={K}>Partner-facing note</div>
            <div className="mt-0.5 whitespace-pre-wrap">{r.partnerNote ?? <span className="text-[#98A2B3]">None (the partner sees just &ldquo;Adjustment&rdquo;)</span>}</div>
          </div>
        )}
        <div>
          <div className={K}>History</div>
          <ul className="mt-0.5 space-y-0.5">
            <li>Raised by {r.createdBy} on {fmtDate(r.createdAt)}</li>
            {r.decidedAt && (
              <li>
                {r.status === AdjustmentStatus.APPROVED ? "Approved" : "Rejected"} by {r.decidedBy} on {fmtDate(r.decidedAt)}
                {r.decisionNote ? `: ${r.decisionNote}` : ""}
              </li>
            )}
            {r.sourceAdjustmentId && <li>Raised to match university adjustment #{r.sourceAdjustmentId}</li>}
            {r.derived.map((d) => (
              <li key={d.id}>Matching partner deduction #{d.id} ({d.status === AdjustmentStatus.DRAFT ? "awaiting approval" : d.status === AdjustmentStatus.APPROVED ? "approved" : "rejected"})</li>
            ))}
          </ul>
        </div>
        {r.noteNumber && (
          <div>
            <div className={K}>Adjustment Note (sent to the partner)</div>
            <a className="mt-0.5 inline-block font-semibold text-[#1570EF] hover:underline" href={`/api/adjustment-note/${r.id}`} target="_blank" rel="noreferrer">
              {r.noteNumber} (PDF)
            </a>
          </div>
        )}
      </div>
      <div className="space-y-3 text-sm text-[#344054]">
        <div>
          <div className={K}>Evidence (staff only)</div>
          {r.evidence.length === 0 ? (
            <div className="mt-0.5 text-[#98A2B3]">None yet</div>
          ) : (
            <ul className="mt-0.5 space-y-0.5">
              {r.evidence.map((e) => (
                <li key={e.id}>
                  <a className="text-[#1570EF] hover:underline" href={fileHref(e.url)} target="_blank" rel="noreferrer">{e.name}</a>
                  <span className="text-xs text-[#667085]"> · {e.by ?? "staff"}, {fmtDate(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <label className="mt-1.5 inline-block cursor-pointer text-[13px] font-semibold text-[#1570EF] hover:underline">
            {busy ? "Uploading…" : "+ Add evidence (PDF, JPG, PNG)"}
            <input type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          {err && <div className="text-xs text-[#B42318]">{err}</div>}
        </div>
        {r.status === AdjustmentStatus.APPROVED && (
          <div>
            <div className={K}>Applied</div>
            {r.allocations.length === 0 ? (
              <div className="mt-0.5 text-[#667085]">
                {r.side === "partner"
                  ? "Not yet: it's netted off this partner's next payout at release."
                  : "Not yet: it stands as a credit on this university's / vendor's next invoice."}
              </div>
            ) : (
              <ul className="mt-0.5 space-y-0.5">
                {r.allocations.map((a) => (
                  <li key={a.id}>
                    {money(a.amount, r.currency)} → {a.vendorInvoice ? `invoice ${a.vendorInvoice}` : `payout for claim ${a.payoutInvoice}`}
                    <span className="text-xs text-[#667085]"> · {fmtDate(a.at)}</span>
                  </li>
                ))}
              </ul>
            )}
            {r.balance != null && r.balance > 0 && r.allocations.length > 0 && (
              <div className="mt-0.5 text-[#B54708]">{money(r.balance, r.currency)} still to apply (carried forward)</div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {r.status === AdjustmentStatus.DRAFT && isSuperAdmin && (
            <>
              <Button className="!h-8 !text-[13px]" onClick={() => onDecide("approve")}>Approve</Button>
              <Button variant="secondary" className="!h-8 !text-[13px]" onClick={() => onDecide("reject")}>Reject</Button>
            </>
          )}
          {r.status === AdjustmentStatus.DRAFT && !isSuperAdmin && (
            <span className="text-xs text-[#667085]">Only a Super Admin can approve or reject adjustments.</span>
          )}
          {r.side === "university" && r.status !== AdjustmentStatus.REJECTED && r.commissionId != null && (
            <Button variant="secondary" className="!h-8 !text-[13px]" onClick={onMatch}>Raise matching partner deduction</Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- new adjustment ------------------------------------------------------------

type Prefill = {
  side?: "university" | "partner";
  commissionId?: number;
  reasonId?: number;
  sourceAdjustmentId?: number;
  vendorInvoiceId?: number;
  label?: string;
};
type CommissionOption = RouterOutputs["adjustments"]["commissionSearch"][number];
type PayeeOption = RouterOutputs["adjustments"]["payeeSearch"][number];

function NewAdjustmentModal({ prefill, onClose, onCreated }: { prefill: Prefill; onClose: () => void; onCreated: (id: number) => Promise<void> }) {
  const [side, setSide] = useState<"university" | "partner">(prefill.side ?? "university");
  const [direction, setDirection] = useState<"deduction" | "credit">("deduction");
  const [reasonId, setReasonId] = useState<string>(prefill.reasonId ? String(prefill.reasonId) : "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string>("INR");
  const [date, setDate] = useState(today());
  const [commQ, setCommQ] = useState("");
  const [comm, setComm] = useState<CommissionOption | null>(null);
  const [trancheId, setTrancheId] = useState("");
  const [invoiceId, setInvoiceId] = useState(prefill.vendorInvoiceId ? String(prefill.vendorInvoiceId) : "");
  const [vendorId, setVendorId] = useState("");
  const [universityId, setUniversityId] = useState("");
  const [payeeQ, setPayeeQ] = useState("");
  const [payee, setPayee] = useState<PayeeOption | null>(null);
  const [internalNote, setInternalNote] = useState("");
  const [partnerNote, setPartnerNote] = useState("");
  const [files, setFiles] = useState<{ url: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasonsQ = api.adjustments.reasons.useQuery();
  const cpQ = api.adjustments.counterparties.useQuery(undefined, { enabled: side === "university" });
  const commSearch = api.adjustments.commissionSearch.useQuery({ q: commQ }, { enabled: comm == null && commQ.trim().length >= 2 });
  const payeeSearch = api.adjustments.payeeSearch.useQuery({ q: payeeQ }, { enabled: payee == null && payeeQ.trim().length >= 2 });
  const create = api.adjustments.create.useMutation({
    onSuccess: (d) => onCreated(d.id),
    onError: (e) => setError(e.message),
  });

  // Pre-filled (e.g. from a university adjustment): load that commission.
  const prefillQ = api.adjustments.commissionSearch.useQuery(
    { q: "", id: prefill.commissionId },
    { enabled: prefill.commissionId != null },
  );
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    const hit = prefillQ.data?.[0];
    if (!prefilled && hit) {
      setPrefilled(true);
      setComm(hit);
    }
  }, [prefillQ.data, prefilled]);

  function pickCommission(c: CommissionOption) {
    setComm(c);
    setTrancheId("");
    setInvoiceId("");
    if (side === "university") setCurrency(c.invoices[0]?.currency ?? c.currency);
  }
  useEffect(() => {
    if (side === "partner") setCurrency("INR");
    else if (comm) setCurrency(comm.invoices[0]?.currency ?? comm.currency);
  }, [side, comm]);
  useEffect(() => {
    if (!invoiceId || !comm) return;
    const inv = comm.invoices.find((i) => String(i.id) === invoiceId);
    if (inv) setCurrency(inv.currency);
  }, [invoiceId, comm]);

  const onFile = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    setError(null);
    try {
      const ups: { url: string; name: string }[] = [];
      for (const f of Array.from(list)) ups.push(await uploadEvidence(f));
      setFiles((prev) => [...prev, ...ups]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    setError(null);
    const amt = Number(amount);
    if (!reasonId) return setError("Pick a reason.");
    if (!(amt > 0)) return setError("Enter an amount above 0.");
    if (side === "partner" && !comm && !payee) return setError("Pick the partner, or a commission of theirs.");
    if (side === "university" && !comm && !vendorId && !universityId) return setError("Pick a commission, or the vendor / university.");
    create.mutate({
      side,
      direction,
      reasonId: Number(reasonId),
      amount: Math.round(amt * 100) / 100,
      currency: currency as (typeof FINANCE_CURRENCIES)[number],
      date,
      commissionId: comm?.commissionId,
      trancheId: trancheId ? Number(trancheId) : undefined,
      vendorInvoiceId: side === "university" && invoiceId ? Number(invoiceId) : undefined,
      vendorId: side === "university" && !comm && vendorId ? Number(vendorId) : undefined,
      universityId: side === "university" && !comm && !vendorId && universityId ? Number(universityId) : undefined,
      payee: side === "partner" && !comm && payee ? (payee.payee as PayeeRef) : undefined,
      internalNote: internalNote.trim() || undefined,
      partnerNote: side === "partner" ? partnerNote.trim() || undefined : undefined,
      sourceAdjustmentId: prefill.sourceAdjustmentId,
      evidence: files,
    });
  };

  return (
    <Modal
      open
      width="w-[640px]"
      title={prefill.label ?? "New adjustment"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} disabled={uploading} onClick={submit}>Raise draft</Button>
        </>
      }
    >
      <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={LABEL}>Side</span>
            <div className="flex gap-2">
              {(["university", "partner"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={prefill.side != null}
                  onClick={() => { setSide(v); setComm(null); setPayee(null); }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold ${side === v ? "border-[#1570EF] bg-[#EFF8FF] text-[#1570EF]" : "border-[#D0D5DD] text-[#344054]"} disabled:opacity-70`}
                >
                  {v === "university" ? "University (receivable)" : "Partner (payable)"}
                </button>
              ))}
            </div>
          </div>
          <FormSelect
            label="Type"
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
            options={[
              { value: "deduction", label: side === "partner" ? "Deduction (recover from payouts)" : "Deduction (university pays less)" },
              { value: "credit", label: side === "partner" ? "Credit (add to next payout)" : "Credit (university owes more)" },
            ]}
          />
        </div>
        <FormSelect
          label="Reason"
          required
          value={reasonId}
          onChange={(e) => setReasonId(e.target.value)}
          placeholder="Pick a reason"
          options={(reasonsQ.data ?? []).map((r) => ({ value: String(r.id), label: r.name }))}
        />

        <div>
          <span className={LABEL}>Commission (student){side === "university" ? "" : " — optional"}</span>
          {comm ? (
            <div className="flex items-start justify-between rounded-lg border border-[#D0D5DD] bg-[#F9FAFB] px-3 py-2 text-sm">
              <div>
                <div className="font-semibold text-[#101828]">{comm.student} <span className="font-normal text-[#667085]">{comm.cpStudentId}</span></div>
                <div className="text-xs text-[#667085]">{comm.university} · {comm.vendorName} · {comm.partner} · {comm.currency}</div>
              </div>
              <button type="button" className="text-xs font-semibold text-[#1570EF]" onClick={() => setComm(null)}>Change</button>
            </div>
          ) : (
            <>
              <input value={commQ} onChange={(e) => setCommQ(e.target.value)} placeholder="Student name, CP-00012 or university" className="h-10 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#84CAFF]" />
              {commSearch.data && commSearch.data.length > 0 && (
                <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-[#E4E7EC] bg-white text-sm">
                  {commSearch.data.map((c) => (
                    <li key={c.commissionId}>
                      <button type="button" onClick={() => pickCommission(c)} className="w-full px-3 py-2 text-left hover:bg-[#F9FAFB]">
                        <span className="font-medium">{c.student}</span> <span className="text-[#667085]">{c.cpStudentId} · {c.university} · {c.partner}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {comm && comm.tranches.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <FormSelect
              label="Instalment (optional)"
              value={trancheId}
              onChange={(e) => setTrancheId(e.target.value)}
              placeholder="Whole commission"
              options={comm.tranches.map((t) => ({ value: String(t.id), label: `${t.name} (${money(t.amount, comm.currency)})` }))}
            />
            {side === "university" && (
              <FormSelect
                label="Vendor invoice (optional)"
                value={invoiceId}
                onChange={(e) => setInvoiceId(e.target.value)}
                placeholder={comm.invoices.length ? "Its own invoice" : "Not invoiced yet"}
                options={comm.invoices.map((i) => ({ value: String(i.id), label: `${i.number} (${i.currency})` }))}
              />
            )}
          </div>
        )}

        {side === "university" && !comm && (
          <div className="grid grid-cols-2 gap-3">
            <FormSelect
              label="Vendor"
              value={vendorId}
              onChange={(e) => { setVendorId(e.target.value); if (e.target.value) setUniversityId(""); }}
              placeholder="—"
              options={(cpQ.data?.vendors ?? []).map((v) => ({ value: String(v.id), label: v.name }))}
            />
            <FormSelect
              label="or University (direct contract)"
              value={universityId}
              onChange={(e) => { setUniversityId(e.target.value); if (e.target.value) setVendorId(""); }}
              placeholder="—"
              options={(cpQ.data?.universities ?? []).map((u) => ({ value: String(u.id), label: u.name }))}
            />
          </div>
        )}

        {side === "partner" && !comm && (
          <div>
            <span className={LABEL}>Partner</span>
            {payee ? (
              <div className="flex items-center justify-between rounded-lg border border-[#D0D5DD] bg-[#F9FAFB] px-3 py-2 text-sm">
                <span className="font-semibold">{payee.name} <span className="font-normal text-[#667085]">{payee.type === "agency" ? "Agency" : "Independent"}</span></span>
                <button type="button" className="text-xs font-semibold text-[#1570EF]" onClick={() => setPayee(null)}>Change</button>
              </div>
            ) : (
              <>
                <input value={payeeQ} onChange={(e) => setPayeeQ(e.target.value)} placeholder="Agency or independent counsellor name" className="h-10 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#84CAFF]" />
                {payeeSearch.data && payeeSearch.data.length > 0 && (
                  <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-[#E4E7EC] bg-white text-sm">
                    {payeeSearch.data.map((p) => (
                      <li key={p.key}>
                        <button type="button" onClick={() => setPayee(p)} className="w-full px-3 py-2 text-left hover:bg-[#F9FAFB]">
                          {p.name} <span className="text-[#667085]">{p.type === "agency" ? "Agency" : "Independent"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <FormInput label="Amount" required type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <FormSelect
            label="Currency"
            value={currency}
            disabled={side === "partner"}
            onChange={(e) => setCurrency(e.target.value)}
            options={FINANCE_CURRENCIES.map((c) => ({ value: c, label: c }))}
          />
          <FormInput label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {side === "partner" && <p className="-mt-2 text-xs text-[#667085]">Partner adjustments are in INR, like claims and payouts.</p>}

        <div>
          <span className={LABEL}>Internal note (staff only)</span>
          <textarea rows={3} maxLength={1000} className={TEXTAREA} value={internalNote} onChange={(e) => setInternalNote(e.target.value)} placeholder="What happened, who confirmed it, references…" />
        </div>
        {side === "partner" && (
          <div>
            <span className={LABEL}>Note to the partner</span>
            <textarea rows={2} maxLength={500} className={TEXTAREA} value={partnerNote} onChange={(e) => setPartnerNote(e.target.value)} placeholder="Shown on their statement and Adjustment Note, labelled “Adjustment”." />
            <p className="mt-1 text-xs text-[#667085]">The partner never sees the reason, the internal note or the evidence.</p>
          </div>
        )}
        <div>
          <span className={LABEL}>Evidence (staff only)</span>
          {files.length > 0 && (
            <ul className="mb-1 text-sm">
              {files.map((f, i) => (
                <li key={f.url} className="flex items-center gap-2">
                  {f.name}
                  <button type="button" className="text-xs text-[#B42318]" onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <label className="inline-block cursor-pointer text-[13px] font-semibold text-[#1570EF] hover:underline">
            {uploading ? "Uploading…" : "+ Attach files (PDF, JPG, PNG)"}
            <input type="file" multiple accept="application/pdf,image/jpeg,image/png" className="hidden" disabled={uploading} onChange={(e) => void onFile(e.target.files)} />
          </label>
        </div>
        {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
      </div>
    </Modal>
  );
}

// ---- decide / holds ------------------------------------------------------------------

function DecideModal({ row, kind, onClose, onDone }: { row: Row; kind: "approve" | "reject"; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const approve = api.adjustments.approve.useMutation({
    onSuccess: (d) =>
      onDone(
        d.noteNumber
          ? `Approved. Adjustment Note ${d.noteNumber} sent to the partner.`
          : d.standingCredit && d.standingCredit > 0
            ? `Approved. ${money(d.standingCredit, row.currency)} stands as a credit on the next invoice.`
            : "Approved and applied to the invoice.",
      ),
    onError: (e) => setError(e.message),
  });
  const reject = api.adjustments.reject.useMutation({ onSuccess: () => onDone("Rejected"), onError: (e) => setError(e.message) });
  const go = () => {
    setError(null);
    if (kind === "approve") approve.mutate({ id: row.id, note: note.trim() || undefined });
    else if (!note.trim()) setError("Give a reason for rejecting.");
    else reject.mutate({ id: row.id, note: note.trim() });
  };
  return (
    <Modal
      open
      title={`${kind === "approve" ? "Approve" : "Reject"} adjustment #${row.id}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={approve.isPending || reject.isPending} onClick={go}>{kind === "approve" ? "Approve" : "Reject"}</Button>
        </>
      }
    >
      <p className="text-sm text-[#344054]">
        {row.direction === "deduction" ? "Deduction" : "Credit"} of <b>{money(row.amount, row.currency)}</b> on the {row.side} side
        {row.side === "partner" && row.payee ? ` for ${row.payee.partner}` : row.counterparty ? ` with ${row.counterparty}` : ""} ({row.reason}).
      </p>
      {kind === "approve" && (
        <p className="text-sm text-[#667085]">
          {row.side === "partner"
            ? "The partner is emailed a numbered Adjustment Note now; it's netted off their next payout, and any excess carries forward."
            : "It's applied to the invoice now; if the money was already collected it stands as a credit on this university's / vendor's next invoice."}
        </p>
      )}
      <div>
        <span className={LABEL}>{kind === "approve" ? "Note (optional)" : "Reason for rejecting"}</span>
        <textarea rows={3} maxLength={500} className={TEXTAREA} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
    </Modal>
  );
}

function HoldsTable({ holds, loading, canHold, onLift }: { holds: Hold[] | undefined; loading: boolean; canHold: boolean; onLift: (h: Hold) => void }) {
  return (
    <DashboardCard title="Payout holds" bodyClassName="p-0">
      <p className="px-4 pt-3 text-sm text-[#667085]">
        While a partner is on hold they can still submit claims, but nothing is approved for payment or released. The partner sees that
        payouts are paused, never the reason.
      </p>
      {loading ? (
        <SkeletonTable rows={4} cols={5} />
      ) : !holds?.length ? (
        <EmptyState label={canHold ? "Use Put payee on hold." : "A Finance Manager or Super Admin can place one."} />
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-2 w-full min-w-[760px] border-collapse">
            <thead>
              <tr>
                <th className={TH}>Partner</th>
                <th className={TH}>Reason (staff only)</th>
                <th className={TH}>Placed</th>
                <th className={TH}>Lifted</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {holds.map((h) => (
                <tr key={h.id} className="border-b border-[#F2F4F7]">
                  <td className={TD}>
                    {h.partner}
                    <PayeeTags partnerType={h.partnerType} payeeInactive={h.payeeInactive} />
                    {h.active && <HoldBadge />}
                  </td>
                  <td className={TD}>{h.reason}</td>
                  <td className={TD}>{fmtDate(h.placedAt)}<div className="text-xs text-[#667085]">{h.placedBy}</div></td>
                  <td className={TD}>
                    {h.liftedAt ? (
                      <>
                        {fmtDate(h.liftedAt)}
                        <div className="text-xs text-[#667085]">{h.liftedBy}{h.liftNote ? `: ${h.liftNote}` : ""}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={`${TD} text-right`}>
                    {h.active && canHold && <Button variant="secondary" className="!h-8 !text-[13px]" onClick={() => onLift(h)}>Lift hold</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardCard>
  );
}

function PlaceHoldModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [payee, setPayee] = useState<PayeeOption | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const search = api.adjustments.payeeSearch.useQuery({ q }, { enabled: payee == null && q.trim().length >= 2 });
  const place = api.adjustments.placeHold.useMutation({ onSuccess: () => onDone(), onError: (e) => setError(e.message) });
  return (
    <Modal
      open
      title="Put a partner's payouts on hold"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={place.isPending}
            onClick={() => {
              setError(null);
              if (!payee) return setError("Pick the partner.");
              if (reason.trim().length < 3) return setError("Give a reason.");
              place.mutate({ payee: payee.payee as PayeeRef, reason: reason.trim() });
            }}
          >
            Put on hold
          </Button>
        </>
      }
    >
      {payee ? (
        <div className="flex items-center justify-between rounded-lg border border-[#D0D5DD] bg-[#F9FAFB] px-3 py-2 text-sm">
          <span className="font-semibold">{payee.name}</span>
          <button type="button" className="text-xs font-semibold text-[#1570EF]" onClick={() => setPayee(null)}>Change</button>
        </div>
      ) : (
        <div>
          <span className={LABEL}>Partner</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Agency or independent counsellor name" className="h-10 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#84CAFF]" />
          {search.data && search.data.length > 0 && (
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-[#E4E7EC] bg-white text-sm">
              {search.data.map((p) => (
                <li key={p.key}>
                  <button type="button" onClick={() => setPayee(p)} className="w-full px-3 py-2 text-left hover:bg-[#F9FAFB]">
                    {p.name} <span className="text-[#667085]">{p.type === "agency" ? "Agency" : "Independent"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div>
        <span className={LABEL}>Reason (staff only)</span>
        <textarea rows={3} maxLength={500} className={TEXTAREA} value={reason} onChange={(e) => setReason(e.target.value)} />
        <p className="mt-1 text-xs text-[#667085]">The partner sees only that payouts are paused.</p>
      </div>
      {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
    </Modal>
  );
}

function LiftHoldModal({ hold, onClose, onDone }: { hold: Hold; onClose: () => void; onDone: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lift = api.adjustments.liftHold.useMutation({ onSuccess: () => onDone(), onError: (e) => setError(e.message) });
  return (
    <Modal
      open
      title={`Lift the hold on ${hold.partner}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={lift.isPending} onClick={() => lift.mutate({ holdId: hold.id, note: note.trim() || undefined })}>Lift hold</Button>
        </>
      }
    >
      <p className="text-sm text-[#344054]">Held since {fmtDate(hold.placedAt)}: {hold.reason}</p>
      <div>
        <span className={LABEL}>Note (optional)</span>
        <textarea rows={2} maxLength={500} className={TEXTAREA} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
    </Modal>
  );
}
