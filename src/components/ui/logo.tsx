// The Collegepond logo (white, for the blue brand panels). The artwork is
// public/brand/collegepond-logo-white.png (400x72), cut from the official
// logo; collegepond-mark-white.png is the cap mark on its own.
export const BRAND_LOGO_WHITE = "/brand/collegepond-logo-white.png";
export const BRAND_MARK_WHITE = "/brand/collegepond-mark-white.png";

export function Logo({ className = "", height = 32 }: { className?: string; height?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={BRAND_LOGO_WHITE}
      alt="Collegepond"
      width={Math.round((height * 400) / 72)}
      height={height}
      className={`block select-none ${className}`}
      draggable={false}
    />
  );
}
