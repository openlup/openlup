import { describe, expect, it, vi } from "vitest";
import type { CheckoutRecoverySubscriptionContextPort } from "./checkoutRecoverySubscriptionContextPort.js";
import { fallbackForRecoveryContext } from "./checkoutRecoveryDestination.js";

function subscriptionContextPort(result: boolean): CheckoutRecoverySubscriptionContextPort {
  return {
    clientHasLiveOrPendingSubscription: vi.fn().mockResolvedValue(result),
  };
}

describe("fallbackForRecoveryContext", () => {
  it("keeps subscription-cycle recovery inside the account without a client lookup", async () => {
    const port = subscriptionContextPort(false);

    await expect(fallbackForRecoveryContext(port, {
      mode: "subscription_cycle",
      subscriptionId: "subscription_1",
    })).resolves.toBe("customer_account");
    expect(port.clientHasLiveOrPendingSubscription).not.toHaveBeenCalled();
  });

  it("allows a fresh checkout for a one-time order with no live subscription", async () => {
    const port = subscriptionContextPort(false);

    await expect(fallbackForRecoveryContext(port, {
      mode: "one_time_order",
    }, "client_1")).resolves.toBe("fresh_checkout");
    expect(port.clientHasLiveOrPendingSubscription).toHaveBeenCalledWith({ clientId: "client_1" });
  });

  it("routes a one-time customer with a live subscription back to the account", async () => {
    const port = subscriptionContextPort(true);

    await expect(fallbackForRecoveryContext(port, {
      mode: "one_time_order",
    }, "client_1")).resolves.toBe("customer_account");
  });
});
