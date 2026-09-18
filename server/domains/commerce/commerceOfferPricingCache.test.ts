import { describe, expect, it, vi } from "vitest";

import type { CommerceOfferPricingResponse } from "../../../src/domains/commerce/offerPricingContracts.js";
import { createCommerceOfferPricingCache } from "./commerceOfferPricingCache.js";

const value = { contractVersion: "commerce.offer-pricing.v1" } as CommerceOfferPricingResponse;

describe("commerce offer pricing cache", () => {
  it("coalesces concurrent loads and serves one bounded cached value", async () => {
    let now = 1_000;
    let resolve!: (result: CommerceOfferPricingResponse) => void;
    const load = vi.fn(() => new Promise<CommerceOfferPricingResponse>((done) => {
      resolve = done;
    }));
    const cache = createCommerceOfferPricingCache({ ttlMs: 5_000, now: () => now });

    const first = cache.read("commerce.offer-policy.v1", load);
    const concurrent = cache.read("commerce.offer-policy.v1", load);
    expect(load).toHaveBeenCalledOnce();
    resolve(value);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([value, value]);

    now = 5_999;
    await expect(cache.read("commerce.offer-policy.v1", load)).resolves.toBe(value);
    expect(load).toHaveBeenCalledOnce();
  });

  it("briefly coalesces failures, then retries without serving stale pricing", async () => {
    let now = 1_000;
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(value);
    const cache = createCommerceOfferPricingCache({
      ttlMs: 5_000,
      failureTtlMs: 1_000,
      now: () => now,
    });

    await expect(cache.read("commerce.offer-policy.v1", load)).rejects.toThrow("db down");
    await expect(cache.read("commerce.offer-policy.v1", load)).rejects.toThrow("db down");
    expect(load).toHaveBeenCalledOnce();

    now = 2_001;
    await expect(cache.read("commerce.offer-policy.v1", load)).resolves.toBe(value);
    now = 7_002;
    await expect(cache.read("commerce.offer-policy.v1", load)).resolves.toBe(value);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("bounds freshness from load start rather than slow-load completion", async () => {
    let now = 1_000;
    const load = vi.fn().mockResolvedValue(value);
    const cache = createCommerceOfferPricingCache({ ttlMs: 5_000, now: () => now });

    const slow = cache.read("commerce.offer-policy.v1", load);
    now = 7_000;
    await slow;
    await cache.read("commerce.offer-policy.v1", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never serves a cached v1 projection to a v2 policy request", async () => {
    const v2 = { contractVersion: "commerce.offer-pricing.v2" } as CommerceOfferPricingResponse;
    const loadV1 = vi.fn().mockResolvedValue(value);
    const loadV2 = vi.fn().mockResolvedValue(v2);
    const cache = createCommerceOfferPricingCache({ ttlMs: 5_000 });

    await expect(cache.read("commerce.offer-policy.v1", loadV1)).resolves.toBe(value);
    await expect(cache.read("commerce.offer-policy.v2", loadV2)).resolves.toBe(v2);
    expect(loadV1).toHaveBeenCalledOnce();
    expect(loadV2).toHaveBeenCalledOnce();
  });
});
