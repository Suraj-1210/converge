"use client";

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { FileUpload } from "~/components/ui/file-upload";
import { FormInput } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { api, type RouterOutputs } from "~/trpc/react";

// The partner's payout bank account: one form and one summary, used by the
// Account page (Bank Details tab) and the commission invoice wizard.
// Domestic accounts give an IFSC + cancelled cheque; international ones a
// SWIFT/BIC, bank country and address + a bank letter or statement. Saving
// sends the account back to "verification pending" — finance checks the
// proof by hand before any payout. Partners only ever see the last 4 digits.

export type BankOnFile = RouterOutputs["partnerCommission"]["bankAccount"];

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const SWIFT_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

async function uploadProof(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("folder", "bank-proofs");
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new Error(body.error ?? "Upload failed");
  return body.url;
}

export function BankVerificationBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span className="rounded-full bg-[#ECFDF3] px-2 py-0.5 text-[11px] font-semibold text-[#067647]">✓ Verified</span>
  ) : (
    <span className="rounded-full bg-[#FFFAEB] px-2 py-0.5 text-[11px] font-semibold text-[#B54708]">Verification pending</span>
  );
}

// Masked, read-only view of the account on file.
export function BankAccountSummary({ bank }: { bank: BankOnFile }) {
  const intl = bank.region === "international";
  const rows: [string, string | null][] = [
    ["Type", intl ? "International" : "Domestic (India)"],
    ["Account holder", bank.accountHolder],
    ["Account number", bank.accountNumberLast4 ? `•••• ${bank.accountNumberLast4}` : null],
    ...(intl && bank.ibanLast4 ? ([["IBAN", `•••• ${bank.ibanLast4}`]] as [string, string][]) : []),
    ["Bank", [bank.bankName, bank.branch].filter(Boolean).join(", ") || null],
    [intl ? "SWIFT / BIC" : "IFSC", intl ? bank.swift : bank.ifsc],
    ...(intl ? ([["Bank country", bank.bankCountry], ["Bank address", bank.bankAddress]] as [string, string | null][]) : []),
    ["Account type", bank.accountType],
    [intl ? "Bank letter" : "Cancelled cheque", bank.hasProof ? (bank.proofFileName ?? "Uploaded") : "Not uploaded"],
  ];
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <div className="text-xs font-medium tracking-wide text-[#98A2B3] uppercase">{label}</div>
          <div className="mt-0.5 text-sm font-medium break-words text-[#101828]">{value ?? "—"}</div>
        </div>
      ))}
    </div>
  );
}

export function BankDetailsForm({
  bank,
  gstin,
  pan,
  onSaved,
  onCancel,
}: {
  bank: BankOnFile | undefined;
  // Carried through so saving bank details doesn't clear the tax ids.
  gstin?: string;
  pan?: string;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const utils = api.useUtils();
  const countries = api.geo.countries.useQuery(undefined, { staleTime: Infinity }).data ?? [];
  const [region, setRegion] = useState<"domestic" | "international">(bank?.region ?? "domestic");
  const [form, setForm] = useState({
    accountHolder: bank?.accountHolder ?? "",
    accountNumber: "",
    confirmNumber: "",
    ifsc: bank?.ifsc ?? "",
    swift: bank?.swift ?? "",
    iban: "",
    bankName: bank?.bankName ?? "",
    branch: bank?.branch ?? "",
    bankCountry: bank?.bankCountry && bank.bankCountry !== "IN" ? bank.bankCountry : "",
    bankAddress: bank?.bankAddress ?? "",
    accountType: bank?.accountType ?? "Current Account",
  });
  const [proof, setProof] = useState<{ url?: string; name?: string; uploading?: boolean }>({});
  const [err, setErr] = useState("");
  const save = api.partnerCommission.saveBankAccount.useMutation();
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const intl = region === "international";

  async function onProof(file: File) {
    setProof({ name: file.name, uploading: true });
    try {
      const url = await uploadProof(file);
      setProof({ url, name: file.name });
    } catch (e) {
      setProof({});
      setErr(e instanceof Error ? e.message : "Upload failed");
    }
  }

  async function submit() {
    setErr("");
    const f = {
      ...form,
      ifsc: form.ifsc.trim().toUpperCase(),
      swift: form.swift.trim().toUpperCase(),
      iban: form.iban.replace(/\s+/g, "").toUpperCase(),
      accountNumber: form.accountNumber.replace(/\s+/g, ""),
      confirmNumber: form.confirmNumber.replace(/\s+/g, ""),
    };
    if (!f.accountHolder.trim()) return setErr("Account holder name is required");
    if (f.accountNumber.length < 4) return setErr("Enter the full account number");
    if (f.accountNumber !== f.confirmNumber) return setErr("The account numbers don't match");
    if (!f.bankName.trim()) return setErr("Bank name is required");
    if (!intl && !IFSC_RE.test(f.ifsc)) return setErr("Enter a valid IFSC (e.g. HDFC0001234)");
    if (intl && !SWIFT_RE.test(f.swift)) return setErr("Enter a valid SWIFT/BIC (8 or 11 characters)");
    if (intl && !f.bankCountry) return setErr("Select the bank's country");
    if (intl && !f.bankAddress.trim()) return setErr("Enter the bank's address");
    if (!proof.url) {
      return setErr(intl ? "Upload a bank letter or statement" : "Upload a cancelled cheque");
    }
    try {
      await save.mutateAsync({
        region,
        accountHolder: f.accountHolder.trim(),
        accountNumber: f.accountNumber,
        ifsc: intl ? undefined : f.ifsc,
        swift: intl ? f.swift : undefined,
        iban: intl && f.iban ? f.iban : undefined,
        bankName: f.bankName.trim(),
        branch: f.branch.trim() || undefined,
        bankCountry: intl ? f.bankCountry : undefined,
        bankAddress: intl ? f.bankAddress.trim() : undefined,
        accountType: f.accountType || undefined,
        proofUrl: proof.url,
        proofFileName: proof.name,
        gstin: gstin?.trim() ? gstin : undefined,
        pan: pan?.trim() ? pan : undefined,
      });
      await utils.partnerCommission.bankAccount.invalidate();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save bank details");
    }
  }

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-[#D0D5DD] p-0.5">
        {(["domestic", "international"] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRegion(r)}
            className={`rounded-md px-3.5 py-1.5 text-[13px] font-semibold transition ${
              region === r ? "bg-[#1570EF] text-white" : "text-[#344054] hover:bg-[#F9FAFB]"
            }`}
          >
            {r === "domestic" ? "Domestic (India)" : "International"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormInput label="Account Holder" required value={form.accountHolder} onChange={(e) => set("accountHolder", e.target.value)} />
        <FormInput label={intl ? "Bank Name" : "Bank Name"} required value={form.bankName} onChange={(e) => set("bankName", e.target.value)} />
        <FormInput
          label="Account Number"
          required
          autoComplete="off"
          value={form.accountNumber}
          onChange={(e) => set("accountNumber", e.target.value)}
          placeholder={bank?.accountNumberLast4 ? `Currently •••• ${bank.accountNumberLast4}` : ""}
        />
        <FormInput
          label="Re-enter Account Number"
          required
          autoComplete="off"
          value={form.confirmNumber}
          onChange={(e) => set("confirmNumber", e.target.value)}
          onPaste={(e) => e.preventDefault()}
        />
        {intl ? (
          <>
            <FormInput label="SWIFT / BIC" required value={form.swift} onChange={(e) => set("swift", e.target.value.toUpperCase())} maxLength={11} placeholder="e.g. HSBCGB2LXXX" />
            <FormInput label="IBAN (if your bank uses one)" value={form.iban} onChange={(e) => set("iban", e.target.value.toUpperCase())} maxLength={42} />
            <FormSelect
              label="Bank Country"
              required
              placeholder="Select country"
              options={countries.filter((c) => c.iso2 !== "IN").map((c) => ({ value: c.iso2, label: c.name }))}
              value={form.bankCountry}
              onChange={(e) => set("bankCountry", e.target.value)}
            />
            <FormInput label="Branch" value={form.branch} onChange={(e) => set("branch", e.target.value)} />
            <div className="sm:col-span-2">
              <FormInput label="Bank Address" required value={form.bankAddress} onChange={(e) => set("bankAddress", e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <FormInput label="IFSC" required value={form.ifsc} onChange={(e) => set("ifsc", e.target.value.toUpperCase())} maxLength={11} placeholder="e.g. HDFC0001234" />
            <FormInput label="Branch" value={form.branch} onChange={(e) => set("branch", e.target.value)} />
          </>
        )}
        <FormSelect
          label="Account Type"
          options={[
            { value: "Current Account", label: "Current Account" },
            { value: "Savings Account", label: "Savings Account" },
          ]}
          value={form.accountType}
          onChange={(e) => set("accountType", e.target.value)}
        />
      </div>

      <FileUpload
        label={intl ? "Bank Letter or Statement" : "Cancelled Cheque"}
        required
        hint={
          intl
            ? "A letter or statement from your bank showing the account name, number and SWIFT. PDF, JPG or PNG (max 5MB)"
            : "Shows the account holder, number and IFSC. PDF, JPG or PNG (max 5MB)"
        }
        fileName={proof.name}
        uploading={proof.uploading}
        onFileSelect={(f) => void onProof(f)}
        onFileRemove={() => setProof({})}
      />

      <p className="text-[11px] text-[#667085]">
        🔒 Stored encrypted — only the last 4 digits are shown back. Our finance team checks these details against the
        {intl ? " bank letter" : " cancelled cheque"} before your first payment to this account.
      </p>
      {err && <p className="text-xs font-medium text-[#F04438]">{err}</p>}
      <div className="flex items-center gap-3">
        <Button onClick={() => void submit()} loading={save.isPending} disabled={proof.uploading}>
          Save Bank Details
        </Button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-sm font-semibold text-[#344054] transition-colors hover:bg-[#F9FAFB]"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
