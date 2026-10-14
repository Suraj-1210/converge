// How Collegepond's side of a partner relationship is named.
//
// RELATIONSHIP_MANAGER_LABEL is what partners see for the Collegepond staff
// member who owns their account. Internally (admin screens, roles, code) that
// person is a BDM; partner-facing screens and emails never say "BDM" or
// "Business Development Manager".
//
// Loyalty tiers are not here: they live in the Partner Tiers master
// (Settings -> Partner Tiers; src/server/partner-tiers.ts).

export const RELATIONSHIP_MANAGER_LABEL = "Relationship Manager";
