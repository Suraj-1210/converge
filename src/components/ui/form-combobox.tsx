"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

// Type-to-search select for long lists (countries, states, cities). Styled to
// match FormInput / FormSelect. The value is always one of `options` — free
// text that matches nothing is discarded on blur. `extraAction` adds a footer
// entry to the list (e.g. "My city isn't listed").

const chevronBg = `url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%2398A2B3' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

// Rendering thousands of rows is slow and useless; typing narrows the list.
const MAX_SHOWN = 200;

export interface ComboboxOption {
  value: string;
  label: string;
}

interface FormComboboxProps {
  label?: string;
  required?: boolean;
  placeholder?: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
  error?: boolean;
  errorMessage?: string;
  extraAction?: { label: string; onSelect: () => void };
}

export function FormCombobox({
  label,
  required,
  placeholder,
  options,
  value,
  onChange,
  disabled,
  loading,
  error,
  errorMessage,
  extraAction,
}: FormComboboxProps) {
  const selectedLabel = options.find((o) => o.value === value)?.label ?? "";
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Keep the text in sync when the value changes from outside (e.g. reset).
  useEffect(() => {
    if (!open) setQuery(selectedLabel);
  }, [selectedLabel, open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Showing the current selection as the query shouldn't filter the list.
    if (!q || q === selectedLabel.toLowerCase()) return options;
    const starts = options.filter((o) => o.label.toLowerCase().startsWith(q));
    const contains = options.filter(
      (o) => !o.label.toLowerCase().startsWith(q) && o.label.toLowerCase().includes(q),
    );
    return [...starts, ...contains];
  }, [options, query, selectedLabel]);
  const shown = matches.slice(0, MAX_SHOWN);
  // Hidden while loading, so Enter on a not-yet-filled list can't pick it.
  const action = loading ? undefined : extraAction;
  const rowCount = shown.length + (action ? 1 : 0);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (index: number) => {
    const opt = shown[index];
    if (opt) {
      onChange(opt.value);
      setQuery(opt.label);
    } else if (action && index === shown.length) {
      action.onSelect();
    }
    setOpen(false);
  };

  return (
    <div className="relative flex flex-1 flex-col">
      {label && (
        <label className="mb-1.5 text-[13px] font-medium text-[#344054]">
          {label} {required && <span className="text-[#F04438]">*</span>}
        </label>
      )}
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        disabled={disabled}
        placeholder={loading ? "Loading…" : placeholder}
        onFocus={(e) => {
          setOpen(true);
          setActive(0);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          setQuery(selectedLabel);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, rowCount - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            if (rowCount > 0) choose(active);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery(selectedLabel);
          }
        }}
        className={`h-[42px] w-full rounded-lg border bg-white bg-[right_14px_center] bg-no-repeat pr-9 pl-3.5 font-[family-name:var(--font-inter)] text-sm text-[#101828] outline-none transition-all placeholder:text-[#98A2B3] focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.12)] ${
          error
            ? "border-[#F04438] shadow-[0_0_0_3px_rgba(240,68,56,0.12)]"
            : "border-[#D0D5DD]"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
        style={{ backgroundImage: chevronBg }}
      />
      {open && !disabled && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-[#D0D5DD] bg-white py-1 shadow-lg"
          // Keep focus in the input so a click registers before blur closes it.
          onMouseDown={(e) => e.preventDefault()}
        >
          {shown.map((o, i) => (
            <li
              key={o.value}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={`cursor-pointer px-3.5 py-2 text-sm ${
                i === active ? "bg-[#F2F4F7]" : ""
              } ${o.value === value ? "font-semibold text-[#1570EF]" : "text-[#101828]"}`}
            >
              {o.label}
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-3.5 py-2 text-sm text-[#98A2B3]">
              {loading ? "Loading…" : "No matches"}
            </li>
          )}
          {matches.length > MAX_SHOWN && (
            <li className="px-3.5 py-1.5 text-xs text-[#98A2B3]">
              Showing {MAX_SHOWN} of {matches.length}. Type to narrow down.
            </li>
          )}
          {action && (
            <li
              data-index={shown.length}
              role="option"
              aria-selected={false}
              onMouseEnter={() => setActive(shown.length)}
              onClick={() => choose(shown.length)}
              className={`cursor-pointer border-t border-[#E4E7EC] px-3.5 py-2 text-sm font-medium text-[#1570EF] ${
                active === shown.length ? "bg-[#F2F4F7]" : ""
              }`}
            >
              {action.label}
            </li>
          )}
        </ul>
      )}
      {error && errorMessage && (
        <div className="mt-1 flex items-center gap-1 text-xs text-[#F04438]">
          <svg viewBox="0 0 16 16" fill="#F04438" className="h-[13px] w-[13px] shrink-0">
            <circle cx="8" cy="8" r="7" />
            <path d="M8 4v4M8 10.5v.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {errorMessage}
        </div>
      )}
    </div>
  );
}
