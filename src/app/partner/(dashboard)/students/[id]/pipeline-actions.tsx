"use client";

import { useRef, useState } from "react";
import { Modal } from "~/components/ui/modal";
import {
  PARTNER_REPORTABLE,
  PartnerReportStatus,
  UniApplicationStatus,
  UniApplicationStatusLabel,
  partnerReportOption,
} from "~/server/db/enums";
import { type AdminStudentFull } from "~/app/admin/(dashboard)/students/lib";

type Card = AdminStudentFull["applicationCards"][number];

// Partner-side Phase 3A actions on an application card (17 Oct 2026):
//   - the documents Collegepond named at Documents Pending, each uploadable
//     in place (ticks off when uploaded);
//   - reporting Deposit Paid (from Unconditional Offer) or the visa outcome
//     (from Visa Filed) with the supporting document. A report takes effect
//     only when a Collegepond counsellor confirms it.

const ALLOWED = ".pdf,.doc,.docx,.jpg,.jpeg,.png";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

async function postForm(url: string, fd: FormData) {
  const res = await fetch(url, { method: "POST", body: fd });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Upload failed");
}

// ---- Documents Pending --------------------------------------------------------

export function PendingDocsChecklist({
  app: a,
  studentId,
  onChanged,
  onToast,
}: {
  app: Card;
  studentId: number;
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<Card["pendingDocs"][number] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const docs = a.pendingDocs;
  if (a.status !== UniApplicationStatus.DOCUMENTS_PENDING || docs.length === 0) return null;
  const left = docs.filter((d) => !d.receivedAt).length;

  const upload = async (file: File) => {
    if (!target) return;
    setBusyId(target.id);
    try {
      const fd = new FormData();
      fd.append("studentId", String(studentId));
      // A named standard document files under its own type; anything else
      // under Additional Documents, ticked by item.
      fd.append("docType", target.key === "other" ? "additional" : target.key);
      fd.append("applicationId", String(a.id));
      fd.append("pendingItemId", String(target.id));
      fd.append("file", file);
      await postForm("/api/partner/student-doc", fd);
      onToast(`${target.label} uploaded`);
      onChanged();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusyId(null);
      setTarget(null);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-[#FEDF89] bg-[#FFFCF5] px-4 py-3">
      <div className="text-[13px] font-semibold text-[#B54708]">
        {left > 0
          ? `Collegepond needs ${left} document${left === 1 ? "" : "s"} for this application`
          : "All requested documents received. Collegepond will take it from here."}
      </div>
      <ul className="mt-2 space-y-1.5">
        {docs.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="flex items-center gap-2">
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                  d.receivedAt ? "border-[#12B76A] bg-[#12B76A]" : "border-[#FEC84B] bg-white"
                }`}
                aria-hidden
              >
                {d.receivedAt && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3} className="h-2.5 w-2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </span>
              <span className={d.receivedAt ? "text-[#667085] line-through" : "text-[#344054]"}>{d.label}</span>
              {d.receivedAt && <span className="text-[11px] text-[#12B76A]">received {fmtDate(d.receivedAt)}</span>}
            </span>
            {!d.receivedAt && (
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => {
                  setTarget(d);
                  input.current?.click();
                }}
                className="h-7 cursor-pointer rounded-md bg-[#1570EF] px-2.5 text-[12px] font-semibold text-white hover:bg-[#1260d4] disabled:opacity-50"
              >
                {busyId === d.id ? "Uploading…" : "Upload"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <input
        ref={input}
        type="file"
        accept={ALLOWED}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
          else setTarget(null);
        }}
      />
    </div>
  );
}

// ---- Reports (Deposit Paid, visa outcome) -----------------------------------------

// The latest report's state on the card: awaiting Collegepond, or not
// accepted (with the reason). A confirmed one simply shows as the stage.
export function ReportStatus({ app: a }: { app: Card }) {
  const r = a.partnerReport;
  if (!r) return null;
  const what =
    (UniApplicationStatusLabel as Record<number, string | undefined>)[r.targetStatus] ?? "Update";
  if (r.pending) {
    return (
      <div className="mt-4 rounded-lg border border-[#B2DDFF] bg-[#F5FAFF] px-4 py-2.5 text-[13px] text-[#175CD3]">
        <span className="font-semibold">Reported by you: {what}</span> — awaiting Collegepond confirmation
        <span className="text-[#475467]"> · {fmtDate(r.createdAt)}</span>
        {r.document && (
          <>
            {" · "}
            <a href={r.document.fileUrl} target="_blank" rel="noreferrer" className="underline">
              {r.document.fileName}
            </a>
          </>
        )}
      </div>
    );
  }
  // Show a rejection while the application is still at the stage it was
  // reported from (so the partner can try again); once it moves on, the
  // stage speaks for itself.
  if (r.status === PartnerReportStatus.REJECTED && partnerReportOption(a.status, r.targetStatus)) {
    return (
      <div className="mt-4 rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-4 py-2.5 text-[13px] text-[#B42318]">
        <span className="font-semibold">“{what}” was not confirmed</span>
        {r.decisionNote ? `: ${r.decisionNote}` : ""}
        {r.decidedAt && <span className="text-[#912018]"> · {fmtDate(r.decidedAt)}</span>}
      </div>
    );
  }
  return null;
}

// "Mark Deposit Paid" / "Report visa outcome" button + its form, for the
// stages a partner can report from. Hidden while a report is pending.
export function ReportAction({
  app: a,
  onDone,
}: {
  app: Card;
  onDone: (msg: string) => void;
}) {
  const options = PARTNER_REPORTABLE[a.status as UniApplicationStatus] ?? [];
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (options.length === 0 || a.partnerReport?.pending) return null;

  const isDeposit = a.status === UniApplicationStatus.UNCONDITIONAL_OFFER;
  const chosen = to !== null ? partnerReportOption(a.status, to) : options.length === 1 ? options[0]! : null;
  const close = () => {
    setOpen(false);
    setTo(null);
    setNote("");
    setFile(null);
    setError(null);
  };
  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("applicationId", String(a.id));
      fd.append("targetStatus", String(chosen.to));
      if (note.trim()) fd.append("note", note.trim());
      if (file) fd.append("file", file);
      await postForm("/api/partner/application-report", fd);
      close();
      onDone(`${chosen.label} sent to Collegepond for confirmation`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the update");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-8 cursor-pointer rounded-lg border border-[#B2CCFF] bg-[#F5F9FF] px-3 text-[12px] font-semibold text-[#175CD3] hover:bg-[#EFF4FF]"
      >
        {isDeposit ? "Mark Deposit Paid" : "Report visa outcome"}
      </button>
      <Modal
        open={open}
        title={isDeposit ? "Mark Deposit Paid" : "Report the visa outcome"}
        onClose={close}
        footer={
          <>
            <button
              type="button"
              onClick={close}
              className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !chosen || (chosen.docRequired && !file)}
              onClick={() => void submit()}
              className="cursor-pointer rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#175CD3] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send to Collegepond"}
            </button>
          </>
        }
      >
        <p className="text-[13px] text-[#475467]">
          {a.university} — {a.program}. Collegepond checks the document and confirms the update; the
          application moves once they do. The document is saved to the student&apos;s documents.
        </p>
        {options.length > 1 && (
          <div className="space-y-2">
            {options.map((o) => (
              <label key={o.to} className="flex cursor-pointer items-center gap-2 text-[13px] text-[#344054]">
                <input
                  type="radio"
                  name={`report-${a.id}`}
                  checked={to === o.to}
                  onChange={() => setTo(o.to)}
                  className="h-4 w-4 cursor-pointer accent-[#1570EF]"
                />
                {o.label}
              </label>
            ))}
          </div>
        )}
        {chosen && (
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-[#344054]">
              {isDeposit
                ? "Deposit proof (receipt or bank confirmation)"
                : chosen.to === UniApplicationStatus.VISA_SECURED
                  ? "Visa grant letter or visa copy"
                  : chosen.to === UniApplicationStatus.VISA_REJECTED
                    ? "Visa refusal letter"
                    : "Supporting document (optional)"}
              {chosen.docRequired ? " *" : ""}
            </span>
            <input
              type="file"
              accept={ALLOWED}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-[13px] text-[#344054] file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-[#F2F4F7] file:px-3 file:py-1.5 file:text-[12px] file:font-semibold"
            />
          </label>
        )}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Note for Collegepond (optional)"
          className="w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-[13px] outline-none focus:border-[#1570EF]"
        />
        {error && <p className="text-[13px] text-[#B42318]">{error}</p>}
      </Modal>
    </>
  );
}
