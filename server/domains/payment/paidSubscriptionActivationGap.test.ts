import { describe, expect, it } from "vitest";
import { deriveSubscriptionActivationStatus } from "../../../src/domains/payment/contracts.js";

const paidAt = "2026-07-22T10:00:00.000Z";

describe("paid subscription activation presentation", () => {
  it("leaves one-time payments outside subscription activation", () => {
    expect(deriveSubscriptionActivationStatus({
      orderMode: "one_time", orderStatus: "paid", intentStatus: "succeeded",
      subscriptionStatus: null, paidAt, hasExactGap: false, now: new Date("2026-07-22T10:10:00.000Z"),
    })).toBe("not_applicable");
  });

  it("does not call a pending subscription active after money settled", () => {
    expect(deriveSubscriptionActivationStatus({
      orderMode: "subscription_cycle", orderStatus: "paid", intentStatus: "succeeded",
      subscriptionStatus: "pending_activation", paidAt, hasExactGap: true, now: new Date("2026-07-22T10:01:59.000Z"),
    })).toBe("waiting_for_mandate");
    expect(deriveSubscriptionActivationStatus({
      orderMode: "subscription_cycle", orderStatus: "paid", intentStatus: "succeeded",
      subscriptionStatus: "pending_activation", paidAt, hasExactGap: true, now: new Date("2026-07-22T10:02:00.000Z"),
    })).toBe("action_required");
  });

  it("reports active only from durable subscription truth", () => {
    expect(deriveSubscriptionActivationStatus({
      orderMode: "subscription_cycle", orderStatus: "paid", intentStatus: "succeeded",
      subscriptionStatus: "active", paidAt, hasExactGap: false, now: new Date("2026-07-22T11:00:00.000Z"),
    })).toBe("active");
  });

  it("does not infer the Tpay Model O gap from a generic pending subscription", () => {
    expect(deriveSubscriptionActivationStatus({
      orderMode: "subscription_cycle", orderStatus: "paid", intentStatus: "succeeded",
      subscriptionStatus: "pending_activation", paidAt, hasExactGap: false,
      now: new Date("2026-07-22T10:10:00.000Z"),
    })).toBe("not_applicable");
  });
});
