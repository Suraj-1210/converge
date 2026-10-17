import "server-only";
import { type Prisma } from "../../generated/prisma";
import { db } from "~/server/db";
import { STUDENT_DOC_TYPES, UniApplicationStatus, studentDocSlot } from "~/server/db/enums";

// The documents a Collegepond counsellor names when moving an application to
// Documents Pending (application.pending_docs). Each item is a standard
// student document type, or "other" with a free-text label. Uploading a
// document of that type for the student ticks the item off on every
// application waiting for it; an "other" item is ticked by uploading against
// it from the partner's application card (or by a counsellor by hand).
// Reaching all-received does not move the stage: Collegepond does that.

export interface PendingDoc {
  id: number;
  key: string; // STUDENT_DOC_TYPES key, or "other"
  label: string;
  receivedAt: string | null;
}

export interface PendingDocInput {
  key: string;
  label?: string | null;
}

export const PENDING_DOC_OTHER = "other";

export function parsePendingDocs(v: unknown): PendingDoc[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: unknown) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    if (typeof o.id !== "number" || typeof o.key !== "string" || typeof o.label !== "string") return [];
    return [
      {
        id: o.id,
        key: o.key,
        label: o.label,
        receivedAt: typeof o.receivedAt === "string" ? o.receivedAt : null,
      },
    ];
  });
}

const toJson = (docs: PendingDoc[]) => docs as unknown as Prisma.InputJsonValue;

// Builds the new list from the counsellor's picks, keeping the id and
// received state of items that were already on it. Throws on an unknown key
// or an "other" without a label.
export function buildPendingDocs(previous: PendingDoc[], picks: PendingDocInput[]): PendingDoc[] {
  let nextId = previous.reduce((m, d) => Math.max(m, d.id), 0) + 1;
  const out: PendingDoc[] = [];
  const seen = new Set<string>();
  for (const p of picks) {
    let key: string;
    let label: string;
    if (p.key === PENDING_DOC_OTHER) {
      label = (p.label ?? "").trim().slice(0, 120);
      if (!label) throw new Error("Describe the other document");
      key = PENDING_DOC_OTHER;
    } else {
      const t = STUDENT_DOC_TYPES.find((d) => d.key === p.key);
      if (!t) throw new Error("Unknown document type");
      key = t.key;
      label = t.label;
    }
    const dedupe = `${key}|${label.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const prev = previous.find((d) => d.key === key && d.label.toLowerCase() === label.toLowerCase());
    out.push(prev ?? { id: nextId++, key, label, receivedAt: null });
  }
  return out;
}

export async function savePendingDocs(applicationId: number, docs: PendingDoc[]) {
  await db.application.update({
    where: { id: applicationId },
    data: { pending_docs: toJson(docs) },
  });
}

export interface TickResult {
  applicationId: number;
  university: string;
  ticked: string[];
  allReceived: boolean;
}

// After a student document upload: tick matching items on the student's
// applications that are at Documents Pending. `item` targets one specific
// item (an "other" document uploaded against it from the application card).
export async function tickPendingDocs(
  studentId: number,
  docType: string,
  item?: { applicationId: number; itemId: number } | null,
): Promise<TickResult[]> {
  const apps = await db.application.findMany({
    where: { student_id: studentId, status: UniApplicationStatus.DOCUMENTS_PENDING },
    select: { id: true, pending_docs: true, course: { select: { university: { select: { name: true } } } } },
  });
  const slot = studentDocSlot(docType);
  const now = new Date().toISOString();
  const results: TickResult[] = [];
  for (const a of apps) {
    const docs = parsePendingDocs(a.pending_docs);
    if (docs.length === 0) continue;
    const ticked: string[] = [];
    for (const d of docs) {
      if (d.receivedAt) continue;
      const targeted = item?.applicationId === a.id && item.itemId === d.id;
      if (targeted || (d.key !== PENDING_DOC_OTHER && d.key === slot)) {
        d.receivedAt = now;
        ticked.push(d.label);
      }
    }
    if (ticked.length === 0) continue;
    await savePendingDocs(a.id, docs);
    results.push({
      applicationId: a.id,
      university: a.course.university.name,
      ticked,
      allReceived: docs.every((d) => d.receivedAt),
    });
  }
  return results;
}
