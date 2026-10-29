/** The server cannot assign a policy right now. Caller-independent: retrying an
 * identical request may succeed after server-side configuration or readiness changes. */
export class CommercePricingPolicyUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super("commerce_pricing_policy_v2_unavailable");
    this.name = "CommercePricingPolicyUnavailableError";
  }
}

/**
 * Every reason a caller-side refusal can carry. ⛔ Each one answers `400`, which
 * puts it outside every 5xx monitor, so each one owes a dedicated host monitor.
 * A host observability check can compare this tuple with its configured monitors;
 * the tuple itself does not install or verify those monitors. Adding a member
 * here without adding a monitor is the regression this tuple lets a host check
 * for: reclassifying `v2_capability_required` from `503` to `400` once silently
 * removed the only alert on a site-wide unpriceable-quote outage.
 */
export const PRICING_POLICY_REQUEST_REASONS = [
  "v2_capability_required",
  "v2_visitor_id_required",
] as const;

export type PricingPolicyRequestReason = (typeof PRICING_POLICY_REQUEST_REASONS)[number];

/** The request itself lacks the context a v2 assignment needs. Caller-fixable,
 * and never evidence that pricing is down. The reason is typed off
 * PRICING_POLICY_REQUEST_REASONS so a host observability check can include it. */
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

