"use client";

import Link from "next/link";
import { useState } from "react";

// Deferred applications, on both Students pages (Day 5 testing): a deferral
// keeps the application open for a later intake, and this list keeps it from
// getting lost until it enrols or closes. Hidden when there are none.

export interface DeferredRow {
  applicationId: number;
  studentId: number;
  studentName: string;
  university: string;
  program: string;
  stage: string;
  newIntake: string;
  fromIntake: string | null;
  deferredAt: string | null;
}

export function DeferredPanel({
  rows,
  hrefFor,
}: {
  rows: DeferredRow[] | undefined;
  hrefFor: (studentId: number) => string;
}) {
  const [open, setOpen] = useState(false);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="mb-5 rounded-xl border border-[#D9D6FE] bg-[#F5F3FF]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-[14px] font-semibold text-[#5925DC]">
          Deferred applications ({rows.length})
          <span className="ml-2 text-[12px] font-normal text-[#6E56CF]">
            open for a later intake: follow up before each intake starts
          </span>
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#5925DC"
          strokeWidth={2}
          className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-[#D9D6FE] bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
                <th className="px-4 py-2">Student</th>
                <th className="px-4 py-2">University / Program</th>
                <th className="px-4 py-2">Stage</th>
                <th className="px-4 py-2">New intake</th>
                <th className="px-4 py-2">Was</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.applicationId} className="border-t border-[#F2F4F7]">
                  <td className="px-4 py-2">
                    <Link href={hrefFor(r.studentId)} className="font-medium text-[#1570EF] hover:underline">
                      {r.studentName}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-[#344054]">
                    {r.university}
                    <div className="text-[12px] text-[#667085]">{r.program}</div>
                  </td>
                  <td className="px-4 py-2 text-[#344054]">{r.stage}</td>
                  <td className="px-4 py-2 font-semibold text-[#5925DC]">{r.newIntake}</td>
                  <td className="px-4 py-2 text-[#667085]">{r.fromIntake ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
