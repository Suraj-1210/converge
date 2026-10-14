"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { type AdminStudentFull } from "../lib";

// Edits a partner made on the partner portal that nobody here has reviewed
// yet. Marking them reviewed clears this banner and the admin-bell item.
export function PartnerEditsBanner({
  student,
  onToast,
}: {
  student: AdminStudentFull;
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(true);
  const review = api.students.markPartnerUpdatesReviewed.useMutation({
    onSuccess: () => {
      void utils.students.adminGet.invalidate({ id: student.id });
      void utils.students.adminList.invalidate();
      void utils.notifications.list.invalidate();
      onToast("Partner changes marked as reviewed");
    },
    onError: (e) => onToast(e.message),
  });

  const edits = student.partnerUpdates;
  if (edits.length === 0) return null;
  const people = [...new Set(edits.map((e) => (e.agency ? `${e.by} (${e.agency})` : e.by)))];

  return (
    <div className="mb-6 rounded-[14px] border border-[#FEDF89] bg-[#FFFCF5]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[#B54708]">
            Updated by {people.join(", ")} on the Partner Portal
          </div>
          <div className="text-[12px] text-[#93370D]">
            {edits.length} {edits.length === 1 ? "change" : "changes"} not yet reviewed
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="h-8 cursor-pointer rounded-lg border border-[#FEDF89] bg-white px-3 text-[12px] font-semibold text-[#B54708]"
          >
            {open ? "Hide changes" : "Show changes"}
          </button>
          <button
            type="button"
            disabled={review.isPending}
            onClick={() => review.mutate({ studentId: student.id })}
            className="h-8 cursor-pointer rounded-lg bg-[#DC6803] px-3 text-[12px] font-semibold text-white hover:bg-[#B54708] disabled:opacity-50"
          >
            {review.isPending ? "Saving…" : "Mark as reviewed"}
          </button>
        </div>
      </div>
      {open && (
        <ul className="divide-y divide-[#FEF0C7] border-t border-[#FEF0C7]">
          {edits.map((e) => (
            <li key={e.id} className="px-5 py-3">
              <div className="text-[12px] text-[#93370D]">
                <span className="font-semibold">{e.section}</span> · {e.by} ·{" "}
                {new Date(e.at).toLocaleString("en-IN", {
                  day: "numeric",
                  month: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
              <ul className="mt-1 space-y-0.5 text-[13px] text-[#344054]">
                {e.changes.map((c, i) => (
                  <li key={i} className="break-words">
                    {c}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
