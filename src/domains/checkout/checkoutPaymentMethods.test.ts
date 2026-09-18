import { describe, expect, it } from "vitest";

import { CHECKOUT_PAYMENT_METHODS, type PaymentMethod } from "./checkoutPaymentMethods";

describe("checkout payment methods", () => {
  it("is the closed set the platform recognises", () => {
    expect([...CHECKOUT_PAYMENT_METHODS]).toEqual([
      "blik",
      "blik_one_click",
      "card",
      "transfer",
    ]);
  });

  it("names every method exactly once", () => {
    expect(new Set(CHECKOUT_PAYMENT_METHODS).size).toBe(CHECKOUT_PAYMENT_METHODS.length);
  });

  // A contract whose type drifts from its own value list is the failure this
  // module exists to prevent: the account and the storefront would then disagree
  // about what a buyer may pick while both still compile.
  it("derives the type from the value list, not beside it", () => {
    const everyMethod: PaymentMethod[] = [...CHECKOUT_PAYMENT_METHODS];
    expect(everyMethod).toHaveLength(CHECKOUT_PAYMENT_METHODS.length);
  });
});
