import type { CommerceOfferPricingResponse } from "./contracts/offer.js";

/**
 * Entries and in-flight loads are keyed by caller string per runtime instance.
 * TTLs bound freshness and failure reuse, not entry count; callers choose the
 * key set, and this cache does not cap or prune distinct keys.
 */
export interface CommerceOfferPricingCache<Response extends CommerceOfferPricingResponse = CommerceOfferPricingResponse> {
  read(key: string, load: () => Promise<Response>): Promise<Response>;
}

export function createCommerceOfferPricingCache<Response extends CommerceOfferPricingResponse = CommerceOfferPricingResponse>(input: {
  ttlMs: number;
  failureTtlMs?: number;
  now?: () => number;
}): CommerceOfferPricingCache<Response> {
  const now = input.now ?? Date.now;
  const failureTtlMs = input.failureTtlMs ?? 0;
  const cached = new Map<string, { value: Response; expiresAt: number }>();
  const failed = new Map<string, { error: unknown; expiresAt: number }>();
  const pending = new Map<string, Promise<Response>>();

  return {
    read(key, load) {
      const cachedEntry = cached.get(key);
      const failedEntry = failed.get(key);
      if (cachedEntry && cachedEntry.expiresAt > now()) return Promise.resolve(cachedEntry.value);
      if (failedEntry && failedEntry.expiresAt > now()) return Promise.reject(failedEntry.error);
      const pendingEntry = pending.get(key);
      if (pendingEntry) return pendingEntry;

      const startedAt = now();
      const current = load()
        .then((value) => {
          // Bound freshness from the pricing instant, not from completion of a
          // potentially slow DB read.
          cached.set(key, { value, expiresAt: startedAt + input.ttlMs });
          failed.delete(key);
          return value;
        })
        .catch((error: unknown) => {
          // A public cold endpoint must not hammer a degraded database once per
          // request. Keep only the failure object, briefly, and never turn it
          // into stale pricing data; callers still receive the same rejection.
          if (failureTtlMs > 0) {
            failed.set(key, { error, expiresAt: now() + failureTtlMs });
          }
          throw error;
        })
        .finally(() => {
          if (pending.get(key) === current) pending.delete(key);
        });
      pending.set(key, current);
      return current;
    },
  };
}
