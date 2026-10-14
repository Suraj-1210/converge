"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "~/components/ui/modal";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  EXPECTED_STUDENT_DOC_TYPES,
  STUDENT_DOC_TYPES,
  studentDocSlot,
  type StudentDocSection,
  type StudentDocType,
} from "~/server/db/enums";
import { plural } from "./assignee";

type StudentDoc = RouterOutputs["students"]["partnerDocuments"][number];

const SECTIONS: { key: StudentDocSection; label: string }[] = [
  { key: "identity", label: "Identity" },
  { key: "academic", label: "Academic" },
  { key: "enrollment", label: "Enrollment" },
];
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".pdf,.doc,.docx,.jpg,.jpeg,.png";
const ALLOWED = new Set(["pdf", "doc", "docx", "jpg", "jpeg", "png"]);

// Current files per checklist slot: a superseded single-slot upload stays on
// the server as history but isn't "the" file any more.
export function docsBySlot(docs: StudentDoc[]): Map<string, StudentDoc[]> {
  const out = new Map<string, StudentDoc[]>();
  for (const d of docs) {
    const slot = studentDocSlot(d.docType);
    const t = STUDENT_DOC_TYPES.find((x) => x.key === slot);
    if (!d.isMostRecent && t?.multiple !== true) continue;
    out.set(slot, [...(out.get(slot) ?? []), d]);
  }
  return out;
}

export function expectedProgress(docs: StudentDoc[] | undefined) {
  const bySlot = docsBySlot(docs ?? []);
  const done = EXPECTED_STUDENT_DOC_TYPES.filter((t) =>
    bySlot.has(t.key),
  ).length;
  return { done, total: EXPECTED_STUDENT_DOC_TYPES.length };
}

function fileProblem(f: File): string | null {
  const ext = (f.name.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED.has(ext)) return "Use PDF, DOC, DOCX, JPG or PNG.";
  if (f.size > MAX_BYTES) return "Too large (max 10 MB).";
  return null;
}

async function uploadOne(studentId: number, docType: string, file: File) {
  const problem = fileProblem(file);
  if (problem) throw new Error(problem);
  const fd = new FormData();
  fd.append("studentId", String(studentId));
  fd.append("docType", docType);
  fd.append("file", file);
  const res = await fetch("/api/partner/student-doc", {
    method: "POST",
    body: fd,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Upload failed");
}

// Best guess at a dropped file's type from its name; the user confirms or
// changes it before uploading. Unknown → left blank for them to pick.
const word = (w: string) => new RegExp(`(^|[^a-z0-9])(${w})([^a-z0-9]|$)`, "i");
const GUESSES: [RegExp, string][] = [
  [/passport/i, "passport"],
  [/aadh?aa?r|national.?id/i, "national_id"],
  [word("10th|x|xth|ssc|sslc|class.?10"), "marksheet_10th"],
  [word("12th|xii|xiith|hsc|class.?12"), "marksheet_12th"],
  [/resume|curriculum|(^|[^a-z0-9])cv([^a-z0-9]|$)/i, "resume"],
  [/(^|[^a-z0-9])sop([^a-z0-9]|$)|statement.?of.?purpose/i, "sop"],
  [/(^|[^a-z0-9])lor([^a-z0-9]|$)|recommendation/i, "lor"],
  [/backlog/i, "backlog"],
  [/ielts|toefl|(^|[^a-z0-9])pte([^a-z0-9]|$)|duolingo/i, "english_test"],
  [
    /transcript|bachelor|b\.?tech|b\.?e\.|b\.?com|b\.?sc|degree/i,
    "transcript_bachelors",
  ],
  [/offer/i, "offer_letter"],
  [/visa/i, "visa"],
  [/deposit/i, "deposit_receipt"],
  [/tuition|fee.?receipt/i, "tuition_receipt"],
];
function guessType(name: string): string {
  return GUESSES.find(([re]) => re.test(name))?.[1] ?? "";
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

interface Queued {
  id: number;
  file: File;
  docType: string;
  state: "ready" | "uploading" | "done" | "error";
  error?: string;
}

// The student's documents as a checklist of the standard expected list, with
// per-item and multi-file uploads. Used inline on the student profile and in
// the Upload documents dialog. onPendingChange reports files queued but not
// uploaded, so a dialog can ask before discarding them.
export function DocumentsChecklist({
  student,
  onUploaded,
  onPendingChange,
}: {
  student: { id: number; firstName: string; lastName: string };
  onUploaded: (msg: string) => void;
  onPendingChange?: (waiting: number) => void;
}) {
  const utils = api.useUtils();
  const docs = api.students.partnerDocuments.useQuery({
    studentId: student.id,
  });
  const bySlot = docsBySlot(docs.data ?? []);
  const { done, total } = expectedProgress(docs.data);
  const refresh = () => {
    void utils.students.partnerDocuments.invalidate({ studentId: student.id });
    void utils.students.partnerGet.invalidate({ id: student.id });
  };

  // Multi-file drop: each file gets its own type before anything uploads.
  const [queue, setQueue] = useState<Queued[]>([]);
  const nextId = useRef(1);
  const [dragging, setDragging] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const [showOptional, setShowOptional] = useState(false);

  // Per-row (one doc type) uploads.
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setQueue((q) => [
      ...q,
      ...list.map((file) => {
        const problem = fileProblem(file);
        return {
          id: nextId.current++,
          file,
          docType: guessType(file.name),
          state: problem ? ("error" as const) : ("ready" as const),
          error: problem ?? undefined,
        };
      }),
    ]);
  };

  const pending = queue.filter((q) => q.state === "ready");
  const waiting = queue.filter((q) => q.state !== "done").length;
  useEffect(() => onPendingChange?.(waiting), [waiting, onPendingChange]);
  const uploadingQueue = queue.some((q) => q.state === "uploading");
  const missingType = pending.some((q) => !q.docType);

  async function uploadQueue() {
    let ok = 0;
    for (const item of pending) {
      setQueue((q) =>
        q.map((x) => (x.id === item.id ? { ...x, state: "uploading" } : x)),
      );
      try {
        await uploadOne(student.id, item.docType, item.file);
        ok++;
        setQueue((q) =>
          q.map((x) => (x.id === item.id ? { ...x, state: "done" } : x)),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        setQueue((q) =>
          q.map((x) =>
            x.id === item.id ? { ...x, state: "error", error: msg } : x,
          ),
        );
      }
    }
    refresh();
    if (ok > 0) {
      onUploaded(`${plural(ok, "document")} uploaded for ${student.firstName}`);
      // Done rows have served their purpose; failures stay to retry or remove.
      setQueue((q) => q.filter((x) => x.state !== "done"));
    }
  }

  async function uploadRow(t: StudentDocType, files: File[]) {
    const list = t.multiple ? files : files.slice(0, 1);
    if (list.length === 0) return;
    setRowBusy(t.key);
    setRowError((e) => ({ ...e, [t.key]: "" }));
    let ok = 0;
    for (const f of list) {
      try {
        await uploadOne(student.id, t.key, f);
        ok++;
      } catch (e) {
        setRowError((er) => ({
          ...er,
          [t.key]: `${f.name}: ${e instanceof Error ? e.message : "Upload failed"}`,
        }));
      }
    }
    setRowBusy(null);
    refresh();
    if (ok > 0) onUploaded(`${t.label} uploaded`);
  }

  const expectedSections = SECTIONS.map((sec) => ({
    ...sec,
    types: STUDENT_DOC_TYPES.filter((d) => d.section === sec.key && d.expected),
  })).filter((s) => s.types.length > 0);
  const optional = STUDENT_DOC_TYPES.filter((d) => !d.expected);
  const optionalUploaded = optional.filter((t) => bySlot.has(t.key)).length;

  return (
    <div className="space-y-4">
      {/* Progress */}
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold text-[#101828]">
            {docs.isLoading
              ? "Checking documents…"
              : `${done} of ${total} documents`}
          </span>
          {!docs.isLoading && (
            <span
              className={`text-[12px] font-medium ${done === total ? "text-[#027A48]" : "text-[#B54708]"}`}
            >
              {done === total
                ? "All expected documents uploaded"
                : `${total - done} missing`}
            </span>
          )}
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#F2F4F7]">
          <div
            className={`h-full rounded-full transition-all ${done === total ? "bg-[#12B76A]" : "bg-[#1570EF]"}`}
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
      </div>

      {/* Multi-file drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors ${
          dragging
            ? "border-[#1570EF] bg-[#F5F9FF]"
            : "border-[#D0D5DD] bg-[#FCFCFD]"
        }`}
      >
        <p className="text-[13px] text-[#344054]">
          <span className="font-semibold">Drop several files here</span> or{" "}
          <button
            type="button"
            onClick={() => pickRef.current?.click()}
            className="cursor-pointer font-semibold text-[#1570EF] hover:underline"
          >
            browse
          </button>
          , then choose what each one is.
        </p>
        <p className="mt-1 text-[11px] text-[#98A2B3]">
          PDF, DOC, DOCX, JPG or PNG, up to 10 MB each.
        </p>
        <input
          ref={pickRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {queue.length > 0 && (
        <div className="rounded-lg border border-[#E4E7EC]">
          <ul className="divide-y divide-[#F2F4F7]">
            {queue.map((q) => (
              <li
                key={q.id}
                className="flex flex-wrap items-center gap-2.5 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[13px] font-medium text-[#101828]"
                    title={q.file.name}
                  >
                    {q.file.name}
                  </div>
                  {q.state === "error" && (
                    <div className="text-[12px] text-[#F04438]">{q.error}</div>
                  )}
                  {q.state === "uploading" && (
                    <div className="text-[12px] text-[#1570EF]">Uploading…</div>
                  )}
                </div>
                <select
                  aria-label={`Document type for ${q.file.name}`}
                  value={q.docType}
                  disabled={q.state === "uploading"}
                  onChange={(e) =>
                    setQueue((list) =>
                      list.map((x) =>
                        x.id === q.id
                          ? {
                              ...x,
                              docType: e.target.value,
                              ...(fileProblem(x.file)
                                ? {}
                                : { state: "ready", error: undefined }),
                            }
                          : x,
                      ),
                    )
                  }
                  className={`h-8 w-[220px] rounded-lg border bg-white px-2 text-[12px] text-[#101828] outline-none focus:border-[#1570EF] ${
                    q.docType ? "border-[#D0D5DD]" : "border-[#F79009]"
                  }`}
                >
                  <option value="">Choose type…</option>
                  {SECTIONS.map((sec) => (
                    <optgroup key={sec.key} label={sec.label}>
                      {STUDENT_DOC_TYPES.filter(
                        (d) => d.section === sec.key,
                      ).map((d) => (
                        <option key={d.key} value={d.key}>
                          {d.label}
                          {d.expected ? "" : " (optional)"}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remove ${q.file.name}`}
                  disabled={q.state === "uploading"}
                  onClick={() =>
                    setQueue((list) => list.filter((x) => x.id !== q.id))
                  }
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-[#98A2B3] hover:bg-[#F9FAFB] hover:text-[#475467] disabled:opacity-40"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-3 border-t border-[#F2F4F7] bg-[#F9FAFB] px-3 py-2.5">
            <span className="text-[12px] text-[#667085]">
              {missingType
                ? "Choose a type for each file to upload."
                : `${plural(pending.length, "file")} ready`}
            </span>
            <button
              type="button"
              disabled={pending.length === 0 || missingType || uploadingQueue}
              onClick={() => void uploadQueue()}
              className="h-8 cursor-pointer rounded-lg bg-[#1570EF] px-3 text-[12px] font-semibold text-white hover:bg-[#1260d4] disabled:cursor-default disabled:opacity-50"
            >
              {uploadingQueue
                ? "Uploading…"
                : `Upload ${pending.length > 0 ? plural(pending.length, "file") : ""}`}
            </button>
          </div>
        </div>
      )}

      {docs.error && (
        <p className="text-[13px] text-[#F04438]">{docs.error.message}</p>
      )}

      {/* Expected checklist */}
      {expectedSections.map((sec) => (
        <div key={sec.key}>
          <div className="mb-2 text-[11px] font-bold tracking-wider text-[#667085] uppercase">
            {sec.label}
          </div>
          <ul className="space-y-2">
            {sec.types.map((t) => (
              <ChecklistRow
                key={t.key}
                type={t}
                files={bySlot.get(t.key) ?? []}
                loading={docs.isLoading}
                busy={rowBusy === t.key}
                disabled={rowBusy !== null && rowBusy !== t.key}
                error={rowError[t.key] ?? ""}
                onFiles={(f) => void uploadRow(t, f)}
              />
            ))}
          </ul>
        </div>
      ))}

      {/* Optional types stay available, folded away. */}
      <div className="rounded-lg border border-[#E4E7EC]">
        <button
          type="button"
          onClick={() => setShowOptional((v) => !v)}
          aria-expanded={showOptional}
          className="flex w-full cursor-pointer items-center justify-between px-3.5 py-2.5 text-left"
        >
          <span className="text-[13px] font-semibold text-[#344054]">
            Other documents{" "}
            <span className="font-normal text-[#98A2B3]">(optional)</span>
          </span>
          <span className="text-[12px] text-[#667085]">
            {optionalUploaded > 0 ? `${optionalUploaded} uploaded · ` : ""}
            {showOptional ? "Hide" : "Show"}
          </span>
        </button>
        {showOptional && (
          <ul className="space-y-2 border-t border-[#F2F4F7] p-2.5">
            {optional.map((t) => (
              <ChecklistRow
                key={t.key}
                type={t}
                files={bySlot.get(t.key) ?? []}
                loading={docs.isLoading}
                busy={rowBusy === t.key}
                disabled={rowBusy !== null && rowBusy !== t.key}
                error={rowError[t.key] ?? ""}
                onFiles={(f) => void uploadRow(t, f)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function UploadDocumentsModal({
  student,
  onClose,
  onUploaded,
}: {
  student: { id: number; firstName: string; lastName: string };
  onClose: () => void;
  onUploaded: (msg: string) => void;
}) {
  const [waiting, setWaiting] = useState(0);
  // A stray click on the backdrop shouldn't silently drop queued files.
  const close = () => {
    if (
      waiting > 0 &&
      !window.confirm(`Discard ${plural(waiting, "file")} not uploaded yet?`)
    )
      return;
    onClose();
  };
  return (
    <Modal
      open
      title={`Documents · ${student.firstName} ${student.lastName}`}
      onClose={close}
      width="w-[640px]"
      footer={
        <button
          type="button"
          onClick={close}
          className="h-9 cursor-pointer rounded-lg border border-[#D0D5DD] px-4 text-[13px] font-semibold text-[#344054]"
        >
          Done
        </button>
      }
    >
      <DocumentsChecklist
        student={student}
        onUploaded={onUploaded}
        onPendingChange={setWaiting}
      />
    </Modal>
  );
}

function ChecklistRow({
  type: t,
  files,
  loading,
  busy,
  disabled,
  error,
  onFiles,
}: {
  type: StudentDocType;
  files: StudentDoc[];
  loading: boolean;
  busy: boolean;
  disabled: boolean;
  error: string;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const has = files.length > 0;
  const latest = files[0];

  return (
    <li
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        if (!disabled && !busy) onFiles(Array.from(e.dataTransfer.files));
      }}
      className={`rounded-lg border px-3.5 py-2.5 transition-colors ${
        over
          ? "border-[#1570EF] bg-[#F5F9FF]"
          : has
            ? "border-[#E4E7EC]"
            : t.expected
              ? "border-[#FEDF89] bg-[#FFFCF5]"
              : "border-[#E4E7EC]"
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
            has
              ? "bg-[#D1FADF] text-[#027A48]"
              : t.expected
                ? "bg-[#FEF0C7] text-[#B54708]"
                : "bg-[#F2F4F7] text-[#98A2B3]"
          }`}
        >
          {has ? "✓" : t.expected ? "!" : "–"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[#101828]">
            {t.label}
            {t.multiple && (
              <span className="ml-1.5 text-[11px] font-normal text-[#98A2B3]">
                multiple allowed
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[12px]">
            {loading ? (
              <span className="text-[#98A2B3]">…</span>
            ) : has ? (
              <span className="text-[#027A48]">
                ✓ Uploaded{latest ? ` ${fmtDate(latest.createdAt)}` : ""}
                {files.length > 1 ? ` · ${plural(files.length, "file")}` : ""}
              </span>
            ) : t.expected ? (
              <span className="rounded-full bg-[#FEF0C7] px-2 py-0.5 font-semibold text-[#B54708]">
                Missing
              </span>
            ) : (
              <span className="text-[#98A2B3]">Not uploaded</span>
            )}
            {!has && !loading && (
              <span className="ml-2 text-[#98A2B3]">
                or drop a file on this row
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => inputRef.current?.click()}
          className={`h-8 shrink-0 cursor-pointer rounded-lg px-3 text-[12px] font-semibold disabled:cursor-default disabled:opacity-50 ${
            has || !t.expected
              ? "border border-[#D0D5DD] bg-white text-[#344054] hover:bg-[#F9FAFB]"
              : "bg-[#1570EF] text-white hover:bg-[#1260d4]"
          }`}
        >
          {busy
            ? "Uploading…"
            : has
              ? t.multiple
                ? "Add file"
                : "Replace"
              : "Upload"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple={t.multiple}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) onFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
      {has && (
        <ul className="mt-2 space-y-1 pl-8">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-2 text-[12px] text-[#475467]"
            >
              <span className="min-w-0 flex-1 truncate" title={f.fileName}>
                {f.fileName}
                <span className="text-[#98A2B3]">
                  {" "}
                  · {fmtDate(f.createdAt)}
                </span>
              </span>
              {f.fileUrl && (
                <a
                  href={f.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 font-semibold text-[#1570EF] hover:underline"
                >
                  View
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="mt-1.5 pl-8 text-[12px] text-[#F04438]">{error}</p>
      )}
    </li>
  );
}
