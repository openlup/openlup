import type { CommerceOfferPricingResponse } from "../../../src/domains/commerce/offerPricingContracts.js";

/** One bounded value and one in-flight load per runtime instance. */
export interface CommerceOfferPricingCache {
  read(key: string, load: () => Promise<CommerceOfferPricingResponse>): Promise<CommerceOfferPricingResponse>;
}

export function createCommerceOfferPricingCache(input: {
  ttlMs: number;
  failureTtlMs?: number;
  now?: () => number;
}): CommerceOfferPricingCache {
  const now = input.now ?? Date.now;
  const failureTtlMs = input.failureTtlMs ?? 0;
  const cached = new Map<string, { value: CommerceOfferPricingResponse; expiresAt: number }>();
  const failed = new Map<string, { error: unknown; expiresAt: number }>();
  const pending = new Map<string, Promise<CommerceOfferPricingResponse>>();

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
