"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { StudentStatusBadge } from "~/components/students/status";
import { Toast } from "~/components/ui/toast";
import { api } from "~/trpc/react";
import {
  avatarGradient,
  derivedProgram,
  derivedUniversity,
  displayId,
  studentInitials,
  studentName,
} from "../lib";
import { ApplicationTab } from "./application-tab";
import { ChatTab } from "./chat-tab";
import { DocumentsTab } from "./documents-tab";
import { PartnerEditsBanner } from "./partner-edits-banner";
import { ProfileTab } from "./profile-tab";
import { SummaryTab } from "./summary-tab";
import { TasksNotesTab } from "./tasks-notes-tab";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "application", label: "Application" },
  { id: "tasks", label: "Tasks & Notes" },
  { id: "documents", label: "Documents" },
  { id: "chat", label: "Chat" },
  { id: "summary", label: "Document Summary" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function StudentProfilePage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0;

  const studentQuery = api.students.adminGet.useQuery(
    { id },
    { enabled: validId },
  );
  const utils = api.useUtils();

  const [tab, setTab] = useState<TabId>("profile");
  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };

  const student = studentQuery.data;
  // First-paint fallback for the hero, so the View-Transition morph target
  // (name + avatar) exists on the very first navigation: adminGet isn't cached
  // yet, but the row we came from is in the adminList cache (same base shape).
  const hero =
    student ?? utils.students.adminList.getData()?.find((s) => s.id === id);

  return (
    <>
      <Link
        href="/admin/students"
        className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-[#667085] hover:text-[#1570EF]"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back to Students
      </Link>

      {!validId ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
          Invalid student id.
        </div>
      ) : studentQuery.error ? (
        <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
          {studentQuery.error.message}
        </div>
      ) : !hero ? (
        <div className="rounded-[14px] border border-[#E4E7EC] bg-white px-6 py-12 text-center text-sm text-[#98A2B3]">
          Loading…
        </div>
      ) : (
        <>
          {/* Hero */}
          <div className="mb-6 rounded-[14px] border border-[#E4E7EC] bg-white px-7 py-6">
            <div className="flex flex-wrap items-center gap-4">
              <div
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-xl font-semibold text-white"
                style={{
                  background: avatarGradient(hero.id),
                  viewTransitionName: `student-avatar-${hero.id}`,
                }}
              >
                {studentInitials(hero)}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2
                    className="text-[22px] font-bold text-[#101828]"
                    style={{ viewTransitionName: `student-name-${hero.id}` }}
                  >
                    {studentName(hero)}
                  </h2>
                  <span className="rounded-2xl bg-[#EFF8FF] px-2.5 py-0.5 text-xs font-semibold text-[#1570EF]">
                    {displayId(hero.id)}
                  </span>
                  <StudentStatusBadge status={hero.status} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-[#667085]">
                  <HeroMeta icon={<MailIcon />}>{hero.email ?? "—"}</HeroMeta>
                  <HeroMeta icon={<PhoneIcon />}>
                    {hero.phone ?? "—"}
                  </HeroMeta>
                  <HeroMeta icon={<CapIcon />}>
                    {derivedProgram(hero)} | {derivedUniversity(hero)}
                  </HeroMeta>
                </div>
              </div>
            </div>
          </div>

          {student && <PartnerEditsBanner student={student} onToast={showToast} />}

          {/* Main tabs */}
          <div className="mb-6 flex gap-1 overflow-x-auto border-b-2 border-[#E4E7EC]">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`-mb-[2px] cursor-pointer border-b-2 px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition ${
                    active
                      ? "border-[#1570EF] text-[#1570EF]"
                      : "border-transparent text-[#667085] hover:text-[#1570EF]"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {student ? (
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
              {tab === "profile" && (
                <ProfileTab student={student} onToast={showToast} />
              )}
              {tab === "application" && (
                <ApplicationTab student={student} onToast={showToast} />
              )}
              {tab === "tasks" && (
                <TasksNotesTab student={student} onToast={showToast} />
              )}
              {tab === "documents" && (
                <DocumentsTab student={student} onToast={showToast} />
              )}
              {tab === "chat" && (
                <ChatTab studentId={Number(student.id)} onToast={showToast} />
              )}
              {tab === "summary" && <SummaryTab student={student} />}
              </motion.div>
            </AnimatePresence>
          ) : (
            <div className="rounded-[14px] border border-[#E4E7EC] bg-white px-6 py-10 text-center text-sm text-[#98A2B3]">
              Loading details…
            </div>
          )}
        </>
      )}

      <Toast
        message={toastMsg}
        open={toastOpen}
        onClose={() => setToastOpen(false)}
      />
    </>
  );
}

function HeroMeta({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

function MailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className="h-3.5 w-3.5 shrink-0"
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
      stroke="#98A2B3"
      strokeWidth={2}
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function CapIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#98A2B3"
      strokeWidth={2}
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d="M22 10L12 5 2 10l10 5 10-5z" />
      <path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" />
    </svg>
  );
}
