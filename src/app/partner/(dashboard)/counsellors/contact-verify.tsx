"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import {
  getExpectedPhoneDigits,
  isValidEmail,
  isValidPhone,
} from "~/lib/utils/validation";

// Contact verification for a counsellor being added or edited: codes go to
// the counsellor's email and phone, the counsellor reads them out, the owner
// types them in. Each verified code yields a proof bound to that exact email /
// number; the server requires them to save. Changing a value after verifying
// it drops its proof.

export type Channel = "email" | "phone";
export type Contact = { email: string; countryCode: string; phone: string };
export type Proofs = Partial<Record<Channel, string>>;

const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]*$/u;

// Field rules, mirroring the server's (counsellors router). "" = valid.
export function nameError(v: string): string {
  const t = v.trim();
  if (!t) return "Required";
  if (t.length > 50) return "50 characters at most";
  if (!NAME_RE.test(t)) return "Use letters, spaces, apostrophes or hyphens only";
  return "";
}
export function emailError(v: string): string {
  const t = v.trim();
  if (!t) return "Required";
  if (t.length > 255 || !isValidEmail(t)) return "Enter a valid email address";
  return "";
}
export function phoneError(phone: string, countryCode: string): string {
  if (!phone.trim()) return "Required";
  if (!isValidPhone(phone, countryCode)) {
    return `Enter a ${getExpectedPhoneDigits(countryCode)}-digit mobile number`;
  }
  return "";
}

const valueOf = (c: Contact, ch: Channel) =>
  ch === "email" ? c.email.trim().toLowerCase() : `${c.countryCode}${c.phone.replace(/\D/g, "")}`;

export function ContactVerification({
  contact,
  channels,
  counsellorId,
  proofs,
  onProofs,
}: {
  contact: Contact;
  // Which channels still need verifying (an edit only re-verifies changes).
  channels: Channel[];
  counsellorId?: number;
  proofs: Proofs;
  onProofs: (p: Proofs) => void;
}) {
  const [codes, setCodes] = useState<Record<Channel, string>>({ email: "", phone: "" });
  const [sentFor, setSentFor] = useState<Partial<Record<Channel, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<Channel, string>>>({});
  const [sendError, setSendError] = useState("");
  // The value each proof was issued for; a proof for an old value is dropped.
  const verifiedFor = useRef<Partial<Record<Channel, string>>>({});

  // Latest proofs for back-to-back verifies (dev autopilot verifies both).
  const proofsRef = useRef(proofs);
  proofsRef.current = proofs;

  const send = api.counsellors.sendContactOtp.useMutation();
  const verify = api.counsellors.verifyContactOtp.useMutation();

  const contactValid =
    emailError(contact.email) === "" && phoneError(contact.phone, contact.countryCode) === "";

  // Drop proofs (and sent state) whose value has since been edited.
  const emailNow = valueOf(contact, "email");
  const phoneNow = valueOf(contact, "phone");
  useEffect(() => {
    const next: Proofs = { ...proofs };
    let changed = false;
    for (const ch of ["email", "phone"] as const) {
      if (next[ch] && verifiedFor.current[ch] !== valueOf(contact, ch)) {
        delete next[ch];
        changed = true;
      }
    }
    if (changed) onProofs(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailNow, phoneNow]);

  const pending = channels.filter((ch) => !proofs[ch]);

  async function doVerify(ch: Channel, code: string) {
    setErrors((e) => ({ ...e, [ch]: "" }));
    try {
      const res = await verify.mutateAsync({ ...contact, channel: ch, otp: code });
      verifiedFor.current[ch] = valueOf(contact, ch);
      onProofs({ ...proofsRef.current, [ch]: res.proof });
    } catch (e) {
      setErrors((x) => ({ ...x, [ch]: e instanceof Error ? e.message : "Invalid code" }));
    }
  }
  async function doSend(which: Channel[]) {
    setSendError("");
    try {
      const res = await send.mutateAsync({ ...contact, channels: which, counsellorId });
      const now: Partial<Record<Channel, string>> = {};
      for (const ch of which) if (res.sent[ch]) now[ch] = valueOf(contact, ch);
      setSentFor((s) => ({ ...s, ...now }));
      if (res.error) setSendError(res.error);
      // Dev autopilot: the sandbox code is filled in and checked, so the flow
      // stays visible without reading the server log. Null in production.
      for (const ch of which) {
        const dev = res.devOtp[ch];
        if (dev) {
          setCodes((c) => ({ ...c, [ch]: dev }));
          await doVerify(ch, dev);
        }
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Couldn't send the codes");
    }
  }

  if (channels.length === 0) return null;

  const anySent = channels.some((ch) => sentFor[ch] === valueOf(contact, ch));

  return (
    <div className="rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-[#475467]">
          {pending.length === 0
            ? "Contact details verified."
            : "We'll send a code to the counsellor's " +
              channels.map((c) => (c === "email" ? "email" : "phone")).join(" and ") +
              ". Ask them to read it out to you."}
        </p>
        {pending.length > 0 && (
          <button
            type="button"
            disabled={!contactValid || send.isPending}
            onClick={() => void doSend(pending)}
            className="h-8 rounded-lg border border-[#1570EF] bg-white px-3 text-[12px] font-semibold text-[#1570EF] hover:bg-[#EFF8FF] disabled:opacity-50"
          >
            {send.isPending ? "Sending…" : anySent ? "Resend codes" : "Send verification codes"}
          </button>
        )}
      </div>
      {!contactValid && pending.length > 0 && (
        <p className="mt-2 text-[12px] text-[#98A2B3]">
          Enter a valid email and phone number first.
        </p>
      )}
      {sendError && <p className="mt-2 text-[12px] text-[#F04438]">{sendError}</p>}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {channels.map((ch) => {
          const done = !!proofs[ch];
          const sent = sentFor[ch] === valueOf(contact, ch);
          if (!done && !sent) return null;
          return (
            <div key={ch}>
              <label className="mb-1.5 block text-[13px] font-medium text-[#344054]">
                {ch === "email" ? "Email code" : "Phone code"}{" "}
                <span className="text-[#F04438]">*</span>
              </label>
              {done ? (
                <p className="flex h-[38px] items-center text-[13px] font-semibold text-[#027A48]">
                  ✓ {ch === "email" ? "Email" : "Phone"} verified
                </p>
              ) : (
                <div className="flex gap-2">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={5}
                    value={codes[ch]}
                    onChange={(e) =>
                      setCodes((c) => ({ ...c, [ch]: e.target.value.replace(/\D/g, "") }))
                    }
                    placeholder="5-digit code"
                    className={`h-[38px] w-full rounded-lg border px-3 text-[13px] tracking-[0.2em] outline-none focus:border-[#1570EF] ${errors[ch] ? "border-[#F04438]" : "border-[#D0D5DD]"}`}
                  />
                  <button
                    type="button"
                    disabled={codes[ch].length !== 5 || verify.isPending}
                    onClick={() => void doVerify(ch, codes[ch])}
                    className="h-[38px] shrink-0 rounded-lg bg-[#1570EF] px-3 text-[12px] font-semibold text-white hover:bg-[#1260d4] disabled:opacity-50"
                  >
                    Verify
                  </button>
                </div>
              )}
              {errors[ch] && <p className="mt-1 text-[12px] text-[#F04438]">{errors[ch]}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
