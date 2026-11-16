import "server-only";
import { db } from "~/server/db";
import { BannerKind, EventAudience } from "~/server/db/enums";
import { resolveStorageUrl } from "~/server/storage";
import {
  dateKey,
  eventWhen,
  hasEventsTab,
  isPdfUrl,
  istToday,
  istTodayDate,
} from "~/server/event-sharing";
import type { BannerSlide } from "~/lib/partner-banner";

// The rotating slides on the partner dashboard (16 Nov 2026).
//
//   EVENT slide  follows its event: shown while the event is published, not
//                yet past, and the partner is in its audience (and has the
//                Events tab). No wide image → the slide is built from the
//                event (poster thumbnail, name, date, place, Register).
//   INFO slide   every partner; a click opens a pop-up with `details`.
//   Both         is_active, and today (India) within display_from..display_to
//                when set. Expired slides simply stop matching.

export const ROTATE_KEY = "partner_banner.rotate_seconds";
export const ROTATE_DEFAULT = 6;
export const ROTATE_MIN = 3;
export const ROTATE_MAX = 30;

export async function rotateSeconds(): Promise<number> {
  const row = await db.system_config.findUnique({
    where: { config_key: ROTATE_KEY },
    select: { value: true },
  });
  const n = row ? Number(JSON.parse(row.value)) : NaN;
  return Number.isFinite(n)
    ? Math.min(ROTATE_MAX, Math.max(ROTATE_MIN, Math.round(n)))
    : ROTATE_DEFAULT;
}

export const bannerSelect = {
  id: true,
  kind: true,
  event_id: true,
  title: true,
  summary: true,
  details: true,
  link_url: true,
  link_label: true,
  image_url: true,
  display_from: true,
  display_to: true,
  sort_order: true,
  is_active: true,
  event: {
    select: {
      id: true,
      title: true,
      event_type: true,
      event_date: true,
      start_time: true,
      end_time: true,
      is_virtual: true,
      location: true,
      organizer: true,
      creative_url: true,
      registration_url: true,
      audience: true,
      is_active: true,
    },
  },
} as const;

type BannerRow = {
  id: number;
  kind: number;
  title: string | null;
  summary: string | null;
  details: string | null;
  link_url: string | null;
  link_label: string | null;
  image_url: string | null;
  event: {
    id: number;
    title: string;
    event_type: number;
    event_date: Date;
    start_time: Date | null;
    end_time: Date | null;
    is_virtual: number;
    location: string | null;
    organizer: string | null;
    creative_url: string | null;
    registration_url: string | null;
  } | null;
};

// One slide as the dashboard (and the admin preview) renders it.
export function toSlide(b: BannerRow): BannerSlide | null {
  const image = resolveStorageUrl(b.image_url);
  const ownTitle = b.title?.trim() ? b.title.trim() : null;
  if (b.kind === BannerKind.EVENT) {
    const e = b.event;
    if (!e) return null;
    const { date, time } = eventWhen(e);
    const poster =
      e.creative_url && !isPdfUrl(e.creative_url)
        ? resolveStorageUrl(e.creative_url)
        : null;
    return {
      id: b.id,
      kind: "event",
      title: ownTitle ?? e.title,
      summary: b.summary,
      imageUrl: image,
      event: {
        id: e.id,
        eventType: e.event_type,
        date,
        time,
        place: e.is_virtual === 1 ? "Online" : (e.location ?? null),
        organizer: e.organizer,
        posterUrl: poster,
        registrationUrl: e.registration_url,
      },
    };
  }
  return {
    id: b.id,
    kind: "info",
    title: ownTitle ?? "",
    summary: b.summary,
    imageUrl: image,
    details: b.details,
    linkUrl: b.link_url,
    linkLabel: b.link_label,
  };
}

// Where a slide stands today, for the admin list.
export function bannerStatus(b: {
  is_active: number;
  kind: number;
  display_from: Date | null;
  display_to: Date | null;
  event: { event_date: Date; is_active: number } | null;
}): "live" | "scheduled" | "expired" | "off" | "eventDraft" {
  const today = istToday();
  if (b.is_active !== 1) return "off";
  if (b.display_to && dateKey(b.display_to) < today) return "expired";
  if (b.kind === BannerKind.EVENT) {
    if (!b.event) return "expired";
    if (dateKey(b.event.event_date) < today) return "expired";
    if (b.event.is_active !== 1) return "eventDraft";
  }
  if (b.display_from && dateKey(b.display_from) > today) return "scheduled";
  return "live";
}

// The slides one partner user sees now, in order.
export async function slidesFor(user: {
  id: number;
  type: number;
}): Promise<BannerSlide[]> {
  const today = istTodayDate();
  const eventsOn = await hasEventsTab(user);
  const rows = await db.partner_banner.findMany({
    where: {
      is_active: 1,
      AND: [
        { OR: [{ display_from: null }, { display_from: { lte: today } }] },
        { OR: [{ display_to: null }, { display_to: { gte: today } }] },
        {
          OR: [
            { kind: BannerKind.INFO },
            ...(eventsOn
              ? [
                  {
                    kind: BannerKind.EVENT,
                    event: {
                      is_active: 1,
                      event_date: { gte: today },
                      OR: [
                        { audience: EventAudience.ALL },
                        { event_registration: { some: { user_id: user.id } } },
                      ],
                    },
                  },
                ]
              : []),
          ],
        },
      ],
    },
    orderBy: [{ sort_order: "asc" }, { id: "asc" }],
    select: bannerSelect,
  });
  return rows.map(toSlide).filter((s): s is BannerSlide => s !== null);
}
