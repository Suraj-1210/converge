"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "~/server/api/root";
import { api } from "~/trpc/react";
import { useExportLog } from "~/lib/export-log";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Toast } from "~/components/ui/toast";
import { DashboardCard, SkeletonTable, EmptyState } from "~/components/dashboard/widgets";
import { formatDate, countryFlag } from "~/components/dashboard/format";
import {
  AdminRole,
  VendorType,
  VendorTypeLabel,
  CommissionType,
} from "~/server/db/enums";

type RO = inferRouterOutputs<AppRouter>;
type ContractRow = RO["commissionRates"]["listContracts"][number];
type VendorRow = RO["commissionRates"]["listVendors"][number];
type RateRow = ContractRow["rates"][number];
type BonusRow = ContractRow["bonusTiers"][number];
type TrancheRow = ContractRow["tranches"][number];

type ModalState =
  | { kind: "vendor"; vendor?: VendorRow }
  | { kind: "contract"; presetVendorId: number | null; contract?: ContractRow }
  | { kind: "rate"; contractId: number; universityId: number; rate?: RateRow }
  | { kind: "bonus"; contractId: number; tier?: BonusRow }
  | { kind: "tranche"; contractId: number; nextSeq: number; tranche?: TrancheRow }
  | null;

// ---- small helpers ----------------------------------------------------------
const toDateInput = (d: Date | string | null | undefined): string => {
  if (!d) return "";
  const t = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
};
const rateLabel = (r: { commissionType: number; rate: number | null }): string => {
  if (r.rate == null) return "—";
  return r.commissionType === CommissionType.FLAT
    ? `$${r.rate.toLocaleString()}`
    : `${r.rate}%`;
};
// The headline (university-wide) rate, falling back to the first program rate.
const headlineRate = (c: ContractRow): RateRow | null =>
  c.rates.find((r) => r.courseId === null) ?? c.rates[0] ?? null;
// Commission-type badge text: "%" or "Flat".
const typeText = (commissionType: number | null | undefined): string =>
  commissionType == null ? "—" : commissionType === CommissionType.FLAT ? "Flat" : "%";
// The mock collapses every study level to UG vs Masters.
const LEVEL_OPTIONS = [
  { value: "0", label: "Undergraduate (UG)" },
  { value: "1", label: "Masters" },
] as const;
const levelBadge = (level: number | null): string | null =>
  level == null ? null : level === 0 ? "UG" : "Masters";
const levelFromDegree = (deg: number | null | undefined): string =>
  deg === 0 ? "0" : "1";

function Pill({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: "gray" | "blue" | "green" | "orange" | "purple";
}) {
  const tones = {
    gray: "bg-[#F2F4F7] text-[#667085]",
    blue: "bg-[#EFF8FF] text-[#1570EF]",
    green: "bg-[#ECFDF3] text-[#067647]",
    orange: "bg-[#FFF6ED] text-[#B54708]",
    purple: "bg-[#F9F5FF] text-[#7F56D9]",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 text-[#667085] transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function CountChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-[#EFF8FF] px-2 py-0.5 text-xs font-semibold text-[#1570EF]">
      {children}
    </span>
  );
}

function TypeToggle({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const opts = [
    { v: CommissionType.PERCENTAGE, label: "Percentage (%)" },
    { v: CommissionType.FLAT, label: "Flat Amount ($)" },
  ];
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-[#344054]">Commission Type</label>
      <div className="flex gap-2">
        {opts.map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition ${
              value === o.v
                ? "border-[#1570EF] bg-[#EFF8FF] text-[#1570EF]"
                : "border-[#D0D5DD] text-[#344054] hover:bg-[#F9FAFB]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";
const TEXT_BTN = "text-[13px] font-semibold text-[#1570EF] hover:underline";
const DEL_BTN = "text-[13px] font-semibold text-[#B42318] hover:underline";

// ---- CSV --------------------------------------------------------------------
const CSV_EXPORT_HEADERS = [
  "UniversityId",
  "UniversityName",
  "VendorId",
  "VendorName",
  "CommissionRate",
  "CommissionType",
  "CpShare",
  "IsDefault",
  "EffectiveDate",
  "Notes",
];
const CSV_TEMPLATE_HEADERS = [
  "UniversityId",
  "VendorId",
  "CommissionRate",
  "CommissionType",
  "CpShare",
  "IsDefault",
  "EffectiveDate",
  "Notes",
];

const csvCell = (v: string | number | null | undefined): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvTypeWord = (t: number | null | undefined): string =>
  t === CommissionType.FLAT ? "flat" : "percentage";
const normHeader = (h: string): string => h.toLowerCase().replace(/[^a-z]/g, "");

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function downloadCsv(filename: string, rows: string[][]): void {
  const content = rows.map((r) => r.map(csvCell).join(",")).join("\n");
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type ImportStatus = "new" | "changed" | "nochange";
type PreviewRow = {
  status: ImportStatus;
  universityId: number;
  universityName: string;
  vendorId: number | null;
  vendorName: string;
  commissionType: number;
  rate: number | null;
  cpSharePct: number | null;
  isDefault: boolean;
  effectiveDate: string | null;
  notes: string | null;
};

function buildPreview(
  text: string,
  contracts: ContractRow[],
  unis: { id: number; name: string }[],
  vendors: VendorRow[],
): { rows: PreviewRow[]; error: string | null; skipped: number } {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], error: "No CSV data to import", skipped: 0 };
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2)
    return {
      rows: [],
      error: "CSV must have a header row and at least one data row",
      skipped: 0,
    };
  const headers = parseCsvLine(lines[0]!).map(normHeader);
  const idx = (name: string) => headers.indexOf(name);
  const iUni = idx("universityid");
  const iVen = idx("vendorid");
  const iRate = idx("commissionrate");
  if (iUni < 0 || iVen < 0 || iRate < 0)
    return {
      rows: [],
      error: "CSV must have UniversityId, VendorId, and CommissionRate columns",
      skipped: 0,
    };
  const iType = idx("commissiontype");
  const iCp = idx("cpshare");
  const iDef = idx("isdefault");
  const iEff = idx("effectivedate");
  const iNotes = idx("notes");

  const uniName = new Map(unis.map((u) => [u.id, u.name]));
  const venName = new Map(vendors.map((v) => [v.id, v.name]));
  const existing = new Map<string, ContractRow>();
  for (const c of contracts)
    existing.set(`${c.universityId}:${c.vendorId ?? "direct"}`, c);

  const rows: PreviewRow[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!);
    const uniId = parseInt((cells[iUni] ?? "").trim(), 10);
    if (!Number.isFinite(uniId) || uniId <= 0) {
      skipped++;
      continue;
    }
    const venRaw = (cells[iVen] ?? "").trim();
    const vendorId =
      venRaw === "" || /^(direct|vnd-direct)$/i.test(venRaw)
        ? null
        : parseInt(venRaw, 10);
    if (vendorId !== null && (!Number.isFinite(vendorId) || vendorId <= 0)) {
      skipped++;
      continue;
    }
    const rateRaw = (cells[iRate] ?? "").trim();
    const rate = rateRaw === "" ? null : Number(rateRaw);
    if (rate !== null && Number.isNaN(rate)) {
      skipped++;
      continue;
    }
    const typeRaw = iType >= 0 ? (cells[iType] ?? "").trim().toLowerCase() : "";
    const commissionType = /^(flat|1|\$)/.test(typeRaw)
      ? CommissionType.FLAT
      : CommissionType.PERCENTAGE;
    const cpRaw = iCp >= 0 ? (cells[iCp] ?? "").trim() : "";
    const cpSharePct = cpRaw === "" ? null : Number(cpRaw);
    const defRaw = iDef >= 0 ? (cells[iDef] ?? "").trim().toLowerCase() : "";
    const isDefault = /^(true|yes|1|y|★)$/.test(defRaw);
    const effectiveDate = iEff >= 0 ? (cells[iEff] ?? "").trim() || null : null;
    const notes = iNotes >= 0 ? (cells[iNotes] ?? "").trim() || null : null;

    const ex = existing.get(`${uniId}:${vendorId ?? "direct"}`);
    let status: ImportStatus;
    if (!ex) status = "new";
    else {
      const exHead = headlineRate(ex);
      const exRate = exHead?.rate ?? null;
      const exType = exHead?.commissionType ?? CommissionType.PERCENTAGE;
      const exCp = ex.cpSharePct ?? 0;
      const changed =
        (rate ?? null) !== exRate ||
        (cpSharePct ?? 0) !== exCp ||
        isDefault !== ex.isDefault ||
        commissionType !== exType;
      status = changed ? "changed" : "nochange";
    }
    rows.push({
      status,
      universityId: uniId,
      universityName: uniName.get(uniId) ?? ex?.universityName ?? `#${uniId}`,
      vendorId,
      vendorName:
        vendorId == null ? "Direct" : (venName.get(vendorId) ?? `#${vendorId}`),
      commissionType,
      rate,
      cpSharePct,
      isDefault,
      effectiveDate,
      notes,
    });
  }
  return { rows, error: null, skipped };
}

// =============================================================================
export default function CommissionRatesPage() {
  const meQ = api.authSession.me.useQuery();
  const role = meQ.data?.role;
  const canView =
    role === AdminRole.SUPER_ADMIN ||
    role === AdminRole.FINANCE_MANAGER ||
    role === AdminRole.FINANCE_EXECUTIVE;
  const canEdit =
    role === AdminRole.SUPER_ADMIN || role === AdminRole.FINANCE_MANAGER;

  // `me` is cached client-side (the shell fetches it), so on the client's first
  // render it resolves instantly while SSR has it unresolved — branching the page
  // structure on it directly would hydration-mismatch. Gate on mount so the server
  // and the first client render produce the same (skeleton) tree, then reveal.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [tab, setTab] = useState<"entry" | "summary">("entry");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [vendorOpenRaw, setVendorOpen] = useState<Set<number> | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  // CSV panel state
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; skipped: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (m: string) => {
    setToastMsg(m);
    setToastOpen(true);
  };

  const utils = api.useUtils();
  const logExport = useExportLog();
  const vendorsQ = api.commissionRates.listVendors.useQuery(undefined, { enabled: canView });
  const contractsQ = api.commissionRates.listContracts.useQuery(undefined, { enabled: canView });
  const unisQ = api.commissionRates.universitiesForPicker.useQuery(undefined, { enabled: canView });

  const setDefault = api.commissionRates.setDefault.useMutation({
    onSuccess: () => {
      void utils.commissionRates.invalidate();
      showToast("Default updated");
    },
    onError: (e) => showToast(e.message),
  });
  const removeContract = api.commissionRates.removeContract.useMutation({
    onSuccess: () => {
      void utils.commissionRates.invalidate();
      showToast("Contract removed");
    },
    onError: (e) => showToast(e.message),
  });
  const removeRate = api.commissionRates.removeRate.useMutation({
    onSuccess: () => void utils.commissionRates.invalidate(),
    onError: (e) => showToast(e.message),
  });
  const removeBonus = api.commissionRates.removeBonusTier.useMutation({
    onSuccess: () => void utils.commissionRates.invalidate(),
    onError: (e) => showToast(e.message),
  });
  const removeTranche = api.commissionRates.removeTranche.useMutation({
    onSuccess: () => void utils.commissionRates.invalidate(),
    onError: (e) => showToast(e.message),
  });
  const importContracts = api.commissionRates.importContracts.useMutation({
    onSuccess: (res) => {
      void utils.commissionRates.invalidate();
      setPreview(null);
      setCsvText("");
      showToast(`Import complete: ${res.created} added, ${res.updated} updated`);
    },
    onError: (e) => showToast(e.message),
  });

  const contracts = useMemo(() => contractsQ.data ?? [], [contractsQ.data]);
  const vendors = useMemo(() => vendorsQ.data ?? [], [vendorsQ.data]);
  const unis = useMemo(() => unisQ.data ?? [], [unisQ.data]);
  const directContracts = useMemo(
    () => contracts.filter((c) => c.vendorId === null),
    [contracts],
  );
  const byVendor = useMemo(() => {
    const m = new Map<number, ContractRow[]>();
    for (const c of contracts) {
      if (c.vendorId === null) continue;
      const list = m.get(c.vendorId) ?? [];
      list.push(c);
      m.set(c.vendorId, list);
    }
    return m;
  }, [contracts]);
  const vendorSourceCount = contracts.length - directContracts.length;
  const uniCount = useMemo(
    () => new Set(contracts.map((c) => c.universityId)).size,
    [contracts],
  );

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // First vendor card auto-opens; the rest start collapsed.
  const firstVendorId = vendors[0]?.id;
  const vendorOpen =
    vendorOpenRaw ?? new Set(firstVendorId != null ? [firstVendorId] : []);
  const toggleVendor = (id: number) =>
    setVendorOpen(() => {
      const next = new Set(vendorOpen);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const loading = contractsQ.isLoading || vendorsQ.isLoading;

  // ---- CSV handlers --------------------------------------------------------
  const handleExport = () => {
    const rows: string[][] = [CSV_EXPORT_HEADERS];
    for (const c of contracts) {
      const head = headlineRate(c);
      rows.push([
        String(c.universityId),
        c.universityName,
        c.vendorId == null ? "DIRECT" : String(c.vendorId),
        c.vendorName ?? "Direct",
        head?.rate != null ? String(head.rate) : "",
        csvTypeWord(head?.commissionType),
        c.cpSharePct != null ? String(c.cpSharePct) : "",
        c.isDefault ? "true" : "false",
        c.effectiveDate ? toDateInput(c.effectiveDate) : "",
        c.notes ?? "",
      ]);
    }
    downloadCsv("commission-rates-export.csv", rows);
    logExport("Commission rates CSV", contracts.length);
    showToast(`CSV exported (${contracts.length} records)`);
  };
  const handleTemplate = () => {
    downloadCsv("commission-rates-template.csv", [
      CSV_TEMPLATE_HEADERS,
      ["12", "DIRECT", "12", "percentage", "", "false", "2024-04-15", "Standard direct rate"],
      ["12", "34", "15", "percentage", "80", "true", "2024-04-15", "Third-party via vendor"],
    ]);
    showToast("Template downloaded");
  };
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      showToast(`File "${f.name}" exceeds 5MB limit. Please upload a smaller file.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCsvText(typeof reader.result === "string" ? reader.result : "");
      setCsvOpen(true);
    };
    reader.readAsText(f);
  };
  const handlePreview = () => {
    const res = buildPreview(csvText, contracts, unis, vendors);
    if (res.error) {
      showToast(res.error);
      return;
    }
    setPreview({ rows: res.rows, skipped: res.skipped });
  };
  const applyImport = () => {
    if (!preview) return;
    const rows = preview.rows
      .filter((r) => r.status !== "nochange")
      .map((r) => ({
        universityId: r.universityId,
        vendorId: r.vendorId,
        commissionType: r.commissionType,
        rate: r.rate,
        cpSharePct: r.cpSharePct,
        isDefault: r.isDefault,
        effectiveDate: r.effectiveDate,
        notes: r.notes,
      }));
    if (rows.length === 0) {
      showToast("No new or changed rows to apply");
      return;
    }
    importContracts.mutate({ rows });
  };

  // ---- nested sub-tables for an expanded contract --------------------------
  const renderRatesSubTable = (c: ContractRow) => (
    <div className="rounded-lg border border-[#E4E7EC]">
      <div className="flex items-center justify-between px-3.5 py-2">
        <span className="text-xs font-semibold text-[#475467]">🎓 Program-Specific Rates</span>
        {canEdit && (
          <button
            className={TEXT_BTN}
            onClick={() =>
              setModal({ kind: "rate", contractId: c.id, universityId: c.universityId })
            }
          >
            + Add Program
          </button>
        )}
      </div>
      {c.rates.filter((r) => r.courseId !== null).length === 0 ? (
        <p className="px-3.5 pb-3 text-xs text-[#98A2B3]">
          No program-specific rates — base rate applies to all programs.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>Program Name</th>
              <th className={TH}>Level</th>
              <th className={TH}>Commission Type</th>
              <th className={TH}>Rate</th>
              {canEdit && <th className={TH}></th>}
            </tr>
          </thead>
          <tbody>
            {c.rates
              .filter((r) => r.courseId !== null)
              .map((r) => (
                <tr key={r.id} className="border-b border-[#F2F4F7] last:border-0">
                  <td className={TD}>{r.courseName ?? "Program"}</td>
                  <td className={TD}>
                    {levelBadge(r.level) ? (
                      <Pill tone="blue">{levelBadge(r.level)}</Pill>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={TD}>
                    <Pill>{typeText(r.commissionType)}</Pill>
                  </td>
                  <td className={TD}>{rateLabel(r)}</td>
                  {canEdit && (
                    <td className={`${TD} text-right`}>
                      <button
                        className={`${TEXT_BTN} mr-3`}
                        onClick={() =>
                          setModal({ kind: "rate", contractId: c.id, universityId: c.universityId, rate: r })
                        }
                      >
                        Edit
                      </button>
                      <button className={DEL_BTN} onClick={() => removeRate.mutate({ id: r.id })}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );

  const renderBonusSubTable = (c: ContractRow) => (
    <div className="rounded-lg border border-[#E4E7EC]">
      <div className="flex items-center justify-between px-3.5 py-2">
        <span className="text-xs font-semibold text-[#475467]">🎁 Volume Bonus Tiers</span>
        {canEdit && (
          <button className={TEXT_BTN} onClick={() => setModal({ kind: "bonus", contractId: c.id })}>
            + Add Tier
          </button>
        )}
      </div>
      {c.bonusTiers.length === 0 ? (
        <p className="px-3.5 pb-3 text-xs text-[#98A2B3]">No volume bonuses configured.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>Student Range</th>
              <th className={TH}>Amount Per Student</th>
              {canEdit && <th className={TH}></th>}
            </tr>
          </thead>
          <tbody>
            {c.bonusTiers.map((b) => (
              <tr key={b.id} className="border-b border-[#F2F4F7] last:border-0">
                <td className={TD}>
                  {b.minStudents}
                  {b.maxStudents ? `–${b.maxStudents}` : "+"} students
                </td>
                <td className={TD}>${(b.amountPerStudent ?? 0).toLocaleString()}</td>
                {canEdit && (
                  <td className={`${TD} text-right`}>
                    <button
                      className={`${TEXT_BTN} mr-3`}
                      onClick={() => setModal({ kind: "bonus", contractId: c.id, tier: b })}
                    >
                      Edit
                    </button>
                    <button className={DEL_BTN} onClick={() => removeBonus.mutate({ id: b.id })}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  const renderTrancheSubTable = (c: ContractRow) => (
    <div className="rounded-lg border border-[#E4E7EC]">
      <div className="flex items-center justify-between px-3.5 py-2">
        <span className="text-xs font-semibold text-[#475467]">💳 Tranche Payments</span>
        {canEdit &&
          (c.tranches.length >= 4 ? (
            <span className="text-xs text-[#98A2B3]">(max 4 tranches)</span>
          ) : (
            <button
              className={TEXT_BTN}
              onClick={() =>
                setModal({ kind: "tranche", contractId: c.id, nextSeq: c.tranches.length + 1 })
              }
            >
              + Add Tranche
            </button>
          ))}
      </div>
      {c.tranches.length === 0 ? (
        <p className="px-3.5 pb-3 text-xs text-[#98A2B3]">No tranche payments — commission paid in full.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>Tranche</th>
              <th className={TH}>Amount</th>
              <th className={TH}>% of Total</th>
              <th className={TH}>Timing / Trigger</th>
              {canEdit && <th className={TH}></th>}
            </tr>
          </thead>
          <tbody>
            {c.tranches.map((t) => (
              <tr key={t.id} className="border-b border-[#F2F4F7] last:border-0">
                <td className={TD}>{t.name}</td>
                <td className={TD}>{t.amount == null ? "—" : `$${t.amount.toLocaleString()}`}</td>
                <td className={TD}>{t.pct == null ? "—" : `${t.pct}%`}</td>
                <td className={TD}>{t.timing ?? "—"}</td>
                {canEdit && (
                  <td className={`${TD} text-right`}>
                    <button
                      className={`${TEXT_BTN} mr-3`}
                      onClick={() =>
                        setModal({ kind: "tranche", contractId: c.id, nextSeq: t.seq, tranche: t })
                      }
                    >
                      Edit
                    </button>
                    <button className={DEL_BTN} onClick={() => removeTranche.mutate({ id: t.id })}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  // ---- one contract row (+ its expanded detail) ----------------------------
  const renderContractRow = (c: ContractRow, isVendor: boolean, cols: number) => {
    const open = expanded.has(c.id);
    const headline = headlineRate(c);
    const programCount = c.rates.filter((r) => r.courseId !== null).length;
    return (
      <Fragment key={c.id}>
        <tr className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
          <td className={`${TD} w-8`}>
            <button onClick={() => toggle(c.id)} aria-label="Expand">
              <Chevron open={open} />
            </button>
          </td>
          <td className={`${TD} font-medium text-[#101828]`}>{c.universityName}</td>
          <td className={TD}>
            {countryFlag(c.country)} {c.country}
          </td>
          <td className={TD}>
            {headline ? <Pill>{typeText(headline.commissionType)}</Pill> : <span className="text-[#98A2B3]">—</span>}
          </td>
          <td className={TD}>{headline ? rateLabel(headline) : <span className="text-[#98A2B3]">—</span>}</td>
          {isVendor && (
            <td className={TD}>
              {c.cpSharePct == null ? (
                "—"
              ) : (
                <span className="font-medium text-[#1570EF]">{c.cpSharePct}%</span>
              )}
            </td>
          )}
          {isVendor && (
            <td className={TD}>
              {programCount > 0 ? (
                <Pill tone="purple">
                  {programCount} {programCount === 1 ? "program" : "programs"}
                </Pill>
              ) : (
                <Pill tone="gray">Unified</Pill>
              )}
            </td>
          )}
          {!isVendor && (
            <td className={TD}>
              {c.bonusTiers.length > 0 ? (
                <button onClick={() => toggle(c.id)}>
                  <Pill tone="purple">🎁 Bonus</Pill>
                </button>
              ) : (
                <span className="text-[#98A2B3]">—</span>
              )}
            </td>
          )}
          {!isVendor && (
            <td className={TD}>
              {c.tranches.length > 0 ? (
                <button onClick={() => toggle(c.id)}>
                  <Pill tone="blue">💳 {c.tranches.length} Tranches</Pill>
                </button>
              ) : (
                <span className="text-[#98A2B3]">—</span>
              )}
            </td>
          )}
          <td className={TD}>{c.effectiveDate ? formatDate(c.effectiveDate) : "—"}</td>
          <td className={TD}>
            {canEdit ? (
              <button
                onClick={() => setDefault.mutate({ universityId: c.universityId, contractId: c.id })}
                title="Set as default for this university"
                className={`text-lg leading-none ${c.isDefault ? "text-[#F79009]" : "text-[#D0D5DD] hover:text-[#F79009]"}`}
              >
                {c.isDefault ? "★" : "☆"}
              </button>
            ) : (
              <span className={`text-lg leading-none ${c.isDefault ? "text-[#F79009]" : "text-[#D0D5DD]"}`}>
                {c.isDefault ? "★" : "—"}
              </span>
            )}
          </td>
          <td className={`${TD} max-w-[160px] truncate`} title={c.notes ?? undefined}>
            {c.notes ?? "—"}
          </td>
          {canEdit && (
            <td className={`${TD} text-right whitespace-nowrap`}>
              <button
                className={`${TEXT_BTN} mr-3`}
                onClick={() => setModal({ kind: "contract", presetVendorId: c.vendorId, contract: c })}
              >
                Edit
              </button>
              <button
                className={DEL_BTN}
                onClick={() => {
                  if (confirm(`Remove the ${c.universityName} contract and its rates?`))
                    removeContract.mutate({ id: c.id });
                }}
              >
                Delete
              </button>
            </td>
          )}
        </tr>
        {open && (
          <tr className="bg-[#F9FAFB]">
            <td colSpan={cols} className="px-4 py-3">
              <div className="space-y-3">
                {renderRatesSubTable(c)}
                {!isVendor && renderBonusSubTable(c)}
                {!isVendor && renderTrancheSubTable(c)}
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  // ---- gating --------------------------------------------------------------
  if (!mounted || meQ.isLoading) {
    return (
      <DashboardCard title="Commission Rates" bodyClassName="p-0">
        <SkeletonTable rows={5} cols={7} />
      </DashboardCard>
    );
  }
  if (!canView) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-[#E4E7EC] bg-white px-8 py-12 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#FEF3F2] text-2xl">
            🔒
          </div>
          <h2 className="text-lg font-bold text-[#101828]">Access Restricted</h2>
          <p className="mt-2 text-sm text-[#667085]">
            Finance modules are available to Finance Managers and Admins only.
          </p>
        </div>
      </div>
    );
  }

  const directCols = canEdit ? 11 : 10;
  const vendorCols = canEdit ? 11 : 10;

  return (
    <div>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Commission Rates</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Manage commission structures for direct university contracts and third-party vendors.
          </p>
        </div>
        {tab === "entry" && canEdit && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setModal({ kind: "vendor" })}>
              Add Vendor
            </Button>
            <Button onClick={() => setModal({ kind: "contract", presetVendorId: null })}>
              Add Direct Contract
            </Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-5 flex gap-2 border-b border-[#E4E7EC]">
        {([
          { id: "entry", label: "Commission Entry", count: contracts.length },
          { id: "summary", label: "Commission Summary", count: uniCount },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-semibold transition ${
              tab === t.id
                ? "border-[#1570EF] text-[#1570EF]"
                : "border-transparent text-[#667085] hover:text-[#344054]"
            }`}
          >
            {t.label}
            <CountChip>{t.count}</CountChip>
          </button>
        ))}
      </div>

      {tab === "entry" ? (
        loading ? (
          <DashboardCard title="Direct University Contracts" bodyClassName="p-0">
            <SkeletonTable rows={5} cols={7} />
          </DashboardCard>
        ) : (
          <div className="space-y-6">
            {/* Direct contracts */}
            <DashboardCard
              title="🏢 Direct University Contracts"
              bodyClassName="p-0"
              headerRight={<CountChip>{directContracts.length} contracts</CountChip>}
            >
              {directContracts.length === 0 ? (
                <EmptyState label="No direct contracts yet. Add one to set university commission rates." />
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={`${TH} w-8`}></th>
                      <th className={TH}>University</th>
                      <th className={TH}>Country</th>
                      <th className={TH}>Type</th>
                      <th className={TH}>Rate</th>
                      <th className={TH}>Bonus</th>
                      <th className={TH}>Tranches</th>
                      <th className={TH}>Effective Date</th>
                      <th className={TH}>Default</th>
                      <th className={TH}>Notes</th>
                      {canEdit && <th className={`${TH} text-right`}>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {directContracts.map((c) => renderContractRow(c, false, directCols))}
                  </tbody>
                </table>
              )}
            </DashboardCard>

            {/* Third-party vendors */}
            <div>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-base font-bold text-[#101828]">🤝 Third-Party Vendors</h2>
                <CountChip>
                  {vendors.length} {vendors.length === 1 ? "vendor" : "vendors"} · {vendorSourceCount}{" "}
                  {vendorSourceCount === 1 ? "source" : "sources"}
                </CountChip>
              </div>
              {vendors.length === 0 ? (
                <EmptyState label="No third-party vendors. Add a vendor (e.g. KC, IDP) to track their commissions." />
              ) : (
                <div className="space-y-4">
                  {vendors.map((v) => renderVendorCard(v))}
                </div>
              )}
            </div>

            {/* Import / Export panel */}
            {renderCsvPanel()}
          </div>
        )
      ) : (
        <SummaryTab onToast={showToast} canEdit={canEdit} onExport={handleExport} />
      )}

      {/* Modals */}
      {modal?.kind === "vendor" && (
        <VendorModal vendor={modal.vendor} onClose={() => setModal(null)} onToast={showToast} />
      )}
      {modal?.kind === "contract" && (
        <ContractModal
          presetVendorId={modal.presetVendorId}
          contract={modal.contract}
          vendors={vendors}
          onClose={() => setModal(null)}
          onToast={showToast}
        />
      )}
      {modal?.kind === "rate" && (
        <RateModal
          contractId={modal.contractId}
          universityId={modal.universityId}
          rate={modal.rate}
          onClose={() => setModal(null)}
          onToast={showToast}
        />
      )}
      {modal?.kind === "bonus" && (
        <BonusModal
          contractId={modal.contractId}
          tier={modal.tier}
          onClose={() => setModal(null)}
          onToast={showToast}
        />
      )}
      {modal?.kind === "tranche" && (
        <TrancheModal
          contractId={modal.contractId}
          nextSeq={modal.nextSeq}
          tranche={modal.tranche}
          onClose={() => setModal(null)}
          onToast={showToast}
        />
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </div>
  );

  // ---- vendor accordion card ----------------------------------------------
  function renderVendorCard(v: VendorRow) {
    const list = byVendor.get(v.id) ?? [];
    const open = vendorOpen.has(v.id);
    const uniN = new Set(list.map((c) => c.universityId)).size;
    // Average the percentage rates only; a flat fee (e.g. 2500) is an amount,
    // not a percent, so it is counted separately.
    const heads = list.map((c) => headlineRate(c)).filter((r) => r?.rate != null);
    const rateVals = heads
      .filter((r) => r?.commissionType !== CommissionType.FLAT)
      .map((r) => r!.rate!);
    const flatN = heads.length - rateVals.length;
    const avg =
      rateVals.length > 0
        ? (rateVals.reduce((a, b) => a + b, 0) / rateVals.length).toFixed(1)
        : null;
    const hasContact = [v.contactName, v.contactEmail, v.contactPhone, v.address].some(
      (x) => !!x?.trim(),
    );
    return (
      <div key={v.id} className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
        {/* Header */}
        <button
          onClick={() => toggleVendor(v.id)}
          className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-[#FCFCFD]"
        >
          <div className="flex items-center gap-2.5">
            <Chevron open={open} />
            <span className="text-[15px] font-semibold text-[#101828]">{v.name}</span>
            <Pill tone={v.type === VendorType.DIRECT ? "gray" : "green"}>
              {VendorTypeLabel[(v.type as 0 | 1) ?? VendorType.THIRD_PARTY]}
            </Pill>
          </div>
          <span className="text-xs text-[#98A2B3]">
            {uniN} {uniN === 1 ? "university" : "universities"} · {list.length}{" "}
            {list.length === 1 ? "source" : "sources"}
            {avg != null ? ` · Avg: ${avg}%` : ""}
            {flatN > 0 ? ` · ${flatN} flat` : ""}
          </span>
        </button>

        {open && (
          <div className="border-t border-[#F2F4F7]">
            {/* Contact strip */}
            {hasContact && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-[#F9FAFB] px-5 py-2.5 text-xs text-[#475467]">
                {v.contactName && <span>👤 {v.contactName}</span>}
                {v.contactEmail && <span>✉️ {v.contactEmail}</span>}
                {v.contactPhone && <span>📞 {v.contactPhone}</span>}
                {v.address && <span>📍 {v.address}</span>}
              </div>
            )}
            {/* Actions */}
            {canEdit && (
              <div className="flex items-center gap-3 px-5 py-2.5">
                <button
                  className={TEXT_BTN}
                  onClick={() => setModal({ kind: "contract", presetVendorId: v.id })}
                >
                  + Add University to {v.name}
                </button>
                <button className={TEXT_BTN} onClick={() => setModal({ kind: "vendor", vendor: v })}>
                  Edit Vendor
                </button>
              </div>
            )}
            {/* Sources */}
            {list.length === 0 ? (
              <p className="px-5 py-5 text-sm text-[#98A2B3]">No universities assigned to this vendor yet.</p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={`${TH} w-8`}></th>
                    <th className={TH}>University</th>
                    <th className={TH}>Country</th>
                    <th className={TH}>Type</th>
                    <th className={TH}>Rate</th>
                    <th className={TH}>CP Share %</th>
                    <th className={TH}>Programs</th>
                    <th className={TH}>Effective Date</th>
                    <th className={TH}>Default</th>
                    <th className={TH}>Notes</th>
                    {canEdit && <th className={`${TH} text-right`}>Actions</th>}
                  </tr>
                </thead>
                <tbody>{list.map((c) => renderContractRow(c, true, vendorCols))}</tbody>
              </table>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- CSV import / export panel -------------------------------------------
  function renderCsvPanel() {
    const counts = preview
      ? {
          neu: preview.rows.filter((r) => r.status === "new").length,
          changed: preview.rows.filter((r) => r.status === "changed").length,
          nochange: preview.rows.filter((r) => r.status === "nochange").length,
        }
      : null;
    const applyCount = counts ? counts.neu + counts.changed : 0;
    return (
      <div className="rounded-xl border border-[#E4E7EC] bg-white">
        <button
          onClick={() => setCsvOpen((o) => !o)}
          className="flex w-full items-center justify-between px-5 py-3.5 text-left"
        >
          <span className="text-[15px] font-semibold text-[#101828]">Import / Export</span>
          <Chevron open={csvOpen} />
        </button>
        {csvOpen && (
          <div className="space-y-4 border-t border-[#F2F4F7] px-5 py-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={handleExport}>
                Export CSV
              </Button>
              {canEdit && (
                <>
                  <Button variant="secondary" onClick={handleTemplate}>
                    Download Template
                  </Button>
                  <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                    Upload CSV
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleFile}
                  />
                </>
              )}
            </div>
            {canEdit && (
              <>
                <p className="text-xs text-[#667085]">Or paste CSV data below:</p>
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  rows={4}
                  placeholder={
                    "UniversityId,VendorId,CommissionRate,CommissionType,CpShare,IsDefault,EffectiveDate,Notes\n12,DIRECT,12,percentage,,false,2024-04-15,Standard rate"
                  }
                  className="w-full rounded-lg border border-[#D0D5DD] px-3 py-2 font-mono text-xs text-[#344054] focus:border-[#1570EF] focus:outline-none"
                />
                <div>
                  <Button variant="secondary" onClick={handlePreview}>
                    Preview Import
                  </Button>
                </div>
              </>
            )}

            {/* Preview */}
            {preview && (
              <div className="rounded-lg border border-[#E4E7EC]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F2F4F7] px-3.5 py-2.5">
                  <span className="text-sm font-semibold text-[#101828]">Import Preview</span>
                  <div className="flex items-center gap-3 text-xs font-medium">
                    <span className="text-[#067647]">● {counts?.neu ?? 0} new</span>
                    <span className="text-[#B54708]">● {counts?.changed ?? 0} changed</span>
                    <span className="text-[#667085]">● {counts?.nochange ?? 0} unchanged</span>
                    {preview.skipped > 0 && (
                      <span className="text-[#B42318]">● {preview.skipped} skipped</span>
                    )}
                  </div>
                </div>
                {preview.rows.length === 0 ? (
                  <p className="px-3.5 py-4 text-sm text-[#98A2B3]">No valid rows found in the CSV.</p>
                ) : (
                  <div className="max-h-72 overflow-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          <th className={TH}>Status</th>
                          <th className={TH}>University</th>
                          <th className={TH}>Vendor</th>
                          <th className={TH}>Type</th>
                          <th className={TH}>Rate</th>
                          <th className={TH}>CP Share</th>
                          <th className={TH}>Default</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((r, i) => (
                          <tr key={i} className="border-b border-[#F2F4F7] last:border-0">
                            <td className={TD}>
                              {r.status === "new" ? (
                                <Pill tone="green">NEW</Pill>
                              ) : r.status === "changed" ? (
                                <Pill tone="orange">CHANGED</Pill>
                              ) : (
                                <span className="text-xs text-[#98A2B3]">No change</span>
                              )}
                            </td>
                            <td className={TD}>{r.universityName}</td>
                            <td className={TD}>{r.vendorName}</td>
                            <td className={TD}>
                              <Pill>{typeText(r.commissionType)}</Pill>
                            </td>
                            <td className={TD}>
                              {r.rate == null ? "—" : rateLabel({ commissionType: r.commissionType, rate: r.rate })}
                            </td>
                            <td className={TD}>{r.vendorId == null ? "—" : r.cpSharePct == null ? "—" : `${r.cpSharePct}%`}</td>
                            <td className={TD}>{r.isDefault ? "★" : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {canEdit && (
                  <div className="flex items-center gap-2 border-t border-[#F2F4F7] px-3.5 py-2.5">
                    <Button onClick={applyImport} loading={importContracts.isPending}>
                      Apply {applyCount} {applyCount === 1 ? "Change" : "Changes"}
                    </Button>
                    <Button variant="secondary" onClick={() => setPreview(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
}

// =============================================================================
// Summary tab
// =============================================================================
function SummaryTab({
  onToast,
  canEdit,
  onExport,
}: {
  onToast: (m: string) => void;
  canEdit: boolean;
  onExport: () => void;
}) {
  const [country, setCountry] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const utils = api.useUtils();
  const summaryQ = api.commissionRates.summary.useQuery();
  const setDefault = api.commissionRates.setDefault.useMutation({
    onSuccess: () => {
      void utils.commissionRates.invalidate();
      onToast("Default updated");
    },
    onError: (e) => onToast(e.message),
  });

  const allRows = useMemo(() => summaryQ.data ?? [], [summaryQ.data]);
  const countries = useMemo(
    () => Array.from(new Set(allRows.map((u) => u.country))).sort(),
    [allRows],
  );
  const rows = useMemo(
    () =>
      allRows.filter(
        (u) =>
          (country === "" || u.country === country) &&
          (search.trim() === "" ||
            u.universityName.toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [allRows, country, search],
  );
  const toggle = (id: number) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-48">
          <FormSelect
            label="Country"
            placeholder="All Countries"
            options={countries.map((c) => ({ value: c, label: `${countryFlag(c)} ${c}` }))}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          />
        </div>
        <div className="w-64">
          <FormInput
            label="Search"
            placeholder="Search universities..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setCountry("");
            setSearch("");
          }}
        >
          Reset
        </Button>
      </div>
      <DashboardCard
        title="Commission Structure by University"
        bodyClassName="p-0"
        headerRight={
          <div className="flex items-center gap-3">
            <CountChip>
              {rows.length} {rows.length === 1 ? "university" : "universities"}
            </CountChip>
            <button className={TEXT_BTN} onClick={onExport}>
              Export CSV
            </button>
          </div>
        }
      >
        {summaryQ.isLoading ? (
          <SkeletonTable rows={5} cols={7} />
        ) : rows.length === 0 ? (
          <EmptyState label={allRows.length === 0 ? "No commission sources configured yet." : "No universities found. Try adjusting your filters."} />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} w-8`}></th>
                <th className={TH}>University</th>
                <th className={TH}>Country</th>
                <th className={TH}>Total Sources</th>
                <th className={TH}>Default Vendor</th>
                <th className={TH}>Default Rate</th>
                <th className={TH}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const open = expanded.has(u.universityId);
                const def = u.sources.find((s) => s.isDefault) ?? null;
                const anyBonus = u.sources.some((s) => s.hasBonus);
                const anyTranche = u.sources.some((s) => s.hasTranches);
                return (
                  <Fragment key={u.universityId}>
                    <tr className="border-b border-[#F2F4F7] last:border-0 hover:bg-[#FCFCFD]">
                      <td className={`${TD} w-8`}>
                        <button onClick={() => toggle(u.universityId)} aria-label="Expand">
                          <Chevron open={open} />
                        </button>
                      </td>
                      <td className={`${TD} font-medium text-[#101828]`}>{u.universityName}</td>
                      <td className={TD}>
                        {countryFlag(u.country)} {u.country}
                      </td>
                      <td className={TD}>
                        <CountChip>{u.sources.length}</CountChip>
                      </td>
                      <td className={TD}>
                        {def ? <Pill tone="orange">★ {def.vendorName}</Pill> : <span className="text-[#98A2B3]">None set</span>}
                      </td>
                      <td className={TD}>
                        {def?.defaultRate == null
                          ? "—"
                          : def.commissionType === CommissionType.FLAT
                            ? `$${def.defaultRate.toLocaleString()}`
                            : `${def.defaultRate}%`}
                      </td>
                      <td className={TD}>
                        <div className="flex gap-1">
                          {anyBonus && <Pill tone="purple">🎁 Bonus</Pill>}
                          {anyTranche && <Pill tone="blue">💳 Tranches</Pill>}
                          {!anyBonus && !anyTranche && <span className="text-[#98A2B3]">—</span>}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-[#F9FAFB]">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="rounded-lg border border-[#E4E7EC]">
                            <table className="w-full border-collapse">
                              <thead>
                                <tr>
                                  <th className={TH}>Default</th>
                                  <th className={TH}>Vendor</th>
                                  <th className={TH}>Type</th>
                                  <th className={TH}>Comm. Type</th>
                                  <th className={TH}>Rate</th>
                                  <th className={TH}>CP Share %</th>
                                  <th className={TH}>Effective Date</th>
                                  <th className={TH}>Notes</th>
                                </tr>
                              </thead>
                              <tbody>
                                {u.sources.map((s) => (
                                  <tr key={s.contractId} className="border-b border-[#F2F4F7] last:border-0">
                                    <td className={TD}>
                                      {canEdit ? (
                                        <button
                                          onClick={() =>
                                            setDefault.mutate({
                                              universityId: u.universityId,
                                              contractId: s.contractId,
                                            })
                                          }
                                          className={`text-lg leading-none ${s.isDefault ? "text-[#F79009]" : "text-[#D0D5DD] hover:text-[#F79009]"}`}
                                        >
                                          {s.isDefault ? "★" : "☆"}
                                        </button>
                                      ) : (
                                        <span className={`text-lg leading-none ${s.isDefault ? "text-[#F79009]" : "text-[#D0D5DD]"}`}>
                                          {s.isDefault ? "★" : "—"}
                                        </span>
                                      )}
                                    </td>
                                    <td className={`${TD} font-medium text-[#101828]`}>{s.vendorName}</td>
                                    <td className={TD}>
                                      <Pill tone={s.vendorType === VendorType.THIRD_PARTY ? "green" : "gray"}>
                                        {s.vendorId == null
                                          ? "Direct"
                                          : VendorTypeLabel[(s.vendorType as 0 | 1) ?? VendorType.THIRD_PARTY]}
                                      </Pill>
                                    </td>
                                    <td className={TD}>
                                      <Pill>{typeText(s.commissionType)}</Pill>
                                    </td>
                                    <td className={TD}>
                                      {s.defaultRate == null
                                        ? "—"
                                        : s.commissionType === CommissionType.FLAT
                                          ? `$${s.defaultRate.toLocaleString()}`
                                          : `${s.defaultRate}%`}
                                    </td>
                                    <td className={TD}>{s.cpSharePct == null ? "—" : `${s.cpSharePct}%`}</td>
                                    <td className={TD}>{s.effectiveDate ? formatDate(s.effectiveDate) : "—"}</td>
                                    <td className={TD}>{s.notes ?? "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </DashboardCard>
    </div>
  );
}

// =============================================================================
// Modals
// =============================================================================
function ModalFooter({
  onClose,
  onSave,
  saving,
  saveLabel = "Save",
}: {
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  saveLabel?: string;
}) {
  return (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={onSave} loading={saving}>
        {saveLabel}
      </Button>
    </>
  );
}

function VendorModal({
  vendor,
  onClose,
  onToast,
}: {
  vendor?: VendorRow;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const utils = api.useUtils();
  const [name, setName] = useState(vendor?.name ?? "");
  const [type, setType] = useState<string>(String(vendor?.type ?? VendorType.THIRD_PARTY));
  const [contactName, setContactName] = useState(vendor?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(vendor?.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(vendor?.contactPhone ?? "");
  const [address, setAddress] = useState(vendor?.address ?? "");
  const [err, setErr] = useState("");

  const done = () => {
    void utils.commissionRates.invalidate();
    onToast(vendor ? "Vendor updated" : `Vendor "${name.trim()}" added`);
    onClose();
  };
  const create = api.commissionRates.createVendor.useMutation({ onSuccess: done, onError: (e) => setErr(e.message) });
  const update = api.commissionRates.updateVendor.useMutation({ onSuccess: done, onError: (e) => setErr(e.message) });
  const saving = create.isPending || update.isPending;

  const save = () => {
    if (!name.trim()) return setErr("Vendor name is required");
    const payload = {
      name: name.trim(),
      type: Number(type),
      contactName: contactName || undefined,
      contactEmail: contactEmail || undefined,
      contactPhone: contactPhone || undefined,
      address: address || undefined,
    };
    if (vendor) update.mutate({ id: vendor.id, ...payload });
    else create.mutate(payload);
  };

  return (
    <Modal
      open
      title={vendor ? "Edit Vendor" : "Add Vendor"}
      onClose={onClose}
      footer={<ModalFooter onClose={onClose} onSave={save} saving={saving} saveLabel={vendor ? "Save" : "Add Vendor"} />}
    >
      <FormInput label="Vendor Name" required value={name} onChange={(e) => setName(e.target.value)} error={!!err} errorMessage={err} placeholder="e.g. KC Overseas, IDP" />
      <FormSelect
        label="Vendor Type"
        options={[
          { value: String(VendorType.DIRECT), label: "Direct" },
          { value: String(VendorType.THIRD_PARTY), label: "Third-Party" },
        ]}
        value={type}
        onChange={(e) => setType(e.target.value)}
      />
      <p className="text-xs font-semibold tracking-wide text-[#98A2B3] uppercase">Contact Details</p>
      <div className="flex gap-3">
        <FormInput label="Contact Person" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="e.g. John Smith" />
        <FormInput label="Contact Phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="e.g. +91 98765 43210" />
      </div>
      <FormInput label="Contact Email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="e.g. john@vendor.com" />
      <FormTextarea label="Address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Office address" />
    </Modal>
  );
}

function ContractModal({
  presetVendorId,
  contract,
  vendors,
  onClose,
  onToast,
}: {
  presetVendorId: number | null;
  contract?: ContractRow;
  vendors: VendorRow[];
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const utils = api.useUtils();
  const editing = !!contract;
  const unisQ = api.commissionRates.universitiesForPicker.useQuery(undefined, { enabled: !editing });

  const headline = contract ? headlineRate(contract) : null;

  const [universityId, setUniversityId] = useState<string>(
    contract ? String(contract.universityId) : "",
  );
  const [programId, setProgramId] = useState<string>("");
  const [vendorId, setVendorId] = useState<string>(
    contract
      ? contract.vendorId == null
        ? ""
        : String(contract.vendorId)
      : presetVendorId == null
        ? ""
        : String(presetVendorId),
  );
  const [commissionType, setCommissionType] = useState<number>(
    headline?.commissionType ?? CommissionType.PERCENTAGE,
  );
  const [rateVal, setRateVal] = useState<string>(headline?.rate != null ? String(headline.rate) : "");
  const [cpShare, setCpShare] = useState<string>(
    contract?.cpSharePct != null ? String(contract.cpSharePct) : "",
  );
  const [effectiveDate, setEffectiveDate] = useState(toDateInput(contract?.effectiveDate));
  const [notes, setNotes] = useState(contract?.notes ?? "");
  const [isDefault, setIsDefault] = useState(contract?.isDefault ?? false);
  const [err, setErr] = useState("");

  // Programs for the (create-mode) Program dropdown.
  const coursesQ = api.commissionRates.coursesForUniversity.useQuery(
    { universityId: Number(universityId) },
    { enabled: !editing && universityId !== "" },
  );

  const done = () => {
    void utils.commissionRates.invalidate();
    onToast(editing ? "Commission source updated" : "Commission source added");
    onClose();
  };
  const create = api.commissionRates.createContract.useMutation({ onSuccess: done, onError: (e) => setErr(e.message) });
  const update = api.commissionRates.updateContract.useMutation({ onSuccess: done, onError: (e) => setErr(e.message) });
  const saving = create.isPending || update.isPending;

  const isVendor = vendorId !== "";
  const isFlat = commissionType === CommissionType.FLAT;

  const save = () => {
    const r = Number(rateVal);
    if (rateVal.trim() === "" || Number.isNaN(r) || r < 0) return setErr("Enter a valid commission rate");
    const cp = cpShare.trim() === "" ? null : Number(cpShare);
    if (isVendor && cp == null) return setErr("CP share is required for third-party vendors");
    if (cp != null && (Number.isNaN(cp) || cp < 0 || cp > 100)) return setErr("CP share must be 0–100");

    if (editing && contract) {
      update.mutate({
        id: contract.id,
        vendorId: vendorId === "" ? null : Number(vendorId),
        cpSharePct: cp,
        effectiveDate: effectiveDate || null,
        notes,
        isDefault,
        commissionType,
        rate: r,
      });
      return;
    }
    if (!universityId) return setErr("Pick a university");
    const course = (coursesQ.data ?? []).find((c) => String(c.id) === programId);
    create.mutate({
      universityId: Number(universityId),
      vendorId: vendorId === "" ? null : Number(vendorId),
      cpSharePct: cp,
      effectiveDate: effectiveDate || undefined,
      notes: notes || undefined,
      isDefault,
      commissionType,
      rate: r,
      rateCourseId: programId === "" ? null : Number(programId),
      level: programId === "" ? null : Number(levelFromDegree(course?.degree_level ?? null)),
    });
  };

  const vendorOptions = [
    { value: "", label: "Direct (university contract)" },
    ...vendors.map((v) => ({
      value: String(v.id),
      label: `${v.name} (${VendorTypeLabel[(v.type as 0 | 1) ?? VendorType.THIRD_PARTY]})`,
    })),
  ];

  return (
    <Modal
      open
      title={editing ? "Edit Commission Source" : "Add Commission Source"}
      onClose={onClose}
      footer={<ModalFooter onClose={onClose} onSave={save} saving={saving} />}
    >
      {editing && contract ? (
        <div className="rounded-lg bg-[#F9FAFB] px-3.5 py-2.5 text-sm text-[#344054]">
          <span className="font-semibold text-[#101828]">{contract.universityName}</span>
        </div>
      ) : (
        <>
          <FormSelect
            label="University"
            required
            placeholder="Select a university"
            options={(unisQ.data ?? []).map((u) => ({ value: String(u.id), label: u.name }))}
            value={universityId}
            onChange={(e) => {
              setUniversityId(e.target.value);
              setProgramId("");
            }}
          />
          <FormSelect
            label="Program (optional — leave blank for university-wide rate)"
            placeholder="All Programs (university-wide)"
            options={(coursesQ.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            value={programId}
            onChange={(e) => setProgramId(e.target.value)}
          />
        </>
      )}
      <FormSelect
        label="Vendor"
        options={vendorOptions}
        value={vendorId}
        onChange={(e) => setVendorId(e.target.value)}
      />
      <TypeToggle value={commissionType} onChange={setCommissionType} />
      <div className="flex gap-3">
        <FormInput
          label={isFlat ? "Commission Amount ($)" : "Commission Rate (%)"}
          required
          type="number"
          step="0.1"
          value={rateVal}
          onChange={(e) => setRateVal(e.target.value)}
        />
        {isVendor && (
          <FormInput
            label="CP Share (%)"
            type="number"
            step="0.1"
            value={cpShare}
            onChange={(e) => setCpShare(e.target.value)}
            placeholder="e.g. 80"
          />
        )}
      </div>
      <FormInput
        label="Effective Date"
        type="date"
        value={effectiveDate}
        onChange={(e) => setEffectiveDate(e.target.value)}
      />
      <FormSelect
        label="Set as Default for this University"
        options={[
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" },
        ]}
        value={isDefault ? "yes" : "no"}
        onChange={(e) => setIsDefault(e.target.value === "yes")}
      />
      <FormTextarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <p className="text-xs font-medium text-[#F04438]">{err}</p>}
    </Modal>
  );
}

function RateModal({
  contractId,
  universityId,
  rate,
  onClose,
  onToast,
}: {
  contractId: number;
  universityId: number;
  rate?: RateRow;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const utils = api.useUtils();
  const coursesQ = api.commissionRates.coursesForUniversity.useQuery({ universityId });
  const [courseId, setCourseId] = useState<string>(rate?.courseId != null ? String(rate.courseId) : "");
  const [level, setLevel] = useState<string>(rate?.level != null ? String(rate.level) : "0");
  const [commissionType, setCommissionType] = useState<number>(rate?.commissionType ?? CommissionType.PERCENTAGE);
  const [rateVal, setRateVal] = useState<string>(rate?.rate != null ? String(rate.rate) : "");
  const [err, setErr] = useState("");

  const done = () => {
    void utils.commissionRates.invalidate();
    onToast(rate ? "Program rate updated" : "Program rate added");
    onClose();
  };
  const upsert = api.commissionRates.upsertRate.useMutation({ onSuccess: done, onError: (e) => setErr(e.message) });

  const save = () => {
    const r = Number(rateVal);
    if (rateVal.trim() === "" || Number.isNaN(r) || r < 0) return setErr("Enter a valid rate");
    upsert.mutate({
      id: rate?.id,
      contractId,
      courseId: courseId === "" ? null : Number(courseId),
      level: Number(level),
      commissionType,
      rate: r,
    });
  };

  const isFlat = commissionType === CommissionType.FLAT;

  return (
    <Modal
      open
      title={rate ? "Edit Program Rate" : "Add Program Rate"}
      onClose={onClose}
      footer={<ModalFooter onClose={onClose} onSave={save} saving={upsert.isPending} saveLabel="Save Program Rate" />}
    >
      <FormSelect
        label="Program Name"
        placeholder="Select a program..."
        options={(coursesQ.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
        value={courseId}
        onChange={(e) => {
          setCourseId(e.target.value);
          const course = (coursesQ.data ?? []).find((c) => String(c.id) === e.target.value);
          if (course) setLevel(levelFromDegree(course.degree_level));
        }}
      />
      <FormSelect
        label="Level"
        options={LEVEL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        value={level}
        onChange={(e) => setLevel(e.target.value)}
      />
      <TypeToggle value={commissionType} onChange={setCommissionType} />
      <FormInput
        label={isFlat ? "Commission Amount ($)" : "Commission Rate (%)"}
        required
        type="number"
        step="0.1"
        value={rateVal}
        onChange={(e) => setRateVal(e.target.value)}
        error={!!err}
        errorMessage={err}
      />
    </Modal>
  );
}

function BonusModal({
  contractId,
  tier,
  onClose,
  onToast,
}: {
  contractId: number;
  tier?: BonusRow;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const utils = api.useUtils();
  const [minS, setMinS] = useState(tier ? String(tier.minStudents) : "");
  const [maxS, setMaxS] = useState(tier?.maxStudents != null ? String(tier.maxStudents) : "");
  const [amt, setAmt] = useState(tier?.amountPerStudent != null ? String(tier.amountPerStudent) : "");
  const [err, setErr] = useState("");

  const done = () => {
    void utils.commissionRates.invalidate();
    onToast(tier ? "Bonus tier updated" : "Bonus tier added");
    onClose();
  };
  const upsert = api.commissionRates.upsertBonusTier.useMutation({ onSuccess: done, onError: (e) => setErr(e.message) });

  const save = () => {
    const min = Number(minS);
    const a = Number(amt);
    if (!minS || Number.isNaN(min) || min < 1) return setErr("Min students must be ≥ 1");
    const max = maxS.trim() === "" ? null : Number(maxS);
    if (max != null && max < min) return setErr("Max students must be ≥ min");
    if (amt.trim() === "" || Number.isNaN(a) || a < 0) return setErr("Enter a valid amount");
    upsert.mutate({
      id: tier?.id,
      contractId,
      minStudents: min,
      maxStudents: max,
      amountPerStudent: a,
    });
  };

  return (
    <Modal
      open
      title={tier ? "Edit Bonus Tier" : "Add Bonus Tier"}
      onClose={onClose}
      footer={<ModalFooter onClose={onClose} onSave={save} saving={upsert.isPending} saveLabel="Save Bonus Tier" />}
    >
      <div className="flex gap-3">
        <FormInput label="Min Students" required type="number" value={minS} onChange={(e) => setMinS(e.target.value)} />
        <FormInput label="Max Students" type="number" value={maxS} onChange={(e) => setMaxS(e.target.value)} placeholder="(no cap)" />
      </div>
      <FormInput
        label="Amount Per Student ($)"
        required
        type="number"
        step="1"
        value={amt}
        onChange={(e) => setAmt(e.target.value)}
        error={!!err}
        errorMessage={err}
      />
    </Modal>
  );
}

function TrancheModal({
  contractId,
  nextSeq,
  tranche,
  onClose,
  onToast,
}: {
  contractId: number;
  nextSeq: number;
  tranche?: TrancheRow;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const utils = api.useUtils();
  const seq = tranche?.seq ?? nextSeq;
  const [name, setName] = useState(tranche?.name ?? `Tranche ${seq}`);
  const [amount, setAmount] = useState(tranche?.amount != null ? String(tranche.amount) : "");
  const [pct, setPct] = useState(tranche?.pct != null ? String(tranche.pct) : "");
  const [timing, setTiming] = useState(tranche?.timing ?? "");
  const [err, setErr] = useState("");

  const done = () => {
    void utils.commissionRates.invalidate();
    onToast(tranche ? "Tranche updated" : "Tranche added");
    onClose();
  };
  const upsert = api.commissionRates.upsertTranche.useMutation({ onSuccess: done, onError: (e) => setErr(e.message) });

  const save = () => {
    if (!name.trim()) return setErr("Tranche name is required");
    upsert.mutate({
      id: tranche?.id,
      contractId,
      seq,
      name: name.trim(),
      amount: amount.trim() === "" ? null : Number(amount),
      pct: pct.trim() === "" ? null : Number(pct),
      timing: timing || undefined,
    });
  };

  return (
    <Modal
      open
      title={`${tranche ? "Edit" : "Add"} Tranche Payment (Tranche ${seq} of max 4)`}
      onClose={onClose}
      footer={<ModalFooter onClose={onClose} onSave={save} saving={upsert.isPending} saveLabel="Save Tranche" />}
    >
      <FormInput label="Tranche Name" required value={name} onChange={(e) => setName(e.target.value)} error={!!err} errorMessage={err} placeholder="e.g. Tranche 1 — On Enrollment" />
      <div className="flex gap-3">
        <FormInput label="Amount ($)" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <FormInput label="Percentage of Total (%)" type="number" step="0.1" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="Optional" />
      </div>
      <FormInput
        label="Timing / Trigger"
        value={timing}
        onChange={(e) => setTiming(e.target.value)}
        placeholder="e.g. On enrollment, After semester 1, On completion"
      />
    </Modal>
  );
}
