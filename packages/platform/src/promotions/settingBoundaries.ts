/** @experimental Informational catalogue entries owned by promotions. */
export const promotionsSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["freeShippingBasis", "cap", "Choose the subtotal basis for free shipping.", "Native threshold decisions use a fixed basis."],
  ["promotionCompatibilityGroups", "cap", "Combine promotion codes using compatibility groups.", "The adjustment engine needs additional combination rules."],
];
