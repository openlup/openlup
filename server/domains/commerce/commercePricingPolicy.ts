import { CommercePricingPolicyRequestError, CommercePricingPolicyUnavailableError } from "@openlup/platform/pricing";
export { CommercePricingPolicyUnavailableError, PRICING_POLICY_REQUEST_REASONS, CommercePricingPolicyRequestError, mapPricingPolicyFailure } from "@openlup/platform/pricing";
export type { PricingPolicyRequestReason, SafePricingPolicyReason, PricingPolicyFailureMapping } from "@openlup/platform/pricing";

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

function snapshot(resolved: ReturnType<typeof resolvePricingPolicy>): PricingPolicySnapshot {
  return {
    offerPolicyVersion: resolved.offerPolicyVersion,
    promotionEngineVersion: resolved.promotionEngineVersion,
    pricingPolicyToken: resolved.pricingPolicyToken!,
  };
}
