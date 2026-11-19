import { type ReactNode } from "react";
import { BRAND_MARK_WHITE } from "~/components/ui/logo";

/**
 * The portals are dense desktop dashboards and aren't built for small screens.
 * Below the `lg` breakpoint (1024px) we show a friendly interstitial instead.
 * Pure Tailwind responsive classes — no client media query — so it's SSR-safe
 * and never causes a hydration mismatch.
 */
export function MobileGate({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-[#F5F6FA] px-8 text-center lg:hidden">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1570EF]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BRAND_MARK_WHITE} alt="Collegepond" className="h-9 w-9" />
        </span>
        <div>
          <h1 className="text-xl font-bold text-[#101828]">Best viewed on desktop</h1>
          <p className="mx-auto mt-2 max-w-xs text-sm text-[#667085]">
            The Collegepond portal isn&apos;t optimised for phones or small screens yet. Please open it on a laptop or desktop for the full experience.
          </p>
        </div>
      </div>
      <div className="hidden lg:block">{children}</div>
    </>
  );
}
