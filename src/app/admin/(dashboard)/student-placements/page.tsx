"use client";

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { UniApplicationStatus } from "~/server/db/enums";
import { formatDate, countryName } from "~/components/dashboard/format";
import { Icon, type IconName, SkeletonTable } from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";

type Placement = RouterOutputs["placements"]["list"][number];
type AttKey = "pending" | "attended";

const ATT_LABEL: Record<AttKey, string> = { pending: "Pending", attended: "Enrolled" };
const attBadge = (att: AttKey) =>
  att === "attended" ? "bg-[#EFF8FF] text-[#175CD3]" : "bg-[#FFF6ED] text-[#B93815]";

// Mock-style stat card: colored icon box, big number, label.
function StatCard({
  icon,
  bg,
  fg,
  value,
  label,
}: {
  icon: IconName;
  bg: string;
  fg: string;
  value: number;
  label: string;
}) {
  return (
    <div className="rounded-xl border border-[#E4E7EC] bg-white p-5">
      <div
        className="mb-3.5 flex h-11 w-11 items-center justify-center rounded-[10px]"
        style={{ background: bg, color: fg }}
      >
        <Icon name={icon} size={22} />
      </div>
      <div className="text-[28px] leading-none font-extrabold text-[#101828]">{value}</div>
      <div className="mt-1.5 text-[13px] font-medium text-[#667085]">{label}</div>
    </div>
  );
}

const filterSelectCls =
  "h-[38px] rounded-lg border border-[#D0D5DD] bg-white px-2.5 text-[13px] font-medium text-[#344054] outline-none hover:border-[#1570EF] focus:border-[#1570EF]";

export default function StudentPlacementsPage() {
  const { data, isLoading } = api.placements.list.useQuery();
  const utils = api.useUtils();
  const saveId = api.students.setApplicationUniId.useMutation();
  const setStatus = api.students.setApplicationStatus.useMutation();

  const [fVendor, setFVendor] = useState("");
  const [fUniversity, setFUniversity] = useState("");
  const [fStatus, setFStatus] = useState<"" | AttKey>("");
  const [openVendors, setOpenVendors] = useState<Record<string, boolean>>({});
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const [modal, setModal] = useState<{ app: Placement; newStatus: AttKey } | null>(null);
  const [modalUniId, setModalUniId] = useState("");
  const [modalError, setModalError] = useState("");
  const [saving, setSaving] = useState(false);

  const rows = data ?? [];
  const att = (p: Placement): AttKey => (p.enrolled ? "attended" : "pending");

  // KPIs (full queue, not filtered).
  const total = rows.length;
  const attended = rows.filter((p) => p.enrolled).length;
  const pending = total - attended;
  const idsEntered = rows.filter((p) => !!p.enrollmentId?.trim()).length;

  const vendorOptions = [
    ...new Set(
      rows.map((r) => r.vendor).filter((v): v is string => v !== null && v !== ""),
    ),
  ].sort();
  const uniOptions = [...new Set(rows.map((r) => r.university))].sort();

  const filtered = rows.filter((p) => {
    if (fVendor !== "" && (p.vendor ?? "") !== fVendor) return false;
    if (fUniversity !== "" && p.university !== fUniversity) return false;
    if (fStatus !== "" && att(p) !== fStatus) return false;
    return true;
  });

  // Group by vendor → university (mock's vendorGroups[vendor].unis[uni]).
  const groupMap = new Map<
    string,
    { name: string; direct: boolean; unis: Map<string, Placement[]> }
  >();
  for (const p of filtered) {
    const name = p.vendor ?? "No vendor set";
    let g = groupMap.get(name);
    if (!g) {
      g = { name, direct: name.toLowerCase() === "direct", unis: new Map() };
      groupMap.set(name, g);
    }
    const arr = g.unis.get(p.university) ?? [];
    arr.push(p);
    g.unis.set(p.university, arr);
  }
  const groups = [...groupMap.values()].sort((a, b) => {
    if (a.direct !== b.direct) return a.direct ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const hasFilters = fVendor !== "" || fUniversity !== "" || fStatus !== "";

  function openStatusModal(app: Placement, newStatus: AttKey) {
    setOpenDropdown(null);
    setModal({ app, newStatus });
    setModalUniId(app.enrollmentId ?? "");
    setModalError("");
  }

  async function confirmStatusChange() {
    if (!modal) return;
    const id = modalUniId.trim();
    if (id === "") {
      setModalError("Please enter the University Student ID to confirm.");
      return;
    }
    setSaving(true);
    try {
      await saveId.mutateAsync({ applicationId: modal.app.id, universityAppId: id });
      await setStatus.mutateAsync({
        applicationId: modal.app.id,
        status:
          modal.newStatus === "attended"
            ? UniApplicationStatus.ENROLLED
            : UniApplicationStatus.VISA_SECURED,
      });
      await utils.placements.list.invalidate();
      setModal(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Student Placements</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Confirm enrollment and enter university student IDs
        </p>
      </div>

      {/* Stat cards */}
      <Stagger className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <FadeUp className="h-full">
          <StatCard icon="students" bg="#EFF8FF" fg="#1570EF" value={total} label="Total Students" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="check" bg="#EFF8FF" fg="#175CD3" value={attended} label="Enrolled" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="clock" bg="#FFF6ED" fg="#B93815" value={pending} label="Pending" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="calendar" bg="#F0FDF4" fg="#15803D" value={idsEntered} label="IDs Entered" />
        </FadeUp>
      </Stagger>

      {/* Filter bar */}
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <select className={filterSelectCls} value={fVendor} onChange={(e) => setFVendor(e.target.value)}>
          <option value="">All Vendors</option>
          {vendorOptions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          className={filterSelectCls}
          value={fUniversity}
          onChange={(e) => setFUniversity(e.target.value)}
        >
          <option value="">All Universities</option>
          {uniOptions.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          className={filterSelectCls}
          value={fStatus}
          onChange={(e) => setFStatus(e.target.value as "" | AttKey)}
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="attended">Enrolled</option>
        </select>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setFVendor("");
              setFUniversity("");
              setFStatus("");
            }}
            className="h-[38px] rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-[13px] font-medium text-[#667085] hover:bg-[#F9FAFB]"
          >
            Reset
          </button>
        )}
      </div>

      {/* Section header */}
      <div className="mb-4 flex items-center gap-2 text-base font-bold text-[#101828]">
        Student Placements — Visa Approved
        <span className="rounded-[10px] bg-[#EFF8FF] px-2 py-0.5 text-[11px] font-bold text-[#175CD3]">
          {filtered.length} student{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
          <SkeletonTable rows={6} cols={7} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-[#D0D5DD] bg-[#F9FAFB] p-6 text-center">
          <h4 className="mb-1 font-semibold text-[#344054]">No students found</h4>
          <p className="text-[13px] text-[#667085]">
            Students will appear here once their visa status is marked as secured in
            Active Applications.
          </p>
        </div>
      ) : (
        groups.map((g, gi) => {
          const uniKeys = [...g.unis.keys()].sort();
          const groupTotal = [...g.unis.values()].reduce((n, a) => n + a.length, 0);
          const isOpen = openVendors[g.name] ?? gi === 0;
          return (
            <div
              key={g.name}
              className="mb-3 overflow-visible rounded-xl border border-[#E4E7EC] bg-white"
            >
              {/* Accordion header */}
              <div
                onClick={() =>
                  setOpenVendors((s) => ({ ...s, [g.name]: !(s[g.name] ?? gi === 0) }))
                }
                className="flex cursor-pointer items-center justify-between rounded-xl px-5 py-3.5 select-none hover:bg-[#F9FAFB]"
              >
                <div className="flex items-center gap-3">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-[#101828]">
                    {g.direct ? "🏢" : "🤝"} {g.name}
                  </h3>
                  <span
                    className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${
                      g.direct ? "bg-[#EFF8FF] text-[#175CD3]" : "bg-[#F0FDF4] text-[#067647]"
                    }`}
                  >
                    {g.direct ? "Direct Contract" : "Third-Party Vendor"}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-[#667085]">
                    {uniKeys.length} universit{uniKeys.length === 1 ? "y" : "ies"} ·{" "}
                    {groupTotal} student{groupTotal === 1 ? "" : "s"}
                  </span>
                  <Icon
                    name="chevron-down"
                    size={18}
                    className={`text-[#667085] transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </div>
              </div>

              {/* Accordion body */}
              {isOpen && (
                <div className="px-5 pb-4">
                  {uniKeys.map((uKey) => {
                    const students = g.unis.get(uKey)!;
                    const country = countryName(students[0]?.country ?? "");
                    return (
                      <div key={uKey} className="mb-3.5 last:mb-0">
                        <div className="mb-2 flex items-center gap-1.5 border-b border-[#F2F4F7] py-2 text-[13px] font-bold text-[#344054]">
                          {uKey}
                          {country && <span className="font-normal text-[#667085]">· {country}</span>}
                          <span className="ml-1 text-[11px] font-normal text-[#98A2B3]">
                            {students.length} student{students.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="bg-[#F9FAFB] text-left text-[11px] font-semibold tracking-[0.3px] text-[#667085] uppercase">
                              <th className="border-b border-[#E4E7EC] px-2.5 py-1.5">Student</th>
                              <th className="border-b border-[#E4E7EC] px-2.5 py-1.5">Student ID</th>
                              <th className="border-b border-[#E4E7EC] px-2.5 py-1.5">Program</th>
                              <th className="border-b border-[#E4E7EC] px-2.5 py-1.5">Intake</th>
                              <th className="border-b border-[#E4E7EC] px-2.5 py-1.5">Visa Approved</th>
                              <th className="border-b border-[#E4E7EC] px-2.5 py-1.5">Status</th>
                              <th className="border-b border-[#E4E7EC] px-2.5 py-1.5">
                                University Student ID
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {students.map((s) => {
                              const a = att(s);
                              return (
                                <tr key={s.id} className="border-b border-[#F2F4F7] last:border-0">
                                  <td className="px-2.5 py-2 font-semibold text-[#101828]">
                                    {s.studentName}
                                  </td>
                                  <td className="px-2.5 py-2 text-[11px] text-[#667085]">
                                    CP-{s.studentId}
                                  </td>
                                  <td className="px-2.5 py-2 text-[#344054]">{s.program}</td>
                                  <td className="px-2.5 py-2 text-[#344054]">{s.intake ?? "—"}</td>
                                  <td className="px-2.5 py-2 text-[#344054]">
                                    {s.visaDate ? formatDate(s.visaDate) : "—"}
                                  </td>
                                  <td className="relative px-2.5 py-2">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setOpenDropdown(openDropdown === s.id ? null : s.id)
                                      }
                                      className={`inline-flex items-center gap-1 rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${attBadge(a)} cursor-pointer transition-all hover:-translate-y-px hover:shadow`}
                                    >
                                      {ATT_LABEL[a]}
                                      <Icon name="chevron-down" size={10} />
                                    </button>
                                    {openDropdown === s.id && (
                                      <div className="absolute top-full left-0 z-[200] mt-1 min-w-[180px] rounded-[10px] border border-[#E4E7EC] bg-white p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
                                        {(["pending", "attended"] as AttKey[]).map((opt) => (
                                          <button
                                            key={opt}
                                            type="button"
                                            onClick={() => openStatusModal(s, opt)}
                                            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] hover:bg-[#F0F7FF] hover:text-[#1570EF] ${
                                              opt === a
                                                ? "bg-[#F0F7FF] font-semibold text-[#1570EF]"
                                                : "text-[#344054]"
                                            }`}
                                          >
                                            <span className="flex w-3.5 justify-center">
                                              {opt === a ? <Icon name="check" size={14} /> : null}
                                            </span>
                                            {ATT_LABEL[opt]}
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-2.5 py-2">
                                    {s.enrollmentId?.trim() ? (
                                      <span className="text-[11px] font-semibold text-[#101828]">
                                        {s.enrollmentId}
                                      </span>
                                    ) : (
                                      <span className="text-[11px] text-[#667085] italic">
                                        Not entered
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Outside-click backdrop for the attendance dropdown */}
      {openDropdown !== null && (
        <div className="fixed inset-0 z-[150]" onClick={() => setOpenDropdown(null)} />
      )}

      {/* Confirm Status Change modal */}
      {modal && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-[rgba(16,24,40,0.55)] p-4">
          <div className="w-[480px] max-w-full rounded-xl bg-white shadow-[0_20px_60px_rgba(0,0,0,0.2)]">
            <div className="flex items-center justify-between border-b border-[#E4E7EC] px-6 py-5">
              <h3 className="text-base font-bold text-[#101828]">Confirm Status Change</h3>
              <button
                type="button"
                onClick={() => setModal(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E4E7EC] bg-white text-[#667085] hover:bg-[#F9FAFB]"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="px-6 py-5">
              <div className="mb-[18px] rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] px-4 py-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold tracking-[0.5px] text-[#667085] uppercase">
                    Student
                  </span>
                  <span className="text-[13px] font-bold text-[#101828]">
                    {modal.app.studentName}
                  </span>
                </div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold tracking-[0.5px] text-[#667085] uppercase">
                    Collegepond ID
                  </span>
                  <span className="text-[13px] text-[#667085]">CP-{modal.app.studentId}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold tracking-[0.5px] text-[#667085] uppercase">
                    New Status
                  </span>
                  <span
                    className={`inline-block rounded-[10px] px-2.5 py-0.5 text-[11px] font-semibold ${attBadge(modal.newStatus)}`}
                  >
                    {ATT_LABEL[modal.newStatus]}
                  </span>
                </div>
              </div>
              <label className="mb-1.5 block text-[13px] font-semibold text-[#344054]">
                Enter University Student ID
              </label>
              <p className="mt-[-2px] mb-2.5 text-[11px] text-[#98A2B3]">
                This is the student ID assigned by the university, not the Collegepond ID
              </p>
              <input
                type="text"
                autoFocus
                value={modalUniId}
                onChange={(e) => setModalUniId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void confirmStatusChange();
                }}
                placeholder="e.g. 2026-MAN-00451"
                className="w-full rounded-lg border border-[#D0D5DD] px-3 py-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF] focus:ring-2 focus:ring-[#1570EF]/20"
              />
              {modalError !== "" && (
                <p className="mt-1.5 text-[11px] text-[#F04438]">{modalError}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#E4E7EC] px-6 py-4">
              <button
                type="button"
                onClick={() => setModal(null)}
                className="rounded-lg border border-[#D0D5DD] bg-white px-[18px] py-2.5 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void confirmStatusChange()}
                className="rounded-lg bg-[#1570EF] px-[18px] py-2.5 text-[13px] font-semibold text-white hover:bg-[#1260d4] disabled:opacity-50"
              >
                {saving ? "Saving…" : "Confirm Change"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
