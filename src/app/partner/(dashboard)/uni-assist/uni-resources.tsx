"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { ResourceKind, isPreviewable, resourceOpenUrl } from "~/lib/resources";

// Uni Assist "Brochures & resources" (16 Nov 2026): Resources-library entries
// tagged with a university, on that university's program cards. One batched
// query for every university on the loaded pages (resources.partnerByUniversity),
// only for partners with the Resources tab.

export type UniResources = RouterOutputs["resources"]["partnerByUniversity"];

export function useUniResources(universityIds: number[]): UniResources {
  const tabs = api.tabAccess.partnerMine.useQuery().data?.tabs;
  const ids = useMemo(() => [...new Set(universityIds)].sort((a, b) => a - b), [universityIds]);
  const q = api.resources.partnerByUniversity.useQuery(
    { universityIds: ids },
    { enabled: ids.length > 0 && !!tabs?.includes("resources"), placeholderData: (prev) => prev },
  );
  return q.data ?? {};
}

export function UniResourcesButton({ items }: { items: UniResources[number] | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!items?.length) return null;
  return (
    <div ref={ref} className="relative mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 text-xs font-semibold text-[#1570EF] hover:underline"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        Brochures &amp; resources ({items.length})
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-1.5 w-72 rounded-xl border border-[#E4E7EC] bg-white p-1.5 shadow-[0_12px_32px_rgba(16,24,40,0.12)]">
          {items.map((r) => {
            const link = r.kind === ResourceKind.LINK;
            const mode = link ? "open" : isPreviewable(r.mime) ? "preview" : "download";
            return (
              <a
                key={r.id}
                href={resourceOpenUrl(r.id, mode)}
                target={mode === "download" ? undefined : "_blank"}
                rel="noopener noreferrer"
                className="block rounded-lg px-2.5 py-2 hover:bg-[#F9FAFB]"
              >
                <span className="block text-[13px] font-semibold text-[#101828]">
                  {r.title}
                  {r.isNew && (
                    <span className="ml-1.5 rounded-full bg-[#ECFDF3] px-1.5 py-0.5 text-[10px] font-semibold text-[#027A48]">New</span>
                  )}
                </span>
                <span className="block text-[11px] text-[#667085]">
                  {r.category} · {link ? "Link ↗" : mode === "preview" ? "Open" : "Download"}
                </span>
              </a>
            );
          })}
          <a href="/partner/resources" className="mt-1 block border-t border-[#F2F4F7] px-2.5 pt-2 pb-1 text-[11px] font-semibold text-[#1570EF] hover:underline">
            All resources
          </a>
        </div>
      )}
    </div>
  );
}
