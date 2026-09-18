import { describe, expect, it } from "vitest";
import { createInitialSubscriptionCheckoutModel as createCoreModel } from "@openlup/core/subscription";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import { createInitialSubscriptionCheckoutModel } from "./subscriptionEngine.js";
import { baseTemplate, firstCycleAt, now, pricingSnapshot } from "./subscriptionEngineTestHelpers.js";

describe("subscription engine app shim", () => {
  it("forwards the composition-root timezone verbatim, with no hidden default", () => {
    // The composition root names the market zone; the app overlay owns it in
    // DELIVERY_DISPATCH_POLICY, the same place the delivery-estimate seam reads
    // its zone from. E11 removed the silent market-zone fallback that used to
    // live in the shim, so the shim now merely passes the explicit zone through.
    const input = {
      subscriptionId: "sub-shim",
      clientRef: "client-shim",
      template: baseTemplate,
      paymentMethodRef: "pm-shim",
      firstCycleAt,
      now,
      pricingSnapshot,
      idempotencyKey: "shim-example",
      timezone: DELIVERY_DISPATCH_POLICY.timeZone,
    };
    const app = createInitialSubscriptionCheckoutModel(input);
    const core = createCoreModel(input);

    expect(app).toMatchObject({
      ok: true,
      value: { subscription: { timezone: DELIVERY_DISPATCH_POLICY.timeZone } },
    });
    // Given the same explicit input, the shim adds nothing the core would not:
    // it no longer overrides or defaults the timezone.
    expect(app).toEqual(core);
  });
});
