import { describe, expect, it } from "vitest";
import { createNoopAnalytics, initializeDeploymentAnalytics, trackDeploymentEvent } from "./noop.js";

describe("createNoopAnalytics", () => {
  it("leaves deployment collection absent in default composition", () => {
    expect(initializeDeploymentAnalytics()).toBeUndefined();
    expect(trackDeploymentEvent("configurator_start", { entry_view: "hero" })).toBe(false);
  });
  it("satisfies the AnalyticsPort contract and emits nothing", () => {
    const analytics = createNoopAnalytics();
    expect(() => analytics.trackPageView("/home")).not.toThrow();
    expect(() => analytics.trackEvent("Purchase", { value: 10 })).not.toThrow();
    expect(typeof analytics.trackPageView).toBe("function");
    expect(typeof analytics.trackEvent).toBe("function");
  });
});
