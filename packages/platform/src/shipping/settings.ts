/** @experimental Discovery metadata for the host's saved-address callback. */
export const savedAddressValidationSetting = {
  key: "savedAddressValidation",
  domain: "shipping",
  kind: "callback",
  goal: "Customize validation and normalization of the postal code and phone on saved customer addresses.",
  schemaVersion: 1,
  rules: [],
  examples: [],
  fallback: null,
  absentMeans: { description: "The platform uses the standard normalization and validation for the supplied address policy.", source: "shipping address policy", value: null },
  defaultBasis: { kind: "neutral" },
  whyThisDefault: "Hosts can choose address formats required by their delivery integrations while preserving existing behavior by default.",
  effect: {
    appliesTo: "Subsequent saved-address submissions after deployment.",
    frozenOn: ["Existing saved addresses and captured delivery destinations keep their stored values."],
    impact: "customer-promise",
  },
  runtime: { level: "read-only", reason: "The callbacks are executable host code." },
  change: { file: "owned/acquisition-policy.ts", symbol: "savedAddressValidation" },
} as const;
