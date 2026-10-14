// Who works a student, as the Students page shows it. counsellor_id holds
// the counsellor, or the owner's own id when the owner keeps the student
// ("You"); null means nobody has been picked yet ("Unassigned"). An agency
// with no active counsellors has nobody to route to, so its students read
// as the owner's rather than as a backlog.

export interface Viewer {
  id: number;
  kind: "agency" | "counsellor" | "independent";
  // Owner only: whether the agency has an active counsellor to assign to.
  hasCounsellors: boolean;
}

export interface AssignableStudent {
  id: number;
  firstName: string;
  lastName: string;
  counsellorId: number | null;
  counsellorName: string | null;
}

export type Assignee =
  | { kind: "you" }
  | { kind: "unassigned" }
  | { kind: "person"; id: number; name: string };

export function assigneeOf(s: AssignableStudent, viewer: Viewer): Assignee {
  if (s.counsellorId === null) {
    return viewer.kind === "agency" && !viewer.hasCounsellors
      ? { kind: "you" }
      : { kind: "unassigned" };
  }
  if (s.counsellorId === viewer.id) return { kind: "you" };
  return {
    kind: "person",
    id: s.counsellorId,
    name: s.counsellorName ?? "Former counsellor",
  };
}

export const studentName = (s: { firstName: string; lastName: string }) =>
  `${s.firstName} ${s.lastName}`.trim();

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

// "a, b and c"
export function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
