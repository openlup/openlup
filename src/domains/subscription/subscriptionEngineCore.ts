import {
  createInitialSubscriptionCheckoutModel as createCoreInitialSubscriptionCheckoutModel,
  editCutoffAt,
  findDueSubscriptions,
  isEditWindowOpen,
  isRenewalDue,
  planSubscriptionCycle,
} from "@openlup/core/subscription";
import type {
  CreateInitialSubscriptionCheckoutInput,
  InitialSubscriptionCheckoutModel,
  SubscriptionEngineResult,
} from "./subscriptionEngineTypes.js";

export {
  editCutoffAt,
  findDueSubscriptions,
  isEditWindowOpen,
  isRenewalDue,
  planSubscriptionCycle,
};

/**
 * First-party subscription-create input. Unlike the private engine core it wraps,
 * this shim REQUIRES an explicit `timezone`: the engine is locale-neutral and
 * "does not know the country", so the market zone is named by the composition
 * root (`DELIVERY_DISPATCH_POLICY.timeZone` in the deployment overlay) — exactly as
 * `deliveryEstimate.ts` requires its dispatch `policy` and refuses a default.
 */
export type CreateInitialSubscriptionCheckoutAppInput = Omit<
  CreateInitialSubscriptionCheckoutInput,
  "timezone"
> & { timezone: string };

export function createInitialSubscriptionCheckoutModel(
  input: CreateInitialSubscriptionCheckoutAppInput,
): SubscriptionEngineResult<InitialSubscriptionCheckoutModel> {
  // No silent market-zone fallback: the caller-supplied zone passes straight
  // through, so the core never has to guess a market.
  return createCoreInitialSubscriptionCheckoutModel(input);
}
