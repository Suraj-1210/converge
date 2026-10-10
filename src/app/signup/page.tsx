"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { AuthLayout } from "~/components/ui/auth-layout";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { FormCombobox } from "~/components/ui/form-combobox";
import { PhoneInput } from "~/components/ui/phone-input";
import { OtpInput } from "~/components/ui/otp-input";
import { Button } from "~/components/ui/button";
import { FileUpload } from "~/components/ui/file-upload";
import { StepIndicator } from "~/components/ui/step-indicator";
import { ConsentCheckbox } from "~/components/ui/consent-checkbox";
import { ReviewCard, DocBadge } from "~/components/ui/review-card";
import { SuccessScreen } from "~/components/ui/success-screen";
import {
  isValidEmail,
  isValidPhone,
  getExpectedPhoneDigits,
} from "~/lib/utils/validation";
import { maskEmail, maskPhone } from "~/lib/utils/masking";
import { counselorRanges, volumeRanges } from "~/lib/constants/location-data";
import { isPanRequired, normalizePan, panError } from "~/lib/utils/pan";
import { api } from "~/trpc/react";

type Role = "agency" | "independent";

const agencySteps = ["basic", "otp", "company", "documents", "review"] as const;
const independentSteps = ["basic", "otp", "documents", "review"] as const;

// Always-required agency uploads. "gst" is required on top of these only when
// the agency answers "GST Registered? → Yes" in Company Details.
const AGENCY_REQUIRED_DOCS = [
  "companyPan",
  "aadhaar",
  "cancelledCheque",
  "partnershipDocs",
] as const;

const agencyDisplaySteps = [
  "Basic Information",
  "Company Details",
  "Business Documents",
  "Review & Submit",
];
const independentDisplaySteps = [
  "Basic Information",
  "Additional Information",
  "Review & Submit",
];

const leftPanelContent: Record<string, { heading: React.ReactNode; subtext: string }> = {
  basic: {
    heading: (
      <>
        Empower Your Dreams!
        <br />
        Shape Your Future!
      </>
    ),
    subtext:
      "Join Collegepond and take the first step towards building a successful counseling practice.",
  },
  otp: {
    heading: (
      <>
        Almost there!
        <br />
        Verify your email &amp; phone.
      </>
    ),
    subtext:
      "We need to confirm your email address and phone number to secure your account.",
  },
  company: {
    heading: (
      <>
        Tell us about
        <br />
        your business
      </>
    ),
    subtext:
      "This helps us tailor the portal experience for your agency and team.",
  },
  "documents-agency": {
    heading: (
      <>
        Upload your
        <br />
        documents
      </>
    ),
    subtext:
      "These documents help us verify your business and expedite the approval process.",
  },
  "documents-independent": {
    heading: (
      <>
        Upload your
        <br />
        documents
      </>
    ),
    subtext:
      "These documents help us verify your identity and expedite the approval process.",
  },
  review: {
    heading: (
      <>
        Review and
        <br />
        submit
      </>
    ),
    subtext:
      "Please review your details before submitting your application for approval.",
  },
};

// Interfaces
interface FormErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  companyWebsite?: string;
  country?: string;
  state?: string;
  city?: string;
  companyAddress?: string;
  numCounselors?: string;
  annualVolume?: string;
  gstRegistered?: string;
  pan?: string;
  consent?: string;
  documents?: string;
}

interface FileState {
  file?: File;
  name?: string;
  path?: string;
  uploading?: boolean;
}

async function uploadFile(file: File, folder: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("folder", folder);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Upload failed" }))) as {
      error?: string;
    };
    throw new Error(body.error ?? "Upload failed");
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

export default function SignupPage() {
  const [role, setRole] = useState<Role>("agency");
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);

  // Form data
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [countryCode, setCountryCode] = useState("+91");
  // Company PAN for an agency, personal PAN for an independent.
  const [pan, setPan] = useState("");

  // Company data
  const [companyName, setCompanyName] = useState("");
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [country, setCountry] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  // The applicant chose "My city isn't listed" and is typing it instead.
  const [cityManual, setCityManual] = useState(false);
  const [companyAddress, setCompanyAddress] = useState("");
  const [numCounselors, setNumCounselors] = useState("");
  const [annualVolume, setAnnualVolume] = useState("");
  // "" until answered. "yes" makes the GST certificate a required document.
  const [gstRegistered, setGstRegistered] = useState<"" | "yes" | "no">("");

  // OTP state
  const [emailOtp, setEmailOtp] = useState<string[]>(["", "", "", "", ""]);
  const [phoneOtp, setPhoneOtp] = useState<string[]>(["", "", "", "", ""]);
  const [emailVerified, setEmailVerified] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [emailTimerSeconds, setEmailTimerSeconds] = useState(30);
  const [phoneTimerSeconds, setPhoneTimerSeconds] = useState(30);
  const emailTimerRef = useRef<NodeJS.Timeout | null>(null);
  const phoneTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Document uploads (agency)
  const [agencyDocs, setAgencyDocs] = useState<Record<string, FileState>>({
    companyPan: {},
    aadhaar: {},
    cancelledCheque: {},
    partnershipDocs: {},
    logo: {},
    gst: {},
  });

  // Document uploads (independent)
  const [independentDocs, setIndependentDocs] = useState<Record<string, FileState>>({
    pan: {},
    aadhaar: {},
    cancelledCheque: {},
    profilePhoto: {},
  });

  // Consent
  const [consent, setConsent] = useState(false);

  // Errors
  const [errors, setErrors] = useState<FormErrors>({});
  const [shakeOtp, setShakeOtp] = useState(false);

  // Success data
  const [applicationId, setApplicationId] = useState("");

  // tRPC mutations
  const sendSignupOtp = api.signup.sendSignupOtp.useMutation();
  const verifyEmailOtpMut = api.signup.verifyEmailOtp.useMutation();
  const verifyPhoneOtpMut = api.signup.verifyPhoneOtp.useMutation();
  const submitApp = api.signup.submitApplication.useMutation();

  const rightContentRef = useRef<HTMLDivElement>(null);

  // Location master list (geo_* tables). Reference data — fetch once.
  const geoOpts = { staleTime: Infinity, refetchOnWindowFocus: false } as const;
  const countriesQuery = api.geo.countries.useQuery(undefined, geoOpts);
  const statesQuery = api.geo.states.useQuery(
    { country },
    { ...geoOpts, enabled: country.length === 2 },
  );
  const stateNames = statesQuery.data ?? [];
  const hasStates = stateNames.length > 0;
  const citiesQuery = api.geo.cities.useQuery(
    { country, state: state || undefined },
    {
      ...geoOpts,
      // A country without states lists its cities directly.
      enabled: statesQuery.isSuccess && (hasStates ? !!state : true),
    },
  );
  // India first — most partners are India-based — then alphabetical.
  const countryOptions = (countriesQuery.data ?? [])
    .map((c) => ({ value: c.iso2, label: c.name }))
    .sort((a, b) => Number(b.value === "IN") - Number(a.value === "IN"));
  const countryName =
    countryOptions.find((c) => c.value === country)?.label ?? country;
  const panRequired = isPanRequired(role, { country, countryCode });

  // Computed values
  const steps = role === "agency" ? agencySteps : independentSteps;
  const displaySteps = role === "agency" ? agencyDisplaySteps : independentDisplaySteps;
  const currentStepName = steps[currentStepIndex] ?? "basic";

  // Display index (skip OTP in indicator)
  const getDisplayIndex = useCallback(
    (stepName: string) => {
      let dIdx = -1;
      for (const step of steps) {
        if (step !== "otp") dIdx++;
        if (step === stepName) return dIdx;
      }
      return dIdx;
    },
    [steps],
  );

  const displayIndex = getDisplayIndex(currentStepName);
  const progressPercent =
    displaySteps.length > 1
      ? (displayIndex / (displaySteps.length - 1)) * 100
      : 0;

  // Left panel content
  const getLeftContentKey = () => {
    if (currentStepName === "documents") return `documents-${role}`;
    return currentStepName;
  };
  const leftContent = leftPanelContent[getLeftContentKey()] ?? leftPanelContent.basic!;

  // OTP Timer logic
  const startEmailTimer = useCallback(() => {
    setEmailTimerSeconds(30);
    if (emailTimerRef.current) clearInterval(emailTimerRef.current);
    emailTimerRef.current = setInterval(() => {
      setEmailTimerSeconds((prev) => {
        if (prev <= 1) {
          if (emailTimerRef.current) clearInterval(emailTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const startPhoneTimer = useCallback(() => {
    setPhoneTimerSeconds(30);
    if (phoneTimerRef.current) clearInterval(phoneTimerRef.current);
    phoneTimerRef.current = setInterval(() => {
      setPhoneTimerSeconds((prev) => {
        if (prev <= 1) {
          if (phoneTimerRef.current) clearInterval(phoneTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (emailTimerRef.current) clearInterval(emailTimerRef.current);
      if (phoneTimerRef.current) clearInterval(phoneTimerRef.current);
    };
  }, []);

  // Auto-verify email OTP when all filled
  useEffect(() => {
    if (emailOtp.every((d) => d.length === 1) && !emailVerified) {
      verifyEmailOtpMut.mutate(
        { email, otp: emailOtp.join("") },
        {
          onSuccess: () => {
            setEmailVerified(true);
            if (emailTimerRef.current) clearInterval(emailTimerRef.current);
          },
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailOtp]);

  // Auto-verify phone OTP when all filled
  useEffect(() => {
    if (phoneOtp.every((d) => d.length === 1) && !phoneVerified) {
      verifyPhoneOtpMut.mutate(
        { phone: phone.replace(/\s/g, ""), countryCode, otp: phoneOtp.join("") },
        {
          onSuccess: () => {
            setPhoneVerified(true);
            if (phoneTimerRef.current) clearInterval(phoneTimerRef.current);
          },
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneOtp]);

  // Validation
  const validateBasicInfo = (): boolean => {
    const newErrors: FormErrors = {};
    if (!firstName.trim()) newErrors.firstName = "First name is required";
    if (!lastName.trim()) newErrors.lastName = "Last name is required";
    if (!email.trim()) {
      newErrors.email = "Email is required";
    } else if (!isValidEmail(email)) {
      newErrors.email = "Please enter a valid email address";
    }
    const phoneDigits = phone.replace(/\s/g, "").replace(/[^0-9]/g, "");
    const expectedDigits = getExpectedPhoneDigits(countryCode);
    if (!phoneDigits) {
      newErrors.phone = "Phone number is required";
    } else if (!isValidPhone(phone, countryCode)) {
      newErrors.phone = `Phone number must be ${expectedDigits} digits for ${countryCode}`;
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateOtp = (): boolean => {
    if (!emailVerified || !phoneVerified) {
      setShakeOtp(true);
      setTimeout(() => setShakeOtp(false), 500);
      return false;
    }
    return true;
  };

  const validateCompany = (): boolean => {
    const newErrors: FormErrors = {};
    if (!companyName.trim()) newErrors.companyName = "Company name is required";
    if (!companyWebsite.trim()) newErrors.companyWebsite = "Website or LinkedIn is required";
    if (!country) newErrors.country = "Country is required";
    else if (statesQuery.isLoading) newErrors.state = "Loading states…";
    else if (hasStates && !state) newErrors.state = "State is required";
    if (!city.trim()) newErrors.city = "City is required";
    if (pan.trim() || panRequired) {
      const msg = panError(pan, "agency");
      if (msg) newErrors.pan = msg;
    }
    if (!companyAddress.trim()) newErrors.companyAddress = "Address is required";
    if (!numCounselors) newErrors.numCounselors = "Number of counselors is required";
    if (!annualVolume) newErrors.annualVolume = "Student volume is required";
    if (!gstRegistered) newErrors.gstRegistered = "Please select an option";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateDocuments = (): boolean => {
    if (role === "agency") {
      const required: string[] = [...AGENCY_REQUIRED_DOCS];
      // A GST-registered agency must also supply its GST certificate.
      if (gstRegistered === "yes") required.push("gst");
      const missing = required.some((k) => !agencyDocs[k]?.name);
      if (missing) {
        setErrors({ documents: "Please upload all required documents" });
        return false;
      }
    } else {
      if (pan.trim() || panRequired) {
        const msg = panError(pan, "individual");
        if (msg) {
          setErrors({ pan: msg });
          return false;
        }
      }
      const required = ["pan", "aadhaar", "cancelledCheque"];
      const missing = required.some((k) => !independentDocs[k]?.name);
      if (missing) {
        setErrors({ documents: "Please upload all required documents" });
        return false;
      }
    }
    setErrors({});
    return true;
  };

  const validateConsent = (): boolean => {
    if (!consent) {
      setErrors({
        consent: "Please check the box above to agree to the Terms of Service and Privacy Policy before submitting.",
      });
      return false;
    }
    setErrors({});
    return true;
  };

  // Navigation
  const goToStep = (index: number) => {
    setCurrentStepIndex(index);
    setErrors({});
  };

  const nextStep = () => {
    setErrors({});
    const step = currentStepName;

    if (step === "basic") {
      if (!validateBasicInfo()) return;
      // Send OTP
      sendSignupOtp.mutate(
        { email, phone: phone.replace(/\s/g, ""), countryCode },
        {
          onSuccess: () => {
            setEmailOtp(["", "", "", "", ""]);
            setPhoneOtp(["", "", "", "", ""]);
            setEmailVerified(false);
            setPhoneVerified(false);
            setCurrentStepIndex(currentStepIndex + 1);
            startEmailTimer();
            startPhoneTimer();
          },
        },
      );
      return;
    }

    if (step === "otp" && !validateOtp()) return;
    if (step === "company" && !validateCompany()) return;
    if (step === "documents" && !validateDocuments()) return;

    if (currentStepIndex < steps.length - 1) {
      setCurrentStepIndex(currentStepIndex + 1);
    }
  };

  const prevStep = () => {
    if (currentStepIndex > 0) {
      setErrors({});
      setCurrentStepIndex(currentStepIndex - 1);
    }
  };

  const goToStepByName = (name: string) => {
    const idx = (steps as readonly string[]).indexOf(name);
    if (idx !== -1) goToStep(idx);
  };

  const handleSubmit = () => {
    if (!validateConsent()) return;

    const docs = role === "agency" ? agencyDocs : independentDocs;
    const documents: Record<string, string> = {};
    for (const [k, v] of Object.entries(docs)) {
      if (v.path) documents[k] = v.path;
    }

    submitApp.mutate(
      {
        role,
        firstName,
        lastName,
        email,
        phone: phone.replace(/\s/g, ""),
        countryCode,
        companyName: role === "agency" ? companyName : undefined,
        companyWebsite: role === "agency" ? companyWebsite : undefined,
        country: role === "agency" ? country : undefined,
        state: role === "agency" && hasStates ? state : undefined,
        city: role === "agency" ? city.trim() : undefined,
        companyAddress: role === "agency" ? companyAddress : undefined,
        numCounselors: role === "agency" ? numCounselors : undefined,
        annualVolume: role === "agency" ? annualVolume : undefined,
        gstRegistered: role === "agency" ? gstRegistered === "yes" : undefined,
        documents,
        pan: pan.trim() ? normalizePan(pan) : undefined,
      },
      {
        onSuccess: (data) => {
          setApplicationId(data.applicationId);
          setShowSuccess(true);
        },
      },
    );
  };

  const selectRole = (newRole: Role) => {
    if (newRole === role) return;
    setRole(newRole);
    setCurrentStepIndex(0);
    setErrors({});
  };

  // File upload helpers
  const setAgencyDoc = async (key: string, file: File) => {
    setAgencyDocs((prev) => ({ ...prev, [key]: { file, uploading: true } }));
    try {
      const path = await uploadFile(file, `signup/agency/${key}`);
      setAgencyDocs((prev) => ({
        ...prev,
        [key]: { file, name: file.name, path, uploading: false },
      }));
    } catch (err) {
      setAgencyDocs((prev) => ({ ...prev, [key]: {} }));
      alert(err instanceof Error ? err.message : "Upload failed");
    }
  };
  const removeAgencyDoc = (key: string) => {
    setAgencyDocs((prev) => ({ ...prev, [key]: {} }));
  };
  const setIndependentDoc = async (key: string, file: File) => {
    setIndependentDocs((prev) => ({ ...prev, [key]: { file, uploading: true } }));
    try {
      const path = await uploadFile(file, `signup/independent/${key}`);
      setIndependentDocs((prev) => ({
        ...prev,
        [key]: { file, name: file.name, path, uploading: false },
      }));
    } catch (err) {
      setIndependentDocs((prev) => ({ ...prev, [key]: {} }));
      alert(err instanceof Error ? err.message : "Upload failed");
    }
  };
  const removeIndependentDoc = (key: string) => {
    setIndependentDocs((prev) => ({ ...prev, [key]: {} }));
  };

  // Document status for review
  const getAgencyDocStatus = () => {
    const docs = [
      { key: "companyPan", name: "Company PAN", required: true },
      { key: "aadhaar", name: "Aadhaar Card", required: true },
      { key: "cancelledCheque", name: "Cancelled Cheque", required: true },
      { key: "partnershipDocs", name: "Partnership Docs", required: true },
      { key: "logo", name: "Company Logo", required: false },
      { key: "gst", name: "GST Certificate", required: gstRegistered === "yes" },
    ];
    return docs.map((d) => ({
      name: d.name,
      status: agencyDocs[d.key]?.name
        ? ("uploaded" as const)
        : d.required
          ? ("pending" as const)
          : ("skipped" as const),
    }));
  };

  const getIndependentDocStatus = () => {
    const docs = [
      { key: "pan", name: "PAN Card", required: true },
      { key: "aadhaar", name: "Aadhaar Card", required: true },
      { key: "cancelledCheque", name: "Cancelled Cheque", required: true },
      { key: "profilePhoto", name: "Profile Photo", required: false },
    ];
    return docs.map((d) => ({
      name: d.name,
      status: independentDocs[d.key]?.name
        ? ("uploaded" as const)
        : d.required
          ? ("pending" as const)
          : ("skipped" as const),
    }));
  };

  // Success screen
  if (showSuccess) {
    return (
      <SuccessScreen
        title="Application Submitted!"
        message="Thank you for registering with Collegepond. Our team will review your application and get back to you within 24-48 hours."
        details={[
          { label: "Application ID", value: applicationId },
          {
            label: "Status",
            value: (
              <span className="inline-flex items-center gap-1.5 rounded-[10px] bg-[rgba(247,144,9,0.1)] px-2.5 py-0.5 text-xs font-semibold text-[#F79009]">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <circle cx="4" cy="4" r="3" fill="#F79009" />
                </svg>
                Under Review
              </span>
            ),
          },
          { label: "Email", value: email },
          { label: "Expected Response", value: "24 - 48 hours" },
        ]}
        note="A confirmation email has been sent to your registered email address."
        actionLabel="Back to Login"
        actionHref="/login"
      />
    );
  }

  return (
    <AuthLayout
      leftHeading={leftContent.heading}
      leftSubtext={leftContent.subtext}
      leftBottomContent={
        <StepIndicator steps={displaySteps} currentStep={displayIndex} />
      }
      progressPercent={progressPercent}
    >
      <div ref={rightContentRef} className="flex flex-1 flex-col">
        {/* ═══ SCREEN: BASIC INFO ═══ */}
        {currentStepName === "basic" && (
          <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease]">
            <div className="mb-1 text-[22px] font-bold text-[#101828]">
              Create Your Account
            </div>
            <div className="mb-7 text-sm text-[#667085]">
              Fill in your details to get started with Collegepond.
            </div>

            {/* Role selection */}
            <div className="mb-3.5 text-[13px] font-semibold tracking-wide text-[#344054] uppercase">
              I am a
            </div>
            <div className="mb-6 flex gap-3.5">
              <RoleCard
                selected={role === "agency"}
                onClick={() => selectRole("agency")}
                icon={
                  <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5">
                    <rect x="2" y="4" width="16" height="13" rx="2" stroke="#344054" strokeWidth="1.5" />
                    <path d="M7 4V3a2 2 0 012-2h2a2 2 0 012 2v1" stroke="#344054" strokeWidth="1.5" />
                    <path d="M2 10h16" stroke="#344054" strokeWidth="1.5" />
                  </svg>
                }
                title="Agency Owner"
                subtitle="Register your agency"
              />
              <RoleCard
                selected={role === "independent"}
                onClick={() => selectRole("independent")}
                icon={
                  <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5">
                    <circle cx="10" cy="7" r="3.5" stroke="#344054" strokeWidth="1.5" />
                    <path d="M3 18c0-3.5 3.13-6 7-6s7 2.5 7 6" stroke="#344054" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                }
                title="Independent Counselor"
                subtitle="Register as individual"
              />
            </div>

            <div className="mb-3.5 text-[13px] font-semibold tracking-wide text-[#344054] uppercase">
              Personal Details
            </div>

            <div className="mb-4 flex gap-4">
              <FormInput
                label="First Name"
                required
                placeholder="Enter first name"
                value={firstName}
                onChange={(e) => { setFirstName(e.target.value); setErrors((p) => ({ ...p, firstName: undefined })); }}
                error={!!errors.firstName}
                errorMessage={errors.firstName}
              />
              <FormInput
                label="Last Name"
                required
                placeholder="Enter last name"
                value={lastName}
                onChange={(e) => { setLastName(e.target.value); setErrors((p) => ({ ...p, lastName: undefined })); }}
                error={!!errors.lastName}
                errorMessage={errors.lastName}
              />
            </div>

            <div className="mb-4">
              <FormInput
                label="Email Address"
                required
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: undefined })); }}
                error={!!errors.email}
                errorMessage={errors.email}
              />
            </div>

            <div className="mb-4">
              <PhoneInput
                label="Phone Number"
                required
                countryCode={countryCode}
                phone={phone}
                onCountryCodeChange={(code) => { setCountryCode(code); setErrors((p) => ({ ...p, phone: undefined })); }}
                onPhoneChange={(val) => { setPhone(val); setErrors((p) => ({ ...p, phone: undefined })); }}
                error={!!errors.phone}
                errorMessage={errors.phone}
              />
            </div>

            <div className="mt-auto flex items-center justify-between pt-6">
              <div />
              <Button onClick={nextStep} iconRight loading={sendSignupOtp.isPending}>
                Continue &amp; Verify
              </Button>
            </div>

            <div className="mt-5 text-center text-[13px] text-[#667085]">
              Already a member?{" "}
              <Link href="/login" className="font-medium text-[#1570EF] hover:underline">
                Login here
              </Link>
            </div>
          </div>
        )}

        {/* ═══ SCREEN: OTP VERIFICATION ═══ */}
        {currentStepName === "otp" && (
          <div className={`flex flex-1 flex-col animate-[fadeSlide_0.3s_ease] ${shakeOtp ? "animate-[headShake_0.4s_ease-in-out]" : ""}`}>
            <div className="mb-1 text-[22px] font-bold text-[#101828]">
              Verify Your Email &amp; Phone
            </div>
            <div className="mb-7 text-sm text-[#667085]">
              We&apos;ve sent a 5-digit verification code to your email and phone number.
            </div>

            <div className="flex flex-col gap-5 mt-2">
              {/* Email OTP */}
              <div className={`rounded-[14px] border-[1.5px] p-6 px-5 transition-all ${emailVerified ? "border-[#12B76A] bg-[rgba(18,183,106,0.04)]" : "border-[#E4E7EC] bg-[#FAFBFC]"}`}>
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[rgba(21,112,239,0.1)]">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                      <path d="M2.5 6.667l6.46 4.306a2 2 0 002.08 0L17.5 6.667M4.167 15.833h11.666A1.667 1.667 0 0017.5 14.167V5.833A1.667 1.667 0 0015.833 4.167H4.167A1.667 1.667 0 002.5 5.833v8.334a1.667 1.667 0 001.667 1.666z" stroke="#1570EF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div className="text-[15px] font-semibold text-[#101828]">Email Verification</div>
                </div>
                <div className="mb-1 text-center text-[13px] text-[#667085]">
                  Code sent to <strong className="text-[#101828]">{maskEmail(email)}</strong>
                </div>
                <div className="my-4 flex justify-center">
                  <OtpInput
                    value={emailOtp}
                    onChange={setEmailOtp}
                    verified={emailVerified}
                  />
                </div>
                {!emailVerified && (
                  <div className="text-center text-[13px] text-[#98A2B3]">
                    {emailTimerSeconds > 0 ? (
                      <>Resend code in <strong>{emailTimerSeconds}</strong>s</>
                    ) : (
                      <>
                        {"Didn't receive the code? "}
                        <button
                          onClick={() => {
                            setEmailOtp(["", "", "", "", ""]);
                            startEmailTimer();
                            sendSignupOtp.mutate({ email, phone: phone.replace(/\s/g, ""), countryCode });
                          }}
                          className="cursor-pointer border-none bg-transparent font-medium text-[#1570EF] hover:underline"
                        >
                          Resend OTP
                        </button>
                      </>
                    )}
                  </div>
                )}
                {emailVerified && (
                  <div className="mx-auto mt-3 flex w-fit items-center gap-1.5 rounded-full border border-[#A6F4C5] bg-[#ECFDF3] px-3.5 py-1.5 text-[13px] font-semibold text-[#12B76A]">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M3.5 8.5l3 3 6-6" stroke="#12B76A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Verified
                  </div>
                )}
              </div>

              {/* Phone OTP */}
              <div className={`rounded-[14px] border-[1.5px] p-6 px-5 transition-all ${phoneVerified ? "border-[#12B76A] bg-[rgba(18,183,106,0.04)]" : "border-[#E4E7EC] bg-[#FAFBFC]"}`}>
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[rgba(247,144,9,0.1)]">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                      <path d="M17.5 14.167v2.5a1.667 1.667 0 01-1.817 1.658 16.492 16.492 0 01-7.191-2.558 16.25 16.25 0 01-5-5 16.492 16.492 0 01-2.558-7.225A1.667 1.667 0 012.583 1.725h2.5A1.667 1.667 0 016.75 3.225c.106.8.303 1.585.584 2.342a1.667 1.667 0 01-.375 1.758l-1.059 1.06a13.333 13.333 0 005 5l1.058-1.059a1.667 1.667 0 011.759-.375c.757.281 1.542.478 2.341.584a1.667 1.667 0 011.442 1.632z" stroke="#F79009" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div className="text-[15px] font-semibold text-[#101828]">Phone Verification</div>
                </div>
                <div className="mb-1 text-center text-[13px] text-[#667085]">
                  Code sent to <strong className="text-[#101828]">{maskPhone(phone, countryCode)}</strong>
                </div>
                <div className="my-4 flex justify-center">
                  <OtpInput
                    value={phoneOtp}
                    onChange={setPhoneOtp}
                    verified={phoneVerified}
                  />
                </div>
                {!phoneVerified && (
                  <div className="text-center text-[13px] text-[#98A2B3]">
                    {phoneTimerSeconds > 0 ? (
                      <>Resend code in <strong>{phoneTimerSeconds}</strong>s</>
                    ) : (
                      <>
                        {"Didn't receive the code? "}
                        <button
                          onClick={() => {
                            setPhoneOtp(["", "", "", "", ""]);
                            startPhoneTimer();
                            sendSignupOtp.mutate({ email, phone: phone.replace(/\s/g, ""), countryCode });
                          }}
                          className="cursor-pointer border-none bg-transparent font-medium text-[#1570EF] hover:underline"
                        >
                          Resend OTP
                        </button>
                      </>
                    )}
                  </div>
                )}
                {phoneVerified && (
                  <div className="mx-auto mt-3 flex w-fit items-center gap-1.5 rounded-full border border-[#A6F4C5] bg-[#ECFDF3] px-3.5 py-1.5 text-[13px] font-semibold text-[#12B76A]">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M3.5 8.5l3 3 6-6" stroke="#12B76A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Verified
                  </div>
                )}
              </div>
            </div>

            <div className="mt-auto flex items-center justify-between pt-6">
              <Button variant="secondary" onClick={prevStep} iconLeft>
                Back
              </Button>
              <Button onClick={nextStep} iconRight>
                Verify &amp; Continue
              </Button>
            </div>
          </div>
        )}

        {/* ═══ SCREEN: COMPANY DETAILS (Agency) ═══ */}
        {currentStepName === "company" && (
          <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease]">
            <div className="mb-1 text-[22px] font-bold text-[#101828]">Company Details</div>
            <div className="mb-7 text-sm text-[#667085]">
              Tell us about your agency so we can customize your experience.
            </div>

            <div className="mb-4 flex gap-4">
              <FormInput
                label="Company / Agency Name"
                required
                placeholder="Enter company name"
                value={companyName}
                onChange={(e) => { setCompanyName(e.target.value); setErrors((p) => ({ ...p, companyName: undefined })); }}
                error={!!errors.companyName}
                errorMessage={errors.companyName}
              />
              <FormInput
                label="Company Website / LinkedIn"
                required
                placeholder="https://..."
                value={companyWebsite}
                onChange={(e) => { setCompanyWebsite(e.target.value); setErrors((p) => ({ ...p, companyWebsite: undefined })); }}
                error={!!errors.companyWebsite}
                errorMessage={errors.companyWebsite}
              />
            </div>

            <div className="mb-4 flex gap-4">
              <FormCombobox
                label="Country"
                required
                placeholder="Search country"
                loading={countriesQuery.isLoading}
                options={countryOptions}
                value={country}
                onChange={(v) => {
                  setCountry(v);
                  setState("");
                  setCity("");
                  setCityManual(false);
                  setErrors((p) => ({ ...p, country: undefined, pan: undefined }));
                }}
                error={!!errors.country}
                errorMessage={errors.country}
              />
              <FormCombobox
                label="State / Province"
                required={hasStates}
                placeholder={country && statesQuery.isSuccess && !hasStates ? "Not applicable" : "Search state"}
                loading={statesQuery.isFetching}
                options={stateNames.map((s) => ({ value: s, label: s }))}
                value={state}
                onChange={(v) => {
                  setState(v);
                  if (!cityManual) setCity("");
                  setErrors((p) => ({ ...p, state: undefined }));
                }}
                disabled={!country || (statesQuery.isSuccess && !hasStates)}
                error={!!errors.state}
                errorMessage={errors.state}
              />
            </div>
            <div className="mb-1 flex gap-4">
              {cityManual ? (
                <div className="flex flex-1 flex-col">
                  <FormInput
                    label="City"
                    required
                    placeholder="Type your city"
                    maxLength={100}
                    value={city}
                    onChange={(e) => { setCity(e.target.value); setErrors((p) => ({ ...p, city: undefined })); }}
                    error={!!errors.city}
                    errorMessage={errors.city}
                  />
                  <button
                    type="button"
                    onClick={() => { setCityManual(false); setCity(""); }}
                    className="mt-1 cursor-pointer self-start border-none bg-transparent p-0 text-xs font-medium text-[#1570EF] hover:underline"
                  >
                    Choose from the list instead
                  </button>
                </div>
              ) : (
                <FormCombobox
                  label="City"
                  required
                  placeholder="Search city"
                  loading={citiesQuery.isFetching}
                  options={(citiesQuery.data ?? []).map((c) => ({ value: c, label: c }))}
                  value={city}
                  onChange={(v) => {
                    setCity(v);
                    setErrors((p) => ({ ...p, city: undefined }));
                  }}
                  disabled={!country || (hasStates && !state)}
                  error={!!errors.city}
                  errorMessage={errors.city}
                  extraAction={{
                    label: "My city isn't listed",
                    onSelect: () => {
                      setCityManual(true);
                      setCity("");
                    },
                  }}
                />
              )}
              {/* Keeps the city at half-width, matching the rows above. */}
              <div className="flex-1" />
            </div>
            {/* GeoNames data is CC BY 4.0 — this attribution is required. */}
            <div className="mb-4 text-[11px] text-[#98A2B3]">
              Location data ©{" "}
              <a href="https://www.geonames.org" target="_blank" rel="noopener noreferrer" className="hover:underline">
                GeoNames
              </a>
              , licensed under{" "}
              <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer" className="hover:underline">
                CC BY 4.0
              </a>
            </div>

            <div className="mb-4">
              <FormTextarea
                label="Company Address"
                required
                placeholder="Full address including street, building, floor..."
                value={companyAddress}
                onChange={(e) => { setCompanyAddress(e.target.value); setErrors((p) => ({ ...p, companyAddress: undefined })); }}
                error={!!errors.companyAddress}
                errorMessage={errors.companyAddress}
              />
            </div>

            <div className="mb-4 flex gap-4">
              <FormSelect
                label="Number of Counselors"
                required
                placeholder="Select range"
                options={counselorRanges.map((r) => ({ value: r, label: r }))}
                value={numCounselors}
                onChange={(e) => { setNumCounselors(e.target.value); setErrors((p) => ({ ...p, numCounselors: undefined })); }}
                error={!!errors.numCounselors}
                errorMessage={errors.numCounselors}
              />
              <FormSelect
                label="Annual Student Volume"
                required
                placeholder="Select range"
                options={volumeRanges.map((r) => ({ value: r, label: r }))}
                value={annualVolume}
                onChange={(e) => { setAnnualVolume(e.target.value); setErrors((p) => ({ ...p, annualVolume: undefined })); }}
                error={!!errors.annualVolume}
                errorMessage={errors.annualVolume}
              />
            </div>

            <div className="mb-4 flex gap-4">
              <FormSelect
                label="GST Registered?"
                required
                placeholder="Select an option"
                options={[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ]}
                value={gstRegistered}
                onChange={(e) => {
                  setGstRegistered(e.target.value as "" | "yes" | "no");
                  setErrors((p) => ({ ...p, gstRegistered: undefined }));
                }}
                error={!!errors.gstRegistered}
                errorMessage={errors.gstRegistered}
              />
              <FormInput
                label="Company PAN"
                required={panRequired}
                placeholder="ABCDE1234F"
                maxLength={10}
                autoComplete="off"
                value={pan}
                onChange={(e) => { setPan(normalizePan(e.target.value)); setErrors((p) => ({ ...p, pan: undefined })); }}
                error={!!errors.pan}
                errorMessage={errors.pan}
              />
            </div>
            <div className="-mt-2 mb-4 text-xs text-[#667085]">
              PAN of the company or firm/LLP — or, for a sole proprietorship, the proprietor&apos;s PAN.
              Required for agencies based in India.
            </div>

            {gstRegistered === "yes" && (
              <div className="mb-4 rounded-lg border border-[#B2DDFF] bg-[#EFF8FF] px-3.5 py-2.5 text-[13px] text-[#175CD3]">
                You&apos;ll need to upload your GST certificate in the next step.
              </div>
            )}

            <div className="mt-auto flex items-center justify-between pt-6">
              <Button variant="secondary" onClick={prevStep} iconLeft>
                Back
              </Button>
              <Button onClick={nextStep} iconRight>
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* ═══ SCREEN: BUSINESS DOCUMENTS (Agency) ═══ */}
        {currentStepName === "documents" && role === "agency" && (
          <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease]">
            <div className="mb-1 text-[22px] font-bold text-[#101828]">Business Documents</div>
            <div className="mb-7 text-sm text-[#667085]">
              Upload the required documents to verify your agency.
            </div>

            <div className="mb-3.5 text-[13px] font-semibold tracking-wide text-[#344054] uppercase">
              Required Documents
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3.5">
              <FileUpload
                label="Company PAN Card"
                required
                hint="PDF, JPG or PNG (max 5MB)"
                fileName={agencyDocs.companyPan?.name}
                uploading={agencyDocs.companyPan?.uploading}
                error={!!errors.documents && !agencyDocs.companyPan?.name}
                onFileSelect={(f) => void setAgencyDoc("companyPan", f)}
                onFileRemove={() => removeAgencyDoc("companyPan")}
              />
              <FileUpload
                label="Aadhaar Card of Director"
                required
                hint="PDF, JPG or PNG (max 5MB)"
                fileName={agencyDocs.aadhaar?.name}
                uploading={agencyDocs.aadhaar?.uploading}
                error={!!errors.documents && !agencyDocs.aadhaar?.name}
                onFileSelect={(f) => void setAgencyDoc("aadhaar", f)}
                onFileRemove={() => removeAgencyDoc("aadhaar")}
              />
              <FileUpload
                label="Cancelled Cheque"
                required
                hint="PDF, JPG or PNG (max 5MB)"
                fileName={agencyDocs.cancelledCheque?.name}
                uploading={agencyDocs.cancelledCheque?.uploading}
                error={!!errors.documents && !agencyDocs.cancelledCheque?.name}
                onFileSelect={(f) => void setAgencyDoc("cancelledCheque", f)}
                onFileRemove={() => removeAgencyDoc("cancelledCheque")}
              />
              <FileUpload
                label="Company / Partnership Documents"
                required
                hint="PDF, JPG or PNG (max 5MB)"
                fileName={agencyDocs.partnershipDocs?.name}
                uploading={agencyDocs.partnershipDocs?.uploading}
                error={!!errors.documents && !agencyDocs.partnershipDocs?.name}
                onFileSelect={(f) => void setAgencyDoc("partnershipDocs", f)}
                onFileRemove={() => removeAgencyDoc("partnershipDocs")}
              />
              {/* GST certificate is mandatory only for a GST-registered agency;
                  otherwise it sits under Optional Documents below. */}
              {gstRegistered === "yes" && (
                <FileUpload
                  label="GST Certificate"
                  required
                  hint="PDF, JPG or PNG (max 5MB)"
                  fileName={agencyDocs.gst?.name}
                  uploading={agencyDocs.gst?.uploading}
                  error={!!errors.documents && !agencyDocs.gst?.name}
                  onFileSelect={(f) => void setAgencyDoc("gst", f)}
                  onFileRemove={() => removeAgencyDoc("gst")}
                />
              )}
            </div>

            <div className="mb-3.5 mt-6 text-[13px] font-semibold tracking-wide text-[#344054] uppercase">
              Optional Documents
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3.5">
              <FileUpload
                label="Company Logo"
                hint="JPG or PNG (max 2MB)"
                accept=".jpg,.jpeg,.png"
                maxSize={2}
                fileName={agencyDocs.logo?.name}
                uploading={agencyDocs.logo?.uploading}
                onFileSelect={(f) => void setAgencyDoc("logo", f)}
                onFileRemove={() => removeAgencyDoc("logo")}
              />
              {gstRegistered !== "yes" && (
                <FileUpload
                  label="GST Certificate"
                  hint="PDF, JPG or PNG (max 5MB)"
                  fileName={agencyDocs.gst?.name}
                  uploading={agencyDocs.gst?.uploading}
                  onFileSelect={(f) => void setAgencyDoc("gst", f)}
                  onFileRemove={() => removeAgencyDoc("gst")}
                />
              )}
            </div>

            {errors.documents && (
              <div className="mb-2 text-[13px] text-[#F04438]">{errors.documents}</div>
            )}

            <div className="mt-auto flex items-center justify-between pt-6">
              <Button variant="secondary" onClick={prevStep} iconLeft>
                Back
              </Button>
              <Button onClick={nextStep} iconRight>
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* ═══ SCREEN: ADDITIONAL INFO / DOCUMENTS (Independent) ═══ */}
        {currentStepName === "documents" && role === "independent" && (
          <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease]">
            <div className="mb-1 text-[22px] font-bold text-[#101828]">Additional Information</div>
            <div className="mb-7 text-sm text-[#667085]">
              Upload the required documents to verify your identity.
            </div>

            <div className="mb-6 flex gap-4">
              <FormInput
                label="PAN Number"
                required={panRequired}
                placeholder="ABCPE1234F"
                maxLength={10}
                autoComplete="off"
                value={pan}
                onChange={(e) => { setPan(normalizePan(e.target.value)); setErrors((p) => ({ ...p, pan: undefined })); }}
                error={!!errors.pan}
                errorMessage={errors.pan}
              />
              {/* Keeps the input at half-width, matching the upload grid. */}
              <div className="flex-1" />
            </div>

            <div className="mb-3.5 text-[13px] font-semibold tracking-wide text-[#344054] uppercase">
              Required Documents
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3.5">
              <FileUpload
                label="PAN Card"
                required
                hint="PDF, JPG or PNG (max 5MB)"
                fileName={independentDocs.pan?.name}
                uploading={independentDocs.pan?.uploading}
                error={!!errors.documents && !independentDocs.pan?.name}
                onFileSelect={(f) => void setIndependentDoc("pan", f)}
                onFileRemove={() => removeIndependentDoc("pan")}
              />
              <FileUpload
                label="Aadhaar Card"
                required
                hint="PDF, JPG or PNG (max 5MB)"
                fileName={independentDocs.aadhaar?.name}
                uploading={independentDocs.aadhaar?.uploading}
                error={!!errors.documents && !independentDocs.aadhaar?.name}
                onFileSelect={(f) => void setIndependentDoc("aadhaar", f)}
                onFileRemove={() => removeIndependentDoc("aadhaar")}
              />
              <FileUpload
                label="Cancelled Cheque"
                required
                hint="PDF, JPG or PNG (max 5MB)"
                fileName={independentDocs.cancelledCheque?.name}
                uploading={independentDocs.cancelledCheque?.uploading}
                error={!!errors.documents && !independentDocs.cancelledCheque?.name}
                onFileSelect={(f) => void setIndependentDoc("cancelledCheque", f)}
                onFileRemove={() => removeIndependentDoc("cancelledCheque")}
              />
            </div>

            <div className="mb-3.5 mt-6 text-[13px] font-semibold tracking-wide text-[#344054] uppercase">
              Optional
            </div>
            <div className="mb-4 grid max-w-[calc(50%-7px)] grid-cols-1 gap-3.5">
              <FileUpload
                label="Profile Photo"
                hint="JPG or PNG (max 2MB)"
                accept=".jpg,.jpeg,.png"
                maxSize={2}
                fileName={independentDocs.profilePhoto?.name}
                uploading={independentDocs.profilePhoto?.uploading}
                onFileSelect={(f) => void setIndependentDoc("profilePhoto", f)}
                onFileRemove={() => removeIndependentDoc("profilePhoto")}
              />
            </div>

            {errors.documents && (
              <div className="mb-2 text-[13px] text-[#F04438]">{errors.documents}</div>
            )}

            <div className="mt-auto flex items-center justify-between pt-6">
              <Button variant="secondary" onClick={prevStep} iconLeft>
                Back
              </Button>
              <Button onClick={nextStep} iconRight>
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* ═══ SCREEN: REVIEW & SUBMIT (Agency) ═══ */}
        {currentStepName === "review" && role === "agency" && (
          <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease]">
            <div className="mb-1 text-[22px] font-bold text-[#101828]">Review &amp; Submit</div>
            <div className="mb-7 text-sm text-[#667085]">
              Please review all the information before submitting your application.
            </div>

            <ReviewCard
              title="Personal Details"
              onEdit={() => goToStepByName("basic")}
              items={[
                { label: "Name", value: `${firstName} ${lastName}` },
                {
                  label: "Email",
                  value: (
                    <>
                      {email}
                      <span className="inline-flex items-center gap-1 rounded-[10px] bg-[rgba(18,183,106,0.1)] px-2 py-0.5 text-[11px] font-semibold text-[#12B76A]">
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Verified
                      </span>
                    </>
                  ),
                },
                {
                  label: "Phone",
                  value: (
                    <>
                      {countryCode} {phone}
                      <span className="inline-flex items-center gap-1 rounded-[10px] bg-[rgba(18,183,106,0.1)] px-2 py-0.5 text-[11px] font-semibold text-[#12B76A]">
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Verified
                      </span>
                    </>
                  ),
                },
                { label: "Type", value: "Agency Owner" },
              ]}
            />

            <ReviewCard
              title="Company Details"
              onEdit={() => goToStepByName("company")}
              items={[
                { label: "Company Name", value: companyName },
                { label: "Website", value: companyWebsite },
                { label: "Location", value: [city, state, countryName].filter(Boolean).join(", ") },
                { label: "Company PAN", value: pan || "—" },
                { label: "Team Size", value: `${numCounselors} counselors` },
                { label: "GST Registered", value: gstRegistered === "yes" ? "Yes" : "No" },
              ]}
            />

            <ReviewCard
              title="Business Documents"
              onEdit={() => goToStepByName("documents")}
            >
              <div className="flex flex-wrap gap-2">
                {getAgencyDocStatus().map((d) => (
                  <DocBadge key={d.name} name={d.name} status={d.status} />
                ))}
              </div>
            </ReviewCard>

            <ConsentCheckbox
              checked={consent}
              onChange={(v) => { setConsent(v); setErrors((p) => ({ ...p, consent: undefined })); }}
              error={!!errors.consent}
              errorMessage={errors.consent}
            />

            {submitApp.error && (
              <div className="mt-3 text-[13px] text-[#F04438]">
                {submitApp.error.data?.zodError?.fieldErrors.pan?.[0] ??
                  submitApp.error.data?.zodError?.formErrors[0] ??
                  submitApp.error.message}
              </div>
            )}

            <div className="mt-auto flex items-center justify-between pt-6">
              <Button variant="secondary" onClick={prevStep} iconLeft>
                Back
              </Button>
              <Button onClick={handleSubmit} iconRight loading={submitApp.isPending}>
                Submit Application
              </Button>
            </div>
          </div>
        )}

        {/* ═══ SCREEN: REVIEW & SUBMIT (Independent) ═══ */}
        {currentStepName === "review" && role === "independent" && (
          <div className="flex flex-1 flex-col animate-[fadeSlide_0.3s_ease]">
            <div className="mb-1 text-[22px] font-bold text-[#101828]">Review &amp; Submit</div>
            <div className="mb-7 text-sm text-[#667085]">
              Please review all the information before submitting your application.
            </div>

            <ReviewCard
              title="Personal Details"
              onEdit={() => goToStepByName("basic")}
              items={[
                { label: "Name", value: `${firstName} ${lastName}` },
                {
                  label: "Email",
                  value: (
                    <>
                      {email}
                      <span className="inline-flex items-center gap-1 rounded-[10px] bg-[rgba(18,183,106,0.1)] px-2 py-0.5 text-[11px] font-semibold text-[#12B76A]">
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Verified
                      </span>
                    </>
                  ),
                },
                {
                  label: "Phone",
                  value: (
                    <>
                      {countryCode} {phone}
                      <span className="inline-flex items-center gap-1 rounded-[10px] bg-[rgba(18,183,106,0.1)] px-2 py-0.5 text-[11px] font-semibold text-[#12B76A]">
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Verified
                      </span>
                    </>
                  ),
                },
                { label: "Type", value: "Independent Counselor" },
              ]}
            />

            <ReviewCard
              title="Additional Information"
              onEdit={() => goToStepByName("documents")}
              items={[{ label: "PAN", value: pan || "—" }]}
            >
              <div className="flex flex-wrap gap-2">
                {getIndependentDocStatus().map((d) => (
                  <DocBadge key={d.name} name={d.name} status={d.status} />
                ))}
              </div>
            </ReviewCard>

            <ConsentCheckbox
              checked={consent}
              onChange={(v) => { setConsent(v); setErrors((p) => ({ ...p, consent: undefined })); }}
              error={!!errors.consent}
              errorMessage={errors.consent}
            />

            {submitApp.error && (
              <div className="mt-3 text-[13px] text-[#F04438]">
                {submitApp.error.data?.zodError?.fieldErrors.pan?.[0] ??
                  submitApp.error.data?.zodError?.formErrors[0] ??
                  submitApp.error.message}
              </div>
            )}

            <div className="mt-auto flex items-center justify-between pt-6">
              <Button variant="secondary" onClick={prevStep} iconLeft>
                Back
              </Button>
              <Button onClick={handleSubmit} iconRight loading={submitApp.isPending}>
                Submit Application
              </Button>
            </div>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}

// Role card sub-component
function RoleCard({
  selected,
  onClick,
  icon,
  title,
  subtitle,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div
      onClick={onClick}
      className={`relative flex flex-1 cursor-pointer items-center gap-3 rounded-[10px] border-[1.5px] p-4 transition-all hover:border-[#1570EF] ${
        selected
          ? "border-[#1570EF] bg-[rgba(21,112,239,0.04)]"
          : "border-[#E4E7EC]"
      }`}
    >
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
          selected ? "bg-[rgba(21,112,239,0.1)]" : "bg-[#F2F4F7]"
        }`}
      >
        {icon}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-[#101828]">{title}</h4>
        <p className="text-xs text-[#667085]">{subtitle}</p>
      </div>
      {selected && (
        <div className="absolute top-2.5 right-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#1570EF]">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 6l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </div>
  );
}
