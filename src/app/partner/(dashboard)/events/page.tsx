"use client";

import { useState } from "react";
import Link from "next/link";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  EventType,
  EventTypeLabel,
  EventRegistrationStatus,
  EventRegistrationStatusLabel,
} from "~/server/db/enums";
import { formatDate } from "~/components/dashboard/format";
import { StatCard, EmptyState, Icon, Skeleton } from "~/components/dashboard/widgets";
import { Stagger, FadeUp } from "~/components/dashboard/motion";

type EventRow = RouterOutputs["events"]["forPartners"][number];

const TYPE_BADGE: Record<number, string> = {
  [EventType.UNIVERSITY_FAIR]: "bg-[#EFF8FF] text-[#175CD3]",
  [EventType.WEBINAR]: "bg-[#F0FDF4] text-[#067647]",
  [EventType.WORKSHOP]: "bg-[#FFFAEB] text-[#B54708]",
  [EventType.INFO_SESSION]: "bg-[#FDF2FA] text-[#C11574]",
  [EventType.PARTNER_MEET]: "bg-[#F0F0FF] text-[#5925DC]",
  [EventType.OTHER]: "bg-[#F2F4F7] text-[#344054]",
};
const RSVP_BADGE: Record<number, string> = {
  0: "bg-[#FFF6ED] text-[#B93815]",
  1: "bg-[#ECFDF3] text-[#027A48]",
  2: "bg-[#FEF3F2] text-[#B42318]",
  3: "bg-[#EFF8FF] text-[#175CD3]",
};

const pad = (n: number) => String(n).padStart(2, "0");
function typeLabel(code: number): string {
  return (EventTypeLabel as Record<number, string | undefined>)[code] ?? "Other";
}
function formatTime(hhmm: string | null): string {
  if (!hhmm) return "";
  const parts = hhmm.split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1] ?? 0);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ap}`;
}
function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

function EventCard({
  e,
  isUpcoming,
  onRsvp,
  busy,
}: {
  e: EventRow;
  isUpcoming: boolean;
  onRsvp: (status: "accepted" | "declined") => void;
  busy: boolean;
}) {
  const accepted =
    e.rsvpStatus === EventRegistrationStatus.ACCEPTED ||
    e.rsvpStatus === EventRegistrationStatus.ATTENDED;
  const declined = e.rsvpStatus === EventRegistrationStatus.DECLINED;
  return (
    <div className="mb-3 flex gap-4 rounded-xl border border-[#E4E7EC] bg-white p-5">
      {e.creativeUrl && (
        <Link
          href={`/partner/events/${e.id}`}
          className="flex aspect-[1/1.414] w-20 shrink-0 self-start items-center justify-center overflow-hidden rounded-md border border-[#E4E7EC] bg-[#F9FAFB]"
          aria-hidden
          tabIndex={-1}
        >
          {e.creativeIsPdf ? (
            <span className="text-[11px] font-semibold text-[#B42318]">PDF</span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={e.creativeUrl} alt="" className="h-full w-full object-cover" />
          )}
        </Link>
      )}
      <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-bold text-[#101828]">
          <Link href={`/partner/events/${e.id}`} className="hover:text-[#1570EF] hover:underline">
            {e.title}
          </Link>
        </h3>
        <span
          className={`rounded-[10px] px-2 py-0.5 text-[11px] font-semibold ${TYPE_BADGE[e.eventType] ?? TYPE_BADGE[EventType.OTHER]}`}
        >
          {typeLabel(e.eventType)}
        </span>
        {e.rsvpStatus != null && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${RSVP_BADGE[e.rsvpStatus] ?? RSVP_BADGE[0]}`}
          >
            {(EventRegistrationStatusLabel as Record<number, string | undefined>)[
              e.rsvpStatus
            ] ?? "Invited"}
          </span>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-4 text-[12px] text-[#475467]">
        <span className="flex items-center gap-1.5">
          <Icon name="calendar" size={13} /> {formatDate(e.eventDate)}
        </span>
        {(e.startTime ?? e.endTime) && (
          <span className="flex items-center gap-1.5">
            <Icon name="clock" size={13} /> {formatTime(e.startTime)}
            {e.endTime ? ` – ${formatTime(e.endTime)}` : ""}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Icon name="globe" size={13} /> {e.isVirtual ? "Online" : (e.location ?? "—")}
        </span>
        {e.organizer && (
          <span className="flex items-center gap-1.5">
            <Icon name="university" size={13} /> {e.organizer}
          </span>
        )}
      </div>
      {e.description && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-[#475467]">
          {e.description}
        </p>
      )}
      {e.agenda && (
        <p className="mt-2 text-[12px] whitespace-pre-line text-[#667085]">
          <span className="font-semibold text-[#344054]">Agenda: </span>
          {e.agenda}
        </p>
      )}
      {isUpcoming && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#F2F4F7] pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onRsvp("accepted")}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50 ${
              accepted
                ? "bg-[#12B76A] text-white"
                : "border border-[#D0D5DD] bg-white text-[#344054] hover:bg-[#F9FAFB]"
            }`}
          >
            {accepted ? "Going ✓" : "Accept"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRsvp("declined")}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50 ${
              declined
                ? "bg-[#F04438] text-white"
                : "border border-[#D0D5DD] bg-white text-[#344054] hover:bg-[#F9FAFB]"
            }`}
          >
            {declined ? "Declined" : "Decline"}
          </button>
          <Link
            href={`/partner/events/${e.id}`}
            className="rounded-lg px-2 py-1.5 text-[12px] font-semibold text-[#1570EF] hover:underline"
          >
            Details
          </Link>
          {e.registrationUrl && (
            <a
              href={e.registrationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-[#1570EF] px-3 py-1.5 text-[12px] font-semibold text-[#1570EF] hover:bg-[#EFF8FF]"
            >
              Register students ↗
            </a>
          )}
          {e.isVirtual && e.meetingUrl && accepted && (
            <a
              href={e.meetingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto rounded-lg bg-[#1570EF] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#1260d4]"
            >
              Join Online
            </a>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

export default function PartnerEventsPage() {
  const { data, isLoading } = api.events.forPartners.useQuery();
  const utils = api.useUtils();
  const rsvp = api.events.rsvp.useMutation({
    onSuccess: () => void utils.events.forPartners.invalidate(),
  });
  const [tab, setTab] = useState<"upcoming" | "past">("upcoming");

  const rows = data ?? [];
  const today = todayStr();
  const upcoming = rows
    .filter((e) => e.eventDate >= today)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const past = rows
    .filter((e) => e.eventDate < today)
    .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  const thisMonth = upcoming.filter((e) => e.eventDate.startsWith(today.slice(0, 7)));
  const list = tab === "upcoming" ? upcoming : past;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#101828]">Events</h1>
        <p className="mt-1 text-sm text-[#667085]">
          Webinars, university fairs, and partner meetups from Collegepond.
        </p>
      </div>

      <Stagger className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FadeUp className="h-full">
          <StatCard icon="calendar" tone="blue" value={upcoming.length} label="Upcoming Events" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="calendar" tone="purple" value={thisMonth.length} label="This Month" />
        </FadeUp>
        <FadeUp className="h-full">
          <StatCard icon="clock" tone="cyan" value={past.length} label="Past Events" />
        </FadeUp>
      </Stagger>

      <div className="mb-5 flex gap-1 border-b border-[#E4E7EC]">
        {(
          [
            { key: "upcoming", label: "Upcoming Events", count: upcoming.length },
            { key: "past", label: "Past Events", count: past.length },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-5 py-2.5 text-sm font-semibold transition-colors ${
              tab === t.key
                ? "border-[#1570EF] text-[#1570EF]"
                : "border-transparent text-[#667085] hover:text-[#1570EF]"
            }`}
          >
            {t.label}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                tab === t.key ? "bg-[#EFF8FF] text-[#1570EF]" : "bg-[#F2F4F7] text-[#344054]"
              }`}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          label={tab === "upcoming" ? "No upcoming events right now." : "No past events."}
        />
      ) : (
        list.map((e) => (
          <EventCard
            key={e.id}
            e={e}
            isUpcoming={tab === "upcoming"}
            busy={rsvp.isPending}
            onRsvp={(status) => rsvp.mutate({ eventId: e.id, status })}
          />
        ))
      )}
    </>
  );
}
