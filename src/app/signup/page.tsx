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
import { gstinError, normalizeGstin } from "~/lib/utils/gstin";
import { PARTNER_DOC_SLOTS } from "~/lib/constants/partner-documents";
import { PARTNER_FIELD_LABELS } from "~/lib/constants/partner-labels";
import { api } from "~/trpc/react";

type Role = "agency" | "independent";
// The sign-up category (16 Nov 2026). An institution (a school or college)
// signs up exactly like an agency: same steps, documents and GST rule, with
// its own wording. Agencies and institutions are both role "agency".
type Category = "agency" | "institution" | "independent";

const CATEGORY_OPTIONS: { value: Category; label: string; hint: string }[] = [
  { value: "agency", label: "Agent Owner", hint: "You own or run a study-abroad agency and will add your counsellors." },
  { value: "independent", label: "Independent Counsellor", hint: "You counsel students on your own, not as part of an agency." },
  {
    value: "institution",
    label: "Institutional Counsellor",
    hint: "You represent a school, college or other educational institution and will add its counsellors.",
  },
];

const agencySteps = ["basic", "otp", "company", "documents", "review"] as const;
const independentSteps = ["basic", "otp", "documents", "review"] as const;

// The organization documents come from PARTNER_DOC_SLOTS, so the list switches
// with the category. "gst" is required on top of the always-required ones for
// an Indian agency / institution (GST isn't asked outside India).
// Bank details and the cancelled cheque are not part of sign-up: they're added
// after approval in My Account → Financial Details.
const ORG_DOC_UPLOAD: Record<string, { hint?: string; accept?: string; maxSize?: number }> = {
  logo: { hint: "JPG or PNG (max 2MB)", accept: ".jpg,.jpeg,.png", maxSize: 2 },
};

const agencyDisplaySteps = [
  "Basic Information",
  "Company Details",
  "Business Documents",
  "Review & Submit",
];
const institutionDisplaySteps = [
  "Basic Information",
  "Institution Details",
  "Institution Documents",
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
  gstNumber?: string;
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
  const [category, setCategory] = useState<Category>("agency");
  const role: Role = category === "independent" ? "independent" : "agency";
  const isInstitution = category === "institution";
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
  // GSTIN: mandatory for an organization based in India (with its GST
  // certificate), not asked elsewhere.
  const [gstNumber, setGstNumber] = useState("");

  // OTP state
  const [emailOtp, setEmailOtp] = useState<string[]>(["", "", "", "", ""]);
  const [phoneOtp, setPhoneOtp] = useState<string[]>(["", "", "", "", ""]);
  const [emailVerified, setEmailVerified] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  // Signed proofs from the verify calls; submitApplication requires both.
  const [emailProof, setEmailProof] = useState("");
  const [phoneProof, setPhoneProof] = useState("");
  const [emailTimerSeconds, setEmailTimerSeconds] = useState(30);
  const [phoneTimerSeconds, setPhoneTimerSeconds] = useState(30);
  const emailTimerRef = useRef<NodeJS.Timeout | null>(null);
  const phoneTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Document uploads (agency)
  const [agencyDocs, setAgencyDocs] = useState<Record<string, FileState>>({
    companyPan: {},
    aadhaar: {},
    partnershipDocs: {},
    logo: {},
    gst: {},
  });

  // Document uploads (independent)
  const [independentDocs, setIndependentDocs] = useState<Record<string, FileState>>({
    pan: {},
    aadhaar: {},
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
  const gstRequired = role === "agency" && country === "IN";
  // The organization's sign-up documents for this category; the GST
  // certificate only applies in India.
  const orgDocSlots = PARTNER_DOC_SLOTS[isInstitution ? "institution" : "agency"].filter(
    (s) => s.atSignup && (s.key !== "gst" || gstRequired),
  );
  const orgDocRequired = (key: string) =>
    orgDocSlots.find((s) => s.key === key)?.required({ gstRegistered: gstRequired }) ?? false;
  // Words for the organization: "Company" for an agency, "Institution" for a
  // school / college.
  const orgWord = isInstitution ? "Institution" : "Company";

  // Computed values
  const steps = role === "agency" ? agencySteps : independentSteps;
  const displaySteps =
    role === "independent" ? independentDisplaySteps : isInstitution ? institutionDisplaySteps : agencyDisplaySteps;
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
          onSuccess: (data) => {
            setEmailProof(data.proof);
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
          onSuccess: (data) => {
            setPhoneProof(data.proof);
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
    if (!companyName.trim()) newErrors.companyName = `${orgWord} name is required`;
    if (!companyWebsite.trim()) newErrors.companyWebsite = "Website or LinkedIn is required";
    if (!country) newErrors.country = "Country is required";
    else if (statesQuery.isLoading) newErrors.state = "Loading states…";
    else if (hasStates && !state) newErrors.state = "State is required";
    if (!city.trim()) newErrors.city = "City is required";
    if (pan.trim() || panRequired) {
      const msg = panError(pan, isInstitution ? "institution" : "agency");
      if (msg) newErrors.pan = msg;
    }
    if (gstRequired) {
      const msg = gstinError(gstNumber);
      if (msg) newErrors.gstNumber = msg;
    }
    if (!companyAddress.trim()) newErrors.companyAddress = "Address is required";
    if (!numCounselors) newErrors.numCounselors = "Number of counselors is required";
    if (!annualVolume) newErrors.annualVolume = "Student volume is required";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateDocuments = (): boolean => {
    if (role === "agency") {
      const missing = orgDocSlots.some((s) => orgDocRequired(s.key) && !agencyDocs[s.key]?.name);
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
      const required = ["pan", "aadhaar"];
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

  // Sends fresh codes and opens the OTP screen with verification cleared.
  const startVerification = () => {
    sendSignupOtp.mutate(
      { email, phone: phone.replace(/\s/g, ""), countryCode },
      {
        onSuccess: () => {
          setEmailOtp(["", "", "", "", ""]);
          setPhoneOtp(["", "", "", "", ""]);
          setEmailVerified(false);
          setPhoneVerified(false);
          setEmailProof("");
          setPhoneProof("");
          setCurrentStepIndex((steps as readonly string[]).indexOf("otp"));
          startEmailTimer();
          startPhoneTimer();
        },
      },
    );
  };

  const nextStep = () => {
    setErrors({});
    const step = currentStepName;

    if (step === "basic") {
      if (!validateBasicInfo()) return;
      startVerification();
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
    // Only this category's documents (a GST certificate uploaded before the
    // country changed to one outside India isn't sent).
    const keys = new Set(
      role === "agency" ? orgDocSlots.map((s) => s.key) : Object.keys(independentDocs),
    );
    const documents: Record<string, string> = {};
    for (const [k, v] of Object.entries(docs)) {
      if (v.path && keys.has(k)) documents[k] = v.path;
    }

    submitApp.mutate(
      {
        role,
        orgKind: role === "agency" ? (isInstitution ? "institution" : "agency") : undefined,
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
        gstNumber: gstRequired ? normalizeGstin(gstNumber) : undefined,
        documents,
        pan: pan.trim() ? normalizePan(pan) : undefined,
        verification: { email: emailProof, phone: phoneProof },
      },
      {
        onSuccess: (data) => {
          setApplicationId(data.applicationId);
          setShowSuccess(true);
        },
        onError: (err) => {
          // Proofs expire; send new codes so the applicant can re-verify and
          // come back here with everything else they entered still filled in.
          if (err.data?.code === "PRECONDITION_FAILED") startVerification();
        },
      },
    );
  };

  // Agency <-> institution keeps the same steps; switching to or from an
  // independent changes them, so start over from the first step.
  const selectCategory = (next: Category) => {
    if (next === category) return;
    const nextRole: Role = next === "independent" ? "independent" : "agency";
    setCategory(next);
    if (nextRole !== role) setCurrentStepIndex(0);
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
    const docs = orgDocSlots.map((s) => ({ key: s.key, name: s.label, required: orgDocRequired(s.key) }));
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

            {/* Sign-up category: picks the steps and the document list. */}
            <div className="mb-6">
              <FormSelect
                label="I am a"
                required
                options={CATEGORY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={category}
                onChange={(e) => selectCategory(e.target.value as Category)}
              />
              <div className="mt-1.5 text-xs text-[#667085]">
                {CATEGORY_OPTIONS.find((o) => o.value === category)?.hint}
              </div>
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

            {/* Already registered (same email or phone) → send them to login,
                where they can see their application status. */}
            {sendSignupOtp.error && (
              <div className="mt-2 rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3.5 py-2.5 text-[13px] text-[#B42318]">
                {sendSignupOtp.error.message}
                {sendSignupOtp.error.data?.code === "CONFLICT" && (
                  <>
                    {" "}
                    <Link href="/login" className="font-semibold underline">
                      Log in
                    </Link>
                  </>
                )}
              </div>
            )}

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
            {/* Sent back here from submit because the proofs expired. */}
            {submitApp.error?.data?.code === "PRECONDITION_FAILED" && (
              <div className="-mt-4 mb-5 text-[13px] text-[#F04438]">
                {submitApp.error.message}
              </div>
            )}

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
                <div className="text-center text-xs text-[#98A2B3]">
                  Please check your junk/spam folder if you don&apos;t see it in your inbox.
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
            <div className="mb-1 text-[22px] font-bold text-[#101828]">{orgWord} Details</div>
            <div className="mb-7 text-sm text-[#667085]">
              {isInstitution
                ? "Tell us about your school or institution so we can customize your experience."
                : "Tell us about your agency so we can customize your experience."}
            </div>

            <div className="mb-4 flex gap-4">
              <FormInput
                label={isInstitution ? PARTNER_FIELD_LABELS.institutionName : PARTNER_FIELD_LABELS.companyName}
                required
                placeholder={isInstitution ? "Enter institution / school name" : "Enter company name"}
                value={companyName}
                onChange={(e) => { setCompanyName(e.target.value); setErrors((p) => ({ ...p, companyName: undefined })); }}
                error={!!errors.companyName}
                errorMessage={errors.companyName}
              />
              <FormInput
                label={`${orgWord} Website / LinkedIn`}
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
                  setErrors((p) => ({ ...p, country: undefined, pan: undefined, gstNumber: undefined }));
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
                label={`${orgWord} Address`}
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
              <FormInput
                label={isInstitution ? PARTNER_FIELD_LABELS.institutionPan : PARTNER_FIELD_LABELS.companyPan}
                required={panRequired}
                placeholder="ABCDE1234F"
                maxLength={10}
                autoComplete="off"
                value={pan}
                onChange={(e) => { setPan(normalizePan(e.target.value)); setErrors((p) => ({ ...p, pan: undefined })); }}
                error={!!errors.pan}
                errorMessage={errors.pan}
              />
              {gstRequired ? (
                <FormInput
                  label={PARTNER_FIELD_LABELS.gstNumber}
                  required
                  placeholder="27ABCDE1234F1Z5"
                  maxLength={15}
                  autoComplete="off"
                  value={gstNumber}
                  onChange={(e) => {
                    setGstNumber(normalizeGstin(e.target.value));
                    setErrors((p) => ({ ...p, gstNumber: undefined }));
                  }}
                  error={!!errors.gstNumber}
                  errorMessage={errors.gstNumber}
                />
              ) : (
                // Keeps the PAN at half-width, matching the rows above.
                <div className="flex-1" />
              )}
            </div>
            <div className="-mt-2 mb-4 text-xs text-[#667085]">
              {isInstitution
                ? "PAN of the institution itself — the trust, society, company or government body that runs it."
                : "PAN of the company or firm/LLP — or, for a sole proprietorship, the proprietor’s PAN."}{" "}
              Required in India.
            </div>

            {gstRequired && (
              <div className="mb-4 rounded-lg border border-[#B2DDFF] bg-[#EFF8FF] px-3.5 py-2.5 text-[13px] text-[#175CD3]">
                GST registration is required for {isInstitution ? "institutions" : "agencies"} based in India.
                You&apos;ll upload the GST certificate in the next step.
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
            <div className="mb-1 text-[22px] font-bold text-[#101828]">
              {isInstitution ? "Institution Documents" : "Business Documents"}
            </div>
            <div className="mb-7 text-sm text-[#667085]">
              Upload the required documents to verify your {isInstitution ? "institution" : "agency"}.
            </div>

            <div className="mb-3.5 text-[13px] font-semibold tracking-wide text-[#344054] uppercase">
              Required Documents
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3.5">
              {orgDocSlots
                .filter((slot) => orgDocRequired(slot.key))
                .map((slot) => (
                  <FileUpload
                    key={slot.key}
                    label={slot.label}
                    required
                    {...ORG_DOC_UPLOAD[slot.key]}
                    fileName={agencyDocs[slot.key]?.name}
                    uploading={agencyDocs[slot.key]?.uploading}
                    error={!!errors.documents && !agencyDocs[slot.key]?.name}
                    onFileSelect={(f) => void setAgencyDoc(slot.key, f)}
                    onFileRemove={() => removeAgencyDoc(slot.key)}
                  />
                ))}
            </div>

            <div className="mb-3.5 mt-6 text-[13px] font-semibold tracking-wide text-[#344054] uppercase">
              Optional Documents
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3.5">
              {orgDocSlots
                .filter((slot) => !orgDocRequired(slot.key))
                .map((slot) => (
                  <FileUpload
                    key={slot.key}
                    label={slot.label}
                    {...ORG_DOC_UPLOAD[slot.key]}
                    fileName={agencyDocs[slot.key]?.name}
                    uploading={agencyDocs[slot.key]?.uploading}
                    onFileSelect={(f) => void setAgencyDoc(slot.key, f)}
                    onFileRemove={() => removeAgencyDoc(slot.key)}
                  />
                ))}
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
                { label: "Type", value: isInstitution ? "Institutional Counsellor" : "Agent Owner" },
              ]}
            />

            <ReviewCard
              title={`${orgWord} Details`}
              onEdit={() => goToStepByName("company")}
              items={[
                { label: `${orgWord} Name`, value: companyName },
                { label: "Website", value: companyWebsite },
                { label: "Location", value: [city, state, countryName].filter(Boolean).join(", ") },
                { label: `${orgWord} PAN`, value: pan || "—" },
                { label: "Team Size", value: `${numCounselors} counselors` },
                ...(gstRequired ? [{ label: "GST Number", value: gstNumber }] : []),
              ]}
            />

            <ReviewCard
              title={isInstitution ? "Institution Documents" : "Business Documents"}
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
                  submitApp.error.data?.zodError?.fieldErrors.gstNumber?.[0] ??
                  submitApp.error.data?.zodError?.fieldErrors.documents?.[0] ??
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
                { label: "Type", value: "Independent Counsellor" },
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
                  submitApp.error.data?.zodError?.fieldErrors.gstNumber?.[0] ??
                  submitApp.error.data?.zodError?.fieldErrors.documents?.[0] ??
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
