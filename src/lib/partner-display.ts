// How a partner is named wherever a student, application or payout shows
// "whose" it is (27 Oct testing), the same on both portals:
//   independent counsellor → the person's name, e.g. "Aishwarya Rai"
//   agency                 → "<org name> · <partner type>", e.g. "EduBridge · Agency"
// organization.type has a single value today (OrganizationType.AGENCY), so the
// type reads "Agency"; a new org type gets its label here.

import { OrganizationType } from "~/server/db/enums";

export const ORG_TYPE_LABEL: Record<number, string> = {
  [OrganizationType.AGENCY]: "Agency",
};

// The partner type on its own, e.g. the Type column of the Partners page.
export function partnerTypeLabel(kind: "agency" | "independent"): string {
  return kind === "agency" ? ORG_TYPE_LABEL[OrganizationType.AGENCY]! : "Independent Counsellor";
}

type Person = { first_name: string; last_name: string } | null | undefined;
type Org = { name: string; type?: number | null } | null | undefined;

const personName = (p: Person) => (p ? `${p.first_name} ${p.last_name}`.trim() : "");

// `org` is the student's (or application's) organization; `person` is the
// independent counsellor who owns it (student.created_by) when there's no org.
export function partnerLabel(org: Org, person: Person): string {
  if (org) return `${org.name} · ${ORG_TYPE_LABEL[org.type ?? OrganizationType.AGENCY] ?? "Agency"}`;
  return personName(person) || "Independent Counsellor";
}

// Just the name (an org's name, or the independent's): for filters and pickers
// that already group by type.
export function partnerName(org: Org, person: Person): string {
  return org?.name ?? (personName(person) || "Independent Counsellor");
}
