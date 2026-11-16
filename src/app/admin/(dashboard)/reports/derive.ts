// Row sets per tab, shared by the on-screen tables and the exports so both
// list the same groups in the same order (the workbook's sort orders).

import type { RouterOutputs } from "~/trpc/react";
import { countryName } from "~/components/dashboard/format";
import { NONE, intakeSortKey, type AppCounts, type Dimension } from "~/lib/reports";

export type Report = RouterOutputs["reports"]["report"];
export type Weekly = RouterOutputs["reports"]["weekly"];
export type DrillRows = RouterOutputs["reports"]["drilldown"]["rows"];
export type Group = Report["byDim"]["partner"][number];
export type NamedGroup = Group & { name: string };

// A group's display name (NULL groups: "Unassigned", "Not assigned"…).
export function groupLabel(dim: Dimension, key: string, label: string): string {
  if (key === NONE || !label) {
    switch (dim) {
      case "rm":
        return "Unassigned (no BDM)";
      case "counsellor":
        return "Not assigned";
      case "partner":
        return "No partner";
      case "intake":
        return "Intake not set";
      default:
        return label || "—";
    }
  }
  return dim === "country" ? countryName(key) : label;
}

const named = (dim: Dimension, rows: Group[]): NamedGroup[] =>
  rows.map((r) => ({ ...r, name: groupLabel(dim, r.key, r.label) }));

const by =
  (...keys: (keyof AppCounts)[]) =>
  (a: NamedGroup, b: NamedGroup) => {
    for (const k of keys) if (b[k] !== a[k]) return b[k] - a[k];
    return a.name.localeCompare(b.name);
  };

// RM Wise: by overall applications.
export const rmRows = (r: Report) => named("rm", r.byDim.rm).sort(by("total", "active"));

// Partner Wise: by Deposit Paid, then Active Applications.
export const partnerRows = (r: Report) => named("partner", r.byDim.partner).sort(by("depositPaid", "active", "total"));

// Country Wise: by Active Applications.
export const countryRows = (r: Report) => named("country", r.byDim.country).sort(by("active", "total"));

// University Wise: only universities with at least one offer, deposit or
// visa outcome; by Deposit Paid, then Active.
export const universityRows = (r: Report) =>
  named("university", r.byDim.university)
    .filter((u) => u.conditional + u.unconditional + u.depositPaid + u.visaApproved + u.visaRejected > 0)
    .sort(by("depositPaid", "active", "conditional"));

// Intake Wise: calendar order.
export const intakeRows = (r: Report) =>
  named("intake", r.byDim.intake).sort((a, b) => intakeSortKey(a.name) - intakeSortKey(b.name) || a.name.localeCompare(b.name));

// Vendors: by applications.
export const vendorRows = (r: Report) => named("vendor", r.byDim.vendor).sort(by("total", "depositPaid"));

// Counsellor Wise: application outcomes per counsellor (the student's CP
// counsellor) merged with the students each counsellor shortlisted.
export interface CounsellorRow extends NamedGroup {
  shortlisted: number;
  partnerApproved: number;
}
export function counsellorRows(r: Report): CounsellorRow[] {
  const map = new Map<string, CounsellorRow>();
  const zero = (key: string, label: string): CounsellorRow => {
    const blank = Object.fromEntries(Object.keys(r.totals).map((k) => [k, 0])) as AppCounts;
    return { key, label, ...blank, name: groupLabel("counsellor", key, label), shortlisted: 0, partnerApproved: 0 };
  };
  for (const g of r.byDim.counsellor) map.set(g.key, { ...zero(g.key, g.label), ...g, name: groupLabel("counsellor", g.key, g.label) });
  for (const s of r.shortlists.proposed.rows) {
    const row = map.get(s.key) ?? zero(s.key, s.label);
    row.shortlisted = s.students;
    map.set(s.key, row);
  }
  for (const s of r.shortlists.approved.rows) {
    const row = map.get(s.key) ?? zero(s.key, s.label);
    row.partnerApproved = s.students;
    map.set(s.key, row);
  }
  return [...map.values()].sort(
    (a, b) =>
      b.depositPaid - a.depositPaid ||
      b.visaApproved - a.visaApproved ||
      b.shortlisted - a.shortlisted ||
      (a.key === "none" ? 1 : b.key === "none" ? -1 : 0) ||
      a.name.localeCompare(b.name),
  );
}

// Weekly: RM-wise leads with the previous period alongside.
export function rmLeadRows(w: Weekly) {
  const prev = new Map(w.prevRmLeads.map((r) => [r.key, r.leads]));
  const keys = new Map(w.rmLeads.map((r) => [r.key, r.label]));
  for (const r of w.prevRmLeads) if (!keys.has(r.key)) keys.set(r.key, r.label);
  return [...keys.entries()]
    .map(([key, label]) => ({
      key,
      name: groupLabel("rm", key, label),
      leads: w.rmLeads.find((r) => r.key === key)?.leads ?? 0,
      prev: prev.get(key) ?? 0,
    }))
    .sort((a, b) => b.leads - a.leads || b.prev - a.prev || a.name.localeCompare(b.name));
}

export function weeklyShortlistRows(w: Weekly) {
  const approved = new Map(w.shortlists.approved.rows.map((r) => [r.key, r.students]));
  const keys = new Map(w.shortlists.proposed.rows.map((r) => [r.key, r.label]));
  for (const r of w.shortlists.approved.rows) if (!keys.has(r.key)) keys.set(r.key, r.label);
  return [...keys.entries()]
    .map(([key, label]) => ({
      key,
      name: groupLabel("counsellor", key, label),
      shortlisted: w.shortlists.proposed.rows.find((r) => r.key === key)?.students ?? 0,
      partnerApproved: approved.get(key) ?? 0,
    }))
    .sort((a, b) => b.shortlisted - a.shortlisted || b.partnerApproved - a.partnerApproved || a.name.localeCompare(b.name));
}
