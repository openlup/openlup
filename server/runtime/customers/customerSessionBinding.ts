import { resolveCustomerSessionBinding as resolve } from "@openlup/platform/identity";
export { createCapturedCustomerChallengeDelivery } from "@openlup/platform/identity";
export type { CapturedCustomerChallenge, CustomerSessionBinding } from "@openlup/platform/identity";
export function resolveCustomerSessionBinding(env: Parameters<typeof resolve>[0], options: Parameters<typeof resolve>[1] = {}) {
  return resolve(env, { loadJwt: () => import("jose"), ...options });
}
