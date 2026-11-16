"use client";

/* eslint-disable @next/next/no-img-element -- uploaded banner thumbnails */

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { MediaUpload } from "~/components/events/media-upload";
import { PartnerBannerCarousel } from "~/components/partner/event-banner";
import { BANNER_IMAGE_HINT, type BannerSlide } from "~/lib/partner-banner";

// Events → Dashboard banners: the rotating slides on the partner dashboard
// (16 Nov 2026). Anyone with the Events tab manages them; the procedures are
// gated by the same tab (events.* in API_SECTIONS).

type EventRow = RouterOutputs["events"]["list"][number];
type SlideRow = RouterOutputs["events"]["bannerList"]["slides"][number];

const STATUS: Record<
  SlideRow["status"],
  { label: string; cls: string; hint: string }
> = {
  live: {
    label: "Live",
    cls: "bg-[#ECFDF3] text-[#067647]",
    hint: "Showing to partners now",
  },
  scheduled: {
    label: "Scheduled",
    cls: "bg-[#EFF8FF] text-[#175CD3]",
    hint: "Starts on its Show from date",
  },
  expired: {
    label: "Expired",
    cls: "bg-[#F2F4F7] text-[#667085]",
    hint: "Past its end date or the event date",
  },
  off: {
    label: "Off",
    cls: "bg-[#F2F4F7] text-[#667085]",
    hint: "Switched off",
  },
  eventDraft: {
    label: "Event is a draft",
    cls: "bg-[#FFFAEB] text-[#B54708]",
    hint: "Shows once the event is published",
  },
};

const pad = (n: number) => String(n).padStart(2, "0");
const nn = (s: string): string | null => (s.trim() === "" ? null : s.trim());

function prettyDate(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
function time12(t: string): string {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h >= 12 ? "PM" : "AM"}`;
}
const isPdf = (s: string | null) => !!s && /\.pdf(\?|#|$)/i.test(s);

const label = "mb-1.5 block text-[13px] font-semibold text-[#344054]";
const input =
  "w-full rounded-lg border border-[#D0D5DD] px-3 py-2.5 text-[13px] text-[#344054] outline-none focus:border-[#1570EF]";

function SlideModal({
  slide,
  events,
  onClose,
}: {
  slide: SlideRow | null;
  events: EventRow[];
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const [f, setF] = useState(() => ({
    kind: slide?.kind ?? ("event" as "event" | "info"),
    eventId: slide?.eventId ?? null,
    title: slide?.title ?? "",
    summary: slide?.summary ?? "",
    details: slide?.details ?? "",
    linkUrl: slide?.linkUrl ?? "",
    linkLabel: slide?.linkLabel ?? "",
    imageRef: slide?.imageRef ?? null,
    imagePreview: slide?.imageUrl ?? null,
    displayFrom: slide?.displayFrom ?? "",
    displayTo: slide?.displayTo ?? "",
    sortOrder: String(slide?.sortOrder ?? 0),
    isActive: slide?.isActive ?? true,
  }));
  const [err, setErr] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) =>
    setF((s) => ({ ...s, [k]: v }));
  const save = api.events.bannerSave.useMutation({
    onSuccess: () => {
      void utils.events.bannerList.invalidate();
      void utils.events.list.invalidate();
      onClose();
    },
    onError: (e) => setErr(e.message),
  });

  // Upcoming events (and this slide's own event, even if past).
  const today = new Date().toISOString().slice(0, 10);
  const pickable = events
    .filter((e) => e.eventDate >= today || e.id === f.eventId)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const ev = events.find((e) => e.id === f.eventId) ?? null;

  const preview: BannerSlide | null =
    f.kind === "event"
      ? ev
        ? {
            id: 0,
            kind: "event",
            title: nn(f.title) ?? ev.title,
            summary: nn(f.summary),
            imageUrl: f.imagePreview,
            event: {
              id: ev.id,
              eventType: ev.eventType,
              date: prettyDate(ev.eventDate),
              time: ev.startTime
                ? `${time12(ev.startTime)}${ev.endTime ? ` – ${time12(ev.endTime)}` : ""} IST`
                : null,
              place: ev.isVirtual ? "Online" : ev.location,
              organizer: ev.organizer,
              posterUrl:
                ev.creativeUrl && !ev.creativeIsPdf ? ev.creativeUrl : null,
              registrationUrl: ev.registrationUrl,
            },
          }
        : null
      : nn(f.title)
        ? {
            id: 0,
            kind: "info",
            title: f.title.trim(),
            summary: nn(f.summary),
            imageUrl: f.imagePreview,
            details: nn(f.details),
            linkUrl: nn(f.linkUrl),
            linkLabel: nn(f.linkLabel),
          }
        : null;

  function submit() {
    if (f.kind === "event" && !f.eventId)
      return setErr("Pick the event this slide is for.");
    if (f.kind === "info" && f.title.trim() === "")
      return setErr("An information slide needs a title.");
    const link = nn(f.linkUrl);
    if (f.kind === "info" && link && !/^https?:\/\/\S+\.\S+/i.test(link)) {
      return setErr("The link must be a full link starting with https://");
    }
    if (f.displayFrom && f.displayTo && f.displayTo < f.displayFrom) {
      return setErr("“Show until” is before “Show from”.");
    }
    setErr("");
    save.mutate({
      id: slide?.id,
      kind: f.kind,
      eventId: f.kind === "event" ? f.eventId : null,
      title: nn(f.title),
      summary: nn(f.summary),
      details: f.kind === "info" ? nn(f.details) : null,
      linkUrl: f.kind === "info" ? link : null,
      linkLabel: f.kind === "info" ? nn(f.linkLabel) : null,
      imageUrl: f.imageRef,
      displayFrom: nn(f.displayFrom),
      displayTo: nn(f.displayTo),
      sortOrder: Number.isFinite(Number(f.sortOrder))
        ? Math.round(Number(f.sortOrder))
        : 0,
      isActive: f.isActive,
    });
  }

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center bg-[rgba(16,24,40,0.55)] p-4">
      <div className="max-h-[92vh] w-[720px] max-w-full overflow-y-auto rounded-xl bg-white shadow-[0_20px_60px_rgba(0,0,0,0.2)]">
        <div className="flex items-center justify-between border-b border-[#E4E7EC] px-6 py-5">
          <h3 className="text-base font-bold text-[#101828]">
            {slide ? "Edit slide" : "Add slide"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E4E7EC] text-[#667085] hover:bg-[#F9FAFB]"
          >
            ✕
          </button>
        </div>
        <div className="space-y-3.5 px-6 py-5">
          <div>
            <span className={label}>Slide type</span>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  {
                    v: "event",
                    t: "Event",
                    d: "Opens the event page (RSVP, Register)",
                  },
                  {
                    v: "info",
                    t: "Information",
                    d: "Opens a pop-up with the details",
                  },
                ] as const
              ).map((o) => (
                <label
                  key={o.v}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[13px] ${
                    f.kind === o.v
                      ? "border-[#1570EF] bg-[#EFF8FF]"
                      : "border-[#D0D5DD]"
                  }`}
                >
                  <input
                    type="radio"
                    name="slide-kind"
                    className="mt-1"
                    checked={f.kind === o.v}
                    onChange={() => set("kind", o.v)}
                  />
                  <span>
                    <span className="block font-semibold text-[#101828]">
                      {o.t}
                    </span>
                    <span className="block text-[11px] text-[#667085]">
                      {o.d}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {f.kind === "event" && (
            <div>
              <label className={label} htmlFor="slide-event">
                Event
              </label>
              <select
                id="slide-event"
                className={input}
                value={f.eventId ?? ""}
                onChange={(e) =>
                  set("eventId", e.target.value ? Number(e.target.value) : null)
                }
              >
                <option value="">Choose an event…</option>
                {pickable.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title} · {prettyDate(e.eventDate)}
                    {e.isActive ? "" : " (draft)"}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-[#98A2B3]">
                Shown to the event&apos;s audience while it&apos;s published,
                until the event date.
              </span>
            </div>
          )}

          <div>
            <label className={label} htmlFor="slide-title">
              Title{" "}
              {f.kind === "event" && (
                <span className="font-normal text-[#98A2B3]">
                  (optional, defaults to the event name)
                </span>
              )}
            </label>
            <input
              id="slide-title"
              className={input}
              maxLength={150}
              value={f.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder={
                f.kind === "event"
                  ? (ev?.title ?? "")
                  : "e.g. New scholarships for Jan 2027"
              }
            />
          </div>
          <div>
            <label className={label} htmlFor="slide-summary">
              Short text{" "}
              <span className="font-normal text-[#98A2B3]">
                (optional, one line)
              </span>
            </label>
            <input
              id="slide-summary"
              className={input}
              maxLength={300}
              value={f.summary}
              onChange={(e) => set("summary", e.target.value)}
            />
          </div>

          <MediaUpload
            label="Wide image (optional)"
            hint={`${BANNER_IMAGE_HINT}. Keep text away from the edges: narrow screens crop the sides.${
              f.kind === "event"
                ? " Without one, the slide is built from the event and its poster."
                : ""
            }`}
            folder="partner-banners"
            wide
            value={f.imageRef}
            previewUrl={f.imagePreview}
            onChange={(ref, pv) =>
              setF((s) => ({ ...s, imageRef: ref, imagePreview: pv }))
            }
          />

          {f.kind === "info" && (
            <>
              <div>
                <label className={label} htmlFor="slide-details">
                  Pop-up details
                </label>
                <textarea
                  id="slide-details"
                  className={`${input} min-h-[120px] resize-y`}
                  value={f.details}
                  onChange={(e) => set("details", e.target.value)}
                  placeholder={
                    "A paragraph of text.\n\n- A bullet point\n- Another bullet point"
                  }
                />
                <span className="mt-1 block text-[11px] text-[#98A2B3]">
                  A blank line starts a new paragraph; lines starting with “- ”
                  are bullets.
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
                <div>
                  <label className={label} htmlFor="slide-link">
                    Link (optional)
                  </label>
                  <input
                    id="slide-link"
                    className={input}
                    value={f.linkUrl}
                    onChange={(e) => set("linkUrl", e.target.value)}
                    placeholder="https://…"
                  />
                </div>
                <div>
                  <label className={label} htmlFor="slide-link-label">
                    Button text
                  </label>
                  <input
                    id="slide-link-label"
                    className={input}
                    maxLength={60}
                    value={f.linkLabel}
                    onChange={(e) => set("linkLabel", e.target.value)}
                    placeholder="Learn more"
                  />
                </div>
              </div>
            </>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className={label} htmlFor="slide-from">
                Show from
              </label>
              <input
                id="slide-from"
                type="date"
                className={input}
                value={f.displayFrom}
                onChange={(e) => set("displayFrom", e.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="slide-to">
                Show until
              </label>
              <input
                id="slide-to"
                type="date"
                className={input}
                value={f.displayTo}
                onChange={(e) => set("displayTo", e.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="slide-order">
                Order
              </label>
              <input
                id="slide-order"
                type="number"
                className={input}
                value={f.sortOrder}
                onChange={(e) => set("sortOrder", e.target.value)}
              />
            </div>
            <div>
              <span className={label}>Active</span>
              <label className="flex h-[42px] items-center gap-2 text-[13px] text-[#344054]">
                <input
                  type="checkbox"
                  checked={f.isActive}
                  onChange={(e) => set("isActive", e.target.checked)}
                />
                Show
              </label>
            </div>
          </div>
          <p className="text-[11px] text-[#98A2B3]">
            Dates are optional. Lower order shows first. Slides drop off by
            themselves after “Show until”
            {f.kind === "event" ? " or the event date" : ""}.
          </p>

          {preview && (
            <div>
              <span className={label}>Preview</span>
              <PartnerBannerCarousel
                slides={[preview]}
                rotateSeconds={6}
                preview
              />
            </div>
          )}
          {err !== "" && <p className="text-[12px] text-[#F04438]">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-[#E4E7EC] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#D0D5DD] bg-white px-[18px] py-2.5 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={save.isPending}
            onClick={submit}
            className="rounded-lg bg-[#1570EF] px-[18px] py-2.5 text-[13px] font-semibold text-white hover:bg-[#1260d4] disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : slide ? "Save slide" : "Add slide"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RotationSetting({ seconds }: { seconds: number }) {
  const utils = api.useUtils();
  const [v, setV] = useState(String(seconds));
  const [msg, setMsg] = useState("");
  const save = api.events.bannerSetRotation.useMutation({
    onSuccess: (r) => {
      setMsg(`Saved: ${r.seconds} s`);
      void utils.events.bannerList.invalidate();
    },
    onError: (e) => setMsg(e.message),
  });
  const n = Number(v);
  const ok = Number.isInteger(n) && n >= 3 && n <= 30;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#344054]">
      <label htmlFor="rotate-seconds" className="font-semibold">
        Rotate every
      </label>
      <input
        id="rotate-seconds"
        type="number"
        min={3}
        max={30}
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          setMsg("");
        }}
        className="h-[34px] w-16 rounded-lg border border-[#D0D5DD] px-2 text-[13px] outline-none focus:border-[#1570EF]"
      />
      <span>seconds</span>
      <button
        type="button"
        disabled={!ok || n === seconds || save.isPending}
        onClick={() => save.mutate({ seconds: n })}
        className="h-[34px] rounded-lg border border-[#D0D5DD] bg-white px-3 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB] disabled:opacity-50"
      >
        Save
      </button>
      <span className="text-[11px] text-[#98A2B3]">
        {msg || "3–30 s. Pauses on hover."}
      </span>
    </div>
  );
}

export function BannersPanel({ events }: { events: EventRow[] }) {
  const q = api.events.bannerList.useQuery();
  const utils = api.useUtils();
  const del = api.events.bannerDelete.useMutation({
    onSuccess: () => {
      void utils.events.bannerList.invalidate();
      void utils.events.list.invalidate();
    },
  });
  const [modal, setModal] = useState<{ slide: SlideRow | null } | null>(null);
  const slides = q.data?.slides ?? [];
  const live = slides
    .filter((s) => s.status === "live")
    .map((s) => s.preview)
    .filter((s): s is BannerSlide => s !== null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E4E7EC] bg-white p-4">
        <div>
          <h2 className="text-[15px] font-bold text-[#101828]">
            Partner dashboard banner
          </h2>
          <p className="mt-0.5 text-[12px] text-[#667085]">
            Slides rotate at the top of every partner&apos;s dashboard. Event
            slides go to the event&apos;s audience; information slides to every
            partner.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {q.data && (
            <RotationSetting
              key={q.data.rotateSeconds}
              seconds={q.data.rotateSeconds}
            />
          )}
          <button
            type="button"
            onClick={() => setModal({ slide: null })}
            className="flex h-9 items-center gap-2 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
          >
            + Add slide
          </button>
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
          Live now · {live.length} slide{live.length === 1 ? "" : "s"} (each
          partner sees the ones meant for them)
        </div>
        {live.length > 0 ? (
          <PartnerBannerCarousel
            slides={live}
            rotateSeconds={q.data?.rotateSeconds ?? 6}
            preview
          />
        ) : (
          <div className="rounded-xl border border-dashed border-[#D0D5DD] bg-[#F9FAFB] p-6 text-center text-[13px] text-[#667085]">
            No live slides. Partners see no banner until one is added.
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
        {slides.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-[#667085]">
            {q.isLoading
              ? "Loading…"
              : "No slides yet. Add one, or tick “Show on partner dashboard” on an event."}
          </p>
        ) : (
          <ul className="divide-y divide-[#F2F4F7]">
            {slides.map((s) => {
              const st = STATUS[s.status];
              const thumb =
                s.imageUrl ??
                (s.kind === "event"
                  ? events.find(
                      (e) =>
                        e.id === s.eventId &&
                        e.creativeUrl &&
                        !isPdf(e.creativeRef),
                    )?.creativeUrl
                  : null);
              return (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-4 px-4 py-3"
                >
                  <div
                    className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[#E4E7EC] bg-[#F9FAFB] ${
                      s.imageUrl ? "aspect-[4/1] w-32" : "h-[46px] w-32"
                    }`}
                  >
                    {thumb ? (
                      <img
                        src={thumb}
                        alt=""
                        className={`h-full w-full ${s.imageUrl ? "object-cover" : "object-contain"}`}
                      />
                    ) : (
                      <span className="text-[10px] text-[#98A2B3]">
                        Auto slide
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14px] font-semibold text-[#101828]">
                        {s.title ?? s.eventTitle ?? "Untitled"}
                      </span>
                      <span
                        className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${
                          s.kind === "event"
                            ? "bg-[#EFF8FF] text-[#175CD3]"
                            : "bg-[#FDF2FA] text-[#C11574]"
                        }`}
                      >
                        {s.kind === "event" ? "Event" : "Information"}
                      </span>
                      <span
                        title={st.hint}
                        className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}
                      >
                        {st.label}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-[#667085]">
                      {s.kind === "event" && s.eventDate
                        ? `Event ${prettyDate(s.eventDate)} · `
                        : ""}
                      {s.displayFrom || s.displayTo
                        ? `Shown ${s.displayFrom ? prettyDate(s.displayFrom) : "now"} → ${
                            s.displayTo
                              ? prettyDate(s.displayTo)
                              : s.kind === "event"
                                ? "event date"
                                : "no end"
                          }`
                        : s.kind === "event"
                          ? "Shown until the event date"
                          : "No end date"}
                      {` · Order ${s.sortOrder}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => setModal({ slide: s })}
                      className="rounded-md border border-[#D0D5DD] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-[#344054] hover:bg-[#F9FAFB]"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={del.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Delete this slide? Partners stop seeing it straight away.",
                          )
                        ) {
                          del.mutate({ id: s.id });
                        }
                      }}
                      className="rounded-md border border-[#FECDCA] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-[#B42318] hover:bg-[#FEF3F2]"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {modal && (
        <SlideModal
          slide={modal.slide}
          events={events}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
