import { describe, expect, it } from "vitest";

import { createRequestCache, requestCacheKey } from "./commerceRequestCache";

describe("createRequestCache", () => {
  it("returns undefined on miss and the stored value on hit", () => {
    const cache = createRequestCache<number>();
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("evicts the least-recently-used entry past the cap", () => {
    const cache = createRequestCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // touch a so b becomes least-recently-used
    cache.set("c", 3); // evicts b
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("b")).toBeUndefined();
  });

  it("clears settled entries", () => {
    const cache = createRequestCache<number>();
    cache.set("a", 1);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });

  it("keys identical payloads to the same string", () => {
    expect(requestCacheKey({ mode: "subscription", cadenceDays: 21 })).toBe(
      requestCacheKey({ mode: "subscription", cadenceDays: 21 }),
    );
    expect(requestCacheKey({ cadenceDays: 21 })).not.toBe(requestCacheKey({ cadenceDays: 14 }));
  });
});
