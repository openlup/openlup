import {
  isPaymentMethodLifecycleEventKind,
  type PaymentMethodLifecycleEvent,
  type PaymentMethodReplacementFacts,
} from "@openlup/core/payment";
import type { NormalizedProviderPaymentWebhook } from "./paymentWebhookHandlers.js";

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

export function expiryForMethodRefWrite(
  consentSnapshot: Record<string, unknown> | undefined,
  occurredAt: string,
  active: boolean,
): string | null {
  const raw = consentSnapshot?.[METHOD_EXPIRES_AT_SNAPSHOT_KEY];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const expiry = Date.parse(raw);
  if (!Number.isFinite(expiry)) return null;
  if (!active) return raw;
  const reference = Date.parse(occurredAt);
  return Number.isFinite(reference) && expiry <= reference ? null : raw;
}

export function readMethodLifecycleEvent(
  event: NormalizedProviderPaymentWebhook,
): PaymentMethodLifecycleEvent | null {
  const candidate = (event as ProviderWebhookWithMethodLifecycle).methodLifecycle;
  if (!candidate || typeof candidate !== "object") return null;
  if (!isPaymentMethodLifecycleEventKind(candidate.kind)) return null;
  if (!candidate.providerKind?.trim() || !candidate.providerMethodRef?.trim()) return null;
  if (!candidate.providerEventId?.trim() || !candidate.occurredAt?.trim()) return null;
  return candidate;
}
