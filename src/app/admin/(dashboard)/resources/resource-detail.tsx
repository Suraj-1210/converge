"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { countryName, formatDate } from "~/components/dashboard/format";
import { UserType } from "~/server/db/enums";
import {
  RESOURCE_ACCEPT,
  ResourceKind,
  audienceLabel,
  fileTypeLabel,
  formatBytes,
  resourceOpenUrl,
} from "~/lib/resources";
import { uploadResourceFile } from "./upload";
import { Badge } from "./ui";

const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3 py-2.5 text-[13px] text-[#344054]";

const PARTNER_TYPE: Record<number, string> = {
  [UserType.AGENCY_OWNER]: "Agency owner",
  [UserType.AGENCY_COUNSELLOR]: "Agency counsellor",
  [UserType.INDEPENDENT_COUNSELLOR]: "Independent",
};

function dateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// One resource: file versions (replace / restore) and which partners opened it.
export function ResourceDetailModal({
  id,
  onClose,
  onEdit,
  toast,
}: {
  id: number;
  onClose: () => void;
  onEdit: () => void;
  toast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const q = api.resources.adminGet.useQuery({ id });
  const r = q.data;
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => Promise.all([utils.resources.adminGet.invalidate({ id }), utils.resources.adminList.invalidate()]);
  const addVersion = api.resources.adminAddVersion.useMutation({
    onSuccess: async (v) => {
      await refresh();
      toast(`Version ${v.version} uploaded. Partners now get the new file.`);
    },
    onError: (e) => setError(e.message),
  });
  const restore = api.resources.adminRestoreVersion.useMutation({
    onSuccess: async (v) => {
      await refresh();
      toast(`Restored as version ${v.version}.`);
    },
    onError: (e) => setError(e.message),
  });
  const archive = api.resources.adminSetArchived.useMutation({
    onSuccess: async (_d, v) => {
      await refresh();
      toast(v.archived ? "Archived: partners no longer see it." : "Unarchived.");
    },
    onError: (e) => setError(e.message),
  });

  const replace = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setUploading(true);
    try {
      const up = await uploadResourceFile(file);
      addVersion.mutate({ id, upload: up.upload });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      open
      title={r?.title ?? "Resource"}
      onClose={onClose}
      width="w-[820px]"
      footer={
        <>
          {r && (
            <Button
              variant="secondary"
              loading={archive.isPending}
              onClick={() => {
                if (!r.archivedAt && !confirm("Archive this resource? Partners stop seeing it at once; its history is kept.")) return;
                archive.mutate({ id, archived: !r.archivedAt });
              }}
            >
              {r.archivedAt ? "Unarchive" : "Archive"}
            </Button>
          )}
          <Button onClick={onEdit}>Edit details</Button>
        </>
      }
    >
      {q.isLoading || !r ? (
        <div className="py-8 text-center text-sm text-[#98A2B3]">{q.error ? q.error.message : "Loading…"}</div>
      ) : (
        <div className="flex max-h-[65vh] flex-col gap-5 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3">
            <Info label="Category" value={r.category.name} />
            <Info label="Audience" value={audienceLabel(r.audience)} />
            <Info label="Status" value={r.status[0]!.toUpperCase() + r.status.slice(1)} />
            <Info label="University" value={r.university?.name ?? "—"} />
            <Info label="Country" value={r.country ? countryName(r.country) : "—"} />
            <Info label="Dates" value={`${formatDate(r.publishOn)} → ${r.expiresOn ? formatDate(r.expiresOn) : "no expiry"}`} />
            <Info
              label="Notify"
              value={
                r.notify
                  ? `${r.notifiedBell} bell${r.notifiedBell === 1 ? "" : "s"}${r.important ? `, ${r.notifiedEmail} email${r.notifiedEmail === 1 ? "" : "s"}` : ""}`
                  : "Off"
              }
            />
            <Info label="Added" value={`${r.createdBy ?? "—"}, ${formatDate(r.createdAt)}`} />
            <Info label="Flags" value={[r.pinned && "Pinned", r.important && "Important"].filter(Boolean).join(", ") || "—"} />
          </div>
          {r.description && <p className="text-[13px] whitespace-pre-line text-[#475467]">{r.description}</p>}
          {r.kind === ResourceKind.LINK && r.linkUrl && (
            <a href={r.linkUrl} target="_blank" rel="noopener noreferrer" className="text-[13px] font-semibold break-all text-[#1570EF] hover:underline">
              {r.linkUrl}
            </a>
          )}

          {r.kind === ResourceKind.FILE && (
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-[#101828]">File versions</h4>
                <label className={`cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF] ${uploading || addVersion.isPending ? "pointer-events-none opacity-60" : ""}`}>
                  {uploading || addVersion.isPending ? "Uploading…" : "Upload new version"}
                  <input type="file" accept={RESOURCE_ACCEPT} className="hidden" onChange={(e) => { void replace(e.target.files?.[0]); e.target.value = ""; }} />
                </label>
              </div>
              <div className="overflow-x-auto rounded-lg border border-[#E4E7EC]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={TH}>Version</th>
                      <th className={TH}>File</th>
                      <th className={TH}>Uploaded</th>
                      <th className={TH}>Opens</th>
                      <th className={`${TH} text-right`} />
                    </tr>
                  </thead>
                  <tbody>
                    {r.versions.length === 0 ? (
                      <tr><td colSpan={5} className="px-3 py-5 text-center text-sm text-[#98A2B3]">No file yet. Upload one: partners don&apos;t see the resource until it has a file.</td></tr>
                    ) : r.versions.map((v) => (
                      <tr key={v.id} className="border-b border-[#F2F4F7] last:border-0">
                        <td className={TD}>
                          v{v.version} {v.current && <Badge cls="ml-1 bg-[#ECFDF3] text-[#027A48]">Current</Badge>}
                          {v.restoredFrom != null && <div className="text-[11px] text-[#98A2B3]">restored from v{v.restoredFrom}</div>}
                        </td>
                        <td className={`${TD} max-w-[260px] break-all`}>
                          {v.fileName}
                          <div className="text-[11px] text-[#98A2B3]">{fileTypeLabel(v.mime)} · {formatBytes(v.size)}</div>
                        </td>
                        <td className={TD}>
                          {v.uploadedBy ?? "—"}
                          <div className="text-[11px] text-[#98A2B3]">{dateTime(v.uploadedAt)}</div>
                        </td>
                        <td className={TD}>{v.opens}</td>
                        <td className={`${TD} text-right whitespace-nowrap`}>
                          <a href={resourceOpenUrl(id, "download", { versionId: v.id, asAdmin: true })} className="rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]">
                            Download
                          </a>
                          {!v.current && (
                            <button
                              type="button"
                              disabled={restore.isPending}
                              onClick={() => {
                                if (confirm(`Restore v${v.version}? It becomes the latest version for partners; the current file stays in the history.`)) {
                                  restore.mutate({ id, versionId: v.id });
                                }
                              }}
                              className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#B54708] hover:bg-[#FFFAEB] disabled:opacity-50"
                            >
                              Restore
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h4 className="mb-2 text-sm font-semibold text-[#101828]">
              Partner opens <span className="font-normal text-[#667085]">· {r.totalOpens} open{r.totalOpens === 1 ? "" : "s"} by {r.totalDownloaders} partner{r.totalDownloaders === 1 ? "" : "s"}</span>
            </h4>
            <div className="overflow-x-auto rounded-lg border border-[#E4E7EC]">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={TH}>Partner</th>
                    <th className={TH}>Agency</th>
                    <th className={TH}>Type</th>
                    <th className={TH}>Opens</th>
                    <th className={TH}>Last opened</th>
                  </tr>
                </thead>
                <tbody>
                  {r.downloaders.length === 0 ? (
                    <tr><td colSpan={5} className="px-3 py-5 text-center text-sm text-[#98A2B3]">{r.totalDownloaders > 0 ? "None of the partners you look after has opened it yet." : "Nobody has opened it yet."}</td></tr>
                  ) : r.downloaders.map((d) => (
                    <tr key={d.userId} className="border-b border-[#F2F4F7] last:border-0">
                      <td className={TD}>
                        {d.name}
                        <div className="text-[11px] text-[#98A2B3]">{d.email}</div>
                      </td>
                      <td className={TD}>{d.organization ?? "—"}</td>
                      <td className={TD}>{PARTNER_TYPE[d.type] ?? "—"}</td>
                      <td className={TD}>{d.count}</td>
                      <td className={TD}>{dateTime(d.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {r.hiddenDownloaders > 0 && r.downloaders.length > 0 && (
              <p className="mt-1.5 text-xs text-[#98A2B3]">
                Plus {r.hiddenDownloaders} partner{r.hiddenDownloaders === 1 ? "" : "s"} you don&apos;t look after.
              </p>
            )}
          </section>

          {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">{label}</div>
      <div className="text-[#344054]">{value}</div>
    </div>
  );
}
