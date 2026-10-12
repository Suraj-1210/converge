"use client";

import { useEffect, useRef, useState } from "react";

// Shows the executed MOU inside the portal. Browsers set to "download PDFs"
// (and some embedded browsers) save a PDF link instead of opening it, so
// "View" renders the PDF itself with PDF.js rather than relying on the
// browser's viewer.
export function MouViewer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let worker: Worker | null = null;
    setState("loading");

    void (async () => {
      try {
        const res = await fetch("/api/mou", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());

        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module" });
        pdfjs.GlobalWorkerOptions.workerPort = worker;
        const doc = await pdfjs.getDocument({ data }).promise;

        const container = pagesRef.current;
        if (!container || cancelled) return;
        container.replaceChildren();
        const cssWidth = Math.min(container.clientWidth, 820);
        const dpr = window.devicePixelRatio || 1;
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${cssWidth}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
          canvas.className = "mx-auto mb-4 block rounded-md bg-white shadow-sm last:mb-0";
          canvas.setAttribute("aria-label", `MOU page ${n} of ${doc.numPages}`);
          container.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
        }
        await doc.destroy();
        if (!cancelled) setState("ready");
      } catch (err) {
        console.error("[mou] viewer failed", err);
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#101828]/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Executed MOU"
    >
      <div
        className="flex h-full max-h-[92vh] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#EAECF0] px-6 py-4">
          <h2 className="text-base font-semibold text-[#101828]">Executed MOU</h2>
          <div className="flex items-center gap-2">
            <a
              href="/api/mou?download=1"
              className="rounded-md border border-[#D0D5DD] bg-white px-3 py-1.5 text-xs font-semibold text-[#344054] no-underline transition-colors hover:bg-[#F9FAFB]"
            >
              Download
            </a>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[#667085] transition-colors hover:bg-[#F2F4F7]"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <div className="relative flex-1 overflow-y-auto bg-[#F2F4F7] p-4 sm:p-6">
          {state === "loading" && (
            <p className="py-16 text-center text-sm text-[#667085]">Loading your MOU…</p>
          )}
          {state === "error" && (
            <p className="py-16 text-center text-sm text-[#667085]">
              Couldn&apos;t display the MOU here. Use Download to save a copy instead.
            </p>
          )}
          {/* Kept in layout while loading so pages are sized to its width. */}
          <div ref={pagesRef} className={state === "ready" ? "" : "invisible h-0 overflow-hidden"} />
        </div>
      </div>
    </div>
  );
}
