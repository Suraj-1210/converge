"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { INTAKE_OPTIONS } from "~/components/students/status";
import { useStudentProfileApi } from "./profile-api";
import {
  ADD_COUNTRY_OPTIONS,
  COURSE_LEVEL_SELECT_OPTIONS,
  EMAIL_REGEX,
  GENDER_SELECT_OPTIONS,
  NATIONALITY_OPTIONS,
  PHONE_CODES,
  PHONE_LENGTH,
  PROGRAM_OPTIONS,
  displayId,
  splitPhone,
  type AdminStudentFull,
} from "../lib";
import {
  ADDRESS_COUNTRIES,
  MARITAL_STATUS_OPTIONS,
  RELATIONSHIP_OPTIONS,
  YES_NO_OPTIONS,
  strOrNull,
} from "./profile-lib";
import { AcademicTab } from "./academic-tab";
import { TestsTab } from "./tests-tab";
import { WorkTab } from "./work-tab";

const SUB_TABS = [
  { id: "personal", label: "Personal Information" },
  { id: "academic", label: "Academic Qualification" },
  { id: "work", label: "Work Experience" },
  { id: "tests", label: "Tests" },
] as const;

type SubTabId = (typeof SUB_TABS)[number]["id"];

export function ProfileTab({
  student,
  onToast,
}: {
  student: AdminStudentFull;
  onToast: (msg: string) => void;
}) {
  const [subTab, setSubTab] = useState<SubTabId>("personal");

  return (
    <>
      {/* Profile sub-tabs */}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-[#E4E7EC]">
        {SUB_TABS.map((t) => {
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`-mb-px cursor-pointer border-b-2 px-3.5 py-2 text-[13px] font-semibold whitespace-nowrap transition ${
                active
                  ? "border-[#1570EF] text-[#1570EF]"
                  : "border-transparent text-[#667085] hover:text-[#1570EF]"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {subTab === "personal" && (
        <PersonalInfoForm student={student} onToast={onToast} />
      )}
      {subTab === "academic" && (
        <AcademicTab student={student} onToast={onToast} />
      )}
      {subTab === "work" && <WorkTab student={student} onToast={onToast} />}
      {subTab === "tests" && <TestsTab student={student} onToast={onToast} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Personal Information
// ---------------------------------------------------------------------------

interface ContactDraft {
  relationship: string;
  name: string;
  email: string;
  phoneCode: string;
  phone: string;
}

interface ProfileForm {
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  phoneCode: string;
  phone: string;
  dateOfBirth: string;
  gender: string;
  maritalStatus: string;
  mailA1: string;
  mailA2: string;
  mailCity: string;
  mailState: string;
  mailCountry: string;
  mailPostal: string;
  permSame: boolean;
  permA1: string;
  permA2: string;
  permCity: string;
  permState: string;
  permCountry: string;
  permPostal: string;
  nationality: string;
  dualCitizenship: string;
  passportNumber: string;
  passportExpiry: string;
  visaRefused: string;
  visaRefusedDetails: string;
  criminalRecord: string;
  criminalRecordDetails: string;
  medicalCondition: string;
  medicalConditionDetails: string;
  country: string;
  intake: string;
  courseLevel: string;
  program: string;
  educationLoan: boolean | null;
  contacts: ContactDraft[];
}

const triBool = (v: boolean | null): string =>
  v === null ? "" : v ? "yes" : "no";
const ynToBool = (s: string): boolean | null =>
  s === "" ? null : s === "yes";

function buildForm(s: AdminStudentFull): ProfileForm {
  const { code, number } = splitPhone(s.phone);
  return {
    firstName: s.firstName,
    middleName: s.middleName ?? "",
    lastName: s.lastName,
    email: s.email ?? "",
    phoneCode: code,
    phone: number,
    dateOfBirth: s.dateOfBirth ?? "",
    gender: s.gender === null ? "" : String(s.gender),
    maritalStatus: s.maritalStatus === null ? "" : String(s.maritalStatus),
    mailA1: s.mailingAddress1 ?? "",
    mailA2: s.mailingAddress2 ?? "",
    mailCity: s.mailingCity ?? "",
    mailState: s.mailingState ?? "",
    mailCountry: s.mailingCountry ?? "",
    mailPostal: s.mailingPostal ?? "",
    permSame: s.permanentSameAsMailing,
    permA1: s.permanentAddress1 ?? "",
    permA2: s.permanentAddress2 ?? "",
    permCity: s.permanentCity ?? "",
    permState: s.permanentState ?? "",
    permCountry: s.permanentCountry ?? "",
    permPostal: s.permanentPostal ?? "",
    nationality: s.nationality ?? "",
    dualCitizenship: triBool(s.dualCitizenship),
    passportNumber: s.passportNumber ?? "",
    passportExpiry: s.passportExpiry ?? "",
    visaRefused: triBool(s.visaRefused),
    visaRefusedDetails: s.visaRefusedDetails ?? "",
    criminalRecord: triBool(s.criminalRecord),
    criminalRecordDetails: s.criminalRecordDetails ?? "",
    medicalCondition: triBool(s.medicalCondition),
    medicalConditionDetails: s.medicalConditionDetails ?? "",
    country: s.country ?? "",
    intake: s.intake ?? "",
    courseLevel: s.courseLevel === null ? "" : String(s.courseLevel),
    program: s.interestedProgram ?? "",
    educationLoan: s.educationLoan,
    contacts: s.emergencyContacts.map((c) => {
      const p = splitPhone(c.phone);
      return {
        relationship: String(c.relationship),
        name: c.name,
        email: c.email ?? "",
        phoneCode: p.code,
        phone: p.number,
      };
    }),
  };
}

const emptyContact = (): ContactDraft => ({
  relationship: "",
  name: "",
  email: "",
  phoneCode: "+91",
  phone: "",
});

function PersonalInfoForm({
  student,
  onToast,
}: {
  student: AdminStudentFull;
  onToast: (msg: string) => void;
}) {
  const profileApi = useStudentProfileApi();
  const refresh = profileApi.useRefresh();
  const [form, setForm] = useState<ProfileForm>(() => buildForm(student));

  // Re-seed only when navigating to a different student — a background
  // refetch shouldn't clobber in-progress edits.
  useEffect(() => {
    setForm(buildForm(student));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id]);

  const set = (patch: Partial<ProfileForm>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const setContact = (i: number, patch: Partial<ContactDraft>) =>
    setForm((prev) => ({
      ...prev,
      contacts: prev.contacts.map((c, idx) =>
        idx === i ? { ...c, ...patch } : c,
      ),
    }));

  const updateMut = profileApi.useUpdateProfile({
    onSuccess: (res) => {
      if (!res.ok) {
        onToast(
          `Another student (${res.duplicate.name}, ${displayId(res.duplicate.id)}) already uses this ${
            res.duplicate.matchedOn === "email" ? "email address" : "phone number"
          }`,
        );
        return;
      }
      refresh(student.id);
      onToast("Profile saved");
    },
    onError: (err) => onToast(err.message),
  });

  const save = () => {
    const required = [
      form.firstName,
      form.lastName,
      form.email,
      form.phone,
      form.country,
      form.intake,
      form.courseLevel,
      form.program,
    ];
    if (required.some((v) => !v.trim())) {
      onToast("Please fill in all required fields");
      return;
    }
    if (!EMAIL_REGEX.test(form.email.trim())) {
      onToast("Please enter a valid email address");
      return;
    }
    const digits = form.phone.replace(/\D/g, "");
    const requiredLen = PHONE_LENGTH[form.phoneCode] ?? 10;
    if (digits.length !== requiredLen) {
      onToast(`Phone number must be ${requiredLen} digits for ${form.phoneCode}`);
      return;
    }
    const contacts = form.contacts.filter(
      (c) => c.name.trim() || c.email.trim() || c.phone.trim(),
    );
    for (const c of contacts) {
      if (!c.name.trim() || c.relationship === "") {
        onToast("Emergency contacts need at least a relationship and a name");
        return;
      }
      if (c.email.trim() && !EMAIL_REGEX.test(c.email.trim())) {
        onToast(`Invalid email for emergency contact ${c.name.trim()}`);
        return;
      }
    }
    if (!form.dateOfBirth) {
      onToast("Date of birth is required");
      return;
    }
    if (form.educationLoan === null) {
      onToast("Please answer the education loan question");
      return;
    }
    updateMut.mutate({
      id: student.id,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      countryCode: form.phoneCode,
      phone: form.phone.trim(),
      dateOfBirth: form.dateOfBirth,
      gender: form.gender ? Number(form.gender) : null,
      nationality: form.nationality || null,
      country: form.country,
      intake: form.intake,
      courseLevel: Number(form.courseLevel),
      interestedProgram: form.program,
      educationLoan: form.educationLoan,
      middleName: strOrNull(form.middleName),
      maritalStatus: form.maritalStatus ? Number(form.maritalStatus) : null,
      mailingAddress1: strOrNull(form.mailA1),
      mailingAddress2: strOrNull(form.mailA2),
      mailingCity: strOrNull(form.mailCity),
      mailingState: strOrNull(form.mailState),
      mailingCountry: form.mailCountry || null,
      mailingPostal: strOrNull(form.mailPostal),
      permanentSameAsMailing: form.permSame,
      permanentAddress1: strOrNull(form.permA1),
      permanentAddress2: strOrNull(form.permA2),
      permanentCity: strOrNull(form.permCity),
      permanentState: strOrNull(form.permState),
      permanentCountry: form.permCountry || null,
      permanentPostal: strOrNull(form.permPostal),
      dualCitizenship: ynToBool(form.dualCitizenship),
      passportNumber: strOrNull(form.passportNumber),
      passportExpiry: form.passportExpiry || null,
      visaRefused: ynToBool(form.visaRefused),
      visaRefusedDetails: strOrNull(form.visaRefusedDetails),
      criminalRecord: ynToBool(form.criminalRecord),
      criminalRecordDetails: strOrNull(form.criminalRecordDetails),
      medicalCondition: ynToBool(form.medicalCondition),
      medicalConditionDetails: strOrNull(form.medicalConditionDetails),
      emergencyContacts: contacts.map((c) => ({
        relationship: Number(c.relationship),
        name: c.name.trim(),
        email: strOrNull(c.email),
        phone: c.phone.trim() ? `${c.phoneCode} ${c.phone.trim()}` : null,
      })),
    });
  };

  // "Same as mailing" mirrors the mailing fields into the (disabled)
  // permanent inputs; the server copies the values on save.
  const perm = form.permSame
    ? {
        a1: form.mailA1,
        a2: form.mailA2,
        city: form.mailCity,
        state: form.mailState,
        country: form.mailCountry,
        postal: form.mailPostal,
      }
    : {
        a1: form.permA1,
        a2: form.permA2,
        city: form.permCity,
        state: form.permState,
        country: form.permCountry,
        postal: form.permPostal,
      };

  return (
    <div className="rounded-[14px] border border-[#E4E7EC] bg-white p-7">
      <SectionHeader icon={<UserIcon />} title="Basic Information" first />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <FormInput
          label="First Name"
          required
          value={form.firstName}
          onChange={(e) => set({ firstName: e.target.value })}
        />
        <FormInput
          label="Middle Name"
          placeholder="Enter middle name"
          value={form.middleName}
          onChange={(e) => set({ middleName: e.target.value })}
        />
        <FormInput
          label="Last Name"
          required
          value={form.lastName}
          onChange={(e) => set({ lastName: e.target.value })}
        />
      </div>

      <SectionHeader icon={<MailIcon />} title="Contact Information" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <FormInput
          label="Email Address"
          required
          type="email"
          value={form.email}
          onChange={(e) => set({ email: e.target.value })}
        />
        <PhoneField
          label="Telephone #"
          required
          code={form.phoneCode}
          number={form.phone}
          onCode={(phoneCode) => set({ phoneCode })}
          onNumber={(phone) => set({ phone })}
        />
      </div>

      <SectionHeader icon={<IdIcon />} title="Personal Details" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <FormInput
          label="Date of Birth"
          type="date"
          value={form.dateOfBirth}
          onChange={(e) => set({ dateOfBirth: e.target.value })}
        />
        <FormSelect
          label="Gender"
          placeholder="Select gender..."
          options={GENDER_SELECT_OPTIONS}
          value={form.gender}
          onChange={(e) => set({ gender: e.target.value })}
        />
        <FormSelect
          label="Marital Status"
          placeholder="Select status..."
          options={MARITAL_STATUS_OPTIONS}
          value={form.maritalStatus}
          onChange={(e) => set({ maritalStatus: e.target.value })}
        />
      </div>

      <SectionHeader icon={<HomeIcon />} title="Mailing Address" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormInput
            label="Address Line 1"
            placeholder="Street address, P.O. box"
            value={form.mailA1}
            onChange={(e) => set({ mailA1: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <FormInput
            label="Address Line 2"
            placeholder="Apartment, suite, unit, building, floor"
            value={form.mailA2}
            onChange={(e) => set({ mailA2: e.target.value })}
          />
        </div>
        <FormInput
          label="City"
          value={form.mailCity}
          onChange={(e) => set({ mailCity: e.target.value })}
        />
        <FormInput
          label="State / Province"
          value={form.mailState}
          onChange={(e) => set({ mailState: e.target.value })}
        />
        <FormSelect
          label="Country"
          placeholder="Select country..."
          options={ADDRESS_COUNTRIES.map((c) => ({ value: c, label: c }))}
          value={form.mailCountry}
          onChange={(e) => set({ mailCountry: e.target.value })}
        />
        <FormInput
          label="Postal Code"
          value={form.mailPostal}
          onChange={(e) => set({ mailPostal: e.target.value })}
        />
      </div>

      <SectionHeader icon={<HomeIcon />} title="Permanent Address" />
      <label className="mb-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-[#344054]">
        <input
          type="checkbox"
          checked={form.permSame}
          onChange={(e) => set({ permSame: e.target.checked })}
          className="h-4 w-4 cursor-pointer accent-[#1570EF]"
        />
        Same as Mailing Address
      </label>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormInput
            label="Address Line 1"
            placeholder="Street address, P.O. box"
            disabled={form.permSame}
            value={perm.a1}
            onChange={(e) => set({ permA1: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <FormInput
            label="Address Line 2"
            placeholder="Apartment, suite, unit, building, floor"
            disabled={form.permSame}
            value={perm.a2}
            onChange={(e) => set({ permA2: e.target.value })}
          />
        </div>
        <FormInput
          label="City"
          disabled={form.permSame}
          value={perm.city}
          onChange={(e) => set({ permCity: e.target.value })}
        />
        <FormInput
          label="State / Province"
          disabled={form.permSame}
          value={perm.state}
          onChange={(e) => set({ permState: e.target.value })}
        />
        <FormSelect
          label="Country"
          placeholder="Select country..."
          options={ADDRESS_COUNTRIES.map((c) => ({ value: c, label: c }))}
          disabled={form.permSame}
          value={perm.country}
          onChange={(e) => set({ permCountry: e.target.value })}
        />
        <FormInput
          label="Postal Code"
          disabled={form.permSame}
          value={perm.postal}
          onChange={(e) => set({ permPostal: e.target.value })}
        />
      </div>

      <SectionHeader icon={<GlobeIcon />} title="Nationality" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <FormSelect
          label="Nationality"
          placeholder="Select nationality..."
          options={NATIONALITY_OPTIONS}
          value={form.nationality}
          onChange={(e) => set({ nationality: e.target.value })}
        />
        <FormSelect
          label="Dual Citizenship"
          placeholder="Select..."
          options={YES_NO_OPTIONS}
          value={form.dualCitizenship}
          onChange={(e) => set({ dualCitizenship: e.target.value })}
        />
        <FormInput
          label="Passport Number"
          placeholder="e.g. A1234567"
          value={form.passportNumber}
          onChange={(e) => set({ passportNumber: e.target.value })}
        />
        <FormInput
          label="Passport Expiry Date"
          type="date"
          value={form.passportExpiry}
          onChange={(e) => set({ passportExpiry: e.target.value })}
        />
        <YesNoWithDetails
          label="Visa Refused"
          value={form.visaRefused}
          details={form.visaRefusedDetails}
          detailsPlaceholder="Provide details about the visa refusal..."
          onValue={(visaRefused) => set({ visaRefused })}
          onDetails={(visaRefusedDetails) => set({ visaRefusedDetails })}
        />
        <YesNoWithDetails
          label="Criminal Record"
          value={form.criminalRecord}
          details={form.criminalRecordDetails}
          detailsPlaceholder="Provide details..."
          onValue={(criminalRecord) => set({ criminalRecord })}
          onDetails={(criminalRecordDetails) => set({ criminalRecordDetails })}
        />
        <YesNoWithDetails
          label="Medical Condition"
          value={form.medicalCondition}
          details={form.medicalConditionDetails}
          detailsPlaceholder="Provide details..."
          onValue={(medicalCondition) => set({ medicalCondition })}
          onDetails={(medicalConditionDetails) =>
            set({ medicalConditionDetails })
          }
        />
      </div>

      <SectionHeader icon={<CapIcon />} title="Study Preferences" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <FormSelect
          label="Country Preference"
          required
          placeholder="Select country..."
          options={ADD_COUNTRY_OPTIONS}
          value={form.country}
          onChange={(e) => set({ country: e.target.value })}
        />
        <FormSelect
          label="Intake"
          required
          placeholder="Select intake..."
          options={INTAKE_OPTIONS.map((i) => ({ value: i, label: i }))}
          value={form.intake}
          onChange={(e) => set({ intake: e.target.value })}
        />
        <FormSelect
          label="Level"
          required
          placeholder="Select level..."
          options={COURSE_LEVEL_SELECT_OPTIONS}
          value={form.courseLevel}
          onChange={(e) => set({ courseLevel: e.target.value })}
        />
        <FormSelect
          label="Interested Program"
          required
          placeholder="Select program..."
          options={PROGRAM_OPTIONS.map((p) => ({ value: p, label: p }))}
          value={form.program}
          onChange={(e) => set({ program: e.target.value })}
        />
      </div>
      <div className="mt-5 space-y-3.5">
        <YesNoRow
          label="Is the student interested in applying for an education loan through Collegepond?"
          required
          value={form.educationLoan}
          onChange={(educationLoan) => set({ educationLoan })}
        />
      </div>

      <SectionHeader icon={<PhoneIcon />} title="Emergency Contacts" />
      <div className="space-y-4">
        {form.contacts.map((c, i) => (
          <div
            key={i}
            className="rounded-[10px] border border-[#E4E7EC] p-5"
          >
            <div className="mb-3.5 flex items-center justify-between">
              <span className="text-[13px] font-semibold text-[#344054]">
                Contact {i + 1}
              </span>
              <button
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    contacts: prev.contacts.filter((_, idx) => idx !== i),
                  }))
                }
                className="cursor-pointer text-xs font-semibold text-[#F04438] hover:underline"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormSelect
                label="Relationship"
                required
                placeholder="Select relationship..."
                options={RELATIONSHIP_OPTIONS}
                value={c.relationship}
                onChange={(e) => setContact(i, { relationship: e.target.value })}
              />
              <FormInput
                label="Name"
                required
                placeholder="Contact name"
                value={c.name}
                onChange={(e) => setContact(i, { name: e.target.value })}
              />
              <FormInput
                label="Email"
                type="email"
                placeholder="contact@email.com"
                value={c.email}
                onChange={(e) => setContact(i, { email: e.target.value })}
              />
              <PhoneField
                label="Phone"
                code={c.phoneCode}
                number={c.phone}
                onCode={(phoneCode) => setContact(i, { phoneCode })}
                onNumber={(phone) => setContact(i, { phone })}
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            setForm((prev) => ({
              ...prev,
              contacts: [...prev.contacts, emptyContact()],
            }))
          }
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
          Add Contact
        </button>
      </div>

      {/* Actions */}
      <div className="mt-7 flex justify-end gap-3 border-t border-[#F2F4F7] pt-5">
        <Button
          variant="secondary"
          onClick={() => setForm(buildForm(student))}
          className="!h-[40px] !px-4 !text-[13px]"
        >
          Cancel
        </Button>
        <Button
          onClick={save}
          loading={updateMut.isPending}
          className="!h-[40px] !px-5 !text-[13px]"
        >
          Save Profile
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared form bits (also used by the other profile sub-tabs)
// ---------------------------------------------------------------------------

export function SectionHeader({
  icon,
  title,
  first = false,
}: {
  icon: ReactNode;
  title: string;
  first?: boolean;
}) {
  return (
    <div
      className={`mb-4 flex items-center gap-2.5 border-b border-[#F2F4F7] pb-2.5 ${
        first ? "" : "mt-8"
      }`}
    >
      {icon}
      <h3 className="text-[15px] font-bold text-[#101828]">{title}</h3>
    </div>
  );
}

export function PhoneField({
  label,
  required = false,
  code,
  number,
  onCode,
  onNumber,
}: {
  label: string;
  required?: boolean;
  code: string;
  number: string;
  onCode: (v: string) => void;
  onNumber: (v: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <label className="mb-1.5 text-[13px] font-medium text-[#344054]">
        {label} {required && <span className="text-[#F04438]">*</span>}
      </label>
      <div className="flex gap-2">
        <select
          value={code}
          onChange={(e) => onCode(e.target.value)}
          className="h-[42px] w-[88px] shrink-0 cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-2.5 text-sm text-[#101828] outline-none focus:border-[#1570EF]"
        >
          {PHONE_CODES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <FormInput
          type="tel"
          placeholder="98765 43210"
          value={number}
          onChange={(e) => onNumber(e.target.value.replace(/[^0-9 ]/g, ""))}
        />
      </div>
    </div>
  );
}

function YesNoWithDetails({
  label,
  value,
  details,
  detailsPlaceholder,
  onValue,
  onDetails,
}: {
  label: string;
  value: string;
  details: string;
  detailsPlaceholder: string;
  onValue: (v: string) => void;
  onDetails: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <FormSelect
        label={label}
        placeholder="Select..."
        options={YES_NO_OPTIONS}
        value={value}
        onChange={(e) => onValue(e.target.value)}
      />
      {value === "yes" && (
        <FormTextarea
          placeholder={detailsPlaceholder}
          value={details}
          onChange={(e) => onDetails(e.target.value)}
          rows={2}
        />
      )}
    </div>
  );
}

function YesNoRow({
  label,
  required,
  value,
  onChange,
}: {
  label: string;
  required?: boolean;
  value: boolean | null;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-[#344054]">
        {label} {required && <span className="text-[#F04438]">*</span>}
      </span>
      <div className="flex gap-5">
        {[true, false].map((option) => (
          <label
            key={String(option)}
            className="flex cursor-pointer items-center gap-1.5 text-sm text-[#344054]"
          >
            <input
              type="radio"
              checked={value === option}
              onChange={() => onChange(option)}
              className="h-4 w-4 cursor-pointer accent-[#1570EF]"
            />
            {option ? "Yes" : "No"}
          </label>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const iconClass = "h-[18px] w-[18px] shrink-0";

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1570EF" strokeWidth={2} className={iconClass}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1570EF" strokeWidth={2} className={iconClass}>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}

function IdIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1570EF" strokeWidth={2} className={iconClass}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M15 8h4M15 12h4M7 16h10" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1570EF" strokeWidth={2} className={iconClass}>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1570EF" strokeWidth={2} className={iconClass}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1570EF" strokeWidth={2} className={iconClass}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function CapIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#1570EF" strokeWidth={2} className={iconClass}>
      <path d="M22 10L12 5 2 10l10 5 10-5z" />
      <path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" />
    </svg>
  );
}
