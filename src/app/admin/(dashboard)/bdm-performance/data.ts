// Display helpers + design tokens for the BDM Performance dashboard.
// The page pulls real partner data from the `bdm` router; this file is purely
// formatting + badge styles. The mock's synthetic CRM dataset (fabricated
// partners / prospects / activities / tasks) was removed — it had no backend and
// was never imported once the page moved to real data.

export type Status = "Active" | "Pending" | "Deactivated";

export const relDays = (d: number) =>
  d <= 0 ? "Today" : d === 1 ? "1d ago" : `${d}d ago`;

export const fmtMoney = (n: number) =>
  n >= 1e7
    ? `₹${(n / 1e7).toFixed(1)} Cr`
    : n >= 1e5
      ? `₹${(n / 1e5).toFixed(1)} L`
      : n >= 1e3
        ? `₹${Math.round(n / 1e3)}K`
        : `₹${n}`;

export const initials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();

export const STATUS_BADGE: Record<Status, { wrap: string; dot: string }> = {
  Active: { wrap: "bg-[#ECFDF3] text-[#027A48]", dot: "bg-[#12B76A]" },
  Pending: { wrap: "bg-[#FFF6ED] text-[#B54708]", dot: "bg-[#F79009]" },
  Deactivated: { wrap: "bg-[#FEF3F2] text-[#B42318]", dot: "bg-[#F04438]" },
};

export const PIPE_SEGMENTS = [
  { key: "leads", label: "Leads", color: "#1570EF" },
  { key: "preapp", label: "Pre-App", color: "#F79009" },
  { key: "submitted", label: "Submitted", color: "#7F56D9" },
  { key: "offer", label: "Offer", color: "#0BA5EC" },
  { key: "deposit", label: "Deposit", color: "#12B76A" },
] as const;
