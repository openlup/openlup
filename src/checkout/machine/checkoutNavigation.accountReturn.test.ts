import { afterEach, describe, expect, it } from "vitest";

import {
  clearAccountOrderReturn,
  paymentStatusUrlFor,
  persistAccountOrderReturn,
  readAccountOrderReturn,
} from "./checkoutNavigation";

afterEach(() => {
  clearAccountOrderReturn();
});

describe("account order return stash", () => {
  const ctx = {
    orderId: "11111111-1111-4111-8111-111111111111",
    orderRef: "order_11111111-1111-4111-8111-111111111111",
    petName: "Burek",
    isSubscription: true,
  };

  it("round-trips the display context through localStorage", () => {
    expect(readAccountOrderReturn()).toBeNull();
    persistAccountOrderReturn(ctx);
    expect(readAccountOrderReturn()).toEqual(ctx);
  });

  it("matches the stash to an order id and ignores a stale one", () => {
    persistAccountOrderReturn(ctx);
    expect(readAccountOrderReturn(ctx.orderId)).toEqual(ctx);
    expect(readAccountOrderReturn("99999999-9999-4999-8999-999999999999")).toBeNull();
  });

  it("keeps the selected pet scope across a provider redirect", () => {
    const scoped = { ...ctx, petId: "pet-123" };
    persistAccountOrderReturn(scoped);
    expect(readAccountOrderReturn(ctx.orderId)).toEqual(scoped);
  });

  it("keeps concurrent order returns isolated by order id", () => {
    const second = {
      ...ctx,
      orderId: "22222222-2222-4222-8222-222222222222",
      orderRef: "order_22222222-2222-4222-8222-222222222222",
      petId: "pet-2",
    };
    persistAccountOrderReturn({ ...ctx, petId: "pet-1" });
    persistAccountOrderReturn(second);

    expect(readAccountOrderReturn(ctx.orderId)?.petId).toBe("pet-1");
    expect(readAccountOrderReturn(second.orderId)?.petId).toBe("pet-2");
  });

  it("clears the stash", () => {
    persistAccountOrderReturn(ctx);
    clearAccountOrderReturn();
    expect(readAccountOrderReturn()).toBeNull();
  });
});

describe("paymentStatusUrlFor with an account terminal path", () => {
  it("builds the in-account status URL carrying the poll + simulator params", () => {
    const url = paymentStatusUrlFor("/konto/zamowienie/status", {
      orderRef: "order_abc",
      orderId: "11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
      providerPaymentId: "tpay_sim_22222222-2222-4222-8222-222222222222",
    });
    const parsed = new URL(url, "https://openlup.test");
    expect(parsed.pathname).toBe("/konto/zamowienie/status");
    expect(parsed.searchParams.get("orderId")).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.searchParams.get("paymentIntentId")).toBe("22222222-2222-4222-8222-222222222222");
    expect(parsed.searchParams.get("clientId")).toBe("33333333-3333-4333-8333-333333333333");
    expect(parsed.searchParams.get("providerPaymentId")).toBe("tpay_sim_22222222-2222-4222-8222-222222222222");
  });
});
