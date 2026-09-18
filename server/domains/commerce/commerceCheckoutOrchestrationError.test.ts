import { describe, expect, it } from "vitest";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";

describe("CheckoutOrchestrationError", () => {
  it("preserves compensation identity and a structured reason", () => {
    const error = new CheckoutOrchestrationError("failed", "order-1", "price_changed");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "CheckoutOrchestrationError",
      message: "failed",
      orderIdForCompensation: "order-1",
      reason: "price_changed",
    });
  });
});
