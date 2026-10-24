"use client";

import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { WEEKDAYS, describeHours, fmtMinutes, hhmmToMinute, minuteToHhmm } from "~/lib/tat";
import { ACK_MAX_LENGTH_LIMIT, ACK_MAX_PHRASE_LENGTH, ACK_MAX_PHRASES } from "~/lib/partner-chat-rules";

const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054]";
const INPUT = "h-9 rounded-lg border border-[#D0D5DD] px-2.5 text-sm outline-none focus:border-[#1570EF]";

const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

// Settings -> TAT Settings. Super Admin only (the parent hides the section and
// the API refuses everyone else). Working hours, holidays and per-action
// targets drive every TAT clock (src/server/tat.ts). Chat Response is the
// first action; others are added as they're measured.
export function TatSettingsPanel({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const q = api.tat.master.useQuery();
  const refresh = async () => {
    await utils.tat.master.invalidate();
    void utils.tat.config.invalidate();
    void utils.tat.chatOverview.invalidate();
  };

  const [tz, setTz] = useState("Asia/Kolkata");
  const [days, setDays] = useState<number[]>([]);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("19:00");
  const [holiday, setHoliday] = useState({ date: "", name: "" });
  const [edit, setEdit] = useState<{ key: string; hours: string; warningPct: string; active: boolean } | null>(null);
  const [ackText, setAckText] = useState("");
  const [ackMax, setAckMax] = useState("40");

  useEffect(() => {
    if (!q.data) return;
    setTz(q.data.hours.timezone);
    setDays(q.data.hours.workDays);
    setStart(minuteToHhmm(q.data.hours.dayStartMinute));
    setEnd(minuteToHhmm(q.data.hours.dayEndMinute));
    setAckText(q.data.chatAck.phrases.join("\n"));
    setAckMax(String(q.data.chatAck.maxLength));
  }, [q.data]);

  const onError = (e: { message: string }) => toast(e.message);
  const hoursMut = api.tat.updateHours.useMutation({ onSuccess: async () => { await refresh(); toast("Working hours saved"); }, onError });
  const addHol = api.tat.addHoliday.useMutation({ onSuccess: async () => { await refresh(); setHoliday({ date: "", name: "" }); toast("Holiday added"); }, onError });
  const delHol = api.tat.removeHoliday.useMutation({ onSuccess: async () => { await refresh(); toast("Holiday removed"); }, onError });
  const targetMut = api.tat.updateTarget.useMutation({ onSuccess: async () => { await refresh(); setEdit(null); toast("TAT target saved"); }, onError });
  const ackMut = api.tat.updateChatAck.useMutation({ onSuccess: async () => { await refresh(); toast("Acknowledgements saved"); }, onError });
  const saveAck = (reset = false) => {
    const max = Number(ackMax);
    if (!Number.isInteger(max) || max < 1 || max > ACK_MAX_LENGTH_LIMIT) return toast(`Max length must be 1–${ACK_MAX_LENGTH_LIMIT} characters`);
    const phrases = reset ? [] : [...new Set(ackText.split("\n").map((p) => p.trim()).filter(Boolean))];
    if (phrases.length > ACK_MAX_PHRASES) return toast(`Up to ${ACK_MAX_PHRASES} phrases`);
    if (phrases.some((p) => p.length > ACK_MAX_PHRASE_LENGTH)) return toast(`Each phrase can be up to ${ACK_MAX_PHRASE_LENGTH} characters`);
    ackMut.mutate({ phrases, maxLength: max });
  };

  const saveHours = () => {
    const s = hhmmToMinute(start);
    const e = hhmmToMinute(end);
    if (s === null || e === null) return toast("Enter times as HH:MM");
    if (e <= s) return toast("The working day must end after it starts");
    if (days.length === 0) return toast("Pick at least one working day");
    hoursMut.mutate({ timezone: tz, workDays: days, dayStartMinute: s, dayEndMinute: e });
  };
  const saveTarget = () => {
    if (!edit) return;
    const minutes = Math.round(Number(edit.hours) * 60);
    const pct = Number(edit.warningPct);
    if (!Number.isFinite(minutes) || minutes < 5) return toast("The target must be at least 5 minutes");
    if (!Number.isInteger(pct) || pct < 1 || pct > 99) return toast("Warning % must be a whole number from 1 to 99");
    targetMut.mutate({ key: edit.key, thresholdMinutes: minutes, warningPct: pct, active: edit.active });
  };

  if (!q.data) {
    return <div className={`${CARD} p-5 text-sm text-[#98A2B3]`}>{q.error ? q.error.message : "Loading…"}</div>;
  }
  const preview = describeHours({ timezone: tz, workDays: days, dayStartMinute: hhmmToMinute(start) ?? 0, dayEndMinute: hhmmToMinute(end) ?? 0 });

  return (
    <div className="space-y-5">
      {/* Working hours */}
      <div className={CARD}>
        <div className="border-b border-[#E4E7EC] px-5 py-4">
          <h3 className="text-[15px] font-semibold text-[#101828]">Working hours</h3>
          <p className="mt-0.5 text-xs text-[#667085]">TAT clocks only run during these hours. Time outside them, and on holidays, doesn&apos;t count.</p>
        </div>
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-sm font-medium text-[#344054]">Working days</span>
            {WEEKDAYS.map((d) => {
              const on = days.includes(d.iso);
              return (
                <button
                  key={d.iso}
                  type="button"
                  onClick={() => setDays((x) => (on ? x.filter((y) => y !== d.iso) : [...x, d.iso].sort()))}
                  className={`h-8 w-12 rounded-lg border text-xs font-semibold ${on ? "border-[#1570EF] bg-[#EFF8FF] text-[#1570EF]" : "border-[#D0D5DD] text-[#667085]"}`}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-sm font-medium text-[#344054]">Hours</span>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={INPUT} />
            <span className="text-sm text-[#667085]">to</span>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={INPUT} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-sm font-medium text-[#344054]">Timezone</span>
            <select value={tz} onChange={(e) => setTz(e.target.value)} className={INPUT}>
              {[...new Set([tz, ...TIMEZONES])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={saveHours} disabled={hoursMut.isPending} className="h-10 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1565d8] disabled:opacity-50">
              Save working hours
            </button>
            <span className="text-xs text-[#667085]">{preview}</span>
          </div>
        </div>
      </div>

      {/* Targets */}
      <div className={CARD}>
        <div className="border-b border-[#E4E7EC] px-5 py-4">
          <h3 className="text-[15px] font-semibold text-[#101828]">Action targets</h3>
          <p className="mt-0.5 text-xs text-[#667085]">
            Warning from the given percentage of the target; Breached once past it. Chat Response: Collegepond replying to a partner in partner chat (system messages don&apos;t count).
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Action</th>
                <th className={TH}>Target (business hours)</th>
                <th className={TH}>Warning at</th>
                <th className={TH}>Active</th>
                <th className={TH}></th>
              </tr>
            </thead>
            <tbody>
              {q.data.targets.map((t) => {
                const editing = edit?.key === t.key;
                return (
                  <tr key={t.key} className="border-b border-[#F2F4F7] last:border-0">
                    <td className={`${TD} font-semibold text-[#101828]`}>{t.label}</td>
                    <td className={TD}>
                      {editing ? (
                        <span className="inline-flex items-center gap-1.5">
                          <input type="number" min={0.1} step={0.25} value={edit.hours} onChange={(e) => setEdit({ ...edit, hours: e.target.value })} className={`${INPUT} w-24`} />
                          hours
                        </span>
                      ) : (
                        fmtMinutes(t.thresholdMinutes)
                      )}
                    </td>
                    <td className={TD}>
                      {editing ? (
                        <span className="inline-flex items-center gap-1.5">
                          <input type="number" min={1} max={99} value={edit.warningPct} onChange={(e) => setEdit({ ...edit, warningPct: e.target.value })} className={`${INPUT} w-20`} />%
                        </span>
                      ) : (
                        `${t.warningPct}%`
                      )}
                    </td>
                    <td className={TD}>
                      {editing ? (
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
                          Active
                        </label>
                      ) : t.active ? (
                        <span className="text-[#027A48]">Active</span>
                      ) : (
                        <span className="text-[#98A2B3]">Paused</span>
                      )}
                    </td>
                    <td className={TD}>
                      {editing ? (
                        <div className="flex gap-2">
                          <button type="button" onClick={saveTarget} disabled={targetMut.isPending} className="rounded-md bg-[#12B76A] px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
                            Save
                          </button>
                          <button type="button" onClick={() => setEdit(null)} className="rounded-md border border-[#D0D5DD] px-3 py-1 text-xs font-semibold text-[#344054]">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setEdit({ key: t.key, hours: String(t.thresholdMinutes / 60), warningPct: String(t.warningPct), active: t.active })}
                          className="rounded-md border border-[#D0D5DD] px-3 py-1 text-xs font-semibold text-[#344054] hover:border-[#1570EF] hover:text-[#1570EF]"
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Chat acknowledgements */}
      <div className={CARD}>
        <div className="border-b border-[#E4E7EC] px-5 py-4">
          <h3 className="text-[15px] font-semibold text-[#101828]">Chat acknowledgements</h3>
          <p className="mt-0.5 text-xs text-[#667085]">
            A short partner message made only of these phrases (e.g. &ldquo;Ok, thanks! 👍&rdquo;) doesn&apos;t start the Chat Response clock. It
            still shows in the thread. Messages with a file always count. One phrase per line; emoji work too.
            {q.data.chatAck.isDefault ? " Using the built-in list." : ""}
          </p>
        </div>
        <div className="space-y-3 p-5">
          <textarea
            value={ackText}
            onChange={(e) => setAckText(e.target.value)}
            rows={8}
            className="w-full max-w-md rounded-lg border border-[#D0D5DD] px-2.5 py-2 font-mono text-sm outline-none focus:border-[#1570EF]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[#344054]">Only for messages up to</span>
            <input value={ackMax} onChange={(e) => setAckMax(e.target.value)} inputMode="numeric" className={`${INPUT} w-20`} />
            <span className="text-sm text-[#667085]">characters</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => saveAck()} disabled={ackMut.isPending} className="h-10 rounded-lg bg-[#1570EF] px-4 text-[13px] font-semibold text-white hover:bg-[#1565d8] disabled:opacity-50">
              Save acknowledgements
            </button>
            <button type="button" onClick={() => saveAck(true)} disabled={ackMut.isPending} className="h-10 rounded-lg border border-[#D0D5DD] px-4 text-[13px] font-semibold text-[#344054] disabled:opacity-50">
              Reset to built-in list
            </button>
          </div>
        </div>
      </div>

      {/* Holidays */}
      <div className={CARD}>
        <div className="border-b border-[#E4E7EC] px-5 py-4">
          <h3 className="text-[15px] font-semibold text-[#101828]">Holidays</h3>
          <p className="mt-0.5 text-xs text-[#667085]">Whole days the TAT clock skips.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-[#F2F4F7] px-5 py-3">
          <input type="date" value={holiday.date} onChange={(e) => setHoliday({ ...holiday, date: e.target.value })} className={INPUT} />
          <input value={holiday.name} maxLength={100} onChange={(e) => setHoliday({ ...holiday, name: e.target.value })} placeholder="Name, e.g. Diwali" className={`${INPUT} w-56`} />
          <button
            type="button"
            disabled={!holiday.date || !holiday.name.trim() || addHol.isPending}
            onClick={() => addHol.mutate({ date: holiday.date, name: holiday.name.trim() })}
            className="h-9 rounded-lg bg-[#1570EF] px-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            Add holiday
          </button>
        </div>
        {q.data.holidays.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[#98A2B3]">No holidays added.</p>
        ) : (
          <ul>
            {q.data.holidays.map((h) => (
              <li key={h.id} className="flex items-center justify-between border-b border-[#F2F4F7] px-5 py-2.5 text-sm last:border-0">
                <span>
                  <span className="font-mono text-[#344054]">{h.date}</span>
                  <span className="ml-3 text-[#101828]">{h.name}</span>
                </span>
                <button type="button" onClick={() => delHol.mutate({ id: h.id })} className="text-xs font-semibold text-[#B42318] hover:underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
