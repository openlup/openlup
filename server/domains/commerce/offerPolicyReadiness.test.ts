import { describe, expect, it, vi } from "vitest";

import {
  OFFER_POLICY_V2_READINESS_CONTRACT,
  createOfferPolicyReadinessCache,
} from "./offerPolicyReadiness.js";

const green = {
  contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
  ready: true,
  checkedAt: "2026-07-21T12:00:00.000Z",
  reasons: [],
};

describe("offer policy v2 readiness cache", () => {
  it("single-flights concurrent reads and caps positive caching at 60 seconds", async () => {
    let now = 1_000;
    let release!: (value: unknown) => void;
    const rpc = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const cache = createOfferPolicyReadinessCache({ now: () => now, positiveTtlMs: 90_000 });
    const port = { readOfferPolicyV2Readiness: rpc };

    const first = cache.read(port);
    const second = cache.read(port);
    expect(rpc).toHaveBeenCalledTimes(1);
    now += 30_000;
    release(green);
    await expect(Promise.all([first, second])).resolves.toEqual([green, green]);

    now += 29_999;
    await cache.read(port);
    expect(rpc).toHaveBeenCalledTimes(1);
    now += 2;
    rpc.mockResolvedValue(green);
    await cache.read(port);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("caches negative, malformed and thrown results for no more than 5 seconds", async () => {
    let now = 1_000;
    const rpc = vi.fn().mockResolvedValue({ ...green, ready: false, reasons: ["mirror_paused"] });
    const cache = createOfferPolicyReadinessCache({ now: () => now, negativeTtlMs: 20_000 });
    const port = { readOfferPolicyV2Readiness: rpc };

    await expect(cache.read(port)).resolves.toMatchObject({ ready: false });
    now += 4_999;
    await cache.read(port);
    expect(rpc).toHaveBeenCalledTimes(1);
    now += 2;
    rpc.mockResolvedValue({ ready: true });
    await expect(cache.read(port)).resolves.toMatchObject({
      ready: false,
      reasons: ["readiness_contract_invalid"],
    });
    now += 5_001;
    rpc.mockResolvedValue({ ...green, checkedAt: "not-a-timestamp" });
    await expect(cache.read(port)).resolves.toMatchObject({
      ready: false,
      reasons: ["readiness_contract_invalid"],
    });
    now += 5_001;
    rpc.mockRejectedValue(new Error("database down"));
    await expect(cache.read(port)).resolves.toMatchObject({
      ready: false,
      reasons: ["readiness_rpc_unavailable"],
    });
  });
});
