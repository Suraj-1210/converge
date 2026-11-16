// How a partner is named wherever a student, application or payout shows
// "whose" it is (27 Oct testing), the same on both portals:
//   independent counsellor → the person's name, e.g. "Aishwarya Rai"
//   agency / institution   → "<org name> · <partner type>", e.g. "EduBridge · Agency"
// The partner type comes from organization.type (OrganizationType); a new org
// type gets its label here.

import { OrganizationType, PartnerKindLabel, type PartnerKind } from "~/server/db/enums";

export const ORG_TYPE_LABEL: Record<number, string> = {
  [OrganizationType.AGENCY]: "Agency",
  [OrganizationType.INSTITUTION]: "Institution",
};

// The two org categories by name, for code that passes them around as strings
// (sign-up, the admin partner list, document slots).
export type OrgKind = "agency" | "institution";

export function orgKindOf(type: number | null | undefined): OrgKind {
  return type === OrganizationType.INSTITUTION ? "institution" : "agency";
}

export function orgTypeCode(kind: OrgKind): OrganizationType {
  return kind === "institution" ? OrganizationType.INSTITUTION : OrganizationType.AGENCY;
}

// The partner type on its own, e.g. the Type column of the Partners page.
// `orgKind` defaults to agency for rows that predate the institution type.
export function partnerTypeLabel(kind: "agency" | "independent", orgKind: OrgKind = "agency"): string {
  if (kind === "independent") return "Independent Counsellor";
  return ORG_TYPE_LABEL[orgTypeCode(orgKind)]!;
}

// A partner user's role as the portal names it: "Agency Owner", or for an
// institution "Institution Owner" / "Institution Counsellor".
export function partnerKindLabel(kind: PartnerKind, orgType: number | null | undefined): string {
  if (kind !== "independent" && orgKindOf(orgType) === "institution") {
    return kind === "agency" ? "Institution Owner" : "Institution Counsellor";
  }
  return PartnerKindLabel[kind];
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
