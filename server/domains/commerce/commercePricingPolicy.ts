import {
  OFFER_POLICY_V2,
  type PricingPolicySnapshot,
  type PricingPolicyRequest,
} from "../../../src/domains/commerce/offerPolicyContracts.js";
import {
  offerPolicyV1FallbackDisabled,
  offerPolicyV2Enabled,
  offerPolicyV2RolloutBps,
  pricingPolicyTokenSecret,
} from "../../_lib/config/featureFlags.js";
import { resolvePricingPolicy } from "./pricingPolicyToken.js";
import {
  readOfferPolicyV2Readiness,
  type OfferPolicyReadinessPort,
} from "./offerPolicyReadiness.js";

/** Server authority for quote/checkout assignment. Missing config is legacy v1. */
export async function resolveCommercePricingPolicy<T extends object>(request: T & {
  visitorId?: string;
  pricingPolicy?: PricingPolicyRequest;
}, readinessPort?: OfferPolicyReadinessPort): Promise<PricingPolicySnapshot | undefined> {
  const v1FallbackDisabled = offerPolicyV1FallbackDisabled();
  // Exact legacy compatibility: old/no-capability requests do not gain fields.
  if (!request.pricingPolicy?.capability && !request.pricingPolicy?.token) {
    if (v1FallbackDisabled) throw new CommercePricingPolicyRequestError("v2_capability_required");
    return undefined;
  }
  const secret = pricingPolicyTokenSecret();
  // Rollback compatibility is literal: without signing/verification authority
  // the response must look exactly like the pre-policy v1 contract.
  if (!secret) {
    if (v1FallbackDisabled) throw new CommercePricingPolicyUnavailableError("signing_secret_unavailable");
    return undefined;
  }
  const common = {
    assignmentKey: request.visitorId,
    capability: request.pricingPolicy?.capability,
    token: request.pricingPolicy?.token,
    secret,
  };
  // Honor a valid bound token before touching readiness. An outage may stop new
  // v2 assignments, but cannot change a policy already accepted by a customer.
  const existing = resolvePricingPolicy({ ...common, v2Enabled: false, rolloutBps: 0 });
  const refreshObsoleteAssignment = Boolean(
    v1FallbackDisabled &&
    existing.pricingPolicyToken &&
    existing.offerPolicyVersion !== OFFER_POLICY_V2 &&
    request.pricingPolicy?.capability === OFFER_POLICY_V2,
  );
  if (existing.pricingPolicyToken && !refreshObsoleteAssignment) {
    if (v1FallbackDisabled && existing.offerPolicyVersion !== OFFER_POLICY_V2) {
      throw new CommercePricingPolicyUnavailableError("v1_assignment_rejected");
    }
    return snapshot(existing);
  }

  const assignmentEnabled = offerPolicyV2Enabled();
  const canRequestAssignment = assignmentEnabled && Boolean(
    request.visitorId && request.pricingPolicy?.capability,
  );
  const readiness = canRequestAssignment && readinessPort
    ? await readOfferPolicyV2Readiness(readinessPort)
    : null;
  const rolloutBps = offerPolicyV2RolloutBps();
  if (v1FallbackDisabled) {
    // Attribute the refusal before reporting it. What the caller failed to send
    // is the caller's problem and must never be published as an upstream
    // outage; only the two conditions below it describe a server that cannot
    // price, which is what the production alert on this route is for.
    if (!request.pricingPolicy?.capability) {
      throw new CommercePricingPolicyRequestError("v2_capability_required");
    }
    if (!request.visitorId) {
      throw new CommercePricingPolicyRequestError("v2_visitor_id_required");
    }
    if (!assignmentEnabled || rolloutBps !== 10_000) {
      throw new CommercePricingPolicyUnavailableError("v2_assignment_config_invalid");
    }
    if (!readiness?.ready) {
      throw new CommercePricingPolicyUnavailableError("v2_readiness_not_ready");
    }
  }
  const resolved = resolvePricingPolicy({
    ...common,
    // An obsolete but authentic draft assignment proves the visitor binding,
    // not permission to keep obsolete pricing. Once every hard-cutover guard
    // above is green, discard it and issue only a fresh current-policy token.
    ...(refreshObsoleteAssignment ? { token: undefined } : {}),
    v2Enabled: assignmentEnabled,
    rolloutBps: readiness?.ready ? rolloutBps : 0,
  });
  // A bound historical assignment is honored even while the rollout flag is
  // off. Otherwise only an enabled cohort receives a policy field; emitting an
  // unbound v1 snapshot during rollback would create a client render loop and
  // a false checkout drift.
  if (v1FallbackDisabled && resolved.offerPolicyVersion !== OFFER_POLICY_V2) {
    throw new CommercePricingPolicyUnavailableError("v1_assignment_rejected");
  }
  return resolved.pricingPolicyToken ? snapshot(resolved) : undefined;
}

/** The server cannot assign a policy right now. Caller-independent: retrying an
 * identical request only succeeds once production configuration changes. */
export class CommercePricingPolicyUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super("commerce_pricing_policy_v2_unavailable");
    this.name = "CommercePricingPolicyUnavailableError";
  }
}

/**
 * Every reason a caller-side refusal can carry. ⛔ Each one answers `400`, which
 * puts it outside every 5xx monitor, so each one owes a dedicated Axiom monitor
 * of its own - `scripts/axiom-bff-observability-lib.test.ts` reads this tuple and
 * fails when a reason has none. Adding a member here without adding a monitor is
 * the exact regression this tuple exists to make impossible: `#3275` reclassified
 * `v2_capability_required` from `503` to `400` and silently took the only alert
 * on a site-wide unpriceable-quote outage with it.
 */
export const PRICING_POLICY_REQUEST_REASONS = [
  "v2_capability_required",
  "v2_visitor_id_required",
] as const;

export type PricingPolicyRequestReason = (typeof PRICING_POLICY_REQUEST_REASONS)[number];

/** The request itself lacks the context a v2 assignment needs. Caller-fixable,
 * and never evidence that pricing is down. The reason is typed off
 * PRICING_POLICY_REQUEST_REASONS so a new one cannot skip its monitor. */
export class CommercePricingPolicyRequestError extends Error {
  constructor(public readonly reason: PricingPolicyRequestReason) {
    super("commerce_pricing_policy_v2_request_invalid");
    this.name = "CommercePricingPolicyRequestError";
  }
}

export type SafePricingPolicyReason =
  | "v2_capability_required"
  | "v2_visitor_id_required"
  | "signing_secret_unavailable"
  | "v1_assignment_rejected"
  | "v2_assignment_config_invalid"
  | "v2_readiness_not_ready"
  | "other";

const SAFE_PRICING_POLICY_REASONS = new Set<SafePricingPolicyReason>([
  "v2_capability_required",
  "v2_visitor_id_required",
  "signing_secret_unavailable", // gitleaks:allow — closed-set diagnostic code, never a credential
  "v1_assignment_rejected",
  "v2_assignment_config_invalid",
  "v2_readiness_not_ready",
  "other",
]);

export interface PricingPolicyFailureMapping {
  code: "BAD_REQUEST" | "UPSTREAM_UNAVAILABLE";
  details: {
    reason: "pricing_policy_request_invalid" | "pricing_policy_unavailable";
    stage: "pricing_policy";
    policyReason: SafePricingPolicyReason;
  };
}

/**
 * Single owner of the status a pricing-policy refusal earns, shared by every
 * route that resolves one. A caller-attributable gap answers `400`; only a
 * server that genuinely cannot price answers `503`, so a `503` on these routes
 * stays a truthful outage signal.
 */
export function mapPricingPolicyFailure(error: unknown): PricingPolicyFailureMapping | null {
  const caller = error instanceof CommercePricingPolicyRequestError;
  if (!caller && !(error instanceof CommercePricingPolicyUnavailableError)) return null;
  return {
    code: caller ? "BAD_REQUEST" : "UPSTREAM_UNAVAILABLE",
    details: {
      reason: caller ? "pricing_policy_request_invalid" : "pricing_policy_unavailable",
      stage: "pricing_policy",
      policyReason: safePricingPolicyReason((error as { reason: unknown }).reason),
    },
  };
}

function safePricingPolicyReason(value: unknown): SafePricingPolicyReason {
  return SAFE_PRICING_POLICY_REASONS.has(value as SafePricingPolicyReason)
    ? value as SafePricingPolicyReason
    : "other";
}

function snapshot(resolved: ReturnType<typeof resolvePricingPolicy>): PricingPolicySnapshot {
  return {
    offerPolicyVersion: resolved.offerPolicyVersion,
    promotionEngineVersion: resolved.promotionEngineVersion,
    pricingPolicyToken: resolved.pricingPolicyToken!,
  };
}
