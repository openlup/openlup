/** @beta */
export interface ProviderAttemptIdentityInput {
  namespace: string;
  provider: string;
  localExecutionIdempotencyKey: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  mode: "one_time" | "subscription_cycle";
  orderRef: string;
}

/** @beta */
export interface ProviderAttemptIdentity {
  providerIdempotencyKey: string;
  providerRequestFingerprint: string;
}

/** @beta */
export function buildProviderAttemptIdentity(
  input: ProviderAttemptIdentityInput,
): ProviderAttemptIdentity {
  const normalizedNamespace = normalizeSegment(input.namespace);
  const normalizedProvider = normalizeSegment(input.provider);
  const normalizedLocalKey = normalizeSegment(input.localExecutionIdempotencyKey);
  const normalizedCurrency = input.currency.trim().toUpperCase();
  const providerIdempotencyKey = [
    normalizedNamespace,
    normalizedProvider,
    input.paymentIntentId,
    normalizedLocalKey,
  ].join(":");

  return {
    providerIdempotencyKey,
    providerRequestFingerprint: [
      normalizedProvider,
      input.paymentIntentId,
      input.amountMinor.toString(),
      normalizedCurrency,
      input.mode,
      input.orderRef,
    ].join("|"),
  };
}

/** @beta */
export function isProviderAttemptReplaySafe(input: {
  existingFingerprint: string;
  nextFingerprint: string;
}): boolean {
  return input.existingFingerprint === input.nextFingerprint;
}

function normalizeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
}
