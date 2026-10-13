"use client";

import { useRef, useState } from "react";
import { api } from "~/trpc/react";
import {
  STUDENT_DOC_TYPES,
  UserStatus,
  type StudentDocSection,
} from "~/server/db/enums";

const sectionHeading =
  "mt-6 mb-3 border-b border-[#F2F4F7] pb-1.5 text-[11px] font-bold tracking-wider text-[#667085] uppercase";

// Which of the agency's counsellors works this student. The owner can route
// it to an active counsellor or take it back; everyone else just sees it.
export function StudentCounsellor({
  studentId,
  counsellorId,
  counsellorName,
  isOwner,
  onChanged,
}: {
  studentId: number;
  counsellorId: number | null;
  counsellorName: string | null;
  isOwner: boolean;
  onChanged: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const team = api.counsellors.myCounsellors.useQuery(undefined, { enabled: isOwner });
  const [error, setError] = useState("");
  const assign = api.students.partnerAssignCounsellor.useMutation({
    onSuccess: (r) => {
      setError("");
      onChanged(r.counsellorName ? `Assigned to ${r.counsellorName}` : "Assigned to you");
      void utils.students.partnerList.invalidate();
      void utils.counsellors.myCounsellors.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const current = counsellorName ?? "Agency owner";
  if (!isOwner) {
    return (
      <>
        <div className={sectionHeading}>Counsellor</div>
        <p className="text-sm text-[#344054]">{current}</p>
      </>
    );
  }

  const active = (team.data ?? []).filter((c) => c.status === UserStatus.APPROVED);
  // Keep the current assignee selectable even if no longer active.
  const showCurrent = counsellorId !== null && !active.some((c) => c.id === counsellorId);

  return (
    <>
      <div className={sectionHeading}>Counsellor</div>
      <label className="mb-1.5 block text-[13px] font-medium text-[#344054]">
        Assigned to
      </label>
      <select
        value={counsellorId === null ? "owner" : String(counsellorId)}
        disabled={assign.isPending || team.isLoading}
        onChange={(e) =>
          assign.mutate({
            studentIds: [studentId],
            counsellorId: e.target.value === "owner" ? null : Number(e.target.value),
          })
        }
        className="h-[38px] w-full rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#101828] outline-none focus:border-[#1570EF] disabled:opacity-60"
      >
        <option value="owner">Me (agency owner)</option>
        {showCurrent && (
          <option value={String(counsellorId)} disabled>
            {current} (inactive)
          </option>
        )}
        {active.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.name}
          </option>
        ))}
      </select>
      {!team.isLoading && active.length === 0 && (
        <p className="mt-1.5 text-[12px] text-[#98A2B3]">
          No active counsellors yet. Add them on the Counsellors page.
        </p>
      )}
      {error && <p className="mt-1.5 text-[12px] text-[#F04438]">{error}</p>}
    </>
  );
}

const SECTIONS: { key: StudentDocSection; label: string }[] = [
  { key: "identity", label: "Identity" },
  { key: "academic", label: "Academic" },
  { key: "enrollment", label: "Enrollment" },
];
const LABEL = new Map(STUDENT_DOC_TYPES.map((d) => [d.key, d.label]));

function sizeLabel(bytes: number | null): string {
  if (!bytes) return "";
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The student's compliance / academic documents, with an upload control.
// Shown to anyone who can see the student; the server checks the same.
export function StudentDocuments({
  studentId,
  onUploaded,
}: {
  studentId: number;
  onUploaded: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const docs = api.students.partnerDocuments.useQuery({ studentId });
  const [docType, setDocType] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Current files only: a superseded single-slot upload stays as history.
  const current = (docs.data ?? []).filter((d) => {
    const t = STUDENT_DOC_TYPES.find((x) => x.key === d.docType);
    return t?.multiple || d.isMostRecent;
  });

  async function upload() {
    if (!docType) return setError("Choose a document type.");
    if (!file) return setError("Choose a file.");
    if (file.size > 10 * 1024 * 1024) return setError("File too large (max 10 MB).");
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("studentId", String(studentId));
      fd.append("docType", docType);
      fd.append("file", file);
      const res = await fetch("/api/partner/student-doc", { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Upload failed");
      onUploaded(`${LABEL.get(docType) ?? "Document"} uploaded`);
      setDocType("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      void utils.students.partnerDocuments.invalidate({ studentId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={sectionHeading}>Documents</div>
      <div className="rounded-lg border border-[#E4E7EC] p-3.5">
        <div className="grid grid-cols-1 gap-2.5">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-[#344054]">
              Document type <span className="text-[#F04438]">*</span>
            </label>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              className="h-[38px] w-full rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#101828] outline-none focus:border-[#1570EF]"
            >
              <option value="">Select…</option>
              {SECTIONS.map((sec) => (
                <optgroup key={sec.key} label={sec.label}>
                  {STUDENT_DOC_TYPES.filter((d) => d.section === sec.key).map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-[#344054]">
              File <span className="text-[#F04438]">*</span>
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-[13px] text-[#475467] file:mr-3 file:h-8 file:cursor-pointer file:rounded-lg file:border file:border-[#D0D5DD] file:bg-white file:px-3 file:text-[12px] file:font-semibold file:text-[#344054]"
            />
            <p className="mt-1 text-[11px] text-[#98A2B3]">PDF, DOC, DOCX, JPG or PNG, up to 10 MB.</p>
          </div>
        </div>
        {error && <p className="mt-2 text-[12px] text-[#F04438]">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void upload()}
          className="mt-3 h-8 rounded-lg bg-[#1570EF] px-3 text-[12px] font-semibold text-white hover:bg-[#1260d4] disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>

      {docs.isLoading ? (
        <p className="mt-3 text-[13px] text-[#98A2B3]">Loading documents…</p>
      ) : current.length === 0 ? (
        <p className="mt-3 text-[13px] text-[#98A2B3]">No documents uploaded yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {current.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[#E4E7EC] px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-[#101828]">
                  {LABEL.get(d.docType) ?? d.docType}
                </div>
                <div className="mt-0.5 truncate text-xs text-[#667085]">
                  {d.fileName}
                  {d.sizeBytes ? ` · ${sizeLabel(d.sizeBytes)}` : ""}
                </div>
              </div>
              <a
                href={d.fileUrl ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-[12px] font-semibold text-[#1570EF] hover:underline"
              >
                View
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
