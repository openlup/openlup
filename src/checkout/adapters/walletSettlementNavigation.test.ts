/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import type { NavigateFunction } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHECKOUT_ATTEMPT_STORAGE_KEY } from "@/checkout/machine/checkoutAttemptStore";
import { LEGACY_CHECKOUT_CONTINUATION_KEY } from "@/checkout/machine/checkoutNavigation";
import {
  defaultConfiguratorFormData,
  getConfiguratorFormData,
  resetConfiguratorFormData,
  setConfiguratorFormData,
} from "@/checkout/composer/configuratorFormStore";
import { routeWalletCheckoutSettlement } from "./walletSettlementNavigation";

const paths = {
  thankYou: "/dziekujemy",
  paymentFailed: "/platnosc-nieudana",
  paymentPath: "/platnosc",
};

function navigateMock(): NavigateFunction {
  return vi.fn() as unknown as NavigateFunction;
}

describe("routeWalletCheckoutSettlement", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetConfiguratorFormData();
  });

  it("keeps the user on the configurator and invalidates consent on price change", () => {
    const navigate = navigateMock();
    sessionStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, "stale-attempt");
    setConfiguratorFormData({
      ...defaultConfiguratorFormData,
      firstName: "Ada",
      checkoutQuoteExpectation: { totalGross: { amountMinor: 12900, currency: "PLN" } },
    });

    routeWalletCheckoutSettlement({
      settlement: { kind: "price_changed" },
      navigate,
      paths,
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(getConfiguratorFormData().checkoutQuoteExpectation).toBeNull();
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBe("stale-attempt");
  });

  it("does not navigate to success when a selected subscription is unavailable", () => {
    const navigate = navigateMock();

    routeWalletCheckoutSettlement({
      settlement: { kind: "subscription_unavailable" },
      navigate,
      paths,
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not route a null-intent (disabled) wallet outcome to the thank-you page", () => {
    const navigate = navigateMock();

    // buildCheckoutIntent returned null (e.g. parcel-locker with no pickup point):
    // no order was minted and no payment taken, so a thank-you route would be a
    // false success. The wallet row surfaces the fix-your-details error in place.
    routeWalletCheckoutSettlement({
      settlement: { kind: "disabled" },
      navigate,
      paths,
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("clears a provisional wallet marker for a pre-dispatch error without navigation or sequence bump", () => {
    const navigate = navigateMock();
    sessionStorage.setItem(LEGACY_CHECKOUT_CONTINUATION_KEY, "provisional-wallet-confirmation");
    sessionStorage.setItem(
      CHECKOUT_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ fingerprint: "journey", key: "checkout:11111111-1111-4111-8111-111111111111" }),
    );

    routeWalletCheckoutSettlement({ settlement: { kind: "retryable" }, navigate, paths });

    expect(navigate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBeUndefined();
  });

  it("routes terminal wallet settlements to the correct checkout tail pages", () => {
    const navigate = navigateMock();

    routeWalletCheckoutSettlement({
      settlement: { kind: "paid", orderRef: "order_paid" },
      navigate,
      paths,
    });
    routeWalletCheckoutSettlement({
      settlement: {
        kind: "processing",
        orderRef: "order_processing",
        orderId: "order-id",
        paymentIntentId: "intent-id",
        clientId: "client-id",
      },
      navigate,
      paths,
    });
    routeWalletCheckoutSettlement({
      settlement: { kind: "status", orderRef: "order_status" },
      navigate,
      paths,
    });
    routeWalletCheckoutSettlement({
      settlement: { kind: "failed" },
      navigate,
      paths,
    });

    expect(navigate).toHaveBeenNthCalledWith(1, "/dziekujemy?order=order_paid");
    expect(navigate).toHaveBeenNthCalledWith(
      2,
      "/platnosc?order=order_processing&orderId=order-id&paymentIntentId=intent-id&clientId=client-id",
    );
    expect(navigate).toHaveBeenNthCalledWith(3, "/platnosc?order=order_status");
    expect(navigate).toHaveBeenNthCalledWith(4, "/platnosc-nieudana");
    expect(navigate).toHaveBeenCalledTimes(4);
  });

  it("keeps an issuer decline on the wallet row instead of routing to the failure page", () => {
    const navigate = navigateMock();
    sessionStorage.setItem(
      CHECKOUT_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ fingerprint: "journey", key: "checkout:11111111-1111-4111-8111-111111111111" }),
    );

    routeWalletCheckoutSettlement({
      settlement: {
        kind: "failed",
        reason: "card_declined",
        orderRef: "order_ref",
        orderId: "order-id",
        paymentIntentId: "intent-id",
        clientId: "client-id",
      },
      navigate,
      paths,
    });

    // The order stays `pending_payment` with its stock hold, so the buyer keeps
    // the tiles and the one-tap retry; WalletExpressRow renders the reason.
    expect(navigate).not.toHaveBeenCalled();
    // The retry still gets its own execution-idempotency namespace.
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBe(1);
  });

  it("still routes an expired-card decline inline rather than to the failure page", () => {
    const navigate = navigateMock();

    routeWalletCheckoutSettlement({
      settlement: { kind: "failed", reason: "expired", orderRef: "order_ref" },
      navigate,
      paths,
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("routes minted technical wallet failures to status readback instead of closing the order as failed", () => {
    const navigate = navigateMock();
    sessionStorage.setItem(
      CHECKOUT_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ fingerprint: "journey", key: "checkout:11111111-1111-4111-8111-111111111111" }),
    );

    routeWalletCheckoutSettlement({
      settlement: {
        kind: "failed",
        reason: "technical",
        orderRef: "order_ref",
        orderId: "order-id",
        paymentIntentId: "intent-id",
        clientId: "client-id",
      },
      navigate,
      paths,
    });

    expect(navigate).toHaveBeenCalledWith(
      "/platnosc?order=order_ref&orderId=order-id&paymentIntentId=intent-id&clientId=client-id&reason=technical",
    );
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBeUndefined();
  });

  it("routes a deterministic technical confirm failure straight to retry with full context", () => {
    const navigate = vi.fn(() => {
      // The sequence is durable before the retry route is exposed.
      expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBe(1);
    }) as unknown as NavigateFunction;
    sessionStorage.setItem(LEGACY_CHECKOUT_CONTINUATION_KEY, "stale-confirm-attempt");
    sessionStorage.setItem(
      CHECKOUT_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ fingerprint: "journey", key: "checkout:11111111-1111-4111-8111-111111111111" }),
    );

    routeWalletCheckoutSettlement({
      settlement: {
        kind: "failed",
        reason: "technical",
        forceFailurePage: true,
        orderRef: "order_ref",
        orderId: "order-id",
        paymentIntentId: "intent-id",
        clientId: "client-id",
      },
      navigate,
      paths,
    });

    expect(navigate).toHaveBeenCalledWith(
      "/platnosc-nieudana?order=order_ref&orderId=order-id&paymentIntentId=intent-id&clientId=client-id&reason=technical",
    );
    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
  });

  it("routes a reasonless failure to the bare failure page", () => {
    const navigate = navigateMock();

    routeWalletCheckoutSettlement({ settlement: { kind: "failed" }, navigate, paths });

    expect(navigate).toHaveBeenCalledWith("/platnosc-nieudana");
  });

  it("carries a pre-mint technical wallet failure reason without order ids", () => {
    const navigate = navigateMock();

    routeWalletCheckoutSettlement({
      settlement: { kind: "failed", reason: "technical" },
      navigate,
      paths,
    });

    expect(navigate).toHaveBeenCalledWith("/platnosc-nieudana?reason=technical");
  });
});
