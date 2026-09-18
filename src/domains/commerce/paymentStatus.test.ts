import { describe, expect, it } from "vitest";
import { deriveAsyncCheckoutStatus } from "./paymentStatus.js";

describe("deriveAsyncCheckoutStatus", () => {
  it("keeps browser-facing status derived from local payment-control state", () => {
    expect(deriveAsyncCheckoutStatus({
      intentStatus: "created",
      attemptStatus: null,
      orderStatus: "pending_payment",
    })).toBe("pending_provider_action");
    expect(deriveAsyncCheckoutStatus({
      intentStatus: "requires_action",
      attemptStatus: "requires_action",
      orderStatus: "pending_payment",
    })).toBe("requires_action");
    expect(deriveAsyncCheckoutStatus({
      intentStatus: "processing",
      attemptStatus: "sent_to_provider",
      orderStatus: "pending_payment",
    })).toBe("processing");
    expect(deriveAsyncCheckoutStatus({
      intentStatus: "processing",
      attemptStatus: "blocked_preflight",
      orderStatus: "pending_payment",
    })).toBe("failed");
    expect(deriveAsyncCheckoutStatus({
      intentStatus: "succeeded",
      attemptStatus: "succeeded",
      orderStatus: "paid",
    })).toBe("paid");
  });

  it("maps terminal local failure and expiry without trusting provider return URLs", () => {
    expect(deriveAsyncCheckoutStatus({
      intentStatus: "failed",
      attemptStatus: "failed",
      orderStatus: "failed",
    })).toBe("failed");
    expect(deriveAsyncCheckoutStatus({
      intentStatus: "expired",
      attemptStatus: "expired",
      orderStatus: "expired",
    })).toBe("expired");
  });
});
