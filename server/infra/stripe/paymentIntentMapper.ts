import { readProviderActivationConfig } from "../providerReadiness.js";

export interface StripePaymentIntentDraftInput {
  amountMinor: number;
  currency: string;
  customerRef: string | null;
  orderRef: string;
  reusableMethodRef?: string | null;
  metadata?: Record<string, string>;
}

export function readStripeReadinessConfig(env: Record<string, string | undefined>) {
  return readProviderActivationConfig({
    providerKind: "stripe",
    enabled:
      env.COMMERCE_PAYMENT_PROVIDER_EXECUTION_ENABLED === "true" &&
      env.STRIPE_PROVIDER_ENABLED === "true",
    requiredEnv: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    env,
  });
}

export function buildStripePaymentIntentDraft(input: StripePaymentIntentDraftInput) {
  return {
    provider: "stripe",
    requestKind: "payment_intent",
    amount: input.amountMinor,
    currency: input.currency.toLowerCase(),
    customer: input.customerRef,
    payment_method: input.reusableMethodRef ?? undefined,
    setup_future_usage: "off_session",
    capture_method: "automatic",
    metadata: {
      orderRef: input.orderRef,
      ...input.metadata,
    },
  };
}
