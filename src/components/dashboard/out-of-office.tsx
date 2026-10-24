"use client";

import { useEffect, useState } from "react";
import { Modal } from "~/components/ui/modal";
import { api } from "~/trpc/react";

// Out of office, from the admin user menu (src/server/out-of-office.ts). A
// counsellor sets their own dates and alternate; a Counselling Lead can also
// set or override it for their team, and a Super Admin for anyone in
// counselling. It ends by itself after the To date.

export function OutOfOfficeMenuItem({ onClick }: { onClick: () => void }) {
  const mine = api.outOfOffice.mine.useQuery(undefined, { staleTime: 60_000 }).data;
  if (!mine?.eligible) return null;
  const status = mine.setting
    ? mine.setting.status === "active"
      ? `On · until ${mine.setting.dates.split(" – ").pop()}`
      : `Scheduled · ${mine.setting.dates}`
    : mine.covering.length
      ? `Covering for ${mine.covering.map((c) => c.name).join(", ")}`
      : null;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-2.5 rounded-md border-none bg-transparent px-3 py-2 text-left text-sm text-[#344054] transition-colors hover:bg-[#F0F7FF] hover:text-[#1570EF]"
    >
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${mine.setting?.status === "active" ? "bg-[#F79009]" : "bg-[#D0D5DD]"}`}
      />
      <span>
        <span className="block">Out of office</span>
        {status && <span className="block text-[11px] text-[#98A2B3]">{status}</span>}
      </span>
    </button>
  );
}

const inputClass =
  "h-9 w-full rounded-lg border border-[#D0D5DD] bg-white px-3 text-sm text-[#101828] outline-none focus:border-[#1570EF]";

export function OutOfOfficeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = api.useUtils();
  const mine = api.outOfOffice.mine.useQuery(undefined, { enabled: open }).data;
  const manageable = api.outOfOffice.manageable.useQuery(undefined, {
    enabled: open && !!mine?.canManageOthers,
  }).data;
  const [targetId, setTargetId] = useState<number | null>(null);
  const me = api.authSession.me.useQuery(undefined, { enabled: open }).data;

  // Default: myself if I can be out of office, else the first person I manage.
  useEffect(() => {
    if (!open || targetId !== null) return;
    if (mine?.canSetOwn && me) setTargetId(me.id);
    else if (manageable?.[0]) setTargetId(manageable[0].id);
  }, [open, targetId, mine, me, manageable]);

  const detail = api.outOfOffice.get.useQuery(
    { cpUserId: targetId ?? 0 },
    { enabled: open && targetId !== null, retry: false },
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [alternateId, setAlternateId] = useState<number | "">("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    const d = detail.data;
    if (!d) return;
    setFrom(d.setting?.from ?? d.today);
    setTo(d.setting?.to ?? d.today);
    setAlternateId(d.setting?.alternate.id ?? "");
    setError("");
  }, [detail.data]);

  const refresh = async () => {
    await Promise.all([utils.outOfOffice.mine.invalidate(), utils.outOfOffice.get.invalidate()]);
  };
  const set = api.outOfOffice.set.useMutation({
    onSuccess: async (r) => {
      setSaved(`Saved: out of office ${r.dates}.`);
      await refresh();
    },
    onError: (e) => setError(e.message),
  });
  const clear = api.outOfOffice.clear.useMutation({
    onSuccess: async () => {
      setSaved("Out of office removed.");
      await refresh();
    },
    onError: (e) => setError(e.message),
  });

  const close = () => {
    setSaved("");
    setError("");
    setTargetId(null);
    onClose();
  };

  const d = detail.data;
  const self = me?.id === targetId;
  const busy = set.isPending || clear.isPending;

  return (
    <Modal
      open={open}
      title="Out of office"
      onClose={close}
      footer={
        <>
          {d?.setting && (
            <button
              type="button"
              disabled={busy}
              onClick={() => targetId && clear.mutate({ cpUserId: targetId })}
              className="mr-auto rounded-lg border border-[#FECDCA] bg-white px-3 py-2 text-sm font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50"
            >
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-[#D0D5DD] bg-white px-3 py-2 text-sm font-semibold text-[#344054] hover:bg-[#F9FAFB]"
          >
            Close
          </button>
          <button
            type="button"
            disabled={busy || !d || !from || !to || alternateId === ""}
            onClick={() => {
              setError("");
              setSaved("");
              if (targetId && alternateId !== "") set.mutate({ cpUserId: targetId, from, to, alternateId });
            }}
            className="rounded-lg bg-[#1570EF] px-4 py-2 text-sm font-semibold text-white hover:bg-[#175CD3] disabled:opacity-50"
          >
            Save
          </button>
        </>
      }
    >
      <p className="text-[13px] text-[#475467]">
        While {self ? "you're" : "they're"} out, the alternate gets {self ? "your" : "their"} partner chats, the chat
        reply TAT and new auto-assigned students. Partners see who to contact instead. It ends automatically after the
        To date.
      </p>

      {mine && mine.covering.length > 0 && (
        <div className="rounded-lg border border-[#B2DDFF] bg-[#EFF8FF] px-3 py-2 text-[13px] text-[#175CD3]">
          You&apos;re covering for {mine.covering.map((c) => `${c.name} (${c.dates})`).join(", ")}.
        </div>
      )}

      {mine?.canManageOthers && manageable && manageable.length > 0 && (
        <label className="block text-[13px] font-medium text-[#344054]">
          For
          <select
            className={`${inputClass} mt-1`}
            value={targetId ?? ""}
            onChange={(e) => {
              setTargetId(Number(e.target.value));
              setSaved("");
            }}
          >
            {manageable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.role ? ` · ${m.role}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {detail.error ? (
        <p className="text-sm text-[#B42318]">{detail.error.message}</p>
      ) : !d ? (
        <p className="text-sm text-[#98A2B3]">{targetId === null ? "Nothing to set here." : "Loading…"}</p>
      ) : (
        <>
          {d.setting && (
            <div
              className={`rounded-lg px-3 py-2 text-[13px] ${
                d.setting.status === "active" ? "bg-[#FFFAEB] text-[#B54708]" : "bg-[#F2F4F7] text-[#344054]"
              }`}
            >
              {d.setting.status === "active" ? "Out of office now" : "Scheduled"}: {d.setting.dates}, covered by{" "}
              {d.setting.alternate.name}.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[13px] font-medium text-[#344054]">
              From
              <input type="date" className={`${inputClass} mt-1`} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="block text-[13px] font-medium text-[#344054]">
              To
              <input
                type="date"
                className={`${inputClass} mt-1`}
                value={to}
                min={from || d.today}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-[13px] font-medium text-[#344054]">
            Alternate counsellor
            <select
              className={`${inputClass} mt-1`}
              value={alternateId}
              onChange={(e) => setAlternateId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Pick someone from the team…</option>
              {d.alternates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.role ? ` · ${a.role}` : ""}
                </option>
              ))}
            </select>
            {d.alternates.length === 0 && (
              <span className="mt-1 block text-xs text-[#B54708]">
                Nobody in the team can cover. Ask your Counselling Lead or a Super Admin to add teammates in Settings →
                Counselling Teams.
              </span>
            )}
          </label>
        </>
      )}

      {error && <p className="text-sm text-[#B42318]">{error}</p>}
      {saved && <p className="text-sm text-[#027A48]">{saved}</p>}
    </Modal>
  );
}
