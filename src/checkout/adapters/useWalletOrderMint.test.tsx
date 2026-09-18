import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startStripeWalletCheckout = vi.fn();

vi.mock("./stripeWalletCheckout", () => ({
  startStripeWalletCheckout: (...args: unknown[]) => startStripeWalletCheckout(...args),
}));
vi.mock("@/checkout/composer/deliverySelectionFlags", () => ({ dhlOnlyDeliveryEnabled: () => false }));
vi.mock("@/lib/flags", () => ({ subscriptionCheckoutContractEnabled: () => true }));

import { useWalletOrderMint } from "./useWalletOrderMint";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";

/**
 * Line γ seam fixture: the composition vocabulary the composition root supplies in
 * production. Held here as plain data so the machine's tests exercise the seam without
 * importing the vertical's validation module.
 */
const KNOWN_COMPOSITION_SLUGS = ["lamb", "venison", "beef", "turkey", "salmon", "pork"] as const;

const data = {
  recommendationSnapshot: null,
  lengthDays: 21,
  promoCodes: [],
  checkoutQuoteExpectation: { totalGross: { amountMinor: 12_900, currency: "PLN" } },
} as unknown as ConfiguratorFormData;

describe("useWalletOrderMint", () => {
  beforeEach(() => startStripeWalletCheckout.mockReset());

  it("evicts a rejected confirmed-action mint so the next confirmation starts a fresh Promise", async () => {
    const rejected = new Error("wallet mint transport failure");
    startStripeWalletCheckout
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce({ kind: "quote_unavailable" });
    const { result } = renderHook(() => useWalletOrderMint(data, data.checkoutQuoteExpectation, "pl", KNOWN_COMPOSITION_SLUGS));

    const first = result.current();
    await expect(first).rejects.toBe(rejected);
    await waitFor(() => expect(startStripeWalletCheckout).toHaveBeenCalledTimes(1));

    const second = result.current();
    expect(second).not.toBe(first);
    await expect(second).resolves.toEqual({ kind: "quote_unavailable" });

    expect(startStripeWalletCheckout).toHaveBeenCalledTimes(2);
    expect(startStripeWalletCheckout.mock.calls[1]).toEqual(startStripeWalletCheckout.mock.calls[0]);
  });

  it("evicts a resolved ambiguous recovery so the next confirmation can read back the same journey", async () => {
    startStripeWalletCheckout
      .mockResolvedValueOnce({ kind: "retryable" })
      .mockResolvedValueOnce({ kind: "paid", orderRef: "order_x" });
    const { result } = renderHook(() => useWalletOrderMint(data, data.checkoutQuoteExpectation, "pl", KNOWN_COMPOSITION_SLUGS));

    const first = result.current();
    await expect(first).resolves.toEqual({ kind: "retryable" });
    await waitFor(() => expect(startStripeWalletCheckout).toHaveBeenCalledTimes(1));

    const second = result.current();
    expect(second).not.toBe(first);
    await expect(second).resolves.toEqual({ kind: "paid", orderRef: "order_x" });
    expect(startStripeWalletCheckout).toHaveBeenCalledTimes(2);
    // The mint hook does not alter attempt storage; the second call receives
    // the unchanged checkout payload, which replays its stable journey key.
    expect(startStripeWalletCheckout.mock.calls[1]).toEqual(startStripeWalletCheckout.mock.calls[0]);
  });
});
