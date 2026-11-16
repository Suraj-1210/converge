"use client";

import { useMemo, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";
import { FormInput, FormTextarea } from "~/components/ui/form-input";
import { FormSelect } from "~/components/ui/form-select";
import { FormCombobox } from "~/components/ui/form-combobox";
import {
  MANUAL_AUDIENCES,
  NOTICE_AUDIENCES,
  NOTICE_SEVERITIES,
  NoticeAudience,
  NoticeSeverity,
  TRIGGER_GROUP_LABEL,
  audienceLabel,
  isValidNoticeLink,
  renderTemplate,
  severityLabel,
  severityTone,
  type NoticeTone,
  type TriggerGroup,
} from "~/lib/partner-notices";

const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const TH = "border-b border-[#E4E7EC] bg-[#F9FAFB] px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#667085]";
const TD = "px-3.5 py-3 text-sm text-[#344054] align-top";
const LINK_BTN = "cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#1570EF] hover:bg-[#F0F7FF] disabled:cursor-not-allowed disabled:opacity-40";

const DOT: Record<NoticeTone, string> = {
  green: "bg-[#12B76A]",
  amber: "bg-[#F79009]",
  red: "bg-[#F04438]",
  blue: "bg-[#1570EF]",
};

type Trigger = RouterOutputs["partnerNoticeSettings"]["triggers"][number];
type Manual = RouterOutputs["partnerNoticeSettings"]["manualList"][number];

const GROUP_ORDER: TriggerGroup[] = ["account", "money", "student", "events"];

// Input validation errors arrive as zod's JSON issue list; show the first message.
function errorText(message: string): string {
  try {
    const issues = JSON.parse(message) as { message?: string }[];
    if (Array.isArray(issues) && issues[0]?.message) return issues[0].message;
  } catch {
    // not JSON: a plain server message
  }
  return message;
}

// Settings -> Partner Notices. Super Admin only (the parent hides the section
// for everyone else and the API refuses them). What partners see under
// "Important Notices" on their dashboard.
export function PartnerNoticesPanel({ toast }: { toast: (msg: string) => void }) {
  const [tab, setTab] = useState<"triggers" | "manual">("triggers");
  return (
    <div className="space-y-4">
      <div className={`${CARD} px-5 py-4`}>
        <h3 className="text-[15px] font-semibold text-[#101828]">Partner Notices</h3>
        <p className="mt-0.5 text-sm text-[#667085]">
          What partners see under &ldquo;Important Notices&rdquo; on their dashboard: notices the system raises on its own, and announcements you write.
        </p>
        <div className="mt-3 flex gap-1 border-b border-[#F2F4F7]">
          {([
            ["triggers", "System triggers"],
            ["manual", "Manual notices"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm font-semibold ${tab === id ? "border-[#1570EF] text-[#1570EF]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "triggers" ? <TriggersTab toast={toast} /> : <ManualTab toast={toast} />}
    </div>
  );
}

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${on ? "bg-[#1570EF]" : "bg-[#D0D5DD]"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

function SeverityPill({ severity }: { severity: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-[#475467]">
      <span className={`h-2 w-2 rounded-full ${DOT[severityTone(severity)]}`} />
      {severityLabel(severity)}
    </span>
  );
}

// How the notice reads on the partner dashboard.
function NoticePreview({ severity, title, body }: { severity: number; title: string; body: string | null }) {
  return (
    <div className="flex gap-2.5 text-[13px]">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[severityTone(severity)]}`} />
      <div className="min-w-0">
        <div className="font-medium text-[#101828]">{title || <span className="text-[#98A2B3]">No title</span>}</div>
        {body && <div className="text-xs whitespace-pre-line text-[#667085]">{body}</div>}
      </div>
    </div>
  );
}

// ---- System triggers ------------------------------------------------------------

function TriggersTab({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const listQ = api.partnerNoticeSettings.triggers.useQuery();
  const [editing, setEditing] = useState<Trigger | null>(null);
  const refresh = () => utils.partnerNoticeSettings.triggers.invalidate();
  const toggleMut = api.partnerNoticeSettings.setTriggerEnabled.useMutation({
    onSuccess: async (_d, v) => { await refresh(); toast(v.enabled ? "Notice switched on" : "Notice switched off"); },
    onError: (e) => toast(e.message),
  });
  const resetMut = api.partnerNoticeSettings.resetTrigger.useMutation({
    onSuccess: async () => { await refresh(); toast("Back to the default settings"); },
    onError: (e) => toast(e.message),
  });

  const rows = listQ.data ?? [];
  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    rows: rows.filter((r) => r.group === g).sort((a, b) => a.config.sortOrder - b.config.sortOrder),
  })).filter((g) => g.rows.length > 0);

  return (
    <>
      <div className={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} w-16`}>Order</th>
                <th className={TH}>Notice</th>
                <th className={TH}>Audience</th>
                <th className={TH}>Severity</th>
                <th className={TH}>Stays</th>
                <th className={TH}>On</th>
                <th className={`${TH} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listQ.isLoading ? (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-[#98A2B3]">Loading notices…</td></tr>
              ) : listQ.error ? (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-[#B42318]">{listQ.error.message}</td></tr>
              ) : (
                groups.map((g) => [
                  <tr key={`h-${g.group}`}>
                    <td colSpan={7} className="border-b border-[#F2F4F7] bg-[#FCFCFD] px-3.5 py-2 text-[11px] font-semibold tracking-wider text-[#98A2B3] uppercase">
                      {TRIGGER_GROUP_LABEL[g.group]}
                    </td>
                  </tr>,
                  ...g.rows.map((t) => (
                    <tr key={t.code} className={`border-b border-[#F2F4F7] last:border-0 ${t.config.enabled ? "" : "[&_td:not(:nth-last-child(-n+2))]:opacity-55"}`}>
                      <td className={`${TD} tabular-nums text-[#667085]`}>{t.config.sortOrder}</td>
                      <td className={TD}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-[#101828]">{t.label}</span>
                          {t.customized && <span className="rounded-full bg-[#F4F3FF] px-1.5 py-0.5 text-[10px] font-semibold text-[#6941C6]">Edited</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-[#667085]">{t.fires}</div>
                        <div className="mt-1 text-xs text-[#98A2B3]">&ldquo;{t.config.title}&rdquo; → {t.link}</div>
                      </td>
                      <td className={`${TD} text-xs`}>
                        {audienceLabel(t.config.audience)}
                        {t.ownerOnly && <div className="text-[11px] text-[#98A2B3]">Locked: money / account</div>}
                      </td>
                      <td className={TD}><SeverityPill severity={t.config.severity} /></td>
                      <td className={`${TD} whitespace-nowrap text-xs`}>{t.windowApplies ? `${t.config.windowDays} days` : "While it applies"}</td>
                      <td className={TD}>
                        <Toggle
                          on={t.config.enabled}
                          label={`${t.label} on or off`}
                          disabled={toggleMut.isPending}
                          onChange={() => toggleMut.mutate({ code: t.code, enabled: !t.config.enabled })}
                        />
                      </td>
                      <td className={`${TD} whitespace-nowrap text-right`}>
                        <button className={LINK_BTN} onClick={() => setEditing(t)}>Edit</button>
                        <button
                          className={`${LINK_BTN} ml-1 !text-[#475467]`}
                          disabled={!t.customized || resetMut.isPending}
                          title={t.customized ? "Back to the default wording and settings" : "Already on the defaults"}
                          onClick={() => {
                            if (confirm(`Reset “${t.label}” to its default wording and settings?`)) resetMut.mutate({ code: t.code });
                          }}
                        >
                          Reset
                        </button>
                      </td>
                    </tr>
                  )),
                ])
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-[#98A2B3]">
        These are the notices the system knows how to raise; you can change their wording, colour, order, how long they stay and who sees them.
        Money and account notices only ever go to agency owners and independents, never to agency counsellors.
        Application milestones go to the owner and to the agency counsellor handling that student.
      </p>
      {editing && (
        <TriggerEditor
          trigger={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { await refresh(); setEditing(null); toast("Notice saved"); }}
        />
      )}
    </>
  );
}

function TriggerEditor({ trigger: t, onClose, onSaved }: { trigger: Trigger; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    enabled: t.config.enabled,
    title: t.config.title,
    body: t.config.body ?? "",
    severity: t.config.severity as number,
    sortOrder: String(t.config.sortOrder),
    windowDays: t.config.windowDays == null ? "" : String(t.config.windowDays),
    audience: t.config.audience as number,
  });
  const [error, setError] = useState("");
  const saveMut = api.partnerNoticeSettings.saveTrigger.useMutation({ onSuccess: onSaved, onError: (e) => setError(errorText(e.message)) });

  const windowDays = Number(form.windowDays) || null;
  const sample = useMemo(() => {
    const v: Record<string, string | number> = {};
    for (const p of t.placeholders) v[p.key] = p.sample;
    if (windowDays != null) v.days = windowDays;
    return v;
  }, [t.placeholders, windowDays]);
  const hasChoice = /\{[^{}]*\|[^{}]*\}/.test(form.title + form.body);
  const previews = hasChoice ? [{ ...sample, count: 1 }, { ...sample, count: 3 }] : [sample];

  const useDefaults = () => {
    const d = t.defaults;
    setForm({
      enabled: d.enabled,
      title: d.title,
      body: d.body ?? "",
      severity: d.severity,
      sortOrder: String(d.sortOrder),
      windowDays: d.windowDays == null ? "" : String(d.windowDays),
      audience: d.audience,
    });
  };

  const save = () => {
    setError("");
    const sortOrder = Number(form.sortOrder);
    if (!form.title.trim()) return setError("Title is required");
    if (!Number.isInteger(sortOrder)) return setError("Order must be a whole number");
    if (t.windowApplies && (!windowDays || windowDays < 1 || windowDays > 365)) return setError("Stays for: 1 to 365 days");
    saveMut.mutate({
      code: t.code,
      enabled: form.enabled,
      title: form.title,
      body: form.body,
      severity: form.severity as NoticeSeverity,
      sortOrder,
      windowDays: t.windowApplies ? windowDays : null,
      audience: (t.ownerOnly ? NoticeAudience.OWNER : form.audience) as NoticeAudience,
    });
  };

  return (
    <Modal
      open
      title={`Edit notice: ${t.label}`}
      width="w-[640px]"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="mr-auto cursor-pointer text-xs font-semibold text-[#475467] hover:text-[#101828]" onClick={useDefaults}>
            Fill in the defaults
          </button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={saveMut.isPending} onClick={save}>Save</Button>
        </>
      }
    >
      <p className="text-xs text-[#667085]">{t.fires} Links to: {t.link}.</p>
      <label className="flex items-center gap-2.5 text-sm text-[#344054]">
        <Toggle on={form.enabled} label="Notice on or off" onChange={() => setForm({ ...form, enabled: !form.enabled })} />
        {form.enabled ? "On: partners see this notice" : "Off: nobody sees this notice"}
      </label>
      <FormInput label="Title" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <FormTextarea label="Message" maxLength={1000} rows={2} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      <div className="rounded-lg bg-[#F9FAFB] px-3 py-2 text-xs text-[#667085]">
        {t.placeholders.length > 0 ? (
          <>
            <span className="font-semibold text-[#344054]">Placeholders: </span>
            {t.placeholders.map((p, i) => (
              <span key={p.key}>
                {i > 0 && ", "}
                <code className="text-[#6941C6]">{`{${p.key}}`}</code> ({p.desc})
              </span>
            ))}
            {t.placeholders.some((p) => p.key === "count") && (
              <div className="mt-1">
                <code className="text-[#6941C6]">{"{one|many}"}</code> picks the first word when the count is 1, e.g. <code>{"{count} {commission is|commissions are} ready"}</code>.
              </div>
            )}
          </>
        ) : (
          "This notice has no placeholders."
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormSelect
          label="Severity"
          value={String(form.severity)}
          onChange={(e) => setForm({ ...form, severity: Number(e.target.value) })}
          options={NOTICE_SEVERITIES.map((s) => ({ value: String(s.value), label: s.label }))}
        />
        <FormSelect
          label="Who sees it"
          value={String(t.ownerOnly ? NoticeAudience.OWNER : form.audience)}
          disabled={t.ownerOnly}
          onChange={(e) => setForm({ ...form, audience: Number(e.target.value) })}
          options={NOTICE_AUDIENCES.map((s) => ({ value: String(s.value), label: s.label }))}
        />
        <FormInput label="Display order" type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
        {t.windowApplies && (
          <FormInput label="Stays for (days)" type="number" min={1} max={365} value={form.windowDays} onChange={(e) => setForm({ ...form, windowDays: e.target.value })} />
        )}
      </div>
      {t.ownerOnly && <p className="-mt-1 text-xs text-[#98A2B3]">Money and account notices are for owners and independents only.</p>}
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-[#344054]">Preview (sample values)</div>
        <div className="space-y-2.5 rounded-lg border border-[#E4E7EC] p-3">
          {previews.map((v, i) => (
            <NoticePreview
              key={i}
              severity={form.severity}
              title={renderTemplate(form.title, v)}
              body={form.body.trim() ? renderTemplate(form.body, v) : null}
            />
          ))}
        </div>
      </div>
      {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
    </Modal>
  );
}

// ---- Manual notices -------------------------------------------------------------

const STATE_CHIP: Record<Manual["state"], string> = {
  live: "bg-[#ECFDF3] text-[#027A48]",
  scheduled: "bg-[#EFF8FF] text-[#175CD3]",
  expired: "bg-[#F2F4F7] text-[#475467]",
  inactive: "bg-[#FEF3F2] text-[#B42318]",
};
const STATE_LABEL: Record<Manual["state"], string> = { live: "Live", scheduled: "Scheduled", expired: "Expired", inactive: "Inactive" };

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function ManualTab({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const listQ = api.partnerNoticeSettings.manualList.useQuery();
  const [editing, setEditing] = useState<Manual | "new" | null>(null);
  const refresh = () => utils.partnerNoticeSettings.manualList.invalidate();
  const updateMut = api.partnerNoticeSettings.manualUpdate.useMutation({
    onSuccess: async (_d, v) => { await refresh(); toast(v.notice.active ? "Notice activated" : "Notice deactivated"); },
    onError: (e) => toast(e.message),
  });
  const removeMut = api.partnerNoticeSettings.manualRemove.useMutation({
    onSuccess: async () => { await refresh(); toast("Notice deleted"); },
    onError: (e) => toast(e.message),
  });
  const rows = listQ.data ?? [];

  const toggle = (n: Manual) =>
    updateMut.mutate({
      id: n.id,
      notice: {
        title: n.title,
        body: n.body ?? "",
        linkUrl: n.linkUrl ?? "",
        severity: n.severity as NoticeSeverity,
        audience: n.audience as NoticeAudience,
        startsOn: n.startsOn,
        endsOn: n.endsOn,
        active: !n.active,
        sortOrder: n.sortOrder,
        targets: n.targets.map(parseTarget),
      },
    });

  return (
    <>
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3 border-b border-[#F2F4F7] px-5 py-4">
          <p className="text-sm text-[#667085]">Announcements shown between their start and end dates. Expired ones disappear by themselves.</p>
          <Button className="!h-9 shrink-0 !text-[13px]" onClick={() => setEditing("new")}>Add Notice</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Notice</th>
                <th className={TH}>Dates</th>
                <th className={TH}>Audience</th>
                <th className={TH}>Status</th>
                <th className={`${TH} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listQ.isLoading ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">Loading notices…</td></tr>
              ) : listQ.error ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#B42318]">{listQ.error.message}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-[#98A2B3]">No manual notices yet</td></tr>
              ) : rows.map((n) => (
                <tr key={n.id} className="border-b border-[#F2F4F7] last:border-0">
                  <td className={TD}>
                    <NoticePreview severity={n.severity} title={n.title} body={n.body} />
                    {n.linkUrl && <div className="mt-1 truncate pl-4.5 text-xs text-[#1570EF]">{n.linkUrl}</div>}
                  </td>
                  <td className={`${TD} whitespace-nowrap text-xs`}>
                    {fmtDate(n.startsOn)} – {n.endsOn ? fmtDate(n.endsOn) : "no end"}
                  </td>
                  <td className={`${TD} text-xs`}>
                    {MANUAL_AUDIENCES.find((a) => a.value === n.audience)?.label}
                    {n.targets.length > 0 && (
                      <div className="text-[11px] text-[#98A2B3]" title={n.targets.map((t) => t.label).join(", ")}>
                        Only {n.targets.length === 1 ? n.targets[0]!.label : `${n.targets.length} partners`}
                      </div>
                    )}
                  </td>
                  <td className={TD}>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_CHIP[n.state]}`}>{STATE_LABEL[n.state]}</span>
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <button className={LINK_BTN} onClick={() => setEditing(n)}>Edit</button>
                    <button
                      onClick={() => toggle(n)}
                      disabled={updateMut.isPending}
                      className={`ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold disabled:opacity-50 ${n.active ? "text-[#F04438] hover:bg-[#FEF3F2]" : "text-[#F79009] hover:bg-[#FFFAEB]"}`}
                    >
                      {n.active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete “${n.title}”? This permanently removes the notice and cannot be undone.`)) removeMut.mutate({ id: n.id });
                      }}
                      disabled={removeMut.isPending}
                      className="ml-1 cursor-pointer rounded px-2 py-1 text-xs font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editing && (
        <ManualEditor
          notice={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => { await refresh(); setEditing(null); toast(msg); }}
        />
      )}
    </>
  );
}

function parseTarget(t: { key: string }): { orgId: number } | { userId: number } {
  const [kind, id] = t.key.split(":");
  return kind === "org" ? { orgId: Number(id) } : { userId: Number(id) };
}

function todayIso(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

function ManualEditor({ notice, onClose, onSaved }: { notice: Manual | null; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const partnersQ = api.partnerNoticeSettings.partnerOptions.useQuery();
  const [form, setForm] = useState({
    title: notice?.title ?? "",
    body: notice?.body ?? "",
    linkUrl: notice?.linkUrl ?? "",
    severity: notice?.severity ?? NoticeSeverity.INFO,
    audience: notice?.audience ?? NoticeAudience.BOTH,
    startsOn: notice?.startsOn ?? todayIso(),
    endsOn: notice?.endsOn ?? "",
    active: notice?.active ?? true,
    sortOrder: String(notice?.sortOrder ?? 0),
    targets: notice?.targets ?? ([] as { key: string; label: string }[]),
  });
  const [error, setError] = useState("");
  const createMut = api.partnerNoticeSettings.manualCreate.useMutation({
    onSuccess: () => onSaved("Notice added"),
    onError: (e) => setError(errorText(e.message)),
  });
  const updateMut = api.partnerNoticeSettings.manualUpdate.useMutation({
    onSuccess: () => onSaved("Notice saved"),
    onError: (e) => setError(errorText(e.message)),
  });

  const partnerOpts = (partnersQ.data ?? [])
    .filter((p) => !form.targets.some((t) => t.key === p.key))
    .map((p) => ({ value: p.key, label: `${p.label} · ${p.kind}` }));

  const save = () => {
    setError("");
    const sortOrder = Number(form.sortOrder);
    if (!form.title.trim()) return setError("Title is required");
    if (!form.startsOn) return setError("Pick a start date");
    if (form.linkUrl.trim() && !isValidNoticeLink(form.linkUrl.trim())) {
      return setError("Link must be a portal path (/partner/…) or an https:// address");
    }
    if (form.endsOn && form.endsOn < form.startsOn) return setError("The end date is before the start date");
    if (!Number.isInteger(sortOrder)) return setError("Order must be a whole number");
    const payload = {
      title: form.title,
      body: form.body,
      linkUrl: form.linkUrl,
      severity: form.severity as NoticeSeverity,
      audience: form.audience as NoticeAudience,
      startsOn: form.startsOn,
      endsOn: form.endsOn || null,
      active: form.active,
      sortOrder,
      targets: form.targets.map(parseTarget),
    };
    if (notice) updateMut.mutate({ id: notice.id, notice: payload });
    else createMut.mutate(payload);
  };

  return (
    <Modal
      open
      title={notice ? "Edit Notice" : "Add Notice"}
      width="w-[640px]"
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={createMut.isPending || updateMut.isPending} onClick={save}>Save</Button></>}
    >
      <FormInput label="Title" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <FormTextarea label="Message" maxLength={2000} rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      <FormInput
        label="Link (optional)"
        maxLength={500}
        placeholder="/partner/events or https://…"
        value={form.linkUrl}
        onChange={(e) => setForm({ ...form, linkUrl: e.target.value })}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormSelect
          label="Severity"
          value={String(form.severity)}
          onChange={(e) => setForm({ ...form, severity: Number(e.target.value) })}
          options={NOTICE_SEVERITIES.map((s) => ({ value: String(s.value), label: s.label }))}
        />
        <FormSelect
          label="Who sees it"
          value={String(form.audience)}
          onChange={(e) => setForm({ ...form, audience: Number(e.target.value) })}
          options={MANUAL_AUDIENCES.map((s) => ({ value: String(s.value), label: s.label }))}
        />
        <FormInput label="Starts" required type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />
        <FormInput label="Ends (optional)" type="date" min={form.startsOn} value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />
        <FormInput label="Display order" type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
        <label className="flex items-center gap-2.5 self-end pb-2 text-sm text-[#344054]">
          <Toggle on={form.active} label="Active" onChange={() => setForm({ ...form, active: !form.active })} />
          {form.active ? "Active" : "Inactive"}
        </label>
      </div>
      <p className="-mt-1 text-xs text-[#98A2B3]">
        Shown from the start date to the end date (both included, India time). System notices use orders 10–150; 0 puts this one at the top.
      </p>
      <div>
        <FormCombobox
          label="Only these partners (optional)"
          placeholder={partnersQ.isLoading ? "Loading partners…" : "Search agencies and independents"}
          options={partnerOpts}
          loading={partnersQ.isLoading}
          value=""
          onChange={(key) => {
            const p = partnersQ.data?.find((x) => x.key === key);
            if (p) setForm({ ...form, targets: [...form.targets, { key: p.key, label: p.label }] });
          }}
        />
        {form.targets.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {form.targets.map((t) => (
              <span key={t.key} className="inline-flex items-center gap-1 rounded-full bg-[#EFF8FF] py-0.5 pr-1 pl-2.5 text-xs font-medium text-[#175CD3]">
                {t.label}
                <button
                  type="button"
                  aria-label={`Remove ${t.label}`}
                  className="cursor-pointer rounded-full px-1 hover:bg-[#D1E9FF]"
                  onClick={() => setForm({ ...form, targets: form.targets.filter((x) => x.key !== t.key) })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-[#98A2B3]">No partners picked: everyone in the audience sees it. An agency includes its counsellors.</p>
        )}
      </div>
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-[#344054]">Preview</div>
        <div className="rounded-lg border border-[#E4E7EC] p-3">
          <NoticePreview severity={form.severity} title={form.title} body={form.body.trim() || null} />
        </div>
      </div>
      {error && <div className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-sm text-[#B42318]">{error}</div>}
    </Modal>
  );
}
