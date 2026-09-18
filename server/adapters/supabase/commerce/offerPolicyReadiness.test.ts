import { describe, expect, it, vi } from "vitest";

import { createSupabaseOfferPolicyReadinessPort } from "./offerPolicyReadiness.js";

describe("Supabase offer-policy readiness port", () => {
  it("calls only the closed service-role RPC without caller-controlled arguments", async () => {
    const data = { contractVersion: "commerce-offer-policy-v2-readiness.v1", ready: false };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    await expect(createSupabaseOfferPolicyReadinessPort({ rpc })
      .readOfferPolicyV2Readiness()).resolves.toBe(data);
    expect(rpc).toHaveBeenCalledWith("commerce_offer_policy_v2_readiness");
  });

  it("surfaces RPC errors to the fail-closed cache", async () => {
    const port = createSupabaseOfferPolicyReadinessPort({
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "denied" } }),
    });
    await expect(port.readOfferPolicyV2Readiness()).rejects.toThrow("offer_policy_readiness_failed");
  });
});
