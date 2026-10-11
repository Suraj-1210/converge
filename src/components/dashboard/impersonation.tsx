"use client";

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { SearchIcon, UsersIcon } from "./nav-icons";

// Height of the amber "Viewing as" bar. The dashboard shells expose it as the
// --banner-h CSS variable so the fixed sidebar/topbar and the page content
// shift down by exactly this much while impersonating.
const BANNER_HEIGHT = 40;

export type ImpersonationSide = "admin" | "partner";

export function useImpersonation(side: ImpersonationSide) {
  return api.impersonation.current.useQuery({ side }, { retry: false }).data ?? null;
}

export function bannerOffsetStyle(active: boolean): CSSProperties {
  return { ["--banner-h" as string]: active ? `${BANNER_HEIGHT}px` : "0px" };
}

/**
 * "Viewing as: <Name> (<role>)" with an Exit button, shown across the top of
 * every page while a Super Admin is impersonating someone. `fixed` pins it for
 * the dashboard shells; standalone pages (MOU signing, pending verification)
 * render it inline.
 */
export function ImpersonationBanner({
  side,
  fixed = true,
}: {
  side: ImpersonationSide;
  fixed?: boolean;
}) {
  const current = useImpersonation(side);
  const stop = api.impersonation.stop.useMutation();
  if (!current) return null;

  async function exit() {
    let redirectUrl = "/admin/dashboard";
    try {
      redirectUrl = (await stop.mutateAsync({ side })).redirectUrl;
    } catch {
      // Fall through to the admin portal; middleware re-checks the session.
    }
    // Hard navigation: drops the swapped cookie and the tRPC cache in one go.
    window.location.href = redirectUrl;
  }

  return (
    <div
      role="status"
      style={{ height: BANNER_HEIGHT }}
      className={`${fixed ? "fixed top-0 right-0 left-0 z-[60]" : "relative"} flex items-center justify-between gap-4 bg-amber-400 px-4 text-sm`}
    >
      <div className="flex min-w-0 items-center gap-2 text-amber-950">
        <UsersIcon className="h-[18px] w-[18px] shrink-0 stroke-amber-900" />
        <span className="truncate">
          Viewing as: <strong className="font-semibold">{current.name}</strong> ({current.roleLabel})
        </span>
      </div>
      <button
        type="button"
        onClick={exit}
        disabled={stop.isPending}
        className="shrink-0 cursor-pointer rounded-lg border-none bg-amber-700 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-800 disabled:opacity-60"
      >
        {stop.isPending ? "Exiting…" : "Exit Impersonation"}
      </button>
    </div>
  );
}

interface Target {
  key: string;
  kind: "staff" | "partner";
  id: number;
  name: string;
  email: string;
  roleLabel: string;
  detail: string | null;
}

/**
 * Header dropdown listing every active staff user and partner a Super Admin
 * can impersonate. Render it only for a real (non-impersonating) Super Admin.
 */
export function ImpersonateMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"partner" | "staff">("partner");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const targets = api.impersonation.targets.useQuery(undefined, { enabled: open });
  const start = api.impersonation.start.useMutation();

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const list = useMemo<Target[]>(() => {
    const data = targets.data;
    if (!data) return [];
    const rows: Target[] =
      tab === "staff"
        ? data.staff.map((u) => ({ key: `s${u.id}`, kind: "staff", ...u, detail: null }))
        : data.partners.map((u) => ({
            key: `p${u.id}`,
            kind: "partner",
            id: u.id,
            name: u.name,
            email: u.email,
            roleLabel: u.roleLabel,
            detail: [u.orgName, u.underReview ? "Under review" : null].filter(Boolean).join(" · ") || null,
          }));
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.name, r.email, r.roleLabel, r.detail ?? ""].some((v) => v.toLowerCase().includes(q)),
    );
  }, [targets.data, tab, query]);

  async function pick(t: Target) {
    setError(null);
    try {
      const { redirectUrl } = await start.mutateAsync({ kind: t.kind, id: t.id });
      // Hard navigation so the new session cookie and a clean cache take effect.
      window.location.href = redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start impersonation.");
    }
  }

  const counts = targets.data
    ? { partner: targets.data.partners.length, staff: targets.data.staff.length }
    : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Impersonate a user"
        title="View as another user"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[#E4E7EC] bg-white px-2.5 text-[13px] font-medium text-[#475467] transition-colors hover:bg-[#F9FAFB]"
      >
        <UsersIcon className="h-[18px] w-[18px] stroke-[#667085]" />
        <span className="hidden xl:inline">Impersonate</span>
      </button>

      {open && (
        <div className="absolute top-11 right-0 z-[100] flex max-h-[520px] w-[380px] flex-col overflow-hidden rounded-xl border border-[#E4E7EC] bg-white shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
          <div className="border-b border-[#E4E7EC] px-4 pt-3.5 pb-3">
            <h3 className="text-sm font-semibold text-[#101828]">View as another user</h3>
            <p className="mt-0.5 text-xs text-[#98A2B3]">
              You act as this user with their access. Actions are logged under your name.
            </p>
            <div className="mt-3 flex gap-1 rounded-lg bg-[#F2F4F7] p-0.5">
              {(["partner", "staff"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={`flex-1 cursor-pointer rounded-md border-none px-2 py-1 text-xs font-medium transition-colors ${
                    tab === k ? "bg-white text-[#101828] shadow-sm" : "bg-transparent text-[#667085]"
                  }`}
                >
                  {k === "partner" ? "Partners" : "Staff"}
                  {counts ? ` (${counts[k]})` : ""}
                </button>
              ))}
            </div>
            <div className="mt-2 flex h-8 items-center gap-2 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] px-2.5">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 stroke-[#98A2B3]" />
              <input
                autoFocus
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, email, agency…"
                className="flex-1 border-none bg-transparent text-[13px] text-[#101828] outline-none placeholder:text-[#98A2B3]"
              />
            </div>
            {error && <p className="mt-2 text-xs text-[#F04438]">{error}</p>}
          </div>
          <div className="flex-1 overflow-y-auto">
            {targets.isLoading ? (
              <p className="px-4 py-6 text-center text-xs text-[#98A2B3]">Loading users…</p>
            ) : targets.error ? (
              <p className="px-4 py-6 text-center text-xs text-[#F04438]">{targets.error.message}</p>
            ) : list.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-[#98A2B3]">No matching users.</p>
            ) : (
              list.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  disabled={start.isPending}
                  onClick={() => void pick(t)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 border-b border-[#F2F4F7] bg-transparent px-4 py-2.5 text-left transition-colors hover:bg-[#F0F7FF] disabled:cursor-wait disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-[#101828]">{t.name}</span>
                    <span className="block truncate text-[11px] text-[#98A2B3]">
                      {t.email}
                      {t.detail ? ` · ${t.detail}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-[#F2F4F7] px-2 py-0.5 text-[11px] font-medium text-[#475467]">
                    {t.roleLabel}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
