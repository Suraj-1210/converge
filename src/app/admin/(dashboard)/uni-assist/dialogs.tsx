"use client";

import { useExportLog } from "~/lib/export-log";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Modal } from "~/components/ui/modal";
import { type InrRates } from "~/lib/fx-convert";
import {
  COUNTRIES,
  INTAKE_MONTHS,
  MAX_DOWNLOAD_PROGRAMS,
  downloadFields,
  templateToFilters,
  type Program,
  type SearchTemplate,
} from "./uni-assist-lib";

// ----- Download dialog ------------------------------------------------------

type DownloadFormat = "csv" | "excel";

// Downloads a student's shortlist: the caller passes only that student's
// shortlisted programs, and at most MAX_DOWNLOAD_PROGRAMS go in one sheet.
// Shared with the partner Uni Assist (side = "partner" for the audit log).
export function DownloadDialog({
  open,
  onClose,
  programs,
  studentName,
  displayCurrency,
  rates,
  side = "admin",
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  programs: Program[];
  studentName: string;
  displayCurrency: string;
  rates: InrRates;
  side?: "admin" | "partner";
  onDone: (message: string) => void;
}) {
  const fieldsAll = downloadFields(displayCurrency, rates);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(fieldsAll.map((f) => f.key)),
  );
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [format, setFormat] = useState<DownloadFormat>("csv");
  const logExport = useExportLog(side);

  // Fresh pick each time it opens: the first ten shortlisted programs.
  const programKey = programs.map((p) => p.id).join(",");
  useEffect(() => {
    if (open) {
      setPicked(new Set(programs.slice(0, MAX_DOWNLOAD_PROGRAMS).map((p) => p.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, programKey]);

  const allSelected = selected.size === fieldsAll.length;
  const overLimit = programs.length > MAX_DOWNLOAD_PROGRAMS;

  const toggleField = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(
      allSelected ? new Set() : new Set(fieldsAll.map((f) => f.key)),
    );
  };

  const toggleProgram = (id: number) => {
    if (!picked.has(id) && picked.size >= MAX_DOWNLOAD_PROGRAMS) {
      onDone(`At most ${MAX_DOWNLOAD_PROGRAMS} programs per sheet`);
      return;
    }
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const execute = async () => {
    if (selected.size === 0) {
      onDone("Please select at least one field");
      return;
    }
    const chosen = programs.filter((p) => picked.has(p.id)).slice(0, MAX_DOWNLOAD_PROGRAMS);
    if (chosen.length === 0) {
      onDone("Please select at least one program");
      return;
    }
    const fields = fieldsAll.filter((f) => selected.has(f.key));
    const header = fields.map((f) => f.label);
    const rows = chosen.map((p) => fields.map((f) => f.value(p)));
    const slug = studentName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "student";
    const fileBase = `uni-assist-shortlist-${slug}`;

    if (format === "excel") {
      // xlsx is already a dependency (bulk import uses it server-side).
      // Dynamic import keeps it out of the page bundle until needed.
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
      ws["!cols"] = header.map((h) => ({ wch: h.length > 12 ? 22 : 15 }));
      const wb = XLSX.utils.book_new();
      // Sheet names: max 31 chars, no []:*?/\
      XLSX.utils.book_append_sheet(
        wb,
        ws,
        studentName.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Shortlist",
      );
      XLSX.writeFile(wb, `${fileBase}.xlsx`);
      logExport(`Uni Assist shortlist XLSX (${studentName})`, rows.length);
    } else {
      const escape = (v: string) =>
        /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      const csv = [header, ...rows]
        .map((r) => r.map(escape).join(","))
        .join("\n");
      // BOM so Excel opens UTF-8 correctly (€, ₹ symbols).
      const blob = new Blob(["﻿" + csv], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileBase}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      logExport(`Uni Assist shortlist CSV (${studentName})`, rows.length);
    }
    onClose();
    onDone(
      `Downloaded ${chosen.length} shortlisted program${chosen.length === 1 ? "" : "s"} for ${studentName} as ${format === "excel" ? "Excel" : "CSV"}`,
    );
  };

  return (
    <Modal
      open={open}
      title={`Download Shortlist · ${studentName}`}
      onClose={onClose}
      width="w-[520px]"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-5 py-2.5 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
          >
            Cancel
          </button>
          <Button onClick={execute} className="!h-[42px] !px-5">
            Download
          </Button>
        </div>
      }
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-[#101828]">
          Programs ({picked.size}/{Math.min(programs.length, MAX_DOWNLOAD_PROGRAMS)})
        </span>
        {overLimit && (
          <span className="text-xs text-[#B54708]">
            {programs.length} shortlisted · up to {MAX_DOWNLOAD_PROGRAMS} per sheet
          </span>
        )}
      </div>
      <div className="mb-5 flex max-h-[200px] flex-col gap-1.5 overflow-y-auto">
        {programs.map((p) => {
          const on = picked.has(p.id);
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => toggleProgram(p.id)}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[13px] transition-colors ${
                on
                  ? "border-[#1570EF] bg-[#F0F7FF] text-[#1570EF]"
                  : "border-[#E4E7EC] text-[#344054] hover:border-[#1570EF]"
              }`}
            >
              <Checkbox checked={on} />
              <span className="min-w-0 flex-1 truncate">
                {p.name}
                <span className="text-[#98A2B3]"> · {p.university?.name ?? ""}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-[#101828]">
          Select Fields
        </span>
        <button
          type="button"
          onClick={toggleAll}
          className="cursor-pointer text-xs font-medium text-[#1570EF] hover:underline"
        >
          {allSelected ? "Clear All" : "Select All"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {fieldsAll.map((f) => {
          const isSelected = selected.has(f.key);
          return (
            <button
              type="button"
              key={f.key}
              onClick={() => toggleField(f.key)}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[13px] transition-colors ${
                isSelected
                  ? "border-[#1570EF] bg-[#F0F7FF] text-[#1570EF]"
                  : "border-[#E4E7EC] text-[#344054] hover:border-[#1570EF] hover:bg-[#F0F7FF]"
              }`}
            >
              <Checkbox checked={isSelected} />
              {f.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-[#667085] italic">
        Tuition and application fees are in each course&apos;s own currency.
        The approximate column converts at mid-market exchange rates.
      </p>
      <div className="mt-5">
        <span className="text-sm font-semibold text-[#101828]">Format</span>
        <div className="mt-2 flex overflow-hidden rounded-lg border border-[#D0D5DD]">
          {(
            [
              { value: "csv", label: "CSV" },
              { value: "excel", label: "Excel" },
            ] as const
          ).map((opt, i) => (
            <button
              type="button"
              key={opt.value}
              onClick={() => setFormat(opt.value)}
              className={`flex-1 cursor-pointer py-2 text-[13px] font-medium transition-colors ${
                i === 0 ? "border-r border-[#D0D5DD]" : ""
              } ${
                format === opt.value
                  ? "bg-[#1570EF] text-white"
                  : "bg-white text-[#667085] hover:bg-[#F9FAFB]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2 transition-colors ${
        checked ? "border-[#1570EF] bg-[#1570EF]" : "border-[#D0D5DD] bg-white"
      }`}
    >
      {checked && (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth={3}
          className="h-3 w-3"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

// ----- Save template dialog -------------------------------------------------

export function SaveTemplateDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const submit = () => {
    if (!name.trim()) return;
    onSave(name.trim());
    onClose();
  };

  return (
    <Modal
      open={open}
      title="Save Search Template"
      onClose={onClose}
      width="w-[420px]"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-5 py-2.5 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
          >
            Cancel
          </button>
          <Button
            onClick={submit}
            disabled={!name.trim()}
            className="!h-[42px] !px-5"
          >
            Save
          </Button>
        </div>
      }
    >
      <FormInput
        autoFocus
        placeholder="Enter template name..."
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
    </Modal>
  );
}

// ----- Load template dialog -------------------------------------------------

export function LoadTemplateDialog({
  open,
  onClose,
  templates,
  loading,
  onLoad,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  templates: SearchTemplate[];
  loading?: boolean;
  onLoad: (t: SearchTemplate) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <Modal
      open={open}
      title="Saved Search Templates"
      onClose={onClose}
      width="w-[460px]"
    >
      {loading ? (
        <div className="py-8 text-center text-sm text-[#98A2B3]">Loading…</div>
      ) : templates.length === 0 ? (
        <div className="py-8 text-center text-sm text-[#98A2B3]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#98A2B3"
            strokeWidth={1.5}
            className="mx-auto mb-2 h-10 w-10"
          >
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          No saved templates yet
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[#E4E7EC] px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#101828]">
                  {t.name}
                </div>
                <div className="mt-0.5 text-xs text-[#98A2B3]">
                  {templateMeta(t)} · by {t.createdBy}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onLoad(t);
                    onClose();
                  }}
                  className="cursor-pointer rounded-lg border border-[#B2DDFF] bg-[#EFF8FF] px-3.5 py-1.5 text-xs font-semibold text-[#1570EF] hover:bg-[#1570EF] hover:text-white"
                >
                  Load
                </button>
                {t.canDelete && (
                  <button
                    type="button"
                    onClick={() => onDelete(t.id)}
                    className="cursor-pointer rounded-lg border border-[#FECDCA] bg-white px-3.5 py-1.5 text-xs font-semibold text-[#F04438] hover:bg-[#FEF3F2]"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function templateMeta(t: SearchTemplate): string {
  const f = templateToFilters(t);
  const parts: string[] = [];
  if (f.query) parts.push(`“${f.query}”`);
  if (f.degreeLevel) parts.push("Study level");
  if (f.countries.length > 0) {
    parts.push(
      `${f.countries.length} countr${f.countries.length === 1 ? "y" : "ies"}`,
    );
  }
  if (f.intakeMonths.length > 0) parts.push(f.intakeMonths.join(", "));
  if (f.intakeYear) parts.push(f.intakeYear);
  return parts.length > 0 ? parts.join(" · ") : "All filters";
}

// ----- Submit course dialog -------------------------------------------------

interface SubmitCourseForm {
  country: string;
  university: string;
  courseName: string;
  courseLink: string;
  intakeMonth: string;
  intakeYear: string;
}

const emptySubmitForm = (): SubmitCourseForm => ({
  country: "",
  university: "",
  courseName: "",
  courseLink: "",
  intakeMonth: "",
  intakeYear: "",
});

// Mirrors the mock: collect the request and confirm. There's no submissions
// table yet, so nothing is persisted — the content team picks these up once
// that lands.
export function SubmitCourseDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [form, setForm] = useState<SubmitCourseForm>(emptySubmitForm());
  const [submitted, setSubmitted] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(emptySubmitForm());
      setSubmitted(false);
      setShowErrors(false);
    }
  }, [open]);

  const set = <K extends keyof SubmitCourseForm>(
    key: K,
    value: SubmitCourseForm[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const missing = (key: keyof SubmitCourseForm) =>
    showErrors && key !== "courseLink" && !form[key].trim();

  const submit = () => {
    const valid =
      form.country &&
      form.university.trim() &&
      form.courseName.trim() &&
      form.intakeMonth &&
      form.intakeYear;
    if (!valid) {
      setShowErrors(true);
      return;
    }
    setSubmitted(true);
  };

  const yearOptions = ["2026", "2027", "2028"].map((y) => ({
    value: y,
    label: y,
  }));

  return (
    <Modal
      open={open}
      title={submitted ? "Course Submitted" : "Submit a Course"}
      onClose={onClose}
      width="w-[480px]"
      footer={
        submitted ? undefined : (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-5 py-2.5 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
            >
              Cancel
            </button>
            <Button onClick={submit} className="!h-[42px] !px-5">
              Submit
            </Button>
          </div>
        )
      }
    >
      {submitted ? (
        <div className="py-4 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#ECFDF3]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#12B76A"
              strokeWidth={2.5}
              className="h-7 w-7"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h4 className="text-base font-bold text-[#101828]">
            Course Submitted Successfully
          </h4>
          <p className="mx-auto mt-2 max-w-[360px] text-sm leading-relaxed text-[#667085]">
            Thank you for submitting <strong>{form.courseName}</strong> at{" "}
            <strong>{form.university}</strong>. Our team will review the course
            details and add it to the platform.
          </p>
          <Button onClick={onClose} className="mt-5 !h-[42px] !px-7">
            Done
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <FormSelect
            label="Country"
            required
            placeholder="Select country"
            options={COUNTRIES.map((c) => ({ value: c.code, label: c.name }))}
            value={form.country}
            onChange={(e) => set("country", e.target.value)}
            error={missing("country")}
            errorMessage="Country is required"
          />
          <FormInput
            label="University"
            required
            placeholder="e.g. University of Toronto"
            value={form.university}
            onChange={(e) => set("university", e.target.value)}
            error={missing("university")}
            errorMessage="University is required"
          />
          <FormInput
            label="Course Name"
            required
            placeholder="e.g. MSc Computer Science"
            value={form.courseName}
            onChange={(e) => set("courseName", e.target.value)}
            error={missing("courseName")}
            errorMessage="Course name is required"
          />
          <FormInput
            label="Link to Course"
            placeholder="https://www.university.edu/course-page"
            value={form.courseLink}
            onChange={(e) => set("courseLink", e.target.value)}
          />
          <div className="flex gap-3">
            <FormSelect
              label="Intake Month"
              required
              placeholder="Select month"
              options={INTAKE_MONTHS.map((m) => ({ value: m, label: m }))}
              value={form.intakeMonth}
              onChange={(e) => set("intakeMonth", e.target.value)}
              error={missing("intakeMonth")}
              errorMessage="Required"
            />
            <FormSelect
              label="Intake Year"
              required
              placeholder="Select year"
              options={yearOptions}
              value={form.intakeYear}
              onChange={(e) => set("intakeYear", e.target.value)}
              error={missing("intakeYear")}
              errorMessage="Required"
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
