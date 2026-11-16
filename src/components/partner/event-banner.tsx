"use client";

/* eslint-disable @next/next/no-img-element -- uploaded posters and banners are
   arbitrary public URLs (Spaces / local /uploads), not next/image sources. */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { EventTypeLabel } from "~/server/db/enums";
import {
  parseRichText,
  safeHref,
  type BannerSlide,
} from "~/lib/partner-banner";

// The partner dashboard banner (16 Nov 2026): managed slides that rotate on a
// preset interval. EVENT slides open the portal event page; INFO slides open
// a pop-up with the details. Auto-rotation pauses on hover and keyboard
// focus, while the tab is hidden, when paused with the button, and never
// runs under prefers-reduced-motion. The admin preview renders the same
// component with `preview` (links don't navigate).

type InfoSlide = Extract<BannerSlide, { kind: "info" }>;
type EventSlide = Extract<BannerSlide, { kind: "event" }>;

const typeLabel = (code: number) =>
  (EventTypeLabel as Record<number, string | undefined>)[code] ?? "Event";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

const FRAME = "relative block h-full w-full overflow-hidden text-left";

function SlideImage({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      className="h-full w-full object-cover"
      draggable={false}
    />
  );
}

// An event slide with no wide image: poster thumbnail left, details right.
function EventAutoSlide({ s }: { s: EventSlide }) {
  const e = s.event;
  return (
    <div className="flex h-full items-center gap-4 bg-gradient-to-r from-[#0B4EA2] via-[#1570EF] to-[#2E90FA] px-4 py-4 sm:gap-6 sm:px-8">
      <div className="flex aspect-[1/1.414] h-full max-h-[200px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/95 shadow-[0_8px_24px_rgba(0,0,0,0.25)]">
        {e.posterUrl ? (
          <img
            src={e.posterUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <svg
            viewBox="0 0 24 24"
            className="h-8 w-8 stroke-[#1570EF]"
            fill="none"
            strokeWidth={1.8}
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        )}
      </div>
      <div className="min-w-0 flex-1 text-white">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-wide uppercase opacity-90">
          <span className="rounded-full bg-white/20 px-2 py-0.5">
            {typeLabel(e.eventType)}
          </span>
          {e.organizer && <span className="truncate">{e.organizer}</span>}
        </div>
        <div className="line-clamp-2 text-[17px] leading-snug font-bold sm:text-[22px]">
          {s.title}
        </div>
        {s.summary && (
          <div className="mt-1 line-clamp-1 text-[13px] opacity-90">
            {s.summary}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] opacity-95 sm:text-[13px]">
          <span>{e.date}</span>
          {e.time && <span>{e.time}</span>}
          {e.place && <span>{e.place}</span>}
        </div>
        <span className="mt-3 inline-flex rounded-lg bg-white px-3.5 py-1.5 text-[13px] font-semibold text-[#1570EF] shadow-sm">
          Register →
        </span>
      </div>
    </div>
  );
}

function InfoAutoSlide({ s }: { s: InfoSlide }) {
  return (
    <div className="flex h-full flex-col justify-center bg-gradient-to-r from-[#EFF8FF] via-[#F5FAFF] to-[#F9FAFB] px-5 py-4 sm:px-8">
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-[#1570EF] uppercase">
        Announcement
      </div>
      <div className="line-clamp-2 text-[17px] leading-snug font-bold text-[#101828] sm:text-[22px]">
        {s.title}
      </div>
      {s.summary && (
        <div className="mt-1 line-clamp-2 text-[13px] text-[#475467]">
          {s.summary}
        </div>
      )}
      <span className="mt-3 inline-flex w-fit rounded-lg bg-[#1570EF] px-3.5 py-1.5 text-[13px] font-semibold text-white">
        Read more
      </span>
    </div>
  );
}

export function InfoModal({
  slide,
  onClose,
}: {
  slide: InfoSlide;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  // On open: focus Close, Escape closes; on close: focus returns to the slide.
  useEffect(() => {
    const returnTo = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeFn.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, []);
  const href = safeHref(slide.linkUrl);
  const blocks = parseRichText(slide.details);
  return (
    <div
      className="fixed inset-0 z-[260] flex items-center justify-center bg-[rgba(16,24,40,0.55)] p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[88vh] w-[560px] max-w-full overflow-y-auto rounded-xl bg-white shadow-[0_20px_60px_rgba(0,0,0,0.2)]"
      >
        {slide.imageUrl && (
          <div className="aspect-[4/1] w-full overflow-hidden rounded-t-xl bg-[#F2F4F7]">
            <img
              src={slide.imageUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          </div>
        )}
        <div className="flex items-start justify-between gap-3 px-6 pt-5">
          <h2 id={titleId} className="text-lg font-bold text-[#101828]">
            {slide.title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#E4E7EC] text-[#667085] hover:bg-[#F9FAFB]"
          >
            ✕
          </button>
        </div>
        <div className="space-y-3 px-6 pt-2 pb-6 text-[14px] leading-relaxed text-[#475467]">
          {slide.summary && (
            <p className="font-medium text-[#344054]">{slide.summary}</p>
          )}
          {blocks.map((b, i) =>
            "p" in b ? (
              <p key={i}>{b.p}</p>
            ) : (
              <ul key={i} className="list-disc space-y-1 pl-5">
                {b.list.map((li, j) => (
                  <li key={j}>{li}</li>
                ))}
              </ul>
            ),
          )}
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
            >
              {slide.linkLabel ?? "Learn more"} ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function SlideBody({
  s,
  preview,
  onInfo,
  tabIndex,
}: {
  s: BannerSlide;
  preview: boolean;
  onInfo: (s: InfoSlide) => void;
  tabIndex: number;
}) {
  if (s.kind === "event") {
    const label = `${s.title}, ${s.event.date}. Open the event page`;
    const inner: ReactNode = s.imageUrl ? (
      <SlideImage src={s.imageUrl} alt="" />
    ) : (
      <EventAutoSlide s={s} />
    );
    return preview ? (
      <div className={FRAME} aria-label={label}>
        {inner}
      </div>
    ) : (
      <Link
        href={`/partner/events/${s.event.id}`}
        className={FRAME}
        aria-label={label}
        tabIndex={tabIndex}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={`${FRAME} cursor-pointer`}
      aria-label={`${s.title}. Read more`}
      aria-haspopup="dialog"
      onClick={() => onInfo(s)}
      tabIndex={tabIndex}
    >
      {s.imageUrl ? (
        <SlideImage src={s.imageUrl} alt="" />
      ) : (
        <InfoAutoSlide s={s} />
      )}
    </button>
  );
}

const CTRL =
  "flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-[#344054] shadow-sm ring-1 ring-black/5 hover:bg-white focus-visible:outline-2 focus-visible:outline-[#1570EF]";

export function PartnerBannerCarousel({
  slides,
  rotateSeconds,
  preview = false,
  className = "",
}: {
  slides: BannerSlide[];
  rotateSeconds: number;
  preview?: boolean;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [info, setInfo] = useState<InfoSlide | null>(null);
  const reduced = useReducedMotion();
  const hidden = usePageHidden();
  const n = slides.length;
  const current = n > 0 ? index % n : 0;
  const go = useCallback((i: number) => setIndex(((i % n) + n) % n), [n]);

  const rotating =
    n > 1 &&
    !reduced &&
    !stopped &&
    !hovered &&
    !focused &&
    !hidden &&
    info === null;
  useEffect(() => {
    if (!rotating) return;
    const t = window.setTimeout(
      () => go(current + 1),
      Math.max(3, rotateSeconds) * 1000,
    );
    return () => window.clearTimeout(t);
  }, [rotating, current, rotateSeconds, go]);

  // Arrow keys on a focused slide: move focus along with it (the slide it
  // leaves becomes inert, which would otherwise drop focus to the page).
  const trackRef = useRef<HTMLDivElement>(null);
  const followFocus = useRef(false);
  useEffect(() => {
    if (!followFocus.current) return;
    followFocus.current = false;
    trackRef.current?.children[current]
      ?.querySelector<HTMLElement>("a, button")
      ?.focus();
  }, [current]);

  if (n === 0) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (n < 2 || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    e.preventDefault();
    followFocus.current = !!trackRef.current?.contains(document.activeElement);
    go(current + (e.key === "ArrowRight" ? 1 : -1));
  };

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Announcements"
      className={`group relative overflow-hidden rounded-xl border border-[#E4E7EC] bg-[#F9FAFB] ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setFocused(false);
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className="relative aspect-[4/1] max-h-[280px] min-h-[168px] w-full"
        aria-live={rotating ? "off" : "polite"}
      >
        <div
          ref={trackRef}
          className={`flex h-full ${reduced ? "" : "transition-transform duration-500 ease-out"}`}
          style={{ transform: `translateX(-${current * 100}%)` }}
        >
          {slides.map((s, i) => (
            <div
              key={s.id}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${n}: ${s.title}`}
              aria-hidden={i !== current}
              inert={i !== current}
              className="h-full w-full shrink-0"
            >
              <SlideBody
                s={s}
                preview={preview}
                onInfo={setInfo}
                tabIndex={i === current ? 0 : -1}
              />
            </div>
          ))}
        </div>
      </div>

      {n > 1 && (
        <>
          <div className="absolute top-1/2 left-2 -translate-y-1/2 opacity-80 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              className={CTRL}
              onClick={() => go(current - 1)}
              aria-label="Previous slide"
            >
              ‹
            </button>
          </div>
          <div className="absolute top-1/2 right-2 -translate-y-1/2 opacity-80 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              className={CTRL}
              onClick={() => go(current + 1)}
              aria-label="Next slide"
            >
              ›
            </button>
          </div>
          <div className="absolute right-0 bottom-2 left-0 flex items-center justify-center gap-1.5">
            {slides.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => go(i)}
                aria-label={`Go to slide ${i + 1}: ${s.title}`}
                aria-current={i === current ? "true" : undefined}
                className={`h-2 rounded-full shadow-sm ring-1 ring-black/10 transition-all ${
                  i === current
                    ? "w-5 bg-white"
                    : "w-2 bg-white/60 hover:bg-white/90"
                }`}
              />
            ))}
            {!reduced && (
              <button
                type="button"
                onClick={() => setStopped((v) => !v)}
                aria-label={stopped ? "Resume rotation" : "Pause rotation"}
                className="ml-2 flex h-5 w-5 items-center justify-center rounded-full bg-white/80 text-[9px] text-[#344054] shadow-sm ring-1 ring-black/10 hover:bg-white"
              >
                {stopped ? "▶" : "❚❚"}
              </button>
            )}
          </div>
        </>
      )}

      {info && <InfoModal slide={info} onClose={() => setInfo(null)} />}
    </section>
  );
}
