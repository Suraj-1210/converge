"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { SearchIcon } from "./nav-icons";

// The top-bar search (both portals): type or paste a CP Student ID, a name,
// email or phone; matching students drop down as Name · CP ID, and picking one
// opens their profile. The server only returns students this user can see.
// ⌘K / Ctrl+K focuses it.

type Portal = "admin" | "partner";

function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GlobalSearch({ portal, placeholder }: { portal: Portal; placeholder?: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const q = useDebounced(text.trim(), 200);
  const enabled = q.length >= 2;

  const admin = api.globalSearch.adminStudents.useQuery({ q }, { enabled: enabled && portal === "admin", staleTime: 30_000 });
  const partner = api.globalSearch.partnerStudents.useQuery({ q }, { enabled: enabled && portal === "partner", staleTime: 30_000 });
  const query = portal === "admin" ? admin : partner;
  const results = enabled ? (query.data ?? []) : [];
  const searching = enabled && (query.isFetching || q !== text.trim());

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const go = (id: number) => {
    setOpen(false);
    setText("");
    inputRef.current?.blur();
    router.push(`/${portal}/students/${id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      if (hit) go(hit.id);
    }
  };

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const showPanel = open && text.trim().length >= 2;

  return (
    <div ref={boxRef} className="relative hidden md:block">
      <div className="flex h-9 w-[300px] items-center gap-2 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] px-3 focus-within:border-[#1570EF] focus-within:bg-white">
        <SearchIcon className="h-4 w-4 shrink-0 stroke-[#98A2B3]" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="global-search-results"
          aria-label="Search students"
          placeholder={placeholder ?? "Search students by name or CP ID…"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-[#101828] outline-none placeholder:text-[#98A2B3]"
        />
        <span className="rounded bg-[#E4E7EC] px-1.5 py-0.5 text-[11px] font-medium text-[#98A2B3]">
          {isMac ? "⌘K" : "Ctrl K"}
        </span>
      </div>

      {showPanel && (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute top-[42px] right-0 z-50 w-[360px] overflow-hidden rounded-xl border border-[#E4E7EC] bg-white shadow-[0_12px_32px_rgba(16,24,40,0.14)]"
        >
          <div className="border-b border-[#F2F4F7] px-3.5 py-2 text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
            Students
          </div>
          {results.length > 0 ? (
            <ul className="max-h-[360px] overflow-y-auto py-1">
              {results.map((r, i) => (
                <li key={r.id} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(r.id)}
                    className={`flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2 text-left ${
                      i === active ? "bg-[#F5FAFF]" : ""
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-[#101828]">{r.name}</span>
                      <span className="block truncate text-xs text-[#667085]">
                        {[r.partner, r.email].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-md bg-[#F2F4F7] px-2 py-0.5 font-mono text-xs font-semibold text-[#344054]">
                      {r.cpStudentId}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-3.5 py-4 text-sm text-[#667085]">
              {searching ? "Searching…" : query.isError ? "Search isn't available for your account." : "No matching students."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
