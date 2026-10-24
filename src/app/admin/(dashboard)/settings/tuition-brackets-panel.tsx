"use client";

import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { DISPLAY_CURRENCIES } from "~/app/admin/(dashboard)/uni-assist/uni-assist-lib";
import { bracketsFor, type BracketConfig } from "~/lib/fx-convert";

const CARD = "rounded-xl border border-[#E4E7EC] bg-white";
const INPUT = "h-9 w-full rounded-lg border border-[#D0D5DD] px-2.5 text-sm outline-none focus:border-[#1570EF]";

// Settings -> Uni Assist Brackets. Super Admin only (the parent hides the
// section and the API refuses everyone else). Breakpoints per currency make
// the Tuition Range dropdown on both Uni Assist pages; fees in other
// currencies are converted with Exchange Rates before they're bracketed.
export function TuitionBracketsPanel({ toast }: { toast: (msg: string) => void }) {
  const utils = api.useUtils();
  const q = api.universities.uniAssistMoney.useQuery();
  const [text, setText] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!q.data) return;
    setText(
      Object.fromEntries(
        DISPLAY_CURRENCIES.map((c) => [c, (q.data.brackets[c] ?? []).join(", ")]),
      ),
    );
  }, [q.data]);

  const saveMut = api.universities.saveTuitionBrackets.useMutation({
    onSuccess: async () => {
      await utils.universities.uniAssistMoney.invalidate();
      void utils.universities.partnerUniAssistMoney.invalidate();
      toast("Tuition brackets saved");
    },
    onError: (e) => toast(e.message),
  });

  const parse = (s: string): number[] | null => {
    const parts = s.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    const nums = parts.map((p) => Number(p.replace(/_/g, "")));
    return nums.every((n) => Number.isFinite(n) && n > 0) ? nums : null;
  };

  const save = () => {
    const config: BracketConfig = {};
    for (const c of DISPLAY_CURRENCIES) {
      const nums = parse(text[c] ?? "");
      if (nums === null) return toast(`${c}: enter whole amounts separated by commas`);
      if (nums.length > 12) return toast(`${c}: at most 12 breakpoints`);
      config[c] = nums;
    }
    saveMut.mutate(config);
  };

  return (
    <div className={CARD}>
      <div className="border-b border-[#E4E7EC] px-5 py-4">
        <h3 className="text-[15px] font-semibold text-[#101828]">Uni Assist tuition brackets</h3>
        <p className="mt-0.5 text-xs text-[#667085]">
          Breakpoints per currency, smallest first. 10000, 20000 gives: under 10,000 ·
          10,000–20,000 · 20,000 and above. Leave a currency empty to offer no brackets in it.
        </p>
      </div>
      <div className="space-y-4 p-5">
        {DISPLAY_CURRENCIES.map((c) => {
          const nums = parse(text[c] ?? "");
          const preview = nums ? bracketsFor({ [c]: nums }, c) : [];
          return (
            <div key={c} className="grid grid-cols-[64px_1fr] items-start gap-3">
              <span className="pt-2 text-sm font-semibold text-[#344054]">{c}</span>
              <div>
                <input
                  value={text[c] ?? ""}
                  onChange={(e) => setText((t) => ({ ...t, [c]: e.target.value }))}
                  placeholder="e.g. 10000, 20000, 30000"
                  className={INPUT}
                />
                <div className={`mt-1 text-[11px] ${nums ? "text-[#667085]" : "text-[#F04438]"}`}>
                  {nums
                    ? preview.length
                      ? preview.map((b) => b.label).join(" · ")
                      : "No brackets"
                    : "Whole amounts separated by commas"}
                </div>
              </div>
            </div>
          );
        })}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saveMut.isPending || !q.data}
            className="h-9 cursor-pointer rounded-lg bg-[#1570EF] px-4 text-sm font-semibold text-white hover:bg-[#1260d4] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveMut.isPending ? "Saving…" : "Save brackets"}
          </button>
        </div>
      </div>
    </div>
  );
}
