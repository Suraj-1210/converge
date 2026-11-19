"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Modal } from "~/components/ui/modal";
import {
  COURSE_LEVEL_OPTIONS,
  INTAKE_OPTIONS,
} from "~/components/students/status";
import { LOAN_CONSENT_TEXT } from "~/lib/loan-sharing";
import { api, type RouterOutputs } from "~/trpc/react";
import { fileProblem, uploadOne } from "./upload-documents-modal";

// ----- Shared constants ----------------------------------------------------

// ISO2 → display name. Local to the partner students page (same convention as
// the uni-assist page) to avoid a shared-data dep. Covers the destination
// countries offered in the Add Student form plus a couple of extras that may
// appear on admin-created records.
export const COUNTRY_NAME: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  IE: "Ireland",
  NZ: "New Zealand",
  SG: "Singapore",
  FR: "France",
  NL: "Netherlands",
  AE: "United Arab Emirates",
  IN: "India",
};

// Destination options for the form, in mock order.
export const DESTINATION_COUNTRIES = [
  "US",
  "GB",
  "CA",
  "AU",
  "DE",
  "IE",
  "NZ",
  "SG",
  "FR",
  "NL",
  "AE",
];

export const PHONE_CODES = ["+91", "+1", "+44", "+61", "+49", "+33", "+971", "+65"];

// Expected national-number digit count per dialling code.
export const PHONE_LEN: Record<string, number> = {
  "+91": 10,
  "+1": 10,
  "+44": 10,
  "+61": 9,
  "+49": 11,
  "+33": 9,
  "+971": 9,
  "+65": 8,
};

const PROGRAM_OPTIONS = [
  "Computer Science",
  "Data Science",
  "Business Analytics",
  "MBA / Business Admin",
  "Finance",
  "Engineering",
  "Mechanical Engineering",
  "Civil Engineering",
  "Psychology",
  "Physics",
  "Information Technology",
  "Nursing",
  "Pharmacy",
  "Architecture",
  "Law",
  "Media & Communications",
];

// Uploaded with the registration itself (19 Nov): a partner can't add a
// student without them. Keys are the student document types.
export const MANDATORY_DOCS = [
  { key: "passport", label: "Passport" },
  { key: "resume", label: "Updated CV / Resume" },
] as const;
type MandatoryKey = (typeof MANDATORY_DOCS)[number]["key"];
type DocFiles = Record<MandatoryKey, File | null>;
const noFiles = (): DocFiles => ({ passport: null, resume: null });

// ----- Types ----------------------------------------------------------------

type CreateResult = RouterOutputs["students"]["partnerCreate"];
type Duplicate = Extract<CreateResult, { ok: false }>["duplicate"];
export type CreatedStudent = Extract<CreateResult, { ok: true }>["student"];

interface FormState {
  firstName: string;
  lastName: string;
  countryCode: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  country: string;
  intake: string;
  courseLevel: string;
  interestedProgram: string;
  educationLoan: boolean | null;
  // Asked when Education loan = Yes: the lead goes to the loan team on save.
  loanConsent: boolean;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

const emptyForm = (): FormState => ({
  firstName: "",
  lastName: "",
  countryCode: "+91",
  phone: "",
  email: "",
  dateOfBirth: "",
  country: "",
  intake: "",
  courseLevel: "",
  interestedProgram: "",
  educationLoan: null,
  loanConsent: false,
});

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.firstName.trim()) errors.firstName = "First name is required";
  if (!form.lastName.trim()) errors.lastName = "Last name is required";

  const digits = form.phone.replace(/\D/g, "");
  const expected = PHONE_LEN[form.countryCode] ?? 10;
  if (!digits) errors.phone = "Phone number is required";
  else if (digits.length !== expected)
    errors.phone = `Enter a valid ${expected}-digit phone number for ${form.countryCode}`;

  if (!form.email.trim()) errors.email = "Email is required";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
    errors.email = "Enter a valid email address";

  if (!form.dateOfBirth) errors.dateOfBirth = "Date of birth is required";

  if (!form.country) errors.country = "Country preference is required";
  if (!form.intake) errors.intake = "Intake is required";
  if (form.courseLevel === "") errors.courseLevel = "Level is required";
  if (!form.interestedProgram)
    errors.interestedProgram = "Interested program is required";
  if (form.educationLoan === null)
    errors.educationLoan = "Please choose Yes or No";
  if (form.educationLoan === true && !form.loanConsent)
    errors.loanConsent = "Confirm the student agreed to be contacted by the loan team";
  return errors;
}

// ----- Modal -----------------------------------------------------------------

export function AddStudentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (student: CreatedStudent) => void;
}) {
  const utils = api.useUtils();
  const createStudent = api.students.partnerCreate.useMutation();

  const [form, setForm] = useState<FormState>(emptyForm());
  const [errors, setErrors] = useState<FormErrors>({});
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [files, setFiles] = useState<DocFiles>(noFiles());
  const [fileErrors, setFileErrors] = useState<Partial<Record<MandatoryKey, string>>>({});
  const [uploading, setUploading] = useState(false);
  // Created, but a document didn't upload: offer a retry for just those.
  const [partial, setPartial] = useState<{
    student: CreatedStudent;
    failed: { key: MandatoryKey; label: string; error: string }[];
  } | null>(null);

  const pickFile = (key: MandatoryKey, f: File | null) => {
    setFiles((cur) => ({ ...cur, [key]: f }));
    setFileErrors((e) => ({ ...e, [key]: f ? (fileProblem(f) ?? undefined) : undefined }));
  };

  // Upload the mandatory files for a just-created student; returns failures.
  const uploadDocs = async (studentId: number, keys: MandatoryKey[]) => {
    const failed: { key: MandatoryKey; label: string; error: string }[] = [];
    for (const d of MANDATORY_DOCS) {
      const f = files[d.key];
      if (!keys.includes(d.key) || !f) continue;
      try {
        await uploadOne(studentId, d.key, f);
      } catch (err) {
        failed.push({ key: d.key, label: d.label, error: err instanceof Error ? err.message : "Upload failed" });
      }
    }
    return failed;
  };

  const finish = async (student: CreatedStudent) => {
    await utils.students.partnerList.invalidate();
    setForm(emptyForm());
    setErrors({});
    setFiles(noFiles());
    setFileErrors({});
    setPartial(null);
    onCreated(student);
  };

  const retryUploads = async () => {
    if (!partial) return;
    setUploading(true);
    const failed = await uploadDocs(partial.student.id, partial.failed.map((f) => f.key));
    setUploading(false);
    if (failed.length === 0) await finish(partial.student);
    else setPartial({ ...partial, failed });
  };

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  // Keep typed values on accidental close (backdrop click); only the
  // transient error/duplicate state resets. Form clears after a success.
  const handleClose = () => {
    // Closing after a partial upload: the student exists, so finish (the list
    // shows what's still missing).
    if (partial) {
      void finish(partial.student);
      return;
    }
    setDuplicate(null);
    setSubmitError(null);
    onClose();
  };

  const handleSubmit = async () => {
    const nextErrors = validate(form);
    setErrors(nextErrors);
    const nextFileErrors: Partial<Record<MandatoryKey, string>> = {};
    for (const d of MANDATORY_DOCS) {
      const f = files[d.key];
      const problem = f ? fileProblem(f) : `${d.label} is required`;
      if (problem) nextFileErrors[d.key] = problem;
    }
    setFileErrors(nextFileErrors);
    if (Object.keys(nextErrors).length > 0 || Object.keys(nextFileErrors).length > 0) return;
    setSubmitError(null);
    try {
      const res = await createStudent.mutateAsync({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        countryCode: form.countryCode,
        phone: form.phone.replace(/\s+/g, " ").trim(),
        dateOfBirth: form.dateOfBirth,
        country: form.country,
        intake: form.intake,
        courseLevel: Number(form.courseLevel),
        interestedProgram: form.interestedProgram,
        educationLoan: form.educationLoan === true,
        loanConsent: form.educationLoan === true && form.loanConsent,
      });
      if (!res.ok) {
        setDuplicate(res.duplicate);
        return;
      }
      setUploading(true);
      const failed = await uploadDocs(res.student.id, MANDATORY_DOCS.map((d) => d.key));
      setUploading(false);
      if (failed.length > 0) {
        setPartial({ student: res.student, failed });
        return;
      }
      await finish(res.student);
    } catch (err) {
      setUploading(false);
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
    }
  };

  const expectedDigits = PHONE_LEN[form.countryCode] ?? 10;

  return (
    <Modal
      open={open}
      title={partial ? "Student Added: Documents Pending" : duplicate ? "Duplicate Student Found" : "Add New Student"}
      onClose={handleClose}
      width="w-[640px]"
      footer={
        partial ? (
          <>
            <Button variant="secondary" onClick={handleClose} disabled={uploading}>
              Upload later
            </Button>
            <Button onClick={() => void retryUploads()} loading={uploading}>
              Retry upload
            </Button>
          </>
        ) : duplicate ? (
          <>
            <Button variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={() => setDuplicate(null)}>Back to Form</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} loading={createStudent.isPending || uploading}>
              {uploading ? "Uploading documents…" : "Add Student"}
            </Button>
          </>
        )
      }
    >
      {partial ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-[#FEDF89] bg-[#FFFAEB] p-4 text-sm text-[#B54708]">
            {partial.student.firstName} {partial.student.lastName} was added as CP-{partial.student.id},
            but {partial.failed.length === 1 ? "this document" : "these documents"} didn&apos;t upload.
            Retry now, or upload {partial.failed.length === 1 ? "it" : "them"} later from the student&apos;s Documents.
          </div>
          <ul className="space-y-1.5 text-sm">
            {partial.failed.map((f) => (
              <li key={f.key} className="text-[#344054]">
                <span className="font-semibold">{f.label}</span>
                <span className="text-[#B42318]"> · {f.error}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : duplicate ? (
        <DuplicateNotice duplicate={duplicate} />
      ) : (
        <>
          <Section title="Student Details">
            <div className="flex flex-col gap-3 sm:flex-row">
              <FormInput
                label="First Name"
                required
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                placeholder="e.g. Aarav"
                error={Boolean(errors.firstName)}
                errorMessage={errors.firstName}
              />
              <FormInput
                label="Last Name"
                required
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                placeholder="e.g. Sharma"
                error={Boolean(errors.lastName)}
                errorMessage={errors.lastName}
              />
            </div>
          </Section>

          <Section title="Contact Details">
            <div className="flex gap-3">
              <div className="w-[110px] shrink-0">
                <FormSelect
                  label="Code"
                  options={PHONE_CODES.map((c) => ({ value: c, label: c }))}
                  value={form.countryCode}
                  onChange={(e) => {
                    set("countryCode", e.target.value);
                    // Length rules changed — clear a stale phone error.
                    setErrors((prev) => {
                      if (!prev.phone) return prev;
                      const next = { ...prev };
                      delete next.phone;
                      return next;
                    });
                  }}
                />
              </div>
              <FormInput
                label="Phone Number"
                required
                inputMode="numeric"
                value={form.phone}
                onChange={(e) =>
                  set("phone", e.target.value.replace(/[^0-9 ]/g, ""))
                }
                placeholder={`${expectedDigits}-digit number`}
                error={Boolean(errors.phone)}
                errorMessage={errors.phone}
              />
            </div>
            <FormInput
              label="Email"
              required
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="student@example.com"
              error={Boolean(errors.email)}
              errorMessage={errors.email}
            />
            <FormInput
              label="Date of Birth"
              required
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => set("dateOfBirth", e.target.value)}
              error={Boolean(errors.dateOfBirth)}
              errorMessage={errors.dateOfBirth}
            />
          </Section>

          <Section title="Academic Preferences">
            <div className="flex flex-col gap-3 sm:flex-row">
              <FormSelect
                label="Country Preference"
                required
                placeholder="Select country"
                options={DESTINATION_COUNTRIES.map((c) => ({
                  value: c,
                  label: COUNTRY_NAME[c] ?? c,
                }))}
                value={form.country}
                onChange={(e) => set("country", e.target.value)}
                error={Boolean(errors.country)}
                errorMessage={errors.country}
              />
              <FormSelect
                label="Intake"
                required
                placeholder="Select intake"
                options={INTAKE_OPTIONS.map((i) => ({ value: i, label: i }))}
                value={form.intake}
                onChange={(e) => set("intake", e.target.value)}
                error={Boolean(errors.intake)}
                errorMessage={errors.intake}
              />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <FormSelect
                label="Level"
                required
                placeholder="Select level"
                options={COURSE_LEVEL_OPTIONS.map((o) => ({
                  value: String(o.value),
                  label: o.label,
                }))}
                value={form.courseLevel}
                onChange={(e) => set("courseLevel", e.target.value)}
                error={Boolean(errors.courseLevel)}
                errorMessage={errors.courseLevel}
              />
              <FormSelect
                label="Interested Program"
                required
                placeholder="Select program"
                options={PROGRAM_OPTIONS.map((p) => ({ value: p, label: p }))}
                value={form.interestedProgram}
                onChange={(e) => set("interestedProgram", e.target.value)}
                error={Boolean(errors.interestedProgram)}
                errorMessage={errors.interestedProgram}
              />
            </div>
          </Section>

          <Section title="Additional Information">
            <YesNoRadio
              label="Is your student interested in applying for an education loan through Collegepond?"
              name="education-loan"
              required
              value={form.educationLoan}
              onChange={(v) => set("educationLoan", v)}
              errorMessage={errors.educationLoan}
            />
            {form.educationLoan === true && (
              <div className="rounded-lg border border-[#D1E9FF] bg-[#F5FAFF] p-3">
                <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-[#344054]">
                  <input
                    type="checkbox"
                    checked={form.loanConsent}
                    onChange={(e) => set("loanConsent", e.target.checked)}
                    className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-[#1570EF]"
                  />
                  <span>
                    {LOAN_CONSENT_TEXT} <span className="text-[#F04438]">*</span>
                  </span>
                </label>
                <p className="mt-1.5 ml-7 text-xs text-[#667085]">
                  We&apos;ll pass the student to Collegepond&apos;s loan team when you save. Follow their progress under
                  Loans.
                </p>
                {errors.loanConsent && <div className="mt-1 ml-7 text-xs text-[#F04438]">{errors.loanConsent}</div>}
              </div>
            )}
          </Section>

          <Section title="Mandatory Documents">
            <p className="-mt-1 text-xs text-[#667085]">PDF only, up to 10 MB each.</p>
            {MANDATORY_DOCS.map((d) => (
              <FilePick
                key={d.key}
                label={d.label}
                file={files[d.key]}
                error={fileErrors[d.key]}
                onPick={(f) => pickFile(d.key, f)}
              />
            ))}
          </Section>

          {submitError && (
            <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-3 text-sm text-[#B42318]">
              {submitError}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ----- Duplicate notice ------------------------------------------------------

function DuplicateNotice({ duplicate }: { duplicate: Duplicate }) {
  const matchedLabel =
    duplicate.matchedOn === "email" ? "email address" : "phone number";
  return (
    <>
      <div className="rounded-lg border border-[#FEDF89] bg-[#FFFAEB] p-4 text-sm text-[#B54708]">
        A student with this {matchedLabel} already exists in your account.
        Please review the existing record below.
      </div>
      <div className="rounded-lg border border-[#E4E7EC] p-4">
        <div className="text-sm font-semibold text-[#101828]">
          {duplicate.name}
        </div>
        <div className="text-xs text-[#98A2B3]">CP-{duplicate.id}</div>
        <dl className="mt-3 space-y-1.5 text-sm">
          <DuplicateRow
            label="Email"
            value={duplicate.email ?? "—"}
            highlight={duplicate.matchedOn === "email"}
          />
          <DuplicateRow
            label="Phone"
            value={duplicate.phone ?? "—"}
            highlight={duplicate.matchedOn === "phone"}
          />
          <DuplicateRow label="Organisation" value={duplicate.orgName} />
        </dl>
      </div>
    </>
  );
}

function DuplicateRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-[100px] shrink-0 text-[#667085]">{label}</dt>
      <dd
        className={
          highlight ? "font-semibold text-[#B42318]" : "text-[#344054]"
        }
      >
        {value}
        {highlight && (
          <span className="ml-2 rounded-full bg-[#FEF3F2] px-2 py-0.5 text-[11px] font-semibold text-[#B42318]">
            Matched
          </span>
        )}
      </dd>
    </div>
  );
}

// ----- Small atoms -----------------------------------------------------------

function FilePick({
  label,
  file,
  error,
  onPick,
}: {
  label: string;
  file: File | null;
  error?: string;
  onPick: (f: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-[#344054]">
        {label} <span className="text-[#F04438]">*</span>
      </div>
      <div
        className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
          error ? "border-[#FDA29B]" : "border-[#D0D5DD]"
        }`}
      >
        <span className={`min-w-0 flex-1 truncate text-sm ${file ? "text-[#101828]" : "text-[#98A2B3]"}`}>
          {file ? file.name : "No file chosen"}
        </span>
        {file && (
          <button
            type="button"
            onClick={() => {
              onPick(null);
              if (ref.current) ref.current.value = "";
            }}
            className="cursor-pointer text-xs font-semibold text-[#667085] hover:text-[#B42318]"
          >
            Remove
          </button>
        )}
        <button
          type="button"
          onClick={() => ref.current?.click()}
          className="h-8 shrink-0 cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-xs font-semibold text-[#344054] hover:bg-[#F9FAFB]"
        >
          {file ? "Change" : "Choose PDF"}
        </button>
        <input
          ref={ref}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
      </div>
      {error && <div className="mt-1 text-xs text-[#F04438]">{error}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="border-b border-[#F2F4F7] pb-1.5 text-[11px] font-bold tracking-[0.06em] text-[#98A2B3] uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function YesNoRadio({
  label,
  name,
  required,
  value,
  onChange,
  errorMessage,
}: {
  label: string;
  name: string;
  required?: boolean;
  value: boolean | null;
  onChange: (v: boolean) => void;
  errorMessage?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-[#344054]">
        {label} {required && <span className="text-[#F04438]">*</span>}
      </div>
      <div className="flex gap-5">
        {[true, false].map((opt) => (
          <label
            key={String(opt)}
            className="flex cursor-pointer items-center gap-2 text-sm text-[#344054]"
          >
            <input
              type="radio"
              name={name}
              checked={value === opt}
              onChange={() => onChange(opt)}
              className="h-4 w-4 accent-[#1570EF]"
            />
            {opt ? "Yes" : "No"}
          </label>
        ))}
      </div>
      {errorMessage && (
        <div className="mt-1 text-xs text-[#F04438]">{errorMessage}</div>
      )}
    </div>
  );
}
