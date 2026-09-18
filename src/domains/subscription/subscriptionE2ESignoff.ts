// Model B subscription E2E sign-off gate (Wave-G pattern, dedicated to the
// subscription_initial lifecycle so it does not perturb the PSP-payment sign-off
// in src/domains/payment/sandboxE2ESignoff.ts).
//
// Each case is verified end-to-end on the hidden preview (checkout -> charge ->
// webhook -> subscription active + cycle paid + mandate bound), with triple-sided
// evidence: a provider proof (Stripe PI / Tpay simulator event) AND a local-DB proof
// (subscriptions.status='active', cycle #1 paid, payment_method_ref bound, coupon
// redemption). Public subscription activation stays blocked until every required
// case is `passed` WITH both evidence fields populated. The committed
// docs/evidence/.../signoff-input.json is the source of truth, validated by
// subscriptionE2ESignoff.test.ts.

export const SUBSCRIPTION_E2E_CASES = [
  "subscription_initial_card_stripe",
  "subscription_initial_blik_tpay",
  "subscription_coupon_applied",
  "subscription_awaiting_mandate_two_event",
  "subscription_declined_first_charge_swept",
] as const;

export type SubscriptionE2ECase = (typeof SUBSCRIPTION_E2E_CASES)[number];

export type SubscriptionE2ECaseStatus = "not_run" | "failed" | "passed";

export type SubscriptionE2ECaseEvidence = {
  caseId: SubscriptionE2ECase;
  status: SubscriptionE2ECaseStatus;
  // Provider-side proof: Stripe PaymentIntent id (succeeded, customer, setup_future_usage)
  // or the Tpay simulator event ids / PAYID alias.
  providerEvidence: string | null;
  // Local-DB proof captured via the service-role client: subscription id + status,
  // cycle id + status, bound payment_method_ref, next_cycle_at, promotion_redemption.
  localDatabaseEvidence: string | null;
  notes?: string | null;
};

export type SubscriptionE2ESignoffInput = {
  cases: SubscriptionE2ECaseEvidence[];
  publicActivationRequested: boolean;
};

export type SubscriptionE2ESignoffDecision = {
  readyForPublicActivationPlan: boolean;
  missingCases: SubscriptionE2ECase[];
  failedCases: SubscriptionE2ECase[];
  missingEvidenceCases: SubscriptionE2ECase[];
  reasons: string[];
};

export function evaluateSubscriptionE2ESignoff(
  input: SubscriptionE2ESignoffInput,
): SubscriptionE2ESignoffDecision {
  const byCase = new Map(input.cases.map((entry) => [entry.caseId, entry]));

  const missingCases = SUBSCRIPTION_E2E_CASES.filter((caseId) => !byCase.has(caseId));
  const failedCases = SUBSCRIPTION_E2E_CASES.filter((caseId) => {
    const entry = byCase.get(caseId);
    return entry?.status === "failed" || entry?.status === "not_run";
  });
  const missingEvidenceCases = SUBSCRIPTION_E2E_CASES.filter((caseId) => {
    const entry = byCase.get(caseId);
    if (!entry || entry.status !== "passed") return false;
    return !entry.providerEvidence?.trim() || !entry.localDatabaseEvidence?.trim();
  });

  const reasons = [
    ...missingCases.map((caseId) => `${caseId}: subscription E2E evidence missing`),
    ...failedCases.map((caseId) => `${caseId}: subscription E2E not passed`),
    ...missingEvidenceCases.map((caseId) => `${caseId}: provider + local DB evidence required`),
  ];

  if (input.publicActivationRequested && reasons.length > 0) {
    reasons.push("public subscription activation is blocked until every subscription E2E case passes with evidence");
  }

  return {
    readyForPublicActivationPlan: reasons.length === 0,
    missingCases,
    failedCases,
    missingEvidenceCases,
    reasons,
  };
}
