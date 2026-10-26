import { expect, it } from "vitest";
import { createNoopAnalytics, initializeDeploymentAnalytics, trackDeploymentEvent,
  syncAdvertisingConsent, trackAdvertisingPurchase } from "../../src/marketing/index.js";

it("leaves deployment and advertising collection inert", () => {
  expect(initializeDeploymentAnalytics()).toBeUndefined();
  expect(syncAdvertisingConsent()).toBeUndefined();
  expect(trackAdvertisingPurchase({ transaction_id: "order:one", currency: "XTS", value: 100,
    shipping: 10, tax: 23, checkout_mode: "one_time", items: [] })).toBe(false);
  expect(trackDeploymentEvent("configurator_start", { entry_view: "hero" })).toBe(false);
});
it("satisfies the runtime analytics port without emission", () => {
  const analytics = createNoopAnalytics();
  expect(() => analytics.trackPageView("/home")).not.toThrow();
  expect(() => analytics.trackEvent("Purchase", { value: 10 })).not.toThrow();
  expect(typeof analytics.trackPageView).toBe("function");
  expect(typeof analytics.trackEvent).toBe("function");
});
