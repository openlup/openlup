export { DEFAULT_EDIT_WINDOW_HOURS } from "@openlup/core/subscription";
export type {
  CreateInitialSubscriptionCheckoutInput,
  CycleMutationResult,
  EngineCycle,
  EngineEvent,
  EngineSubscription,
  InitialSubscriptionCheckoutModel,
  PlanCycleInput,
  SubscriptionEngineErrorCode,
  SubscriptionEngineResult,
  SubscriptionMutationResult,
} from "@openlup/core/subscription";

/**
 * @deprecated The subscription engine no longer defaults the timezone. First-party
 * composition roots must pass an explicit IANA zone — the deployment overlay
 * sources it from `DELIVERY_DISPATCH_POLICY.timeZone` in `src/data/deliveryPolicy.ts` — mirroring
 * the required-`policy` seam in `deliveryEstimate.ts` (the engine "does not know
 * the country"). Retained only so any external importer keeps compiling; nothing
 * first-party reads it any more.
 */
export const DEFAULT_TIMEZONE = "Europe/Warsaw";
