"use client";

import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { useStudentProfileApi } from "./profile-api";
import { type AdminStudentFull } from "../lib";
import {
  ALL_TESTS,
  ENGLISH_TESTS,
  STANDARDIZED_TESTS,
  type TestDef,
} from "./profile-lib";
import { DocumentsTabNote } from "./doc-upload";
import { SectionHeader } from "./profile-tab";

interface AttemptDraft {
  scores: Record<string, string>;
  date: string;
}

type TestState = Record<string, AttemptDraft[]>;

const emptyAttempt = (): AttemptDraft => ({ scores: {}, date: "" });

function buildState(student: AdminStudentFull): TestState {
  const state: TestState = {};
  for (const row of student.testScores) {
    const list = (state[row.test] ??= []);
    const scores: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.scores)) scores[k] = String(v);
    list[row.attempt - 1] = { scores, date: row.testDate ?? "" };
  }
  // Fill any sparse attempt gaps so indexes are stable.
  for (const key of Object.keys(state)) {
    const list = state[key]!;
    for (let i = 0; i < list.length; i++) list[i] ??= emptyAttempt();
  }
  return state;
}

export function TestsTab({
  student,
  onToast,
}: {
  student: AdminStudentFull;
  onToast: (msg: string) => void;
}) {
  const profileApi = useStudentProfileApi();
  const refresh = profileApi.useRefresh();
  const [state, setState] = useState<TestState>(() => buildState(student));
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(Object.keys(buildState(student))),
  );

  useEffect(() => {
    const s = buildState(student);
    setState(s);
    setOpen(new Set(Object.keys(s)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id]);

  const attemptsFor = (key: string): AttemptDraft[] =>
    state[key] ?? [emptyAttempt()];

  const setScore = (key: string, attempt: number, field: string, v: string) =>
    setState((prev) => {
      const list = [...(prev[key] ?? [emptyAttempt()])];
      const a = list[attempt] ?? emptyAttempt();
      list[attempt] = { ...a, scores: { ...a.scores, [field]: v } };
      return { ...prev, [key]: list };
    });

  const setDate = (key: string, attempt: number, date: string) =>
    setState((prev) => {
      const list = [...(prev[key] ?? [emptyAttempt()])];
      const a = list[attempt] ?? emptyAttempt();
      list[attempt] = { ...a, date };
      return { ...prev, [key]: list };
    });

  const addAttempt = (key: string) =>
    setState((prev) => ({
      ...prev,
      [key]: [...(prev[key] ?? [emptyAttempt()]), emptyAttempt()],
    }));

  const removeAttempt = (key: string, attempt: number) =>
    setState((prev) => ({
      ...prev,
      [key]: (prev[key] ?? []).filter((_, i) => i !== attempt),
    }));

  const saveMut = profileApi.useSaveTests({
    onSuccess: () => {
      refresh(student.id);
      onToast("Test scores saved");
    },
    onError: (err) => onToast(err.message),
  });

  const save = () => {
    const entries: Array<{
      test: string;
      attempt: number;
      scores: Record<string, number>;
      testDate: string | null;
    }> = [];
    for (const test of ALL_TESTS) {
      const attempts = state[test.key] ?? [];
      let attemptNo = 0;
      for (const a of attempts) {
        const scores: Record<string, number> = {};
        for (const field of test.fields) {
          const raw = (a.scores[field.id] ?? "").trim();
          if (raw === "") continue;
          const n = Number(raw);
          if (Number.isNaN(n)) {
            onToast(`${test.label}: ${field.label} must be a number`);
            return;
          }
          if (n < field.min || n > field.max) {
            onToast(
              `${test.label}: ${field.label} must be between ${field.min} and ${field.max}`,
            );
            return;
          }
          scores[field.id] = n;
        }
        if (Object.keys(scores).length === 0 && !a.date) continue;
        if (test.validate) {
          const err = test.validate(scores);
          if (err) {
            onToast(`${test.label}: ${err}`);
            return;
          }
        }
        attemptNo += 1;
        entries.push({
          test: test.key,
          attempt: attemptNo,
          scores,
          testDate: a.date || null,
        });
      }
    }
    saveMut.mutate({ studentId: student.id, entries });
  };

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderGroup = (tests: TestDef[]) => (
    <div className="space-y-3">
      {tests.map((test) => {
        const attempts = attemptsFor(test.key);
        const isOpen = open.has(test.key);
        const filled = (state[test.key] ?? []).some(
          (a) => Object.values(a.scores).some((v) => v.trim() !== "") || a.date,
        );
        return (
          <div
            key={test.key}
            className="overflow-hidden rounded-[10px] border border-[#E4E7EC]"
          >
            <button
              type="button"
              onClick={() => toggle(test.key)}
              className="flex w-full cursor-pointer items-center justify-between bg-[#F9FAFB] px-5 py-3.5 text-sm font-bold text-[#101828]"
            >
              <span className="flex items-center gap-2">
                {test.label}
                {filled && (
                  <span className="rounded-xl bg-[#ECFDF3] px-2 py-0.5 text-[11px] font-semibold text-[#027A48]">
                    Scores entered
                  </span>
                )}
              </span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#667085"
                strokeWidth={2}
                className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {isOpen && (
              <div className="space-y-4 border-t border-[#E4E7EC] p-5">
                {attempts.map((a, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-[#F2F4F7] bg-[#FCFCFD] p-4"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-xs font-semibold tracking-wider text-[#98A2B3] uppercase">
                        Attempt {i + 1}
                      </span>
                      {i > 0 && (
                        <button
                          type="button"
                          onClick={() => removeAttempt(test.key, i)}
                          className="cursor-pointer text-xs font-semibold text-[#F04438] hover:underline"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                      {test.fields.map((field) => (
                        <FormInput
                          key={field.id}
                          label={`${field.shortLabel ?? field.label} (${field.min}-${field.max})`}
                          type="number"
                          min={field.min}
                          max={field.max}
                          step={field.step ?? 1}
                          placeholder={`${field.min}-${field.max}`}
                          value={a.scores[field.id] ?? ""}
                          onChange={(e) =>
                            setScore(test.key, i, field.id, e.target.value)
                          }
                        />
                      ))}
                    </div>
                    <div className="mt-3 max-w-[220px]">
                      <FormInput
                        label="Date Taken"
                        type="date"
                        value={a.date}
                        onChange={(e) => setDate(test.key, i, e.target.value)}
                      />
                    </div>
                    <DocumentsTabNote what="Score reports" />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addAttempt(test.key)}
                  className="flex cursor-pointer items-center gap-1.5 text-[13px] font-semibold text-[#1570EF] hover:underline"
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
                  Add Another Attempt
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="rounded-[14px] border border-[#E4E7EC] bg-white p-7">
      <SectionHeader icon={<DocIcon />} title="Test Scores" first />
      <p className="-mt-1 mb-5 text-[13px] text-[#667085]">
        Enter standardized test and English proficiency scores. Expand a test
        to enter details; only attempts with scores are saved.
      </p>

      <div className="mb-3 text-[13px] font-bold text-[#101828]">
        Standardized Tests
      </div>
      {renderGroup(STANDARDIZED_TESTS)}

      <div className="mt-7 mb-3 text-[13px] font-bold text-[#101828]">
        English Proficiency Tests
      </div>
      {renderGroup(ENGLISH_TESTS)}

      <div className="mt-7 flex justify-end border-t border-[#F2F4F7] pt-5">
        <Button
          onClick={save}
          loading={saveMut.isPending}
          className="!h-[40px] !px-5 !text-[13px]"
        >
          Save Test Scores
        </Button>
      </div>
    </div>
  );
}

function DocIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#1570EF"
      strokeWidth={2}
      className="h-[18px] w-[18px] shrink-0"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}
