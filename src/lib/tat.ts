// TAT (turnaround time) rules shared by the server and the TAT Management
// page. Business-hours arithmetic lives in src/server/tat.ts; this file holds
// only what the browser also needs.

export type TatStatus = "Breached" | "Warning" | "On Track";

export interface TatTarget {
  key: string;
  label: string;
  thresholdMinutes: number;
  warningPct: number;
  active: boolean;
}

// The TAT page's breach rule: past the threshold is Breached; from
// warningPct% of it, Warning.
export function tatStatus(elapsedMinutes: number, target: Pick<TatTarget, "thresholdMinutes" | "warningPct">): TatStatus {
  if (elapsedMinutes > target.thresholdMinutes) return "Breached";
  if (elapsedMinutes >= (target.warningPct / 100) * target.thresholdMinutes) return "Warning";
  return "On Track";
}

// "45m", "2h", "3h 10m", "2d 4h" (days of 24 elapsed hours, not business days).
export function fmtMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 48) return r ? `${h}h ${r}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

export const WEEKDAYS: { iso: number; short: string }[] = [
  { iso: 1, short: "Mon" },
  { iso: 2, short: "Tue" },
  { iso: 3, short: "Wed" },
  { iso: 4, short: "Thu" },
  { iso: 5, short: "Fri" },
  { iso: 6, short: "Sat" },
  { iso: 7, short: "Sun" },
];

// 600 → "10:00".
export function minuteToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// "10:00" → 600; null when malformed.
export function hhmmToMinute(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 24 || mm > 59 || (h === 24 && mm > 0)) return null;
  return h * 60 + mm;
}

// "Mon–Sat 10:00–19:00 (Asia/Kolkata)".
export function describeHours(c: { workDays: number[]; dayStartMinute: number; dayEndMinute: number; timezone: string }): string {
  const days = WEEKDAYS.filter((d) => c.workDays.includes(d.iso)).map((d) => d.short);
  const contiguous =
    days.length > 2 &&
    c.workDays.length === days.length &&
    Math.max(...c.workDays) - Math.min(...c.workDays) === c.workDays.length - 1;
  const dayText = days.length === 0 ? "No working days" : contiguous ? `${days[0]}–${days[days.length - 1]}` : days.join(", ");
  return `${dayText} ${minuteToHhmm(c.dayStartMinute)}–${minuteToHhmm(c.dayEndMinute)} (${c.timezone})`;
}
