import { describe, expect, it } from "vitest";
import {
  SAVED_PAYMENT_METHOD_RECURRING_MODELS,
  type CheckoutSavedPaymentMethodResolverPort,
} from "./savedPaymentMethodResolverPort.js";

describe("checkout saved payment method resolver port", () => {
  it("keeps the stored recurring-model vocabulary explicit", () => {
    expect(SAVED_PAYMENT_METHOD_RECURRING_MODELS).toEqual(["O", "M"]);
  });

  it("keeps raw provider method refs behind the server-side port boundary", async () => {
    const port: CheckoutSavedPaymentMethodResolverPort = {
      async resolveSavedPaymentMethod(input) {
        expect(input.savedMethodId).toBe("22222222-2222-4222-8222-222222222222");
        return { providerMethodRef: "payid_secret", providerAliasType: "PAYID", recurringModel: "O" };
      },
    };

    await expect(port.resolveSavedPaymentMethod({
      accessToken: "access-token",
      clientId: "client-1",
      savedMethodId: "22222222-2222-4222-8222-222222222222",
      requestedFlow: "blik_recurring_saved",
      now: new Date("2026-06-24T12:00:00Z"),
    })).resolves.toEqual({ providerMethodRef: "payid_secret", providerAliasType: "PAYID", recurringModel: "O" });
  });
});
