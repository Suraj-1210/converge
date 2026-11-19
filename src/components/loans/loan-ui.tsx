"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Modal } from "~/components/ui/modal";
import { COURSE_LEVEL_OPTIONS, INTAKE_OPTIONS } from "~/components/students/status";
import {
  COUNTRY_NAME,
  DESTINATION_COUNTRIES,
  PHONE_CODES,
  PHONE_LEN,
} from "~/app/partner/(dashboard)/students/add-student-modal";
import {
  LOAN_CONSENT_TEXT,
  LOAN_TRACK,
  LoanReferralSendStatus,
  loanReferralStatusLabel,
  loanStageTone,
  loanTrackIndex,
} from "~/lib/loan-sharing";
import { api } from "~/trpc/react";

// Shared pieces of the partner loan screens (Loans tab, lead page, the loan
// card on a student). Server: ~/server/api/routers/loans.

const TONES = {
  blue: { color: "#175CD3", bg: "#EFF8FF" },
  amber: { color: "#B54708", bg: "#FFFAEB" },
  green: { color: "#067647", bg: "#ECFDF3" },
  red: { color: "#B42318", bg: "#FEF3F2" },
  gray: { color: "#475467", bg: "#F2F4F7" },
} as const;

// The one-line status: the stage once the loan team has the lead, else
// where the hand-over stands.
export function LoanStatusBadge({ sendStatus, stage }: { sendStatus: number; stage: string | null }) {
  const tone =
    sendStatus === LoanReferralSendStatus.RECEIVED
      ? TONES[loanStageTone(stage)]
      : sendStatus === LoanReferralSendStatus.FAILED
        ? TONES.red
        : sendStatus === LoanReferralSendStatus.DUPLICATE
          ? TONES.gray
          : TONES.amber;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap"
      style={{ color: tone.color, background: tone.bg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.color }} />
      {loanReferralStatusLabel(sendStatus, stage)}
    </span>
  );
}

// Received → … → Disbursed, with Declined / Closed shown as the end.
export function LoanTrack({ stage }: { stage: string | null }) {
  const at = loanTrackIndex(stage);
  const ended = stage === "declined" || stage === "closed";
  return (
    <div className="flex items-start">
      {LOAN_TRACK.map((t, i) => {
        const done = !ended && i <= at;
        const current = !ended && i === at;
        return (
          <div key={t.stage} className="flex flex-1 flex-col items-center">
            <div className="flex w-full items-center">
              <div className={`h-0.5 flex-1 ${i === 0 ? "invisible" : done ? "bg-[#1570EF]" : "bg-[#E4E7EC]"}`} />
              <div
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold ${
                  current
                    ? "border-[#1570EF] bg-[#1570EF] text-white"
                    : done
                      ? "border-[#1570EF] bg-white text-[#1570EF]"
                      : "border-[#D0D5DD] bg-white text-[#98A2B3]"
                }`}
              >
                {i + 1}
              </div>
              <div
                className={`h-0.5 flex-1 ${i === LOAN_TRACK.length - 1 ? "invisible" : !ended && i < at ? "bg-[#1570EF]" : "bg-[#E4E7EC]"}`}
              />
            </div>
            <div
              className={`mt-1.5 text-center text-[11px] ${current ? "font-semibold text-[#101828]" : "text-[#667085]"}`}
            >
              {t.label}
            </div>
          </div>
        );
      })}
      {ended && (
        <div className="ml-3 self-center rounded-full bg-[#FEF3F2] px-2.5 py-1 text-[12px] font-semibold text-[#B42318]">
          {stage === "declined" ? "Declined" : "Closed"}
        </div>
      )}
    </div>
  );
}

export function rupees(n: number | null): string {
  return n === null ? "—" : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

type ReferForm = {
  firstName: string;
  lastName: string;
  countryCode: string;
  phone: string;
  email: string;
  intake: string;
  country: string;
  courseLevel: string;
  university: string;
  loanAmount: string;
  note: string;
  consent: boolean;
};

const emptyReferForm = (): ReferForm => ({
  firstName: "",
  lastName: "",
  countryCode: "+91",
  phone: "",
  email: "",
  intake: "",
  country: "",
  courseLevel: "",
  university: "",
  loanAmount: "",
  note: "",
  consent: false,
});

// Refer to the loan team: for a student already on Converge (`student`
// given: their details are used, only the loan specifics are asked), or a
// loan-only lead (decision 3, 19 Nov 2026).
export function ReferLoanModal({
  open,
  onClose,
  student,
  onReferred,
}: {
  open: boolean;
  onClose: () => void;
  student?: { id: number; name: string };
  onReferred: (r: { publicId: string; sendStatus: number }) => void;
}) {
  const utils = api.useUtils();
  const referStudent = api.loans.partnerReferStudent.useMutation();
  const referLead = api.loans.partnerReferLead.useMutation();
  const [f, setF] = useState<ReferForm>(emptyReferForm());
  const [errors, setErrors] = useState<Partial<Record<keyof ReferForm, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const set = <K extends keyof ReferForm>(k: K, v: ReferForm[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const busy = referStudent.isPending || referLead.isPending;

  const close = () => {
    setF(emptyReferForm());
    setErrors({});
    setSubmitError(null);
    onClose();
  };

  const submit = async () => {
    const e: Partial<Record<keyof ReferForm, string>> = {};
    if (!student) {
      if (!f.firstName.trim()) e.firstName = "First name is required";
      if (!f.lastName.trim()) e.lastName = "Last name is required";
      const digits = f.phone.replace(/\D/g, "");
      const expected = PHONE_LEN[f.countryCode] ?? 10;
      if (digits.length !== expected) e.phone = `Enter a valid ${expected}-digit phone number`;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = "Enter a valid email address";
      if (!f.intake) e.intake = "Intake is required";
    }
    const amount = f.loanAmount.replace(/[^0-9]/g, "");
    if (f.loanAmount.trim() && !amount) e.loanAmount = "Enter the amount in rupees";
    if (!f.consent) e.consent = "Confirm the student agreed to be contacted by the loan team";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSubmitError(null);
    const common = {
      university: f.university.trim() || null,
      loanAmount: amount ? Number(amount) : null,
      note: f.note.trim() || null,
      consent: true as const,
    };
    try {
      const r = student
        ? await referStudent.mutateAsync({ studentId: student.id, ...common })
        : await referLead.mutateAsync({
            ...common,
            firstName: f.firstName.trim(),
            lastName: f.lastName.trim(),
            countryCode: f.countryCode,
            phone: f.phone.replace(/\s+/g, " ").trim(),
            email: f.email.trim(),
            intake: f.intake,
            country: f.country || null,
            courseLevel: f.courseLevel === "" ? null : Number(f.courseLevel),
          });
      await Promise.all([utils.loans.partnerList.invalidate(), utils.loans.partnerForStudent.invalidate()]);
      close();
      onReferred(r);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={student ? `Refer ${student.name} for an education loan` : "Refer a loan lead"}
      width="w-[600px]"
      footer={
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Send to loan team
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-[#667085]">
          Collegepond&apos;s loan team will contact the student and keep you updated here at every step.
        </p>
        {!student && (
          <>
            <div className="flex gap-3">
              <FormInput
                label="First name"
                required
                value={f.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                error={!!errors.firstName}
                errorMessage={errors.firstName}
              />
              <FormInput
                label="Last name"
                required
                value={f.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                error={!!errors.lastName}
                errorMessage={errors.lastName}
              />
            </div>
            <div className="flex gap-3">
              <div className="w-[110px] flex-none">
                <FormSelect
                  label="Code"
                  options={PHONE_CODES.map((c) => ({ value: c, label: c }))}
                  value={f.countryCode}
                  onChange={(e) => set("countryCode", e.target.value)}
                />
              </div>
              <FormInput
                label="Phone"
                required
                inputMode="numeric"
                value={f.phone}
                onChange={(e) => set("phone", e.target.value)}
                error={!!errors.phone}
                errorMessage={errors.phone}
              />
            </div>
            <FormInput
              label="Email"
              required
              type="email"
              value={f.email}
              onChange={(e) => set("email", e.target.value)}
              error={!!errors.email}
              errorMessage={errors.email}
            />
            <div className="flex gap-3">
              <FormSelect
                label="Intake"
                required
                placeholder="Select intake"
                options={INTAKE_OPTIONS.map((i) => ({ value: i, label: i }))}
                value={f.intake}
                onChange={(e) => set("intake", e.target.value)}
                error={!!errors.intake}
                errorMessage={errors.intake}
              />
              <FormSelect
                label="Country"
                placeholder="Select country"
                options={DESTINATION_COUNTRIES.map((c) => ({ value: c, label: COUNTRY_NAME[c] ?? c }))}
                value={f.country}
                onChange={(e) => set("country", e.target.value)}
              />
              <FormSelect
                label="Level"
                placeholder="Select level"
                options={COURSE_LEVEL_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
                value={f.courseLevel}
                onChange={(e) => set("courseLevel", e.target.value)}
              />
            </div>
          </>
        )}
        <div className="flex gap-3">
          <FormInput
            label="University (if known)"
            value={f.university}
            onChange={(e) => set("university", e.target.value)}
          />
          <FormInput
            label="Loan amount needed (₹)"
            inputMode="numeric"
            placeholder="e.g. 2500000"
            value={f.loanAmount}
            onChange={(e) => set("loanAmount", e.target.value)}
            error={!!errors.loanAmount}
            errorMessage={errors.loanAmount}
          />
        </div>
        <FormTextarea
          label="Note for the loan team"
          rows={3}
          maxLength={1000}
          value={f.note}
          onChange={(e) => set("note", e.target.value)}
        />
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-[#344054]">
          <input
            type="checkbox"
            checked={f.consent}
            onChange={(e) => set("consent", e.target.checked)}
            className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-[#1570EF]"
          />
          <span>
            {LOAN_CONSENT_TEXT} <span className="text-[#F04438]">*</span>
          </span>
        </label>
        {errors.consent && <div className="-mt-2 ml-7 text-xs text-[#F04438]">{errors.consent}</div>}
        {submitError && (
          <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-3 text-sm text-[#B42318]">
            {submitError}
          </div>
        )}
      </div>
    </Modal>
  );
}

// The "Education loan" row in a student's header box: the referral's status
// with a link to it, or the button to refer. Hidden when the Loans tab is off
// for this partner (the query is refused).
export function StudentLoanRow({
  studentId,
  studentName,
  onToast,
}: {
  studentId: number;
  studentName: string;
  onToast: (msg: string) => void;
}) {
  const q = api.loans.partnerForStudent.useQuery({ studentId }, { retry: false });
  const [open, setOpen] = useState(false);
  if (q.error || q.isLoading) return null;
  const r = q.data;
  const canRefer = !r || r.sendStatus === LoanReferralSendStatus.FAILED;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">Education loan</div>
        <div className="mt-0.5 text-sm">
          {r ? (
            <Link href={`/partner/loans/${r.publicId}`} className="hover:underline">
              <LoanStatusBadge sendStatus={r.sendStatus} stage={r.stage} />
            </Link>
          ) : (
            <span className="text-[#667085]">Not referred</span>
          )}
        </div>
      </div>
      {canRefer && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="h-8 cursor-pointer rounded-lg border border-[#B2CCFF] bg-[#F5F9FF] px-3 text-[12px] font-semibold whitespace-nowrap text-[#175CD3] hover:bg-[#EFF4FF]"
        >
          Refer for loan
        </button>
      )}
      <ReferLoanModal
        open={open}
        onClose={() => setOpen(false)}
        student={{ id: studentId, name: studentName }}
        onReferred={(res) =>
          onToast(
            res.sendStatus === LoanReferralSendStatus.DUPLICATE
              ? "This student is already in progress with Collegepond's loan team."
              : "Sent to Collegepond's loan team. Follow it under Loans.",
          )
        }
      />
    </div>
  );
}
