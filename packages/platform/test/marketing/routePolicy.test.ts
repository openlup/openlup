import { expect, it } from "vitest";
import { createAnalyticsRoutePolicy } from "../../src/marketing/index.js";
const policy = createAnalyticsRoutePolicy({
  publicPaths: ["/", "/contact", "/catalog/item-one", "/groups/group-one", "/privacy"],
  redirectSources: [], privatePathPrefixes: ["/admin", "/account"],
  privateAuthPaths: ["/login", "/sign-in"], capabilityPathPrefixes: ["/access", "/review"],
});
it.each(["/", "/contact", "/catalog/item-one", "/groups/group-one", "/privacy"])("admits known public path %s", path => {
  expect(policy.isDeploymentAnalyticsRouteEligible(path)).toBe(true);
});
it("admits only exact additional public paths", () => {
  const extra = new Set(["/campaign-entry"]);
  expect(policy.isDeploymentAnalyticsRouteEligible("/campaign-entry", extra)).toBe(true);
  expect(policy.isDeploymentAnalyticsRouteEligible("/campaign-entry/private", extra)).toBe(false);
});
it.each(["/unknown", "/catalog/unknown", "/catalog/item-one/secret-tail", "/groups/unknown", "/reference-store",
  "/admin", "/account/order/status", "/review/token", "/ACCESS/token"])("refuses unknown or sensitive path %s", path => {
  expect(policy.isDeploymentAnalyticsRouteEligible(path)).toBe(false);
});
it("preserves broad optional eligibility and sensitive-path normalization asymmetry", () => {
  expect(policy.isOptionalAnalyticsRouteEligible("/unknown")).toBe(true);
  expect(policy.isOptionalAnalyticsRouteEligible("/login")).toBe(false);
  expect(policy.isOptionalAnalyticsRouteEligible("/review/token")).toBe(false);
  expect(policy.isOptionalAnalyticsRouteEligible("/Admin")).toBe(true);
  expect(policy.isOptionalAnalyticsRouteEligible("/sign-in/")).toBe(true);
  expect(policy.isDeploymentAnalyticsRouteEligible("/Admin")).toBe(false);
  expect(policy.isDeploymentAnalyticsRouteEligible("/sign-in/")).toBe(false);
});
it("retains one valid campaign value per allowed key and removes other URL data", () => {
  expect(policy.sanitizeDeploymentAnalyticsUrl("https://shop.example/CONTACT/?utm_source=launch_1&utm_medium=email&utm_campaign=autumn-sale&utm_content=hero&utm_term=unit&click_id=secret#token", "https://shop.example"))
    .toBe("https://shop.example/contact?utm_source=launch_1&utm_medium=email&utm_campaign=autumn-sale&utm_content=hero&utm_term=unit");
});
it("drops duplicate and invalid campaign values", () => {
  expect(policy.sanitizeDeploymentAnalyticsUrl(`https://shop.example/contact?utm_source=one&utm_source=two&utm_medium=space%20value&utm_campaign=${"a".repeat(101)}&utm_term=fresh_value`, "https://shop.example"))
    .toBe("https://shop.example/contact?utm_term=fresh_value");
  expect(policy.sanitizeDeploymentAnalyticsUrl("https://shop.example/review/token?utm_source=safe", "https://shop.example")).toBeNull();
});
it.each(["javascript:alert(1)", "https://user:pass@shop.example/contact", "https://other.example/contact"])("refuses unsafe or foreign URL %s", url => {
  expect(policy.sanitizeDeploymentAnalyticsUrl(url, "https://shop.example")).toBeNull();
});
// New seam 5: host manifest/redirect injection has no ambient route source.
it("normalizes injected manifest paths and ignores parameter redirects", () => {
  const injected = createAnalyticsRoutePolicy({ publicPaths: ["ENTRY///"], redirectSources: ["/OLD/", "/item/:id"],
    privatePathPrefixes: [], privateAuthPaths: [], capabilityPathPrefixes: [] });
  expect(injected.isDeploymentAnalyticsRouteEligible("/entry")).toBe(true);
  expect(injected.isDeploymentAnalyticsRouteEligible("/old")).toBe(true);
  expect(injected.isDeploymentAnalyticsRouteEligible("/item/:id")).toBe(false);
  expect(injected.isDeploymentAnalyticsRouteEligible("/contact")).toBe(false);
});
