"use client";

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { UserStatus } from "~/server/db/enums";
import { formatDate, initials } from "~/components/dashboard/format";
import {
  StatCard,
  EmptyState,
  SkeletonTable,
  AVATAR_GRADIENTS,
} from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";
import { Toast } from "~/components/ui/toast";
import { TabOverridesButton } from "~/components/admin/tab-overrides-modal";

type Counsellor = RouterOutputs["counsellors"]["list"][number];
type Tab = "pending" | "approved" | "rejected" | "inactive";

const REASONS = [
  "Incomplete documentation",
  "Duplicate account",
  "Failed verification",
  "Partner at max capacity",
  "Unqualified",
  "Other",
];

function Avatar({ name, i }: { name: string; i: number }) {
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
      style={{ background: AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length] }}
    >
      {initials(name)}
    </span>
  );
}

function VerifyBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        ok ? "bg-[#ECFDF3] text-[#027A48]" : "bg-[#FEF3F2] text-[#B42318]"
      }`}
    >
      {label} {ok ? "✓" : "✗"}
    </span>
  );
}

function partnerCount(c: Counsellor, countByOrg: Map<number, number>) {
  const n = c.orgId != null ? (countByOrg.get(c.orgId) ?? 0) : 0;
  return c.partnerCap != null
    ? `${n}/${c.partnerCap} counsellors`
    : `${n} counsellor${n === 1 ? "" : "s"}`;
}

function PartnerCell({
  c,
  countByOrg,
}: {
  c: Counsellor;
  countByOrg: Map<number, number>;
}) {
  return (
    <td className="px-4 py-3">
      <div className="text-[#344054]">{c.partner}</div>
      <div className="text-[11px] text-[#98A2B3]">{partnerCount(c, countByOrg)}</div>
    </td>
  );
}

function PendingRow({
  c,
  i,
  countByOrg,
  checked,
  onToggle,
  onChanged,
}: {
  c: Counsellor;
  i: number;
  countByOrg: Map<number, number>;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const setStatus = api.counsellors.setStatus.useMutation({ onSuccess: onChanged });
  const busy = setStatus.isPending;
  return (
    <tr className="border-b border-[#F2F4F7] text-[13px] last:border-0 hover:bg-[#FAFBFC]">
      <td className="px-4 py-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-[#1570EF]"
          aria-label={`Select ${c.name}`}
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={c.name} i={i} />
          <div className="font-semibold text-[#101828]">{c.name}</div>
        </div>
      </td>
      <PartnerCell c={c} countByOrg={countByOrg} />
      <td className="px-4 py-3 text-[#475467]">{c.email}</td>
      <td className="px-4 py-3 text-[#475467]">{c.phone}</td>
      <td className="px-4 py-3 text-[#475467]">{formatDate(c.createdAt)}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          <VerifyBadge ok={c.emailVerified} label="Email" />
          <VerifyBadge ok={c.phoneVerified} label="Phone" />
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => setStatus.mutate({ userId: c.id, status: "approved" })}
            className="rounded-md bg-[#12B76A] px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-[#039855] disabled:opacity-40"
          >
            Approve
          </button>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-[30px] rounded-md border border-[#D0D5DD] px-1.5 text-[12px] text-[#344054] outline-none focus:border-[#1570EF]"
          >
            <option value="">Reason…</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || reason === ""}
            onClick={() =>
              setStatus.mutate({ userId: c.id, status: "rejected", reason })
            }
            className="rounded-md border border-[#FECDCA] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-40"
          >
            Reject
          </button>
        </div>
      </td>
    </tr>
  );
}

// Deactivated by the agency, or removed (soft-deleted) by it. A removed
// counsellor can be restored: they come back deactivated, for the agency (or an
// approval here) to bring back to work.
function InactiveCell({ c, onChanged }: { c: Counsellor; onChanged: () => void }) {
  const restore = api.counsellors.restoreRemoved.useMutation({ onSuccess: onChanged });
  return (
    <td className="px-4 py-3">
      {c.removedAt ? (
        <div className="flex items-center gap-2">
          <span className="text-[#B42318]">Removed by agency · {formatDate(c.removedAt)}</span>
          <button
            type="button"
            disabled={restore.isPending}
            onClick={() => restore.mutate({ userId: c.id })}
            className="rounded-md border border-[#D0D5DD] bg-white px-2 py-1 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:opacity-40"
          >
            Restore
          </button>
        </div>
      ) : (
        <span className="text-[#475467]">Deactivated by agency</span>
      )}
    </td>
  );
}

const TH =
  "px-4 py-2.5 text-left text-[11px] font-semibold tracking-wide text-[#667085] uppercase";

export default function CounselorApprovalsPage() {
  const { data, isLoading } = api.counsellors.list.useQuery();
  const utils = api.useUtils();
  const refresh = () => void utils.counsellors.list.invalidate();

  const [tab, setTabState] = useState<Tab>("pending");
  const [search, setSearch] = useState("");
  const [partner, setPartner] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [toastMsg, setToastMsg] = useState("");

  // Selection only applies to the pending tab; clear it whenever the tab flips.
  const setTab = (t: Tab) => {
    setTabState(t);
    setSelected(new Set());
  };

  const batchApproveMut = api.counsellors.batchApprove.useMutation({
    onSuccess: () => {
      setSelected(new Set());
      void utils.counsellors.list.invalidate();
    },
  });

  const rows = data ?? [];
  const countByOrg = new Map<number, number>();
  for (const r of rows) {
    // A counsellor the agency removed no longer counts towards its team.
    if (r.orgId != null && !r.removedAt) {
      countByOrg.set(r.orgId, (countByOrg.get(r.orgId) ?? 0) + 1);
    }
  }
  const pending = rows.filter((r) => r.status === UserStatus.UNDER_REVIEW);
  const approved = rows.filter((r) => r.status === UserStatus.APPROVED);
  const rejected = rows.filter((r) => r.status === UserStatus.REJECTED);
  // Deactivated or removed by their agency (they left).
  const inactive = rows.filter((r) => r.status === UserStatus.INACTIVE);

  const partners = [...new Set(rows.map((r) => r.partner))].sort();
  const list =
    tab === "pending"
      ? pending
      : tab === "approved"
        ? approved
        : tab === "rejected"
          ? rejected
          : inactive;
  const filtered = list.filter((c) => {
    const q = search.toLowerCase();
    if (
      q !== "" &&
      !c.name.toLowerCase().includes(q) &&
      !c.email.toLowerCase().includes(q)
    )
      return false;
    if (partner !== "" && c.partner !== partner) return false;
    return true;
  });

  const TABS: { key: Tab; label: string; count: number }[] = [
    { key: "pending", label: "Pending", count: pending.length },
    { key: "approved", label: "Approved", count: approved.length },
    { key: "rejected", label: "Rejected", count: rejected.length },
    { key: "inactive", label: "Inactive", count: inactive.length },
  ];

  // Batch-approve selection (pending tab only).
  const pendingVisibleIds = tab === "pending" ? filtered.map((c) => c.id) : [];
  const allSelected =
    pendingVisibleIds.length > 0 &&
    pendingVisibleIds.every((id) => selected.has(id));
  const selectedCount = pendingVisibleIds.filter((id) => selected.has(id)).length;

  const toggleOne = (id: number, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAll = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pendingVisibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Counselor Approvals</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Review and approve counsellors invited by partner agencies.
        </p>
      </div>

      {/* Stat cards */}
      <Stagger className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <FadeUp className="h-full">
          <StatCard icon="approvals" tone="orange" value={pending.length} label="Pending Approvals" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="check" tone="green" value={approved.length} label="Approved" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="applications" tone="red" value={rejected.length} label="Rejected" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="partners" tone="blue" value={rows.length} label="Total Counsellors" />
        </FadeUp>
      </Stagger>

      {/* Tabs */}
      <div className="mb-5 flex gap-1 border-b border-[#E4E7EC]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-5 py-2.5 text-sm font-semibold transition-colors ${
              tab === t.key
                ? "border-[#1570EF] text-[#1570EF]"
                : "border-transparent text-[#667085] hover:text-[#1570EF]"
            }`}
          >
            {t.label}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                tab === t.key ? "bg-[#EFF8FF] text-[#1570EF]" : "bg-[#F2F4F7] text-[#344054]"
              }`}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email…"
          className="h-[38px] w-64 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
        />
        <select
          value={partner}
          onChange={(e) => setPartner(e.target.value)}
          className="h-[38px] rounded-lg border border-[#D0D5DD] bg-white px-2.5 text-[13px] font-medium text-[#344054] outline-none hover:border-[#1570EF] focus:border-[#1570EF]"
        >
          <option value="">All Partners</option>
          {partners.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {(search !== "" || partner !== "") && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setPartner("");
            }}
            className="h-[38px] rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-[13px] font-medium text-[#667085] hover:bg-[#F9FAFB]"
          >
            Reset
          </button>
        )}
      </div>

      {/* Batch action bar (pending tab) */}
      {tab === "pending" && selectedCount > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-[#B2DDFF] bg-[#EFF8FF] px-4 py-2.5">
          <span className="text-[13px] font-semibold text-[#1570EF]">
            {selectedCount} counsellor{selectedCount === 1 ? "" : "s"} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-md px-2.5 py-1.5 text-[12px] font-semibold text-[#667085] hover:bg-white"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={batchApproveMut.isPending}
              onClick={() =>
                batchApproveMut.mutate({ userIds: [...selected] })
              }
              className="rounded-md bg-[#12B76A] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#039855] disabled:opacity-40"
            >
              {batchApproveMut.isPending
                ? "Approving…"
                : `Approve ${selectedCount} Selected`}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
        {isLoading ? (
          <SkeletonTable rows={6} cols={6} />
        ) : filtered.length === 0 ? (
          <div className="p-5">
            <EmptyState
              label={
                tab === "pending"
                  ? "No counsellors awaiting approval."
                  : `No ${tab} counsellors.`
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[#E4E7EC] bg-[#F9FAFB]">
                  {tab === "pending" && (
                    <th className={`${TH} w-10`}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={(e) => toggleAll(e.target.checked)}
                        className="h-4 w-4 cursor-pointer accent-[#1570EF]"
                        aria-label="Select all"
                      />
                    </th>
                  )}
                  <th className={TH}>Counsellor</th>
                  <th className={TH}>Partner</th>
                  <th className={TH}>Email</th>
                  {tab === "pending" && <th className={TH}>Phone</th>}
                  <th className={TH}>Signed Up</th>
                  {tab === "pending" && <th className={TH}>Verification</th>}
                  {tab === "pending" && <th className={TH}>Actions</th>}
                  {tab !== "pending" && tab !== "inactive" && <th className={TH}>Decided By</th>}
                  {tab === "inactive" && <th className={TH}>Status</th>}
                </tr>
              </thead>
              <tbody>
                {tab === "pending"
                  ? filtered.map((c, i) => (
                      <PendingRow
                        key={c.id}
                        c={c}
                        i={i}
                        countByOrg={countByOrg}
                        checked={selected.has(c.id)}
                        onToggle={(v) => toggleOne(c.id, v)}
                        onChanged={refresh}
                      />
                    ))
                  : filtered.map((c, i) => (
                      <tr
                        key={c.id}
                        className="border-b border-[#F2F4F7] text-[13px] last:border-0 hover:bg-[#FAFBFC]"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={c.name} i={i} />
                            <div className="font-semibold text-[#101828]">{c.name}</div>
                            {tab === "approved" && (
                              <TabOverridesButton portal="partner" userId={c.id} toast={setToastMsg} />
                            )}
                          </div>
                        </td>
                        <PartnerCell c={c} countByOrg={countByOrg} />
                        <td className="px-4 py-3 text-[#475467]">{c.email}</td>
                        <td className="px-4 py-3 text-[#475467]">
                          {formatDate(c.createdAt)}
                        </td>
                        {tab === "inactive" ? (
                          <InactiveCell c={c} onChanged={refresh} />
                        ) : (
                          <td className="px-4 py-3 text-[#475467]">{c.decidedBy ?? "—"}</td>
                        )}
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Toast message={toastMsg} open={!!toastMsg} onClose={() => setToastMsg("")} />
    </>
  );
}
