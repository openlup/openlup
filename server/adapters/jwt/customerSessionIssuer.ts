import { createCustomerSessionIssuer as create } from "@openlup/platform/identity";
export type { CustomerSessionIssuerConfig } from "@openlup/platform/identity";
export function createCustomerSessionIssuer(config: Parameters<typeof create>[0]) {
  return create(config, () => import("jose"));
}
