"use client";

import { useState } from "react";
import Link from "next/link";
import { Modal } from "~/components/ui/modal";
import { api } from "~/trpc/react";
import {
  assigneeOf,
  joinAnd,
  plural,
  studentName,
  type AssignableStudent,
} from "./assignee";

type Target = "owner" | number;

// One dialog for assigning a single student or a bulk selection. Step 1 picks
// who (with each person's current student count, to keep the load even);
// step 2 summarises the change. Nothing is saved until "Assign" on step 2.
export function AssignModal({
  students,
  ownerId,
  onClose,
  onDone,
}: {
  students: AssignableStudent[];
  ownerId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const people = api.students.partnerAssignees.useQuery();
  const [target, setTarget] = useState<Target | null>(null);
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [error, setError] = useState("");

  const single = students.length === 1 ? students[0]! : null;
  const counsellors = people.data?.counsellors ?? [];
  const targetId = target === "owner" ? ownerId : target;
  const targetName =
    target === "owner"
      ? "you"
      : (counsellors.find((c) => c.id === target)?.name ?? "this counsellor");

  const assign = api.students.partnerAssignCounsellor.useMutation({
    onSuccess: (r) => {
      void utils.students.partnerList.invalidate();
      void utils.students.partnerAssignees.invalidate();
      void utils.counsellors.myCounsellors.invalidate();
      const who = r.counsellorName ?? "you";
      onDone(
        single
          ? `${studentName(single)} assigned to ${who}`
          : `${plural(r.updated, "student")} assigned to ${who}`,
      );
    },
    onError: (e) => setError(e.message),
  });

  // Where the selection sits today, for the confirmation line.
  const moving = students.filter((s) => s.counsellorId !== targetId);
  const already = students.length - moving.length;
  const groups = new Map<string, number>();
  for (const s of moving) {
    const a = assigneeOf(s, {
      id: ownerId,
      kind: "agency",
      hasCounsellors: true,
    });
    const key =
      a.kind === "you"
        ? "with you"
        : a.kind === "unassigned"
          ? "unassigned"
          : `with ${a.name}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  // "3 currently with you, 2 with Rahul Mehta and 1 unassigned"
  const where = [...groups.entries()];
  const fromLine = single
    ? `Currently ${where[0]?.[0] ?? ""}.`
    : `${joinAnd(where.map(([k, n], i) => `${n} ${i === 0 ? "currently " : ""}${k}`))}.`;

  const title = single
    ? `Assign ${studentName(single)}`
    : `Assign ${plural(students.length, "student")}`;
  const btn =
    "h-9 cursor-pointer rounded-lg px-4 text-[13px] font-semibold disabled:cursor-default disabled:opacity-50";

  const footer =
    people.isLoading || (people.data && counsellors.length === 0) ? (
      <button
        type="button"
        onClick={onClose}
        className={`${btn} border border-[#D0D5DD] text-[#344054]`}
      >
        Close
      </button>
    ) : step === "pick" ? (
      <>
        <button
          type="button"
          onClick={onClose}
          className={`${btn} border border-[#D0D5DD] text-[#344054]`}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={target === null || moving.length === 0}
          onClick={() => {
            setError("");
            setStep("confirm");
          }}
          className={`${btn} bg-[#1570EF] text-white hover:bg-[#1260d4]`}
        >
          Continue
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          disabled={assign.isPending}
          onClick={() => setStep("pick")}
          className={`${btn} border border-[#D0D5DD] text-[#344054]`}
        >
          Back
        </button>
        <button
          type="button"
          disabled={assign.isPending}
          onClick={() =>
            assign.mutate({
              studentIds: moving.map((s) => s.id),
              counsellorId: target === "owner" ? null : target,
            })
          }
          className={`${btn} bg-[#1570EF] text-white hover:bg-[#1260d4]`}
        >
          {assign.isPending ? "Assigning…" : "Assign"}
        </button>
      </>
    );

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      footer={footer}
      width="w-[480px]"
    >
      {people.isLoading ? (
        <p className="text-[13px] text-[#98A2B3]">Loading your team…</p>
      ) : people.error ? (
        <p className="text-[13px] text-[#F04438]">{people.error.message}</p>
      ) : counsellors.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#D0D5DD] px-5 py-6 text-center">
          <p className="text-sm font-semibold text-[#101828]">
            No counsellors yet
          </p>
          <p className="mt-1 text-[13px] text-[#667085]">
            Add a counsellor to your agency, and once Collegepond approves them
            you can assign students to them here.
          </p>
          <Link
            href="/partner/counsellors#add-counsellor"
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
          >
            Counsellors → Add counsellor
          </Link>
        </div>
      ) : step === "pick" ? (
        <PickStep
          owner={people.data!.owner}
          counsellors={counsellors}
          current={single?.counsellorId ?? undefined}
          target={target}
          onPick={setTarget}
          note={
            target !== null && moving.length === 0
              ? single
                ? `${studentName(single)} is already with ${targetName}.`
                : `All selected students are already with ${targetName}.`
              : ""
          }
        />
      ) : (
        <div>
          <p className="text-[15px] font-semibold text-[#101828]">
            {single
              ? `Assign ${studentName(single)} to ${targetName}?`
              : `Assign ${plural(moving.length, "student")} to ${targetName}?`}
          </p>
          <p className="mt-1.5 text-[13px] text-[#475467]">
            {fromLine}
            {already > 0 &&
              ` ${plural(already, "student")} already with ${targetName} won't change.`}
          </p>
          {target !== "owner" && (
            <p className="mt-3 rounded-lg bg-[#F2F7FF] px-3 py-2 text-[12px] text-[#175CD3]">
              {targetName} can see and work{" "}
              {single ? "this student" : "these students"} once assigned. You
              still see every student in your agency.
            </p>
          )}
          {error && <p className="mt-3 text-[13px] text-[#F04438]">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function PickStep({
  owner,
  counsellors,
  current,
  target,
  onPick,
  note,
}: {
  owner: { id: number; studentCount: number };
  counsellors: { id: number; name: string; studentCount: number }[];
  current: number | null | undefined;
  target: Target | null;
  onPick: (t: Target) => void;
  note: string;
}) {
  const max = Math.max(
    1,
    owner.studentCount,
    ...counsellors.map((c) => c.studentCount),
  );
  const options: {
    key: Target;
    name: string;
    sub?: string;
    count: number;
    isCurrent: boolean;
  }[] = [
    {
      key: "owner",
      name: "Me",
      sub: "agency owner",
      count: owner.studentCount,
      isCurrent: current === owner.id,
    },
    ...counsellors.map((c) => ({
      key: c.id as Target,
      name: c.name,
      count: c.studentCount,
      isCurrent: current === c.id,
    })),
  ];
  return (
    <div>
      <p className="mb-3 text-[13px] text-[#667085]">
        Choose who should work{" "}
        {current === undefined ? "these students" : "this student"}. Student
        counts help you keep the load even.
      </p>
      <div role="radiogroup" className="space-y-2">
        {options.map((o) => {
          const on = target === o.key;
          return (
            <button
              key={String(o.key)}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${o.name}${o.sub ? ` (${o.sub})` : ""}, ${plural(o.count, "student")}`}
              onClick={() => onPick(o.key)}
              className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                on
                  ? "border-[#1570EF] bg-[#F5F9FF]"
                  : "border-[#E4E7EC] hover:border-[#B2CCFF]"
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  on ? "border-[#1570EF]" : "border-[#D0D5DD]"
                }`}
              >
                {on && <span className="h-2 w-2 rounded-full bg-[#1570EF]" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-[#101828]">
                    {o.name}
                  </span>
                  {o.sub && (
                    <span className="text-[12px] text-[#98A2B3]">
                      ({o.sub})
                    </span>
                  )}
                  {o.isCurrent && (
                    <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 text-[11px] font-semibold text-[#475467]">
                      Current
                    </span>
                  )}
                </span>
                <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-[#F2F4F7]">
                  <span
                    className="block h-full rounded-full bg-[#84ADFF]"
                    style={{ width: `${(o.count / max) * 100}%` }}
                  />
                </span>
              </span>
              <span className="w-[86px] shrink-0 text-right text-[12px] font-medium text-[#475467]">
                {plural(o.count, "student")}
              </span>
            </button>
          );
        })}
      </div>
      {note && <p className="mt-3 text-[13px] text-[#B54708]">{note}</p>}
    </div>
  );
}
