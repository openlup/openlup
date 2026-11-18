/** @experimental Informational catalogue entries owned by catalog. */
export const catalogSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["optionalGtin", "cap", "Use catalogue SKUs that have no GTIN.", "Native catalogue identities require a GTIN."],
  ["netContentUnits", "cap", "Represent product net contents in units other than grams.", "The catalogue read envelope uses grams for net contents."],
  ["additionalMediaFormats", "cap", "Accept additional catalogue media formats.", "The media contract admits a fixed set of validated formats."],
];
