import { canonicalAddressKey as key, type CanonicalAddressInput } from "@openlup/platform/shipping";
export type { CanonicalAddressInput } from "@openlup/platform/shipping";

export function canonicalAddressKey(input: CanonicalAddressInput): string {
  return key(input, "PL");
}
