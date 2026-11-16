"use client";

/* eslint-disable @next/next/no-img-element -- previews of uploaded files */

import { useRef, useState } from "react";

// Admin upload for an event poster or a dashboard banner image. Files go to a
// public folder of /api/upload (event-creatives, partner-banners): they're
// shown to partners and embedded in emails. `value` is the stored reference,
// `previewUrl` the browser URL for it.

const isPdf = (s: string) => /\.pdf(\?|#|$)/i.test(s);

export function MediaUpload({
  label,
  hint,
  folder,
  value,
  previewUrl,
  allowPdf = false,
  maxMb = 5,
  wide = false,
  onChange,
}: {
  label: string;
  hint: string;
  folder: "event-creatives" | "partner-banners";
  value: string | null;
  previewUrl: string | null;
  allowPdf?: boolean;
  maxMb?: number;
  wide?: boolean;
  onChange: (stored: string | null, preview: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const types = allowPdf
    ? ["image/jpeg", "image/png", "application/pdf"]
    : ["image/jpeg", "image/png"];

  async function pick(file: File) {
    setErr("");
    if (!types.includes(file.type)) {
      setErr(allowPdf ? "Upload a JPG, PNG or PDF." : "Upload a JPG or PNG.");
      return;
    }
    if (file.size > maxMb * 1024 * 1024) {
      setErr(`The file must be under ${maxMb} MB.`);
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folder", folder);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !json.url) throw new Error(json.error ?? "Upload failed");
      onChange(json.url, json.url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const shown = previewUrl ?? value;
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-semibold text-[#344054]">
        {label}
      </div>
      <div className="flex items-start gap-3">
        <div
          className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] ${
            wide ? "aspect-[4/1] w-48" : "aspect-[1/1.414] w-20"
          }`}
        >
          {shown ? (
            isPdf(shown) ? (
              <a
                href={shown}
                target="_blank"
                rel="noopener noreferrer"
                className="px-1 text-center text-[11px] font-semibold text-[#B42318] underline"
              >
                PDF poster
              </a>
            ) : (
              <img src={shown} alt="" className="h-full w-full object-cover" />
            )
          ) : (
            <span className="px-1 text-center text-[10px] text-[#98A2B3]">
              No file
            </span>
          )}
        </div>
        <div className="min-w-0">
          <input
            ref={fileRef}
            type="file"
            accept={types.join(",")}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="cursor-pointer rounded-lg border border-[#1570EF] bg-white px-3 py-1.5 text-xs font-semibold text-[#1570EF] transition-colors hover:bg-[#1570EF] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Uploading…" : value ? "Replace" : "Upload"}
            </button>
            {value && !busy && (
              <button
                type="button"
                onClick={() => onChange(null, null)}
                className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-xs font-semibold text-[#344054] hover:bg-[#F9FAFB]"
              >
                Remove
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-[#98A2B3]">
            {hint}
          </p>
          {err && <p className="mt-1 text-[12px] text-[#F04438]">{err}</p>}
        </div>
      </div>
    </div>
  );
}
