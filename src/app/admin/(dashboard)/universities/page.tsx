"use client";

import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { Modal } from "~/components/ui/modal";
import { StatCard } from "~/components/ui/stat-card";
import { StatusBadge } from "~/components/ui/status-badge";
import { Toast } from "~/components/ui/toast";
import { UniLogo } from "~/components/ui/uni-logo";
import { api, type RouterOutputs } from "~/trpc/react";
import { SkeletonTable } from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";
import {
  ImportPreviewModal,
  type ImportPreview,
} from "./import-preview-modal";

type CourseRow = RouterOutputs["universities"]["listCourses"][number];

// ----- Constants -----------------------------------------------------------

// ISO2 → display name. Bigger list lives in `~/lib/constants/location-data`
// for signup; this is the catalog admin's whitelist.
const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "IE", name: "Ireland" },
  { code: "NZ", name: "New Zealand" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "SG", name: "Singapore" },
  { code: "AE", name: "UAE" },
  { code: "IN", name: "India" },
];
const COUNTRY_NAME = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]));

// ISO2 → 🇺🇸 (regional indicator codepoints).
function flagEmoji(iso2: string): string {
  if (iso2.length !== 2) return "";
  return iso2
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(c.charCodeAt(0) + 127397))
    .join("");
}

const APP_SOURCES = ["University Portal", "Agent Portal", "Paper-based Application"];

const DEGREE_LEVELS: Array<{
  code: number;
  label: string;
  short: string;
  badge: "ug" | "masters" | "mba" | "phd" | "diploma";
}> = [
  { code: 0, label: "Undergraduate / Bachelors", short: "UG", badge: "ug" },
  { code: 1, label: "Masters", short: "Masters", badge: "masters" },
  { code: 2, label: "MBA", short: "MBA", badge: "mba" },
  { code: 3, label: "PhD / Doctorate", short: "PhD", badge: "phd" },
  { code: 4, label: "PG Diploma / Certificate", short: "PGD", badge: "diploma" },
  { code: 5, label: "Diploma", short: "Diploma", badge: "diploma" },
  { code: 6, label: "Associate Degree", short: "Assoc.", badge: "ug" },
  { code: 7, label: "Foundation Year", short: "Found.", badge: "diploma" },
  { code: 8, label: "High School", short: "HS", badge: "diploma" },
];

const CURRENCIES = ["USD", "GBP", "EUR", "CAD", "AUD", "NZD", "SGD", "AED", "INR"];

type TabKey = "universities" | "programs" | "bulk";
type StatusFilter = "all" | "active" | "inactive";
type TypeFilter = "all" | "public" | "private";

// ----- Types ---------------------------------------------------------------

type UniversityRow = {
  id: number;
  name: string;
  code: string | null;
  city: string | null;
  country: string;
  type: "public" | "private";
  ranking: number | null;
  appSource: string | null;
  website: string | null;
  logoUrl: string | null;
  isOpen: boolean;
  courseCount: number;
};

// ----- Forms ---------------------------------------------------------------

interface UniFormState {
  name: string;
  code: string;
  country: string;
  city: string;
  type: "public" | "private";
  ranking: string;
  appSource: string;
  website: string;
  logoUrl: string;
  isOpen: boolean;
}

const emptyUniForm = (): UniFormState => ({
  name: "",
  code: "",
  country: "US",
  city: "",
  type: "public",
  ranking: "",
  appSource: "University Portal",
  website: "",
  logoUrl: "",
  isOpen: true,
});

const fromUni = (u: UniversityRow): UniFormState => ({
  name: u.name,
  code: u.code ?? "",
  country: u.country,
  city: u.city ?? "",
  type: u.type,
  ranking: u.ranking !== null ? String(u.ranking) : "",
  appSource: u.appSource ?? "",
  website: u.website ?? "",
  logoUrl: u.logoUrl ?? "",
  isOpen: u.isOpen,
});

interface CourseFormState {
  universityId: string;
  name: string;
  code: string;
  degreeLevel: string;
  durationMonths: string;
  tuitionFee: string;
  currency: string;
  isOpen: boolean;
  url: string;
  toefl: string;
  ielts: string;
  det: string;
  pte: string;
  gre: string;
  gmat: string;
  isStem: boolean;
  intakeMonth: string;
  intakeYear: string;
  isCoopAvailable: boolean;
  hasAppFeeWaiver: boolean;
  appFee: string;
  applicationDeadline: string;
  hasTuitionDeposit: boolean;
  hasScholarship: boolean;
  scholarshipAmount: string;
  minEntryRequirements: string;
  minEntryRequirementsScale: string;
  hasFasterTat: boolean;
}

const emptyCourseForm = (): CourseFormState => ({
  universityId: "",
  name: "",
  code: "",
  degreeLevel: "",
  durationMonths: "",
  tuitionFee: "",
  currency: "USD",
  isOpen: true,
  url: "",
  toefl: "",
  ielts: "",
  det: "",
  pte: "",
  gre: "",
  gmat: "",
  isStem: false,
  intakeMonth: "",
  intakeYear: "",
  isCoopAvailable: false,
  hasAppFeeWaiver: false,
  appFee: "",
  applicationDeadline: "",
  hasTuitionDeposit: false,
  hasScholarship: false,
  scholarshipAmount: "",
  minEntryRequirements: "",
  minEntryRequirementsScale: "",
  hasFasterTat: false,
});

const numOrNull = (s: string): number | null => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (s: string): number | null => {
  const n = numOrNull(s);
  return n === null ? null : Math.trunc(n);
};

const formatUniId = (id: number): string => `UNI-${String(id).padStart(3, "0")}`;

// ----- Page ----------------------------------------------------------------

export default function AdminUniversitiesPage() {
  const utils = api.useUtils();
  const universities = api.universities.listUniversities.useQuery();
  const courses = api.universities.listCourses.useQuery();

  const [tab, setTab] = useState<TabKey>("universities");

  // Filters (Universities tab)
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  // Filters (Programs tab)
  const [programUniFilter, setProgramUniFilter] = useState<string>("all");

  // Universities expansion
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Modals
  const [uniModal, setUniModal] = useState<{ open: boolean; editing: UniversityRow | null }>({
    open: false,
    editing: null,
  });
  const [courseModalOpen, setCourseModalOpen] = useState(false);
  const [editingCourseId, setEditingCourseId] = useState<number | null>(null);
  const [uniForm, setUniForm] = useState<UniFormState>(emptyUniForm());
  const [courseForm, setCourseForm] = useState<CourseFormState>(emptyCourseForm());
  const [uniErrors, setUniErrors] = useState<Record<string, string>>({});
  const [courseErrors, setCourseErrors] = useState<Record<string, string>>({});

  // Toast
  const [toastMsg, setToastMsg] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    setToastOpen(true);
  };

  // ---- Mutations ----
  const createUni = api.universities.createUniversity.useMutation({
    onSuccess: () => {
      void utils.universities.listUniversities.invalidate();
      closeUniModal();
      showToast("University created");
    },
    onError: (err) => setUniErrors({ form: err.message }),
  });

  const updateUni = api.universities.updateUniversity.useMutation({
    onSuccess: () => {
      void utils.universities.listUniversities.invalidate();
      closeUniModal();
      showToast("University updated");
    },
    onError: (err) => setUniErrors({ form: err.message }),
  });

  const setOpenMut = api.universities.setUniversityOpen.useMutation({
    onSuccess: (data) => {
      void utils.universities.listUniversities.invalidate();
      showToast(`${data.name} ${data.isOpen ? "activated" : "deactivated"}`);
    },
    onError: (err) => showToast(err.message),
  });

  const deleteUni = api.universities.deleteUniversity.useMutation({
    onSuccess: () => {
      void utils.universities.listUniversities.invalidate();
      void utils.universities.listCourses.invalidate();
      showToast("University deleted");
    },
    onError: (err) => showToast(err.message),
  });

  const createCourse = api.universities.createCourse.useMutation({
    onSuccess: () => {
      void utils.universities.listCourses.invalidate();
      void utils.universities.listUniversities.invalidate();
      setCourseModalOpen(false);
      setCourseForm(emptyCourseForm());
      showToast("Program created");
    },
    onError: (err) => setCourseErrors({ form: err.message }),
  });

  const updateCourse = api.universities.updateCourse.useMutation({
    onSuccess: () => {
      void utils.universities.listCourses.invalidate();
      setCourseModalOpen(false);
      setEditingCourseId(null);
      setCourseForm(emptyCourseForm());
      showToast("Program updated");
    },
    onError: (err) => setCourseErrors({ form: err.message }),
  });

  const deleteCourse = api.universities.deleteCourse.useMutation({
    onSuccess: () => {
      void utils.universities.listCourses.invalidate();
      showToast("Program deleted");
    },
    onError: (err) => showToast(err.message),
  });

  // ---- Derived data ----
  // Wrapped in useMemo so they have stable references across renders (the
  // alternative `?? []` produces a fresh array each render and trips
  // react-hooks/exhaustive-deps in dependent useMemo calls below).
  const allUnis = useMemo<UniversityRow[]>(
    () => universities.data ?? [],
    [universities.data],
  );
  const allCourses = useMemo<CourseRow[]>(
    () => courses.data ?? [],
    [courses.data],
  );

  // Country pool restricted to what's actually in the data — keeps the dropdown
  // tight once admins start adding less-common countries.
  const knownCountries = useMemo(() => {
    const set = new Set<string>();
    for (const u of allUnis) set.add(u.country);
    return [...set].sort();
  }, [allUnis]);

  const filteredUnis = useMemo(() => {
    let rows = allUnis;
    if (countryFilter !== "all") rows = rows.filter((u) => u.country === countryFilter);
    if (typeFilter !== "all") rows = rows.filter((u) => u.type === typeFilter);
    if (statusFilter !== "all")
      rows = rows.filter((u) => (statusFilter === "active" ? u.isOpen : !u.isOpen));
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          (u.city ?? "").toLowerCase().includes(q) ||
          (u.code ?? "").toLowerCase().includes(q) ||
          formatUniId(u.id).toLowerCase().includes(q),
      );
    }
    return rows;
  }, [allUnis, countryFilter, typeFilter, statusFilter, search]);

  const filteredCourses = useMemo(() => {
    let rows = allCourses;
    if (programUniFilter !== "all") {
      rows = rows.filter((c) => String(c.universityId) === programUniFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.code ?? "").toLowerCase().includes(q) ||
          (c.university?.name ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [allCourses, search, programUniFilter]);

  const stats = useMemo(() => {
    const distinctCountries = new Set(allUnis.map((u) => u.country));
    return {
      totalUni: allUnis.length,
      totalPrograms: allCourses.length,
      inactiveUni: allUnis.filter((u) => !u.isOpen).length,
      countries: [...distinctCountries],
    };
  }, [allUnis, allCourses]);

  // ---- Handlers ----
  function openAddUni() {
    setUniModal({ open: true, editing: null });
    setUniForm(emptyUniForm());
    setUniErrors({});
  }

  function openEditUni(u: UniversityRow) {
    const apply = () => {
      setUniModal({ open: true, editing: u });
      setUniForm(fromUni(u));
      setUniErrors({});
    };
    const doc: Document & {
      startViewTransition?: (cb: () => void) => unknown;
    } = document;
    if (!doc.startViewTransition) {
      apply();
      return;
    }
    // Morph the row's logo into the edit modal's logo field: name the row logo
    // (old snapshot), then clear it + open the modal whose logo carries the
    // same name (new snapshot) so the browser tweens between them.
    const rowLogo = document.querySelector<HTMLElement>(
      `[data-uni-logo="${u.id}"]`,
    );
    if (rowLogo) rowLogo.style.viewTransitionName = "uni-logo-morph";
    doc.startViewTransition(() => {
      if (rowLogo) rowLogo.style.viewTransitionName = "";
      flushSync(apply);
    });
  }

  function closeUniModal() {
    setUniModal({ open: false, editing: null });
    setUniErrors({});
  }

  function openAddCourse() {
    setEditingCourseId(null);
    setCourseForm(emptyCourseForm());
    setCourseErrors({});
    setCourseModalOpen(true);
  }

  function handleSubmitUni() {
    const errs: Record<string, string> = {};
    if (!uniForm.name.trim()) errs.name = "Name is required";
    const code = uniForm.code.trim();
    if (!code) {
      errs.code = "Code is required";
    } else if (!/^[a-zA-Z0-9]{3}$/.test(code)) {
      errs.code = "Code must be exactly 3 alphanumeric characters";
    }
    if (!uniForm.country.trim() || uniForm.country.length !== 2)
      errs.country = "Country is required";
    if (!uniForm.city.trim()) errs.city = "City is required";
    setUniErrors(errs);
    if (Object.keys(errs).length) return;

    const payload = {
      name: uniForm.name.trim(),
      code,
      country: uniForm.country,
      city: uniForm.city.trim(),
      type: uniForm.type === "private" ? 1 : 0,
      ranking: intOrNull(uniForm.ranking),
      appSource: uniForm.appSource.trim() || null,
      website: uniForm.website.trim() || null,
      logoUrl: uniForm.logoUrl.trim() || null,
      isOpen: uniForm.isOpen,
    };

    if (uniModal.editing) {
      updateUni.mutate({ id: uniModal.editing.id, ...payload });
    } else {
      createUni.mutate(payload);
    }
  }

  function handleSubmitCourse() {
    const degreeLevel =
      courseForm.degreeLevel === "" ? null : Number(courseForm.degreeLevel);
    const durationMonths = intOrNull(courseForm.durationMonths);
    const tuitionFee = numOrNull(courseForm.tuitionFee);
    const currency = courseForm.currency.trim();
    const url = courseForm.url.trim();
    const errs: Record<string, string> = {};
    if (!courseForm.name.trim()) errs.name = "Name is required";
    if (!courseForm.universityId) errs.universityId = "Pick a university";
    if (degreeLevel === null) errs.degreeLevel = "Degree level is required";
    if (durationMonths === null) errs.durationMonths = "Duration (months) is required";
    if (tuitionFee === null) errs.tuitionFee = "Tuition fee is required";
    if (!currency) errs.currency = "Currency is required";
    if (!url) errs.url = "Program URL is required";
    setCourseErrors(errs);
    if (Object.keys(errs).length) return;
    const payload = {
      universityId: Number(courseForm.universityId),
      name: courseForm.name.trim(),
      code: courseForm.code.trim() || null,
      degreeLevel: degreeLevel!,
      durationMonths: durationMonths!,
      tuitionFee: tuitionFee!,
      currency: currency,
      isOpen: courseForm.isOpen,
      url: url,
      toefl: numOrNull(courseForm.toefl),
      ielts: numOrNull(courseForm.ielts),
      det: intOrNull(courseForm.det),
      pte: numOrNull(courseForm.pte),
      gre: intOrNull(courseForm.gre),
      gmat: intOrNull(courseForm.gmat),
      isStem: courseForm.isStem,
      intakeMonth: courseForm.intakeMonth.trim() || null,
      intakeYear: intOrNull(courseForm.intakeYear),
      isCoopAvailable: courseForm.isCoopAvailable,
      hasAppFeeWaiver: courseForm.hasAppFeeWaiver,
      appFee: numOrNull(courseForm.appFee),
      applicationDeadline: courseForm.applicationDeadline.trim() || null,
      hasTuitionDeposit: courseForm.hasTuitionDeposit,
      hasScholarship: courseForm.hasScholarship,
      scholarshipAmount: numOrNull(courseForm.scholarshipAmount),
      minEntryRequirements: courseForm.minEntryRequirements.trim() || null,
      minEntryRequirementsScale:
        courseForm.minEntryRequirementsScale.trim() || null,
      hasFasterTat: courseForm.hasFasterTat,
    };
    if (editingCourseId != null) {
      updateCourse.mutate({ ...payload, id: editingCourseId });
    } else {
      createCourse.mutate(payload);
    }
  }

  // Open the course modal pre-filled for editing an existing program.
  function openEditCourse(c: CourseRow) {
    setEditingCourseId(c.id);
    setCourseErrors({});
    setCourseForm({
      universityId: String(c.universityId),
      name: c.name ?? "",
      code: c.code ?? "",
      degreeLevel: c.degreeLevel == null ? "" : String(c.degreeLevel),
      durationMonths: c.durationMonths == null ? "" : String(c.durationMonths),
      tuitionFee: c.tuitionFee == null ? "" : String(c.tuitionFee),
      currency: c.currency ?? "USD",
      isOpen: c.isOpen,
      url: c.url ?? "",
      toefl: c.toefl == null ? "" : String(c.toefl),
      ielts: c.ielts == null ? "" : String(c.ielts),
      det: c.det == null ? "" : String(c.det),
      pte: c.pte == null ? "" : String(c.pte),
      gre: c.gre == null ? "" : String(c.gre),
      gmat: c.gmat == null ? "" : String(c.gmat),
      isStem: c.isStem,
      intakeMonth: c.intakeMonth ?? "",
      intakeYear: c.intakeYear == null ? "" : String(c.intakeYear),
      isCoopAvailable: c.isCoopAvailable,
      hasAppFeeWaiver: c.hasAppFeeWaiver,
      appFee: c.appFee == null ? "" : String(c.appFee),
      applicationDeadline: c.applicationDeadline ?? "",
      hasTuitionDeposit: c.hasTuitionDeposit,
      hasScholarship: c.hasScholarship,
      scholarshipAmount: c.scholarshipAmount == null ? "" : String(c.scholarshipAmount),
      minEntryRequirements: c.minEntryRequirements ?? "",
      minEntryRequirementsScale: c.minEntryRequirementsScale ?? "",
      hasFasterTat: c.hasFasterTat,
    });
    setCourseModalOpen(true);
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function resetUniFilters() {
    setCountryFilter("all");
    setTypeFilter("all");
    setStatusFilter("all");
    setSearch("");
  }

  // ---- Render ----
  return (
    <>
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#101828]">Universities</h1>
          <p className="mt-1 text-sm text-[#667085]">
            Manage university and program data — the central hub feeding all portal modules
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => showToast("Export coming soon")}
            className="!h-[38px] !px-4"
          >
            <DownloadIcon /> Export CSV
          </Button>
          <Button
            variant="secondary"
            onClick={openAddCourse}
            className="!h-[38px] !border-[#6172F3] !px-4 !text-[#6172F3] hover:!bg-[#F4F3FF]"
          >
            <PlusIcon /> Add Program
          </Button>
          <Button onClick={openAddUni} className="!h-[38px] !px-4">
            <PlusIcon /> Add University
          </Button>
        </div>
      </div>

      {/* Stat cards (matches mock: Total Universities, Total Programs, Inactive, Countries) */}
      <Stagger className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <FadeUp className="h-full">
          <StatCard
            label="Total Universities"
            value={stats.totalUni}
            sub={`Across ${stats.countries.length} countries`}
          />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard
            label="Total Programs"
            value={stats.totalPrograms}
            sub="UG + Postgrad"
          />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard
            label="Inactive Universities"
            value={stats.inactiveUni}
            valueClassName={stats.inactiveUni > 0 ? "text-[#F79009]" : undefined}
            sub="Currently not active"
          />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard
            label="Countries Covered"
            value={stats.countries.length}
            sub={
              stats.countries.length
                ? stats.countries.map(flagEmoji).join(" ")
                : "—"
            }
          />
        </FadeUp>
      </Stagger>

      {/* Tabs */}
      <div className="mb-5 flex gap-0 border-b-2 border-[#E4E7EC]">
        <TabButton
          active={tab === "universities"}
          onClick={() => setTab("universities")}
          count={stats.totalUni}
        >
          Universities
        </TabButton>
        <TabButton
          active={tab === "programs"}
          onClick={() => setTab("programs")}
          count={stats.totalPrograms}
        >
          Programs
        </TabButton>
        <TabButton active={tab === "bulk"} onClick={() => setTab("bulk")}>
          Bulk Upload &amp; Approvals
        </TabButton>
      </div>

      {/* Filter bar */}
      {tab === "universities" && (
        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          <FilterSelect
            value={countryFilter}
            onChange={setCountryFilter}
            options={[
              { value: "all", label: "All Countries" },
              ...knownCountries.map((c) => ({
                value: c,
                label: `${flagEmoji(c)} ${COUNTRY_NAME[c] ?? c}`,
              })),
            ]}
          />
          <FilterSelect
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as TypeFilter)}
            options={[
              { value: "all", label: "All Types" },
              { value: "public", label: "Public" },
              { value: "private", label: "Private" },
            ]}
          />
          <FilterSelect
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            options={[
              { value: "all", label: "All Status" },
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ]}
          />
          <div className="flex h-[38px] flex-1 items-center gap-2 rounded-lg border border-[#D0D5DD] bg-white px-3 sm:max-w-[300px]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth={2}
              className="h-4 w-4 stroke-[#98A2B3]"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search universities..."
              className="w-full border-none bg-transparent text-sm text-[#344054] outline-none placeholder:text-[#98A2B3]"
            />
          </div>
          <button
            type="button"
            onClick={resetUniFilters}
            className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
          >
            Reset
          </button>
        </div>
      )}

      {tab === "programs" && (
        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          <select
            value={programUniFilter}
            onChange={(e) => setProgramUniFilter(e.target.value)}
            className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-sm text-[#344054] outline-none focus:border-[#1570EF]"
          >
            <option value="all">All universities</option>
            {allUnis.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
          </select>
          <div className="flex h-[38px] flex-1 items-center gap-2 rounded-lg border border-[#D0D5DD] bg-white px-3 sm:max-w-[300px]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth={2}
              className="h-4 w-4 stroke-[#98A2B3]"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search programs..."
              className="w-full border-none bg-transparent text-sm text-[#344054] outline-none placeholder:text-[#98A2B3]"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setProgramUniFilter("all");
              setSearch("");
            }}
            className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3.5 text-sm font-medium text-[#667085] hover:bg-[#F9FAFB]"
          >
            Reset
          </button>
        </div>
      )}

      {tab === "universities" && (
        <UniversitiesCard
          isLoading={universities.isLoading}
          rows={filteredUnis}
          totalRows={allUnis.length}
          allCourses={allCourses}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          error={universities.error?.message}
          onEdit={openEditUni}
          onToggleStatus={(u) =>
            setOpenMut.mutate({ id: u.id, isOpen: !u.isOpen })
          }
          onDelete={(id) => {
            if (!confirm("Delete this university? This cannot be undone.")) return;
            deleteUni.mutate({ id });
          }}
        />
      )}

      {tab === "programs" && (
        <ProgramsCard
          isLoading={courses.isLoading}
          rows={filteredCourses}
          totalRows={allCourses.length}
          error={courses.error?.message}
          onEdit={openEditCourse}
          onDelete={(id) => {
            if (!confirm("Delete this program? This cannot be undone.")) return;
            deleteCourse.mutate({ id });
          }}
        />
      )}

      {tab === "bulk" && (
        <BulkUploadTab
          onComplete={async () => {
            await Promise.all([
              utils.universities.listUniversities.invalidate(),
              utils.universities.listCourses.invalidate(),
            ]);
          }}
        />
      )}

      {/* Add / Edit University modal */}
      <Modal
        open={uniModal.open}
        title={uniModal.editing ? "Edit University" : "Add University"}
        onClose={closeUniModal}
        animateIn={!uniModal.editing}
        footer={
          <>
            <Button variant="secondary" onClick={closeUniModal} className="!h-[38px] !px-4">
              Cancel
            </Button>
            <Button
              onClick={handleSubmitUni}
              loading={createUni.isPending || updateUni.isPending}
              className="!h-[38px] !px-4"
            >
              Save
            </Button>
          </>
        }
      >
        <FormInput
          label="University Name"
          required
          placeholder="e.g. University of Oxford"
          value={uniForm.name}
          onChange={(e) => setUniForm({ ...uniForm, name: e.target.value })}
          error={!!uniErrors.name}
          errorMessage={uniErrors.name}
        />
        <div>
          <FormInput
            label="Code (3 chars, unique)"
            required
            maxLength={3}
            placeholder="e.g. MIT, NUS, ICL"
            value={uniForm.code}
            onChange={(e) => setUniForm({ ...uniForm, code: e.target.value })}
            error={!!uniErrors.code}
            errorMessage={uniErrors.code}
          />
          {!uniErrors.code && (
            <div className="mt-1 text-xs text-[#98A2B3]">
              Exactly 3 alphanumeric chars. Used for ZIP logo matching and bulk import upserts.
            </div>
          )}
        </div>
        <FormSelect
          label="Country"
          required
          options={COUNTRIES.map((c) => ({
            value: c.code,
            label: `${flagEmoji(c.code)} ${c.name}`,
          }))}
          value={uniForm.country}
          onChange={(e) => setUniForm({ ...uniForm, country: e.target.value })}
          error={!!uniErrors.country}
          errorMessage={uniErrors.country}
        />
        <FormInput
          label="City"
          placeholder="e.g. Oxford"
          value={uniForm.city}
          onChange={(e) => setUniForm({ ...uniForm, city: e.target.value })}
        />
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-[#344054]">Type</div>
          <div className="flex gap-4 text-[13px] text-[#344054]">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                checked={uniForm.type === "public"}
                onChange={() => setUniForm({ ...uniForm, type: "public" })}
              />
              Public
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                checked={uniForm.type === "private"}
                onChange={() => setUniForm({ ...uniForm, type: "private" })}
              />
              Private
            </label>
          </div>
        </div>
        <FormInput
          label="QS World Ranking"
          type="number"
          placeholder="e.g. 32"
          value={uniForm.ranking}
          onChange={(e) => setUniForm({ ...uniForm, ranking: e.target.value })}
        />
        <FormInput
          label="Website URL"
          placeholder="https://www.university.edu"
          value={uniForm.website}
          onChange={(e) => setUniForm({ ...uniForm, website: e.target.value })}
        />
        <FormSelect
          label="Application Source"
          options={APP_SOURCES.map((s) => ({ value: s, label: s }))}
          value={uniForm.appSource}
          onChange={(e) => setUniForm({ ...uniForm, appSource: e.target.value })}
        />
        <LogoUploader
          name={uniForm.name || "Logo"}
          logoUrl={uniForm.logoUrl}
          onChange={(url) => setUniForm({ ...uniForm, logoUrl: url })}
          onError={showToast}
        />
        <FormSelect
          label="Status"
          options={[
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
          value={uniForm.isOpen ? "active" : "inactive"}
          onChange={(e) => setUniForm({ ...uniForm, isOpen: e.target.value === "active" })}
        />
        {uniErrors.form && <ErrorBanner message={uniErrors.form} />}
      </Modal>

      {/* Add / Edit Program modal */}
      <Modal
        open={courseModalOpen}
        title={editingCourseId != null ? "Edit Program" : "Add Program"}
        onClose={() => setCourseModalOpen(false)}
        width="w-[640px]"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setCourseModalOpen(false)}
              className="!h-[38px] !px-4"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmitCourse}
              loading={createCourse.isPending || updateCourse.isPending}
              className="!h-[38px] !px-4"
            >
              {editingCourseId != null ? "Update Program" : "Save Program"}
            </Button>
          </>
        }
      >
        <SectionDivider label="Basics" first />
        <FormSelect
          label="University"
          required
          placeholder="Select a university…"
          options={allUnis.map((u) => ({
            value: String(u.id),
            label: `${u.name} (${u.country})`,
          }))}
          value={courseForm.universityId}
          onChange={(e) =>
            setCourseForm({ ...courseForm, universityId: e.target.value })
          }
          error={!!courseErrors.universityId}
          errorMessage={courseErrors.universityId}
        />
        <FormInput
          label="Program Name"
          required
          placeholder="e.g. MSc Computer Science"
          value={courseForm.name}
          onChange={(e) => setCourseForm({ ...courseForm, name: e.target.value })}
          error={!!courseErrors.name}
          errorMessage={courseErrors.name}
        />
        <div className="grid grid-cols-2 gap-3">
          <FormSelect
            label="Study Level"
            placeholder="Select level"
            options={DEGREE_LEVELS.map((d) => ({
              value: String(d.code),
              label: d.label,
            }))}
            value={courseForm.degreeLevel}
            onChange={(e) =>
              setCourseForm({ ...courseForm, degreeLevel: e.target.value })
            }
          />
          <FormInput
            label="Duration (months)"
            type="number"
            value={courseForm.durationMonths}
            onChange={(e) =>
              setCourseForm({ ...courseForm, durationMonths: e.target.value })
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormInput
            label="Code (unique)"
            placeholder="e.g. MIT-CS-MS"
            value={courseForm.code}
            onChange={(e) => setCourseForm({ ...courseForm, code: e.target.value })}
          />
          <FormInput
            label="Program URL"
            placeholder="https://…"
            value={courseForm.url}
            onChange={(e) => setCourseForm({ ...courseForm, url: e.target.value })}
          />
        </div>

        <SectionDivider label="Cost & Currency" />
        <div className="grid grid-cols-3 gap-3">
          <FormInput
            label="Tuition Fee"
            type="number"
            value={courseForm.tuitionFee}
            onChange={(e) =>
              setCourseForm({ ...courseForm, tuitionFee: e.target.value })
            }
          />
          <FormSelect
            label="Currency"
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            value={courseForm.currency}
            onChange={(e) =>
              setCourseForm({ ...courseForm, currency: e.target.value })
            }
          />
          <FormInput
            label="Application Fee"
            type="number"
            value={courseForm.appFee}
            onChange={(e) => setCourseForm({ ...courseForm, appFee: e.target.value })}
          />
          <FormInput
            label="Application Deadline"
            type="date"
            value={courseForm.applicationDeadline}
            onChange={(e) =>
              setCourseForm({ ...courseForm, applicationDeadline: e.target.value })
            }
          />
        </div>

        <SectionDivider label="Intake" />
        <div className="grid grid-cols-2 gap-3">
          <FormInput
            label="Intake Month(s)"
            placeholder="e.g. Sep, Jan"
            value={courseForm.intakeMonth}
            onChange={(e) =>
              setCourseForm({ ...courseForm, intakeMonth: e.target.value })
            }
          />
          <FormInput
            label="Intake Year"
            type="number"
            placeholder="e.g. 2026"
            value={courseForm.intakeYear}
            onChange={(e) =>
              setCourseForm({ ...courseForm, intakeYear: e.target.value })
            }
          />
        </div>

        <SectionDivider label="Test Requirements (minimum)" />
        <div className="grid grid-cols-3 gap-3">
          <FormInput
            label="TOEFL"
            type="number"
            placeholder="0–120"
            value={courseForm.toefl}
            onChange={(e) => setCourseForm({ ...courseForm, toefl: e.target.value })}
          />
          <FormInput
            label="IELTS"
            type="number"
            placeholder="0–9"
            value={courseForm.ielts}
            onChange={(e) => setCourseForm({ ...courseForm, ielts: e.target.value })}
          />
          <FormInput
            label="DET"
            type="number"
            placeholder="10–160"
            value={courseForm.det}
            onChange={(e) => setCourseForm({ ...courseForm, det: e.target.value })}
          />
          <FormInput
            label="PTE"
            type="number"
            placeholder="10–90"
            value={courseForm.pte}
            onChange={(e) => setCourseForm({ ...courseForm, pte: e.target.value })}
          />
          <FormInput
            label="GRE"
            type="number"
            placeholder="260–340"
            value={courseForm.gre}
            onChange={(e) => setCourseForm({ ...courseForm, gre: e.target.value })}
          />
          <FormInput
            label="GMAT"
            type="number"
            placeholder="200–800"
            value={courseForm.gmat}
            onChange={(e) => setCourseForm({ ...courseForm, gmat: e.target.value })}
          />
        </div>
        <FormTextarea
          label="Min. Entry Requirement"
          placeholder="e.g. 3.0, 65%, or the full requirement text from the program page"
          rows={3}
          maxLength={2000}
          value={courseForm.minEntryRequirements}
          onChange={(e) =>
            setCourseForm({ ...courseForm, minEntryRequirements: e.target.value })
          }
        />
        <div className="grid grid-cols-2 gap-3">
          <FormInput
            label="Scale"
            maxLength={20}
            placeholder="e.g. GPA, Percentage, CGPA"
            value={courseForm.minEntryRequirementsScale}
            onChange={(e) =>
              setCourseForm({
                ...courseForm,
                minEntryRequirementsScale: e.target.value,
              })
            }
          />
        </div>

        <SectionDivider label="Scholarship & Flags" />
        <FormInput
          label="Scholarship Amount"
          type="number"
          value={courseForm.scholarshipAmount}
          onChange={(e) =>
            setCourseForm({ ...courseForm, scholarshipAmount: e.target.value })
          }
        />
        <div className="grid grid-cols-2 gap-2">
          <Toggle
            label="Open for applications"
            checked={courseForm.isOpen}
            onChange={(v) => setCourseForm({ ...courseForm, isOpen: v })}
          />
          <Toggle
            label="STEM"
            checked={courseForm.isStem}
            onChange={(v) => setCourseForm({ ...courseForm, isStem: v })}
          />
          <Toggle
            label="Co-op available"
            checked={courseForm.isCoopAvailable}
            onChange={(v) => setCourseForm({ ...courseForm, isCoopAvailable: v })}
          />
          <Toggle
            label="App fee waiver"
            checked={courseForm.hasAppFeeWaiver}
            onChange={(v) => setCourseForm({ ...courseForm, hasAppFeeWaiver: v })}
          />
          <Toggle
            label="Tuition deposit"
            checked={courseForm.hasTuitionDeposit}
            onChange={(v) => setCourseForm({ ...courseForm, hasTuitionDeposit: v })}
          />
          <Toggle
            label="Has scholarship"
            checked={courseForm.hasScholarship}
            onChange={(v) => setCourseForm({ ...courseForm, hasScholarship: v })}
          />
          <Toggle
            label="Faster TAT"
            checked={courseForm.hasFasterTat}
            onChange={(v) => setCourseForm({ ...courseForm, hasFasterTat: v })}
          />
        </div>
        {courseErrors.form && <ErrorBanner message={courseErrors.form} />}
      </Modal>

      <Toast message={toastMsg} open={toastOpen} onClose={() => setToastOpen(false)} />
    </>
  );
}

// ----- Filter select chip --------------------------------------------------

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-[38px] cursor-pointer rounded-lg border border-[#D0D5DD] bg-white px-3 text-sm font-medium text-[#344054] outline-none hover:border-[#1570EF] focus:border-[#1570EF]"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ----- Tab button ----------------------------------------------------------

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-0.5 flex cursor-pointer items-center gap-2 border-b-2 bg-transparent px-5 py-2.5 text-sm font-semibold transition-colors ${
        active
          ? "border-[#1570EF] text-[#1570EF]"
          : "border-transparent text-[#667085] hover:text-[#1570EF]"
      }`}
    >
      {children}
      {count !== undefined && (
        <span
          className={`rounded-[10px] px-2 py-0.5 text-[12px] font-semibold ${
            active ? "bg-[#EFF8FF] text-[#1570EF]" : "bg-[#F2F4F7] text-[#344054]"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ----- Universities table card --------------------------------------------

function UniversitiesCard({
  isLoading,
  rows,
  totalRows,
  allCourses,
  expanded,
  onToggleExpand,
  error,
  onEdit,
  onToggleStatus,
  onDelete,
}: {
  isLoading: boolean;
  rows: UniversityRow[];
  totalRows: number;
  allCourses: CourseRow[];
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  error?: string;
  onEdit: (u: UniversityRow) => void;
  onToggleStatus: (u: UniversityRow) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <TableCard title="Universities" count={rows.length} totalCount={totalRows}>
      {error ? (
        <ErrorBanner message={error} />
      ) : isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="No universities" hint="Add one or use Bulk Upload." />
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th />
              <Th>ID</Th>
              <Th>University</Th>
              <Th>Country</Th>
              <Th>City</Th>
              <Th>Type</Th>
              <Th right>Programs</Th>
              <Th>Ranking</Th>
              <Th>App Source</Th>
              <Th>Commission</Th>
              <Th>Status</Th>
              <Th right>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const isExpanded = expanded.has(u.id);
              const programs = allCourses.filter((c) => c.universityId === u.id);
              return (
                <FragmentRow key={u.id}>
                  <tr
                    className={`cursor-pointer border-b border-[#F2F4F7] transition-colors hover:bg-[#F0F7FF] ${
                      isExpanded ? "bg-[#F9FAFB]" : ""
                    }`}
                    onClick={() => onToggleExpand(u.id)}
                  >
                    <Td className="!pr-0 !pl-4">
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="#667085"
                        strokeWidth={1.6}
                        className={`h-4 w-4 transition-transform ${
                          isExpanded ? "rotate-90" : ""
                        }`}
                      >
                        <path d="M6 4l4 4-4 4" />
                      </svg>
                    </Td>
                    <Td>
                      <span className="font-mono text-[12px] font-semibold text-[#1570EF]">
                        {formatUniId(u.id)}
                      </span>
                      {u.code && (
                        <div className="font-mono text-[10px] text-[#98A2B3]">
                          {u.code}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span data-uni-logo={u.id} className="inline-flex shrink-0">
                          <UniLogo name={u.name} logoUrl={u.logoUrl} size={32} />
                        </span>
                        <span className="font-semibold text-[#101828]">{u.name}</span>
                      </div>
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden>{flagEmoji(u.country)}</span>
                        {COUNTRY_NAME[u.country] ?? u.country}
                      </span>
                    </Td>
                    <Td muted>{u.city ?? "—"}</Td>
                    <Td>
                      <TypeBadge type={u.type} />
                    </Td>
                    <Td right className="font-mono text-[#475467]">
                      {u.courseCount}
                    </Td>
                    <Td className="font-mono text-[#475467]">
                      {u.ranking !== null ? `#${u.ranking}` : "—"}
                    </Td>
                    <Td muted>{u.appSource ?? "—"}</Td>
                    <Td>
                      <CommissionPill linked={false} />
                    </Td>
                    <Td>
                      <StatusBadge
                        status={u.isOpen ? "active" : "inactive"}
                        label={u.isOpen ? "Active" : "Inactive"}
                      />
                    </Td>
                    <Td right onClick={(e) => e.stopPropagation()}>
                      <RowActions>
                        <ActionBtn tone="neutral" onClick={() => onEdit(u)}>
                          Edit
                        </ActionBtn>
                        {u.isOpen ? (
                          <ActionBtn tone="warning" onClick={() => onToggleStatus(u)}>
                            Deactivate
                          </ActionBtn>
                        ) : (
                          <ActionBtn tone="success" onClick={() => onToggleStatus(u)}>
                            Activate
                          </ActionBtn>
                        )}
                        <ActionBtn tone="danger" onClick={() => onDelete(u.id)}>
                          Delete
                        </ActionBtn>
                      </RowActions>
                    </Td>
                  </tr>
                  {isExpanded && (
                    <tr className="border-b border-[#F2F4F7] bg-[#F9FAFB]">
                      <td colSpan={12} className="px-5 py-4">
                        {programs.length === 0 ? (
                          <div className="text-xs text-[#98A2B3]">
                            No programs yet for this university.
                          </div>
                        ) : (
                          <table className="w-full">
                            <thead>
                              <tr>
                                {[
                                  "Program",
                                  "Code",
                                  "Level",
                                  "Duration",
                                  "Tuition",
                                  "Intake",
                                  "Requirements",
                                  "App Fee",
                                  "Deadline",
                                ].map((h) => (
                                  <th
                                    key={h}
                                    className="border-b border-[#E4E7EC] bg-white px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]"
                                  >
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {programs.map((p) => (
                                <tr key={p.id} className="border-b border-[#F2F4F7] last:border-b-0">
                                  <td className="px-2.5 py-2 text-xs font-semibold text-[#101828]">
                                    {p.name}
                                  </td>
                                  <td className="px-2.5 py-2 text-xs text-[#475467]">
                                    {p.code ?? "—"}
                                  </td>
                                  <td className="px-2.5 py-2">
                                    <LevelBadge code={p.degreeLevel} />
                                  </td>
                                  <td className="px-2.5 py-2 text-xs text-[#475467]">
                                    {p.durationMonths ? `${p.durationMonths} mo` : "—"}
                                  </td>
                                  <td className="px-2.5 py-2 text-xs text-[#475467]">
                                    {p.tuitionFee !== null
                                      ? `${p.currency ?? ""} ${p.tuitionFee.toLocaleString()}`
                                      : "—"}
                                  </td>
                                  <td className="px-2.5 py-2 text-xs text-[#475467]">
                                    {[p.intakeMonth, p.intakeYear].filter(Boolean).join(" ") ||
                                      "—"}
                                  </td>
                                  <td className="px-2.5 py-2">
                                    <ProgramRequirements c={p} />
                                  </td>
                                  <td className="px-2.5 py-2 text-xs text-[#475467]">
                                    {p.appFee !== null
                                      ? `${p.currency ?? ""} ${p.appFee.toLocaleString()}`
                                      : "—"}
                                  </td>
                                  <td className="px-2.5 py-2 text-xs text-[#475467]">
                                    {formatDeadline(p.applicationDeadline)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      )}
    </TableCard>
  );
}

// React fragments inside <tbody> with arbitrary children require a wrapping
// container that doesn't render an actual element — Fragment is fine but
// looks noisy at call sites; this is a tiny readability shim.
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// Compact admission-requirement pills (IELTS/TOEFL/PTE/DET/GRE/GMAT). Only
// tests with a stored minimum score are shown; "—" when none are set.
function ProgramRequirements({ c }: { c: CourseRow }) {
  const reqs: string[] = [];
  if (c.ielts !== null) reqs.push(`IELTS ${c.ielts}`);
  if (c.toefl !== null) reqs.push(`TOEFL ${c.toefl}`);
  if (c.pte !== null) reqs.push(`PTE ${c.pte}`);
  if (c.det !== null) reqs.push(`DET ${c.det}`);
  if (c.gre !== null) reqs.push(`GRE ${c.gre}`);
  if (c.gmat !== null) reqs.push(`GMAT ${c.gmat}`);
  if (reqs.length === 0) {
    return <span className="text-xs text-[#98A2B3]">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {reqs.map((r) => (
        <span
          key={r}
          className="inline-flex items-center rounded-md bg-[#EFF8FF] px-1.5 py-0.5 text-[10px] font-semibold text-[#175CD3]"
        >
          {r}
        </span>
      ))}
    </div>
  );
}

// ISO date (yyyy-mm-dd) → "12 Jan 2026"; "—" when unset.
function formatDeadline(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ----- Programs table card ------------------------------------------------

function ProgramsCard({
  isLoading,
  rows,
  totalRows,
  error,
  onEdit,
  onDelete,
}: {
  isLoading: boolean;
  rows: CourseRow[];
  totalRows: number;
  error?: string;
  onEdit: (c: CourseRow) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <TableCard title="Programs" count={rows.length} totalCount={totalRows}>
      {error ? (
        <ErrorBanner message={error} />
      ) : isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="No programs" hint="Add one or use Bulk Upload." />
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Program</Th>
              <Th>University</Th>
              <Th>Level</Th>
              <Th>Duration</Th>
              <Th>Tuition</Th>
              <Th>Intake</Th>
              <Th>Status</Th>
              <Th right>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.id}
                className="border-b border-[#F2F4F7] last:border-b-0 hover:bg-[#FAFBFC]"
              >
                <Td>
                  <div className="font-semibold text-[#101828]">{c.name}</div>
                  {c.code && (
                    <div className="text-[11px] font-mono text-[#98A2B3]">{c.code}</div>
                  )}
                </Td>
                <Td muted>
                  {c.university ? `${c.university.name} (${c.university.country})` : "—"}
                </Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    <LevelBadge code={c.degreeLevel} />
                    {c.isStem && (
                      <span className="rounded-md bg-[#ECFDF3] px-1.5 py-0.5 text-[10px] font-bold text-[#067647]">
                        STEM
                      </span>
                    )}
                  </div>
                </Td>
                <Td>{c.durationMonths ? `${c.durationMonths} mo` : "—"}</Td>
                <Td>
                  {c.tuitionFee !== null
                    ? `${c.currency ?? ""} ${c.tuitionFee.toLocaleString()}`
                    : "—"}
                </Td>
                <Td className="text-xs">
                  {[c.intakeMonth, c.intakeYear].filter(Boolean).join(" ") || "—"}
                </Td>
                <Td>
                  <StatusBadge
                    status={c.isOpen ? "active" : "inactive"}
                    label={c.isOpen ? "Open" : "Closed"}
                  />
                </Td>
                <Td right>
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => onEdit(c)}
                      className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#475467] hover:bg-[#F2F4F7]"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(c.id)}
                      className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#F04438] hover:bg-[#FEF3F2]"
                    >
                      Delete
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableCard>
  );
}

// ----- Bulk upload tab ----------------------------------------------------

interface ImportSummary {
  universities: { created: number; updated: number };
  courses: { created: number; updated: number };
  errors: Array<{ sheet: "University" | "Course"; row: number; message: string }>;
}

function BulkUploadTab({ onComplete }: { onComplete: () => Promise<void> }) {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const handlePreview = async () => {
    if (!csvFile) return;
    setParsing(true);
    setErrorMsg(null);
    setSummary(null);
    try {
      const fd = new FormData();
      fd.append("file", csvFile);
      if (zipFile) fd.append("zip", zipFile);
      const res = await fetch("/api/admin/uni-import", {
        method: "POST",
        body: fd,
      });
      const json = (await res.json()) as ImportPreview | { error: string };
      if (!res.ok || "error" in json) {
        setErrorMsg(("error" in json && json.error) || `HTTP ${res.status}`);
      } else {
        setPreview(json);
        setModalOpen(true);
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Parse failed");
    } finally {
      setParsing(false);
    }
  };

  const handleCommitted = async (s: ImportSummary) => {
    setSummary(s);
    setModalOpen(false);
    setPreview(null);
    setCsvFile(null);
    setZipFile(null);
    if (csvInputRef.current) csvInputRef.current.value = "";
    if (zipInputRef.current) zipInputRef.current.value = "";
    await onComplete();
  };

  return (
    <div className="rounded-xl border border-[#E4E7EC] bg-white p-6">
      <div className="mb-4">
        <h3 className="text-base font-bold text-[#101828]">
          Bulk import universities &amp; programs
        </h3>
        <p className="mt-1 text-sm text-[#667085]">
          Upload an XLSX/CSV with sheets named{" "}
          <code className="rounded bg-[#F2F4F7] px-1 py-0.5 text-xs">University</code> and{" "}
          <code className="rounded bg-[#F2F4F7] px-1 py-0.5 text-xs">Course</code>.
          Each university row needs a unique{" "}
          <code className="rounded bg-[#F2F4F7] px-1 py-0.5 text-xs">code</code> (exactly 3
          alphanumeric chars, e.g. <code className="rounded bg-[#F2F4F7] px-1 py-0.5 text-xs">MIT</code>).
          Courses reference universities by the spreadsheet&apos;s{" "}
          <code className="rounded bg-[#F2F4F7] px-1 py-0.5 text-xs">id</code> column.
        </p>
        <p className="mt-2 text-sm text-[#667085]">
          Optionally attach a ZIP of logos. Each file&apos;s name (without extension) must
          match a university&apos;s <code className="rounded bg-[#F2F4F7] px-1 py-0.5 text-xs">code</code>.
          Example: <code className="rounded bg-[#F2F4F7] px-1 py-0.5 text-xs">mit.png</code>{" "}
          attaches to the university with code <code className="rounded bg-[#F2F4F7] px-1 py-0.5 text-xs">MIT</code>.
        </p>
      </div>

      {/* CSV drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) {
            setCsvFile(f);
            setErrorMsg(null);
            setSummary(null);
          }
        }}
        onClick={() => csvInputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragOver
            ? "border-[#1570EF] bg-[#EFF8FF]"
            : "border-[#D0D5DD] bg-[#FAFBFC] hover:border-[#1570EF] hover:bg-[#F0F7FF]"
        }`}
      >
        <input
          ref={csvInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setCsvFile(f);
            setErrorMsg(null);
            setSummary(null);
          }}
        />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#98A2B3"
          strokeWidth={1.5}
          className="mx-auto mb-3 h-10 w-10"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <div className="text-[15px] font-semibold text-[#344054]">
          {csvFile ? csvFile.name : "Drop CSV/XLSX here or click to browse"}
        </div>
        <div className="mt-1 text-[13px] text-[#98A2B3]">
          XLSX or CSV — <span className="font-semibold text-[#1570EF]">max 10 MB</span>
        </div>
      </div>

      {/* Optional ZIP */}
      <div className="mt-3 flex items-center gap-3 rounded-lg border border-[#E4E7EC] bg-[#FAFBFC] px-4 py-3">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#98A2B3"
          strokeWidth={1.6}
          className="h-5 w-5 shrink-0"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[#344054]">
            Logo ZIP (optional)
          </div>
          <div className="truncate text-xs text-[#667085]">
            {zipFile ? zipFile.name : "Filenames matched to university codes (e.g. mit.png)"}
          </div>
        </div>
        <input
          ref={zipInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          onClick={() => zipInputRef.current?.click()}
          className="rounded-lg border border-[#D0D5DD] bg-white px-3 py-1.5 text-xs font-semibold text-[#344054] hover:bg-white"
        >
          {zipFile ? "Change ZIP" : "Choose ZIP"}
        </button>
        {zipFile && (
          <button
            type="button"
            onClick={() => {
              setZipFile(null);
              if (zipInputRef.current) zipInputRef.current.value = "";
            }}
            className="text-xs font-medium text-[#F04438] hover:underline"
          >
            Remove
          </button>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setCsvFile(null);
            setZipFile(null);
            setErrorMsg(null);
            setSummary(null);
            if (csvInputRef.current) csvInputRef.current.value = "";
            if (zipInputRef.current) zipInputRef.current.value = "";
          }}
          className="!h-[38px] !px-4"
        >
          Reset
        </Button>
        <Button
          onClick={handlePreview}
          disabled={!csvFile || parsing}
          loading={parsing}
          className="!h-[38px] !px-4"
        >
          Preview Import
        </Button>
      </div>

      {errorMsg && (
        <div className="mt-5">
          <ErrorBanner message={errorMsg} />
        </div>
      )}

      {summary && (
        <div className="mt-5 space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryStat label="Universities created" value={summary.universities.created} tone="green" />
            <SummaryStat label="Universities updated" value={summary.universities.updated} tone="blue" />
            <SummaryStat label="Programs created" value={summary.courses.created} tone="green" />
            <SummaryStat label="Programs updated" value={summary.courses.updated} tone="blue" />
          </div>
          {summary.errors.length > 0 && (
            <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] p-4">
              <div className="mb-2 text-sm font-semibold text-[#B42318]">
                {summary.errors.length} row{summary.errors.length === 1 ? "" : "s"} skipped
              </div>
              <ul className="max-h-60 space-y-1 overflow-y-auto text-xs text-[#B42318]">
                {summary.errors.map((e, i) => (
                  <li key={i}>
                    [{e.sheet} row {e.row}] {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ImportPreviewModal
        open={modalOpen}
        preview={preview}
        onClose={() => setModalOpen(false)}
        onCommitted={handleCommitted}
      />
    </div>
  );
}

// ----- Tiny inline primitives ---------------------------------------------

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-4 w-4"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="h-4 w-4"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function TypeBadge({ type }: { type: "public" | "private" }) {
  if (type === "private") {
    return (
      <span className="rounded-[10px] bg-[#FDF2FA] px-2 py-0.5 text-[11px] font-semibold text-[#C11574]">
        Private
      </span>
    );
  }
  return (
    <span className="rounded-[10px] bg-[#EFF8FF] px-2 py-0.5 text-[11px] font-semibold text-[#175CD3]">
      Public
    </span>
  );
}

function CommissionPill({ linked }: { linked: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${
        linked ? "text-[#067647]" : "text-[#667085]"
      }`}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          linked ? "bg-[#12B76A]" : "bg-[#D0D5DD]"
        }`}
      />
      {linked ? "Linked" : "Not linked"}
    </span>
  );
}

function LevelBadge({ code }: { code: number | null }) {
  if (code === null) return <span className="text-[#98A2B3]">—</span>;
  const def = DEGREE_LEVELS.find((d) => d.code === code);
  if (!def) {
    return (
      <span className="rounded-md bg-[#F2F4F7] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#475467]">
        {code}
      </span>
    );
  }
  const palette: Record<typeof def.badge, string> = {
    ug: "bg-[#F0F7FF] text-[#1570EF]",
    masters: "bg-[#FDF2FA] text-[#C11574]",
    mba: "bg-[#F0FDF4] text-[#067647]",
    phd: "bg-[#F5F3FF] text-[#5925DC]",
    diploma: "bg-[#FFFAEB] text-[#B54708]",
  };
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${palette[def.badge]}`}
    >
      {def.short}
    </span>
  );
}

function RowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-1.5">{children}</div>;
}

function ActionBtn({
  tone,
  onClick,
  children,
}: {
  tone: "neutral" | "warning" | "success" | "danger";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const palette: Record<typeof tone, string> = {
    neutral: "border-[#D0D5DD] text-[#344054] hover:bg-[#F9FAFB]",
    warning: "border-[#FEC84B] text-[#B54708] hover:bg-[#FFFAEB]",
    success: "border-[#A6F4C5] text-[#067647] hover:bg-[#ECFDF3]",
    danger: "border-[#FECDCA] text-[#B42318] hover:bg-[#FEF3F2]",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-md border bg-white px-2.5 py-1 text-[11px] font-semibold transition-colors ${palette[tone]}`}
    >
      {children}
    </button>
  );
}

function LogoUploader({
  name,
  logoUrl,
  onChange,
  onError,
}: {
  name: string;
  logoUrl: string;
  onChange: (url: string) => void;
  onError: (msg: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handlePick = async (file: File) => {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      onError("Please upload a JPG or PNG file");
      return;
    }
    if (file.size > 200 * 1024) {
      onError("Logo must be under 200 KB");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folder", "uni-logos");
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Upload failed");
      }
      const json = (await res.json()) as { url: string };
      onChange(json.url);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-[#344054]">Logo</div>
      <div className="flex items-center gap-3">
        <span
          className="inline-flex"
          style={{ viewTransitionName: "uni-logo-morph" }}
        >
          <UniLogo name={name} logoUrl={logoUrl || null} size={56} />
        </span>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handlePick(f);
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="cursor-pointer rounded-lg border border-[#1570EF] bg-white px-3 py-1.5 text-xs font-semibold text-[#1570EF] transition-colors hover:bg-[#1570EF] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {uploading
                ? "Uploading…"
                : logoUrl
                  ? "Change logo"
                  : "Upload logo"}
            </button>
            {logoUrl && (
              <button
                type="button"
                onClick={() => onChange("")}
                className="cursor-pointer border-none bg-transparent text-xs font-medium text-[#F04438] hover:underline"
              >
                Remove
              </button>
            )}
          </div>
          <div className="text-[11px] text-[#98A2B3]">
            Square (1:1), ≥256×256 px, PNG (transparent bg) or JPG, ≤200 KB.
          </div>
        </div>
      </div>
    </div>
  );
}

function TableCard({
  title,
  count,
  totalCount,
  children,
}: {
  title: string;
  count: number;
  totalCount: number;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
      <div className="flex items-center justify-between border-b border-[#E4E7EC] px-5 py-4">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold text-[#101828]">{title}</h3>
          <span className="rounded-xl bg-[#EFF8FF] px-2.5 py-0.5 text-xs font-semibold text-[#1570EF]">
            {count}
          </span>
        </div>
        {count !== totalCount && (
          <span className="text-xs font-medium text-[#98A2B3]">
            Showing {count} of {totalCount}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wider text-[#667085] ${
        right ? "text-right" : "text-left"
      } whitespace-nowrap`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  muted,
  className,
  onClick,
}: {
  children: React.ReactNode;
  right?: boolean;
  muted?: boolean;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <td
      onClick={onClick}
      className={`px-3.5 py-3 text-sm whitespace-nowrap ${right ? "text-right" : ""} ${
        muted ? "text-[#667085]" : "text-[#344054]"
      } ${className ?? ""}`}
    >
      {children}
    </td>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-5 py-12 text-center">
      <div className="text-[15px] font-semibold text-[#667085]">{title}</div>
      <div className="mt-1 text-[13px] text-[#98A2B3]">{hint}</div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">
      {message}
    </div>
  );
}

function SectionDivider({ label, first }: { label: string; first?: boolean }) {
  return (
    <div className={first ? "" : "mt-4 border-t border-[#E4E7EC] pt-4"}>
      <div className="text-xs font-semibold uppercase tracking-wider text-[#667085]">
        {label}
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#E4E7EC] bg-white px-3 py-2 text-sm text-[#344054] hover:bg-[#FAFBFC]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-[#1570EF]"
      />
      {label}
    </label>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "blue" | "green";
}) {
  const cls =
    tone === "green"
      ? "border-[#A6F4C5] bg-[#ECFDF3] text-[#067647]"
      : "border-[#84CAFF] bg-[#EFF8FF] text-[#175CD3]";
  return (
    <div className={`rounded-lg border px-4 py-3 ${cls}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
