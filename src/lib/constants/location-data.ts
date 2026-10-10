// Countries, states and cities are no longer hardcoded here: they come from the
// geo_* master list tables through the `geo` tRPC router (see src/server/geo.ts).

export const countryCodes = [
  { value: "+91", label: "+91" },
  { value: "+1", label: "+1" },
  { value: "+44", label: "+44" },
  { value: "+971", label: "+971" },
  { value: "+61", label: "+61" },
  { value: "+65", label: "+65" },
];

export const counselorRanges = ["1 - 5", "6 - 10", "11 - 15", "16 - 25", "25+"];
export const volumeRanges = ["1 - 25", "26 - 50", "51 - 100", "101 - 250", "250+"];
