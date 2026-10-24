"use client";

import { Fragment, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { useExportLog } from "~/lib/export-log";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import {
  DashboardCard,
  StatCard,
  SkeletonTable,
  EmptyState,
} from "~/components/dashboard/widgets";
import { formatINR, formatDate } from "~/components/dashboard/format";
import {
  AdminRole,
  VendorInvoiceStatus,
  VendorInvoiceStatusLabel,
  VarianceReason,
  VarianceReasonLabel,
  VARIANCE_REASON_CODES,
  financialYearLabel,
  toINR,
} from "~/server/db/enums";

type RO = inferRouterOutputs<AppRouter>;
type BillingStudent = RO["universityBilling"]["vendorBillingStudents"][number];
type ConfirmedStudent =
  RO["universityBilling"]["confirmedStudents"]["students"][number];
type Invoice = RO["universityBilling"]["listVendorInvoices"][number];
type AgeingRow = RO["universityBilling"]["ageing"]["rows"][number];

const BILLING_CURRENCIES = ["USD", "GBP", "AUD", "CAD", "EUR", "INR", "NZD", "SGD"];

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";
const money = (n: number, ccy?: string) =>
  `${ccy ? ccy + " " : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayInput = () => new Date().toISOString().slice(0, 10);
const plusDaysInput = (d: number) =>
  new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

// ---- CSV --------------------------------------------------------------------
const csvCell = (v: string | number | null | undefined): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const content = rows.map((r) => r.map(csvCell).join(",")).join("\n");
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
const csvStamp = () => new Date().toISOString().slice(0, 10);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function InvoiceStatusPill({ status }: { status: number }) {
  const tone =
    status === VendorInvoiceStatus.FULLY_PAID
      ? "bg-[#ECFDF3] text-[#067647]"
      : status === VendorInvoiceStatus.PARTIAL_PAYMENT
        ? "bg-[#FFF6ED] text-[#B54708]"
        : status === VendorInvoiceStatus.SENT
          ? "bg-[#EFF8FF] text-[#1570EF]"
          : "bg-[#F2F4F7] text-[#667085]";
  return (
    <span className={`rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}>
      {VendorInvoiceStatusLabel[status as 0 | 1 | 2 | 3]}
    </span>
  );
}

// Per-commission tranche collection progress (pay-as-collected). Each collected
// tranche unlocks the partner's claim for that slice immediately.
function TrancheCollection({ tranches }: { tranches: { total: number; collected: number } }) {
  const done = tranches.collected >= tranches.total;
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-0.5">
        {Array.from({ length: tranches.total }, (_, i) => (
          <span
            key={i}
            className={`h-1.5 w-4 rounded-full ${i < tranches.collected ? "bg-[#12B76A]" : "bg-[#EAECF0]"}`}
          />
        ))}
      </div>
      <div className={`mt-1 text-[10px] ${done ? "text-[#067647]" : "text-[#98A2B3]"}`}>
        {tranches.collected}/{tranches.total} tranches collected
      </div>
    </div>
  );
}

function CountChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">
      {children}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

// ---- vendor → university grouping -------------------------------------------
type Groupable = {
  vendorId: number | null;
  vendorName: string;
  vendorType: number | null;
  universityId: number;
  university: string;
};
type VendorGroup<T> = {
  vendorId: number | null;
  vendorName: string;
  isDirect: boolean;
  total: number;
  unis: { universityId: number; university: string; students: T[] }[];
};
function groupByVendorUni<T extends Groupable>(rows: T[]): VendorGroup<T>[] {
  const m = new Map<string, VendorGroup<T>>();
  for (const r of rows) {
    const key = r.vendorId === null ? "direct" : String(r.vendorId);
    let g = m.get(key);
    if (!g) {
      g = {
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        isDirect: r.vendorId === null,
        total: 0,
        unis: [],
      };
      m.set(key, g);
    }
    let u = g.unis.find((x) => x.universityId === r.universityId);
    if (!u) {
      u = { universityId: r.universityId, university: r.university, students: [] };
      g.unis.push(u);
    }
    u.students.push(r);
    g.total++;
  }
  // Direct first, then vendors alphabetically.
  return Array.from(m.values()).sort((a, b) =>
    a.isDirect ? -1 : b.isDirect ? 1 : a.vendorName.localeCompare(b.vendorName),
  );
}

function VendorHeader({ g }: { g: VendorGroup<unknown> }) {
  return (
    <div className="flex items-center gap-2.5">
      <span>{g.isDirect ? "🏢" : "🤝"}</span>
      <span className="text-[15px] font-semibold text-[#101828]">{g.vendorName}</span>
      <span className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${g.isDirect ? "bg-[#F2F4F7] text-[#667085]" : "bg-[#ECFDF3] text-[#067647]"}`}>
        {g.isDirect ? "Direct Contract" : "Third-Party Vendor"}
      </span>
      <span className="text-xs text-[#98A2B3]">
        {g.unis.length} {g.unis.length === 1 ? "university" : "universities"} · {g.total}{" "}
        {g.total === 1 ? "student" : "students"}
      </span>
    </div>
  );
}

type ModalState =
  | { kind: "createInvoice"; vendorId: number | null; vendorName: string; students: BillingStudent[] }
  | { kind: "recordPayment"; invoice: Invoice }
  | null;

// =============================================================================
// useSearchParams (the ledger's ?recordPayment deep link) needs a Suspense
// boundary under the App Router.
export default function UniversityBillingPage() {
  return (
    <Suspense
      fallback={
        <DashboardCard title="University Billing" bodyClassName="p-0">
          <SkeletonTable rows={6} cols={6} />
        </DashboardCard>
      }
    >
      <UniversityBilling />
    </Suspense>
  );
}

function UniversityBilling() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const canView =
    role === AdminRole.SUPER_ADMIN ||
    role === AdminRole.FINANCE_MANAGER ||
    role === AdminRole.FINANCE_EXECUTIVE;
  const canEdit =
    role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;

  // `me` is cached client-side by the shell, so branching the page on it would
  // hydration-mismatch — gate on mount so SSR and the first client render match.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [tab, setTab] = useState<"confirmed" | "billing" | "ageing">("confirmed");
  const [fy, setFy] = useState<number | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (m: string) => {
    setToastMsg(m);
    setToastOpen(true);
  };

  const statsQ = api.universityBilling.stats.useQuery(fy ? { fy } : undefined, { enabled: canView });
  const fysQ = api.universityBilling.financialYears.useQuery(undefined, { enabled: canView });
  const confirmedQ = api.universityBilling.confirmedStudents.useQuery(undefined, { enabled: canView });
  const billingQ = api.universityBilling.vendorBillingStudents.useQuery(undefined, { enabled: canView });
  const s = statsQ.data;

  const attendedBadge = confirmedQ.data?.students.length ?? 0;
  const billedBadge = billingQ.data?.length ?? 0;

  // Commission Ledger → "Record collection" links here with
  // ?recordPayment=<vendorInvoiceId>: show that invoice on the Vendor Billing
  // tab and open its Record Payment modal. Handled once, then the param is
  // dropped so closing the modal doesn't reopen it.
  const searchParams = useSearchParams();
  const router = useRouter();
  const deepLinkId = Number(searchParams.get("recordPayment")) || null;
  const invoicesQ = api.universityBilling.listVendorInvoices.useQuery(undefined, {
    enabled: canView && deepLinkId != null,
  });
  const [focusInvoiceId, setFocusInvoiceId] = useState<number | null>(null);
  const handledDeepLink = useRef<number | null>(null);
  useEffect(() => {
    if (!mounted || deepLinkId == null || !invoicesQ.data) return;
    if (handledDeepLink.current === deepLinkId) return;
    handledDeepLink.current = deepLinkId;
    router.replace("/admin/university-billing", { scroll: false });
    const toast = (m: string) => {
      setToastMsg(m);
      setToastOpen(true);
    };
    const inv = invoicesQ.data.find((i) => i.id === deepLinkId);
    if (!inv) {
      toast("That vendor invoice no longer exists.");
      return;
    }
    setTab("billing");
    setFocusInvoiceId(inv.id);
    if (inv.status === VendorInvoiceStatus.FULLY_PAID) {
      toast(`Invoice ${inv.invoiceNumber} is already fully paid.`);
    } else if (!canEdit) {
      toast("Only Finance Managers and Super Admins can record a payment.");
    } else {
      setModal({ kind: "recordPayment", invoice: inv });
    }
  }, [mounted, deepLinkId, invoicesQ.data, canEdit, router]);

  if (!mounted || meQ.isLoading) {
    return (
      <DashboardCard title="University Billing" bodyClassName="p-0">
        <SkeletonTable rows={6} cols={6} />
      </DashboardCard>
    );
  }
  if (!canView) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-[#E4E7EC] bg-white px-8 py-12 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#FEF3F2] text-2xl">🔒</div>
          <h2 className="text-lg font-bold text-[#101828]">Access Restricted</h2>
          <p className="mt-2 text-sm text-[#667085]">
            Finance modules are available to Finance Managers and Admins only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#101828]">University Billing</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Confirm that attended students match vendor records, bill the vendor, and record payments received.
        </p>
      </div>

      {/* Stat cards + FY filter */}
      <div className="mb-5 flex items-end justify-between gap-3">
        <div className="grid flex-1 grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon="revenue" tone="blue" label="Expected (All Invoices)" sub="Converted to INR" value={s ? formatINR(s.expectedInr) : "—"} />
          <StatCard icon="revenue" tone="green" label="Received" sub="Converted to INR" value={s ? formatINR(s.receivedInr) : "—"} />
          <StatCard icon="clock" tone="orange" label="Outstanding" sub={s ? `${s.overdueCount} overdue` : undefined} value={s ? formatINR(s.outstandingInr) : "—"} />
          <StatCard icon="trophy" tone="purple" label="Collection Rate" value={s ? `${s.collectionRate}%` : "—"} />
        </div>
        <div className="w-44">
          <FormSelect
            label="Financial Year"
            placeholder="All years"
            options={(fysQ.data ?? []).map((y) => ({ value: String(y), label: financialYearLabel(y) }))}
            value={fy ? String(fy) : ""}
            onChange={(e) => setFy(e.target.value ? Number(e.target.value) : null)}
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-5 flex gap-2 border-b border-[#E4E7EC]">
        {([
          { id: "confirmed", label: "Confirmed Students", count: attendedBadge },
          { id: "billing", label: "Vendor Billing", count: billedBadge },
          { id: "ageing", label: "Ageing Report", count: null },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-semibold transition ${
              tab === t.id ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"
            }`}
          >
            {t.label}
            {t.count != null && <CountChip>{t.count}</CountChip>}
          </button>
        ))}
      </div>

      {tab === "confirmed" && <ConfirmedStudentsTab canEdit={canEdit} onToast={showToast} />}
      {tab === "billing" && (
        <VendorBillingTab
          canEdit={canEdit}
          focusInvoiceId={focusInvoiceId}
          onOpenCreateInvoice={(vendorId, vendorName, students) => setModal({ kind: "createInvoice", vendorId, vendorName, students })}
          onOpenRecordPayment={(invoice) => setModal({ kind: "recordPayment", invoice })}
        />
      )}
      {tab === "ageing" && <AgeingTab />}

      {modal?.kind === "createInvoice" && (
        <CreateInvoiceModal vendorId={modal.vendorId} vendorName={modal.vendorName} students={modal.students} onClose={() => setModal(null)} onToast={showToast} />
      )}
      {modal?.kind === "recordPayment" && (
        <RecordPaymentModal invoice={modal.invoice} onClose={() => setModal(null)} onToast={showToast} />
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );
}

// =============================================================================
// Tab 1 — Confirmed Students
// =============================================================================
function ConfirmedStudentsTab({ canEdit, onToast }: { canEdit: boolean; onToast: (m: string) => void }) {
  const utils = api.useUtils();
  const logExport = useExportLog();
  const q = api.universityBilling.confirmedStudents.useQuery();
  const [status, setStatus] = useState<"all" | "attended">("all");
  const confirm = api.universityBilling.confirmBilling.useMutation({
    onSuccess: () => {
      void utils.universityBilling.invalidate();
      onToast("Confirmed for billing");
    },
    onError: (e) => onToast(e.message),
  });

  const data = q.data;
  const students = useMemo(() => data?.students ?? [], [data]);
  const groups = useMemo(() => groupByVendorUni(students), [students]);
  const confirmedCount = data?.confirmedCount ?? 0;
  const attended = students.length;
  const progressTotal = confirmedCount + attended;
  const pct = progressTotal > 0 ? Math.round((confirmedCount / progressTotal) * 100) : 0;

  const exportRows = (vendorName: string | null, scoped: ConfirmedStudent[]) => {
    const withVendor = vendorName === null;
    const header = [
      ...(withVendor ? ["Vendor"] : []),
      "Student Name", "University Student ID", "CP Student ID", "University", "Program", "Intake", "Visa Secured Date", "Status",
    ];
    const body = scoped.map((r) => [
      ...(withVendor ? [r.vendorName] : []),
      r.studentName, r.universityStudentId ?? "", r.cpStudentId, r.university, r.program, r.intake ?? "", "", "Attended",
    ]);
    downloadCsv(
      withVendor ? `vendor-confirmation-all-${csvStamp()}.csv` : `vendor-confirmation-${slug(vendorName)}-${csvStamp()}.csv`,
      [header, ...body],
    );
    logExport("Vendor confirmation CSV", body.length);
  };

  if (q.isLoading)
    return (
      <DashboardCard title="Confirmed Students" bodyClassName="p-0">
        <SkeletonTable rows={5} cols={6} />
      </DashboardCard>
    );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-48">
          <FormSelect
            label="Status"
            options={[
              { value: "all", label: "All Statuses" },
              { value: "attended", label: "Attended" },
            ]}
            value={status}
            onChange={(e) => setStatus(e.target.value as "all" | "attended")}
          />
        </div>
        <Button variant="secondary" onClick={() => exportRows(null, students)} disabled={students.length === 0}>
          Download All
        </Button>
      </div>

      {/* Progress bar */}
      <div className="rounded-xl border border-[#E4E7EC] bg-white p-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-semibold text-[#101828]">Vendor Confirmation Progress</span>
          <span className="text-sm font-semibold text-[#1570EF]">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[#EAECF0]">
          <div className="h-full rounded-full bg-[#1570EF] transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-[#667085]">
          {pct >= 100
            ? "All attended students vendor-confirmed — ready for billing."
            : `${confirmedCount} of ${progressTotal} attended students confirmed — click Confirm to move to Vendor Billing.`}
        </p>
      </div>

      {students.length === 0 ? (
        <DashboardCard title="Confirmed Students" bodyClassName="p-0">
          <EmptyState label="No attended students awaiting confirmation. Confirm enrollment in Student Placements first." />
        </DashboardCard>
      ) : (
        groups.map((g) => (
          <div key={g.vendorId ?? "direct"} className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E4E7EC] px-5 py-3.5">
              <VendorHeader g={g} />
              {canEdit && (
                <button
                  className="text-[13px] font-semibold text-[#1570EF] hover:underline"
                  onClick={() => exportRows(g.vendorName, g.unis.flatMap((u) => u.students))}
                >
                  Download for Vendor
                </button>
              )}
            </div>
            {g.unis.map((u) => (
              <div key={u.universityId}>
                <div className="bg-[#F9FAFB] px-5 py-2 text-xs font-semibold tracking-wide text-[#475467] uppercase">
                  {u.university}
                </div>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={TH}>Student</th>
                      <th className={TH}>University Student ID</th>
                      <th className={TH}>Program</th>
                      <th className={TH}>Intake</th>
                      <th className={TH}>Status</th>
                      <th className={`${TH} text-right`}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.students.map((r) => (
                      <tr key={r.applicationId} className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
                        <td className={`${TD} font-medium text-[#101828]`}>
                          {r.studentName}
                          <span className="block text-xs font-normal text-[#98A2B3]">{r.cpStudentId}</span>
                        </td>
                        <td className={TD}>{r.universityStudentId ?? <span className="text-[#98A2B3] italic">Not entered</span>}</td>
                        <td className={TD}>{r.program}</td>
                        <td className={TD}>{r.intake ?? "—"}</td>
                        <td className={TD}>
                          <span className="rounded-[10px] bg-[#EFF8FF] px-2 py-0.5 text-[11px] font-semibold text-[#1570EF]">Attended</span>
                        </td>
                        <td className={`${TD} text-right`}>
                          {canEdit ? (
                            <Button
                              variant={r.hasDefaultRate ? "primary" : "secondary"}
                              className="!h-9 !px-4 !text-[13px]"
                              disabled={!r.hasDefaultRate || confirm.isPending}
                              onClick={() => confirm.mutate({ applicationId: r.applicationId })}
                            >
                              Confirm
                            </Button>
                          ) : !r.hasDefaultRate ? (
                            <span className="text-[11px] font-semibold text-[#B42318]">No default rate</span>
                          ) : (
                            <span className="text-xs text-[#98A2B3]">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// =============================================================================
// Tab 2 — Vendor Billing
// =============================================================================
type VbFilter = "total" | "not-invoiced" | "outstanding" | "paid" | null;

function VendorBillingTab({
  canEdit,
  focusInvoiceId,
  onOpenCreateInvoice,
  onOpenRecordPayment,
}: {
  canEdit: boolean;
  focusInvoiceId: number | null;
  onOpenCreateInvoice: (vendorId: number | null, vendorName: string, students: BillingStudent[]) => void;
  onOpenRecordPayment: (invoice: Invoice) => void;
}) {
  const studentsQ = api.universityBilling.vendorBillingStudents.useQuery();
  const invoicesQ = api.universityBilling.listVendorInvoices.useQuery();
  const students = useMemo(() => studentsQ.data ?? [], [studentsQ.data]);
  const invoices = useMemo(() => invoicesQ.data ?? [], [invoicesQ.data]);

  const [view, setView] = useState<"students" | "invoices">("students");
  const [filter, setFilter] = useState<VbFilter>(null);
  const [jumpTo, setJumpTo] = useState<number | null>(null);

  // Stat-card aggregates.
  const invoicedStudents = students.filter((s) => s.invoice != null).length;
  const notInvoiced = students.filter((s) => s.invoice == null).length;
  const outstandingInvoices = invoices.filter(
    (i) => i.status === VendorInvoiceStatus.SENT || i.status === VendorInvoiceStatus.PARTIAL_PAYMENT,
  );
  const fullyPaidInvoices = invoices.filter((i) => i.status === VendorInvoiceStatus.FULLY_PAID);
  const outstandingInr = outstandingInvoices.reduce(
    (s, i) => s + Math.max(0, toINR(i.totalExpected, i.currency) - i.paidInr),
    0,
  );
  const paidInr = fullyPaidInvoices.reduce((s, i) => s + i.paidInr, 0);

  const clickCard = (f: Exclude<VbFilter, null>, v: "students" | "invoices") => {
    setJumpTo(null);
    if (filter === f) {
      setFilter(null);
    } else {
      setFilter(f);
      setView(v);
    }
  };
  const manualView = (v: "students" | "invoices") => {
    setView(v);
    setFilter(null);
    setJumpTo(null);
  };
  const jumpToInvoice = (id: number) => {
    setFilter(null);
    setView("invoices");
    setJumpTo(id);
  };
  // Deep link from the Commission Ledger: show that invoice.
  useEffect(() => {
    if (focusInvoiceId == null) return;
    setFilter(null);
    setView("invoices");
    setJumpTo(focusInvoiceId);
  }, [focusInvoiceId]);

  return (
    <div className="space-y-5">
      {/* Clickable filter cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="applications" tone="blue" label="Total Invoiced" value={invoicedStudents} sub="students" active={filter === "total"} onClick={() => clickCard("total", "invoices")} />
        <StatCard icon="clock" tone="orange" label="Not Yet Invoiced" value={notInvoiced} sub="students" active={filter === "not-invoiced"} onClick={() => clickCard("not-invoiced", "students")} />
        <StatCard icon="deposit" tone="orange" label="Outstanding" value={outstandingInvoices.length} sub={formatINR(Math.round(outstandingInr * 100) / 100)} active={filter === "outstanding"} onClick={() => clickCard("outstanding", "invoices")} />
        <StatCard icon="revenue" tone="green" label="Fully Paid" value={fullyPaidInvoices.length} sub={formatINR(Math.round(paidInr * 100) / 100)} active={filter === "paid"} onClick={() => clickCard("paid", "invoices")} />
      </div>

      {/* View toggle */}
      <div className="inline-flex rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] p-0.5">
        {([
          { id: "students", label: "Students", count: students.length },
          { id: "invoices", label: "Invoices", count: invoices.length },
        ] as const).map((v) => (
          <button
            key={v.id}
            onClick={() => manualView(v.id)}
            className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-[13px] font-semibold transition ${
              view === v.id ? "bg-white text-[#1570EF] shadow-sm" : "text-[#667085]"
            }`}
          >
            {v.label} <span className="text-[#98A2B3]">{v.count}</span>
          </button>
        ))}
      </div>

      {view === "students" ? (
        <BillingStudentsView
          canEdit={canEdit}
          students={students}
          loading={studentsQ.isLoading}
          onlyNotInvoiced={filter === "not-invoiced"}
          onOpenCreateInvoice={onOpenCreateInvoice}
          onJumpToInvoice={jumpToInvoice}
        />
      ) : (
        <InvoicesView
          canEdit={canEdit}
          invoices={invoices}
          loading={invoicesQ.isLoading}
          filter={filter}
          jumpTo={jumpTo}
          onOpenRecordPayment={onOpenRecordPayment}
        />
      )}
    </div>
  );
}

function BillingStudentsView({
  canEdit,
  students,
  loading,
  onlyNotInvoiced,
  onOpenCreateInvoice,
  onJumpToInvoice,
}: {
  canEdit: boolean;
  students: BillingStudent[];
  loading: boolean;
  onlyNotInvoiced: boolean;
  onOpenCreateInvoice: (vendorId: number | null, vendorName: string, students: BillingStudent[]) => void;
  onJumpToInvoice: (id: number) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const rows = useMemo(
    () => (onlyNotInvoiced ? students.filter((s) => s.invoice == null) : students),
    [students, onlyNotInvoiced],
  );
  const groups = useMemo(() => groupByVendorUni(rows), [rows]);

  const toggle = (id: number) =>
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const setMany = (ids: number[], on: boolean) =>
    setSelected((p) => {
      const n = new Set(p);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });

  const selectedStudents = students.filter((s) => selected.has(s.commissionId));
  const selectedVendors = new Set(selectedStudents.map((s) => s.vendorId ?? "direct"));
  const sameVendor = selectedVendors.size <= 1;

  const createFromSelection = () => {
    if (selectedStudents.length === 0) return;
    if (!sameVendor) return;
    const first = selectedStudents[0]!;
    onOpenCreateInvoice(first.vendorId, first.vendorName, selectedStudents);
  };

  if (loading)
    return (
      <DashboardCard title="Vendor Billing" bodyClassName="p-0">
        <SkeletonTable rows={5} cols={7} />
      </DashboardCard>
    );
  if (rows.length === 0)
    return (
      <DashboardCard title="Vendor Billing" bodyClassName="p-0">
        <EmptyState label={onlyNotInvoiced ? "Everything's invoiced — nothing left to bill." : "No students ready to bill. Confirm attended students first."} />
      </DashboardCard>
    );

  return (
    <div className="space-y-4 pb-16">
      {groups.map((g) => (
        <div key={g.vendorId ?? "direct"} className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
          <div className="border-b border-[#E4E7EC] px-5 py-3.5">
            <VendorHeader g={g} />
          </div>
          {g.unis.map((u) => {
            const billable = u.students.filter((st) => st.invoice == null).map((st) => st.commissionId);
            const allSelected = billable.length > 0 && billable.every((id) => selected.has(id));
            return (
              <div key={u.universityId}>
                <div className="bg-[#F9FAFB] px-5 py-2 text-xs font-semibold tracking-wide text-[#475467] uppercase">
                  {u.university}
                </div>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={`${TH} w-10`}>
                        {canEdit && (
                          <input
                            type="checkbox"
                            aria-label="Select all billable"
                            checked={allSelected}
                            disabled={billable.length === 0}
                            onChange={(e) => setMany(billable, e.target.checked)}
                          />
                        )}
                      </th>
                      <th className={TH}>Student</th>
                      <th className={TH}>University Student ID</th>
                      <th className={TH}>Program</th>
                      <th className={TH}>Tuition</th>
                      <th className={TH}>Commission</th>
                      <th className={TH}>Calc. Amount</th>
                      <th className={TH}>Rate Type</th>
                      <th className={TH}>Invoice Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.students.map((st) => {
                      const invoiced = st.invoice != null;
                      return (
                        <tr key={st.commissionId} className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
                          <td className={`${TD} w-10`}>
                            {canEdit && (
                              <input
                                type="checkbox"
                                checked={selected.has(st.commissionId)}
                                disabled={invoiced}
                                onChange={() => toggle(st.commissionId)}
                              />
                            )}
                          </td>
                          <td className={`${TD} font-medium text-[#101828]`}>
                            {st.studentName}
                            <span className="block text-xs font-normal text-[#98A2B3]">{st.cpStudentId}</span>
                          </td>
                          <td className={TD}>{st.universityStudentId ?? <span className="text-[#98A2B3] italic">Not entered</span>}</td>
                          <td className={TD}>{st.program}</td>
                          <td className={TD}>{money(st.tuition, st.currency)}</td>
                          <td className={TD}>{st.rate > 0 ? `${st.rate}%` : money(st.calcAmount, st.currency)}</td>
                          <td className={`${TD} font-semibold text-[#101828]`}>{money(st.calcAmount, st.currency)}</td>
                          <td className={TD}>
                            <span className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${st.rateType === "Program-specific" ? "bg-[#F9F5FF] text-[#7F56D9]" : "bg-[#F2F4F7] text-[#667085]"}`}>
                              {st.rateType}
                            </span>
                          </td>
                          <td className={TD}>
                            {invoiced ? (
                              <div className="flex items-center gap-2">
                                <button className="text-[13px] font-semibold text-[#1570EF] hover:underline" onClick={() => onJumpToInvoice(st.invoice!.id)}>
                                  {st.invoice!.number}
                                </button>
                                <InvoiceStatusPill status={st.invoice!.status} />
                              </div>
                            ) : (
                              <span className="rounded-[10px] bg-[#FEF3F2] px-2 py-0.5 text-[11px] font-semibold text-[#B42318]">Not Invoiced</span>
                            )}
                            {st.tranches.total > 1 && <TrancheCollection tranches={st.tranches} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      ))}

      {/* Floating selection bar */}
      {canEdit && selectedStudents.length > 0 && (
        <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-[#E4E7EC] bg-white px-5 py-3 shadow-[0_8px_24px_rgba(16,24,40,0.12)]">
          <span className="text-sm font-semibold text-[#101828]">
            {selectedStudents.length} student{selectedStudents.length === 1 ? "" : "s"} selected
          </span>
          {!sameVendor && <span className="text-xs font-medium text-[#B42318]">Select one vendor at a time</span>}
          <Button variant="secondary" className="!h-9 !px-4 !text-[13px]" onClick={() => setSelected(new Set())}>Clear</Button>
          <Button className="!h-9 !px-4 !text-[13px]" disabled={!sameVendor} onClick={createFromSelection}>Create Invoice</Button>
        </div>
      )}
    </div>
  );
}

function InvoicesView({
  canEdit,
  invoices,
  loading,
  filter,
  jumpTo,
  onOpenRecordPayment,
}: {
  canEdit: boolean;
  invoices: Invoice[];
  loading: boolean;
  filter: VbFilter;
  jumpTo: number | null;
  onOpenRecordPayment: (invoice: Invoice) => void;
}) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const logExport = useExportLog();
  const toggle = (id: number) =>
    setOpen((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  useEffect(() => {
    if (jumpTo == null) return;
    setOpen((p) => new Set(p).add(jumpTo));
    const el = document.getElementById(`inv-${jumpTo}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [jumpTo]);

  const rows = useMemo(() => {
    if (filter === "outstanding")
      return invoices.filter((i) => i.status === VendorInvoiceStatus.SENT || i.status === VendorInvoiceStatus.PARTIAL_PAYMENT);
    if (filter === "paid") return invoices.filter((i) => i.status === VendorInvoiceStatus.FULLY_PAID);
    return invoices;
  }, [invoices, filter]);

  const invUniversity = (inv: Invoice): string => {
    const unis = Array.from(new Set(inv.items.map((it) => it.university)));
    return unis.length === 0 ? "—" : unis.length === 1 ? unis[0]! : "Multiple";
  };

  const downloadInvoice = (inv: Invoice) => {
    const paid = Math.round(inv.payments.reduce((s, p) => s + p.amountForeign, 0) * 100) / 100;
    const header = ["Student Name", "University Student ID", "Program", "Calculated Amount", "Expected Amount", "Variance", "Variance Reason"];
    const body = inv.items.map((it) => [
      it.student, it.universityStudentId ?? "", it.program, it.calculated, it.expected, it.variance,
      it.varianceReason === VarianceReason.NONE ? "" : VarianceReasonLabel[it.varianceReason as 0 | 1 | 2 | 3 | 4],
    ]);
    const footer = [
      [],
      ["Invoice", inv.invoiceNumber, "Vendor", inv.vendorName, "University", invUniversity(inv)],
      ["Currency", inv.currency, "Total Expected", inv.totalExpected, "Total Paid (≈)", paid, "Status", VendorInvoiceStatusLabel[inv.status as 0 | 1 | 2 | 3]],
    ];
    downloadCsv(`${inv.invoiceNumber}.csv`, [header, ...body, ...footer]);
    logExport(`Vendor invoice ${inv.invoiceNumber} CSV`, body.length);
  };

  if (loading)
    return (
      <DashboardCard title="Vendor Invoices" bodyClassName="p-0">
        <SkeletonTable rows={4} cols={6} />
      </DashboardCard>
    );
  if (rows.length === 0)
    return (
      <DashboardCard title="Vendor Invoices" bodyClassName="p-0">
        <EmptyState label="No invoices to show." />
      </DashboardCard>
    );

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="hidden grid-cols-[24px_1.3fr_1.2fr_1.3fr_60px_1fr_70px_110px_90px] gap-3 px-5 text-[11px] font-semibold tracking-wider text-[#667085] uppercase lg:grid">
        <span></span><span>Invoice #</span><span>Vendor</span><span>University</span><span>Students</span><span>Expected</span><span>Currency</span><span>Status</span><span>Date</span>
      </div>
      {rows.map((inv) => {
        const isOpen = open.has(inv.id);
        const paidForeign = Math.round(inv.payments.reduce((s, p) => s + p.amountForeign, 0) * 100) / 100;
        const remaining = Math.max(0, Math.round((inv.totalExpected - paidForeign) * 100) / 100);
        return (
          <div key={inv.id} id={`inv-${inv.id}`} className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
            <button onClick={() => toggle(inv.id)} className="grid w-full grid-cols-[24px_1.3fr_1.2fr_1.3fr_60px_1fr_70px_110px_90px] items-center gap-3 px-5 py-4 text-left">
              <span className="text-[#667085]"><Chevron open={isOpen} /></span>
              <span className="font-semibold text-[#101828]">{inv.invoiceNumber}</span>
              <span className="text-sm text-[#344054]">{inv.vendorName}</span>
              <span className="text-sm text-[#344054]">{invUniversity(inv)}</span>
              <span className="text-sm text-[#344054]">{inv.items.length}</span>
              <span className="text-sm font-semibold text-[#101828]">{money(inv.totalExpected)}</span>
              <span className="text-sm text-[#344054]">{inv.currency}</span>
              <span><InvoiceStatusPill status={inv.status} /></span>
              <span className="text-xs text-[#98A2B3]">{formatDate(inv.invoiceDate)}</span>
            </button>
            {isOpen && (
              <div className="space-y-4 border-t border-[#E4E7EC] px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-[#667085]">received ₹{inv.paidInr.toLocaleString()} · remaining {money(remaining, inv.currency)}</div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" className="!h-9 !px-4 !text-[13px]" onClick={() => downloadInvoice(inv)}>Download CSV</Button>
                    {canEdit && inv.status !== VendorInvoiceStatus.FULLY_PAID && (
                      <Button className="!h-9 !px-4 !text-[13px]" onClick={() => onOpenRecordPayment(inv)}>Record Payment</Button>
                    )}
                  </div>
                </div>
                {/* Line items */}
                <div className="overflow-hidden rounded-lg border border-[#E4E7EC]">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={TH}>Student</th>
                        <th className={TH}>University ID</th>
                        <th className={TH}>Program</th>
                        <th className={TH}>Calculated</th>
                        <th className={TH}>Expected</th>
                        <th className={TH}>Variance</th>
                        <th className={TH}>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inv.items.map((it) => (
                        <tr key={it.id} className="border-b border-[#F2F4F7] last:border-0">
                          <td className={`${TD} font-medium text-[#101828]`}>{it.student}</td>
                          <td className={TD}>{it.universityStudentId ?? "—"}</td>
                          <td className={TD}>{it.program}</td>
                          <td className={TD}>{money(it.calculated, inv.currency)}</td>
                          <td className={TD}>{money(it.expected, inv.currency)}</td>
                          <td className={`${TD} ${it.variance < 0 ? "text-[#B42318]" : it.variance > 0 ? "text-[#067647]" : ""}`}>
                            {it.variance > 0 ? "+" : ""}{money(it.variance, inv.currency)}
                          </td>
                          <td className={TD}>{it.varianceReason === VarianceReason.NONE ? "—" : VarianceReasonLabel[it.varianceReason as 0 | 1 | 2 | 3 | 4]}</td>
                        </tr>
                      ))}
                      <tr className="bg-[#F9FAFB] font-semibold text-[#101828]">
                        <td className={TD} colSpan={4}>Totals</td>
                        <td className={TD}>{money(inv.totalExpected, inv.currency)}</td>
                        <td className={TD} colSpan={2}></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {/* Payments */}
                <div>
                  <div className="mb-1 text-xs font-semibold tracking-wide text-[#98A2B3] uppercase">Payments ({inv.payments.length})</div>
                  {inv.payments.length === 0 ? (
                    <p className="text-sm text-[#98A2B3]">No payments recorded.</p>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-[#E4E7EC]">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr>
                            <th className={TH}>Date</th>
                            <th className={TH}>Amount (₹)</th>
                            <th className={TH}>FX Rate</th>
                            <th className={TH}>= {inv.currency}</th>
                            <th className={TH}>Reference</th>
                            <th className={TH}>Tranche</th>
                            <th className={TH}>Final?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {inv.payments.map((p) => (
                            <tr key={p.id} className="border-b border-[#F2F4F7] last:border-0">
                              <td className={TD}>{formatDate(p.date)}</td>
                              <td className={`${TD} font-semibold text-[#101828]`}>₹{p.amountInr.toLocaleString()}</td>
                              <td className={TD}>{p.exchangeRate}</td>
                              <td className={TD}>{money(p.amountForeign, inv.currency)}</td>
                              <td className={TD}>{p.reference ?? "—"}</td>
                              <td className={TD}>{p.isTranche ? `${p.trancheNumber}/${p.totalTranches}` : "—"}</td>
                              <td className={TD}>{p.isFinal ? "✓" : "—"}</td>
                            </tr>
                          ))}
                          <tr className="bg-[#F9FAFB] font-semibold text-[#101828]">
                            <td className={TD}>Total Paid</td>
                            <td className={TD}>₹{inv.paidInr.toLocaleString()}</td>
                            <td className={TD} colSpan={5}>
                              <span className="text-[#667085]">Remaining: </span>{money(remaining, inv.currency)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                {inv.notes && <p className="text-xs text-[#667085]"><span className="font-semibold">Notes:</span> {inv.notes}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// Tab 3 — Ageing Report
// =============================================================================
const AGEING_BUCKETS = ["Current (0–30 days)", "31–60 days", "61–90 days", "90+ days"];
const SEVERITY = ["Current", "31–60d", "61–90d", "90+d"];
type SortKey = "vendor" | "university" | "outstanding" | "due" | "days";

function AgeingTab() {
  const q = api.universityBilling.ageing.useQuery();
  const data = q.data;
  const [vendorFilter, setVendorFilter] = useState<string>("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "days", dir: -1 });

  const vendors = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map((r) => r.vendorName))).sort(),
    [data],
  );
  const rows = useMemo(() => {
    let r = data?.rows ?? [];
    if (vendorFilter) r = r.filter((x) => x.vendorName === vendorFilter);
    const key = sort.key;
    const val = (row: AgeingRow): string | number =>
      key === "vendor" ? row.vendorName
      : key === "university" ? row.university
      : key === "outstanding" ? row.outstandingInr
      : key === "due" ? (row.dueDate ? new Date(row.dueDate).getTime() : 0)
      : row.daysOverdue;
    return [...r].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av < bv) return -1 * sort.dir;
      if (av > bv) return 1 * sort.dir;
      return 0;
    });
  }, [data, vendorFilter, sort]);

  const setSortKey = (key: SortKey) =>
    setSort((p) => (p.key === key ? { key, dir: p.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const SortTh = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th className={`${TH} cursor-pointer select-none`} onClick={() => setSortKey(k)}>
      {children}
      {sort.key === k && <span className="ml-1 text-[#1570EF]">{sort.dir === 1 ? "▲" : "▼"}</span>}
    </th>
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {AGEING_BUCKETS.map((label, i) => {
          const b = data?.buckets.find((x) => x.bucket === i);
          return (
            <div key={i} className="rounded-xl border border-[#E4E7EC] bg-white p-4">
              <div className={`text-[26px] font-extrabold ${i >= 2 ? "text-[#B42318]" : "text-[#101828]"}`}>{b?.count ?? 0}</div>
              <div className="mt-1 text-[13px] font-medium text-[#667085]">{label}</div>
              <div className="mt-0.5 text-xs text-[#98A2B3]">{formatINR(b?.inrTotal ?? 0)}</div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <FormSelect
            label="Vendor / Partner"
            placeholder="All Vendors / Partners"
            options={vendors.map((v) => ({ value: v, label: v }))}
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
          />
        </div>
        <Button variant="secondary" onClick={() => { setVendorFilter(""); setSort({ key: "days", dir: -1 }); }}>Reset</Button>
      </div>

      <DashboardCard
        title="Outstanding Invoices"
        bodyClassName="p-0"
        headerRight={<CountChip>{rows.length} {rows.length === 1 ? "invoice" : "invoices"}</CountChip>}
      >
        {q.isLoading ? (
          <SkeletonTable rows={4} cols={7} />
        ) : rows.length === 0 ? (
          <EmptyState label="No outstanding invoices — everything's collected." />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <SortTh k="vendor">Vendor</SortTh>
                <SortTh k="university">University</SortTh>
                <th className={TH}>Invoice #</th>
                <th className={TH}>Students</th>
                <SortTh k="outstanding">Outstanding (₹)</SortTh>
                <th className={TH}>Currency</th>
                <SortTh k="due">Due Date</SortTh>
                <SortTh k="days">Days Overdue</SortTh>
                <th className={TH}>Severity</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[#F2F4F7] last:border-0">
                  <td className={`${TD} font-medium text-[#101828]`}>{r.vendorName}</td>
                  <td className={TD}>{r.university}</td>
                  <td className={TD}>{r.invoiceNumber}</td>
                  <td className={TD}>{r.students}</td>
                  <td className={`${TD} font-semibold text-[#101828]`}>{formatINR(r.outstandingInr)}</td>
                  <td className={TD}>{r.currency}</td>
                  <td className={TD}>{r.dueDate ? formatDate(r.dueDate) : "—"}</td>
                  <td className={`${TD} ${r.daysOverdue > 0 ? "font-semibold text-[#B42318]" : ""}`}>{r.daysOverdue > 0 ? `${r.daysOverdue}d` : "—"}</td>
                  <td className={TD}>
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${r.bucket === 0 ? "bg-[#12B76A]" : r.bucket === 1 ? "bg-[#F79009]" : r.bucket === 2 ? "bg-[#F04438]" : "bg-[#B42318]"}`} />
                      {SEVERITY[r.bucket]}
                    </span>
                  </td>
                  <td className={TD}><InvoiceStatusPill status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DashboardCard>
    </div>
  );
}

// =============================================================================
// Create Invoice modal
// =============================================================================
type Line = {
  commissionId: number;
  student: string;
  cpStudentId: string;
  universityStudentId: string | null;
  university: string;
  program: string;
  rate: number;
  storedCalc: number;
  tuition: string;
  expected: string;
  reason: number;
  note: string;
};

function CreateInvoiceModal({
  vendorId,
  vendorName,
  students,
  onClose,
  onToast,
}: {
  vendorId: number | null;
  vendorName: string;
  students: BillingStudent[];
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const utils = api.useUtils();
  const [lines, setLines] = useState<Line[]>(
    students.map((st) => ({
      commissionId: st.commissionId,
      student: st.studentName,
      cpStudentId: st.cpStudentId,
      universityStudentId: st.universityStudentId,
      university: st.university,
      program: st.program,
      rate: st.rate,
      storedCalc: st.calcAmount,
      tuition: String(st.tuition),
      expected: String(st.calcAmount),
      reason: VarianceReason.NONE,
      note: "",
    })),
  );
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [currency, setCurrency] = useState(students[0]?.currency ?? "USD");
  const [invoiceDate, setInvoiceDate] = useState(todayInput());
  const [dueDate, setDueDate] = useState(plusDaysInput(30));
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");

  const universities = Array.from(new Set(students.map((s) => s.university)));

  const create = api.universityBilling.createVendorInvoice.useMutation({
    onSuccess: () => {
      void utils.universityBilling.invalidate();
      onToast("Invoice created");
      onClose();
    },
    onError: (e) => setErr(e.message),
  });

  const calcFor = (l: Line) => {
    const t = Number(l.tuition);
    if (l.rate > 0) return Math.round(((t * l.rate) / 100) * 100) / 100;
    return l.storedCalc;
  };
  const varianceFor = (l: Line) => Math.round((Number(l.expected) - calcFor(l)) * 100) / 100;
  const totalExpected = lines.reduce((sum, l) => sum + (Number(l.expected) || 0), 0);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = () => {
    if (!invoiceNumber.trim()) return setErr("Invoice number is required");
    for (const l of lines) {
      if (l.tuition.trim() === "" || Number.isNaN(Number(l.tuition)))
        return setErr(`Enter tuition for ${l.student}`);
      if (varianceFor(l) !== 0 && l.reason === VarianceReason.NONE)
        return setErr(`Pick a variance reason for ${l.student}`);
      if (varianceFor(l) !== 0 && l.reason === VarianceReason.OTHER && !l.note.trim())
        return setErr(`Enter the "Other" reason for ${l.student}`);
    }
    create.mutate({
      vendorId,
      invoiceNumber: invoiceNumber.trim(),
      currency: currency as "USD",
      invoiceDate,
      dueDate: dueDate || undefined,
      notes: notes || undefined,
      lines: lines.map((l) => ({
        commissionId: l.commissionId,
        tuitionAmount: Number(l.tuition),
        expectedAmount: Number(l.expected),
        varianceReason: l.reason,
        varianceNote: l.note || undefined,
      })),
    });
  };

  return (
    <Modal
      open
      title="Create Invoice"
      width="w-[920px]"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={create.isPending}>Create Invoice</Button>
        </>
      }
    >
      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <span className="rounded-lg bg-[#F9FAFB] px-3 py-1.5 text-xs text-[#344054]"><span className="text-[#98A2B3]">Vendor:</span> <span className="font-semibold text-[#101828]">{vendorName}</span></span>
        <span className="rounded-lg bg-[#F9FAFB] px-3 py-1.5 text-xs text-[#344054]">
          <span className="text-[#98A2B3]">{universities.length === 1 ? "University:" : "Universities:"}</span>{" "}
          <span className="font-semibold text-[#101828]">{universities.length === 1 ? universities[0] : `${universities.length} universities`}</span>
        </span>
        <span className="rounded-lg bg-[#F9FAFB] px-3 py-1.5 text-xs text-[#344054]"><span className="text-[#98A2B3]">Students:</span> <span className="font-semibold text-[#101828]">{lines.length}</span></span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[#E4E7EC]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>Student</th>
              <th className={TH}>University</th>
              <th className={TH}>Program</th>
              <th className={TH}>Comm %</th>
              <th className={TH}>Tuition</th>
              <th className={TH}>Comm Amt</th>
              <th className={TH}>Expected</th>
              <th className={TH}>Variance</th>
              <th className={TH}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const v = varianceFor(l);
              return (
                <tr key={l.commissionId} className="border-b border-[#F2F4F7] last:border-0 align-top">
                  <td className={`${TD} font-medium text-[#101828]`}>
                    {l.student}
                    <span className="block text-xs font-normal text-[#98A2B3]">{l.universityStudentId ?? l.cpStudentId}</span>
                  </td>
                  <td className={TD}>{l.university}</td>
                  <td className={TD}>{l.program}</td>
                  <td className={TD}>{l.rate > 0 ? `${l.rate}%` : "Flat"}</td>
                  <td className={TD}>
                    <input type="number" value={l.tuition} onChange={(e) => setLine(i, { tuition: e.target.value })} className="h-9 w-24 rounded-md border border-[#D0D5DD] px-2 text-sm outline-none focus:border-[#1570EF]" />
                  </td>
                  <td className={`${TD} font-semibold text-[#067647]`}>{money(calcFor(l))}</td>
                  <td className={TD}>
                    <input type="number" value={l.expected} onChange={(e) => setLine(i, { expected: e.target.value })} className="h-9 w-24 rounded-md border border-[#D0D5DD] px-2 text-sm outline-none focus:border-[#1570EF]" />
                  </td>
                  <td className={`${TD} ${v < 0 ? "text-[#B42318]" : v > 0 ? "text-[#067647]" : ""}`}>{v > 0 ? "+" : ""}{money(v)}</td>
                  <td className={TD}>
                    {v === 0 ? (
                      <span className="text-[#98A2B3]">—</span>
                    ) : (
                      <div className="space-y-1.5">
                        <select value={String(l.reason)} onChange={(e) => setLine(i, { reason: Number(e.target.value) })} className="h-9 rounded-md border border-[#D0D5DD] px-2 text-sm outline-none focus:border-[#1570EF]">
                          {VARIANCE_REASON_CODES.map((code) => (
                            <option key={code} value={code}>{code === VarianceReason.OTHER ? "Other..." : VarianceReasonLabel[code]}</option>
                          ))}
                        </select>
                        {l.reason === VarianceReason.OTHER && (
                          <input value={l.note} onChange={(e) => setLine(i, { note: e.target.value })} placeholder="Enter reason..." className="h-9 w-40 rounded-md border border-[#D0D5DD] px-2 text-sm outline-none focus:border-[#1570EF]" />
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-right text-sm font-semibold text-[#101828]">Total Expected Amount: {money(totalExpected, currency)}</div>

      <div className="flex gap-3">
        <FormInput label="Invoice Number" required value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder={`INV-${new Date().getFullYear()}-001`} />
        <FormSelect label="Currency" options={BILLING_CURRENCIES.map((c) => ({ value: c, label: c }))} value={currency} onChange={(e) => setCurrency(e.target.value)} />
      </div>
      <div className="flex gap-3">
        <FormInput label="Invoice Date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        <FormInput label="Due Date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <FormTextarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <p className="text-xs font-medium text-[#F04438]">{err}</p>}
    </Modal>
  );
}

// =============================================================================
// Record Payment modal (FX)
// =============================================================================
function RecordPaymentModal({
  invoice,
  onClose,
  onToast,
}: {
  invoice: Invoice;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const utils = api.useUtils();
  const [amountInr, setAmountInr] = useState("");
  const [rate, setRate] = useState("");
  const [date, setDate] = useState(todayInput());
  const [reference, setReference] = useState("");
  const [isTranche, setIsTranche] = useState(false);
  const [trancheNumber, setTrancheNumber] = useState("");
  const [totalTranches, setTotalTranches] = useState("");
  const [isFinal, setIsFinal] = useState(true);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");

  const paidForeign = Math.round(invoice.payments.reduce((s, p) => s + p.amountForeign, 0) * 100) / 100;
  const remaining = Math.max(0, Math.round((invoice.totalExpected - paidForeign) * 100) / 100);

  const record = api.universityBilling.recordVendorPayment.useMutation({
    onSuccess: () => {
      void utils.universityBilling.invalidate();
      // The ledger's stage + next step change with collection.
      void utils.commissions.invalidate();
      onToast(isFinal ? "Payment recorded — students now claimable" : "Partial payment recorded");
      onClose();
    },
    onError: (e) => setErr(e.message),
  });

  const equivalent =
    amountInr && rate && Number(rate) > 0 ? Math.round((Number(amountInr) / Number(rate)) * 100) / 100 : null;

  const save = () => {
    if (!amountInr || Number(amountInr) <= 0) return setErr("Enter the rupee amount received");
    if (!rate || Number(rate) <= 0) return setErr("Enter the exchange rate");
    record.mutate({
      vendorInvoiceId: invoice.id,
      amountInr: Number(amountInr),
      exchangeRate: Number(rate),
      paymentDate: date,
      reference: reference || undefined,
      isTranche,
      trancheNumber: isTranche && trancheNumber ? Number(trancheNumber) : undefined,
      totalTranches: isTranche && totalTranches ? Number(totalTranches) : undefined,
      isFinal,
      notes: notes || undefined,
    });
  };

  return (
    <Modal
      open
      title="Record Payment"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={record.isPending}>Record Payment</Button>
        </>
      }
    >
      {/* Summary box */}
      <div className="grid grid-cols-2 gap-y-1.5 rounded-lg bg-[#F9FAFB] px-3.5 py-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-[11px] tracking-wide text-[#98A2B3] uppercase">Invoice</div>
          <div className="font-semibold text-[#101828]">{invoice.invoiceNumber}</div>
        </div>
        <div>
          <div className="text-[11px] tracking-wide text-[#98A2B3] uppercase">Total Expected</div>
          <div className="font-semibold text-[#101828]">{money(invoice.totalExpected, invoice.currency)}</div>
        </div>
        <div>
          <div className="text-[11px] tracking-wide text-[#98A2B3] uppercase">Total Paid</div>
          <div className="font-semibold text-[#101828]">₹{invoice.paidInr.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-[11px] tracking-wide text-[#98A2B3] uppercase">Remaining</div>
          <div className="font-semibold text-[#B42318]">{money(remaining, invoice.currency)}</div>
        </div>
      </div>
      <FormInput label="Payment Amount (₹) — actual rupees deposited" required type="number" value={amountInr} onChange={(e) => setAmountInr(e.target.value)} placeholder="e.g. 500000" />
      <div className="flex gap-3">
        <FormInput label={`Exchange Rate (1 ${invoice.currency} = ? ₹)`} required type="number" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 83.50" />
        <FormInput label={`Equivalent in ${invoice.currency}`} value={equivalent != null ? String(equivalent) : ""} readOnly disabled />
      </div>
      <div className="flex gap-3">
        <FormInput label="Payment Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <FormInput label="Payment Reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="WIRE / NEFT ref" />
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-[#344054]">
        <input type="checkbox" checked={isTranche} onChange={(e) => setIsTranche(e.target.checked)} />
        This is a tranche payment
      </label>
      {isTranche && (
        <div className="flex gap-3">
          <FormInput label="Tranche Number" type="number" value={trancheNumber} onChange={(e) => setTrancheNumber(e.target.value)} />
          <FormInput label="Total Tranches" type="number" value={totalTranches} onChange={(e) => setTotalTranches(e.target.value)} />
        </div>
      )}
      <label className="flex cursor-pointer items-center gap-2 text-sm text-[#344054]">
        <input type="checkbox" checked={isFinal} onChange={(e) => setIsFinal(e.target.checked)} />
        This is the final payment (marks the invoice fully paid → unlocks the partner claim)
      </label>
      <FormTextarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <p className="text-xs font-medium text-[#F04438]">{err}</p>}
    </Modal>
  );
}
