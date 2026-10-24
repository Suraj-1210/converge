"use client";

// Month + year picker for a deferral's new intake (admin defer dialog and the
// partner's deferral report). The server checks it again
// (src/server/application-deferral.ts).

export const INTAKE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function intakeYears(): number[] {
  const y = new Date().getFullYear();
  return [y, y + 1, y + 2, y + 3];
}

// Null when the pick is a month after this one.
export function intakeProblem(month: number | null, year: number | null): string | null {
  if (!month || !year) return "Pick the new intake month and year";
  const now = new Date();
  if (year * 12 + month <= now.getFullYear() * 12 + now.getMonth() + 1) {
    return "The new intake must be after this month";
  }
  return null;
}

export function IntakePicker({
  month,
  year,
  onChange,
}: {
  month: number | null;
  year: number | null;
  onChange: (month: number | null, year: number | null) => void;
}) {
  const select =
    "h-9 cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]";
  return (
    <div>
      <span className="mb-1 block text-[12px] font-semibold text-[#344054]">New intake *</span>
      <div className="flex gap-2">
        <select
          aria-label="Intake month"
          value={month ?? ""}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null, year)}
          className={select}
        >
          <option value="">Month</option>
          {INTAKE_MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </select>
        <select
          aria-label="Intake year"
          value={year ?? ""}
          onChange={(e) => onChange(month, e.target.value ? Number(e.target.value) : null)}
          className={select}
        >
          <option value="">Year</option>
          {intakeYears().map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
