import type { PaymentMethodReplacementFacts } from "@openlup/core/payment";
import type { NormalizedProviderPaymentWebhook } from "./donorContracts.js";
import type { PaymentMethodLifecycleEvent } from "@openlup/core/payment";
export interface ProviderWebhookWithMethodLifecycle extends NormalizedProviderPaymentWebhook {
  methodLifecycle?: PaymentMethodLifecycleEvent | null;
}
export const METHOD_SCHEME_SNAPSHOT_KEY = "methodScheme";
export const METHOD_LAST_DIGITS_SNAPSHOT_KEY = "methodLastDigits";
export const METHOD_EXPIRES_AT_SNAPSHOT_KEY = "methodExpiresAt";

export function methodFactSnapshotKeys(
  facts: PaymentMethodReplacementFacts | null | undefined,
): Record<string, unknown> {
  if (!facts) return {};
  return {
    ...(facts.schemeLabel ? { [METHOD_SCHEME_SNAPSHOT_KEY]: facts.schemeLabel } : {}),
    ...(facts.lastDigits ? { [METHOD_LAST_DIGITS_SNAPSHOT_KEY]: facts.lastDigits } : {}),
    ...(facts.expiresAt ? { [METHOD_EXPIRES_AT_SNAPSHOT_KEY]: facts.expiresAt } : {}),
  };
}

