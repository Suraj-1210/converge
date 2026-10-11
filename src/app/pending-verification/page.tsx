"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "~/trpc/react";
import { ImpersonationBanner } from "~/components/dashboard/impersonation";

// Where a partner lands while not yet approved (or after a rejection /
// deactivation): what has been done, which documents are verified, missing
// or not accepted, what the team asked for, and how to send anything missing.
// Partners can't upload here — the portal opens once documents are complete;
// missing files go to support by email and the team adds them.

type DocState = "missing" | "in_review" | "verified" | "rejected";

const DOC_STATE: Record<DocState, { label: string; cls: string; dot: string }> = {
  verified: { label: "Verified", cls: "bg-[#ECFDF3] text-[#027A48]", dot: "#12B76A" },
  in_review: { label: "Under review", cls: "bg-[#FFFAEB] text-[#B54708]", dot: "#F79009" },
  rejected: { label: "Not accepted", cls: "bg-[#FEF3F2] text-[#B42318]", dot: "#F04438" },
  missing: { label: "Missing", cls: "bg-[#F2F4F7] text-[#475467]", dot: "#98A2B3" },
};

const SUPPORT = "support@collegepond.com";

export default function PendingVerificationPage() {
  const router = useRouter();
  const me = api.auth.me.useQuery(undefined, { retry: false });
  const progress = api.auth.applicationProgress.useQuery(undefined, { retry: false });

  // Bounce away if state has shifted under us (e.g. approved meanwhile).
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/pending-verification") {
      router.replace(target);
    }
  }, [me.data?.redirectUrl, router]);

  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F9FAFB] text-sm text-[#667085]">
        Loading…
      </div>
    );
  }

  if (me.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F9FAFB] p-6">
        <div className="w-full max-w-[460px] rounded-2xl bg-white p-8 text-center shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
          <h1 className="mb-2 text-xl font-bold text-[#101828]">Session Expired</h1>
          <p className="mb-6 text-sm text-[#667085]">
            Please sign in again to view your application status.
          </p>
          <Link
            href="/login"
            className="inline-flex h-[42px] w-full items-center justify-center rounded-lg bg-[#1570EF] text-sm font-semibold text-white hover:bg-[#1260d4]"
          >
            Back to Login
          </Link>
        </div>
      </div>
    );
  }

  const data = me.data!;
  const p = progress.data;
  const rejected = data.status === "rejected";
  const inactive = data.status === "inactive";
  const required = p?.documents.filter((d) => d.required) ?? [];
  const outstanding = required.filter((d) => d.state === "missing" || d.state === "rejected");
  const verifiedCount = required.filter((d) => d.state === "verified").length;

  const heading = rejected
    ? "Your Application was not Approved"
    : inactive
      ? "Your Account is Inactive"
      : outstanding.length
        ? "We Need a Few More Documents"
        : "Your Application is Under Review";

  const blurb = rejected
    ? "Our team reviewed your application and was unable to approve it. If you can provide what is missing below, we can take another look."
    : inactive
      ? `Your account is currently inactive. Contact ${SUPPORT} to reactivate it.`
      : outstanding.length
        ? "Your application can't be completed until the documents marked below are received. The portal opens once everything is verified."
        : "Thanks for signing up with Collegepond. Our team is reviewing your documents. You'll get an email as soon as your account is approved — typically within 24–48 hours.";

  const accent = rejected || inactive ? "#F04438" : outstanding.length ? "#F79009" : "#1570EF";

  const steps: { label: string; done: boolean; current?: boolean }[] = [
    { label: "Application submitted", done: true },
    { label: "Email & phone verified", done: p?.contactVerified ?? true },
    {
      label: required.length
        ? `Documents verified (${verifiedCount} of ${required.length})`
        : "Documents verified",
      done: required.length > 0 && verifiedCount === required.length,
      current: !rejected && !inactive,
    },
    { label: "Approval by Collegepond", done: false, current: !rejected && !inactive && !outstanding.length },
  ];

  return (
    <>
    <ImpersonationBanner side="partner" fixed={false} />
    <div className="flex min-h-screen justify-center bg-[#F9FAFB] p-6">
      <div className="my-auto w-full max-w-[620px] rounded-2xl bg-white p-8 shadow-[0_8px_30px_rgba(0,0,0,0.06)] sm:p-10">
        <div
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full"
          style={{ background: `${accent}1A` }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 8v4l3 2M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"
              stroke={accent}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <h1 className="mb-2 text-center text-2xl font-bold text-[#101828]">
          {data.firstName ? `Hi ${data.firstName}, ` : ""}
          {heading}
        </h1>
        <p className="mx-auto mb-7 max-w-[460px] text-center text-sm leading-relaxed text-[#667085]">
          {blurb}
        </p>

        {/* Decision reason (rejected / deactivated) */}
        {(rejected || inactive) && p?.reason && (
          <Panel title={rejected ? "Reason" : "Reason for deactivation"} tone="red">
            <p className="text-sm text-[#344054]">{p.reason}</p>
          </Panel>
        )}

        {/* What the team asked for */}
        {!inactive && p?.moreInfo && (
          <Panel
            title={`Requested by our team on ${new Date(p.moreInfo.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
            tone="amber"
          >
            {p.moreInfo.items.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-[#344054]">
                {p.moreInfo.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            )}
            {p.moreInfo.message && (
              <p className="mt-2 text-sm whitespace-pre-line text-[#475467]">{p.moreInfo.message}</p>
            )}
          </Panel>
        )}

        {/* Progress steps */}
        {!inactive && (
          <ol className="mb-6 space-y-2.5">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3 text-sm">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    s.done
                      ? "bg-[#12B76A] text-white"
                      : s.current
                        ? "border-2 border-[#1570EF] text-[#1570EF]"
                        : "border-2 border-[#D0D5DD] text-[#98A2B3]"
                  }`}
                >
                  {s.done ? "✓" : ""}
                </span>
                <span className={s.done ? "text-[#344054]" : s.current ? "font-semibold text-[#101828]" : "text-[#98A2B3]"}>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        )}

        {/* Documents */}
        {!inactive && (
          <div className="mb-6 rounded-xl border border-[#EAECF0]">
            <div className="border-b border-[#EAECF0] px-4 py-3 text-[13px] font-semibold text-[#344054]">
              Your documents
            </div>
            {progress.isLoading ? (
              <div className="px-4 py-4 text-sm text-[#98A2B3]">Loading…</div>
            ) : (
              <ul>
                {p?.documents.map((d) => {
                  const st = DOC_STATE[d.state];
                  return (
                    <li
                      key={d.key}
                      className="flex items-center justify-between gap-3 border-b border-[#F2F4F7] px-4 py-2.5 text-sm last:border-b-0"
                    >
                      <span className="text-[#344054]">
                        {d.label}
                        {!d.required && <span className="ml-1 text-xs text-[#98A2B3]">(optional)</span>}
                      </span>
                      <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${st.cls}`}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                        {st.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* How to send what's missing */}
        {!inactive && outstanding.length > 0 && (
          <Panel title="How to send missing documents" tone="blue">
            <p className="text-sm text-[#344054]">
              Email the documents marked <strong>Missing</strong> or <strong>Not accepted</strong> to{" "}
              <a href={`mailto:${SUPPORT}?subject=${encodeURIComponent(`Documents for application ${data.applicationId}`)}`} className="font-semibold text-[#1570EF] hover:underline">
                {SUPPORT}
              </a>{" "}
              with your Application ID <strong>{data.applicationId}</strong>. Clear scans or photos (PDF, JPG or PNG) work best. Our team will add them to your application.
            </p>
          </Panel>
        )}

        <div className="mb-6 grid grid-cols-2 gap-3.5 rounded-[10px] bg-[#F9FAFB] p-4 text-left">
          {data.applicationId && (
            <Field label="Application ID" value={data.applicationId} />
          )}
          <Field label="Email" value={data.email} />
        </div>

        <Link
          href="/login"
          className="flex h-[42px] w-full items-center justify-center rounded-lg border border-[#D0D5DD] bg-white text-sm font-semibold text-[#344054] transition-colors hover:bg-[#F9FAFB]"
        >
          Back to Login
        </Link>
      </div>
    </div>
    </>
  );
}

function Panel({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "red" | "amber" | "blue";
  children: React.ReactNode;
}) {
  const cls =
    tone === "red"
      ? "border-[#FECDCA] bg-[#FEF3F2]"
      : tone === "amber"
        ? "border-[#FEDF89] bg-[#FFFCF5]"
        : "border-[#B2DDFF] bg-[#EFF8FF]";
  return (
    <div className={`mb-5 rounded-xl border px-4 py-3 ${cls}`}>
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-[#475467] uppercase">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium tracking-wide text-[#98A2B3] uppercase">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-[#101828]">{value}</div>
    </div>
  );
}
