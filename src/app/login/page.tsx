"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthLayout } from "~/components/ui/auth-layout";
import { FormInput } from "~/components/ui/form-input";
import { PhoneInput } from "~/components/ui/phone-input";
import { OtpInput } from "~/components/ui/otp-input";
import { isValidEmail, isValidPhone, getExpectedPhoneDigits } from "~/lib/utils/validation";
import { maskEmail } from "~/lib/utils/masking";
import { api } from "~/trpc/react";
import {
  DevAutopilotBadge,
  DevQuickLogin,
  DEV_PARTNER_ACCOUNTS,
  useOtpAutopilot,
  type DevAccount,
} from "~/components/dev/dev-login";

type Screen = "email" | "otp" | "recovery" | "success";

type RecoveryDetailType = "phone" | "email" | "locked" | "other" | null;

const recoveryOptions = [
  { id: "phone" as const, title: "Changed my phone number", subtitle: "I can't receive OTP on my registered phone" },
  { id: "email" as const, title: "Changed my email", subtitle: "I no longer have access to my registered email" },
  { id: "locked" as const, title: "Account locked or deactivated", subtitle: "Too many attempts or account suspended" },
  { id: "other" as const, title: "Other issue", subtitle: "I need help with something else" },
];

const recoveryDetails: Record<string, React.ReactNode> = {
  phone: (
    <div className="rounded-[10px] bg-[#EFF8FF] p-4 text-[13px] leading-relaxed text-[#344054]">
      <h4 className="mb-2 text-sm font-bold text-[#175CD3]">Changed Phone Number</h4>
      <p className="mb-2">To update your registered phone number:</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Email <strong>support@collegepond.com</strong> from your registered email</li>
        <li>Include your full name and reason for the change</li>
        <li>Attach a government-issued ID for verification</li>
        <li>Our team will update your phone number within 24 hours</li>
      </ol>
    </div>
  ),
  email: (
    <div className="rounded-[10px] bg-[#FFFAEB] p-4 text-[13px] leading-relaxed text-[#344054]">
      <h4 className="mb-2 text-sm font-bold text-[#B54708]">Changed Email</h4>
      <p className="mb-2">To update your registered email:</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Contact support at <strong>support@collegepond.com</strong></li>
        <li>You may need to verify your identity via your registered phone</li>
        <li>Updates are processed within 24-48 hours</li>
      </ol>
    </div>
  ),
  locked: (
    <div className="rounded-[10px] bg-[#FEF3F2] p-4 text-[13px] leading-relaxed text-[#344054]">
      <h4 className="mb-2 text-sm font-bold text-[#B42318]">Account Locked or Deactivated</h4>
      <ul className="list-disc space-y-1 pl-5">
        <li><strong>Too many failed attempts</strong> — Wait 30 minutes and try again</li>
        <li><strong>Account deactivated</strong> — Contact Collegepond support for reactivation</li>
      </ul>
      <p className="mt-2">For immediate help, email <strong>support@collegepond.com</strong>.</p>
    </div>
  ),
  other: (
    <div className="rounded-[10px] bg-[#F2F4F7] p-4 text-[13px] leading-relaxed text-[#344054]">
      <h4 className="mb-2 text-sm font-bold text-[#344054]">Need Help?</h4>
      <p className="mb-2">For any other login issues, contact:</p>
      <div className="leading-loose">
        <strong>Email:</strong> support@collegepond.com<br />
        <strong>Hours:</strong> Mon-Fri, 9:00 AM - 6:00 PM IST
      </div>
    </div>
  ),
};

export default function LoginPage() {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("email");

  // Form state
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [countryCode, setCountryCode] = useState("+91");
  const [otp, setOtp] = useState<string[]>(["", "", "", "", ""]);
  const [userName, setUserName] = useState("User");

  // Error state
  const [emailError, setEmailError] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [otpError, setOtpError] = useState("");

  // Recovery state
  const [recoveryDetail, setRecoveryDetail] = useState<RecoveryDetailType>(null);

  // Timer state
  const [resendSeconds, setResendSeconds] = useState(30);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // tRPC mutations
  const sendOtp = api.auth.sendLoginOtp.useMutation();
  const verifyOtp = api.auth.verifyLoginOtp.useMutation();

  // Dev autopilot: sandbox code returned by sendLoginOtp (null in prod).
  const [devOtp, setDevOtp] = useState<string | null>(null);

  const startResendTimer = useCallback(() => {
    setResendSeconds(30);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setResendSeconds((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleSendOtp = () => {
    setEmailError("");
    setPhoneError("");

    let hasError = false;

    if (!email) {
      setEmailError("Email address is required");
      hasError = true;
    } else if (!isValidEmail(email)) {
      setEmailError("Please enter a valid email address");
      hasError = true;
    }

    const phoneDigits = phone.replace(/\s/g, "").replace(/[^0-9]/g, "");
    const expectedDigits = getExpectedPhoneDigits(countryCode);
    if (!phoneDigits) {
      setPhoneError("Mobile number is required");
      hasError = true;
    } else if (!isValidPhone(phone, countryCode)) {
      setPhoneError(`Mobile number must be ${expectedDigits} digits for ${countryCode}`);
      hasError = true;
    }

    if (hasError) return;

    sendOtp.mutate(
      { email, phone: phone.replace(/\s/g, ""), countryCode },
      {
        onSuccess: (data) => {
          setOtp(["", "", "", "", ""]);
          setOtpError("");
          setDevOtp(data.devOtp ?? null);
          setScreen("otp");
          startResendTimer();
        },
        onError: (err) => {
          // Surface "No account found" (and any send failure) on the email step
          // instead of silently advancing to a dead OTP screen.
          setEmailError(err.message);
        },
      },
    );
  };

  const submitOtp = (otpValue: string, creds = { email, phone }) => {
    if (otpValue.length !== 5) return;

    verifyOtp.mutate(
      { email: creds.email, phone: creds.phone.replace(/\s/g, ""), otp: otpValue },
      {
        onSuccess: (data) => {
          setUserName(data.name);
          setScreen("success");
          setTimeout(() => {
            router.push(data.redirectUrl);
          }, 2200);
        },
        onError: () => {
          setOtpError("Invalid code. Please try again.");
        },
      },
    );
  };

  const handleVerifyOtp = () => submitOtp(otp.join(""));

  const handleResendOtp = () => {
    setOtp(["", "", "", "", ""]);
    setOtpError("");
    startResendTimer();
    sendOtp.mutate(
      { email, phone: phone.replace(/\s/g, ""), countryCode },
      { onSuccess: (data) => setDevOtp(data.devOtp ?? null) },
    );
  };

  // Dev quick login: fill the form from a seed account and fire the real
  // Send OTP path — autopilot finishes the rest.
  const handleDevPick = (account: DevAccount) => {
    setEmail(account.email);
    setPhone(account.phone);
    setCountryCode("+91");
    setEmailError("");
    setPhoneError("");
    sendOtp.mutate(
      { email: account.email, phone: account.phone, countryCode: "+91" },
      {
        onSuccess: (data) => {
          setOtp(["", "", "", "", ""]);
          setOtpError("");
          setDevOtp(data.devOtp ?? null);
          setScreen("otp");
          startResendTimer();
        },
      },
    );
  };

  const autopilotRunning = useOtpAutopilot({
    code: devOtp,
    active: screen === "otp" && !verifyOtp.isPending,
    length: 5,
    onDigits: setOtp,
    onSubmit: (code) => {
      setDevOtp(null);
      submitOtp(code);
    },
  });

  const allOtpFilled = otp.every((d) => d.length === 1);

  // Avatars for left bottom
  const leftBottom = (
    <div className="relative z-[1]">
      <div className="mb-2.5 flex">
        {["S", "A", "R", "P"].map((letter, i) => (
          <div
            key={letter}
            className="flex h-[34px] w-[34px] items-center justify-center rounded-full border-2 border-[#1570EF] bg-white/20 text-[13px] text-white"
            style={{ marginLeft: i === 0 ? 0 : -8 }}
          >
            {letter}
          </div>
        ))}
        <div
          className="flex h-[34px] w-[34px] items-center justify-center rounded-full border-2 border-[#1570EF] bg-white/35 text-[11px] text-white"
          style={{ marginLeft: -8 }}
        >
          +2k
        </div>
      </div>
      <div className="text-xs text-white/55">
        Trusted by <strong className="text-white/85">2,000+ counselors</strong> worldwide
      </div>
    </div>
  );

  return (
    <>
      <AuthLayout
        leftHeading={
          <>
            Welcome Back —<br />
            Continue Shaping<br />
            Your Future
          </>
        }
        leftSubtext="Sign in to access expert support, tailored resources, and opportunities designed to help you succeed."
        leftBottomContent={leftBottom}
      >
        {/* Screen 1: Email + Phone */}
        {screen === "email" && (
          <div className="animate-[fadeSlide_0.3s_ease-out]">
            <div className="mb-7 flex items-start justify-between">
              <h2 className="text-[22px] font-bold leading-tight text-[#101828]">
                Login to
                <span className="block text-[#1570EF]">Collegepond</span>
              </h2>
              <div className="shrink-0 text-right">
                <small className="block text-xs text-[#667085]">No account yet?</small>
                <Link
                  href="/signup"
                  className="text-[13px] font-semibold text-[#1570EF] hover:underline"
                >
                  Sign Up here
                </Link>
              </div>
            </div>

            <div className="mb-4">
              <FormInput
                label="Email Address"
                required
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError("");
                }}
                error={!!emailError}
                errorMessage={emailError}
                onKeyDown={(e) => e.key === "Enter" && handleSendOtp()}
              />
            </div>

            <div className="mb-4">
              <PhoneInput
                label="Mobile Number"
                required
                countryCode={countryCode}
                phone={phone}
                onCountryCodeChange={(code) => {
                  setCountryCode(code);
                  setPhoneError("");
                }}
                onPhoneChange={(val) => {
                  setPhone(val);
                  setPhoneError("");
                }}
                error={!!phoneError}
                errorMessage={phoneError}
              />
            </div>

            <button
              onClick={handleSendOtp}
              disabled={sendOtp.isPending}
              className={`mt-1 h-[42px] w-full cursor-pointer rounded-lg border-none bg-[#1570EF] font-[family-name:var(--font-inter)] text-sm font-semibold text-white transition-all hover:bg-[#1260d4] disabled:cursor-not-allowed disabled:opacity-50 ${
                sendOtp.isPending ? "pointer-events-none text-transparent" : ""
              } relative`}
            >
              Send OTP
              {sendOtp.isPending && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-white/30 border-t-white" />
                </span>
              )}
            </button>
            <div className="mt-3 text-center">
              <button
                onClick={() => {
                  setRecoveryDetail(null);
                  setScreen("recovery");
                }}
                className="cursor-pointer border-none bg-transparent text-xs font-medium text-[#1570EF] hover:underline"
              >
                Can&apos;t access your account?
              </button>
            </div>

            <DevQuickLogin
              accounts={DEV_PARTNER_ACCOUNTS}
              onPick={handleDevPick}
              busy={sendOtp.isPending}
            />
          </div>
        )}

        {/* Screen: Account Recovery */}
        {screen === "recovery" && (
          <div className="animate-[fadeSlide_0.3s_ease-out]">
            <button
              onClick={() => setScreen("email")}
              className="mb-5 inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent font-[family-name:var(--font-inter)] text-[13px] font-medium text-[#667085] hover:text-[#1570EF]"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-[15px] w-[15px]"
              >
                <path d="M10 12L6 8l4-4" />
              </svg>
              Back to Login
            </button>

            <div className="mb-7 flex items-start justify-between">
              <h2 className="text-[22px] font-bold leading-tight text-[#101828]">
                Account
                <span className="block text-[#1570EF]">Recovery</span>
              </h2>
            </div>

            {!recoveryDetail ? (
              <>
                <p className="mb-4 text-[13px] text-[#667085]">Select your issue:</p>
                <div className="flex flex-col gap-2">
                  {recoveryOptions.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => setRecoveryDetail(opt.id)}
                      className="cursor-pointer rounded-lg border border-[#E4E7EC] bg-white px-3.5 py-3 text-left transition-all hover:border-[#1570EF] hover:bg-[#F0F7FF]"
                    >
                      <strong className="block text-[13px] text-[#101828]">{opt.title}</strong>
                      <small className="text-[11px] text-[#667085]">{opt.subtitle}</small>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                {recoveryDetails[recoveryDetail]}
                <button
                  onClick={() => setRecoveryDetail(null)}
                  className="mt-4 cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-4 py-2 text-[13px] font-semibold text-[#344054] transition-colors hover:bg-[#F9FAFB]"
                >
                  Back
                </button>
              </>
            )}
          </div>
        )}

        {/* Screen 2: OTP Verification */}
        {screen === "otp" && (
          <div className="animate-[fadeSlide_0.3s_ease-out]">
            <button
              onClick={() => setScreen("email")}
              className="mb-5 inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent font-[family-name:var(--font-inter)] text-[13px] font-medium text-[#667085] hover:text-[#1570EF]"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-[15px] w-[15px]"
              >
                <path d="M10 12L6 8l4-4" />
              </svg>
              Back
            </button>

            <div className="mb-1.5 text-[22px] font-bold text-[#101828]">
              Verify Your Identity
            </div>
            <div className="mb-5 text-sm leading-relaxed text-[#667085]">
              Code sent to{" "}
              <span className="font-semibold text-[#344054]">
                {maskEmail(email)}
              </span>
              <div className="mt-1 text-xs text-[#98A2B3]">
                Please check your junk/spam folder if you don&apos;t see it in your inbox.
              </div>
            </div>

            <DevAutopilotBadge visible={autopilotRunning} />
            <label className="mb-1.5 block text-[13px] font-medium text-[#344054]">
              Enter 5-digit OTP *
            </label>
            <OtpInput
              value={otp}
              onChange={(val) => {
                setOtp(val);
                setOtpError("");
              }}
              error={!!otpError}
            />
            {otpError && (
              <div className="mt-2 flex items-center gap-1 text-xs text-[#F04438]">
                <svg
                  viewBox="0 0 16 16"
                  fill="#F04438"
                  className="h-[13px] w-[13px] shrink-0"
                >
                  <circle cx="8" cy="8" r="7" />
                  <path
                    d="M8 4v4M8 10.5v.5"
                    stroke="#fff"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                {otpError}
              </div>
            )}

            <div className="mt-1.5 mb-5 text-[13px] text-[#667085]">
              {"Didn't receive the code? "}
              {resendSeconds > 0 ? (
                <span className="tabular-nums text-[#98A2B3]">
                  Resend OTP in 0:{String(resendSeconds).padStart(2, "0")}
                </span>
              ) : (
                <button
                  onClick={handleResendOtp}
                  className="cursor-pointer border-none bg-transparent font-[family-name:var(--font-inter)] text-[13px] font-semibold text-[#1570EF] hover:underline"
                >
                  Resend OTP
                </button>
              )}
            </div>

            <button
              onClick={handleVerifyOtp}
              disabled={!allOtpFilled || verifyOtp.isPending}
              className={`h-[42px] w-full cursor-pointer rounded-lg border-none bg-[#1570EF] font-[family-name:var(--font-inter)] text-sm font-semibold text-white transition-all hover:bg-[#1260d4] disabled:cursor-not-allowed disabled:opacity-50 ${
                verifyOtp.isPending ? "pointer-events-none text-transparent" : ""
              } relative`}
            >
              Verify &amp; Login
              {verifyOtp.isPending && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-white/30 border-t-white" />
                </span>
              )}
            </button>
          </div>
        )}
      </AuthLayout>

      {/* Screen 3: Success Overlay */}
      {screen === "success" && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-[#0f1117]">
          <div className="w-[460px] rounded-2xl bg-white p-16 px-11 text-center shadow-[0_24px_80px_rgba(0,0,0,0.4)]">
            <div className="mx-auto mb-5 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[#ECFDF3] animate-[scaleIn_0.4s_ease-out]">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#12B76A"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-9 w-9"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <h2 className="mb-1.5 text-[22px] font-bold text-[#101828]">
              Welcome back, {userName}!
            </h2>
            <p className="mb-5 text-sm text-[#667085]">
              Redirecting to your dashboard...
            </p>
            <div className="mx-auto h-1 w-[180px] overflow-hidden rounded bg-[#E4E7EC]">
              <div className="h-full rounded bg-[#1570EF] animate-[progressFill_2s_ease-in-out_forwards]" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
