"use client";

import { useState } from "react";
import { Modal } from "~/components/ui/modal";
import { REJECTION_REASON_CODES, RejectionReason, RejectionReasonLabel } from "~/server/db/enums";

// Moving an application to Rejected needs the university's reason (16 Nov
// testing), so rejections can be counted by reason. "Other" needs a note.
// The partner sees the reason in the email and on the application.
export function RejectionReasonModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: number, note: string | null) => void;
}) {
  const [reason, setReason] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const isOther = reason === RejectionReason.OTHER;
  const ready = reason !== null && (!isOther || note.trim() !== "");
  const submit = () => {
    if (ready && !busy) onSubmit(reason, note.trim() || null);
  };
  return (
    <Modal
      open
      title="Move to Rejected"
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
            disabled={busy || !ready}
            onClick={submit}
            className="cursor-pointer rounded-lg bg-[#D92D20] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#B42318] disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save and move to Rejected"}
          </button>
        </>
      }
    >
      <label className="block text-[13px] font-medium text-[#344054]">
        Rejection reason <span className="text-[#D92D20]">*</span>
      </label>
      <select
        autoFocus
        value={reason ?? ""}
        onChange={(e) => setReason(e.target.value ? Number(e.target.value) : null)}
        className="mt-1.5 h-10 w-full cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-[14px] text-[#344054] outline-none focus:border-[#1570EF]"
      >
        <option value="">Choose a reason…</option>
        {REJECTION_REASON_CODES.map((c) => (
          <option key={c} value={c}>
            {RejectionReasonLabel[c]}
          </option>
        ))}
      </select>
      <label className="mt-4 block text-[13px] font-medium text-[#344054]">
        {isOther ? (
          <>
            Describe the reason <span className="text-[#D92D20]">*</span>
          </>
        ) : (
          "Note (optional)"
        )}
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        rows={3}
        placeholder={isOther ? "What did the university say?" : "Anything the partner should know"}
        className="mt-1.5 w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-[14px] outline-none focus:border-[#1570EF]"
      />
      <p className="mt-2 text-[12px] text-[#667085]">
        The partner sees this reason in the email and on the application.
      </p>
    </Modal>
  );
}
