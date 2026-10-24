"use client";

import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Modal } from "~/components/ui/modal";
import {
  COURSE_LEVEL_OPTIONS,
  INTAKE_OPTIONS,
} from "~/components/students/status";
import { api, type RouterOutputs } from "~/trpc/react";

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
const DESTINATION_COUNTRIES = [
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

const PHONE_CODES = ["+91", "+1", "+44", "+61", "+49", "+33", "+971", "+65"];

// Expected national-number digit count per dialling code.
const PHONE_LEN: Record<string, number> = {
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
    setDuplicate(null);
    setSubmitError(null);
    onClose();
  };

  const handleSubmit = async () => {
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
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
      });
      if (!res.ok) {
        setDuplicate(res.duplicate);
        return;
      }
      await utils.students.partnerList.invalidate();
      setForm(emptyForm());
      setErrors({});
      onCreated(res.student);
    } catch (err) {
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
      title={duplicate ? "Duplicate Student Found" : "Add New Student"}
      onClose={handleClose}
      width="w-[640px]"
      footer={
        duplicate ? (
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
            <Button onClick={handleSubmit} loading={createStudent.isPending}>
              Add Student
            </Button>
          </>
        )
      }
    >
      {duplicate ? (
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
