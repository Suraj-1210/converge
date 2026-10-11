"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "~/components/ui/button";
import { Toast } from "~/components/ui/toast";
import { api } from "~/trpc/react";
import { ImpersonationBanner } from "~/components/dashboard/impersonation";

type Step = 0 | 1 | 2 | 3;
type SignatureMode = "draw" | "type";

const STEP_LABELS = ["Welcome", "Review MOU", "Digital Signature", "Confirmation"];
const LEFT_TITLES = [
  "Partnership Agreement",
  "Review Agreement",
  "Sign the Agreement",
  "All Done!",
];
const LEFT_SUBTITLES = [
  "Review and digitally sign your Memorandum of Understanding to activate your partner account.",
  "Please read through the complete terms and conditions of our partnership agreement.",
  "Provide your digital signature to formalize the partnership agreement.",
  "Your MOU has been signed. You can now access the full Partner Portal.",
];

const TODAY_LABEL = new Date().toLocaleDateString("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export default function MouSigningPage() {
  const router = useRouter();
  const me = api.auth.me.useQuery(undefined, { retry: false });
  const utils = api.useUtils();

  const [step, setStep] = useState<Step>(0);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [mode, setMode] = useState<SignatureMode>("draw");
  const [typedSig, setTypedSig] = useState("");
  const [hasDrawn, setHasDrawn] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [signedTypedName, setSignedTypedName] = useState<string>("");

  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };

  // Bounce away if state has shifted (already signed, or not approved yet).
  useEffect(() => {
    const target = me.data?.redirectUrl;
    if (target && target !== "/mou-signing") router.replace(target);
  }, [me.data?.redirectUrl, router]);

  const signMou = api.auth.signMou.useMutation({
    onSuccess: async () => {
      // Refresh redirectUrl (now /partner/dashboard) BEFORE advancing, so the
      // dashboard's redirect guard doesn't read the stale pre-sign value and
      // bounce back to /mou-signing — which forced a confusing second signing.
      await utils.auth.me.invalidate();
      goToStep(3);
    },
    onError: (err) => showToast(err.message),
  });

  const partnerName =
    `${me.data?.firstName ?? ""} ${me.data?.lastName ?? ""}`.trim() ||
    (me.data?.email ?? "Partner");

  const rightScrollRef = useRef<HTMLDivElement | null>(null);

  function goToStep(n: Step) {
    setStep(n);
    rightScrollRef.current?.scrollTo({ top: 0 });
  }

  // ---- Canvas drawing -------------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  function pointFromEvent(
    e: React.MouseEvent | React.TouchEvent,
  ): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cx =
      "touches" in e
        ? (e.touches[0]?.clientX ?? e.changedTouches[0]?.clientX ?? 0)
        : e.clientX;
    const cy =
      "touches" in e
        ? (e.touches[0]?.clientY ?? e.changedTouches[0]?.clientY ?? 0)
        : e.clientY;
    return {
      x: ((cx - rect.left) / rect.width) * canvas.width,
      y: ((cy - rect.top) / rect.height) * canvas.height,
    };
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    drawing.current = true;
    lastPoint.current = pointFromEvent(e);
  }

  function continueDraw(e: React.MouseEvent | React.TouchEvent) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    const p = pointFromEvent(e);
    if (!ctx || !p) return;
    if (!lastPoint.current) {
      lastPoint.current = p;
      return;
    }
    ctx.strokeStyle = "#101828";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPoint.current = p;
    setHasDrawn(true);
  }

  function endDraw() {
    drawing.current = false;
    lastPoint.current = null;
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
  }

  function handleSign() {
    if (mode === "draw") {
      const canvas = canvasRef.current;
      if (!canvas || !hasDrawn) {
        showToast("Please draw your signature");
        return;
      }
      const dataUrl = canvas.toDataURL("image/png");
      setSignatureDataUrl(dataUrl);
      signMou.mutate({ kind: "drawn", data: dataUrl });
    } else {
      const value = typedSig.trim();
      if (!value) {
        showToast("Please type your name as signature");
        return;
      }
      setSignedTypedName(value);
      setSignatureDataUrl(null);
      signMou.mutate({ kind: "typed", data: value });
    }
  }

  function handleEnterPortal() {
    router.replace("/partner/dashboard");
  }

  function onMouScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 10) {
      setScrolledToBottom(true);
    }
  }

  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F5F6FA] text-sm text-[#667085]">
        Loading…
      </div>
    );
  }

  const progressPct = ((step + 1) / 4) * 100;

  return (
    <>
      <ImpersonationBanner side="partner" fixed={false} />
      <div className="flex min-h-screen bg-[#F5F6FA] font-[family-name:var(--font-inter)]">
        {/* ===== LEFT BRAND PANEL ===== */}
        <div className="relative flex w-[480px] shrink-0 flex-col overflow-hidden bg-gradient-to-br from-[#0B4A8A] via-[#1570EF] to-[#53B1FD] px-12 py-12 text-white">
          {/* Decorative circles — match AdminBrandPanel */}
          <div className="pointer-events-none absolute -top-[120px] -right-[120px] h-[400px] w-[400px] rounded-full bg-white/[0.06]" />
          <div className="pointer-events-none absolute -bottom-20 -left-20 h-[300px] w-[300px] rounded-full bg-white/[0.04]" />

          {/* Logo block — matches AdminBrandPanel's lockup */}
          <div className="relative z-10 mb-10 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-white/15 backdrop-blur-[10px]">
            <svg viewBox="0 0 36 36" fill="none" className="h-9 w-9">
              <path
                d="M18 3L4 10v16l14 7 14-7V10L18 3z"
                fill="rgba(255,255,255,0.2)"
                stroke="#fff"
                strokeWidth="1.5"
              />
              <path
                d="M12 17l4 4 8-8"
                stroke="#fff"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="relative z-10 mb-1.5 text-[28px] font-extrabold tracking-tight text-white">
            Collegepond
          </div>
          <div className="relative z-10 mb-10 text-[13px] font-semibold uppercase tracking-[2px] text-white/70">
            Partner Portal
          </div>

          {/* Step-specific title/subtitle */}
          <div className="relative z-10 mb-10">
            <h1 className="mb-2.5 text-[22px] font-extrabold leading-tight">
              {LEFT_TITLES[step]}
            </h1>
            <p className="text-sm leading-relaxed text-white/75">
              {LEFT_SUBTITLES[step]}
            </p>
          </div>

          {/* Step indicator */}
          <div className="relative z-10 mt-auto flex flex-col">
            {STEP_LABELS.map((label, i) => {
              const active = step === i;
              const completed = step > i;
              const isLast = i === STEP_LABELS.length - 1;
              return (
                <div
                  key={label}
                  className={`relative flex items-center gap-3.5 ${
                    isLast ? "" : "pb-7"
                  }`}
                >
                  {!isLast && (
                    <span
                      className={`absolute top-9 left-[15px] h-[calc(100%-36px)] w-0.5 transition-colors ${
                        completed ? "bg-white/60" : "bg-white/20"
                      }`}
                    />
                  )}
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold transition-all ${
                      active
                        ? "bg-white text-[#1570EF]"
                        : completed
                          ? "bg-white/30 text-white"
                          : "bg-white/[0.12] text-white/50"
                    }`}
                  >
                    {completed ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M3 7l3 3 5-5"
                          stroke="#fff"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </div>
                  <span
                    className={`text-[13px] transition-colors ${
                      active
                        ? "font-semibold text-white"
                        : completed
                          ? "text-white/75"
                          : "font-medium text-white/45"
                    }`}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ===== RIGHT PANE ===== */}
        <div className="flex flex-1 flex-col bg-white">
          {/* Progress bar */}
          <div className="h-1 w-full shrink-0 bg-[#E4E7EC]">
            <div
              className="h-full bg-[#1570EF] transition-[width] duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div
            ref={rightScrollRef}
            className="flex flex-1 justify-center overflow-y-auto px-10 py-10"
          >
            <div className="flex w-full max-w-[640px] flex-col">
              {/* ===== STEP 0: WELCOME ===== */}
              {step === 0 && (
                <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease-out]">
                  <div className="mb-5 inline-flex w-fit items-center gap-1.5 rounded-full border border-[#A6F4C5] bg-[#ECFDF3] px-3.5 py-1.5 text-[13px] font-semibold text-[#027A48]">
                    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
                      <path
                        d="M13.333 4L6 11.333 2.667 8"
                        stroke="#12B76A"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Application Approved
                  </div>

                  <h2 className="mb-1 text-[22px] font-bold text-[#101828]">
                    Welcome to Collegepond Partner Portal
                  </h2>
                  <p className="mb-7 text-sm text-[#667085]">
                    Congratulations! Your partnership application has been approved.
                  </p>

                  <div className="mb-6 text-[15px] text-[#344054]">
                    Signing as: <strong className="font-bold text-[#101828]">{partnerName}</strong>
                  </div>

                  <p className="mb-6 text-sm leading-relaxed text-[#667085]">
                    Before you access the portal, please review and digitally sign the
                    Memorandum of Understanding (MOU). This agreement outlines the
                    terms of our partnership, commission structure, and mutual
                    obligations.
                  </p>

                  <div className="grid grid-cols-3 gap-3">
                    <FeatureCard
                      bg="rgba(21,112,239,0.08)"
                      stroke="#1570EF"
                      iconPath={
                        <>
                          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                        </>
                      }
                      title="Partnership Benefits"
                      body="Access to 500+ university programs and dedicated support"
                    />
                    <FeatureCard
                      bg="rgba(247,144,9,0.08)"
                      stroke="#F79009"
                      iconPath={
                        <>
                          <line x1="12" y1="1" x2="12" y2="23" />
                          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                        </>
                      }
                      title="Commission Structure"
                      body="Transparent payout tiers based on student enrollment volume"
                    />
                    <FeatureCard
                      bg="rgba(18,183,106,0.08)"
                      stroke="#12B76A"
                      iconPath={
                        <>
                          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3v5zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3v5z" />
                        </>
                      }
                      title="Dedicated Support"
                      body="Assigned counselor for application processing and queries"
                    />
                  </div>

                  <div className="mt-auto flex items-center justify-end pt-8">
                    <Button onClick={() => goToStep(1)} iconRight>
                      Review MOU
                    </Button>
                  </div>
                </div>
              )}

              {/* ===== STEP 1: MOU REVIEW ===== */}
              {step === 1 && (
                <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease-out]">
                  <h2 className="mb-1 text-[22px] font-bold text-[#101828]">
                    Memorandum of Understanding
                  </h2>
                  <p className="mb-7 text-sm text-[#667085]">
                    Please review the complete agreement below
                  </p>

                  <div
                    onScroll={onMouScroll}
                    className="mb-4 max-h-[380px] overflow-y-auto rounded-[10px] border border-[#E4E7EC] bg-[#FAFBFC] p-6"
                  >
                    <MouSection
                      number={1}
                      title="Partnership Terms"
                      body={
                        <>
                          <p>
                            This Memorandum of Understanding (&quot;MOU&quot;) is
                            entered into between Collegepond Education Services Pvt.
                            Ltd. (&quot;Collegepond&quot;) and the Partner
                            (&quot;Partner&quot;) identified in the registration,
                            establishing a referral and student placement
                            partnership.
                          </p>
                          <p className="mt-2">
                            The partnership shall commence from the date of digital
                            signing of this MOU and shall remain in effect for a
                            period of one (1) year, automatically renewable unless
                            terminated by either party with 30 days written notice.
                          </p>
                        </>
                      }
                    />
                    <MouSection
                      number={2}
                      title="Scope of Services"
                      body={
                        <>
                          <p>Under this agreement, Collegepond shall:</p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            <li>Provide access to the Collegepond Partner Portal for application management</li>
                            <li>Process student applications to partner universities on behalf of the Partner</li>
                            <li>Provide regular updates on application status and university decisions</li>
                            <li>Offer training materials and resources for counselors</li>
                            <li>Maintain direct relationships with 500+ universities across 15+ countries</li>
                          </ul>
                          <p className="mt-3">The Partner shall:</p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            <li>Submit complete and accurate student applications through the portal</li>
                            <li>Ensure all student documents are authentic and verified</li>
                            <li>Maintain professional standards in student counseling</li>
                            <li>Respond to queries and requests within reasonable timeframes</li>
                          </ul>
                        </>
                      }
                    />
                    <MouSection
                      number={3}
                      title="Commission Structure"
                      body={
                        <>
                          <p>
                            Collegepond shall pay the Partner a commission for each
                            successfully enrolled student as per the following tier
                            structure:
                          </p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            <li><strong>Silver Tier (1-10 students):</strong> 70% of university commission received by Collegepond</li>
                            <li><strong>Gold Tier (11-30 students):</strong> 75% of university commission received by Collegepond</li>
                            <li><strong>Platinum Tier (31-50 students):</strong> 80% of university commission received by Collegepond</li>
                            <li><strong>Titanium Tier (51-75 students):</strong> 85% of university commission received by Collegepond</li>
                            <li><strong>Diamond Tier (75+ students):</strong> 90% of university commission received by Collegepond</li>
                          </ul>
                          <p className="mt-2">
                            Commission shall be payable within 30 days of Collegepond
                            receiving payment from the respective university. All
                            payments shall be made via bank transfer to the account
                            specified by the Partner.
                          </p>
                        </>
                      }
                    />
                    <MouSection
                      number={4}
                      title="Obligations & Responsibilities"
                      body={
                        <>
                          <p>
                            Both parties agree to act in good faith and in the best
                            interest of the students. The Partner acknowledges that
                            Collegepond reserves the right to reject any application
                            that does not meet the minimum eligibility criteria set
                            by the partner universities.
                          </p>
                          <p className="mt-2">
                            The Partner shall not make any false promises or
                            guarantees to students regarding admission outcomes. Any
                            misrepresentation may result in immediate termination of
                            this partnership.
                          </p>
                        </>
                      }
                    />
                    <MouSection
                      number={5}
                      title="Confidentiality"
                      body={
                        <>
                          <p>
                            Both parties agree to maintain strict confidentiality
                            regarding all student information, commission structures,
                            internal processes, and proprietary systems shared during
                            the course of this partnership. This obligation survives
                            the termination of this MOU.
                          </p>
                          <p className="mt-2">
                            Neither party shall disclose confidential information to
                            third parties without prior written consent from the
                            other party, except as required by law.
                          </p>
                        </>
                      }
                    />
                    <MouSection
                      number={6}
                      title="Term & Termination"
                      last
                      body={
                        <>
                          <p>
                            This MOU may be terminated by either party with 30 days
                            written notice. Upon termination:
                          </p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            <li>All pending applications shall be processed to completion</li>
                            <li>Outstanding commissions shall be paid as per the agreed schedule</li>
                            <li>Access to the Partner Portal shall be revoked within 7 days</li>
                            <li>Both parties shall return or destroy any confidential information</li>
                          </ul>
                          <p className="mt-2">
                            Collegepond reserves the right to immediately terminate
                            this agreement in cases of fraud, misrepresentation, or
                            breach of confidentiality obligations without any prior
                            notice period.
                          </p>
                        </>
                      }
                    />
                  </div>

                  <div
                    className={`mb-3.5 flex items-center justify-center gap-1.5 text-xs text-[#98A2B3] transition-opacity ${
                      scrolledToBottom ? "pointer-events-none opacity-0" : ""
                    }`}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3.5 w-3.5 animate-bounce stroke-[#98A2B3]"
                    >
                      <path d="M8 3v10M4 9l4 4 4-4" />
                    </svg>
                    Scroll to read the complete agreement
                  </div>

                  <label className="mb-1 flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={agreed}
                      onChange={(e) => setAgreed(e.target.checked)}
                      className="mt-0.5 h-[18px] w-[18px] cursor-pointer accent-[#1570EF]"
                    />
                    <span className="text-[13px] font-medium leading-relaxed text-[#344054]">
                      I have read and agree to the terms and conditions of this
                      Memorandum of Understanding
                    </span>
                  </label>

                  <div className="mt-auto flex items-center justify-between gap-2 pt-8">
                    <Button variant="secondary" iconLeft onClick={() => goToStep(0)}>
                      Back
                    </Button>
                    <Button
                      onClick={() => {
                        if (!scrolledToBottom) {
                          showToast("Please scroll to read the complete agreement");
                          return;
                        }
                        if (!agreed) {
                          showToast("Please agree to the terms and conditions");
                          return;
                        }
                        goToStep(2);
                      }}
                      disabled={!scrolledToBottom || !agreed}
                      iconRight
                    >
                      I Accept &amp; Continue
                    </Button>
                  </div>
                </div>
              )}

              {/* ===== STEP 2: SIGNATURE ===== */}
              {step === 2 && (
                <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease-out]">
                  <h2 className="mb-1 text-[22px] font-bold text-[#101828]">
                    Digital Signature
                  </h2>
                  <p className="mb-7 text-sm text-[#667085]">
                    Please provide your signature to complete the agreement
                  </p>

                  <div className="mb-5 flex gap-1 rounded-lg bg-[#F2F4F7] p-1">
                    <button
                      onClick={() => setMode("draw")}
                      className={`flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] transition ${
                        mode === "draw"
                          ? "bg-white font-semibold text-[#101828] shadow-sm"
                          : "font-medium text-[#667085]"
                      }`}
                    >
                      <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 stroke-current">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                      Draw Signature
                    </button>
                    <button
                      onClick={() => setMode("type")}
                      className={`flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] transition ${
                        mode === "type"
                          ? "bg-white font-semibold text-[#101828] shadow-sm"
                          : "font-medium text-[#667085]"
                      }`}
                    >
                      <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 stroke-current">
                        <polyline points="4 7 4 4 20 4 20 7" />
                        <line x1="9" y1="20" x2="15" y2="20" />
                        <line x1="12" y1="4" x2="12" y2="20" />
                      </svg>
                      Type Signature
                    </button>
                  </div>

                  {mode === "draw" ? (
                    <>
                      <div className="relative mb-2">
                        <canvas
                          ref={canvasRef}
                          width={1100}
                          height={400}
                          onMouseDown={startDraw}
                          onMouseMove={continueDraw}
                          onMouseUp={endDraw}
                          onMouseLeave={endDraw}
                          onTouchStart={startDraw}
                          onTouchMove={continueDraw}
                          onTouchEnd={endDraw}
                          style={{ height: 200, touchAction: "none" }}
                          className={`block w-full cursor-crosshair rounded-[10px] border-2 bg-white transition-colors ${
                            hasDrawn
                              ? "border-solid border-[#12B76A]"
                              : "border-dashed border-[#D0D5DD] hover:border-[#1570EF]"
                          }`}
                        />
                        {!hasDrawn && (
                          <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
                            <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-1.5 h-8 w-8 stroke-[#D0D5DD]">
                              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                            </svg>
                            <span className="block text-[13px] text-[#98A2B3]">
                              Draw your signature here
                            </span>
                          </div>
                        )}
                      </div>
                      <button
                        onClick={clearCanvas}
                        className="mb-4 inline-flex cursor-pointer items-center gap-1 self-start border-none bg-transparent px-0 py-1 text-[13px] font-medium text-[#F04438] hover:underline"
                      >
                        <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.5" strokeLinecap="round" className="h-3.5 w-3.5 stroke-current">
                          <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 0 1 1.334-1.334h2.666a1.333 1.333 0 0 1 1.334 1.334V4m2 0v9.333a1.333 1.333 0 0 1-1.334 1.334H4.667a1.333 1.333 0 0 1-1.334-1.334V4" />
                        </svg>
                        Clear
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        value={typedSig}
                        onChange={(e) => setTypedSig(e.target.value)}
                        maxLength={50}
                        placeholder="Type your full name"
                        className="mb-4 h-11 w-full rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-sm text-[#101828] outline-none focus:border-[#1570EF] focus:shadow-[0_0_0_3px_rgba(21,112,239,0.12)]"
                      />
                      <div className="mb-4 flex h-[140px] items-center justify-center overflow-hidden rounded-[10px] border border-[#E4E7EC] bg-[#FAFBFC]">
                        {typedSig.trim() ? (
                          <span className="font-[family-name:var(--font-dancing-script)] text-4xl font-semibold text-[#1570EF]">
                            {typedSig}
                          </span>
                        ) : (
                          <span className="text-[13px] text-[#98A2B3]">
                            Your signature preview will appear here
                          </span>
                        )}
                      </div>
                    </>
                  )}

                  <div className="flex gap-6 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] px-4 py-3.5">
                    <div>
                      <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wider text-[#98A2B3]">
                        Signer
                      </div>
                      <span className="text-sm font-semibold text-[#101828]">
                        {partnerName}
                      </span>
                    </div>
                    <div>
                      <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wider text-[#98A2B3]">
                        Date
                      </div>
                      <span className="text-sm font-semibold text-[#101828]">
                        {TODAY_LABEL}
                      </span>
                    </div>
                  </div>

                  <div className="mt-auto flex items-center justify-between gap-2 pt-8">
                    <Button variant="secondary" iconLeft onClick={() => goToStep(1)}>
                      Back
                    </Button>
                    <Button
                      onClick={handleSign}
                      loading={signMou.isPending}
                      iconRight
                    >
                      Sign &amp; Complete
                    </Button>
                  </div>
                </div>
              )}

              {/* ===== STEP 3: CONFIRMATION ===== */}
              {step === 3 && (
                <div className="flex flex-1 flex-col items-center justify-center text-center animate-[fadeSlide_0.3s_ease-out]">
                  <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[#ECFDF3] animate-[scaleIn_0.5s_cubic-bezier(0.175,0.885,0.32,1.275)]">
                    <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10 stroke-[#12B76A] stroke-[2.5]">
                      <path
                        d="M5 13l4 4L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>

                  <h2 className="mb-2 text-[22px] font-bold text-[#101828]">
                    MOU Successfully Signed!
                  </h2>
                  <p className="mb-7 max-w-[380px] text-sm text-[#667085]">
                    Your Memorandum of Understanding has been digitally signed and recorded.
                  </p>

                  <div className="mb-6 w-full max-w-[400px] rounded-xl border border-[#E4E7EC] p-5 text-left">
                    <SummaryRow label="Partner Name" value={partnerName} />
                    <SummaryRow label="Date Signed" value={TODAY_LABEL} />
                    <div className="pt-3">
                      <span className="mb-2.5 block text-[13px] font-medium text-[#667085]">
                        Digital Signature
                      </span>
                      <div className="flex h-20 items-center justify-center overflow-hidden rounded-lg border border-[#E4E7EC] bg-[#FAFBFC]">
                        {signatureDataUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={signatureDataUrl}
                            alt="Signature"
                            className="max-h-[70px] max-w-full"
                          />
                        ) : (
                          <span className="font-[family-name:var(--font-dancing-script)] text-3xl font-semibold text-[#1570EF]">
                            {signedTypedName}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleEnterPortal}
                    className="flex h-11 w-full max-w-[400px] cursor-pointer items-center justify-center gap-2 rounded-lg bg-[#12B76A] px-6 text-sm font-semibold text-white transition-colors hover:bg-[#0E9F5A]"
                  >
                    Enter Portal
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M3 8h10m0 0L9 4m4 4L9 12"
                        stroke="#fff"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function FeatureCard({
  bg,
  stroke,
  iconPath,
  title,
  body,
}: {
  bg: string;
  stroke: string;
  iconPath: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[10px] border border-[#E4E7EC] p-4 transition-colors hover:border-[#1570EF] hover:bg-[rgba(21,112,239,0.02)]">
      <div
        className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg"
        style={{ background: bg }}
      >
        <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" style={{ stroke }}>
          {iconPath}
        </svg>
      </div>
      <h4 className="mb-1 text-[13px] font-semibold text-[#101828]">{title}</h4>
      <p className="text-xs leading-snug text-[#667085]">{body}</p>
    </div>
  );
}

function MouSection({
  number,
  title,
  body,
  last,
}: {
  number: number;
  title: string;
  body: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={last ? "" : "mb-5"}>
      <h3 className="mb-2 text-sm font-bold text-[#101828]">
        {number}. {title}
      </h3>
      <div className="text-[13px] leading-relaxed text-[#344054]">{body}</div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-[#F2F4F7] py-2.5 last:border-b-0">
      <span className="text-[13px] font-medium text-[#667085]">{label}</span>
      <span className="text-sm font-semibold text-[#101828]">{value}</span>
    </div>
  );
}
