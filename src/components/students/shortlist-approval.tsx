"use client";

import { useEffect, useState } from "react";
import { Modal } from "~/components/ui/modal";
import { ShortlistApproval } from "~/server/db/enums";

// University assignment approval UI, shared by the admin and partner student
// profiles (rules: src/server/shortlist-approval.ts). Each shortlist row is
// one side's proposal; the other side approves or rejects it, and Apply waits
// for approval.

export type Viewer = "admin" | "partner";

export interface ShortlistApprovalFields {
  addedBy: "collegepond" | "partner";
  addedByName: string;
  approvalStatus: number;
  proposalNote: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  rejectReason: string | null;
}

type Tone = "orange" | "purple" | "green" | "red" | "gray";

const TONE: Record<Tone, string> = {
  orange: "border-[#FEDF89] bg-[#FFFAEB] text-[#B54708]",
  purple: "border-[#D9D6FE] bg-[#F4F3FF] text-[#5925DC]",
  green: "border-[#ABEFC6] bg-[#ECFDF3] text-[#067647]",
  red: "border-[#FECDCA] bg-[#FEF3F2] text-[#B42318]",
  gray: "border-[#EAECF0] bg-[#F9FAFB] text-[#475467]",
};

export interface ShortlistView {
  label: string;
  tone: Tone;
  // This viewer approves/rejects it (the other side proposed it, pending).
  canDecide: boolean;
  // This viewer proposed it and it was rejected: they may send it back.
  canRepropose: boolean;
  approved: boolean;
  rejected: boolean;
}

export function shortlistView(s: ShortlistApprovalFields, viewer: Viewer): ShortlistView {
  const mine = (s.addedBy === "collegepond") === (viewer === "admin");
  const pending = s.approvalStatus === ShortlistApproval.PENDING;
  const approved = s.approvalStatus === ShortlistApproval.APPROVED;
  const rejected = s.approvalStatus === ShortlistApproval.REJECTED;
  const other = viewer === "admin" ? "partner" : "Collegepond";
  let label: string;
  let tone: Tone;
  if (pending) {
    label = mine ? `Awaiting ${other} approval` : `Proposed by ${other} · needs your approval`;
    tone = mine ? "orange" : "purple";
  } else if (approved) {
    // A row approved before the approval step existed has no decider.
    label = s.decidedAt ? (mine ? `Approved by ${other}` : "Approved by you") : "Approved";
    tone = "green";
  } else {
    label = mine ? `Rejected by ${other}` : "Rejected by you";
    tone = "red";
  }
  return {
    label,
    tone,
    canDecide: pending && !mine,
    canRepropose: rejected && mine,
    approved,
    rejected,
  };
}

export function ShortlistStatusBadge({ view }: { view: ShortlistView }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE[view.tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {view.label}
    </span>
  );
}

// Who proposed it, the re-proposal note and the rejection reason, as one or
// two short lines under the card's title.
export function ShortlistApprovalNotes({
  s,
  viewer,
}: {
  s: ShortlistApprovalFields;
  viewer: Viewer;
}) {
  const proposer =
    s.addedBy === "partner"
      ? viewer === "partner"
        ? `Proposed by ${s.addedByName}`
        : `Proposed by partner: ${s.addedByName}`
      : `Proposed by ${s.addedByName}`;
  return (
    <div className="mt-1 space-y-1 text-[12px] text-[#667085]">
      <div>
        {proposer}
        {s.decidedByName && s.approvalStatus !== ShortlistApproval.PENDING
          ? ` · ${s.approvalStatus === ShortlistApproval.APPROVED ? "approved" : "rejected"} by ${s.decidedByName}`
          : ""}
      </div>
      {s.proposalNote && s.approvalStatus === ShortlistApproval.PENDING && (
        <div className="rounded-md bg-[#F9FAFB] px-2 py-1 text-[#475467]">
          <span className="font-semibold">Note:</span> {s.proposalNote}
        </div>
      )}
      {s.rejectReason && s.approvalStatus === ShortlistApproval.REJECTED && (
        <div className="rounded-md bg-[#FEF3F2] px-2 py-1 text-[#B42318]">
          <span className="font-semibold">Reason:</span> {s.rejectReason}
        </div>
      )}
    </div>
  );
}

// Reject (reason required) or re-propose (note optional).
export function ShortlistTextDialog({
  open,
  mode,
  subject,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "reject" | "repropose";
  subject: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const reject = mode === "reject";
  const trimmed = text.trim();
  const valid = reject ? trimmed.length >= 3 : true;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={reject ? "Reject this university?" : "Re-propose this university?"}
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
            disabled={!valid || busy}
            onClick={() => onSubmit(trimmed)}
            className={`cursor-pointer rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${
              reject ? "bg-[#D92D20] hover:bg-[#B42318]" : "bg-[#1570EF] hover:bg-[#1260d4]"
            }`}
          >
            {busy ? "Saving…" : reject ? "Reject" : "Re-propose"}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-[#475467]">{subject}</p>
      <label className="block">
        <span className="mb-1 block text-[12px] font-semibold text-[#344054]">
          {reject ? "Reason (shown to the other side)" : "Note (optional)"}
        </span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 500))}
          rows={3}
          autoFocus
          placeholder={
            reject
              ? "e.g. Budget is too high for the family"
              : "e.g. Scholarship now confirmed for this intake"
          }
          className="w-full rounded-lg border border-[#D0D5DD] px-3 py-2 text-[13px] text-[#101828] outline-none focus:border-[#1570EF]"
        />
        <span className="mt-1 block text-right text-[11px] text-[#98A2B3]">{text.length}/500</span>
      </label>
    </Modal>
  );
}
