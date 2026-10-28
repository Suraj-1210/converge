"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Modal } from "~/components/ui/modal";
import {
  INTAKE_OPTIONS,
  STATUS_GROUP_OPTIONS,
} from "~/components/students/status";
import { api } from "~/trpc/react";
import {
  ADD_COUNTRY_OPTIONS,
  COURSE_LEVEL_SELECT_OPTIONS,
  EMAIL_REGEX,
  PHONE_CODES,
  PHONE_LENGTH,
  PROGRAM_OPTIONS,
  displayId,
  type CpCounsellor,
  type OrgOption,
} from "./lib";

// Same chevron the shared FormSelect uses, for the hand-rolled selects here
// (FormSelect can't render <optgroup>s).
const chevronBg = `url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%2398A2B3' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

export function counsellorName(c: CpCounsellor): string {
  return `${c.firstName} ${c.lastName}`.trim() || c.email;
}

export function counsellorOptions(counsellors: CpCounsellor[]) {
  return counsellors.map((c) => ({
    value: String(c.id),
    label: counsellorName(c),
  }));
}

// Status <select> with the 21 statuses in pipeline-group <optgroup>s. Styling
// comes from the caller so it works both as a filter pill and a form field.
export function StatusGroupedSelect({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ backgroundImage: chevronBg }}
      className={`cursor-pointer appearance-none bg-white bg-[right_12px_center] bg-no-repeat outline-none ${className}`}
    >
      <option value="">{placeholder}</option>
      {STATUS_GROUP_OPTIONS.map((g) => (
        <optgroup key={g.group} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Bulk: Update Status
// ---------------------------------------------------------------------------

export function BulkStatusModal({
  open,
  count,
  onClose,
  onConfirm,
  saving,
  onToast,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onConfirm: (status: number, note?: string, effectiveDate?: string) => void;
  saving: boolean;
  onToast: (msg: string) => void;
}) {
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");

  useEffect(() => {
    if (open) {
      setStatus("");
      setNote("");
      setEffectiveDate("");
    }
  }, [open]);

  const confirm = () => {
    if (status === "") {
      onToast("Please select a status");
      return;
    }
    onConfirm(
      Number(status),
      note.trim() || undefined,
      effectiveDate || undefined,
    );
  };

  return (
    <Modal
      open={open}
      title={`Update Status for ${count} Student(s)`}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            className="!h-[38px] !px-4"
          >
            Cancel
          </Button>
          <Button onClick={confirm} loading={saving} className="!h-[38px] !px-4">
            Update Status
          </Button>
        </>
      }
    >
      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-[#344054]">
          New Status <span className="text-[#F04438]">*</span>
        </label>
        <StatusGroupedSelect
          value={status}
          onChange={setStatus}
          placeholder="Select a status…"
          className="h-[42px] w-full rounded-lg border border-[#D0D5DD] pr-9 pl-3.5 text-sm text-[#101828] focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.12)]"
        />
      </div>
      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-[#344054]">
          Effective Date (optional)
        </label>
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => setEffectiveDate(e.target.value)}
          className="h-[42px] w-full cursor-pointer rounded-lg border border-[#D0D5DD] px-3.5 font-[family-name:var(--font-inter)] text-sm text-[#101828] outline-none focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.12)]"
        />
      </div>
      <FormTextarea
        label="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="Add a note about this status change..."
      />
      <p className="text-xs text-[#98A2B3]">
        The note and effective date are recorded in the audit log.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bulk: Assign / Reassign Counselor
// ---------------------------------------------------------------------------

export function BulkAssignModal({
  open,
  count,
  counsellors,
  onClose,
  onConfirm,
  saving,
  onToast,
}: {
  open: boolean;
  count: number;
  counsellors: CpCounsellor[];
  onClose: () => void;
  onConfirm: (cpCounsellorId: number) => void;
  saving: boolean;
  onToast: (msg: string) => void;
}) {
  const [counsellorId, setCounsellorId] = useState("");

  useEffect(() => {
    if (open) setCounsellorId("");
  }, [open]);

  const confirm = () => {
    if (!counsellorId) {
      onToast("Please select a counselor");
      return;
    }
    onConfirm(Number(counsellorId));
  };

  return (
    <Modal
      open={open}
      title={`Assign / Reassign Counselor to ${count} Student(s)`}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            className="!h-[38px] !px-4"
          >
            Cancel
          </Button>
          <Button onClick={confirm} loading={saving} className="!h-[38px] !px-4">
            Assign
          </Button>
        </>
      }
    >
      <FormSelect
        label="Counselor"
        required
        placeholder="Choose a counselor..."
        options={counsellorOptions(counsellors)}
        value={counsellorId}
        onChange={(e) => setCounsellorId(e.target.value)}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Add Student
// ---------------------------------------------------------------------------

interface AddForm {
  firstName: string;
  lastName: string;
  phoneCode: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  country: string;
  intake: string;
  courseLevel: string;
  program: string;
  orgId: string;
  cpCounsellorId: string;
  educationLoan: boolean | null;
}

const emptyAddForm: AddForm = {
  firstName: "",
  lastName: "",
  phoneCode: "+91",
  phone: "",
  email: "",
  dateOfBirth: "",
  country: "",
  intake: "",
  courseLevel: "",
  program: "",
  orgId: "",
  cpCounsellorId: "",
  educationLoan: null,
};

type DuplicateInfo = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  orgName: string;
  matchedOn: "email" | "phone";
};

// Partner picker value (students.listOrgs `key`): "org-<id>" for an agency,
// "ind-<user id>" for an independent counsellor.
function partnerFromKey(key: string): { orgId: number } | { independentUserId: number } {
  const id = Number(key.slice(4));
  return key.startsWith("ind-") ? { independentUserId: id } : { orgId: id };
}

export function AddStudentModal({
  open,
  onClose,
  orgs,
  counsellors,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  orgs: OrgOption[];
  counsellors: CpCounsellor[];
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const [form, setForm] = useState<AddForm>(emptyAddForm);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);

  useEffect(() => {
    if (open) {
      setForm(emptyAddForm);
      setDuplicate(null);
    }
  }, [open]);

  const createMut = api.students.adminCreate.useMutation({
    onSuccess: (res) => {
      if (!res.ok) {
        setDuplicate(res.duplicate);
        return;
      }
      void utils.students.adminList.invalidate();
      onToast(
        `${res.student.firstName} ${res.student.lastName} added as ${displayId(res.student.id)}!`,
      );
      onClose();
    },
    onError: (err) => onToast(err.message),
  });

  const set = (patch: Partial<AddForm>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const save = () => {
    const required = [
      form.firstName,
      form.lastName,
      form.phone,
      form.email,
      form.dateOfBirth,
      form.country,
      form.intake,
      form.courseLevel,
      form.program,
      form.orgId,
    ];
    if (required.some((v) => !v.trim()) || form.educationLoan === null) {
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
    createMut.mutate({
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      countryCode: form.phoneCode,
      phone: form.phone.trim(),
      dateOfBirth: form.dateOfBirth,
      country: form.country,
      intake: form.intake,
      courseLevel: Number(form.courseLevel),
      interestedProgram: form.program,
      educationLoan: form.educationLoan,
      ...partnerFromKey(form.orgId),
      cpCounsellorId: form.cpCounsellorId ? Number(form.cpCounsellorId) : null,
    });
  };

  return (
    <>
      <Modal
        open={open}
        title="Add Student"
        onClose={onClose}
        width="w-[680px]"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={onClose}
              className="!h-[38px] !px-4"
            >
              Cancel
            </Button>
            <Button
              onClick={save}
              loading={createMut.isPending}
              className="!h-[38px] !px-4"
            >
              Add Student
            </Button>
          </>
        }
      >
        <Section title="Student Details">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <FormInput
              label="First Name"
              required
              placeholder="e.g. Ananya"
              value={form.firstName}
              onChange={(e) => set({ firstName: e.target.value })}
            />
            <FormInput
              label="Last Name"
              required
              placeholder="e.g. Patel"
              value={form.lastName}
              onChange={(e) => set({ lastName: e.target.value })}
            />
          </div>
        </Section>

        <Section title="Contact Details">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div className="flex flex-col">
              <label className="mb-1.5 text-[13px] font-medium text-[#344054]">
                Mobile Number <span className="text-[#F04438]">*</span>
              </label>
              <div className="flex gap-2">
                <select
                  value={form.phoneCode}
                  onChange={(e) => set({ phoneCode: e.target.value })}
                  style={{ backgroundImage: chevronBg }}
                  className="h-[42px] w-[88px] shrink-0 cursor-pointer appearance-none rounded-lg border border-[#D0D5DD] bg-white bg-[right_10px_center] bg-no-repeat pr-7 pl-3 text-sm text-[#101828] outline-none focus:border-[#1570EF]"
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
                  value={form.phone}
                  onChange={(e) =>
                    set({ phone: e.target.value.replace(/[^0-9 ]/g, "") })
                  }
                />
              </div>
            </div>
            <FormInput
              label="Email Address"
              required
              type="email"
              placeholder="student@email.com"
              value={form.email}
              onChange={(e) => set({ email: e.target.value })}
            />
            <FormInput
              label="Date of Birth"
              required
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => set({ dateOfBirth: e.target.value })}
            />
          </div>
        </Section>

        <Section title="Academic Preferences">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
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
        </Section>

        <Section title="Assignment">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <FormSelect
              label="Partner"
              required
              placeholder="Select partner..."
              options={orgs.map((o) => ({
                value: o.key,
                label: o.name,
              }))}
              value={form.orgId}
              onChange={(e) => set({ orgId: e.target.value })}
            />
            <FormSelect
              label="Assign Counselor (optional)"
              placeholder="Unassigned"
              options={counsellorOptions(counsellors)}
              value={form.cpCounsellorId}
              onChange={(e) => set({ cpCounsellorId: e.target.value })}
            />
          </div>
        </Section>

        <Section title="Additional Information">
          <YesNoRow
            label="Is your student interested in applying for an education loan through Collegepond?"
            required
            value={form.educationLoan}
            onChange={(educationLoan) => set({ educationLoan })}
          />
        </Section>
      </Modal>

      {/* Duplicate dialog — sits above the Add Student modal */}
      {duplicate && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-[rgba(16,24,40,0.55)] p-4"
          onClick={() => setDuplicate(null)}
        >
          <div
            className="w-[460px] max-w-full overflow-hidden rounded-xl bg-white shadow-[0_20px_60px_rgba(0,0,0,0.2)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b border-[#E4E7EC] px-6 py-5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#FEF3F2]">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#F04438"
                  strokeWidth={2}
                  className="h-4 w-4"
                >
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </span>
              <h3 className="text-base font-bold text-[#101828]">
                Duplicate Student Found
              </h3>
            </div>
            <div className="px-6 py-5">
              <p className="mb-4 text-sm text-[#667085]">
                A student with the same{" "}
                <strong className="text-[#344054]">
                  {duplicate.matchedOn === "email" ? "email address" : "phone number"}
                </strong>{" "}
                already exists.
              </p>
              <div className="space-y-2.5 rounded-lg bg-[#F9FAFB] p-4 text-sm">
                <DupRow label="Name" value={duplicate.name} />
                <DupRow label="Student ID" value={displayId(duplicate.id)} />
                <DupRow
                  label="Email"
                  value={duplicate.email ?? "—"}
                  highlight={duplicate.matchedOn === "email"}
                />
                <DupRow
                  label="Phone"
                  value={duplicate.phone ?? "—"}
                  highlight={duplicate.matchedOn === "phone"}
                />
                <DupRow label="Partner" value={duplicate.orgName} />
              </div>
            </div>
            <div className="flex justify-end border-t border-[#E4E7EC] px-6 py-4">
              <Button
                variant="secondary"
                onClick={() => setDuplicate(null)}
                className="!h-[38px] !px-4"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-3 border-b border-[#F2F4F7] pb-1.5 text-[11px] font-bold tracking-wider text-[#667085] uppercase">
        {title}
      </div>
      <div className="space-y-3.5">{children}</div>
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

function DupRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs font-semibold tracking-wider text-[#98A2B3] uppercase">
        {label}
      </span>
      <span
        className={`text-right break-words ${
          highlight ? "font-semibold text-[#B42318]" : "text-[#344054]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// ---- Bulk CSV import ------------------------------------------------------

// Columns the importer understands (order defines the template).
const IMPORT_COLUMNS = [
  "firstName",
  "lastName",
  "email",
  "countryCode",
  "phone",
  "country",
  "intake",
  "dateOfBirth",
  "courseLevel",
  "interestedProgram",
  "educationLoan",
] as const;

const TEMPLATE_EXAMPLE = [
  "Rahul",
  "Sharma",
  "rahul.sharma@example.com",
  "+91",
  "9876543210",
  "US",
  "Fall 2026",
  "2002-05-14",
  "Masters",
  "Computer Science",
  "yes",
];

// label/synonym (lowercased) → course-level code.
const LEVEL_BY_KEY: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const o of COURSE_LEVEL_SELECT_OPTIONS) {
    m[o.label.toLowerCase()] = Number(o.value);
    m[o.value] = Number(o.value);
  }
  Object.assign(m, {
    bachelors: 2,
    bachelor: 2,
    undergraduate: 2,
    undergrad: 2,
    masters: 3,
    master: 3,
    postgraduate: 3,
    postgrad: 3,
    doctorate: 5,
    phd: 5,
  });
  return m;
})();

// country name or ISO2 (lowercased) → ISO2 code.
const COUNTRY_BY_KEY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const o of ADD_COUNTRY_OPTIONS) {
    m[o.label.toLowerCase()] = o.value;
    m[o.value.toLowerCase()] = o.value;
  }
  return m;
})();

// Minimal CSV parser: handles quoted cells, embedded commas and "" escapes.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// Yes/No answers; anything else (including blank) is null so the row errors.
function parseYesNo(v: string): boolean | null {
  const k = v.trim().toLowerCase();
  if (["yes", "y", "true", "1", "t"].includes(k)) return true;
  if (["no", "n", "false", "0", "f"].includes(k)) return false;
  return null;
}

type ImportPayload = {
  firstName: string;
  lastName: string;
  email: string;
  countryCode: string;
  phone: string;
  country: string;
  intake: string;
  dateOfBirth: string;
  courseLevel: number;
  interestedProgram: string;
  educationLoan: boolean;
};

type ParsedRow =
  | { line: number; ok: true; payload: ImportPayload }
  | { line: number; ok: false; errors: string[]; name: string };

function validateRow(rec: Record<string, string>, line: number): ParsedRow {
  const errors: string[] = [];
  const req = (k: string, max: number) => {
    const v = (rec[k] ?? "").trim();
    if (!v) errors.push(`${k} is required`);
    else if (v.length > max) errors.push(`${k} too long`);
    return v;
  };

  const firstName = req("firstName", 50);
  const lastName = req("lastName", 50);

  const email = (rec.email ?? "").trim();
  if (!EMAIL_REGEX.test(email)) errors.push("invalid email");

  let countryCode = (rec.countryCode ?? "").trim();
  if (!countryCode) errors.push("countryCode is required");
  else if (!countryCode.startsWith("+")) countryCode = `+${countryCode}`;
  if (countryCode.length > 5) errors.push("countryCode too long");

  const phoneDigits = (rec.phone ?? "").replace(/[^0-9]/g, "");
  if (phoneDigits.length < 7 || phoneDigits.length > 15)
    errors.push("phone must be 7–15 digits");

  const countryRaw = (rec.country ?? "").trim();
  let country = COUNTRY_BY_KEY[countryRaw.toLowerCase()];
  if (!country && /^[A-Za-z]{2}$/.test(countryRaw)) country = countryRaw.toUpperCase();
  if (!country) errors.push(`unknown country "${countryRaw}"`);

  const intake = req("intake", 20);

  const dateOfBirth = (rec.dateOfBirth ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth))
    errors.push("dateOfBirth must be YYYY-MM-DD");
  else if (Number.isNaN(new Date(dateOfBirth).getTime()))
    errors.push("invalid dateOfBirth");

  const levelRaw = (rec.courseLevel ?? "").trim().toLowerCase();
  const courseLevel = LEVEL_BY_KEY[levelRaw];
  if (courseLevel === undefined) errors.push(`unknown courseLevel "${rec.courseLevel ?? ""}"`);

  const interestedProgram = req("interestedProgram", 100);

  const educationLoan = parseYesNo(rec.educationLoan ?? "");
  if (educationLoan === null) errors.push("educationLoan must be Yes or No");

  const name = `${firstName} ${lastName}`.trim() || email || `Row ${line}`;
  if (errors.length > 0) return { line, ok: false, errors, name };

  return {
    line,
    ok: true,
    payload: {
      firstName,
      lastName,
      email,
      countryCode,
      phone: phoneDigits,
      country: country!,
      intake,
      dateOfBirth,
      courseLevel: courseLevel!,
      interestedProgram,
      educationLoan: educationLoan!,
    },
  };
}

function parseCsvText(text: string): ParsedRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]!).map((h) => h.trim());
  // Case-insensitive header → our canonical column name.
  const canonical: Record<string, string> = {};
  for (const col of IMPORT_COLUMNS) canonical[col.toLowerCase()] = col;
  const colNames = header.map((h) => canonical[h.toLowerCase()] ?? h);

  return lines.slice(1).map((line, idx) => {
    const cells = parseCsvLine(line);
    const rec: Record<string, string> = {};
    colNames.forEach((name, i) => {
      rec[name] = cells[i] ?? "";
    });
    return validateRow(rec, idx + 2); // +2: 1-based + header row
  });
}

export function BulkImportStudentsModal({
  open,
  onClose,
  orgs,
  counsellors,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  orgs: OrgOption[];
  counsellors: CpCounsellor[];
  onToast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const [orgId, setOrgId] = useState("");
  const [cpCounsellorId, setCpCounsellorId] = useState("");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [result, setResult] = useState<{
    created: number;
    skipped: { row: number; email: string; reason: string }[];
  } | null>(null);

  useEffect(() => {
    if (open) {
      setOrgId("");
      setCpCounsellorId("");
      setFileName("");
      setRows([]);
      setResult(null);
    }
  }, [open]);

  const importMut = api.students.bulkImport.useMutation({
    onSuccess: (res) => {
      void utils.students.adminList.invalidate();
      setResult(res);
      onToast(`Imported ${res.created} student${res.created === 1 ? "" : "s"}`);
    },
    onError: (err) => onToast(err.message),
  });

  const valid = rows.filter((r): r is Extract<ParsedRow, { ok: true }> => r.ok);
  const invalid = rows.filter((r): r is Extract<ParsedRow, { ok: false }> => !r.ok);

  function handleFile(file: File) {
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      setFileName(file.name);
      const text = typeof reader.result === "string" ? reader.result : "";
      setRows(parseCsvText(text));
    };
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const csv = `${IMPORT_COLUMNS.join(",")}\n${TEMPLATE_EXAMPLE.join(",")}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "students-import-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function doImport() {
    if (!orgId || valid.length === 0) return;
    importMut.mutate({
      ...partnerFromKey(orgId),
      cpCounsellorId: cpCounsellorId ? Number(cpCounsellorId) : null,
      rows: valid.map((r) => r.payload),
    });
  }

  return (
    <Modal
      open={open}
      title="Bulk Import Students"
      onClose={onClose}
      width="w-[640px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className="!h-[38px] !px-4">
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              onClick={doImport}
              loading={importMut.isPending}
              disabled={!orgId || valid.length === 0}
              className="!h-[38px] !px-4"
            >
              Import {valid.length > 0 ? `${valid.length} ` : ""}Student
              {valid.length === 1 ? "" : "s"}
            </Button>
          )}
        </>
      }
    >
      {result ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-[#A6F4C5] bg-[#ECFDF3] px-4 py-3 text-sm text-[#067647]">
            ✓ Imported <strong>{result.created}</strong> student
            {result.created === 1 ? "" : "s"}.
          </div>
          {result.skipped.length > 0 && (
            <div className="rounded-xl border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3">
              <div className="mb-1.5 text-sm font-semibold text-[#B54708]">
                Skipped {result.skipped.length} row
                {result.skipped.length === 1 ? "" : "s"} (already exist)
              </div>
              <ul className="space-y-0.5 text-xs text-[#B54708]">
                {result.skipped.slice(0, 20).map((s) => (
                  <li key={`${s.row}-${s.email}`}>
                    Row {s.row}: {s.email} — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <FormSelect
              label="Partner"
              required
              placeholder="Select partner..."
              options={orgs.map((o) => ({ value: o.key, label: o.name }))}
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
            />
            <FormSelect
              label="Assign Counselor (optional)"
              placeholder="Unassigned"
              options={counsellorOptions(counsellors)}
              value={cpCounsellorId}
              onChange={(e) => setCpCounsellorId(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg bg-[#F9FAFB] px-3.5 py-2.5 text-sm">
            <span className="text-[#667085]">
              New to this? Start from the template.
            </span>
            <button
              onClick={downloadTemplate}
              className="cursor-pointer font-semibold text-[#1570EF] hover:underline"
            >
              Download CSV template
            </button>
          </div>

          <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[#D0D5DD] bg-[#FAFBFC] px-6 py-8 text-center hover:border-[#1570EF] hover:bg-[#F0F7FF]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1570EF"
              strokeWidth={2}
              className="mb-2 h-8 w-8"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="text-sm font-semibold text-[#344054]">
              {fileName || "Choose a CSV file"}
            </span>
            <span className="mt-0.5 text-xs text-[#667085]">
              Columns: {IMPORT_COLUMNS.join(", ")}
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </label>

          {rows.length > 0 && (
            <div className="space-y-3">
              <div className="flex gap-2 text-sm">
                <span className="rounded-lg bg-[#ECFDF3] px-2.5 py-1 font-semibold text-[#067647]">
                  {valid.length} valid
                </span>
                {invalid.length > 0 && (
                  <span className="rounded-lg bg-[#FEF3F2] px-2.5 py-1 font-semibold text-[#B42318]">
                    {invalid.length} invalid
                  </span>
                )}
              </div>
              {invalid.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-[#FECDCA] bg-[#FFFBFA] px-3.5 py-2.5">
                  <div className="mb-1 text-xs font-semibold text-[#B42318]">
                    These rows will be skipped — fix and re-upload:
                  </div>
                  <ul className="space-y-0.5 text-xs text-[#B42318]">
                    {invalid.slice(0, 25).map((r) => (
                      <li key={r.line}>
                        Row {r.line} ({r.name}): {r.errors.join("; ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
