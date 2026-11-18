/** @experimental Informational catalogue entries owned by account-support. */
export const account_supportSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["recoverableAdministration", "invariant", "Keep at least one active human administrator.", "The last human administrator is required for recoverable administration."],
];
