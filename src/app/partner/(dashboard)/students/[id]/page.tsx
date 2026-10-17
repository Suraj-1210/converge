"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { StudentStatusBadge } from "~/components/students/status";
import { Toast } from "~/components/ui/toast";
import { api } from "~/trpc/react";
// The profile forms are shared with the admin student profile; the provider
// below points their saves at the partner procedures.
import {
  avatarGradient,
  derivedProgram,
  derivedUniversity,
  displayId,
  studentInitials,
  studentName,
} from "~/app/admin/(dashboard)/students/lib";
import { ProfileTab } from "~/app/admin/(dashboard)/students/[id]/profile-tab";
import {
  StudentProfileApiProvider,
  type StudentProfileApi,
} from "~/app/admin/(dashboard)/students/[id]/profile-api";
import { AssignModal } from "../assign-modal";
import { type Viewer } from "../assignee";
import { AssigneeLabel } from "../assignee-label";
import { DocumentsChecklist, expectedProgress } from "../upload-documents-modal";
import { ApplicationsTab } from "./applications-tab";
import { PartnerChatPanel } from "~/components/partner-chat/chat-panel";
import { LeadPipelineBar } from "~/components/students/lead-pipeline-bar";

function usePartnerRefresh() {
  const utils = api.useUtils();
  return (id: number) => {
    void utils.students.partnerGet.invalidate({ id });
    void utils.students.partnerList.invalidate();
    void utils.students.partnerDocuments.invalidate({ studentId: id });
  };
}

const PARTNER_PROFILE_API: StudentProfileApi = {
  useUpdateProfile: api.students.partnerUpdate.useMutation,
  useSaveEducation: api.students.partnerSaveEducation.useMutation,
  useSaveWork: api.students.partnerSaveWorkExperience.useMutation,
  useSaveTests: api.students.partnerSaveTestScores.useMutation,
  useRefresh: usePartnerRefresh,
  uploadUrl: "/api/partner/student-doc",
  canDeleteDocuments: false,
};

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "documents", label: "Documents" },
  { id: "applications", label: "Applications" },
  { id: "chat", label: "Chat" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function PartnerStudentProfilePage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0;
  const router = useRouter();

  const me = api.auth.me.useQuery(undefined, { retry: false });
  // Bounce away if approval state shifted (mirrors /partner/students).
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/partner/dashboard") router.replace(target);
  }, [me.data?.redirectUrl, router]);

  const isOwner = me.data?.kind === "agency";
  const assignees = api.students.partnerAssignees.useQuery(undefined, {
    enabled: isOwner,
    retry: false,
  });
  const studentQ = api.students.partnerGet.useQuery(
    { id },
    { enabled: validId, retry: false },
  );
  const docs = api.students.partnerDocuments.useQuery(
    { studentId: id },
    { enabled: validId && !!studentQ.data },
  );
  const progress = expectedProgress(docs.data);

  const meId = me.data?.id;
  const meKind = me.data?.kind;
  const hasCounsellors = (assignees.data?.counsellors.length ?? 0) > 0;
  const viewer = useMemo<Viewer | null>(
    () => (meId !== undefined && meKind ? { id: meId, kind: meKind, hasCounsellors } : null),
    [meId, meKind, hasCounsellors],
  );

  const [tab, setTab] = useState<TabId>("profile");
  // Deep link, e.g. /partner/students/12?tab=documents.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && TABS.some((x) => x.id === t)) setTab(t as TabId);
  }, []);
  const [assignOpen, setAssignOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };

  const s = studentQ.data;
  const inAgency = s?.orgId !== null && viewer?.kind !== "independent";

  return (
    <StudentProfileApiProvider value={PARTNER_PROFILE_API}>
      <Link
        href="/partner/students"
        className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-[#667085] hover:text-[#1570EF]"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back to Students
      </Link>

      {!validId ? (
        <Notice tone="error">This link doesn&apos;t point to a student.</Notice>
      ) : studentQ.error ? (
        <Notice tone="error">
          {studentQ.error.data?.code === "NOT_FOUND"
            ? "Student not found, or not one of your students."
            : studentQ.error.message}
        </Notice>
      ) : !s ? (
        <Notice>Loading…</Notice>
      ) : (
        <>
          {/* Hero */}
          <div className="mb-6 flex flex-wrap items-stretch gap-4 rounded-[14px] border border-[#E4E7EC] bg-white px-7 py-6">
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <div
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-xl font-semibold text-white"
                style={{ background: avatarGradient(s.id) }}
              >
                {studentInitials(s)}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-[22px] font-bold text-[#101828]">{studentName(s)}</h1>
                  <span className="rounded-2xl bg-[#EFF8FF] px-2.5 py-0.5 text-xs font-semibold text-[#1570EF]">
                    {displayId(s.id)}
                  </span>
                  <StudentStatusBadge status={s.status} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-[#667085]">
                  <span className="truncate">{s.email ?? "—"}</span>
                  <span>{s.phone ?? "—"}</span>
                  <span className="truncate">
                    {derivedProgram(s)} | {derivedUniversity(s)}
                  </span>
                </div>
              </div>
            </div>

            {/* The two actions from the Students list, up front. */}
            <div className="flex min-w-[260px] flex-col divide-y divide-[#F2F4F7] rounded-xl border border-[#E4E7EC]">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div>
                  <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">Documents</div>
                  <div className="text-sm text-[#344054]">
                    {docs.isLoading ? (
                      "…"
                    ) : (
                      <>
                        <span className="font-semibold text-[#101828]">
                          {progress.done} of {progress.total}
                        </span>
                        {progress.done < progress.total && (
                          <span className="text-[#B54708]"> · {progress.total - progress.done} missing</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setTab("documents")}
                  className="h-8 cursor-pointer rounded-lg bg-[#1570EF] px-3 text-[12px] font-semibold text-white hover:bg-[#1260d4]"
                >
                  Upload documents
                </button>
              </div>
              {inAgency && (
                <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">Counsellor</div>
                    <div className="text-sm">
                      <AssigneeLabel student={s} viewer={viewer} />
                    </div>
                  </div>
                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => setAssignOpen(true)}
                      className="h-8 cursor-pointer rounded-lg border border-[#B2CCFF] bg-[#F5F9FF] px-3 text-[12px] font-semibold text-[#175CD3] hover:bg-[#EFF4FF]"
                    >
                      Assign
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Student Added → … → Application Started; then the application tracks. */}
          <LeadPipelineBar student={s} />

          {/* Tabs */}
          <div className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b-2 border-[#E4E7EC]" role="tablist">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.id)}
                  className={`-mb-[2px] cursor-pointer border-b-2 px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition ${
                    active ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#1570EF]"
                  }`}
                >
                  {t.label}
                  {t.id === "documents" && !docs.isLoading && progress.done < progress.total && (
                    <span className="ml-1.5 rounded-full bg-[#FEF0C7] px-1.5 py-0.5 text-[11px] text-[#B54708]">
                      {progress.total - progress.done}
                    </span>
                  )}
                  {t.id === "applications" && s.applicationCards.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-[#F2F4F7] px-1.5 py-0.5 text-[11px] text-[#475467]">
                      {s.applicationCards.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {tab === "profile" && (
            <>
              <p className="mb-4 rounded-lg bg-[#F5F9FF] px-4 py-2.5 text-[13px] text-[#175CD3]">
                You can update this profile at any time, including after applications are submitted.
                Collegepond&apos;s counselling team is told about every change you save.
              </p>
              <ProfileTab student={s} onToast={showToast} />
            </>
          )}
          {tab === "documents" && (
            <div className="rounded-[14px] border border-[#E4E7EC] bg-white p-6">
              <DocumentsChecklist student={s} onUploaded={showToast} />
            </div>
          )}
          {tab === "applications" && (
            <ApplicationsTab
              student={s}
              viewerKind={viewer?.kind}
              onChanged={() => {
                void studentQ.refetch();
                void docs.refetch();
              }}
              onToast={showToast}
            />
          )}
          {tab === "chat" && <PartnerChatPanel side="partner" studentId={Number(s.id)} onToast={showToast} />}

          {assignOpen && viewer && (
            <AssignModal
              students={[s]}
              ownerId={viewer.id}
              onClose={() => setAssignOpen(false)}
              onDone={(msg) => {
                setAssignOpen(false);
                void studentQ.refetch();
                showToast(msg);
              }}
            />
          )}
        </>
      )}

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </StudentProfileApiProvider>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={
        tone === "error"
          ? "rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4 text-sm text-[#B42318]"
          : "rounded-[14px] border border-[#E4E7EC] bg-white px-6 py-12 text-center text-sm text-[#98A2B3]"
      }
    >
      {children}
    </div>
  );
}
