"use client";

import { assigneeOf, type AssignableStudent, type Viewer } from "./assignee";

// "You", the counsellor's name, or an orange Unassigned badge.
export function AssigneeLabel({
  student,
  viewer,
}: {
  student: AssignableStudent;
  viewer: Viewer | null;
}) {
  if (!viewer) return <span className="text-[#98A2B3]">—</span>;
  const a = assigneeOf(student, viewer);
  if (a.kind === "unassigned") {
    return (
      <span className="inline-flex items-center rounded-full border border-[#FEDF89] bg-[#FFFAEB] px-2 py-0.5 text-[12px] font-semibold text-[#B54708]">
        Unassigned
      </span>
    );
  }
  if (a.kind === "you") return <span className="font-medium text-[#101828]">You</span>;
  return (
    <span className="block max-w-[150px] truncate text-[#344054]" title={a.name}>
      {a.name}
    </span>
  );
}
