"use client";

import { useState } from "react";
import { Modal } from "~/components/ui/modal";
import { UniApplicationStatusLabel } from "~/server/db/enums";

// Moving to Conditional or Unconditional Offer needs the university's Student
// ID (29 Oct testing): asked for here when the application has none yet, and
// saved together with the move.
export function UniIdModal({
  target,
  busy,
  onClose,
  onSubmit,
}: {
  target: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (universityAppId: string) => void;
}) {
  const [value, setValue] = useState("");
  const label = (UniApplicationStatusLabel as Record<number, string | undefined>)[target] ?? "the offer";
  const id = value.trim();
  return (
    <Modal
      open
      title={`Move to ${label}`}
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
            disabled={busy || !id}
            onClick={() => onSubmit(id)}
            className="cursor-pointer rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#175CD3] disabled:opacity-50"
          >
            {busy ? "Saving…" : `Save and move to ${label}`}
          </button>
        </>
      }
    >
      <label className="block text-[13px] font-medium text-[#344054]">
        University Student ID <span className="text-[#D92D20]">*</span>
      </label>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && id && !busy) onSubmit(id);
        }}
        maxLength={100}
        placeholder="The ID the university gave this student or application"
        className="mt-1.5 h-10 w-full rounded-lg border border-[#D0D5DD] px-3 text-[14px] outline-none focus:border-[#1570EF]"
      />
      <p className="mt-2 text-[12px] text-[#667085]">
        Required for an offer. It is shown in Student Placements, University Billing and commission records.
      </p>
    </Modal>
  );
}
