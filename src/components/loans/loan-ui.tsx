"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
  ADDITIONAL_DOC_KEY,
  ADDITIONAL_DOC_LABEL_MAX,
  LOAN_CONSENT_TEXT,
  LOAN_TRACK,
  LoanReferralSendStatus,
  loanReferralStatusLabel,
  loanStageTone,
  loanTrackIndex,
} from "~/lib/loan-sharing";
import { api, type RouterOutputs } from "~/trpc/react";

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

type LoanDetail = RouterOutputs["loans"]["partnerGet"];

// Where a loan file opens: the partner's own routes, or the Super Admin's
// read-only view (/admin/loan-referrals/[publicId]).
function loanFileHref(kind: "doc" | "chat", id: number, readOnly: boolean) {
  if (readOnly) return `/api/admin/loan-file/${id}?kind=${kind}`;
  return kind === "doc" ? `/api/partner/loan-doc-file/${id}` : `/api/partner/loan-file/${id}`;
}

const when = (d: Date | string) =>
  new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

// What the loan team did and chose to share: stage changes, lender results,
// notes ticked "Share with partner" (newest first, read-only).
export function LoanUpdates({ loan }: { loan: LoanDetail }) {
  const items = [...loan.timeline].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return (
    <section className="rounded-2xl border border-[#E4E7EC] bg-white">
      <h2 className="border-b border-[#E4E7EC] px-5 py-3.5 text-sm font-semibold text-[#101828]">Updates</h2>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-[#98A2B3]">Nothing yet.</p>
      ) : (
        <ol className="px-5 py-4">
          {items.map((e, i) => (
            <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
              {i < items.length - 1 && <span className="absolute top-3 left-[5px] h-full w-px bg-[#E4E7EC]" aria-hidden />}
              <span
                className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 bg-white ${
                  e.kind === "note" ? "border-[#7A5AF8]" : "border-[#1570EF]"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-[#101828]">{e.title}</div>
                {e.body && (
                  <div
                    className={`mt-1 text-[13px] whitespace-pre-wrap text-[#344054] ${
                      e.kind === "note" ? "rounded-lg border border-[#EBE9FE] bg-[#F9F8FF] px-3 py-2" : ""
                    }`}
                  >
                    {e.body}
                  </div>
                )}
                <div className="mt-0.5 text-[11px] text-[#98A2B3]">
                  {when(e.at)}
                  {e.actorName && ` · ${e.actorName}`}
                  {e.kind === "note" && " · Loan team"}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// The chat with the loan counsellor (contract 4): both sides, oldest first,
// the composer underneath once the loan team has the lead. Opening it (and
// each new message while it's open) marks it read for this partner user.
export function LoanChat({
  loan,
  onChanged,
  readOnly = false,
}: {
  loan: LoanDetail;
  onChanged: () => void;
  /** Super Admin view: no composer, no retry, nothing marked read. */
  readOnly?: boolean;
}) {
  const retry = api.loans.partnerRetryMessage.useMutation();
  const markRead = api.loans.partnerMarkChatRead.useMutation();
  const utils = api.useUtils();
  const msgs = [...loan.messages].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const lastStaff = msgs.filter((m) => m.side === "staff").at(-1)?.publicId ?? null;
  // Scrolls the message list (not the page) to the newest message.
  const listRef = useRef<HTMLDivElement>(null);
  const { mutate } = markRead;

  useEffect(() => {
    if (readOnly) return;
    mutate(
      { publicId: loan.publicId },
      { onSuccess: () => void Promise.all([utils.loans.partnerUnreadCount.invalidate(), utils.loans.partnerList.invalidate()]) },
    );
  }, [loan.publicId, lastStaff, mutate, utils, readOnly]);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  return (
    <section id="chat" className="rounded-2xl border border-[#E4E7EC] bg-white">
      <div className="border-b border-[#E4E7EC] px-5 py-3.5">
        <h2 className="text-sm font-semibold text-[#101828]">Chat with the loan team</h2>
        <p className="mt-0.5 text-[12px] text-[#667085]">
          {loan.counsellorName ? `With ${loan.counsellorName}` : "With Collegepond's loan team"}. Questions, updates
          about the student, and documents they ask for.
        </p>
      </div>
      <div ref={listRef} className="max-h-[480px] overflow-y-auto px-5 py-4">
        {msgs.length === 0 ? (
          <p className="py-4 text-center text-sm text-[#98A2B3]">No messages yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {msgs.map((m) => {
              const staff = m.side === "staff";
              return (
                <div key={m.publicId} className={`flex flex-col ${staff ? "items-start" : "items-end"}`}>
                  <div className="mb-0.5 text-[11px] font-medium text-[#667085]">
                    {staff ? `${m.authorName} · Loan team` : m.mine ? "You" : m.authorName}
                  </div>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] whitespace-pre-wrap ${
                      staff
                        ? "rounded-tl-sm border border-[#EBE9FE] bg-[#F9F8FF] text-[#344054]"
                        : "rounded-tr-sm bg-[#1570EF] text-white"
                    }`}
                  >
                    {m.body}
                    {m.files.length > 0 && (
                      <div className={`flex flex-wrap gap-1.5 ${m.body ? "mt-2" : ""}`}>
                        {m.files.map((f) => (
                          <a
                            key={f.id}
                            href={loanFileHref("chat", f.id, readOnly)}
                            target="_blank"
                            rel="noreferrer"
                            className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[12px] font-medium ${
                              staff ? "border border-[#E4E7EC] text-[#175CD3]" : "bg-white/15 text-white hover:bg-white/25"
                            }`}
                          >
                            PDF · {f.name}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[#98A2B3]">
                    {when(m.at)}
                    {!staff && m.sendStatus === LoanReferralSendStatus.RECEIVED && " · Delivered"}
                    {!staff && m.sendStatus === LoanReferralSendStatus.SENDING && (
                      <span className="text-[#B54708]"> · Waiting to be delivered</span>
                    )}
                    {!staff && m.sendStatus === LoanReferralSendStatus.FAILED && (
                      <>
                        <span className="text-[#B42318]"> · Not delivered</span>{" "}
                        {!readOnly && (
                        <button
                          type="button"
                          disabled={retry.isPending}
                          onClick={() => void retry.mutateAsync({ publicId: m.publicId }).then(onChanged, onChanged)}
                          className="cursor-pointer font-semibold text-[#1570EF] hover:underline disabled:opacity-50"
                        >
                          Retry
                        </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {readOnly ? (
        <p className="border-t border-[#E4E7EC] px-5 py-3 text-[12px] text-[#98A2B3]">
          Read-only: the partner and the loan counsellor write here.
        </p>
      ) : loan.canMessage ? (
        <ReplyBox publicId={loan.publicId} onSent={onChanged} hasDocList={loan.documents.length > 0} />
      ) : (
        <p className="border-t border-[#E4E7EC] px-5 py-3 text-[12px] text-[#98A2B3]">
          The chat opens once the loan team has received this referral.
        </p>
      )}
    </section>
  );
}

function ReplyBox({
  publicId,
  onSent,
  hasDocList,
}: {
  publicId: string;
  onSent: () => void;
  hasDocList: boolean;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const pick = (list: FileList | null) => {
    setError(null);
    const picked = Array.from(list ?? []);
    const bad = picked.find((f) => !/\.pdf$/i.test(f.name) && f.type !== "application/pdf");
    if (bad) {
      setError(`${bad.name} isn't a PDF. Only PDF files can be sent.`);
      return;
    }
    const big = picked.find((f) => f.size > 10 * 1024 * 1024);
    if (big) {
      setError(`${big.name} is over 10 MB.`);
      return;
    }
    if (files.length + picked.length > 3) setError("Up to 3 PDFs per message.");
    setFiles([...files, ...picked].slice(0, 3));
    setInputKey((k) => k + 1);
  };

  const send = async () => {
    if (!text.trim() && files.length === 0) {
      setError("Write a message or attach a PDF.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("publicId", publicId);
      fd.set("text", text);
      for (const f of files) fd.append("files", f);
      const res = await fetch("/api/partner/loan-message", { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not send the message.");
      setText("");
      setFiles([]);
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the message.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-[#E4E7EC] px-5 py-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
        rows={3}
        placeholder="Message the loan team"
        className="w-full resize-y rounded-lg border border-[#D0D5DD] px-3.5 py-2.5 text-sm text-[#101828] outline-none placeholder:text-[#98A2B3] focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.12)]"
      />
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#F2F4F7] px-2.5 py-1 text-[12px] text-[#344054]"
            >
              {f.name}
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
                className="cursor-pointer text-[#98A2B3] hover:text-[#B42318]"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="mt-2 text-xs text-[#F04438]">{error}</div>}
      {/* Partners attached checklist documents here instead of under
          Documents for the loan (staging test, 19 Nov 2026), where the loan
          team can't review them. Point them to the right place. */}
      {hasDocList && (
        <p className="mt-2 rounded-lg bg-[#F5F9FF] px-3 py-2 text-[12px] text-[#175CD3]">
          Sending a document from the loan team&apos;s list? Upload it under{" "}
          <a href="#documents" className="font-semibold underline">
            Documents for the loan
          </a>{" "}
          so they can review it. Use the chat for anything else.
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <label className="cursor-pointer text-[13px] font-medium text-[#1570EF] hover:underline">
          Attach PDF
          <input
            key={inputKey}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            disabled={files.length >= 3}
            onChange={(e) => pick(e.target.files)}
          />
          <span className="ml-1.5 font-normal text-[#98A2B3]">up to 3, 10 MB each</span>
        </label>
        <Button onClick={() => void send()} loading={busy}>
          Send to loan team
        </Button>
      </div>
    </div>
  );
}

const DOC_GROUPS: { key: "student" | "coapplicant" | "collateral"; label: string }[] = [
  { key: "student", label: "Student" },
  { key: "coapplicant", label: "Co-applicant" },
  { key: "collateral", label: "Collateral (secured loans)" },
];

type DocItem = LoanDetail["documents"][number];
type DocUpload = DocItem["uploads"][number];

// Where one upload stands. Nothing is mandatory (21 Nov 2026): an item with
// no upload shows no badge at all.
function uploadState(u: DocUpload | undefined): { label: string; tone: keyof typeof TONES } | null {
  if (!u) return null;
  if (u.sendStatus === LoanReferralSendStatus.FAILED) return { label: "Not delivered", tone: "red" };
  if (u.sendStatus === LoanReferralSendStatus.SENDING) return { label: "Waiting to be delivered", tone: "amber" };
  if (u.reviewStatus === "accepted") return { label: "Accepted", tone: "green" };
  if (u.reviewStatus === "reupload") return { label: "Upload again", tone: "red" };
  return { label: "With the loan team", tone: "blue" };
}

function StateBadge({ u }: { u: DocUpload | undefined }) {
  const state = uploadState(u);
  if (!state) return null;
  const tone = TONES[state.tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: tone.color, background: tone.bg }}
    >
      {state.label}
    </span>
  );
}

// PDF / JPG / PNG, 1–5 files, 10 MB each: the checks the upload route repeats.
function checkDocFiles(files: File[]): string | null {
  if (files.length === 0) return "Choose a file to upload.";
  if (files.length > 5) return "Up to 5 files at a time.";
  const bad = files.find((f) => !/\.(pdf|jpe?g|png)$/i.test(f.name));
  if (bad) return `${bad.name} isn't a PDF, JPG or PNG.`;
  const big = files.find((f) => f.size > 10 * 1024 * 1024);
  if (big) return `${big.name} is over 10 MB.`;
  return null;
}

async function postLoanDoc(fd: FormData): Promise<void> {
  const res = await fetch("/api/partner/loan-doc", { method: "POST", body: fd });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Could not send the document.");
}

// The loan team's document list for this lead (contract 5): upload per item
// (PDF / JPG / PNG), or send the one already on the student's profile; each
// upload shows the counsellor's review. Below it, Additional documents: any
// other document the counsellor asks for, under the partner's own label.
// Nothing on the list is mandatory. readOnly: the Super Admin's view (no
// uploads, no retries).
export function LoanDocuments({
  loan,
  onChanged,
  readOnly = false,
}: {
  loan: LoanDetail;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const items = loan.documents;
  if (!readOnly && !loan.canMessage) return null;
  const sent = items.filter((i) => i.uploads.length > 0).length;
  const accepted = items.filter((i) => i.uploads[0]?.reviewStatus === "accepted").length;
  const again = items.filter((i) => i.uploads[0]?.reviewStatus === "reupload").length;
  return (
    <section id="documents" className="rounded-2xl border border-[#E4E7EC] bg-white">
      <div className="border-b border-[#E4E7EC] px-5 py-3.5">
        <h2 className="text-sm font-semibold text-[#101828]">Documents for the loan</h2>
        <p className="mt-0.5 text-[12px] text-[#667085]">
          {items.length === 0
            ? "The loan team's document list will appear here shortly."
            : `${sent} of ${items.length} sent · ${accepted} accepted${again ? ` · ${again} to upload again` : ""}. ${
                readOnly ? "" : "Send what you have; "
              }PDF, JPG or PNG, up to 10 MB each.`}
        </p>
      </div>
      {DOC_GROUPS.map((g) => {
        const rows = items.filter((i) => i.group === g.key);
        if (rows.length === 0) return null;
        return (
          <div key={g.key} className="border-b border-[#F2F4F7] last:border-b-0">
            <div className="bg-[#F9FAFB] px-5 py-2 text-[11px] font-semibold tracking-wide text-[#667085] uppercase">
              {g.label}
            </div>
            <ul>
              {rows.map((i) => (
                <DocRow key={i.key} item={i} publicId={loan.publicId} onChanged={onChanged} readOnly={readOnly} />
              ))}
            </ul>
          </div>
        );
      })}
      <AdditionalDocs loan={loan} onChanged={onChanged} readOnly={readOnly} />
    </section>
  );
}

function UploadFiles({
  uploads,
  latest,
  readOnly,
}: {
  uploads: DocUpload[];
  latest: DocUpload | undefined;
  readOnly: boolean;
}) {
  if (uploads.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {uploads.flatMap((u) =>
        u.files.map((f) => (
          <a
            key={f.id}
            href={loanFileHref("doc", f.id, readOnly)}
            target="_blank"
            rel="noreferrer"
            className={`inline-flex items-center rounded-lg border px-2 py-0.5 text-[12px] ${
              u === latest ? "border-[#E4E7EC] text-[#175CD3]" : "border-[#F2F4F7] text-[#98A2B3] line-through"
            }`}
            title={`${u.authorName} · ${when(u.at)}${u.source === "converge_profile" ? " · from the student's profile" : ""}`}
          >
            {f.name}
          </a>
        )),
      )}
    </div>
  );
}

function ReviewNote({ u }: { u: DocUpload | undefined }) {
  if (u?.reviewStatus !== "reupload" || !u.reviewReason) return null;
  return (
    <div className="mt-1 text-[12px] text-[#B42318]">
      {u.reviewedBy ? `${u.reviewedBy}: ` : ""}
      {u.reviewReason}
    </div>
  );
}

function RetryUpload({ u, onChanged, readOnly }: { u: DocUpload | undefined; onChanged: () => void; readOnly: boolean }) {
  const retry = api.loans.partnerRetryDocument.useMutation();
  if (readOnly || u?.sendStatus !== LoanReferralSendStatus.FAILED) return null;
  return (
    <button
      type="button"
      disabled={retry.isPending}
      onClick={() => void retry.mutateAsync({ publicId: u.publicId }).then(onChanged, onChanged)}
      className="mt-1 cursor-pointer text-[12px] font-semibold text-[#1570EF] hover:underline disabled:opacity-50"
    >
      Retry sending
    </button>
  );
}

function UploadButton({ busy, label, onFiles }: { busy: boolean; label: string; onFiles: (files: File[]) => void }) {
  const [inputKey, setInputKey] = useState(0);
  return (
    <label
      className={`inline-flex h-8 cursor-pointer items-center rounded-lg px-3 text-[12px] font-semibold whitespace-nowrap ${
        busy ? "bg-[#F2F4F7] text-[#98A2B3]" : "bg-[#1570EF] text-white hover:bg-[#1260d4]"
      }`}
    >
      {busy ? "Sending…" : label}
      <input
        key={inputKey}
        type="file"
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        multiple
        className="hidden"
        disabled={busy}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          setInputKey((k) => k + 1);
          if (files.length > 0) onFiles(files);
        }}
      />
    </label>
  );
}

function DocRow({
  item,
  publicId,
  onChanged,
  readOnly,
}: {
  item: DocItem;
  publicId: string;
  onChanged: () => void;
  readOnly: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = item.uploads[0];
  const unusedOnFile = item.onFile.filter(
    (f) => !item.uploads.some((u) => u.source === "converge_profile" && u.files.some((x) => x.name === f.name)),
  );

  const send = async (fd: FormData) => {
    setBusy(true);
    setError(null);
    try {
      fd.set("publicId", publicId);
      fd.set("typeKey", item.key);
      await postLoanDoc(fd);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the document.");
    } finally {
      setBusy(false);
    }
  };
  const upload = (files: File[]) => {
    const problem = checkDocFiles(files);
    if (problem) {
      setError(problem);
      return;
    }
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    void send(fd);
  };
  const useOnFile = () => {
    const fd = new FormData();
    for (const f of unusedOnFile) fd.append("profileDocIds", String(f.id));
    void send(fd);
  };

  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-[#101828]">
          {item.label}
          <StateBadge u={latest} />
        </div>
        <ReviewNote u={latest} />
        <UploadFiles uploads={item.uploads} latest={latest} readOnly={readOnly} />
        <RetryUpload u={latest} onChanged={onChanged} readOnly={readOnly} />
        {error && <div className="mt-1 text-[12px] text-[#F04438]">{error}</div>}
      </div>
      {!readOnly && latest?.reviewStatus !== "accepted" && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {unusedOnFile.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={useOnFile}
              className="h-8 cursor-pointer rounded-lg border border-[#B2CCFF] bg-[#F5F9FF] px-3 text-[12px] font-semibold whitespace-nowrap text-[#175CD3] hover:bg-[#EFF4FF] disabled:opacity-50"
              title={unusedOnFile.map((f) => f.name).join(", ")}
            >
              Use the one on file
            </button>
          )}
          <UploadButton busy={busy} label={latest ? "Upload again" : "Upload"} onFiles={upload} />
        </div>
      )}
    </li>
  );
}

// Additional documents (contract 5c): anything outside the list that the
// counsellor asks for on this case, each under a label the partner types.
// Each upload is its own row with its own review; "Upload again" on one the
// counsellor sent back sends a new copy under the same label.
function AdditionalDocs({ loan, onChanged, readOnly }: { loan: LoanDetail; onChanged: () => void; readOnly: boolean }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = loan.additional;
  const canUpload = !readOnly && loan.canMessage;
  if (!canUpload && rows.length === 0) return null;

  const send = async (name: string, files: File[], key: string) => {
    setError(null);
    const clean = name.replace(/\s+/g, " ").trim();
    if (clean.length < 2) {
      setError("Name the document first, for example: Father's bank statement (Apr–Sep).");
      return;
    }
    const problem = checkDocFiles(files);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(key);
    try {
      const fd = new FormData();
      fd.set("publicId", loan.publicId);
      fd.set("typeKey", ADDITIONAL_DOC_KEY);
      fd.set("label", clean);
      for (const f of files) fd.append("files", f);
      await postLoanDoc(fd);
      if (key === "new") setLabel("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the document.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-[#F2F4F7]">
      <div className="bg-[#F9FAFB] px-5 py-2 text-[11px] font-semibold tracking-wide text-[#667085] uppercase">
        Additional documents
      </div>
      {rows.length > 0 && (
        <ul>
          {rows.map((u) => (
            <li key={u.publicId} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-[#101828]">
                  {u.label ?? "Additional document"}
                  <StateBadge u={u} />
                </div>
                <ReviewNote u={u} />
                <UploadFiles uploads={[u]} latest={u} readOnly={readOnly} />
                <RetryUpload u={u} onChanged={onChanged} readOnly={readOnly} />
              </div>
              {canUpload && u.reviewStatus === "reupload" && (
                <div className="shrink-0">
                  <UploadButton
                    busy={busy === u.publicId}
                    label="Upload again"
                    onFiles={(files) => void send(u.label ?? "", files, u.publicId)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <div className="px-5 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={ADDITIONAL_DOC_LABEL_MAX}
              placeholder="Name the document, e.g. Father's bank statement (Apr–Sep)"
              className="h-8 min-w-0 flex-1 rounded-lg border border-[#D0D5DD] px-3 text-[13px] text-[#101828] outline-none placeholder:text-[#98A2B3] focus:border-[#84ADFF] focus:ring-2 focus:ring-[#D1E0FF]"
            />
            <UploadButton busy={busy === "new"} label="Choose files and send" onFiles={(files) => void send(label, files, "new")} />
          </div>
          <p className="mt-1.5 text-[12px] text-[#98A2B3]">
            Anything the loan team asks for that isn&apos;t on the list above. Add as many as you need.
          </p>
        </div>
      )}
      {error && <div className="px-5 pb-3 text-[12px] text-[#F04438]">{error}</div>}
    </div>
  );
}
