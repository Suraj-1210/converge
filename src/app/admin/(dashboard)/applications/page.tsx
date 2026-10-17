"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { StatCard, SkeletonTable } from "~/components/dashboard/widgets";
import { countryFlag, formatDate } from "~/components/dashboard/format";

type StatusOption = { code: number; label: string };

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3 py-3 text-[13px] whitespace-nowrap text-[#344054]";

// Stage badge tone by status code (0–8 happy path, 20+ terminal).
function stageTone(status: number): string {
  if (status >= 20) return "bg-[#FEF3F2] text-[#B42318]"; // closed/rejected
  if (status === 8) return "bg-[#ECFDF3] text-[#067647]"; // enrolled
  if (status === 6 || status === 7) return "bg-[#ECFDF3] text-[#027A48]"; // deposit / visa
  if (status === 4 || status === 5) return "bg-[#F5F3FF] text-[#6941C6]"; // offers
  if (status === 2 || status === 3) return "bg-[#FFFAEB] text-[#B54708]"; // submitted / review
  return "bg-[#EFF8FF] text-[#175CD3]"; // begin / docs
}

// Opens on All so an application set to a closed outcome (rejected,
// withdrawn…) stays in view instead of dropping out of an Active-only list.
const SCOPES = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "closed", label: "Closed" },
] as const;

export default function ApplicationsPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [scope, setScope] = useState<"active" | "closed" | "all">("all");
  const [status, setStatus] = useState("");
  const [orgId, setOrgId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (m: string) => { setToastMsg(m); setToastOpen(true); };
  const [quickLook, setQuickLook] = useState<number | null>(null);

  const filtersQ = api.applications.filters.useQuery();
  const statusOptions = filtersQ.data?.statuses ?? [];
  const queryInput = useMemo(
    () => ({ page, scope, status: status ? Number(status) : undefined, orgId: orgId ? Number(orgId) : undefined, search: search || undefined }),
    [page, scope, status, orgId, search],
  );
  const listQ = api.applications.list.useQuery(queryInput, { placeholderData: keepPreviousData });

  const data = listQ.data;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? { active: 0, closed: 0, inProgress: 0, offers: 0, deposits: 0, enrolled: 0 };
  const pageSize = data?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const reset = () => { setStatus(""); setOrgId(""); setSearch(""); setPage(1); };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Applications</h1>
        <p className="mt-1 text-sm text-[#667085]">Track every university application across partners, stages, and intakes</p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard icon="applications" tone="blue" label="Active" value={stats.active} sub="Not yet closed" />
        <StatCard icon="clock" tone="orange" label="In Progress" value={stats.inProgress} sub="Docs → review" />
        <StatCard icon="offer" tone="purple" label="Offers" value={stats.offers} sub="Conditional + uncond." />
        <StatCard icon="deposit" tone="green" label="Deposits" value={stats.deposits} sub="Deposit + visa" />
        <StatCard icon="trophy" tone="cyan" label="Enrolled" value={stats.enrolled} sub="Confirmed" />
      </div>

      {/* Scope tabs */}
      <div className="mb-4 flex gap-1 border-b border-[#E4E7EC]">
        {SCOPES.map((s) => {
          const on = scope === s.id;
          return (
            <button key={s.id} onClick={() => { setScope(s.id); setStatus(""); setPage(1); }} className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold ${on ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}>
              {s.label}
              {s.id !== "all" && data && (
                <span className="ml-1.5 text-xs font-medium text-[#98A2B3]">{s.id === "active" ? stats.active : stats.closed}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="w-52"><FormSelect label="Stage" placeholder="All Stages" options={(filtersQ.data?.statuses ?? []).map((s) => ({ value: String(s.code), label: s.label }))} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} /></div>
        <div className="w-52"><FormSelect label="Partner" placeholder="All Partners" options={(filtersQ.data?.partners ?? []).map((p) => ({ value: String(p.id), label: p.name }))} value={orgId} onChange={(e) => { setOrgId(e.target.value); setPage(1); }} /></div>
        <div className="w-56"><label className="mb-1.5 block text-sm font-medium text-[#344054]">Search</label><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search student…" className="h-10 w-full rounded-lg border border-[#D0D5DD] px-3 text-sm outline-none focus:border-[#1570EF]" /></div>
        <Button variant="secondary" onClick={reset}>Reset</Button>
        <span className="ml-auto self-center text-xs text-[#98A2B3]">{total} {total === 1 ? "application" : "applications"}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
        <div className="flex items-center gap-2 border-b border-[#E4E7EC] px-5 py-3.5">
          <h3 className="text-[15px] font-semibold text-[#101828]">{SCOPES.find((s) => s.id === scope)?.label} Applications</h3>
          <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">{total}</span>
        </div>
        <div className="overflow-x-auto">
          {!mounted || listQ.isLoading ? (
            <div className="p-4"><SkeletonTable rows={8} cols={7} /></div>
          ) : (
            <table className="w-full border-collapse">
              <thead><tr>
                <th className={TH}>Student</th><th className={TH}>Partner</th><th className={TH}>University</th>
                <th className={TH}>Program</th><th className={TH}>Stage</th><th className={TH}>Intake</th>
                <th className={TH}>Country</th><th className={TH}>Processor</th><th className={TH}>Days</th><th className={`${TH} text-right`}>Actions</th>
              </tr></thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-[#98A2B3]">No applications found</td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#F9FAFB]">
                    <td className={TD}>
                      <Link href={`/admin/students/${r.studentId}`} className="font-semibold text-[#1570EF] hover:underline">
                        {r.student}
                      </Link>
                    </td>
                    <td className={TD}>{r.partner}</td>
                    <td className={TD}>{r.university}</td>
                    <td className="max-w-[220px] truncate px-3 py-3 text-[13px] text-[#344054]">{r.program}</td>
                    <td className={TD}>
                      {statusOptions.length > 0 ? (
                        <StageSelect applicationId={r.id} current={r.status} statuses={statusOptions} onDone={showToast} />
                      ) : (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${stageTone(r.status)}`}>{r.stage}</span>
                      )}
                    </td>
                    <td className={TD}>{r.intake}</td>
                    <td className={TD}>{r.country ? `${countryFlag(r.country)} ${r.country}` : "—"}</td>
                    <td className={TD}>{r.processor ?? <span className="text-[#98A2B3]">Unassigned</span>}</td>
                    <td className={TD}>{r.days}d</td>
                    <td className={`${TD} text-right`}>
                      <button
                        type="button"
                        onClick={() => setQuickLook(r.id)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[#D0D5DD] px-2.5 py-1 text-xs font-semibold text-[#344054] transition-colors hover:border-[#1570EF] hover:text-[#1570EF]"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
                        Quick look
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-[#E4E7EC] px-5 py-3">
            <span className="text-[13px] text-[#667085]">Page {page} of {totalPages} ({total} entries)</span>
            <div className="flex items-center gap-1.5">
              <button disabled={page === 1} onClick={() => setPage((p) => p - 1)} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-[13px] disabled:opacity-40">Prev</button>
              <span className="px-2 text-[13px] text-[#344054]">{page}</span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-md border border-[#D0D5DD] px-2.5 py-1 text-[13px] disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      {quickLook != null && (
        <QuickLookDrawer applicationId={quickLook} statuses={statusOptions} onToast={showToast} onClose={() => setQuickLook(null)} />
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}

// Inline stage picker for a row. A styled native <select> — its option list is
// drawn by the OS, so it's never clipped by the table's horizontal scroll, and
// <optgroup> gives the happy-path / terminal-outcome split. Reuses the shared
// students.setApplicationStatus mutation (stage history, dates, student-status
// sync, audit log all handled server-side).
function StageSelect({
  applicationId,
  current,
  statuses,
  onDone,
}: {
  applicationId: number;
  current: number;
  statuses: StatusOption[];
  onDone: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const label = (code: number) => statuses.find((s) => s.code === code)?.label ?? `Stage ${code}`;
  const mut = api.students.setApplicationStatus.useMutation({
    onSuccess: (_res, vars) => {
      void utils.applications.invalidate();
      onDone(`Stage updated to ${label(vars.status)}`);
    },
    onError: (e) => onDone(e.message),
  });
  const happy = statuses.filter((s) => s.code < 20);
  const terminal = statuses.filter((s) => s.code >= 20);

  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label="Change application stage"
        value={current}
        disabled={mut.isPending}
        onChange={(e) => {
          const code = Number(e.target.value);
          if (code !== current) mut.mutate({ applicationId, status: code });
        }}
        className={`cursor-pointer appearance-none rounded-full py-0.5 pr-6 pl-2.5 text-[11px] font-semibold outline-none focus:ring-2 focus:ring-[#B2DDFF] ${stageTone(current)} ${mut.isPending ? "opacity-60" : ""}`}
      >
        <optgroup label="Move to stage">
          {happy.map((s) => (
            <option key={s.code} value={s.code}>{s.label}</option>
          ))}
        </optgroup>
        <optgroup label="Mark as outcome">
          {terminal.map((s) => (
            <option key={s.code} value={s.code}>{s.label}</option>
          ))}
        </optgroup>
      </select>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute right-1.5 h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}

// ---- Quick-look drawer ------------------------------------------------------
const DrawerSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <div className="mb-2 text-[11px] font-semibold tracking-wide text-[#98A2B3] uppercase">{title}</div>
    {children}
  </div>
);
const InfoRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex justify-between gap-3 py-1 text-[13px]">
    <span className="text-[#667085]">{label}</span>
    <span className="text-right font-medium text-[#101828]">{value}</span>
  </div>
);
function docStatusPill(status: number): { label: string; cls: string } {
  if (status === 1) return { label: "Approved", cls: "bg-[#ECFDF3] text-[#067647]" };
  if (status === 2) return { label: "Rejected", cls: "bg-[#FEF3F2] text-[#B42318]" };
  return { label: "Pending", cls: "bg-[#FFFAEB] text-[#B54708]" };
}

// A right-side slide-over that peeks one application without leaving the filtered
// list. Read-mostly: shows profile / university / documents / timeline, lets you
// change the stage inline, and links out to the full profile.
function QuickLookDrawer({
  applicationId,
  statuses,
  onToast,
  onClose,
}: {
  applicationId: number;
  statuses: StatusOption[];
  onToast: (m: string) => void;
  onClose: () => void;
}) {
  const q = api.applications.detail.useQuery({ applicationId });
  const d = q.data;

  // Slide-in on mount, slide-out on close (waits for the transition before
  // unmounting via onClose).
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const close = useCallback(() => {
    setShown(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-black/30 transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`}
        onClick={close}
      />
      <div
        className={`absolute top-0 right-0 flex h-full w-full max-w-[440px] flex-col bg-white shadow-[0_0_50px_rgba(16,24,40,0.22)] transition-transform duration-300 ease-out ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#E4E7EC] px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold text-[#101828]">{d?.studentName ?? "Loading…"}</div>
            <div className="text-xs text-[#98A2B3]">{d?.universityAppId ? `University ID ${d.universityAppId}` : `Application #${applicationId}`}</div>
          </div>
          <button type="button" aria-label="Close" onClick={close} className="shrink-0 rounded-md p-1.5 text-[#98A2B3] hover:bg-[#F2F4F7] hover:text-[#344054]">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {q.isLoading || !d ? (
            <SkeletonTable rows={6} cols={2} />
          ) : (
            <>
              <DrawerSection title="Student">
                <div className="rounded-lg border border-[#E4E7EC] px-3 py-2">
                  <InfoRow label="Email" value={d.email} />
                  <InfoRow label="Phone" value={d.phone} />
                  <InfoRow label="Country" value={d.country ? `${countryFlag(d.country)} ${d.country}` : "—"} />
                  <InfoRow label="Intake" value={d.intake} />
                  <InfoRow label="Processor" value={d.processor ?? <span className="text-[#98A2B3]">Unassigned</span>} />
                </div>
              </DrawerSection>

              <DrawerSection title="University & Programme">
                <div className="rounded-lg border border-[#E4E7EC] px-3 py-2">
                  <InfoRow label="University" value={d.university} />
                  <InfoRow label="Programme" value={d.program} />
                </div>
              </DrawerSection>

              <DrawerSection title="Stage">
                <div className="flex items-center gap-2">
                  <StageSelect applicationId={d.applicationId} current={d.status} statuses={statuses} onDone={onToast} />
                  <span className="text-xs text-[#98A2B3]">change here or on the row</span>
                </div>
              </DrawerSection>

              <DrawerSection title={`Documents (${d.documents.length})`}>
                {d.documents.length === 0 ? (
                  <p className="text-[13px] text-[#98A2B3]">No documents uploaded yet.</p>
                ) : (
                  <ul className="divide-y divide-[#F2F4F7] rounded-lg border border-[#E4E7EC]">
                    {d.documents.map((doc) => {
                      const p = docStatusPill(doc.status);
                      return (
                        <li key={doc.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                          <span className="min-w-0 truncate text-[#344054]">{doc.name}</span>
                          <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${p.cls}`}>{p.label}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </DrawerSection>

              <DrawerSection title="Timeline">
                {d.timeline.length === 0 ? (
                  <p className="text-[13px] text-[#98A2B3]">No stage history yet.</p>
                ) : (
                  <ol className="relative space-y-3 border-l border-[#E4E7EC] pl-4">
                    {d.timeline.map((t) => (
                      <li key={t.stage} className="relative">
                        <span className="absolute top-1 -left-[21px] h-2.5 w-2.5 rounded-full bg-[#12B76A] ring-2 ring-white" />
                        <div className="text-[13px] font-semibold text-[#101828]">{t.label}</div>
                        <div className="text-xs text-[#98A2B3]">{formatDate(t.at)}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </DrawerSection>
            </>
          )}
        </div>

        <div className="border-t border-[#E4E7EC] px-5 py-3">
          {d && (
            <Link href={`/admin/students/${d.studentId}`} className="flex items-center justify-center gap-1.5 rounded-lg bg-[#1570EF] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1257c4]">
              Open full profile
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
