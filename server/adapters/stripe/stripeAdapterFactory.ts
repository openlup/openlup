import {
  createStripeSandboxPaymentExecutionAdapter,
  PROVIDER_KIND,
} from "./stripeSandboxPaymentExecutionAdapter.js";
import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import { createStripeApiClient } from "../../infra/stripe/stripeApiClient.js";
import {
  assertStripeKeyMode,
  type StripeKeyMode,
} from "../../infra/providerReadiness.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";

/**
 * What renewal orchestration may do with a stored method of this provider,
 * stated as capabilities rather than as an identity to compare against.
 *
 * Every value here restates behaviour this provider ALREADY has on the
 * off-session renewal path; nothing reads this descriptor yet.
 */
export const unattendedChargeCapability: PaymentProviderCapabilityDescriptor = {
  providerKind: PROVIDER_KIND,
  // No local consent evidence is read before the charge: this provider's stored
  // method is chargeable unattended by virtue of existing, and a refusal is
  // reported by the provider inside the confirmed call.
  requiresStoredMandateEvidence: false,
  assessMandate: () => ({ chargeable: true }),
  // A payer repairs this rail by entering a card into provider-hosted fields
  // bound to a setup secret this deployment mints per repair attempt.
  captureFlows: [{ kind: "card_on_file_setup", handoff: "embedded_client_secret" }],
  unattendedChargeFlow: "off_session_payment",
  payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
  methodHealth: {
    requiresCustomerRef: true,
    requiredMethodKind: null,
    requiresPayerContact: false,
  },
  mandateUpsertIsSubscriptionScoped: false,  // This rail turns its own readback status terminal, so silence means the
  // attempt never resolved rather than that the outcome landed elsewhere. Six
  // hours matches the other rail's first value; both are tunable per rail once
  // real settled cases are observed.
  terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
};

export interface StripeAdapterFactoryResult {
  adapter: PaymentExecutionPort;
  mode: StripeKeyMode;
}

/**
 * Builds a Stripe payment execution adapter from environment when enabled.
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
  return { adapter, mode };
}
