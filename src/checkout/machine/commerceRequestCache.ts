/**
 * In-memory, session-scoped cache for configurator commerce requests.
 *
 * Quotes and recommendations are pure functions of their request payload, so a
 * settled identical request never needs to hit the network twice. This lets the
 * hooks resolve a repeat request (revisiting a step, toggling back)
 * synchronously — no debounce, no spinner — and only call the BFF when a
 * parameter actually changes. Bounded LRU so a long session can't grow
 * unbounded; cleared on full page reload, which is the right freshness window
 * for pricing.
 */

export interface RequestCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
}

// Every cache registers here so tests can reset all session caches between cases
// (module-level state otherwise leaks a prior test's quote into the next).
const registry = new Set<RequestCache<unknown>>();

export function clearAllRequestCaches(): void {
  for (const cache of registry) cache.clear();
}

export function createRequestCache<T>(maxEntries = 50): RequestCache<T> {
  const entries = new Map<string, T>();
  const cache: RequestCache<T> = {
    clear() {
      entries.clear();
    },
    get(key) {
      const value = entries.get(key);
      // Touch on read so the most-recently-used key survives eviction.
      if (value !== undefined) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
  };
  registry.add(cache as RequestCache<unknown>);
  return cache;
}

/** Stable cache key for a request payload built by our own code (consistent key order). */
export function requestCacheKey(value: unknown): string {
  return JSON.stringify(value);
}
