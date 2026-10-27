"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { TabSwitch } from "~/components/admin/tab-switch";
import { SWITCHABLE_SECTIONS } from "~/lib/admin-sections";
import { SWITCHABLE_PARTNER_TABS } from "~/lib/partner-tabs";

const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-[#667085]";

type Portal = "admin" | "partner";
// type → tab → on
type Draft = Record<number, Record<string, boolean>>;

const TAB_ROWS: Record<Portal, { tab: string; label: string; group?: string }[]> = {
  admin: SWITCHABLE_SECTIONS.map((s) => ({ tab: s.section, label: s.label, group: s.group })),
  partner: SWITCHABLE_PARTNER_TABS.map((t) => ({ tab: t.tab, label: t.label })),
};

// Settings → Tab Access. Super Admin only (the parent hides the section and
// the API refuses everyone else). One grid per portal: user type × tab. Saved
// as each type's default, which every user of that type follows, including
// ones added later, unless they have a per-user override (Users → Tabs).
export function TabAccessPanel({ toast }: { toast: (msg: string) => void }) {
  const [portal, setPortal] = useState<Portal>("admin");
  const utils = api.useUtils();
  const gridQ = api.tabAccess.typeDefaults.useQuery({ portal });
  const [draft, setDraft] = useState<Draft>({});

  const saved = useMemo<Draft>(() => {
    const out: Draft = {};
    for (const t of gridQ.data ?? []) {
      out[t.type] = Object.fromEntries(t.cells.map((c) => [c.tab, c.value]));
    }
    return out;
  }, [gridQ.data]);
  useEffect(() => setDraft(saved), [saved]);

  const saveMut = api.tabAccess.saveTypeDefaults.useMutation({
    onSuccess: async (r) => {
      await utils.tabAccess.invalidate();
      toast(r.changedTypes === 0 ? "No changes to save" : "Tab access saved");
    },
    onError: (e) => toast(e.message),
  });

  const types = gridQ.data ?? [];
  const isChanged = (type: number, tab: string) => draft[type]?.[tab] !== saved[type]?.[tab];
  const dirty = types.some((t) => t.cells.some((c) => isChanged(t.type, c.tab)));

  const toggle = (type: number, tab: string) =>
    setDraft((d) => ({ ...d, [type]: { ...d[type], [tab]: !d[type]?.[tab] } }));

  const resetToBuiltIn = () =>
    setDraft(
      Object.fromEntries(
        types.map((t) => [t.type, Object.fromEntries(t.cells.map((c) => [c.tab, c.builtIn && c.grantable]))]),
      ),
    );

  const save = () =>
    saveMut.mutate({
      portal,
      types: types
        .filter((t) => !t.locked)
        .map((t) => ({ type: t.type, tabs: draft[t.type] ?? {} })),
    });

  const rows = TAB_ROWS[portal];

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#F2F4F7] px-5 py-4">
        <div>
          <h3 className="text-[15px] font-semibold text-[#101828]">Tab Access</h3>
          <p className="mt-0.5 max-w-2xl text-sm text-[#667085]">
            Choose which tabs each user type sees. Saved settings become the type&apos;s default:
            every user of that type gets them, including users added later, unless they have their
            own override on the Users page. Turning a tab on opens its pages, never more data or
            approval rights than the user&apos;s role already has.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-[#D0D5DD] p-0.5">
          {(["admin", "partner"] as const).map((p) => (
            <button
              key={p}
              type="button"
              disabled={dirty && p !== portal}
              title={dirty && p !== portal ? "Save or discard your changes first" : undefined}
              onClick={() => setPortal(p)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                portal === p ? "bg-[#EFF8FF] text-[#1570EF]" : "text-[#475467] hover:bg-[#F9FAFB]"
              }`}
            >
              {p === "admin" ? "Admin portal" : "Partner portal"}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={`${TH} sticky left-0 z-10 text-left`}>Tab</th>
              {types.map((t) => (
                <th key={t.type} className={`${TH} text-center normal-case tracking-normal`}>
                  {t.label}
                  {t.locked && <div className="font-normal text-[#98A2B3]">always all tabs</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {gridQ.isLoading ? (
              <tr>
                <td colSpan={10} className="px-5 py-8 text-center text-sm text-[#98A2B3]">
                  Loading…
                </td>
              </tr>
            ) : (
              rows.map((row, i) => {
                const groupStart = row.group && row.group !== rows[i - 1]?.group;
                return (
                  <tr key={row.tab} className="border-b border-[#F2F4F7] last:border-b-0">
                    <td className="sticky left-0 z-10 bg-white px-3 py-2.5 text-sm font-medium text-[#344054]">
                      {groupStart && (
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-[#98A2B3]">
                          {row.group}
                        </div>
                      )}
                      {row.label}
                    </td>
                    {types.map((t) => {
                      const cell = t.cells.find((c) => c.tab === row.tab);
                      if (!cell) return <td key={t.type} />;
                      const on = t.locked ? true : !!draft[t.type]?.[row.tab];
                      return (
                        <td key={t.type} className="px-3 py-2.5 text-center">
                          <div className="flex justify-center">
                            <TabSwitch
                              label={`${row.label} for ${t.label}`}
                              on={on}
                              disabled={t.locked || !cell.grantable || saveMut.isPending}
                              changed={!t.locked && isChanged(t.type, row.tab)}
                              title={
                                t.locked
                                  ? "Super Admins always have every tab"
                                  : !cell.grantable
                                    ? `${row.label} can't be given to ${t.label}s`
                                    : cell.builtIn === on
                                      ? undefined
                                      : `Built-in default: ${cell.builtIn ? "on" : "off"}`
                              }
                              onChange={() => toggle(t.type, row.tab)}
                            />
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#F2F4F7] px-5 py-4">
        <p className="text-xs text-[#667085]">
          {portal === "admin"
            ? "Users, Settings and Audit Logs stay Super Admin only. Dashboard is always on."
            : "Dashboard is always on. Counsellors stays the agency owner's and Commission the payee's."}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={resetToBuiltIn} disabled={saveMut.isPending} className="!h-[38px] !px-4">
            Reset to built-in
          </Button>
          <Button variant="secondary" onClick={() => setDraft(saved)} disabled={!dirty || saveMut.isPending} className="!h-[38px] !px-4">
            Discard
          </Button>
          <Button onClick={save} loading={saveMut.isPending} disabled={!dirty} className="!h-[38px] !px-4">
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
