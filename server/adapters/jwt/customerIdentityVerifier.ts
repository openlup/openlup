import { createCustomerIdentityVerifier as create } from "@openlup/platform/identity";
export function createCustomerIdentityVerifier(config: Parameters<typeof create>[0]) {
  return create(config, () => import("jose"));
}
