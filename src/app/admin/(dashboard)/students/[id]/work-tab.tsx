"use client";

import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { useStudentProfileApi } from "./profile-api";
import { type AdminStudentFull } from "../lib";
import {
  EMPLOYMENT_TYPES,
  INDUSTRY_OPTIONS,
  MONTH_OPTIONS,
  WORK_COUNTRIES,
  strOrNull,
  yearOptions,
} from "./profile-lib";
import { SectionHeader } from "./profile-tab";

interface WorkDraft {
  company: string;
  jobTitle: string;
  employmentType: string;
  industry: string;
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  currentlyWorking: boolean;
  city: string;
  country: string;
  description: string;
}

const emptyDraft = (): WorkDraft => ({
  company: "",
  jobTitle: "",
  employmentType: "",
  industry: "",
  startMonth: "",
  startYear: "",
  endMonth: "",
  endYear: "",
  currentlyWorking: false,
  city: "",
  country: "",
  description: "",
});

function buildDrafts(student: AdminStudentFull): WorkDraft[] {
  return student.workExperience.map((w) => ({
    company: w.company,
    jobTitle: w.jobTitle ?? "",
    employmentType: w.employmentType ?? "",
    industry: w.industry ?? "",
    startMonth: String(w.startMonth),
    startYear: String(w.startYear),
    endMonth: w.endMonth === null ? "" : String(w.endMonth),
    endYear: w.endYear === null ? "" : String(w.endYear),
    currentlyWorking: w.currentlyWorking,
    city: w.city ?? "",
    country: w.country ?? "",
    description: w.description ?? "",
  }));
}

export function WorkTab({
  student,
  onToast,
}: {
  student: AdminStudentFull;
  onToast: (msg: string) => void;
}) {
  const profileApi = useStudentProfileApi();
  const refresh = profileApi.useRefresh();
  const [drafts, setDrafts] = useState<WorkDraft[]>(() => buildDrafts(student));

  useEffect(() => {
    setDrafts(buildDrafts(student));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id]);

  const setDraft = (i: number, patch: Partial<WorkDraft>) =>
    setDrafts((prev) =>
      prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)),
    );

  const saveMut = profileApi.useSaveWork({
    onSuccess: () => {
      refresh(student.id);
      onToast("Work experience saved");
    },
    onError: (err) => onToast(err.message),
  });

  const save = () => {
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      if (!d.company.trim()) {
        onToast(`Experience ${i + 1}: company name is required`);
        return;
      }
      if (!d.startMonth || !d.startYear) {
        onToast(`Experience ${i + 1}: start date is required`);
        return;
      }
      if (!d.currentlyWorking && (!d.endMonth || !d.endYear)) {
        onToast(
          `Experience ${i + 1}: end date is required (or mark Currently Working)`,
        );
        return;
      }
    }
    saveMut.mutate({
      studentId: student.id,
      entries: drafts.map((d) => ({
        company: d.company.trim(),
        jobTitle: strOrNull(d.jobTitle),
        employmentType: d.employmentType || null,
        industry: d.industry || null,
        startMonth: Number(d.startMonth),
        startYear: Number(d.startYear),
        endMonth: d.currentlyWorking || !d.endMonth ? null : Number(d.endMonth),
        endYear: d.currentlyWorking || !d.endYear ? null : Number(d.endYear),
        currentlyWorking: d.currentlyWorking,
        city: strOrNull(d.city),
        country: d.country || null,
        description: strOrNull(d.description),
      })),
    });
  };

  const currentYear = new Date().getFullYear();
  const years = yearOptions(currentYear - 30, currentYear + 1);

  return (
    <div className="rounded-[14px] border border-[#E4E7EC] bg-white p-7">
      <SectionHeader icon={<BriefcaseIcon />} title="Work Experience" first />
      <p className="-mt-1 mb-5 text-[13px] text-[#667085]">
        Add professional and internship experience in reverse chronological
        order.
      </p>

      <div className="space-y-4">
        {drafts.map((d, i) => (
          <div key={i} className="rounded-[10px] border border-[#E4E7EC] p-5">
            <div className="mb-3.5 flex items-center justify-between">
              <span className="text-[13px] font-semibold text-[#344054]">
                Experience {i + 1}
              </span>
              <button
                type="button"
                onClick={() =>
                  setDrafts((prev) => prev.filter((_, idx) => idx !== i))
                }
                className="cursor-pointer text-xs font-semibold text-[#F04438] hover:underline"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormInput
                label="Company Name"
                required
                placeholder="Company name"
                value={d.company}
                onChange={(e) => setDraft(i, { company: e.target.value })}
              />
              <FormInput
                label="Job Title / Designation"
                placeholder="Job title"
                value={d.jobTitle}
                onChange={(e) => setDraft(i, { jobTitle: e.target.value })}
              />
              <FormSelect
                label="Employment Type"
                placeholder="Select Type"
                options={EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t }))}
                value={d.employmentType}
                onChange={(e) => setDraft(i, { employmentType: e.target.value })}
              />
              <FormSelect
                label="Industry"
                placeholder="Select Industry"
                options={INDUSTRY_OPTIONS}
                value={d.industry}
                onChange={(e) => setDraft(i, { industry: e.target.value })}
              />
              <div className="flex flex-col">
                <label className="mb-1.5 text-[13px] font-medium text-[#344054]">
                  Start Date <span className="text-[#F04438]">*</span>
                </label>
                <div className="flex gap-2">
                  <FormSelect
                    placeholder="Month"
                    options={MONTH_OPTIONS}
                    value={d.startMonth}
                    onChange={(e) => setDraft(i, { startMonth: e.target.value })}
                  />
                  <FormSelect
                    placeholder="Year"
                    options={years}
                    value={d.startYear}
                    onChange={(e) => setDraft(i, { startYear: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex flex-col">
                <label className="mb-1.5 text-[13px] font-medium text-[#344054]">
                  End Date
                </label>
                <div className="flex gap-2">
                  <FormSelect
                    placeholder="Month"
                    options={MONTH_OPTIONS}
                    disabled={d.currentlyWorking}
                    value={d.currentlyWorking ? "" : d.endMonth}
                    onChange={(e) => setDraft(i, { endMonth: e.target.value })}
                  />
                  <FormSelect
                    placeholder="Year"
                    options={years}
                    disabled={d.currentlyWorking}
                    value={d.currentlyWorking ? "" : d.endYear}
                    onChange={(e) => setDraft(i, { endYear: e.target.value })}
                  />
                </div>
                <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-[13px] text-[#344054]">
                  <input
                    type="checkbox"
                    checked={d.currentlyWorking}
                    onChange={(e) =>
                      setDraft(i, { currentlyWorking: e.target.checked })
                    }
                    className="h-4 w-4 cursor-pointer accent-[#1570EF]"
                  />
                  Currently Working
                </label>
              </div>
              <FormInput
                label="City"
                placeholder="City"
                value={d.city}
                onChange={(e) => setDraft(i, { city: e.target.value })}
              />
              <FormSelect
                label="Country"
                placeholder="Select Country"
                options={WORK_COUNTRIES.map((c) => ({ value: c, label: c }))}
                value={d.country}
                onChange={(e) => setDraft(i, { country: e.target.value })}
              />
              <div className="sm:col-span-2">
                <FormTextarea
                  label="Description / Responsibilities"
                  placeholder="Brief description of role and responsibilities..."
                  rows={3}
                  value={d.description}
                  onChange={(e) => setDraft(i, { description: e.target.value })}
                />
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={() => setDrafts((prev) => [...prev, emptyDraft()])}
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed border-[#D0D5DD] py-3 text-[13px] font-semibold text-[#667085] hover:border-[#1570EF] hover:text-[#1570EF]"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="h-3.5 w-3.5"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Work Experience
        </button>
      </div>

      <div className="mt-7 flex justify-end border-t border-[#F2F4F7] pt-5">
        <Button
          onClick={save}
          loading={saveMut.isPending}
          className="!h-[40px] !px-5 !text-[13px]"
        >
          Save Work Experience
        </Button>
      </div>
    </div>
  );
}

function BriefcaseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#1570EF"
      strokeWidth={2}
      className="h-[18px] w-[18px] shrink-0"
    >
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  );
}
