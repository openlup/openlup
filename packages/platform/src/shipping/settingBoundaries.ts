/** @experimental Informational catalogue entries owned by shipping. */
export const shippingSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["addressRegions", "cap", "Support optional postal codes and address regions.", "The native address contract requires a postal code and has no region field."],
  ["paymentMethodPreferences", "cap", "Save additional payment method preferences.", "The customer preferences contract has a fixed payment method vocabulary."],
];
