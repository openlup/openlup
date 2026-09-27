import { describe, expect, it } from "vitest";

import {
  isDeploymentAnalyticsRouteEligible,
  isGtmAnalyticsRouteEligible,
  sanitizeDeploymentAnalyticsUrl,
} from "./routePolicy";

describe("analytics route policy", () => {
  it.each([
    "/",
    "/contact",
    "/psy/jagniecina",
    "/rasy/maltanczyk",
    "/privacy",
  ])("admits known public deployment route %s", (path) => {
    expect(isDeploymentAnalyticsRouteEligible(path)).toBe(true);
  });

  it("admits only exact deployment-provided SPA paths", () => {
    const additionalPaths = new Set(["/campaign-entry"]);
    expect(isDeploymentAnalyticsRouteEligible("/campaign-entry", additionalPaths)).toBe(true);
    expect(isDeploymentAnalyticsRouteEligible("/campaign-entry/private", additionalPaths)).toBe(false);
  });

  it.each([
    "/not-a-real-page",
    "/psy/unknown",
    "/psy/jagniecina/secret-tail",
    "/rasy/unknown",
    "/reference-store",
    "/admin",
    "/account/order/status",
    "/review/capability-token",
    "/MOJA-OPINIA/capability-token",
  ])("rejects unknown or sensitive deployment route %s", (path) => {
    expect(isDeploymentAnalyticsRouteEligible(path)).toBe(false);
  });

  it("preserves GTM's old broad eligibility while sharing sensitive checks", () => {
    expect(isGtmAnalyticsRouteEligible("/not-a-real-page")).toBe(true);
    expect(isGtmAnalyticsRouteEligible("/zaloguj-sie")).toBe(false);
    expect(isGtmAnalyticsRouteEligible("/review/token")).toBe(false);
    expect(isGtmAnalyticsRouteEligible("/Admin")).toBe(true);
    expect(isGtmAnalyticsRouteEligible("/sign-in/")).toBe(true);
    expect(isDeploymentAnalyticsRouteEligible("/Admin")).toBe(false);
    expect(isDeploymentAnalyticsRouteEligible("/sign-in/")).toBe(false);
  });

  it("keeps one valid value per known campaign key and removes all other URL data", () => {
    expect(sanitizeDeploymentAnalyticsUrl(
      "https://shop.example/CONTACT/?utm_source=launch_1&utm_medium=email&utm_campaign=fall-sale&utm_content=hero&utm_term=box&gclid=secret#token",
      "https://shop.example",
    )).toBe(
      "https://shop.example/contact?utm_source=launch_1&utm_medium=email&utm_campaign=fall-sale&utm_content=hero&utm_term=box",
    );
  });

  it("drops duplicate and invalid campaign values without storing attribution", () => {
    const long = "a".repeat(101);
    expect(sanitizeDeploymentAnalyticsUrl(
      `https://shop.example/contact?utm_source=one&utm_source=two&utm_medium=space%20value&utm_campaign=${long}&utm_term=fresh_value`,
      "https://shop.example",
    )).toBe("https://shop.example/contact?utm_term=fresh_value");
    expect(sanitizeDeploymentAnalyticsUrl(
      "https://shop.example/review/token?utm_source=safe",
      "https://shop.example",
    ))
      .toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "https://user:pass@shop.example/contact",
    "https://other.example/contact",
  ])("rejects unsafe or cross-origin URL %s", (url) => {
    expect(sanitizeDeploymentAnalyticsUrl(url, "https://shop.example")).toBeNull();
  });
});
