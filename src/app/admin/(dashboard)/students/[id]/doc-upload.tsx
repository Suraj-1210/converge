"use client";

import { useRef, useState } from "react";
import { api } from "~/trpc/react";
import { useStudentProfileApi } from "./profile-api";
import { type AdminStudentFull } from "../lib";
import { formatBytes } from "./documents-tab";

// Inline upload slot used inside the Academic Qualification sections and
// Test attempts (the mock's edu-doc-category rows / "Upload Score Report").
// Files accumulate per docType; storage + listing ride the same
// /api/admin/student-doc route and document table as the Documents tab.
export function InlineDocUpload({
  student,
  docType,
  name,
  hint,
  onToast,
}: {
  student: AdminStudentFull;
  docType: string;
  name: string;
  hint: string;
  onToast: (msg: string) => void;
}) {
  const profileApi = useStudentProfileApi();
  const refresh = profileApi.useRefresh();
  const invalidate = () => refresh(student.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const files = student.documents.filter((d) => d.docType === docType);

  const deleteMut = api.students.deleteDocument.useMutation({
    onSuccess: () => {
      invalidate();
      onToast("File removed");
    },
    onError: (err) => onToast(err.message),
  });

  const upload = async (list: File[]) => {
    setUploading(true);
    let uploaded = 0;
    try {
      for (const file of list) {
        const fd = new FormData();
        fd.append("studentId", String(student.id));
        fd.append("docType", docType);
        fd.append("file", file);
        const res = await fetch(profileApi.uploadUrl, {
          method: "POST",
          body: fd,
        });
        if (res.ok) {
          uploaded += 1;
        } else {
          const json = (await res.json()) as { error?: string };
          onToast(json.error ?? `Failed to upload ${file.name}`);
        }
      }
      if (uploaded > 0) {
        invalidate();
        onToast(`Uploaded ${uploaded} file(s)`);
      }
    } catch {
      onToast("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-start gap-3 border-b border-[#F2F4F7] py-3 last:border-b-0">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F0F7FF]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#1570EF"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-[#101828]">{name}</div>
        <div className="text-xs text-[#98A2B3]">{hint}</div>
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {files.map((f) => (
              <span
                key={f.id}
                className="flex items-center gap-2 rounded-lg border border-[#E4E7EC] bg-white py-1 pr-2 pl-2.5 text-xs text-[#344054]"
              >
                <a
                  href={f.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="max-w-[200px] truncate font-medium text-[#1570EF] hover:underline"
                >
                  {f.fileName}
                </a>
                <span className="text-[#98A2B3]">
                  {formatBytes(f.sizeBytes)}
                </span>
                {profileApi.canDeleteDocuments && (
                  <button
                    type="button"
                    disabled={deleteMut.isPending}
                    onClick={() => deleteMut.mutate({ id: f.id })}
                    aria-label={`Remove ${f.fileName}`}
                    className="flex cursor-pointer items-center text-[#98A2B3] hover:text-[#F04438] disabled:opacity-50"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      className="h-3 w-3"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="h-3 w-3"
        >
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        </svg>
        {uploading ? "Uploading…" : "Upload"}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
        className="hidden"
        onChange={(e) => {
          const list = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (list.length > 0) void upload(list);
        }}
      />
    </div>
  );
}
