"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { countryName } from "~/components/dashboard/format";
import { AdminRole } from "~/server/db/enums";
import {
  RESOURCE_ACCEPT,
  RESOURCE_AUDIENCE_OPTIONS,
  ResourceAudience,
  ResourceKind,
  fileTypeLabel,
  formatBytes,
  todayIstIso,
} from "~/lib/resources";
import { uploadResourceFile, type UploadedResourceFile } from "./upload";

// Destination countries offered for the country tag, plus any country a
// university is in.
const COMMON_COUNTRIES = ["GB", "US", "CA", "AU", "IE", "DE", "NZ", "FR", "NL", "SG", "IT", "ES", "AE"];

type Form = {
  kind: number;
  title: string;
  description: string;
  categoryId: string;
  universityId: string;
  country: string;
  audience: string;
  linkUrl: string;
  publishOn: string;
  expiresOn: string;
  pinned: boolean;
  important: boolean;
  notify: boolean;
};

const empty = (): Form => ({
  kind: ResourceKind.FILE,
  title: "",
  description: "",
  categoryId: "",
  universityId: "",
  country: "",
  audience: String(ResourceAudience.ALL),
  linkUrl: "",
  publishOn: todayIstIso(),
  expiresOn: "",
  pinned: false,
  important: false,
  notify: false,
});

export function ResourceFormModal({
  id,
  onClose,
  onSaved,
}: {
  id: number | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const meQ = api.authSession.me.useQuery();
  const categoriesQ = api.resources.adminCategories.useQuery();
  const unisQ = api.resources.adminUniversities.useQuery();
  const existingQ = api.resources.adminGet.useQuery({ id: id ?? 0 }, { enabled: id != null });
  const existing = id != null ? existingQ.data : undefined;

  const [form, setForm] = useState<Form>(empty);
  const [loaded, setLoaded] = useState(id == null);
  const [file, setFile] = useState<UploadedResourceFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!existing || loaded) return;
    setForm({
      kind: existing.kind,
      title: existing.title,
      description: existing.description ?? "",
      categoryId: String(existing.category.id),
      universityId: existing.universityId ? String(existing.universityId) : "",
      country: existing.country ?? "",
      audience: String(existing.audience),
      linkUrl: existing.linkUrl ?? "",
      publishOn: existing.publishOn,
      expiresOn: existing.expiresOn ?? "",
      pinned: existing.pinned,
      important: existing.important,
      notify: existing.notify,
    });
    setLoaded(true);
  }, [existing, loaded]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const categoryOptions = useMemo(
    () =>
      (categoriesQ.data ?? [])
        .filter((c) => c.active || String(c.id) === form.categoryId)
        .map((c) => ({ value: String(c.id), label: c.active ? c.name : `${c.name} (inactive)` })),
    [categoriesQ.data, form.categoryId],
  );
  const uniOptions = useMemo(
    () => (unisQ.data ?? []).map((u) => ({ value: String(u.id), label: `${u.name} (${u.country})` })),
    [unisQ.data],
  );
  const countryOptions = useMemo(() => {
    const codes = new Set(COMMON_COUNTRIES);
    for (const u of unisQ.data ?? []) codes.add(u.country.toUpperCase());
    if (form.country) codes.add(form.country);
    return [...codes]
      .map((c) => ({ value: c, label: countryName(c) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [unisQ.data, form.country]);

  const done = async (msg: string) => {
    await Promise.all([utils.resources.adminList.invalidate(), utils.resources.adminGet.invalidate()]);
    onSaved(msg);
  };
  const announceMsg = (a: { bells: number; emails: number } | null | undefined) =>
    a && a.bells > 0 ? ` ${a.bells} partner${a.bells === 1 ? "" : "s"} notified${a.emails ? `, ${a.emails} emailed` : ""}.` : "";
  const createMut = api.resources.adminCreate.useMutation({
    onSuccess: (r) => done(`Resource added.${announceMsg(r.announced)}`),
    onError: (e) => setError(e.message),
  });
  const updateMut = api.resources.adminUpdate.useMutation({
    onSuccess: (r) => done(`Resource saved.${announceMsg(r.announced)}`),
    onError: (e) => setError(e.message),
  });

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    setUploading(true);
    try {
      const up = await uploadResourceFile(f);
      setFile(up);
      if (!form.title.trim()) set({ title: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() });
    } catch (e) {
      setFile(null);
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const save = () => {
    setError("");
    if (!form.title.trim()) return setError("Title is required.");
    if (!form.categoryId) return setError("Pick a category.");
    if (!form.publishOn) return setError("Pick a publish date.");
    if (form.expiresOn && form.expiresOn < form.publishOn) {
      return setError("The expiry date must be on or after the publish date.");
    }
    if (form.kind === ResourceKind.LINK && !form.linkUrl.trim()) return setError("Enter the link.");
    if (id == null && form.kind === ResourceKind.FILE && !file) return setError("Choose a file to upload.");
    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      categoryId: Number(form.categoryId),
      universityId: form.universityId ? Number(form.universityId) : null,
      country: form.country || null,
      audience: Number(form.audience) as ResourceAudience,
      linkUrl: form.kind === ResourceKind.LINK ? form.linkUrl.trim() : null,
      publishOn: form.publishOn,
      expiresOn: form.expiresOn || null,
      pinned: form.pinned,
      important: form.important,
      notify: form.notify,
    };
    if (id == null) {
      createMut.mutate({ ...payload, kind: form.kind as ResourceKind, upload: file?.upload ?? null });
    } else {
      updateMut.mutate({ ...payload, id });
    }
  };

  const isSuperAdmin = meQ.data?.role === AdminRole.SUPER_ADMIN;
  const busy = createMut.isPending || updateMut.isPending || uploading;
  const alreadyAnnounced = existing?.announcedAt != null;

  return (
    <Modal
      open
      title={id == null ? "Add Resource" : "Edit Resource"}
      onClose={onClose}
      width="w-[640px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={createMut.isPending || updateMut.isPending} disabled={busy || !loaded} onClick={save}>
            {id == null ? "Add Resource" : "Save"}
          </Button>
        </>
      }
    >
      {!loaded ? (
        <div className="py-8 text-center text-sm text-[#98A2B3]">Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          {id == null && (
            <div className="flex gap-2">
              {[
                { kind: ResourceKind.FILE, label: "Upload a file" },
                { kind: ResourceKind.LINK, label: "Add a link (video, Drive…)" },
              ].map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => set({ kind: k.kind })}
                  className={`flex-1 cursor-pointer rounded-lg border px-3 py-2.5 text-[13px] font-semibold ${
                    form.kind === k.kind
                      ? "border-[#1570EF] bg-[#EFF8FF] text-[#1570EF]"
                      : "border-[#D0D5DD] bg-white text-[#344054] hover:border-[#1570EF]"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          )}

          {form.kind === ResourceKind.FILE && id == null && (
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-[#344054]">
                File <span className="text-[#F04438]">*</span>
              </label>
              <input
                type="file"
                accept={RESOURCE_ACCEPT}
                disabled={uploading}
                onChange={(e) => void pickFile(e.target.files?.[0])}
                className="block w-full cursor-pointer text-[13px] text-[#344054] file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-[#D0D5DD] file:bg-white file:px-3 file:py-1.5 file:text-[13px] file:font-semibold file:text-[#344054]"
              />
              <p className="mt-1 text-xs text-[#667085]">
                {uploading
                  ? "Uploading…"
                  : file
                    ? `Uploaded: ${file.fileName} (${fileTypeLabel(file.mime)}, ${formatBytes(file.size)})`
                    : "PDF, PowerPoint, Word, Excel, JPG or PNG, up to 25 MB."}
              </p>
            </div>
          )}
          {form.kind === ResourceKind.FILE && id != null && (
            <p className="rounded-lg bg-[#F9FAFB] px-3 py-2 text-xs text-[#475467]">
              To replace the file, use <strong>Versions &amp; opens</strong>: the old file is kept in the history.
            </p>
          )}
          {form.kind === ResourceKind.LINK && (
            <FormInput
              label="Link"
              required
              placeholder="https://…"
              value={form.linkUrl}
              onChange={(e) => set({ linkUrl: e.target.value })}
            />
          )}

          <FormInput label="Title" required maxLength={200} value={form.title} onChange={(e) => set({ title: e.target.value })} />
          <FormTextarea
            label="Description"
            maxLength={2000}
            rows={3}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />

          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-1 flex-col">
              <FormSelect
                label="Category"
                required
                placeholder="Select a category"
                options={categoryOptions}
                value={form.categoryId}
                onChange={(e) => set({ categoryId: e.target.value })}
              />
              {isSuperAdmin && (
                <a
                  href="/admin/settings?section=resCategories"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 text-xs font-semibold text-[#1570EF] hover:underline"
                >
                  Manage categories
                </a>
              )}
            </div>
            <FormSelect
              label="Audience"
              required
              options={RESOURCE_AUDIENCE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
              value={form.audience}
              onChange={(e) => set({ audience: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-4 sm:flex-row">
            <FormSelect
              label="University (optional)"
              options={[{ value: "", label: "No university" }, ...uniOptions]}
              value={form.universityId}
              onChange={(e) => {
                const uni = unisQ.data?.find((u) => String(u.id) === e.target.value);
                set({ universityId: e.target.value, country: uni && !form.country ? uni.country.toUpperCase() : form.country });
              }}
            />
            <FormSelect
              label="Country (optional)"
              options={[{ value: "", label: "No country" }, ...countryOptions]}
              value={form.country}
              onChange={(e) => set({ country: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-4 sm:flex-row">
            <FormInput
              label="Publish date"
              required
              type="date"
              value={form.publishOn}
              onChange={(e) => set({ publishOn: e.target.value })}
            />
            <FormInput
              label="Expiry date (optional)"
              type="date"
              min={form.publishOn}
              value={form.expiresOn}
              onChange={(e) => set({ expiresOn: e.target.value })}
            />
          </div>
          <p className="-mt-2 text-xs text-[#667085]">
            Partners see it from the publish date through the expiry date (India time). A university-tagged resource also
            shows on that university in partner Uni Assist.
          </p>

          <div className="flex flex-col gap-2.5 rounded-lg border border-[#E4E7EC] p-3.5">
            <Check checked={form.pinned} onChange={(v) => set({ pinned: v })} label="Pinned" hint="Shown at the top of the partner library." />
            <Check
              checked={form.notify}
              onChange={(v) => set({ notify: v })}
              label="Notify partners"
              hint="The audience gets a bell notification when it is published (once per partner; saving again doesn't resend)."
            />
            <Check
              checked={form.important}
              onChange={(v) => set({ important: v })}
              label="Important"
              hint={form.notify ? "Also emailed to the audience, once." : "Marked Important in the library. Tick Notify partners to email it too."}
            />
            {alreadyAnnounced && form.notify && (
              <p className="text-xs text-[#B54708]">
                Already published: partners who were notified won&apos;t be notified again; anyone not yet notified will be
                when you save.
              </p>
            )}
          </div>

          {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 cursor-pointer accent-[#1570EF]"
      />
      <span>
        <span className="block text-[13px] font-semibold text-[#344054]">{label}</span>
        <span className="block text-xs text-[#667085]">{hint}</span>
      </span>
    </label>
  );
}
