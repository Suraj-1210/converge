"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { AdminRole } from "~/server/db/enums";
import { TabSwitch } from "./tab-switch";

// One user's tabs (Super Admin only): their type's default from Settings →
// Tab Access, with per-tab overrides. A tab left equal to the type default
// follows the type from then on; "Reset to type default" drops every override.
export function TabOverridesModal({
  portal,
  userId,
  onClose,
  toast,
}: {
  portal: "admin" | "partner";
  /** null = closed. */
  userId: number | null;
  onClose: () => void;
  toast: (msg: string) => void;
}) {
  const utils = api.useUtils();
  const q = api.tabAccess.userOverrides.useQuery(
    { portal, userId: userId ?? 0 },
    { enabled: userId !== null },
  );
  const saved = useMemo(
    () => Object.fromEntries((q.data?.tabs ?? []).map((t) => [t.tab, t.value])),
    [q.data],
  );
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  useEffect(() => setDraft(saved), [saved]);

  const saveMut = api.tabAccess.saveUserOverrides.useMutation({
    onSuccess: async (r, v) => {
      await utils.tabAccess.invalidate();
      toast(r.changed === 0 ? "No changes to save" : v.reset ? "Reset to type default" : "Tabs saved");
      onClose();
    },
    onError: (e) => toast(e.message),
  });

  const tabs = q.data?.tabs ?? [];
  const dirty = tabs.some((t) => draft[t.tab] !== saved[t.tab]);
  const custom = tabs.filter((t) => t.grantable && draft[t.tab] !== t.typeDefault).length;

  return (
    <Modal
      open={userId !== null}
      title={q.data ? `Tabs for ${q.data.name}` : "Tabs"}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => userId !== null && saveMut.mutate({ portal, userId, tabs: {}, reset: true })}
            disabled={saveMut.isPending || !tabs.some((t) => t.overridden)}
            className="!mr-auto !h-[38px] !px-4"
          >
            Reset to type default
          </Button>
          <Button variant="secondary" onClick={onClose} className="!h-[38px] !px-4">
            Cancel
          </Button>
          <Button
            onClick={() => userId !== null && saveMut.mutate({ portal, userId, tabs: draft })}
            loading={saveMut.isPending}
            disabled={!dirty}
            className="!h-[38px] !px-4"
          >
            Save
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-[#98A2B3]">Loading…</p>
      ) : q.error ? (
        <p className="py-6 text-center text-sm text-[#B42318]">{q.error.message}</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-[#667085]">
            {q.data?.typeLabel} default from Settings → Tab Access
            {custom > 0 ? `, with ${custom} tab${custom === 1 ? "" : "s"} changed for this user.` : "."}
          </p>
          <ul className="divide-y divide-[#F2F4F7] rounded-lg border border-[#E4E7EC]">
            {tabs.map((t) => {
              const on = !!draft[t.tab];
              const differs = t.grantable && on !== t.typeDefault;
              return (
                <li key={t.tab} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <div className="text-sm text-[#344054]">
                    {t.label}
                    {differs && (
                      <span className="ml-2 rounded-full bg-[#FFFAEB] px-2 py-0.5 text-[11px] font-semibold text-[#B54708]">
                        type default: {t.typeDefault ? "on" : "off"}
                      </span>
                    )}
                    {!t.grantable && (
                      <span className="ml-2 text-xs text-[#98A2B3]">not available for this user type</span>
                    )}
                  </div>
                  <TabSwitch
                    label={t.label}
                    on={on}
                    disabled={!t.grantable || saveMut.isPending}
                    changed={draft[t.tab] !== saved[t.tab]}
                    onChange={() => setDraft((d) => ({ ...d, [t.tab]: !d[t.tab] }))}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Modal>
  );
}

// A "Tabs" button that opens one user's tabs. Renders nothing unless the
// signed-in admin is a Super Admin (the API refuses everyone else anyway).
export function TabOverridesButton({
  portal,
  userId,
  toast,
  className,
  label = "Tabs",
}: {
  portal: "admin" | "partner";
  userId: number;
  toast: (msg: string) => void;
  className?: string;
  label?: string;
}) {
  const me = api.authSession.me.useQuery().data;
  const [open, setOpen] = useState(false);
  if (me?.role !== AdminRole.SUPER_ADMIN) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF]"
        }
      >
        {label}
      </button>
      {open && (
        <TabOverridesModal portal={portal} userId={userId} onClose={() => setOpen(false)} toast={toast} />
      )}
    </>
  );
}
