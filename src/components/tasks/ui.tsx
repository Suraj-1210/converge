"use client";

import { type ReactNode } from "react";
import {
  TaskStateLabel,
  fmtShortDay,
  taskCategoryLabel,
  taskPriorityLabel,
  type ShortlistPhase,
  type TaskState,
} from "~/lib/tasks";

// Shared look for My Tasks, Close your day, carry-forward, ageing and the
// student follow-up panel (PDF "Converge – Follow-up Workflow & Task
// Management"), in the portal's palette.

export const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
export const TH =
  "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
export const TD = "px-3.5 py-3 text-[13px] text-[#344054] align-top";
export const INPUT =
  "w-full rounded-lg border border-[#D0D5DD] bg-white px-3 py-2 text-[13px] text-[#101828] outline-none focus:border-[#1570EF] focus:ring-2 focus:ring-[#1570EF]/10";
export const LABEL = "mb-1.5 block text-[13px] font-semibold text-[#344054]";
export const BTN_PRIMARY =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#175CD3] disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_SECONDARY =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_DANGER =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[#D92D20] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#B42318] disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_SMALL =
  "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF] disabled:cursor-not-allowed disabled:opacity-50";

const STATE_TONE: Record<TaskState, string> = {
  overdue: "bg-[#B42318] text-white",
  pending: "bg-[#F2F4F7] text-[#344054]",
  in_progress: "bg-[#EFF8FF] text-[#175CD3]",
  completed: "bg-[#ECFDF3] text-[#067647]",
  cancelled: "bg-[#F2F4F7] text-[#98A2B3]",
};

export function StateBadge({ state }: { state: TaskState }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATE_TONE[state]}`}>
      {TaskStateLabel[state]}
    </span>
  );
}

const PRIORITY_TONE = ["bg-[#F2F4F7] text-[#475467]", "bg-[#FFFAEB] text-[#B54708]", "bg-[#FEF3F2] text-[#B42318]"];

export function PriorityBadge({ priority }: { priority: number }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${PRIORITY_TONE[priority] ?? PRIORITY_TONE[1]}`}>
      {taskPriorityLabel(priority)}
    </span>
  );
}

const PHASE_TONE: Record<ShortlistPhase, string> = {
  shared: "bg-[#F2F4F7] text-[#475467]",
  awaiting: "bg-[#FFFAEB] text-[#B54708]",
  first: "bg-[#EFF8FF] text-[#175CD3]",
  second: "bg-[#FFF6ED] text-[#C4320A]",
  final: "bg-[#F4F3FF] text-[#5925DC]",
  confirmed: "bg-[#ECFDF3] text-[#067647]",
  closed: "bg-[#FEF3F2] text-[#B42318]",
  ended: "bg-[#F2F4F7] text-[#667085]",
};
export const PHASE_BAR: Record<ShortlistPhase, string> = {
  shared: "#98A2B3",
  awaiting: "#667085",
  first: "#1570EF",
  second: "#EF6820",
  final: "#7A5AF8",
  confirmed: "#12B76A",
  closed: "#F04438",
  ended: "#98A2B3",
};

export function PhaseBadge({ phase, label }: { phase: ShortlistPhase; label: string }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${PHASE_TONE[phase]}`}>
      {label}
    </span>
  );
}

export function AutoTag() {
  return <span className="text-[11px] font-medium text-[#98A2B3]">· auto</span>;
}

export function Tile({
  label,
  value,
  sub,
  tone = "default",
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "green" | "orange" | "red" | "blue";
  children?: ReactNode;
}) {
  const color = { default: "text-[#101828]", green: "text-[#067647]", orange: "text-[#C4320A]", red: "text-[#B42318]", blue: "text-[#175CD3]" }[tone];
  const border = tone === "red" ? "border-[#FDA29B]" : "border-[#E4E7EC]";
  return (
    <div className={`rounded-xl border ${border} bg-white px-5 py-4`}>
      <div className="text-[13px] text-[#475467]">{label}</div>
      <div className={`mt-1 text-[28px] leading-9 font-bold ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-[#667085]">{sub}</div>}
      {children}
    </div>
  );
}

export function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer whitespace-nowrap rounded-full border px-3 py-1 text-[12px] font-semibold transition ${
        active ? "border-[#1570EF] bg-[#EFF8FF] text-[#175CD3]" : "border-[#D0D5DD] bg-white text-[#344054] hover:border-[#1570EF]"
      }`}
    >
      {children}
    </button>
  );
}

// "Today" / "18 Nov" / "16 Nov · revised 18 Nov".
export function DueCell({
  due,
  original,
  today,
  overdue,
}: {
  due: string | null;
  original: string | null;
  today: string;
  overdue: boolean;
}) {
  if (!due) return <span className="text-[#98A2B3]">—</span>;
  const revised = original && original !== due;
  const shown = revised ? original : due;
  return (
    <div className="whitespace-nowrap">
      <span className={overdue ? "font-semibold text-[#B42318]" : "text-[#344054]"}>
        {shown === today ? "Today" : fmtShortDay(shown)}
      </span>
      {revised && <div className="text-[11px] text-[#667085]">revised {due === today ? "today" : fmtShortDay(due)}</div>}
    </div>
  );
}

export const categoryLabel = taskCategoryLabel;

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-10 text-center text-sm text-[#98A2B3]">{children}</div>;
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-4 py-3 text-sm text-[#B42318]">{message}</div>;
}

// "1h 44m"
export function fmtCountdown(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// CSV download from rows (client side).
export function downloadCsv(fileName: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
