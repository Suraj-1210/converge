"use client";

import { Logo } from "./logo";

interface BrandFeature {
  icon: React.ReactNode;
  label: string;
}

interface AdminBrandPanelProps {
  features?: BrandFeature[];
}

const defaultFeatures: BrandFeature[] = [
  {
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M9 12l2 2 4-4" />
        <circle cx="12" cy="12" r="10" />
      </svg>
    ),
    label: "Partner & Commission Management",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M12 2v20M2 12h20" />
        <circle cx="12" cy="12" r="10" />
      </svg>
    ),
    label: "Student Application Tracking",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M9 21V9" />
      </svg>
    ),
    label: "Financial Reconciliation",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    label: "Role-Based Access Control",
  },
];

export function AdminBrandPanel({ features = defaultFeatures }: AdminBrandPanelProps) {
  return (
    <div className="relative flex w-[480px] shrink-0 flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-[#0B4A8A] via-[#1570EF] to-[#53B1FD] px-12 py-15">
      {/* Decorative circles */}
      <div className="pointer-events-none absolute -top-[120px] -right-[120px] h-[400px] w-[400px] rounded-full bg-white/[0.06]" />
      <div className="pointer-events-none absolute -bottom-20 -left-20 h-[300px] w-[300px] rounded-full bg-white/[0.04]" />

      {/* Logo */}
      <Logo height={44} className="relative z-[1] mb-3" />
      <div className="mb-10 text-[13px] font-semibold uppercase tracking-[2px] text-white/70">
        Admin Portal
      </div>

      {/* Features */}
      <ul className="relative z-[1] flex flex-col gap-4">
        {features.map((feature) => (
          <li key={feature.label} className="flex items-center gap-3 text-sm font-medium text-white/90">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.12] [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:fill-none [&_svg]:stroke-white [&_svg]:stroke-2">
              {feature.icon}
            </span>
            {feature.label}
          </li>
        ))}
      </ul>

      <span className="absolute bottom-6 text-xs font-medium text-white/40">
        Collegepond Admin Portal v1.0
      </span>
    </div>
  );
}
