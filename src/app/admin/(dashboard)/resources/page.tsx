"use client";

import { useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { StatCard, Skeleton } from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";
import { countryName, formatDate } from "~/components/dashboard/format";
import { Toast } from "~/components/ui/toast";
import { ResourceKind, audienceLabel, fileTypeLabel, formatBytes } from "~/lib/resources";
import { ResourceFormModal } from "./resource-form";
import { ResourceDetailModal } from "./resource-detail";
import { Badge } from "./ui";

type Row = RouterOutputs["resources"]["adminList"][number];
type Status = Row["status"];

// Admin > Resources (16 Nov 2026): the partner Resources library. Whoever has
// the Resources tab (built-in: Super Admin, BDM) adds files or links, edits
// them, replaces files (version history) and sees who opened them.

const STATUS_BADGE: Record<Status, { label: string; cls: string }> = {
  live: { label: "Live", cls: "bg-[#ECFDF3] text-[#027A48]" },
  scheduled: { label: "Scheduled", cls: "bg-[#EFF8FF] text-[#175CD3]" },
  expired: { label: "Expired", cls: "bg-[#F2F4F7] text-[#475467]" },
  archived: { label: "Archived", cls: "bg-[#FEF3F2] text-[#B42318]" },
};

const selectCls =
  "h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]";

export default function AdminResourcesPage() {
  const listQ = api.resources.adminList.useQuery();
  const categoriesQ = api.resources.adminCategories.useQuery();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<"" | Status>("");
  const [form, setForm] = useState<{ id: number | null } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const toast = (m: string) => {
    setToastMsg(m);
    setToastOpen(true);
  };

  const rows = useMemo(() => listQ.data ?? [], [listQ.data]);
  const counts = useMemo(() => {
    const c = { live: 0, scheduled: 0, expired: 0, archived: 0, downloads: 0 };
    for (const r of rows) {
      c[r.status]++;
      c.downloads += r.downloads;
    }
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status ? r.status !== status : r.status === "archived") return false;
      if (category && String(r.category.id) !== category) return false;
      if (!q) return true;
      return [r.title, r.description ?? "", r.category.name, r.university?.name ?? "", r.file?.name ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, category, status]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Resources</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Training material, brochures, handbooks and templates for partners. Partners always get the latest file.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setForm({ id: null })}
          className="flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
        >
          + Add Resource
        </button>
      </div>

      <Stagger className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <FadeUp className="h-full">
          <StatCard
            icon="check"
            tone="green"
            value={counts.live}
            label="Live"
            onClick={() => setStatus(status === "live" ? "" : "live")}
            active={status === "live"}
          />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard
            icon="calendar"
            tone="blue"
            value={counts.scheduled}
            label="Scheduled"
            onClick={() => setStatus(status === "scheduled" ? "" : "scheduled")}
            active={status === "scheduled"}
          />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard
            icon="clock"
            tone="orange"
            value={counts.expired + counts.archived}
            label="Expired / Archived"
            sub={`${counts.expired} expired · ${counts.archived} archived`}
          />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="trend-up" tone="purple" value={counts.downloads} label="Partner Opens" />
        </FadeUp>
      </Stagger>

      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search resources…"
          className="h-[38px] w-64 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
        />
        <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {(categoriesQ.data ?? []).map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
              {c.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as "" | Status)}>
          <option value="">Live, scheduled & expired</option>
          <option value="live">Live</option>
          <option value="scheduled">Scheduled</option>
          <option value="expired">Expired</option>
          <option value="archived">Archived</option>
        </select>
        {(search !== "" || category !== "" || status !== "") && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setCategory("");
              setStatus("");
            }}
            className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-[13px] font-medium text-[#667085] hover:bg-[#F9FAFB]"
          >
            Reset
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-[#E4E7EC] bg-white">
        <table className="w-full min-w-[960px] border-collapse">
          <thead>
            <tr>
              {["Resource", "Category", "Tags", "Audience", "Dates", "Status", "Opens", ""].map((h) => (
                <th
                  key={h}
                  className="border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold tracking-wider text-[#667085] uppercase"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {listQ.isLoading ? (
              <tr>
                <td colSpan={8} className="p-5">
                  <Skeleton className="h-24 w-full" />
                </td>
              </tr>
            ) : listQ.error ? (
              <tr>
                <td colSpan={8} className="px-5 py-8 text-center text-sm text-[#B42318]">
                  {listQ.error.message}
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-sm text-[#98A2B3]">
                  {rows.length === 0 ? "No resources yet. Add the first one." : "No resources match these filters."}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.id} className="border-b border-[#F2F4F7] align-top last:border-0 hover:bg-[#FCFCFD]">
                  <td className="max-w-[320px] px-3.5 py-3">
                    <button
                      type="button"
                      onClick={() => setDetailId(r.id)}
                      className="cursor-pointer text-left text-sm font-semibold text-[#101828] hover:text-[#1570EF]"
                    >
                      {r.title}
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#667085]">
                      {r.pinned && <Badge cls="bg-[#F4F3FF] text-[#5925DC]">Pinned</Badge>}
                      {r.important && <Badge cls="bg-[#FFFAEB] text-[#B54708]">Important</Badge>}
                      {r.kind === ResourceKind.LINK ? (
                        <span>Link</span>
                      ) : r.file ? (
                        <span>
                          {fileTypeLabel(r.file.mime)} · {formatBytes(r.file.size)} · v{r.file.version}
                        </span>
                      ) : (
                        <span className="text-[#B42318]">No file yet</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3.5 py-3 text-sm text-[#344054]">{r.category.name}</td>
                  <td className="px-3.5 py-3 text-xs text-[#475467]">
                    {r.university && <div>{r.university.name}</div>}
                    {r.country && <div>{countryName(r.country)}</div>}
                    {!r.university && !r.country && <span className="text-[#98A2B3]">—</span>}
                  </td>
                  <td className="max-w-[160px] px-3.5 py-3 text-xs text-[#475467]">{audienceLabel(r.audience)}</td>
                  <td className="px-3.5 py-3 text-xs whitespace-nowrap text-[#475467]">
                    <div>From {formatDate(r.publishOn)}</div>
                    <div className="text-[#98A2B3]">{r.expiresOn ? `Until ${formatDate(r.expiresOn)}` : "No expiry"}</div>
                  </td>
                  <td className="px-3.5 py-3">
                    <Badge cls={STATUS_BADGE[r.status].cls}>{STATUS_BADGE[r.status].label}</Badge>
                    {r.notify && (
                      <div className="mt-1 text-[11px] text-[#98A2B3]">
                        {r.announced ? "Partners notified" : "Notifies on publish"}
                      </div>
                    )}
                  </td>
                  <td className="px-3.5 py-3 text-sm text-[#344054]">
                    {r.downloads}
                    <div className="text-[11px] text-[#98A2B3]">
                      {r.downloaders} partner{r.downloaders === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="px-3.5 py-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setForm({ id: r.id })}
                      className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetailId(r.id)}
                      className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#344054] hover:bg-[#F2F4F7]"
                    >
                      {r.kind === ResourceKind.FILE ? "Versions & opens" : "Opens"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <ResourceFormModal
          id={form.id}
          onClose={() => setForm(null)}
          onSaved={(msg) => {
            setForm(null);
            toast(msg);
          }}
        />
      )}
      {detailId != null && (
        <ResourceDetailModal
          id={detailId}
          onClose={() => setDetailId(null)}
          onEdit={() => {
            setForm({ id: detailId });
            setDetailId(null);
          }}
          toast={toast}
        />
      )}
      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </>
  );
}

