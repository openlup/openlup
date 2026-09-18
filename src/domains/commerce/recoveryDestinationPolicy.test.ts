import { describe, expect, it } from "vitest";
import {
  hasSubscriptionRecoveryContext,
  resolveRecoveryDestination,
} from "./recoveryDestinationPolicy.js";

describe("recovery destination policy", () => {
  it("keeps recoverable checkout work on the existing token recovery context", () => {
    for (const input of [
      { orderMode: "one_time_order" as const, clientHasLiveOrPendingSubscription: false },
      { orderMode: "subscription_cycle" as const },
      { hasOrderSubscription: true },
      { clientHasLiveOrPendingSubscription: true },
    ]) {
      expect(resolveRecoveryDestination({
        state: "recoverable",
        source: "checkout_recovery",
        ...input,
      })).toBe("checkout_recovery");
    }
  });

  it("routes subscription-context dead recovery links to account payment recovery", () => {
    for (const input of [
      { orderMode: "subscription_cycle" as const },
      { hasOrderSubscription: true },
      { requestedSubscriptionContext: true },
      { clientHasLiveOrPendingSubscription: true },
    ]) {
      expect(resolveRecoveryDestination({
        state: "unrecoverable",
        source: "checkout_recovery",
        ...input,
      })).toBe("account_payment_recovery");
    }
  });

  it("allows terminal one-time checkout expiry to start fresh when no subscription context exists", () => {
    expect(resolveRecoveryDestination({
      state: "terminal_expired",
      source: "checkout_expired",
      orderMode: "one_time_order",
      hasOrderSubscription: false,
      requestedSubscriptionContext: false,
      clientHasLiveOrPendingSubscription: false,
    })).toBe("fresh_checkout");
  });

  it("always keeps subscription dunning in the account payment recovery surface", () => {
    expect(resolveRecoveryDestination({
      state: "recoverable",
      source: "subscription_dunning",
      orderMode: "one_time_order",
    })).toBe("account_payment_recovery");
  });

  it("detects subscription context without needing downstream URL or provider facts", () => {
    expect(hasSubscriptionRecoveryContext({ clientHasLiveOrPendingSubscription: true })).toBe(true);
    expect(hasSubscriptionRecoveryContext({ orderMode: "one_time_order" })).toBe(false);
  });
});
