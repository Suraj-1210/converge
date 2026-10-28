"use client";

import Link from "next/link";
import { Link as VTLink } from "next-view-transitions";
import { useEffect, type ReactNode } from "react";
import { StudentStatusBadge } from "~/components/students/status";
import {
  avatarGradient,
  countryName,
  derivedProgram,
  derivedUniversity,
  displayId,
  levelShort,
  studentInitials,
  studentName,
  uniAppBadge,
  type AdminStudent,
  type CpCounsellor,
} from "./lib";
import { counsellorName } from "./modals";

export function StudentSlideOver({
  student,
  counsellors,
  onClose,
  onReassign,
  assigning,
}: {
  student: AdminStudent;
  counsellors: CpCounsellor[];
  onClose: () => void;
  onReassign: (cpCounsellorId: number) => void;
  assigning: boolean;
}) {
  // Close on Escape (modals handle their own; this matches them).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[200]">
      <div
        className="absolute inset-0 bg-[rgba(16,24,40,0.45)]"
        onClick={onClose}
      />
      <aside className="absolute top-0 right-0 flex h-full w-[500px] max-w-[calc(100vw-32px)] flex-col bg-white shadow-[-12px_0_40px_rgba(0,0,0,0.18)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#E4E7EC] px-6 py-5">
          <div className="flex items-center gap-3.5">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
              style={{
                background: avatarGradient(student.id),
                viewTransitionName: "student-morph",
              }}
            >
              {studentInitials(student)}
            </div>
            <div>
              <div className="text-base font-bold text-[#101828]">
                {studentName(student)}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StudentStatusBadge status={student.status} />
                <span className="text-xs text-[#98A2B3]">
                  {displayId(student.id)}
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[#E4E7EC] bg-white hover:bg-[#F9FAFB]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#667085"
              strokeWidth={2}
              className="h-4 w-4"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Contact */}
          <div className="space-y-2.5">
            <ContactRow icon={<MailIcon />} value={student.email ?? "—"} />
            <ContactRow icon={<PhoneIcon />} value={student.phone ?? "—"} />
            <ContactRow icon={<BuildingIcon />} value={student.partnerLabel} />
          </div>

          {/* Academic Details */}
          <SectionTitle>Academic Details</SectionTitle>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 rounded-lg bg-[#F9FAFB] p-4">
            <DetailItem label="University" value={derivedUniversity(student)} />
            <DetailItem label="Program" value={derivedProgram(student)} />
            <DetailItem label="Level" value={levelShort(student.courseLevel)} />
            <DetailItem label="Intake" value={student.intake ?? "—"} />
            <DetailItem label="Country" value={countryName(student.country)} />
            <DetailItem label="Student ID" value={displayId(student.id)} />
          </div>

          {/* Universities Applied */}
          <SectionTitle>
            Universities Applied ({student.applications.length})
          </SectionTitle>
          {student.applications.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#D0D5DD] px-4 py-5 text-center text-[13px] text-[#98A2B3]">
              No applications found.
            </div>
          ) : (
            <div className="space-y-2">
              {student.applications.map((app) => {
                const badge = uniAppBadge(app.status);
                return (
                  <div
                    key={app.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[#E4E7EC] px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#101828]">
                        {app.university}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-[#667085]">
                        {app.program}
                      </div>
                    </div>
                    <span
                      className="shrink-0 rounded-2xl px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap"
                      style={{ color: badge.color, background: badge.bg }}
                    >
                      {badge.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Assigned Team */}
          <SectionTitle>Assigned Team</SectionTitle>
          <div className="space-y-3 rounded-lg border border-[#E4E7EC] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
                  CP Counselor
                </div>
                <div className="mt-0.5 text-sm text-[#344054]">
                  {student.cpAutoAssigned
                    ? `Auto-assigned to ${student.cpCounsellorName ?? "a counsellor"}`
                    : (student.cpCounsellorName ?? "Unassigned")}
                </div>
              </div>
              <select
                value={String(student.cpCounsellorId ?? "")}
                onChange={(e) => {
                  if (e.target.value) onReassign(Number(e.target.value));
                }}
                disabled={assigning}
                className="h-[32px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-2 text-xs text-[#344054] outline-none hover:border-[#1570EF] focus:border-[#1570EF] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="" disabled>
                  Reassign…
                </option>
                {counsellors.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {counsellorName(c)}
                  </option>
                ))}
              </select>
            </div>
            <div className="border-t border-[#F2F4F7] pt-3">
              <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
                BDM
              </div>
              <div className="mt-0.5 text-sm text-[#344054]">
                {student.bdmName ?? "—"}
              </div>
            </div>
            <div className="border-t border-[#F2F4F7] pt-3">
              <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
                Partner Counsellor
              </div>
              <div className="mt-0.5 text-sm text-[#344054]">
                {student.counsellorName ?? "—"}
              </div>
            </div>
          </div>

          <VTLink
            href={`/admin/students/${student.id}`}
            className="mt-5 flex items-center justify-center gap-1.5 rounded-lg bg-[#1570EF] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1260d4]"
          >
            View Full Profile →
          </VTLink>
          <Link
            href={`/admin/uni-assist?student=${student.id}`}
            className="mt-2.5 flex items-center justify-center gap-1.5 rounded-lg border border-[#1570EF] bg-white px-4 py-2.5 text-sm font-semibold text-[#1570EF] hover:bg-[#F0F7FF]"
          >
            Shortlist in Uni Assist →
          </Link>
        </div>
      </aside>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 mb-3 border-b border-[#F2F4F7] pb-1.5 text-[11px] font-bold tracking-wider text-[#667085] uppercase">
      {children}
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
        {label}
      </div>
      <div className="mt-0.5 text-sm break-words text-[#344054]">{value}</div>
    </div>
  );
}

function ContactRow({ icon, value }: { icon: ReactNode; value: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-[#344054]">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#F2F4F7]">
        {icon}
      </span>
      <span className="break-all">{value}</span>
    </div>
  );
}

function MailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#667085"
      strokeWidth={2}
      className="h-3.5 w-3.5"
    >
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#667085"
      strokeWidth={2}
      className="h-3.5 w-3.5"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#667085"
      strokeWidth={2}
      className="h-3.5 w-3.5"
    >
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <line x1="9" y1="22" x2="9" y2="18" />
      <line x1="15" y1="22" x2="15" y2="18" />
      <line x1="8" y1="6" x2="10" y2="6" />
      <line x1="14" y1="6" x2="16" y2="6" />
      <line x1="8" y1="10" x2="10" y2="10" />
      <line x1="14" y1="10" x2="16" y2="10" />
      <line x1="8" y1="14" x2="10" y2="14" />
      <line x1="14" y1="14" x2="16" y2="14" />
    </svg>
  );
}
