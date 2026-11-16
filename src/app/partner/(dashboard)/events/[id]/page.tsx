"use client";

/* eslint-disable @next/next/no-img-element -- the uploaded poster */

import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { EventRegistrationStatus, EventTypeLabel } from "~/server/db/enums";
import { formatDate } from "~/components/dashboard/format";
import { Icon, Skeleton } from "~/components/dashboard/widgets";
import { safeHref } from "~/lib/partner-banner";

// One event in the partner portal (16 Nov 2026): the creative, the details,
// RSVP, and the university's own registration form when there is one. The
// dashboard banner, the announcement email and the bell all link here.

const pad = (n: number) => String(n).padStart(2, "0");
function formatTime(hhmm: string | null): string {
  if (!hhmm) return "";
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h >= 12 ? "PM" : "AM"}`;
}
function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

export default function PartnerEventPage() {
  const params = useParams<{ id: string }>();
  const eventId = Number(params.id);
  const valid = Number.isInteger(eventId) && eventId > 0;
  const q = api.events.partnerGet.useQuery(
    { id: eventId },
    { enabled: valid, retry: false },
  );
  const utils = api.useUtils();
  const rsvp = api.events.rsvp.useMutation({
    onSuccess: () => {
      void utils.events.partnerGet.invalidate({ id: eventId });
      void utils.events.forPartners.invalidate();
    },
  });

  const back = (
    <Link
      href="/partner/events"
      className="mb-4 inline-flex items-center gap-1 text-[13px] font-semibold text-[#1570EF] hover:underline"
    >
      ← All events
    </Link>
  );

  if (!valid || q.error) {
    return (
      <>
        {back}
        <div className="rounded-xl border border-dashed border-[#D0D5DD] bg-[#F9FAFB] p-8 text-center">
          <h1 className="mb-1 text-lg font-semibold text-[#344054]">
            Event not available
          </h1>
          <p className="text-[13px] text-[#667085]">
            It may have been removed, or it isn&apos;t open to your account.
          </p>
        </div>
      </>
    );
  }
  if (q.isLoading || !q.data) {
    return (
      <>
        {back}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
          <Skeleton className="aspect-[1/1.414] w-full" />
          <Skeleton className="h-72" />
        </div>
      </>
    );
  }

  const e = q.data;
  const upcoming = e.eventDate >= todayStr();
  const accepted =
    e.rsvpStatus === EventRegistrationStatus.ACCEPTED ||
    e.rsvpStatus === EventRegistrationStatus.ATTENDED;
  const declined = e.rsvpStatus === EventRegistrationStatus.DECLINED;
  const register = safeHref(e.registrationUrl);
  const meeting = safeHref(e.meetingUrl);
  const typeLabel =
    (EventTypeLabel as Record<number, string | undefined>)[e.eventType] ??
    "Event";

  return (
    <>
      {back}
      <div
        className={`grid grid-cols-1 gap-6 ${e.creativeUrl ? "lg:grid-cols-[minmax(260px,360px)_1fr]" : ""}`}
      >
        {e.creativeUrl && (
          <div>
            {e.creativeIsPdf ? (
              <a
                href={e.creativeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex aspect-[1/1.414] w-full flex-col items-center justify-center gap-2 rounded-xl border border-[#E4E7EC] bg-[#F9FAFB] text-[#B42318] hover:border-[#1570EF]"
              >
                <span className="text-[28px]">PDF</span>
                <span className="text-[13px] font-semibold">
                  Open the event poster ↗
                </span>
              </a>
            ) : (
              <a
                href={e.creativeUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the full-size poster"
              >
                <img
                  src={e.creativeUrl}
                  alt={`${e.title} poster`}
                  className="w-full rounded-xl border border-[#E4E7EC] bg-white shadow-sm"
                />
              </a>
            )}
          </div>
        )}

        <div className="rounded-xl border border-[#E4E7EC] bg-white p-6">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-[10px] bg-[#EFF8FF] px-2 py-0.5 text-[11px] font-semibold text-[#175CD3]">
              {typeLabel}
            </span>
            {!upcoming && (
              <span className="rounded-[10px] bg-[#F2F4F7] px-2 py-0.5 text-[11px] font-semibold text-[#667085]">
                Past event
              </span>
            )}
          </div>
          <h1 className="text-2xl font-bold text-[#101828]">{e.title}</h1>

          <dl className="mt-4 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
            <div className="flex items-start gap-2">
              <Icon name="calendar" size={16} />
              <div>
                <dt className="text-[11px] font-semibold tracking-wide text-[#98A2B3] uppercase">
                  Date
                </dt>
                <dd className="text-[#101828]">{formatDate(e.eventDate)}</dd>
              </div>
            </div>
            {e.startTime && (
              <div className="flex items-start gap-2">
                <Icon name="clock" size={16} />
                <div>
                  <dt className="text-[11px] font-semibold tracking-wide text-[#98A2B3] uppercase">
                    Time (IST)
                  </dt>
                  <dd className="text-[#101828]">
                    {formatTime(e.startTime)}
                    {e.endTime ? ` – ${formatTime(e.endTime)}` : ""}
                  </dd>
                </div>
              </div>
            )}
            <div className="flex items-start gap-2">
              <Icon name="globe" size={16} />
              <div>
                <dt className="text-[11px] font-semibold tracking-wide text-[#98A2B3] uppercase">
                  Where
                </dt>
                <dd className="text-[#101828]">
                  {e.isVirtual ? "Online" : (e.location ?? "To be announced")}
                </dd>
              </div>
            </div>
            {e.organizer && (
              <div className="flex items-start gap-2">
                <Icon name="university" size={16} />
                <div>
                  <dt className="text-[11px] font-semibold tracking-wide text-[#98A2B3] uppercase">
                    Organiser
                  </dt>
                  <dd className="text-[#101828]">{e.organizer}</dd>
                </div>
              </div>
            )}
          </dl>

          {e.description && (
            <p className="mt-5 text-[14px] leading-relaxed text-[#475467]">
              {e.description}
            </p>
          )}
          {e.agenda && (
            <div className="mt-4">
              <h2 className="mb-1 text-[13px] font-semibold text-[#344054]">
                Agenda
              </h2>
              <p className="text-[13px] whitespace-pre-line text-[#475467]">
                {e.agenda}
              </p>
            </div>
          )}

          {register && upcoming && (
            <div className="mt-6 rounded-lg border border-[#B2DDFF] bg-[#EFF8FF] p-4">
              <p className="mb-2 text-[13px] text-[#175CD3]">
                Register your students on the university&apos;s own form.
              </p>
              <a
                href={register}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
              >
                Register students ↗
              </a>
            </div>
          )}

          {upcoming && (
            <div className="mt-6 border-t border-[#F2F4F7] pt-4">
              <div className="mb-2 text-[13px] font-semibold text-[#344054]">
                Will you attend?
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={rsvp.isPending}
                  aria-pressed={accepted}
                  onClick={() =>
                    rsvp.mutate({ eventId: e.id, status: "accepted" })
                  }
                  className={`rounded-lg px-4 py-2 text-[13px] font-semibold disabled:opacity-50 ${
                    accepted
                      ? "bg-[#12B76A] text-white"
                      : "border border-[#D0D5DD] bg-white text-[#344054] hover:bg-[#F9FAFB]"
                  }`}
                >
                  {accepted ? "Going ✓" : "Accept"}
                </button>
                <button
                  type="button"
                  disabled={rsvp.isPending}
                  aria-pressed={declined}
                  onClick={() =>
                    rsvp.mutate({ eventId: e.id, status: "declined" })
                  }
                  className={`rounded-lg px-4 py-2 text-[13px] font-semibold disabled:opacity-50 ${
                    declined
                      ? "bg-[#F04438] text-white"
                      : "border border-[#D0D5DD] bg-white text-[#344054] hover:bg-[#F9FAFB]"
                  }`}
                >
                  {declined ? "Declined" : "Decline"}
                </button>
                {e.isVirtual && meeting && accepted && (
                  <a
                    href={meeting}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg bg-[#1570EF] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#1260d4]"
                  >
                    Join online ↗
                  </a>
                )}
              </div>
              {rsvp.error && (
                <p className="mt-2 text-[12px] text-[#F04438]">
                  {rsvp.error.message}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
