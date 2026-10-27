"use client";

// Compact on/off switch for the tab-access grid and per-user tab overrides.
export function TabSwitch({
  on,
  onChange,
  disabled,
  changed,
  title,
  label,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Unsaved change: ringed so the Super Admin can see what Save will do. */
  changed?: boolean;
  title?: string;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
        on ? "bg-[#1570EF]" : "bg-[#D0D5DD]"
      } ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"} ${
        changed ? "ring-2 ring-[#FDB022] ring-offset-1" : ""
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
          on ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
