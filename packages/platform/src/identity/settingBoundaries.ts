/** @experimental Informational catalogue entries owned by identity. */
export const identitySettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["magicLinkRegistration", "cap", "Register a new account through a magic link.", "The native sign-in port admits existing accounts only."],
];
