"use client";

import { useRef, useState } from "react";
import {
  STUDENT_DOC_TYPES,
  studentDocSlot,
  type StudentDocSection,
  type StudentDocType,
} from "~/server/db/enums";
import { api } from "~/trpc/react";
import { type AdminStudentFull } from "../lib";

type StudentDoc = AdminStudentFull["documents"][number];

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsTab({
  student,
  onToast,
}: {
  student: AdminStudentFull;
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const invalidate = () =>
    void utils.students.adminGet.invalidate({ id: student.id });

  return (
    <div className="rounded-[14px] border border-[#E4E7EC] bg-white p-7">
      <DocSection
        title="Identity Documents"
        icon={<BriefcaseIcon />}
        section="identity"
        student={student}
        onToast={onToast}
        invalidate={invalidate}
      />
      <div className="mt-8">
        <DocSection
          title="Academic Documents"
          icon={<CapIcon />}
          section="academic"
          student={student}
          onToast={onToast}
          invalidate={invalidate}
        />
      </div>
      <div className="mt-8">
        <DocSection
          title="Enrollment Documents"
          icon={<BriefcaseIcon />}
          section="enrollment"
          student={student}
          onToast={onToast}
          invalidate={invalidate}
        />
      </div>
    </div>
  );
}

function DocSection({
  title,
  icon,
  section,
  student,
  onToast,
  invalidate,
}: {
  title: string;
  icon: React.ReactNode;
  section: StudentDocSection;
  student: AdminStudentFull;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2.5 border-b border-[#F2F4F7] pb-2.5">
        {icon}
        <h3 className="text-[15px] font-bold text-[#101828]">{title}</h3>
      </div>
      {STUDENT_DOC_TYPES.filter((d) => d.section === section).map((docType) => (
        <DocRow
          key={docType.key}
          docType={docType}
          student={student}
          onToast={onToast}
          invalidate={invalidate}
        />
      ))}
    </div>
  );
}

function DocRow({
  docType,
  student,
  onToast,
  invalidate,
}: {
  docType: StudentDocType;
  student: AdminStudentFull;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Single-slot types show only the current file; history rows stay hidden.
  // Older per-level/per-attempt profile uploads count toward their slot.
  const files = student.documents.filter(
    (d) =>
      studentDocSlot(d.docType) === docType.key &&
      (docType.multiple || d.isMostRecent),
  );
  const hasFiles = files.length > 0;
  const latest = files[0] ?? null;

  const deleteMut = api.students.deleteDocument.useMutation({
    onSuccess: () => {
      invalidate();
      onToast("Document removed");
    },
    onError: (err) => onToast(err.message),
  });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("studentId", String(student.id));
      fd.append("docType", docType.key);
      fd.append("file", file);
      const res = await fetch("/api/admin/student-doc", {
        method: "POST",
        body: fd,
      });
      const json = (await res.json()) as { error?: string; fileName?: string };
      if (!res.ok) {
        onToast(json.error ?? "Upload failed");
        return;
      }
      invalidate();
      onToast(`Uploaded ${json.fileName ?? file.name}`);
    } catch {
      onToast("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const statusLine = hasFiles
    ? docType.multiple
      ? `${files.length} file(s) uploaded`
      : `${latest!.fileName} (${formatBytes(latest!.sizeBytes)})`
    : docType.multiple
      ? "No files uploaded — multiple allowed"
      : "No file uploaded";

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-[#F2F4F7] py-4 last:border-b-0">
      <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] bg-[#F0F7FF]">
        <DocIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-[#101828]">
          {docType.label}
        </div>
        <div className="truncate text-[13px] text-[#667085]">{statusLine}</div>
        {/* File list for multi-slot types */}
        {docType.multiple && hasFiles && (
          <div className="mt-2 flex flex-wrap gap-2">
            {files.map((f) => (
              <FileChip
                key={f.id}
                file={f}
                onRemove={() => deleteMut.mutate({ id: f.id })}
                removing={deleteMut.isPending}
              />
            ))}
          </div>
        )}
      </div>
      <span
        className={`flex shrink-0 items-center gap-1 rounded-2xl px-3 py-1 text-[13px] font-semibold ${
          hasFiles ? "bg-[#ECFDF3] text-[#027A48]" : "bg-[#F9FAFB] text-[#98A2B3]"
        }`}
      >
        {hasFiles ? "Uploaded" : "Not Uploaded"}
      </span>
      <div className="flex shrink-0 gap-2">
        {hasFiles && !docType.multiple && (
          <a
            href={latest!.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer rounded-lg border border-[#1570EF] bg-white px-3.5 py-1.5 text-[13px] font-semibold text-[#1570EF] hover:bg-[#F0F7FF]"
          >
            Download
          </a>
        )}
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="cursor-pointer rounded-lg bg-[#1570EF] px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-[#1058c7] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading
            ? "Uploading…"
            : hasFiles
              ? docType.multiple
                ? "Add More"
                : "Replace"
              : "Upload"}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}

function FileChip({
  file,
  onRemove,
  removing,
}: {
  file: StudentDoc;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <span className="flex items-center gap-2 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] py-1.5 pr-2 pl-3 text-xs text-[#344054]">
      <a
        href={file.fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="max-w-[220px] truncate font-medium text-[#1570EF] hover:underline"
      >
        {file.fileName}
      </a>
      <span className="text-[#98A2B3]">{formatBytes(file.sizeBytes)}</span>
      <button
        type="button"
        disabled={removing}
        onClick={onRemove}
        aria-label={`Remove ${file.fileName}`}
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
    </span>
  );
}

function DocIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#1570EF"
      strokeWidth={2}
      className="h-5 w-5"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}

function CapIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#1570EF"
      strokeWidth={2}
      className="h-[18px] w-[18px] shrink-0"
    >
      <path d="M22 10L12 5 2 10l10 5 10-5z" />
      <path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" />
    </svg>
  );
}

function BriefcaseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#1570EF"
      strokeWidth={2}
      className="h-[18px] w-[18px] shrink-0"
    >
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  );
}
