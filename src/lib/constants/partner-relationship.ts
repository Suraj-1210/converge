// How Collegepond's side of a partner relationship is named and tiered.
//
// RELATIONSHIP_MANAGER_LABEL is what partners see for the Collegepond staff
// member who owns their account. Internally (admin screens, roles, code) that
// person is a BDM; partner-facing screens and emails never say "BDM" or
// "Business Development Manager".
//
// PARTNER_TIERS is the loyalty ladder. A partner's tier is `user.tier`
// (0 = Silver … 4 = Diamond) on the agency owner or independent counsellor,
// set by Collegepond on the admin Partners drawer. It is never derived from
// student counts: thresholds and targets haven't been decided, so nothing
// here promises an automatic upgrade.

export const RELATIONSHIP_MANAGER_LABEL = "Relationship Manager";

export type PartnerTier = {
  name: string;
  icon: string;
  // Badge palette (the admin Partners list's).
  bg: string;
  fg: string;
  perks: readonly string[];
};

export const PARTNER_TIERS: readonly PartnerTier[] = [
  {
    name: "Silver",
    icon: "🥈",
    bg: "#F2F4F7",
    fg: "#344054",
    perks: ["Standard Application Processing", "Email Support"],
  },
  {
    name: "Gold",
    icon: "🥇",
    bg: "#ECFDF3",
    fg: "#027A48",
    perks: ["Priority Application Processing", "Dedicated Support", "Quarterly Webinars"],
  },
  {
    name: "Platinum",
    icon: "🏆",
    bg: "#FFFAEB",
    fg: "#B54708",
    perks: [
      "Priority Processing",
      `Priority access to your ${RELATIONSHIP_MANAGER_LABEL}`,
      "Training & Webinars",
      "Early University Access",
    ],
  },
  {
    name: "Titanium",
    icon: "⚡",
    bg: "#F9F5FF",
    fg: "#6941C6",
    perks: [
      "Priority Processing",
      `Priority access to your ${RELATIONSHIP_MANAGER_LABEL}`,
      "Exclusive Training",
      "Early Access",
      "Sponsored Events",
    ],
  },
  {
    name: "Diamond",
    icon: "💎",
    bg: "#EFF8FF",
    fg: "#1570EF",
    perks: [
      "Priority Application Processing",
      `Priority access to your ${RELATIONSHIP_MANAGER_LABEL}`,
      "Exclusive Training & Webinars",
      "Early Access to New Universities",
      "Sponsored Events & Fam Trips",
    ],
  },
];

export const PARTNER_TIER_NAMES = PARTNER_TIERS.map((t) => t.name);

// user.tier → its tier, clamping anything out of range (the column is a raw
// unsigned tinyint) to the nearest end of the ladder.
export function partnerTier(tier: number): PartnerTier {
  const i = Math.max(0, Math.min(PARTNER_TIERS.length - 1, Math.trunc(tier)));
  return PARTNER_TIERS[i]!;
}
