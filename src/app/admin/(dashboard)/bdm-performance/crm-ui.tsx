"use client";

// Shared pieces for the CRM tabs of BDM Performance (Prospect Pipeline,
// Activity Log, My Tasks). Badge colours are the cp-bdm-performance mock's.

import type { ReactNode } from "react";
import type { RouterOutputs } from "~/trpc/react";
import { initials } from "./data";
import {
  BdmActivityType,
  BdmTaskPriority,
  ProspectStage,
  ProspectTemperature,
} from "~/server/db/enums";

export type Notify = (message: string) => void;
export type Option = { id: number; name: string };
export type PartnerOption = Option & { city?: string | null };

export const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
export const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
export const TD = "px-3 py-3 text-[13px] text-[#344054]";
export const BTN_PRIMARY = "h-9 rounded-lg bg-[#1570EF] px-3.5 text-[13px] font-semibold text-white hover:bg-[#175CD3] disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_SECONDARY = "h-9 rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-50";
export const SELECT = "h-[42px] w-full rounded-lg border border-[#D0D5DD] bg-white px-3 text-sm text-[#101828] outline-none focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.12)]";

export const STAGE_BADGE: Record<number, string> = {
  [ProspectStage.LEAD]: "bg-[#F2F4F7] text-[#344054]",
  [ProspectStage.CONTACTED]: "bg-[#EFF8FF] text-[#1570EF]",
  [ProspectStage.MEETING_DONE]: "bg-[#F9F5FF] text-[#6941C6]",
  [ProspectStage.PROPOSAL_SENT]: "bg-[#FFF6ED] text-[#B54708]",
  [ProspectStage.NEGOTIATION]: "bg-[#FEF0C7] text-[#93370D]",
  [ProspectStage.ONBOARDING]: "bg-[#D1FADF] text-[#027A48]",
  [ProspectStage.CONVERTED]: "bg-[#ECFDF3] text-[#039855]",
  [ProspectStage.LOST]: "bg-[#FEF3F2] text-[#B42318]",
};

export const TEMP_STYLE: Record<number, { wrap: string; dot: string }> = {
  [ProspectTemperature.COLD]: { wrap: "bg-[#F9FAFB] text-[#667085] border-[#E4E7EC]", dot: "bg-[#667085]" },
  [ProspectTemperature.LUKEWARM]: { wrap: "bg-[#F0F9FF] text-[#026AA2] border-[#B9E6FE]", dot: "bg-[#0BA5EC]" },
  [ProspectTemperature.WARM]: { wrap: "bg-[#FFF6ED] text-[#B54708] border-[#FEF0C7]", dot: "bg-[#F79009]" },
  [ProspectTemperature.HOT]: { wrap: "bg-[#FEF3F2] text-[#B42318] border-[#FEE4E2]", dot: "bg-[#F04438]" },
  [ProspectTemperature.SIGNING_UP]: { wrap: "bg-[#F9F5FF] text-[#6941C6] border-[#E9D7FE]", dot: "bg-[#7F56D9]" },
};

export const PRIORITY_BADGE: Record<number, string> = {
  [BdmTaskPriority.URGENT]: "bg-[#FEF3F2] text-[#B42318]",
  [BdmTaskPriority.NORMAL]: "bg-[#EFF8FF] text-[#175CD3]",
  [BdmTaskPriority.LOW]: "bg-[#F9FAFB] text-[#667085]",
};

export const ACTIVITY_ICON: Record<number, { bg: string; stroke: string; path: ReactNode }> = {
  [BdmActivityType.CALL]: {
    bg: "bg-[#EFF8FF]",
    stroke: "#1570EF",
    path: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />,
  },
  [BdmActivityType.EMAIL]: {
    bg: "bg-[#ECFDF3]",
    stroke: "#12B76A",
    path: (
      <>
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
        <polyline points="22,6 12,13 2,6" />
      </>
    ),
  },
  [BdmActivityType.MEETING]: {
    bg: "bg-[#F9F5FF]",
    stroke: "#7F56D9",
    path: (
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
  },
  [BdmActivityType.NOTE]: {
    bg: "bg-[#FFF6ED]",
    stroke: "#F79009",
    path: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </>
    ),
  },
};

// Due dates are business-calendar dates, so "today" is the IST date, matching
// the server. Date-only strings are formatted in UTC so they never shift a day.
const istFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
export const todayIst = () => istFmt.format(new Date());

export function fmtDay(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function daysAgo(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const d = Math.round((Date.parse(`${todayIst()}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86_400_000);
  return d <= 0 ? "Today" : d === 1 ? "Yesterday" : `${d}d ago`;
}

export const codesWithLabels = <T extends number>(codes: readonly T[], labels: Record<T, string>) =>
  codes.map((c) => ({ value: String(c), label: labels[c] }));

// Activities and tasks attach to a partner or a prospect, encoded in one
// <select> value as "o:<orgId>" or "p:<prospectId>".
export type TargetValue = { organizationId: number } | { prospectId: number };
export function parseTarget(v: string): TargetValue | null {
  const n = Number(v.slice(2));
  if (!Number.isInteger(n) || n <= 0) return null;
  if (v.startsWith("o:")) return { organizationId: n };
  if (v.startsWith("p:")) return { prospectId: n };
  return null;
}

export function TargetSelect({
  value,
  onChange,
  partners,
  prospects,
  label = "Related to",
  required = true,
  allLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  partners: PartnerOption[];
  prospects: Option[];
  label?: string;
  required?: boolean;
  /** When set, adds an "all" option with this label (for filters). */
  allLabel?: string;
}) {
  return (
    <div className="flex flex-1 flex-col">
      {label && (
        <label className="mb-1.5 text-[13px] font-medium text-[#344054]">
          {label} {required && <span className="text-[#F04438]">*</span>}
        </label>
      )}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
        {allLabel ? <option value="">{allLabel}</option> : <option value="">Select partner or prospect...</option>}
        {partners.length > 0 && (
          <optgroup label="Partners">
            {partners.map((p) => (
              <option key={`o${p.id}`} value={`o:${p.id}`}>
                {p.name}
                {p.city && p.city !== "—" ? ` (${p.city})` : ""}
              </option>
            ))}
          </optgroup>
        )}
        {prospects.length > 0 && (
          <optgroup label="Prospects">
            {prospects.map((p) => (
              <option key={`p${p.id}`} value={`p:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

// Super Admin acts for a BDM; this picks who. "" means the signed-in user.
export function PersonSelect({
  value,
  onChange,
  bdms,
  label,
  includeMe,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  bdms: Option[];
  label: string;
  includeMe: boolean;
  required?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <label className="mb-1.5 text-[13px] font-medium text-[#344054]">
        {label} {required && <span className="text-[#F04438]">*</span>}
      </label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
        {includeMe ? <option value="">Me</option> : <option value="">Select a BDM...</option>}
        {bdms.map((b) => (
          <option key={b.id} value={String(b.id)}>
            {b.name}
          </option>
        ))}
      </select>
    </div>
  );
}

const AVATAR_GRADIENTS = ["from-[#1570EF] to-[#0BA5EC]", "from-[#7F56D9] to-[#9E77ED]", "from-[#12B76A] to-[#32D583]", "from-[#F79009] to-[#FDB022]", "from-[#F04438] to-[#FD853A]"];
const avatarFor = (name: string) => AVATAR_GRADIENTS[name.length % AVATAR_GRADIENTS.length]!;

export function Avatar({ name }: { name: string }) {
  return <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${avatarFor(name)} text-[11px] font-bold text-white`}>{initials(name)}</span>;
}

type ActivityRow = RouterOutputs["bdmCrm"]["activity"]["list"][number];

export function ActivityItem({ a, showBdm, showTarget = true }: { a: ActivityRow; showBdm: boolean; showTarget?: boolean }) {
  const icon = ACTIVITY_ICON[a.type];
  return (
    <div className="flex gap-3 px-5 py-3.5">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${icon?.bg ?? "bg-[#F2F4F7]"}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke={icon?.stroke ?? "#667085"} strokeWidth={2} className="h-4 w-4">{icon?.path}</svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-[#101828]">
          {a.typeLabel}
          {showTarget && a.target && (
            <span className="font-normal text-[#667085]">
              {" "}· {a.target.name}
              <span className="ml-1.5 rounded-full bg-[#F2F4F7] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#667085]">{a.target.kind}</span>
            </span>
          )}
        </div>
        <div className="mt-0.5 whitespace-pre-wrap text-[13px] text-[#344054]">{a.summary}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-[#98A2B3]">
          <span>{fmtDay(a.occurredOn)}</span>
          {a.durationMins != null && <span>{a.durationMins} min</span>}
          {a.followUpDate && <span>Follow up {fmtDay(a.followUpDate)}</span>}
          {showBdm && <span>by {a.bdmName}</span>}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-5 py-12 text-center">
      <div className="text-sm font-semibold text-[#344054]">{title}</div>
      <div className="mt-1 text-[13px] text-[#98A2B3]">{body}</div>
    </div>
  );
}
