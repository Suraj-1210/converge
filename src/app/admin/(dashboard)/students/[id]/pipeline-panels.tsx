"use client";

import { useRef, useState } from "react";
import { Modal } from "~/components/ui/modal";
import {
  INACTIVE_REASON_CODES,
  InactiveReason,
  InactiveReasonLabel,
  STUDENT_DOC_TYPES,
  UniApplicationStatus,
  UniApplicationStatusLabel,
  partnerReportOption,
} from "~/server/db/enums";
import { api } from "~/trpc/react";
import { APPLICATION_UPLOAD_KINDS, applicationUploadKinds } from "~/lib/application-uploads";
import { IntakePicker, intakeProblem } from "~/components/students/intake-picker";
import { type ApplicationCard } from "../lib";

// Phase 3A panels on an application card (17 Oct 2026): the Documents
// Pending list (picker + checklist) and a partner's report awaiting
// confirmation.

export interface PendingDocPick {
  key: string;
  label?: string | null;
}

const OTHER = "other";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// ---- Picker -----------------------------------------------------------------

// Pick the documents still needed when moving to Documents Pending (or edit
// the list while there). Standard student document types plus free-text
// "Other" lines; at least one is required.
export function PendingDocsModal({
  open,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial: ApplicationCard["pendingDocs"];
  busy: boolean;
  onClose: () => void;
  onSubmit: (picks: PendingDocPick[]) => void;
}) {
  const [keys, setKeys] = useState<Set<string>>(
    () => new Set(initial.filter((d) => d.key !== OTHER).map((d) => d.key)),
  );
  const [others, setOthers] = useState<string[]>(() =>
    initial.filter((d) => d.key === OTHER).map((d) => d.label),
  );
  const [draft, setDraft] = useState("");

  const toggle = (k: string) => {
    const next = new Set(keys);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setKeys(next);
  };
  const addOther = () => {
    const v = draft.trim();
    if (!v || others.some((o) => o.toLowerCase() === v.toLowerCase())) return;
    setOthers([...others, v]);
    setDraft("");
  };
  const picks: PendingDocPick[] = [
    ...STUDENT_DOC_TYPES.filter((d) => keys.has(d.key)).map((d) => ({ key: d.key })),
    ...[...others, ...(draft.trim() ? [draft.trim()] : [])].map((label) => ({ key: OTHER, label })),
  ];

  return (
    <Modal
      open={open}
      title="Which documents are pending?"
      onClose={onClose}
      width="w-[600px]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || picks.length === 0}
            onClick={() => onSubmit(picks)}
            className="cursor-pointer rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#175CD3] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Saving…" : `Request ${picks.length || ""} document${picks.length === 1 ? "" : "s"}`}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-[#475467]">
        The partner is told exactly which documents to upload (in-app and email). Each one ticks off when a
        document of that type is uploaded for the student.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {STUDENT_DOC_TYPES.map((d) => (
          <label key={d.key} className="flex cursor-pointer items-center gap-2 text-[13px] text-[#344054]">
            <input
              type="checkbox"
              checked={keys.has(d.key)}
              onChange={() => toggle(d.key)}
              className="h-4 w-4 cursor-pointer accent-[#1570EF]"
            />
            {d.label}
          </label>
        ))}
      </div>
      <div>
        <div className="mb-1.5 text-[12px] font-semibold text-[#344054]">Other</div>
        {others.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {others.map((o) => (
              <li
                key={o}
                className="flex items-center gap-1 rounded-full bg-[#F2F4F7] px-2.5 py-1 text-[12px] text-[#344054]"
              >
                {o}
                <button
                  type="button"
                  aria-label={`Remove ${o}`}
                  onClick={() => setOthers(others.filter((x) => x !== o))}
                  className="cursor-pointer text-[#98A2B3] hover:text-[#F04438]"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOther();
              }
            }}
            maxLength={120}
            placeholder="e.g. Bank statement (last 6 months)"
            className="h-9 min-w-0 flex-1 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]"
          />
          <button
            type="button"
            onClick={addOther}
            disabled={!draft.trim()}
            className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Checklist --------------------------------------------------------------

// The named documents on an application at Documents Pending, ticked as
// they arrive. A counsellor can tick one by hand (received another way).
export function PendingDocsPanel({
  app: a,
  onEdit,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  onEdit: () => void;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const tickMut = api.applicationPipeline.setPendingDocReceived.useMutation({
    onSuccess: () => invalidate(),
    onError: (err) => onToast(err.message),
  });
  const docs = a.pendingDocs;
  const received = docs.filter((d) => d.receivedAt).length;
  return (
    <div className="mt-4 rounded-[10px] border border-[#FEDF89] bg-[#FFFCF5] px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-bold text-[#B54708]">
          Pending documents · {received} of {docs.length} received
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="cursor-pointer rounded-md border border-[#FEC84B] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#B54708] hover:bg-[#FFFAEB]"
        >
          Edit list
        </button>
      </div>
      {docs.length === 0 ? (
        <p className="text-[13px] text-[#93370D]">No documents named yet. Use “Edit list” to tell the partner what is needed.</p>
      ) : (
        <ul className="space-y-1.5">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={!!d.receivedAt}
                disabled={tickMut.isPending}
                onChange={(e) =>
                  tickMut.mutate({ applicationId: a.id, itemId: d.id, received: e.target.checked })
                }
                aria-label={`${d.label} received`}
                className="h-4 w-4 cursor-pointer accent-[#12B76A]"
              />
              <span className={d.receivedAt ? "text-[#667085] line-through" : "text-[#344054]"}>{d.label}</span>
              {d.receivedAt && <span className="text-[11px] text-[#12B76A]">received {fmtDate(d.receivedAt)}</span>}
            </li>
          ))}
        </ul>
      )}
      {docs.length > 0 && received === docs.length && (
        <div className="mt-2.5 text-xs font-medium text-[#027A48]">
          All pending documents received. Advance to Application Submitted when ready.
        </div>
      )}
    </div>
  );
}

// ---- Partner report -----------------------------------------------------------

// A partner's report (Deposit Paid, visa outcome) waiting for a Collegepond
// counsellor. Confirming applies the stage; rejecting tells the partner why.
export function PartnerReportPanel({
  app: a,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const confirmMut = api.applicationPipeline.confirmPartnerReport.useMutation({
    onSuccess: () => {
      invalidate();
      onToast("Partner update confirmed");
    },
    onError: (err) => onToast(err.message),
  });
  const rejectMut = api.applicationPipeline.rejectPartnerReport.useMutation({
    onSuccess: () => {
      invalidate();
      setRejecting(false);
      onToast("Partner update rejected — the partner has been told why");
    },
    onError: (err) => onToast(err.message),
  });
  const r = a.partnerReport;
  if (!r?.pending) return null;
  const what =
    r.targetStatus === UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE
      ? `Deferred to ${r.deferredIntake ?? "a later intake"}`
      : (partnerReportOption(a.status, r.targetStatus)?.label ??
        (UniApplicationStatusLabel as Record<number, string | undefined>)[r.targetStatus] ??
        "Update");
  const busy = confirmMut.isPending || rejectMut.isPending;

  return (
    <div className="mt-4 rounded-[10px] border border-[#B2DDFF] bg-[#F5FAFF] px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-[#175CD3]">
            Reported by partner: {what} — awaiting Collegepond confirmation
          </div>
          <div className="mt-0.5 text-[12px] text-[#475467]">
            {fmtDate(r.createdAt)}
            {r.document && (
              <>
                {" · "}
                <a
                  href={r.document.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-[#1570EF] underline"
                >
                  {r.document.fileName}
                </a>
              </>
            )}
          </div>
          {r.note && <div className="mt-1 text-[13px] text-[#344054]">“{r.note}”</div>}
        </div>
        {!rejecting && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setRejecting(true)}
              className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => confirmMut.mutate({ reportId: r.id })}
              className="cursor-pointer rounded-lg bg-[#1570EF] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#175CD3] disabled:opacity-50"
            >
              Confirm {what}
            </button>
          </div>
        )}
      </div>
      {rejecting && (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Why can't this be confirmed? (sent to the partner)"
            className="h-9 min-w-[240px] flex-1 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] outline-none focus:border-[#1570EF]"
          />
          <button
            type="button"
            onClick={() => setRejecting(false)}
            className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !reason.trim()}
            onClick={() => rejectMut.mutate({ reportId: r.id, reason: reason.trim() })}
            className="cursor-pointer rounded-lg bg-[#D92D20] px-3 text-[12px] font-semibold text-white hover:bg-[#B42318] disabled:opacity-50"
          >
            Reject report
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Manual Inactive ----------------------------------------------------------

// A Collegepond counsellor marks the student Inactive with a reason (it wins
// over the derived overall status), or reactivates them.
export function InactiveControl({
  student,
  onToast,
}: {
  student: { id: number; inactive: { reason: string | null } | null };
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<InactiveReason>(InactiveReason.NOT_RESPONDING);
  const [note, setNote] = useState("");
  const done = (msg: string) => {
    void utils.students.adminGet.invalidate({ id: student.id });
    void utils.students.adminList.invalidate();
    setOpen(false);
    onToast(msg);
  };
  const inactiveMut = api.applicationPipeline.setStudentInactive.useMutation({
    onSuccess: () => done("Student marked inactive"),
    onError: (err) => onToast(err.message),
  });
  const reactivateMut = api.applicationPipeline.reactivateStudent.useMutation({
    onSuccess: () => done("Student reactivated"),
    onError: (err) => onToast(err.message),
  });

  if (student.inactive) {
    return (
      <button
        type="button"
        disabled={reactivateMut.isPending}
        onClick={() => reactivateMut.mutate({ studentId: student.id })}
        className="cursor-pointer rounded-lg border border-[#ABEFC6] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#067647] hover:bg-[#ECFDF3] disabled:opacity-50"
      >
        Reactivate
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#475467] hover:bg-[#F9FAFB]"
      >
        Mark inactive
      </button>
      <Modal
        open={open}
        title="Mark student inactive"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={inactiveMut.isPending || (reason === InactiveReason.OTHER && !note.trim())}
              onClick={() =>
                inactiveMut.mutate({ studentId: student.id, reason, note: note.trim() || null })
              }
              className="cursor-pointer rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#175CD3] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Mark inactive
            </button>
          </>
        }
      >
        <p className="text-[13px] text-[#475467]">
          The student shows as Inactive on both portals until someone reactivates them, whatever their
          applications say.
        </p>
        <div className="space-y-2">
          {INACTIVE_REASON_CODES.map((r) => (
            <label key={r} className="flex cursor-pointer items-center gap-2 text-[13px] text-[#344054]">
              <input
                type="radio"
                name="inactive-reason"
                checked={reason === r}
                onChange={() => setReason(r)}
                className="h-4 w-4 cursor-pointer accent-[#1570EF]"
              />
              {InactiveReasonLabel[r]}
            </label>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={255}
          rows={2}
          placeholder={reason === InactiveReason.OTHER ? "Note (required for Other)" : "Note (optional, Collegepond only)"}
          className="w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-[13px] outline-none focus:border-[#1570EF]"
        />
      </Modal>
    </>
  );
}

// ---- Deferral -----------------------------------------------------------------

// Defer to a later intake (Day 5 testing): the application stays open. From
// a visa stage it goes back to Deposit Paid, as the visa is filed again.
export function DeferModal({
  app: a,
  onClose,
  onDone,
  onToast,
}: {
  app: ApplicationCard;
  onClose: () => void;
  onDone: (msg: string) => void;
  onToast: (msg: string) => void;
}) {
  const [month, setMonth] = useState<number | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const deferMut = api.applicationPipeline.deferApplication.useMutation({
    onSuccess: (res) => onDone(`Deferred to ${res.intake} — the partner has been told`),
    onError: (err) => onToast(err.message),
  });
  const problem = intakeProblem(month, year);
  const visaStage =
    a.status === UniApplicationStatus.VISA_FILED || a.status === UniApplicationStatus.VISA_SECURED;
  return (
    <Modal
      open
      title={a.deferral ? "Change the deferred intake" : "Defer to a later intake"}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={deferMut.isPending || !!problem}
            onClick={() =>
              deferMut.mutate({ applicationId: a.id, month: month!, year: year!, note: note.trim() || null })
            }
            className="cursor-pointer rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#175CD3] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deferMut.isPending ? "Saving…" : "Defer"}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-[#475467]">
        {a.university} — {a.program}. The application stays open for the new intake and is listed under
        Deferred on the Students page.{" "}
        {visaStage
          ? "It goes back to Deposit Paid: the visa is filed again for the new intake."
          : `It stays at ${UniApplicationStatusLabel[a.status as UniApplicationStatus] ?? "its stage"}.`}
      </p>
      <IntakePicker
        month={month}
        year={year}
        onChange={(m, y) => {
          setMonth(m);
          setYear(y);
        }}
      />
      {month && year && problem && <p className="text-[12px] text-[#B42318]">{problem}</p>}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={255}
        rows={2}
        placeholder="Note (optional), e.g. deposit carried forward, refund requested"
        className="w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-[13px] outline-none focus:border-[#1570EF]"
      />
    </Modal>
  );
}

export function DeferralNotice({ app: a }: { app: ApplicationCard }) {
  const d = a.deferral;
  if (!d) return null;
  return (
    <div className="mt-4 rounded-lg border border-[#D9D6FE] bg-[#F5F3FF] px-4 py-2.5 text-[13px] text-[#5925DC]">
      <span className="font-semibold">Deferred to {d.intake}</span>
      {d.from ? <span className="text-[#475467]"> (was {d.from})</span> : null}
      <span className="text-[#475467]"> · {fmtDate(d.at)}</span>
      {d.note && <div className="mt-0.5 text-[#344054]">“{d.note}”</div>}
    </div>
  );
}

// ---- Partner uploads after Deposit Paid -------------------------------------------

const REVIEW_CHIP = {
  pending: { text: "Awaiting verification", cls: "bg-[#FFFAEB] text-[#B54708]" },
  verified: { text: "Verified", cls: "bg-[#ECFDF3] text-[#067647]" },
  rejected: { text: "Not accepted", cls: "bg-[#FEF3F2] text-[#B42318]" },
} as const;

// The deposit slip, visa documents and visa approved copy the partner
// uploaded for this application; a counsellor verifies or rejects each.
// Collegepond can also add one itself (e.g. a slip received by email), which
// counts as verified. Commission approval needs a verified deposit slip.
export function ApplicationDocsPanel({
  app: a,
  studentId,
  onToast,
  invalidate,
}: {
  app: ApplicationCard;
  studentId: number;
  onToast: (msg: string) => void;
  invalidate: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const reviewMut = api.applicationPipeline.reviewApplicationDocument.useMutation({
    onSuccess: (_r, vars) => {
      invalidate();
      setRejectingId(null);
      setReason("");
      onToast(vars.approve ? "Document verified" : "Document rejected — the partner has been asked to re-upload");
    },
    onError: (err) => onToast(err.message),
  });
  const docs = a.applicationDocs;
  const depositMissing =
    a.stage === UniApplicationStatus.DEPOSIT_PAID ||
    a.stage === UniApplicationStatus.VISA_FILED ||
    a.stage === UniApplicationStatus.VISA_SECURED ||
    a.stage === UniApplicationStatus.ENROLLED
      ? !docs.some((d) => d.docType === "deposit_receipt" && d.review !== "rejected")
      : false;
  const kinds = applicationUploadKinds(a.status);
  if (docs.length === 0 && kinds.length === 0) return null;
  const labelOf = (t: string) => APPLICATION_UPLOAD_KINDS.find((k) => k.docType === t)?.label ?? t;
  const upload = async (file: File) => {
    const kind = kinds.find((k) => k.docType === target);
    if (!kind) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("studentId", String(studentId));
      fd.append("docType", kind.docType);
      fd.append("applicationId", String(a.id));
      fd.append("file", file);
      const res = await fetch("/api/admin/student-doc", { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Upload failed");
      onToast(`${kind.label} added and marked verified`);
      invalidate();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      setTarget(null);
    }
  };

  return (
    <div className="mt-4 rounded-[10px] border border-[#E4E7EC] bg-white px-5 py-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-bold text-[#101828]">Documents for this application</span>
        <span className="flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <button
              key={k.docType}
              type="button"
              disabled={uploading}
              onClick={() => {
                setTarget(k.docType);
                input.current?.click();
              }}
              title="Upload it yourself (counts as verified)"
              className="cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:opacity-50"
            >
              {uploading && target === k.docType ? "Uploading…" : `+ ${k.label}`}
            </button>
          ))}
        </span>
      </div>
      {depositMissing && (
        <div className="mb-2 rounded-md bg-[#FFFAEB] px-3 py-2 text-[12px] font-medium text-[#B54708]">
          No deposit slip yet. The partner has been asked to upload it, or add it here if you have it. Commission
          can&apos;t be approved until it&apos;s verified.
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
          else setTarget(null);
        }}
      />
      <ul className="space-y-2">
        {docs.map((d) => {
          const chip = REVIEW_CHIP[d.review];
          return (
            <li key={d.id} className="text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-[#344054]">{labelOf(d.docType)}</span>
                <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-[#1570EF] underline">
                  {d.fileName}
                </a>
                <span className="text-[12px] text-[#98A2B3]">{fmtDate(d.createdAt)}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip.cls}`}>{chip.text}</span>
                {d.review !== "verified" && rejectingId !== d.id && (
                  <span className="ml-auto flex gap-2">
                    {d.review === "pending" && (
                      <button
                        type="button"
                        disabled={reviewMut.isPending}
                        onClick={() => setRejectingId(d.id)}
                        className="cursor-pointer rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50"
                      >
                        Reject
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={reviewMut.isPending}
                      onClick={() => reviewMut.mutate({ documentId: d.id, approve: true })}
                      className="cursor-pointer rounded-md bg-[#1570EF] px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-[#175CD3] disabled:opacity-50"
                    >
                      Verify
                    </button>
                  </span>
                )}
              </div>
              {d.review === "rejected" && d.reviewNote && (
                <div className="mt-0.5 text-[12px] text-[#B42318]">{d.reviewNote}</div>
              )}
              {rejectingId === d.id && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={255}
                    placeholder="Why isn't it acceptable? (sent to the partner)"
                    className="h-8 min-w-[240px] flex-1 rounded-lg border border-[#D0D5DD] px-3 text-[13px] outline-none focus:border-[#1570EF]"
                  />
                  <button
                    type="button"
                    onClick={() => setRejectingId(null)}
                    className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={reviewMut.isPending || !reason.trim()}
                    onClick={() => reviewMut.mutate({ documentId: d.id, approve: false, note: reason.trim() })}
                    className="cursor-pointer rounded-lg bg-[#D92D20] px-3 text-[12px] font-semibold text-white hover:bg-[#B42318] disabled:opacity-50"
                  >
                    Reject document
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
