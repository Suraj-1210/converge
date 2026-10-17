// Per-student application totals, e.g. "3 applications · 1 rejected", for the
// admin and partner student pages. Every application stays listed there;
// closed ones (status >= 20) are counted by outcome rather than hidden.

import { UniApplicationStatus } from "~/server/db/enums";

export const isClosedApplication = (status: number) => status >= 20;

// Short outcome words for the totals line.
const CLOSED_WORD: Record<number, string> = {
  [UniApplicationStatus.REJECTED_BY_UNIVERSITY]: "rejected",
  [UniApplicationStatus.APPLICATION_WITHDRAWAL]: "withdrawn",
  [UniApplicationStatus.DECLINED_BY_STUDENT]: "declined",
  [UniApplicationStatus.VISA_REJECTED]: "visa rejected",
  [UniApplicationStatus.DEFERRED_TO_NEXT_INTAKE]: "deferred",
  [UniApplicationStatus.COURSE_CLOSED]: "course closed",
};

export function applicationSummary(apps: { status: number }[]): string {
  const parts = [`${apps.length} application${apps.length === 1 ? "" : "s"}`];
  const counts = new Map<string, number>();
  for (const a of apps) {
    if (!isClosedApplication(a.status)) continue;
    const word = CLOSED_WORD[a.status] ?? "closed";
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  for (const [word, n] of counts) parts.push(`${n} ${word}`);
  return parts.join(" · ");
}

// In-progress first, closed after; each group keeps its incoming order.
export function splitByClosed<T extends { status: number }>(apps: T[]) {
  return {
    open: apps.filter((a) => !isClosedApplication(a.status)),
    closed: apps.filter((a) => isClosedApplication(a.status)),
  };
}
