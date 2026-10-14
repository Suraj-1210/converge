"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";

type TabKey = "profile" | "business" | "bank" | "documents" | "loyalty" | "notifications";

const TAB_LABELS: Record<TabKey, string> = {
  profile: "Profile Information",
  business: "Business Information",
  bank: "Bank Details",
  documents: "Documents",
  loyalty: "Loyalty",
  notifications: "Notification Preferences",
};

// Loyalty tiers — mirrors the Commission page banner/modal (display-only; the
// actual commission share is the per-commission partner_share_pct in the DB).
const LOYALTY_TIERS = [
  { name: "Silver", icon: "🥈", max: 10, share: 70, perks: ["70% Commission Rate", "Standard Application Processing", "Email Support"] },
  { name: "Gold", icon: "🥇", max: 30, share: 75, perks: ["75% Commission Rate", "Priority Application Processing", "Dedicated Support", "Quarterly Webinars"] },
  { name: "Platinum", icon: "🏆", max: 50, share: 80, perks: ["80% Commission Rate", "Priority Processing", "Relationship Manager", "Training & Webinars", "Early University Access"] },
  { name: "Titanium", icon: "⚡", max: 75, share: 85, perks: ["85% Commission Rate", "Priority Processing", "Dedicated Relationship Manager", "Exclusive Training", "Early Access", "Sponsored Events"] },
  { name: "Diamond", icon: "💎", max: Infinity, share: 90, perks: ["90% Commission Rate", "Priority Application Processing", "Dedicated Relationship Manager", "Exclusive Training & Webinars", "Early Access to New Universities", "Sponsored Events & Fam Trips"] },
] as const;
const loyaltyTierFor = (count: number) => LOYALTY_TIERS.find((t) => count <= t.max) ?? LOYALTY_TIERS[LOYALTY_TIERS.length - 1]!;

type DocStatus = "pending" | "approved" | "rejected";
const DOC_BADGE: Record<DocStatus, { label: string; cls: string }> = {
  approved: { label: "Verified", cls: "bg-[#ECFDF3] text-[#027A48]" },
  pending: { label: "Pending Review", cls: "bg-[#FFFAEB] text-[#B54708]" },
  rejected: { label: "Rejected", cls: "bg-[#FEF3F2] text-[#B42318]" },
};

const NOTIF_CATEGORIES: { title: string; rows: { key: string; label: string }[] }[] = [
  {
    title: "Application Updates",
    rows: [
      { key: "app.new", label: "New Application Submitted" },
      { key: "app.status", label: "Application Status Change" },
      { key: "app.doc", label: "Document Uploaded by Student" },
      { key: "app.offer", label: "Offer Letter Received" },
    ],
  },
  {
    title: "Financial",
    rows: [
      { key: "fin.commission", label: "Commission Credited" },
      { key: "fin.invoice", label: "Invoice Generated" },
      { key: "fin.payment", label: "Payment Reminder" },
    ],
  },
  {
    title: "Events & Training",
    rows: [
      { key: "evt.reminder", label: "Upcoming Event Reminder" },
      { key: "evt.training", label: "Training Session Available" },
      { key: "evt.webinar", label: "Webinar Registration Confirmation" },
    ],
  },
  {
    title: "System",
    rows: [
      { key: "sys.feature", label: "New Feature Announcements" },
      { key: "sys.maintenance", label: "System Maintenance Alerts" },
      { key: "sys.report", label: "Monthly Performance Report" },
    ],
  },
];

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function PartnerAccountPage() {
  const router = useRouter();
  const me = api.auth.me.useQuery(undefined, { retry: false });
  const account = api.account.get.useQuery();
  const utils = api.useUtils();
  const updateProfile = api.account.updateProfile.useMutation({
    onSuccess: async () => {
      // Refetch both: the page (account.get) and the topbar identity (auth.me)
      // so the new name shows up in the navbar without a reload.
      await Promise.all([
        utils.account.get.invalidate(),
        utils.auth.me.invalidate(),
      ]);
    },
  });

  // Bounce away if MOU was unsigned or status flipped — same pattern as the
  // dashboard page; this page sits behind /partner/dashboard's gate.
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/partner/dashboard") {
      router.replace(target);
    }
  }, [me.data?.redirectUrl, router]);

  const [tab, setTab] = useState<TabKey>("profile");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string }>({});
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Notification toggles are local-only for now. Defaults mirror the mock.
  const [notifPrefs, setNotifPrefs] = useState<Record<string, { email: boolean; whatsapp: boolean }>>(() => {
    const init: Record<string, { email: boolean; whatsapp: boolean }> = {};
    for (const cat of NOTIF_CATEGORIES) {
      for (const row of cat.rows) {
        init[row.key] = { email: true, whatsapp: false };
      }
    }
    return init;
  });

  // Hydrate form once data is loaded.
  useEffect(() => {
    if (account.data) {
      setFirstName(account.data.profile.firstName);
      setLastName(account.data.profile.lastName);
      setAvatarUrl(account.data.profile.avatarUrl);
    }
  }, [account.data]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const initials = useMemo(() => {
    const f = firstName.trim()[0] ?? "";
    const l = lastName.trim()[0] ?? "";
    return (f + l).toUpperCase() || "?";
  }, [firstName, lastName]);

  if (account.isLoading) {
    return <div className="text-sm text-[#667085]">Loading account…</div>;
  }
  if (account.error || !account.data) {
    return (
      <div className="rounded-lg border border-[#FEE4E2] bg-[#FEF3F2] p-4 text-sm text-[#B42318]">
        Couldn&apos;t load account: {account.error?.message ?? "Unknown error"}
      </div>
    );
  }

  const data = account.data;
  // Payouts, loyalty and KYC belong to the agency (its owner), so an agency
  // counsellor only manages their own profile and notifications.
  const tabs: TabKey[] =
    data.partnerType === "agency"
      ? ["profile", "business", "bank", "documents", "loyalty", "notifications"]
      : data.partnerType === "counsellor"
        ? ["profile", "notifications"]
        : ["profile", "bank", "documents", "loyalty", "notifications"];

  const handlePhotoSelect = async (file: File) => {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      showToast("Please upload a JPG or PNG file");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast("File size must be under 2MB");
      return;
    }
    setAvatarUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("folder", "avatars");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Upload failed");
      }
      const json = (await res.json()) as { url: string };
      setAvatarUrl(json.url);
      showToast("Photo uploaded — click Save Changes to apply");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemovePhoto = () => {
    setAvatarUrl(null);
    showToast("Photo removed — click Save Changes to apply");
  };

  const handleSaveProfile = async () => {
    const errs: typeof errors = {};
    if (!firstName.trim()) errs.firstName = "First name is required";
    if (!lastName.trim()) errs.lastName = "Last name is required";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    try {
      await updateProfile.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        avatarUrl,
      });
      showToast("Profile information saved successfully");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed");
    }
  };

  const handleCancelProfile = () => {
    setFirstName(data.profile.firstName);
    setLastName(data.profile.lastName);
    setAvatarUrl(data.profile.avatarUrl);
    setErrors({});
    showToast("Changes discarded");
  };

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">My Account</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Manage your profile, business info, and preferences
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex overflow-x-auto border-b-2 border-[#E4E7EC]">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-0.5 cursor-pointer border-b-2 bg-transparent px-6 py-3 text-sm font-semibold whitespace-nowrap transition-colors ${
              tab === t
                ? "border-[#1570EF] text-[#1570EF]"
                : "border-transparent text-[#667085] hover:text-[#1570EF]"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "profile" && (
        <div className="rounded-2xl border border-[#E4E7EC] bg-white p-7">
          {/* Photo */}
          <div className="mb-6 flex items-center gap-5 border-b border-[#F2F4F7] pb-6">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-[#1570EF] to-[#0b4ea2] text-2xl font-bold text-white">
              {avatarUrl ? (
                <Image
                  src={avatarUrl}
                  alt="Profile photo"
                  width={80}
                  height={80}
                  unoptimized
                  className="h-full w-full object-cover"
                />
              ) : (
                <span>{initials}</span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handlePhotoSelect(file);
                  }}
                />
                <button
                  type="button"
                  disabled={avatarUploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="cursor-pointer rounded-lg border border-[#1570EF] bg-white px-4 py-2 text-[13px] font-semibold text-[#1570EF] transition-colors hover:bg-[#1570EF] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {avatarUploading
                    ? "Uploading…"
                    : avatarUrl
                      ? "Change Photo"
                      : "Upload Photo"}
                </button>
                {avatarUrl && (
                  <button
                    type="button"
                    onClick={handleRemovePhoto}
                    className="cursor-pointer border-none bg-transparent text-[13px] font-medium text-[#F04438] hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="text-xs text-[#98A2B3]">
                JPG or PNG. Max size 2MB.
              </div>
            </div>
          </div>

          {/* Form */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Field
              label="First Name"
              required
              error={errors.firstName}
            >
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={`rounded-lg border px-3.5 py-2.5 text-sm text-[#101828] outline-none transition-all focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.1)] ${
                  errors.firstName
                    ? "border-[#F04438] shadow-[0_0_0_3px_rgba(240,68,56,0.12)]"
                    : "border-[#D0D5DD]"
                }`}
              />
            </Field>
            <Field
              label="Last Name"
              required
              error={errors.lastName}
            >
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={`rounded-lg border px-3.5 py-2.5 text-sm text-[#101828] outline-none transition-all focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.1)] ${
                  errors.lastName
                    ? "border-[#F04438] shadow-[0_0_0_3px_rgba(240,68,56,0.12)]"
                    : "border-[#D0D5DD]"
                }`}
              />
            </Field>
            <Field
              label="Email Address"
              required
              badge={data.profile.isEmailVerified ? "verified" : null}
            >
              <input
                type="email"
                readOnly
                value={data.profile.email}
                className="cursor-not-allowed rounded-lg border border-[#D0D5DD] bg-[#F9FAFB] px-3.5 py-2.5 text-sm text-[#667085] outline-none"
              />
            </Field>
            <Field
              label="Phone Number"
              required
              badge={data.profile.isPhoneVerified ? "verified" : null}
            >
              <input
                type="tel"
                readOnly
                value={`${data.profile.countryCode} ${data.profile.phone}`.trim()}
                className="cursor-not-allowed rounded-lg border border-[#D0D5DD] bg-[#F9FAFB] px-3.5 py-2.5 text-sm text-[#667085] outline-none"
              />
            </Field>
            <Field label="Role">
              <input
                type="text"
                readOnly
                value={data.profile.roleLabel}
                className="cursor-not-allowed rounded-lg border border-[#D0D5DD] bg-[#F9FAFB] px-3.5 py-2.5 text-sm text-[#667085] outline-none"
              />
            </Field>
            <Field label="Date Joined">
              <input
                type="text"
                readOnly
                value={formatDate(data.profile.joinedAt)}
                className="cursor-not-allowed rounded-lg border border-[#D0D5DD] bg-[#F9FAFB] px-3.5 py-2.5 text-sm text-[#667085] outline-none"
              />
            </Field>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={handleSaveProfile}
              disabled={updateProfile.isPending}
              className="cursor-pointer rounded-lg border-none bg-[#1570EF] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1260d4] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {updateProfile.isPending ? "Saving…" : "Save Changes"}
            </button>
            <button
              type="button"
              onClick={handleCancelProfile}
              className="cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-5 py-2.5 text-sm font-semibold text-[#344054] transition-colors hover:bg-[#F9FAFB]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {tab === "business" && data.business && (
        <div className="rounded-2xl border border-[#E4E7EC] bg-white p-7">
          <p className="mb-5 text-xs text-[#98A2B3]">
            Business information is managed by Collegepond. To request changes,
            contact your relationship manager.
          </p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
            <ReadOnlyRow label="Company / Agency Name" value={data.business.name} />
            <ReadOnlyRow label="GST Number" value={data.business.gstNumber} />
            <ReadOnlyRow label="Address" value={data.business.address} />
            <ReadOnlyRow label="City" value={data.business.city} />
            <ReadOnlyRow label="State" value={data.business.state} />
            <ReadOnlyRow label="Country" value={data.business.country} />
            <ReadOnlyRow
              label="Website"
              value={data.business.website}
              isLink={!!data.business.website}
            />
          </dl>
        </div>
      )}

      {tab === "bank" && <BankDetailsTab onToast={showToast} />}

      {tab === "loyalty" && <LoyaltyTab />}

      {tab === "documents" && (
        <div className="rounded-2xl border border-[#E4E7EC] bg-white p-7">
          <div className="mb-4">
            <h3 className="text-base font-semibold text-[#101828]">
              Uploaded Documents
            </h3>
            <p className="mt-1 text-xs text-[#667085]">
              View documents you submitted during signup. To replace a document,
              contact your relationship manager.
            </p>
          </div>
          <ul className="divide-y divide-[#F2F4F7]">
            {/* MOU row first */}
            <li className="flex items-center gap-4 py-4">
              <DocIconLeaf
                tone={data.mou.signed ? "verified" : "muted"}
                stroke={data.mou.signed ? "#12B76A" : "#98A2B3"}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[#101828]">
                  Executed MOU
                </div>
                <div className="text-xs text-[#667085]">
                  {data.mou.signed
                    ? `Digitally signed on ${formatDate(data.mou.signedAt)}`
                    : "MOU has not been signed yet"}
                </div>
              </div>
              <span
                className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                  data.mou.signed
                    ? "bg-[#ECFDF3] text-[#027A48]"
                    : "bg-[#F2F4F7] text-[#667085]"
                }`}
              >
                {data.mou.signed ? "Signed" : "Not Signed"}
              </span>
            </li>

            {data.documents.length === 0 ? (
              <li className="py-6 text-center text-sm text-[#98A2B3]">
                No documents uploaded yet.
              </li>
            ) : (
              data.documents.map((doc) => (
                <li
                  key={doc.id}
                  className="flex items-center gap-4 py-4"
                >
                  <DocIconLeaf
                    tone={
                      doc.status === "approved"
                        ? "verified"
                        : doc.status === "rejected"
                          ? "danger"
                          : "pending"
                    }
                    stroke={
                      doc.status === "approved"
                        ? "#12B76A"
                        : doc.status === "rejected"
                          ? "#F04438"
                          : "#F79009"
                    }
                  />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-semibold text-[#101828]">
                      {doc.label}
                    </div>
                    <div className="truncate text-xs text-[#667085]">
                      {doc.fileName}
                      <span className="ml-2 text-[#98A2B3]">
                        Uploaded {formatDate(doc.uploadedAt)}
                      </span>
                    </div>
                  </div>
                  <span
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold ${DOC_BADGE[doc.status].cls}`}
                  >
                    {DOC_BADGE[doc.status].label}
                  </span>
                  <a
                    href={doc.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-[#D0D5DD] bg-white px-3 py-1.5 text-xs font-semibold text-[#344054] no-underline transition-colors hover:bg-[#F9FAFB]"
                  >
                    View
                  </a>
                  <a
                    href={doc.fileUrl}
                    download={doc.fileName}
                    className="rounded-md border border-[#D0D5DD] bg-white px-3 py-1.5 text-xs font-semibold text-[#344054] no-underline transition-colors hover:bg-[#F9FAFB]"
                  >
                    Download
                  </a>
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      {tab === "notifications" && (
        <div className="rounded-2xl border border-[#E4E7EC] bg-white p-7">
          {/* Column header */}
          <div className="mb-4 flex items-center border-b border-[#F2F4F7] pb-3 pl-1">
            <div className="flex-1" />
            <div className="flex w-[180px] items-center justify-between text-xs font-semibold tracking-wider text-[#98A2B3] uppercase">
              <span className="w-20 text-center">Email</span>
              <span className="w-20 text-center">WhatsApp</span>
            </div>
          </div>

          {NOTIF_CATEGORIES.map((cat) => (
            <div key={cat.title} className="mb-6 last:mb-0">
              <h4 className="mb-2 text-sm font-semibold text-[#101828]">
                {cat.title}
              </h4>
              <div className="divide-y divide-[#F2F4F7] rounded-lg border border-[#F2F4F7]">
                {cat.rows.map((row) => {
                  const pref = notifPrefs[row.key] ?? { email: true, whatsapp: false };
                  return (
                    <div
                      key={row.key}
                      className="flex items-center px-4 py-3"
                    >
                      <div className="flex-1 text-sm text-[#344054]">
                        {row.label}
                      </div>
                      <div className="flex w-[180px] items-center justify-between">
                        <Toggle
                          checked={pref.email}
                          onChange={(v) =>
                            setNotifPrefs((prev) => ({
                              ...prev,
                              [row.key]: { ...pref, email: v },
                            }))
                          }
                        />
                        <Toggle
                          checked={pref.whatsapp}
                          onChange={(v) =>
                            setNotifPrefs((prev) => ({
                              ...prev,
                              [row.key]: { ...pref, whatsapp: v },
                            }))
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="mt-6 flex items-center gap-4 border-t border-[#F2F4F7] pt-5">
            <button
              type="button"
              onClick={() => showToast("Notification preferences saved")}
              className="cursor-pointer rounded-lg border-none bg-[#1570EF] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1260d4]"
            >
              Save Preferences
            </button>
            <span className="text-xs text-[#98A2B3]">
              You can change your notification preferences at any time.
            </span>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed right-6 bottom-6 z-[200] flex items-center gap-2 rounded-lg bg-[#101828] px-4 py-3 text-sm font-medium text-white shadow-[0_4px_12px_rgba(0,0,0,0.15)]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {toast}
        </div>
      )}
    </>
  );
}

// Bank Details tab — the partner's payout account, sourced from our own
// partner_bank_account store (entered in the invoice wizard, encrypted at rest).
// This is NOT RazorpayX data; RazorpayX consumes this account for payouts.
const BANK_INPUT =
  "rounded-lg border border-[#D0D5DD] px-3.5 py-2.5 text-sm text-[#101828] outline-none transition-all focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.1)]";

function BankDetailsTab({ onToast }: { onToast: (m: string) => void }) {
  const utils = api.useUtils();
  const bankQ = api.partnerCommission.bankAccount.useQuery();
  const bank = bankQ.data;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    accountHolder: "", accountNumber: "", ifsc: "", swift: "",
    bankName: "", branch: "", accountType: "Current Account",
  });
  const [err, setErr] = useState("");
  const save = api.partnerCommission.saveBankAccount.useMutation({
    onSuccess: async () => {
      await utils.partnerCommission.bankAccount.invalidate();
      setEditing(false);
      setForm((f) => ({ ...f, accountNumber: "" }));
      onToast("Bank details saved");
    },
    onError: (e) => setErr(e.message),
  });

  const startEdit = () => {
    setErr("");
    setForm({
      accountHolder: bank?.accountHolder ?? "",
      accountNumber: "",
      ifsc: bank?.ifsc ?? "",
      swift: bank?.swift ?? "",
      bankName: bank?.bankName ?? "",
      branch: bank?.branch ?? "",
      accountType: bank?.accountType ?? "Current Account",
    });
    setEditing(true);
  };
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    setErr("");
    if (!form.accountHolder.trim()) return setErr("Account holder name is required");
    if (!form.accountNumber.trim()) return setErr("Enter the account number to save");
    save.mutate({
      accountHolder: form.accountHolder.trim(),
      accountNumber: form.accountNumber.trim(),
      ifsc: form.ifsc || undefined,
      swift: form.swift || undefined,
      bankName: form.bankName || undefined,
      branch: form.branch || undefined,
      accountType: form.accountType || undefined,
    });
  };

  if (bankQ.isLoading) {
    return <div className="rounded-2xl border border-[#E4E7EC] bg-white p-7 text-sm text-[#667085]">Loading bank details…</div>;
  }

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div>
      <div className="text-xs font-medium tracking-wide text-[#98A2B3] uppercase">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-[#101828]">{value || "—"}</div>
    </div>
  );

  return (
    <div className="rounded-2xl border border-[#E4E7EC] bg-white p-7">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[#101828]">Bank Details</h3>
          <p className="mt-1 text-xs text-[#667085]">
            The account CollegePond pays your commission into. 🔒 Stored encrypted — only the last 4 digits are shown back.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="shrink-0 rounded-lg border border-[#D0D5DD] bg-white px-3.5 py-2 text-xs font-semibold text-[#344054] transition-colors hover:bg-[#F9FAFB]"
          >
            {bank?.hasAccount ? "Update" : "Add bank account"}
          </button>
        )}
      </div>

      {!editing ? (
        bank?.hasAccount ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Row label="Account Holder" value={bank.accountHolder ?? ""} />
            <Row label="Account Number" value={bank.accountNumberLast4 ? `•••• ${bank.accountNumberLast4}` : ""} />
            <Row label="Bank Name" value={bank.bankName ?? ""} />
            <Row label="Branch" value={bank.branch ?? ""} />
            <Row label="IFSC" value={bank.ifsc ?? ""} />
            <Row label="SWIFT" value={bank.swift ?? ""} />
            <Row label="Account Type" value={bank.accountType ?? ""} />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-[#D0D5DD] py-10 text-center text-sm text-[#98A2B3]">
            No bank account on file yet. Add one so CollegePond can pay your commission.
          </div>
        )
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Account Holder" required>
              <input className={BANK_INPUT} value={form.accountHolder} onChange={(e) => set("accountHolder", e.target.value)} />
            </Field>
            <Field label={bank?.hasAccount ? "Account Number (re-enter to update)" : "Account Number"} required>
              <input className={BANK_INPUT} value={form.accountNumber} onChange={(e) => set("accountNumber", e.target.value)} placeholder={bank?.accountNumberLast4 ? `•••• ${bank.accountNumberLast4}` : ""} />
            </Field>
            <Field label="Bank Name">
              <input className={BANK_INPUT} value={form.bankName} onChange={(e) => set("bankName", e.target.value)} />
            </Field>
            <Field label="Branch">
              <input className={BANK_INPUT} value={form.branch} onChange={(e) => set("branch", e.target.value)} />
            </Field>
            <Field label="IFSC">
              <input className={BANK_INPUT} value={form.ifsc} onChange={(e) => set("ifsc", e.target.value)} />
            </Field>
            <Field label="SWIFT (international)">
              <input className={BANK_INPUT} value={form.swift} onChange={(e) => set("swift", e.target.value)} />
            </Field>
            <Field label="Account Type">
              <select className={BANK_INPUT} value={form.accountType} onChange={(e) => set("accountType", e.target.value)}>
                <option value="Current Account">Current Account</option>
                <option value="Savings Account">Savings Account</option>
              </select>
            </Field>
          </div>
          {err && <p className="text-xs font-medium text-[#F04438]">{err}</p>}
          <div className="flex items-center gap-3">
            <Button onClick={submit} loading={save.isPending}>Save Bank Details</Button>
            <button
              type="button"
              onClick={() => { setEditing(false); setErr(""); }}
              className="rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-sm font-semibold text-[#344054] transition-colors hover:bg-[#F9FAFB]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Loyalty tab — current tier (from this FY's enrolled-student count) + the full
// tier ladder with benefits. Same data as the Commission page banner/modal.
function LoyaltyTab() {
  const yearlyQ = api.partnerCommission.yearlyStats.useQuery();
  const [show, setShow] = useState<string | null>(null);

  const yearly = yearlyQ.data ?? [];
  const thisYearCount = yearly.length > 0 ? yearly[yearly.length - 1]!.students : 0;
  const tier = loyaltyTierFor(thisYearCount);
  const tierIdx = LOYALTY_TIERS.indexOf(tier);
  const nextTier = LOYALTY_TIERS[tierIdx + 1] ?? null;
  const shown = LOYALTY_TIERS.find((t) => t.name === (show ?? tier.name)) ?? tier;

  return (
    <div className="rounded-2xl border border-[#E4E7EC] bg-white p-7">
      {/* Current tier banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E9D7FE] bg-gradient-to-r from-[#F4F3FF] to-[#FFFFFF] px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{tier.icon}</span>
          <div>
            <div className="text-sm font-bold text-[#101828]">Your Current Tier — {tier.name} · {tier.share}% Commission</div>
            <div className="text-xs text-[#667085]">
              {thisYearCount} student{thisYearCount === 1 ? "" : "s"} this year
              {nextTier ? ` · ${Math.max(0, nextTier.max - thisYearCount + 1)} more to reach ${nextTier.name}` : " · You've reached the top tier!"}
            </div>
          </div>
        </div>
      </div>

      {/* Tier ladder */}
      <div className="mt-5 grid grid-cols-5 gap-2">
        {LOYALTY_TIERS.map((t) => {
          const active = shown.name === t.name;
          return (
            <button
              key={t.name}
              onClick={() => setShow(t.name)}
              className={`rounded-lg border p-2 text-center transition ${active ? "border-[#1570EF] bg-[#EFF8FF]" : "border-[#E4E7EC] hover:bg-[#F9FAFB]"}`}
            >
              <div className="text-xl">{t.icon}</div>
              <div className="text-xs font-bold text-[#101828]">{t.name}</div>
              <div className="text-[10px] text-[#667085]">{t.share}%</div>
              {t.name === tier.name && <div className="mt-0.5 text-[9px] font-semibold text-[#1570EF]">CURRENT</div>}
            </button>
          );
        })}
      </div>

      {/* Benefits of the selected tier */}
      <div className="mt-4 rounded-lg border border-[#E4E7EC] p-4">
        <div className="mb-2 text-sm font-bold text-[#101828]">{shown.icon} {shown.name} Tier Benefits</div>
        <ul className="space-y-1.5">
          {shown.perks.map((p) => (
            <li key={p} className="flex items-center gap-2 text-sm text-[#344054]"><span className="text-[#12B76A]">✓</span> {p}</li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-[#98A2B3]">Tiers are based on students enrolled per financial year; targets reset on April 1, with a one-tier grace buffer.</p>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  badge,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  badge?: "verified" | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-[13px] font-semibold text-[#344054]">
        {label}
        {required && <span className="text-[#F04438]">*</span>}
        {badge === "verified" && (
          <span className="inline-flex items-center gap-1 rounded-md bg-[#ECFDF3] px-1.5 py-0.5 text-[11px] font-semibold text-[#027A48]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3 w-3"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Verified
          </span>
        )}
      </label>
      {children}
      {error && <span className="text-xs text-[#F04438]">{error}</span>}
    </div>
  );
}

function ReadOnlyRow({
  label,
  value,
  isLink,
}: {
  label: string;
  value: string | null | undefined;
  isLink?: boolean;
}) {
  const display = value && value.length > 0 ? value : "—";
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-[13px] font-semibold text-[#344054]">{label}</dt>
      <dd className="rounded-lg border border-[#D0D5DD] bg-[#F9FAFB] px-3.5 py-2.5 text-sm text-[#667085]">
        {isLink && value ? (
          <a
            href={value.startsWith("http") ? value : `https://${value}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#1570EF] hover:underline"
          >
            {value}
          </a>
        ) : (
          display
        )}
      </dd>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 cursor-pointer rounded-full border-none transition-colors ${
        checked ? "bg-[#1570EF]" : "bg-[#E4E7EC]"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function DocIconLeaf({
  tone,
  stroke,
}: {
  tone: "verified" | "pending" | "danger" | "muted";
  stroke: string;
}) {
  const bg =
    tone === "verified"
      ? "bg-[#ECFDF3]"
      : tone === "danger"
        ? "bg-[#FEF3F2]"
        : tone === "pending"
          ? "bg-[#FFFAEB]"
          : "bg-[#F2F4F7]";
  return (
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${bg}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke={stroke}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    </div>
  );
}
