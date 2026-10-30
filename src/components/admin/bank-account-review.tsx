"use client";

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { BANK_PROOF_LABELS } from "~/lib/constants/partner-labels";
import { Button } from "~/components/ui/button";
import { FormTextarea } from "~/components/ui/form-input";
import { Modal } from "~/components/ui/modal";

// A partner's payout bank account as finance sees it (masked, last 4 only),
// with the one verify / reject path. Used by the Bank Verifications queue,
// the Reconciliation verify panel and the partner profile on Partners.

export type AdminBank = NonNullable<RouterOutputs["bankVerification"]["forPartner"]>;

const fmt = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

export function BankStatusPill({ status }: { status: AdminBank["status"] }) {
  const map = {
    verified: ["bg-[#ECFDF3] text-[#067647]", "✓ Verified"],
    rejected: ["bg-[#FEF3F2] text-[#B42318]", "Rejected"],
    pending: ["bg-[#FFF6ED] text-[#B54708]", "Pending verification"],
  } as const;
  const [cls, label] = map[status];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${cls}`}>{label}</span>;
}

// Masked details + proof link + who verified / rejected it.
export function BankAccountDetails({ bank, canReveal }: { bank: AdminBank; canReveal: boolean }) {
  const intl = bank.region === "international";
  const [revealed, setRevealed] = useState<string | null>(null);
  const reveal = api.bankVerification.revealAccountNumber.useMutation();
  const rows: [string, React.ReactNode][] = [
    ["Type", intl ? "International" : "Domestic (India)"],
    ["Account holder", bank.accountHolder],
    [
      "Account number",
      <span key="acct">
        {revealed ?? (bank.last4 ? `•••• ${bank.last4}` : "—")}
        {canReveal && !revealed && (
          <button
            type="button"
            className="ml-1.5 text-xs font-semibold text-[#1570EF] hover:underline disabled:opacity-50"
            disabled={reveal.isPending}
            onClick={() =>
              void reveal
                .mutateAsync({ bankAccountId: bank.id })
                .then((r) => setRevealed(r.accountNumber ?? r.note ?? "Not available"))
                .catch((e: unknown) => setRevealed(e instanceof Error ? e.message : "Couldn't reveal"))
            }
          >
            Reveal
          </button>
        )}
      </span>,
    ],
    ...(intl && bank.ibanLast4 ? ([["IBAN", `•••• ${bank.ibanLast4}`]] as [string, string][]) : []),
    ["Bank", [bank.bankName, bank.branch].filter(Boolean).join(", ") || "—"],
    ["Paid in", bank.payoutCurrency ?? "Not chosen"],
    [intl ? "SWIFT / BIC" : "IFSC", (intl ? bank.swift : bank.ifsc) ?? "—"],
    ...(intl
      ? ([
          ["Bank country", bank.bankCountry ?? "—"],
          ["Bank address", bank.bankAddress ?? "—"],
        ] as [string, string][])
      : []),
    ["Account type", bank.accountType ?? "—"],
    [
      BANK_PROOF_LABELS[intl ? "international" : "domestic"],
      bank.proofUrl ? (
        <a key="proof" href={bank.proofUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#1570EF] hover:underline">
          {bank.proofFileName ?? "View"} ↗
        </a>
      ) : (
        <span key="proof" className="font-semibold text-[#B42318]">Not uploaded</span>
      ),
    ],
    ["Submitted", fmt(bank.submittedAt)],
  ];
  return (
    <div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <div className="text-[11px] font-medium tracking-wide text-[#98A2B3] uppercase">{label}</div>
            <div className="mt-0.5 text-sm font-medium break-words text-[#101828]">{value}</div>
          </div>
        ))}
      </div>
      {bank.status === "verified" && (
        <div className="mt-3 rounded-md bg-[#ECFDF3] px-3 py-2 text-xs text-[#067647]">
          Verified{bank.verifiedBy ? ` by ${bank.verifiedBy}` : ""} on {fmt(bank.verifiedAt)}
          {bank.verificationNote ? ` — ${bank.verificationNote}` : ""}
        </div>
      )}
      {bank.status === "rejected" && (
        <div className="mt-3 rounded-md bg-[#FEF3F2] px-3 py-2 text-xs text-[#B42318]">
          Rejected{bank.rejectedBy ? ` by ${bank.rejectedBy}` : ""} on {fmt(bank.rejectedAt)}
          {bank.rejectionReason ? ` — ${bank.rejectionReason.replace(/[.\s]+$/, "")}` : ""}. Waiting for the partner to save
          new details.
        </div>
      )}
    </div>
  );
}

// Verify (by hand with a note, or RazorpayX penny-drop) or reject with a
// reason. Only for a pending account; the server re-checks the role and that
// the details haven't changed since they were loaded.
export function BankDecisionControls({
  bank,
  razorpayConfigured,
  onDone,
  compact = false,
}: {
  bank: AdminBank;
  razorpayConfigured: boolean;
  onDone: (message: string) => void;
  compact?: boolean;
}) {
  const utils = api.useUtils();
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");

  const refresh = () =>
    Promise.all([
      utils.bankVerification.invalidate(),
      utils.reconciliation.listPending.invalidate(),
      utils.notifications.list.invalidate(),
    ]);
  const onError = (e: { message: string }) => setErr(e.message);
  const verify = api.bankVerification.verifyManually.useMutation({
    onSuccess: async () => { await refresh(); onDone("Bank account verified — the partner has been notified"); },
    onError,
  });
  const verifyRzp = api.bankVerification.verifyViaRazorpay.useMutation({
    onSuccess: async (r) => {
      await refresh();
      onDone(
        r.verified
          ? `Bank verified via RazorpayX${r.registeredName ? ` — ${r.registeredName}` : ""}`
          : `RazorpayX check didn't pass (${r.accountStatus ?? r.status}). Check the proof by hand or reject.`,
      );
    },
    onError,
  });
  const reject = api.bankVerification.reject.useMutation({
    onSuccess: async () => {
      setRejecting(false);
      await refresh();
      onDone("Bank details rejected — the partner has been asked to resubmit");
    },
    onError: (e) => setErr(e.message),
  });

  if (bank.status !== "pending") return null;
  const busy = verify.isPending || verifyRzp.isPending || reject.isPending;
  const proofWord = bank.region === "international" ? "bank letter" : "cancelled cheque";

  return (
    <div className={`space-y-2 rounded-lg border border-[#FEDF89] bg-[#FFFCF5] ${compact ? "p-2.5" : "p-3"}`}>
      <p className="text-[11px] text-[#B54708]">
        Check the {proofWord} against the holder name, account number and {bank.region === "international" ? "SWIFT" : "IFSC"}.
        No payout can be released to this account until it is verified.
      </p>
      {bank.proofUrl ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`How you verified it (e.g. ${proofWord} matches name, a/c and ${bank.region === "international" ? "SWIFT" : "IFSC"})`}
            className="h-8 w-full rounded-md border border-[#D0D5DD] bg-white px-2 text-xs outline-none focus:border-[#1570EF]"
          />
          <Button
            className="!h-8 shrink-0 !text-[12px]"
            disabled={note.trim().length < 5 || busy}
            loading={verify.isPending}
            onClick={() => {
              setErr("");
              verify.mutate({ bankAccountId: bank.id, submittedAt: new Date(bank.submittedAt), note: note.trim() });
            }}
          >
            Mark verified
          </Button>
        </div>
      ) : (
        <p className="text-[11px] font-semibold text-[#B42318]">No {proofWord} uploaded — reject so the partner resubmits with the proof.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {bank.region === "domestic" && razorpayConfigured && (
          <Button
            variant="secondary"
            className="!h-8 !text-[12px]"
            disabled={busy}
            loading={verifyRzp.isPending}
            onClick={() => {
              setErr("");
              verifyRzp.mutate({ bankAccountId: bank.id, submittedAt: new Date(bank.submittedAt) });
            }}
          >
            Verify via RazorpayX (₹1 penny-drop)
          </Button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => { setErr(""); setReason(""); setRejecting(true); }}
          className="h-8 rounded-lg border border-[#FDA29B] bg-white px-3 text-[12px] font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50"
        >
          Reject…
        </button>
      </div>
      {err && !rejecting && <p className="text-xs font-medium text-[#F04438]">{err}</p>}

      {rejecting && (
        <Modal
          open
          title="Reject bank details"
          onClose={() => setRejecting(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRejecting(false)}>Cancel</Button>
              <Button
                loading={reject.isPending}
                onClick={() => {
                  if (reason.trim().length < 5) return setErr("Tell the partner what to fix (at least 5 characters)");
                  setErr("");
                  reject.mutate({ bankAccountId: bank.id, submittedAt: new Date(bank.submittedAt), reason: reason.trim() });
                }}
              >
                Reject and notify partner
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-[#667085]">
            The partner sees this reason in the portal and by email, and must save new bank details. The account stays
            unverified, so no payout can be released to it.
          </p>
          <FormTextarea
            label="Reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={!!err}
            errorMessage={err}
            placeholder={`e.g. The name on the ${proofWord} doesn't match the account holder.`}
          />
        </Modal>
      )}
    </div>
  );
}
