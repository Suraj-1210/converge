"use client";

import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { EducationLevel, EducationLevelLabel } from "~/server/db/enums";
import { useStudentProfileApi } from "./profile-api";
import { type AdminStudentFull } from "../lib";
import {
  BOARD_OPTIONS,
  EDUCATION_COUNTRIES,
  EDUCATION_LEVEL_OPTIONS,
  GRADING_SYSTEM_OPTIONS,
  INDIAN_STATES,
  INSTRUCTION_LANGUAGES,
  MAJOR_OPTIONS,
  MONTH_OPTIONS,
  SCALE_BY_BOARD,
  SCALE_OPTIONS,
  autoQualification,
  eduDocCategories,
  eduDocType,
  isHigherLevel,
  strOrNull,
  yearOptions,
} from "./profile-lib";
import { InlineDocUpload } from "./doc-upload";
import { CapIcon, SectionHeader } from "./profile-tab";

interface EduDraft {
  country: string;
  board: string;
  state: string;
  qualification: string;
  institution: string;
  city: string;
  gradingSystem: string;
  scale: string;
  score: string;
  language: string;
  passMonth: string;
  passYear: string;
  major: string;
  researchTopic: string;
  predictedScore: string;
}

const emptyDraft = (): EduDraft => ({
  country: "",
  board: "",
  state: "",
  qualification: "",
  institution: "",
  city: "",
  gradingSystem: "",
  scale: "",
  score: "",
  language: "",
  passMonth: "",
  passYear: "",
  major: "",
  researchTopic: "",
  predictedScore: "",
});

function buildState(student: AdminStudentFull): {
  highest: string;
  entries: Record<number, EduDraft>;
} {
  const entries: Record<number, EduDraft> = {};
  for (const row of student.educationRows) {
    entries[row.level] = {
      country: row.country ?? "",
      board: row.board ?? "",
      state: row.state ?? "",
      qualification: row.qualification ?? "",
      institution: row.institution ?? "",
      city: row.city ?? "",
      gradingSystem: row.gradingSystem ?? "",
      scale: row.scale ?? "",
      score: row.score ?? "",
      language: row.language ?? "",
      passMonth: row.passMonth === null ? "" : String(row.passMonth),
      passYear: row.passYear === null ? "" : String(row.passYear),
      major: row.major ?? "",
      researchTopic: row.researchTopic ?? "",
      predictedScore: row.predictedScore ?? "",
    };
  }
  return {
    highest:
      student.highestEducationLevel === null
        ? ""
        : String(student.highestEducationLevel),
    entries,
  };
}

export function AcademicTab({
  student,
  onToast,
}: {
  student: AdminStudentFull;
  onToast: (msg: string) => void;
}) {
  const profileApi = useStudentProfileApi();
  const refresh = profileApi.useRefresh();
  const [highest, setHighest] = useState(() => buildState(student).highest);
  const [entries, setEntries] = useState<Record<number, EduDraft>>(
    () => buildState(student).entries,
  );
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    const s = buildState(student);
    setHighest(s.highest);
    setEntries(s.entries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id]);

  // Sections render highest level first, down to 10th grade.
  const levels: number[] = [];
  if (highest !== "") {
    for (let l = Number(highest); l >= EducationLevel.TENTH; l--) levels.push(l);
  }

  const draft = (level: number): EduDraft => entries[level] ?? emptyDraft();

  const setField = (level: number, patch: Partial<EduDraft>) =>
    setEntries((prev) => ({
      ...prev,
      [level]: { ...(prev[level] ?? emptyDraft()), ...patch },
    }));

  const onBoardChange = (level: number, board: string) => {
    const patch: Partial<EduDraft> = { board };
    patch.qualification = autoQualification(level, board);
    const preset = SCALE_BY_BOARD[board];
    if (!isHigherLevel(level) && preset) {
      patch.gradingSystem = preset.system;
      patch.scale = preset.scale;
    }
    if (board !== "State Board") patch.state = "";
    setField(level, patch);
  };

  const saveMut = profileApi.useSaveEducation({
    onSuccess: () => {
      refresh(student.id);
      onToast("Academic information saved");
    },
    onError: (err) => onToast(err.message),
  });

  const save = () => {
    saveMut.mutate({
      studentId: student.id,
      highestLevel: highest === "" ? null : Number(highest),
      entries: levels.map((level) => {
        const d = draft(level);
        return {
          level,
          country: d.country || null,
          board: d.board || null,
          state: d.board === "State Board" ? d.state || null : null,
          qualification: strOrNull(d.qualification),
          institution: strOrNull(d.institution),
          city: strOrNull(d.city),
          gradingSystem: d.gradingSystem || null,
          scale: d.scale || null,
          score: strOrNull(d.score),
          language: d.language || null,
          passMonth: d.passMonth ? Number(d.passMonth) : null,
          passYear: d.passYear ? Number(d.passYear) : null,
          major: isHigherLevel(level) ? d.major || null : null,
          researchTopic:
            level === EducationLevel.PHD ? strOrNull(d.researchTopic) : null,
          predictedScore:
            level === EducationLevel.TWELFTH ? strOrNull(d.predictedScore) : null,
        };
      }),
    });
  };

  const currentYear = new Date().getFullYear();

  return (
    <div className="rounded-[14px] border border-[#E4E7EC] bg-white p-7">
      <SectionHeader icon={<CapIcon />} title="Academic Qualifications" first />

      <div className="max-w-[420px]">
        <FormSelect
          label="Highest Level of Education"
          required
          placeholder="Select Level"
          options={EDUCATION_LEVEL_OPTIONS}
          value={highest}
          onChange={(e) => setHighest(e.target.value)}
        />
      </div>

      <div className="mt-6 space-y-4">
        {levels.map((level) => {
          const d = draft(level);
          const higher = isHigherLevel(level);
          const isCollapsed = collapsed.has(level);
          const label =
            EducationLevelLabel[level as keyof typeof EducationLevelLabel];
          return (
            <div
              key={level}
              className="overflow-hidden rounded-[10px] border border-[#E4E7EC]"
            >
              <button
                type="button"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(level)) next.delete(level);
                    else next.add(level);
                    return next;
                  })
                }
                className="flex w-full cursor-pointer items-center justify-between bg-[#F9FAFB] px-5 py-3.5 text-sm font-bold text-[#101828]"
              >
                {label}
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#667085"
                  strokeWidth={2}
                  className={`h-4 w-4 transition-transform ${isCollapsed ? "" : "rotate-180"}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {!isCollapsed && (
                <div className="border-t border-[#E4E7EC] p-5">
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    <FormSelect
                      label="Country of Study"
                      required
                      placeholder="Select Country"
                      options={EDUCATION_COUNTRIES.map((c) => ({
                        value: c,
                        label: c,
                      }))}
                      value={d.country}
                      onChange={(e) => setField(level, { country: e.target.value })}
                    />
                    <FormSelect
                      label={higher ? "Degree Type" : "Education Board"}
                      required
                      placeholder={higher ? "Select Degree Type" : "Select Board"}
                      options={(BOARD_OPTIONS[level] ?? []).map((b) => ({
                        value: b,
                        label: b,
                      }))}
                      value={d.board}
                      onChange={(e) => onBoardChange(level, e.target.value)}
                    />
                    {d.board === "State Board" && (
                      <FormSelect
                        label="State"
                        required
                        placeholder="Select State"
                        options={INDIAN_STATES.map((s) => ({
                          value: s,
                          label: s,
                        }))}
                        value={d.state}
                        onChange={(e) => setField(level, { state: e.target.value })}
                      />
                    )}
                    <FormInput
                      label={higher ? "Degree Awarded" : "Qualification / Degree Awarded"}
                      required
                      placeholder={
                        higher
                          ? "Auto-filled from degree type"
                          : "Auto-filled from board"
                      }
                      value={d.qualification}
                      onChange={(e) =>
                        setField(level, { qualification: e.target.value })
                      }
                    />
                    <FormInput
                      label="Name of Institution"
                      required
                      placeholder="School / College / University name"
                      value={d.institution}
                      onChange={(e) =>
                        setField(level, { institution: e.target.value })
                      }
                    />
                    <FormInput
                      label="City of Study"
                      required
                      placeholder="City"
                      value={d.city}
                      onChange={(e) => setField(level, { city: e.target.value })}
                    />
                    <FormSelect
                      label="Grading System"
                      required
                      placeholder="Select Grading System"
                      options={GRADING_SYSTEM_OPTIONS.map((g) => ({
                        value: g,
                        label: g,
                      }))}
                      value={d.gradingSystem}
                      onChange={(e) =>
                        setField(level, { gradingSystem: e.target.value })
                      }
                    />
                    <FormSelect
                      label="Scale"
                      required
                      placeholder="Select Scale"
                      options={SCALE_OPTIONS.map((sc) => ({
                        value: sc,
                        label: sc,
                      }))}
                      value={d.scale}
                      onChange={(e) => setField(level, { scale: e.target.value })}
                    />
                    <FormInput
                      label="Score"
                      required
                      placeholder="e.g. 85% or 8.5 CGPA"
                      value={d.score}
                      onChange={(e) => setField(level, { score: e.target.value })}
                    />
                    <FormSelect
                      label="Primary Language of Instruction"
                      required
                      placeholder="Select Language"
                      options={INSTRUCTION_LANGUAGES.map((l) => ({
                        value: l,
                        label: l,
                      }))}
                      value={d.language}
                      onChange={(e) => setField(level, { language: e.target.value })}
                    />
                    <div className="flex flex-col">
                      <label className="mb-1.5 text-[13px] font-medium text-[#344054]">
                        Month & Year of Passing{" "}
                        <span className="text-[#F04438]">*</span>
                      </label>
                      <div className="flex gap-2">
                        <FormSelect
                          placeholder="Month"
                          options={MONTH_OPTIONS}
                          value={d.passMonth}
                          onChange={(e) =>
                            setField(level, { passMonth: e.target.value })
                          }
                        />
                        <FormSelect
                          placeholder="Year"
                          options={yearOptions(currentYear - 30, currentYear + 2)}
                          value={d.passYear}
                          onChange={(e) =>
                            setField(level, { passYear: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    {higher && (
                      <FormSelect
                        label="Major / Specialization"
                        required
                        placeholder="Select Specialization"
                        options={(MAJOR_OPTIONS[level] ?? []).map((m) => ({
                          value: m,
                          label: m,
                        }))}
                        value={d.major}
                        onChange={(e) => setField(level, { major: e.target.value })}
                      />
                    )}
                    {level === EducationLevel.PHD && (
                      <div className="sm:col-span-2">
                        <FormInput
                          label="Research Topic"
                          required
                          placeholder="Thesis / Research topic"
                          value={d.researchTopic}
                          onChange={(e) =>
                            setField(level, { researchTopic: e.target.value })
                          }
                        />
                      </div>
                    )}
                    {level === EducationLevel.TWELFTH && (
                      <FormInput
                        label="Predicted Score (optional)"
                        placeholder="Predicted score if available"
                        value={d.predictedScore}
                        onChange={(e) =>
                          setField(level, { predictedScore: e.target.value })
                        }
                      />
                    )}
                  </div>
                  {/* Per-level document uploads (mock's edu-docs-section) */}
                  <div className="mt-5 rounded-[10px] border border-[#E4E7EC] bg-[#F9FAFB] px-4 py-3">
                    <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-[#101828]">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#1570EF"
                        strokeWidth={2}
                        className="h-4 w-4"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      Document Uploads
                    </div>
                    {eduDocCategories(level).map((cat) => (
                      <InlineDocUpload
                        key={cat.key}
                        student={student}
                        docType={eduDocType(level, cat.key)}
                        name={cat.name}
                        hint={cat.hint}
                        onToast={onToast}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {highest === "" && (
        <div className="mt-5 rounded-lg border border-dashed border-[#D0D5DD] px-4 py-8 text-center text-[13px] text-[#98A2B3]">
          Select the highest level of education to add qualification details.
        </div>
      )}

      <div className="mt-7 flex justify-end border-t border-[#F2F4F7] pt-5">
        <Button
          onClick={save}
          loading={saveMut.isPending}
          className="!h-[40px] !px-5 !text-[13px]"
        >
          Save Academic Info
        </Button>
      </div>
    </div>
  );
}
