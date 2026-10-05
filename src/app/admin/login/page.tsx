"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { AdminBrandPanel } from "~/components/ui/admin-brand-panel";
import { StepDots } from "~/components/ui/step-dots";
import { FormInput } from "~/components/ui/form-input";
import { PhoneInput } from "~/components/ui/phone-input";
import { OtpInput } from "~/components/ui/otp-input";
import { Button } from "~/components/ui/button";
import { isValidEmail, isValidPhone, getExpectedPhoneDigits } from "~/lib/utils/validation";
import { maskEmail, maskPhone } from "~/lib/utils/masking";
import { api } from "~/trpc/react";
import {
  DevAutopilotBadge,
  DevQuickLogin,
  DEV_ADMIN_ACCOUNTS,
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

function SecureAdminBadge() {
  return (
    <div className="mb-7 inline-flex items-center gap-1.5 rounded-full border border-[#A6F4C5] bg-[#ECFDF3] px-3.5 py-1.5 text-xs font-semibold text-[#027A48]">
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 fill-none stroke-[#027A48] stroke-2"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
      Secure Admin Access
    </div>
  );
}

export default function AdminLoginPage() {
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

  // Dev autopilot: sandbox code returned by sendLoginOtp (null in prod).
  const [devOtp, setDevOtp] = useState<string | null>(null);
  // Where the server sent the code (SMS unless ADMIN_LOGIN_OTP_CHANNEL=email).
  const [otpChannel, setOtpChannel] = useState<"sms" | "email">("sms");

  // tRPC mutations
  const sendOtp = api.adminAuth.sendLoginOtp.useMutation();
  const verifyOtp = api.adminAuth.verifyLoginOtp.useMutation();

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
          setOtpChannel(data.channel);
          setScreen("otp");
          startResendTimer();
        },
        onError: (e) => setPhoneError(e.message === "Failed to send OTP" ? "Couldn't send the code. Please try again in a minute." : e.message),
      },
    );
  };

  const submitOtp = (otpValue: string, creds = { email, phone, countryCode }) => {
    if (otpValue.length !== 5) return;

    verifyOtp.mutate(
      {
        email: creds.email,
        phone: creds.phone.replace(/\s/g, ""),
        countryCode: creds.countryCode,
        otp: otpValue,
      },
      {
        onSuccess: (data) => {
          setUserName(data.name);
          setScreen("success");
          // Admin/staff (collegepond_user) have no pending-approval state — an
          // active login always lands on the dashboard. (The partner "pending"
          // review flow lives on /login → /pending-verification, not here.)
          setTimeout(() => {
            router.push("/admin/dashboard");
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
      {
        onSuccess: (data) => {
          setDevOtp(data.devOtp ?? null);
          setOtpChannel(data.channel);
        },
        onError: (e) => setOtpError(e.message === "Failed to send OTP" ? "Couldn't resend the code. Please try again in a minute." : e.message),
      },
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
          setOtpChannel(data.channel);
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

  return (
    <>
      <div className="flex min-h-screen bg-[#F5F6FA]">
        {/* Left Brand Panel */}
        <AdminBrandPanel />

        {/* Right Login Panel */}
        <div className="relative flex flex-1 items-center justify-center px-10 py-24">
          <div className="w-full max-w-[440px]">
            {(screen === "email" || screen === "otp") && (
              <StepDots total={2} current={screen === "email" ? 0 : 1} />
            )}

            {/* Screen 1: Email + Phone */}
            {screen === "email" && (
              <div className="animate-[fadeSlide_0.3s_ease-out]">
                <SecureAdminBadge />

                <h1 className="mb-1.5 text-[26px] font-bold tracking-tight text-[#101828]">
                  Sign in to Admin Portal
                </h1>
                <p className="mb-8 text-sm leading-relaxed text-[#667085]">
                  Enter your credentials to continue.
                </p>

                <div className="mb-5">
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

                <div className="mb-5">
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

                <Button
                  onClick={handleSendOtp}
                  loading={sendOtp.isPending}
                  iconRight
                  className="w-full"
                >
                  Send OTP
                </Button>

                <div className="mt-5 flex items-center justify-center gap-1.5 text-xs text-[#98A2B3]">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5 shrink-0 fill-none stroke-[#98A2B3] stroke-2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                  Sessions expire after 8 hours of inactivity
                </div>

                <DevQuickLogin
                  accounts={DEV_ADMIN_ACCOUNTS}
                  onPick={handleDevPick}
                  busy={sendOtp.isPending}
                />
              </div>
            )}

            {/* Screen 2: OTP Verification */}
            {screen === "otp" && (
              <div className="animate-[fadeSlide_0.3s_ease-out]">
                <SecureAdminBadge />

                <h1 className="mb-1.5 text-[26px] font-bold tracking-tight text-[#101828]">
                  Verify your identity
                </h1>
                <div className="mb-6 text-sm leading-relaxed text-[#667085]">
                  Code sent to your {otpChannel === "email" ? "email" : "phone"}
                  <br />
                  <strong className="text-[#344054]">
                    {otpChannel === "email" ? maskEmail(email) : maskPhone(phone, countryCode)}
                  </strong>
                </div>

                <DevAutopilotBadge visible={autopilotRunning} />
                <div className="mb-2 flex justify-center">
                  <OtpInput
                    length={5}
                    value={otp}
                    onChange={(val) => {
                      setOtp(val);
                      setOtpError("");
                    }}
                    error={!!otpError}
                  />
                </div>
                {otpError && (
                  <div className="mb-2 flex items-center justify-center gap-1 text-xs text-[#F04438]">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5 fill-none stroke-[#F04438] stroke-2"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v4M12 16h.01" />
                    </svg>
                    {otpError}
                  </div>
                )}

                <Button
                  onClick={handleVerifyOtp}
                  disabled={!allOtpFilled}
                  loading={verifyOtp.isPending}
                  className="mt-4 w-full"
                >
                  Verify &amp; Login
                </Button>

                <div className="mt-4 text-center text-[13px] text-[#667085]">
                  {"Didn't receive the code? "}
                  {resendSeconds > 0 ? (
                    <span className="tabular-nums text-[#98A2B3]">
                      ({String(resendSeconds).padStart(2, "0")}s)
                    </span>
                  ) : (
                    <button
                      onClick={handleResendOtp}
                      className="cursor-pointer border-none bg-transparent font-semibold text-[#1570EF] hover:underline"
                    >
                      Resend OTP
                    </button>
                  )}
                </div>

                <div className="mt-4 text-center">
                  <button
                    onClick={() => setScreen("email")}
                    className="cursor-pointer border-none bg-transparent text-[13px] font-medium text-[#667085] hover:text-[#1570EF]"
                  >
                    &larr; Back to login
                  </button>
                </div>
              </div>
            )}

            {/* Screen: Account Recovery */}
            {screen === "recovery" && (
              <div className="animate-[fadeSlide_0.3s_ease-out]">
                <button
                  onClick={() => {
                    setRecoveryDetail(null);
                    setScreen("email");
                  }}
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
                  Back to login
                </button>

                <h1 className="mb-1.5 text-[26px] font-bold tracking-tight text-[#101828]">
                  Account Recovery
                </h1>

                {!recoveryDetail ? (
                  <>
                    <p className="mb-5 text-sm text-[#667085]">Select your issue:</p>
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
          </div>

          {/* Footer */}
          {screen !== "recovery" && (
            <div className="absolute bottom-6 left-0 right-0 text-center">
              <div className="mb-2">
                <button
                  onClick={() => {
                    setRecoveryDetail(null);
                    setScreen("recovery");
                  }}
                  className="cursor-pointer border-none bg-transparent text-[13px] font-medium text-[#1570EF] hover:underline"
                >
                  Can&apos;t access your account?
                </button>
              </div>
              <div className="text-xs text-[#98A2B3]">
                Collegepond Admin Portal v1.0 | Need help? Contact IT Support
              </div>
            </div>
          )}
        </div>
      </div>

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
