// Client-safe shapes and formatting for Partner Tiers (the loyalty programme).
// The tiers themselves live in the database (Settings -> Partner Tiers) and a
// partner's tier is worked out in src/server/partner-tiers.ts.

export interface TierStepView {
  id: number;
  name: string;
  displayOrder: number;
  badgeColor: string; // #RRGGBB
  icon: string | null;
  benefits: string[];
  active: boolean;
  rank: number;
  minStudents: number;
  maxStudents: number | null;
  sharePct: number;
}

export interface TierOverrideView {
  tier: { id: number; name: string };
  endsOn: string | null; // YYYY-MM-DD, inclusive
  reason: string | null;
  isMigrated: boolean;
  setAt: string;
  setBy: { id: number; name: string } | null;
  active: boolean;
}

export interface TierStatusView {
  fy: number;
  fyLabel: string;
  students: number;
  computed: TierStepView;
  effective: TierStepView;
  source: "computed" | "override";
  override: TierOverrideView | null;
  next: { step: TierStepView; needed: number } | null;
  ladder: TierStepView[];
  label: string; // admin wording, e.g. "Gold (set by Super Admin until 31 Mar 2027) · automatic: Silver"
}

// Badge colours: the tier's colour as text on a light tint of itself.
export function tierBadgeStyle(color: string): { color: string; background: string } {
  return { color, background: `${color}1A` };
}

export function tierRangeText(s: { minStudents: number; maxStudents: number | null }): string {
  if (s.maxStudents == null) return `${s.minStudents}+ students`;
  if (s.minStudents === 0) return `Up to ${s.maxStudents} students`;
  return `${s.minStudents}–${s.maxStudents} students`;
}

export function fmtTierDate(ymd: string): string {
  const [y = 1970, m = 1, d = 1] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
