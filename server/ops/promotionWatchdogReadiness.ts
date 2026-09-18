import type { AlertDecision } from "../../src/domains/platform/observabilityContracts.js";

type PromotionReadinessDecision = {
  dedupeKey: string;
  payload?: Record<string, unknown>;
};

/**
 * Payment providers that never reach an external PSP (see
 * `server/domains/payment/paymentAdapterRegistry.ts`). No money leaves the
 * platform for them, so no PSP can ever emit a trusted provider event.
 */
const NO_OP_PAYMENT_PROVIDERS: ReadonlySet<string> = new Set([
  "hidden_rehearsal",
  "noop_payment",
]);

/**
 * The only Canonical Order Money mismatch codes a no-op provider *structurally*
 * implies: without a PSP there is nothing to emit a trusted success event, and
 * settlement status is the evaluator's own non-confirmed diagnostic code. Every
 * other code (amounts, headers, invoices, promotion adjustments) still proves
 * real drift and keeps the readiness verdict fail-closed.
 */
const NO_OP_PROVIDER_IMPLIED_MISMATCH_CODES: ReadonlySet<string> = new Set([
  "trusted_provider_event_missing",
  "provider_settlement_status",
]);

export function promotionWatchdogReady(input: {
  environment: string;
  healthEnabled: boolean;
  claimSweepEnabled: boolean;
  decisions: readonly PromotionReadinessDecision[];
}): boolean {
  if (!input.healthEnabled || !input.claimSweepEnabled) return false;
  return !input.decisions.some((decision) => {
    if (decision.dedupeKey.startsWith("promotion_code_")) return true;
    if (decision.dedupeKey.endsWith(":promotion-claim-sweep")) return true;
    if (!decision.dedupeKey.startsWith("canonical_order_money_mismatch:")) return false;
    return !isStagingSyntheticCanonicalMoneyDecision(input.environment, decision);
  });
}

export function isStagingSyntheticCanonicalMoneyDecision(
  environment: string,
  decision: PromotionReadinessDecision,
): boolean {
  if (environment !== "staging") return false;
  if (!decision.dedupeKey.startsWith("canonical_order_money_mismatch:")) return false;
  const payload = decision.payload;
  if (!payload) return false;
  const provider = payload.paymentProvider;
  const providerAbsent = provider === null || provider === undefined;
  // Fixture namespace: rows planted directly by smoke provisioning, which carry
  // no payment attempt at all. Every mismatch family on them stays diagnostic.
  if (typeof payload.orderRef === "string" && payload.orderRef.startsWith("HP-")) {
    return providerAbsent || (typeof provider === "string" && NO_OP_PAYMENT_PROVIDERS.has(provider));
  }
  // Rehearsal checkouts run the real checkout, so they get ordinary `OPENLUP-*`
  // order numbers — the reference namespace cannot identify them. Their no-op
  // provider can, but only for the mismatch codes that provider shape implies;
  // anything else on the same order still blocks promotion readiness.
  return typeof provider === "string"
    && NO_OP_PAYMENT_PROVIDERS.has(provider)
    && hasOnlyNoOpProviderImpliedMismatches(payload.mismatchCodes);
}

function hasOnlyNoOpProviderImpliedMismatches(rawCodes: unknown): boolean {
  // Absent evidence is not proof of a synthetic shape: stay fail-closed.
  if (!Array.isArray(rawCodes) || rawCodes.length === 0) return false;
  return rawCodes.every((code) =>
    typeof code === "string" && NO_OP_PROVIDER_IMPLIED_MISMATCH_CODES.has(code));
}

export function normalizeStagingSyntheticMoneyDecision(
  environment: string,
  decision: AlertDecision,
): AlertDecision {
  if (!isStagingSyntheticCanonicalMoneyDecision(environment, decision)) return decision;
  return {
    ...decision,
    severity: "p3",
    paging: "never",
    title: "Staging synthetic canonical money fixture",
    message: `${decision.payload?.orderRef ?? decision.dedupeKey} is a known staging synthetic money fixture.`,
    payload: {
      ...decision.payload,
      stagingSyntheticFixture: true,
      originalSeverity: decision.severity,
      originalPaging: decision.paging ?? "default",
    },
  };
}

export function createStagingSyntheticMoneyDecisionNormalizer(environment: string) {
  return (decision: AlertDecision): AlertDecision =>
    normalizeStagingSyntheticMoneyDecision(environment, decision);
}
