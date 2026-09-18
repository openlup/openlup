/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const loadStripe = vi.fn((..._args: unknown[]) => Promise.resolve({ id: "stripe" }));
vi.mock("@stripe/stripe-js", () => ({
  loadStripe: (...args: unknown[]) => loadStripe(...args),
}));

import { useStripePromise } from "./useStripePromise.js";

afterEach(() => {
  vi.unstubAllEnvs();
  loadStripe.mockClear();
});

describe("useStripePromise", () => {
  // Runs first: the module-level cache is still empty, so the no-key branch is
  // exercised before any later test populates it.
  it("returns null when no publishable key is configured", () => {
    vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "");
    const { result } = renderHook(() => useStripePromise());
    expect(result.current).toBeNull();
    expect(loadStripe).not.toHaveBeenCalled();
  });

  it("loads Stripe at most once when a key is present", () => {
    vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "pk_test_123");
    const { result, rerender } = renderHook(() => useStripePromise());
    expect(result.current).not.toBeNull();
    rerender();
    expect(loadStripe).toHaveBeenCalledTimes(1);
    expect(loadStripe).toHaveBeenCalledWith("pk_test_123");
  });
});