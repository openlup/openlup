import {
  createStripeSandboxPaymentExecutionAdapter,
  stripePaymentCapabilities,
} from "@openlup/platform/payments/stripe";
import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import { createStripeApiClient } from "../../infra/stripe/stripeApiClient.js";
import {
  assertStripeKeyMode,
  type StripeKeyMode,
} from "../../infra/providerReadiness.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";

/** Package protocol facts plus this host's existing card repair handoff. */
export const unattendedChargeCapability: PaymentProviderCapabilityDescriptor = {
  providerKind: stripePaymentCapabilities.providerKind,
  requiresStoredMandateEvidence: stripePaymentCapabilities.requiresStoredMandateEvidence,
  assessMandate: stripePaymentCapabilities.assessMandate,
  unattendedChargeFlow: stripePaymentCapabilities.unattendedChargeFlow,
  payerContext: stripePaymentCapabilities.payerContext,
  methodHealth: stripePaymentCapabilities.methodHealth,
  terminalOutcomeReporting: stripePaymentCapabilities.terminalOutcomeReporting,
  mandateUpsertIsSubscriptionScoped: stripePaymentCapabilities.mandateUpsertIsSubscriptionScoped,
  captureFlows: [{ kind: "card_on_file_setup", handoff: "embedded_client_secret" }],
};

export interface StripeAdapterFactoryResult {
  adapter: PaymentExecutionPort;
  mode: StripeKeyMode;
}

/**
 * Builds the card payment execution adapter from environment when enabled.
 * Returns `null` when `STRIPE_PROVIDER_ENABLED` is not `"true"` or
 * `STRIPE_SECRET_KEY` is missing — the resolver in `runtimeComposition`
 * then falls back to a no-op so the saga keeps progressing without raising.
 *
 * `assertStripeKeyMode` enforces the sandbox-only default: `sk_test_` is
 * accepted, `sk_live_` requires explicit `STRIPE_LIVE_CONFIRMED=true` so a
 * mis-deployed live key cannot start charging customers silently.
 */
export function buildStripeAdapterIfEnabled(
  env: Record<string, string | undefined>,
): StripeAdapterFactoryResult | null {
  if (env.STRIPE_PROVIDER_ENABLED !== "true") return null;
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const mode = assertStripeKeyMode(secretKey, env);
  const adapter = createStripeSandboxPaymentExecutionAdapter({
    client: createStripeApiClient({ secretKey }),
  });
  // The contributed adapter has the same host contract; its provider type is open.
  return { adapter: adapter as PaymentExecutionPort, mode };
}
