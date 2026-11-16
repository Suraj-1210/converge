"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { EmptyState, Skeleton } from "~/components/dashboard/widgets";
import { countryName, formatDate } from "~/components/dashboard/format";
import { ResourceKind, fileTypeLabel, formatBytes, isPreviewable, resourceOpenUrl } from "~/lib/resources";

type Resource = RouterOutputs["resources"]["partnerList"][number];

// Partner > Resources (16 Nov 2026): the library Collegepond publishes from
// Admin > Resources. The server decides what this partner may see (audience,
// publish / expiry dates); search and filters run here. Every preview,
// download and link-open goes through /api/resources/<id>, which logs it.

const selectCls =
  "h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]";

export default function PartnerResourcesPage() {
  const listQ = api.resources.partnerList.useQuery();
  const rows = useMemo(() => listQ.data ?? [], [listQ.data]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [university, setUniversity] = useState("");
  const [country, setCountry] = useState("");
  const [preview, setPreview] = useState<Resource | null>(null);
  // ?r=<id> from a notification: highlight that resource.
  const [focusId, setFocusId] = useState<number | null>(null);
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get("r"));
    if (Number.isInteger(id) && id > 0) setFocusId(id);
  }, []);
  useEffect(() => {
    if (focusId == null || rows.length === 0) return;
    document.getElementById(`resource-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, rows.length]);

  const filters = useMemo(() => {
    const cats = new Map<number, string>();
    const unis = new Map<number, string>();
    const countries = new Set<string>();
    for (const r of rows) {
      cats.set(r.category.id, r.category.name);
      if (r.university) unis.set(r.university.id, r.university.name);
      if (r.country) countries.add(r.country);
    }
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
    return {
      categories: [...cats].map(([id, name]) => ({ value: String(id), label: name })).sort(byLabel),
      universities: [...unis].map(([id, name]) => ({ value: String(id), label: name })).sort(byLabel),
      countries: [...countries].map((c) => ({ value: c, label: countryName(c) })).sort(byLabel),
    };
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (category && String(r.category.id) !== category) return false;
      if (university && String(r.university?.id ?? "") !== university) return false;
      if (country && r.country !== country) return false;
      if (!q) return true;
      return [r.title, r.description ?? "", r.category.name, r.university?.name ?? "", r.file?.name ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, category, university, country]);

  const filtered = search !== "" || category !== "" || university !== "" || country !== "";

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Resources</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Training materials, brochures, counsellor handbooks and templates from Collegepond.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search resources…"
          className="h-[38px] w-64 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
        />
        <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {filters.categories.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {filters.universities.length > 0 && (
          <select className={selectCls} value={university} onChange={(e) => setUniversity(e.target.value)}>
            <option value="">All universities</option>
            {filters.universities.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {filters.countries.length > 0 && (
          <select className={selectCls} value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">All countries</option>
            {filters.countries.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setCategory("");
              setUniversity("");
              setCountry("");
            }}
            className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-[13px] font-medium text-[#667085] hover:bg-[#F9FAFB]"
          >
            Reset
          </button>
        )}
      </div>

      {listQ.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : listQ.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">{listQ.error.message}</div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#D0D5DD] bg-white p-10">
          <EmptyState label={filtered ? "No resources match your search." : "No resources have been shared yet."} />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((r) => (
            <ResourceCard key={r.id} r={r} focused={r.id === focusId} onPreview={() => setPreview(r)} />
          ))}
        </div>
      )}

      {preview && (
        <Modal open title={preview.title} onClose={() => setPreview(null)} width="w-[min(960px,94vw)]">
          {preview.file?.mime === "application/pdf" ? (
            <iframe
              title={preview.title}
              src={resourceOpenUrl(preview.id, "preview")}
              className="h-[72vh] w-full rounded-lg border border-[#E4E7EC]"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={resourceOpenUrl(preview.id, "preview")}
              alt={preview.title}
              className="mx-auto max-h-[72vh] max-w-full rounded-lg"
            />
          )}
          <div className="mt-3 flex justify-end gap-2">
            <a
              href={resourceOpenUrl(preview.id, "preview")}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg px-3.5 py-2 text-[13px] font-semibold text-[#1570EF] hover:bg-[#F0F7FF]"
            >
              Open in new tab ↗
            </a>
            <a
              href={resourceOpenUrl(preview.id, "download")}
              className="rounded-lg border border-[#D0D5DD] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
            >
              Download
            </a>
          </div>
        </Modal>
      )}
    </>
  );
}

function ResourceCard({ r, focused, onPreview }: { r: Resource; focused: boolean; onPreview: () => void }) {
  const isLink = r.kind === ResourceKind.LINK;
  const canPreview = !isLink && isPreviewable(r.file?.mime);
  return (
    <div
      id={`resource-${r.id}`}
      className={`flex flex-col rounded-xl border bg-white p-5 transition ${
        focused ? "border-[#1570EF] ring-2 ring-[#B2DDFF]" : "border-[#E4E7EC] hover:border-[#B2DDFF]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 text-[11px] font-semibold text-[#344054]">{r.category.name}</span>
        {r.pinned && <span className="rounded-full bg-[#F4F3FF] px-2 py-0.5 text-[11px] font-semibold text-[#5925DC]">Pinned</span>}
        {r.important && <span className="rounded-full bg-[#FFFAEB] px-2 py-0.5 text-[11px] font-semibold text-[#B54708]">Important</span>}
        {r.isNew && <span className="rounded-full bg-[#ECFDF3] px-2 py-0.5 text-[11px] font-semibold text-[#027A48]">New</span>}
      </div>
      <h3 className="mt-2.5 text-[15px] font-bold text-[#101828]">{r.title}</h3>
      {r.description && <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-[#475467]">{r.description}</p>}
      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#667085]">
        {r.university && <span>{r.university.name}</span>}
        {r.country && <span>{countryName(r.country)}</span>}
        <span>{formatDate(r.publishOn)}</span>
        {isLink ? (
          <span>Link{r.linkHost ? ` · ${r.linkHost}` : ""}</span>
        ) : (
          r.file && (
            <span>
              {fileTypeLabel(r.file.mime)} · {formatBytes(r.file.size)}
            </span>
          )
        )}
      </div>
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {isLink ? (
          <a
            href={resourceOpenUrl(r.id, "open")}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-[#1570EF] px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
          >
            Open link ↗
          </a>
        ) : (
          <>
            {canPreview && (
              <button
                type="button"
                onClick={onPreview}
                className="cursor-pointer rounded-lg bg-[#1570EF] px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
              >
                Preview
              </button>
            )}
            <a
              href={resourceOpenUrl(r.id, "download")}
              className={`rounded-lg px-3.5 py-2 text-[13px] font-semibold ${
                canPreview
                  ? "border border-[#D0D5DD] bg-white text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
                  : "bg-[#1570EF] text-white hover:bg-[#1260d4]"
              }`}
            >
              Download
            </a>
          </>
        )}
      </div>
    </div>
  );
}
