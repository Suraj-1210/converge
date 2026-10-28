"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Page state (tab, filters, search) kept in the URL's search params, so a
// refresh, a shared link or Back lands on the same view (27 Oct testing:
// "refresh keeps your place").
//
// The first render uses `defaults`, matching the server render; the URL is
// read once after mount (`ready` turns true then, so a page can hold its
// queries until it knows the real filters). Changes are written with
// history.replaceState: no navigation, no history entry per keystroke. Keys
// at their default value are left out of the URL.

export type UrlState = Record<string, string>;

export function useUrlState<T extends UrlState>(
  defaults: T,
): [T, (patch: Partial<T>) => void, boolean] {
  const defaultsRef = useRef(defaults);
  const [state, setState] = useState<T>(defaults);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const fromUrl: Partial<T> = {};
    for (const key of Object.keys(defaultsRef.current)) {
      const v = p.get(key);
      if (v !== null) (fromUrl as UrlState)[key] = v;
    }
    setState((prev) => ({ ...prev, ...fromUrl }));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const p = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(state)) {
      if (value === "" || value === defaultsRef.current[key]) p.delete(key);
      else p.set(key, value);
    }
    const qs = p.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [state, ready]);

  const update = useCallback((patch: Partial<T>) => setState((prev) => ({ ...prev, ...patch })), []);
  return [state, update, ready];
}

// A same-portal path to return to after signing in (?next=), or null. Only
// relative paths under the portal's own prefix: never another origin.
export function safeReturnPath(raw: string | null, prefix: "/admin/" | "/partner/"): string | null {
  if (!raw?.startsWith(prefix) || raw.startsWith("//") || raw.includes("\\")) return null;
  if (raw.startsWith("/admin/login")) return null;
  return raw;
}
