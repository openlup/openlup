import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { offerPolicyV2CapabilityEnabled } from "@/lib/flags";
import { getOrCreateVisitorId } from "@/lib/commerceVisitorId";
import { getCommerceOfferPricing } from "./commerceClient";
import { useCommerceOfferPricing } from "./useCommerceOfferPricing";

// Keep the intentional invalid-null boundary visible without changing the real
// visitor-id contract, which only returns a string or undefined.
const { getVisitorId } = vi.hoisted(() => ({
  getVisitorId: vi.fn<() => ReturnType<typeof getOrCreateVisitorId> | null>(() => "visitor-offer-1"),
}));

vi.mock("./commerceClient", () => ({ getCommerceOfferPricing: vi.fn() }));
vi.mock("@/lib/commerceVisitorId", () => ({ getOrCreateVisitorId: getVisitorId }));
vi.mock("@/lib/flags", () => ({ offerPolicyV2CapabilityEnabled: vi.fn(() => true) }));

const getPricing = vi.mocked(getCommerceOfferPricing);
const capabilityEnabled = vi.mocked(offerPolicyV2CapabilityEnabled);

afterEach(() => {
  vi.clearAllMocks();
  capabilityEnabled.mockReturnValue(true);
  getVisitorId.mockReturnValue("visitor-offer-1");
});

describe("useCommerceOfferPricing", () => {
  it("publishes server pricing and never synthesizes a fallback", async () => {
    let resolve!: (value: unknown) => void;
    getPricing.mockReturnValue(new Promise((done) => { resolve = done; }) as never);
    const { result } = renderHook(() => useCommerceOfferPricing());
    expect(result.current).toEqual({ loading: true, available: false, data: null });
    expect(getPricing).toHaveBeenCalledWith(expect.objectContaining({
      headers: {
        "x-commerce-offer-policy-capability": "commerce.offer-policy.v2",
        "x-commerce-visitor-id": "visitor-offer-1",
      },
    }));

    await act(async () => resolve({ scope: "dog_products_only_excludes_shipping" }));
    expect(result.current.available).toBe(true);
    expect(result.current.data?.scope).toBe("dog_products_only_excludes_shipping");
  });

  it("returns amount-free unavailable state on failure", async () => {
    getPricing.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useCommerceOfferPricing());
    await act(async () => undefined);
    expect(result.current).toEqual({ loading: false, available: false, data: null });
  });

  it("keeps the compatibility request header-free while capability is disabled", async () => {
    capabilityEnabled.mockReturnValue(false);
    getPricing.mockRejectedValue(new Error("legacy unavailable"));

    renderHook(() => useCommerceOfferPricing());
    await act(async () => undefined);

    expect(getPricing).toHaveBeenCalledWith(expect.objectContaining({ headers: undefined }));
  });

  it("fails amount-free without advertising v2 when visitor storage is unavailable", async () => {
    getVisitorId.mockReturnValue(null);
    getPricing.mockRejectedValue(new Error("v2 assignment unavailable"));

    const { result } = renderHook(() => useCommerceOfferPricing());
    await act(async () => undefined);

    expect(getPricing).toHaveBeenCalledWith(expect.objectContaining({ headers: undefined }));
    expect(result.current).toEqual({ loading: false, available: false, data: null });
  });
});
