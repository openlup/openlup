import { describe, expect, it } from "vitest";
import {
  SITE_ORIGIN,
  absoluteUrl,
  alternatePathForLang,
  alternatePathForLangPreservingState,
  findRouteKeyByPath,
  localizedPath,
  localizedPathWithState,
} from "@/lib/i18nRoutes";

describe("i18nRoutes", () => {
  it("returns localized paths for known route keys", () => {
    expect(localizedPath("home", "pl")).toBe("/");
    expect(localizedPath("waitlist", "en")).toBe("/waitlist-en");
  });

  it("returns localized paths for new EN parity routes", () => {
    expect(localizedPath("homeV2", "pl")).toBe("/v2");
    expect(localizedPath("homeV2", "en")).toBe("/en/v2");
    expect(localizedPath("configurator", "pl")).toBe("/skomponuj-pakiet");
    expect(localizedPath("configurator", "en")).toBe("/build-your-box");
    expect(localizedPath("configuratorThankYou", "en")).toBe("/build-your-box/thank-you");
    expect(localizedPath("configuratorPaymentFailed", "en")).toBe("/build-your-box/payment-failed");
    expect(localizedPath("configuratorPayment", "en")).toBe("/build-your-box/payment");
    expect(localizedPath("configuratorTpaySimulator", "en")).toBe("/build-your-box/tpay-simulator");
    expect(localizedPath("petPersonalizer", "en")).toBe("/your-dog-on-a-can");
    expect(localizedPath("customerLogin", "en")).toBe("/sign-in");
    expect(localizedPath("customerAuthCallback", "en")).toBe("/account/auth/callback");
    expect(localizedPath("customerDashboard", "en")).toBe("/account");
    expect(localizedPath("customerPaymentRecovery", "en")).toBe("/account/payment/recover");
    expect(localizedPath("returnsGuide", "pl")).toBe("/zwroty");
    expect(localizedPath("returnsGuide", "en")).toBe("/returns");
  });

  it("builds absolute URLs against the site origin", () => {
    expect(absoluteUrl("/dogs/lamb")).toBe(`${SITE_ORIGIN}/dogs/lamb`);
  });

  it("finds route metadata for localized paths with or without trailing slashes", () => {
    expect(findRouteKeyByPath("/how-it-works/")).toEqual({
      key: "science",
      lang: "en",
    });
    expect(findRouteKeyByPath("/")).toEqual({
      key: "home",
      lang: "pl",
    });
  });

  it("returns null for unknown paths", () => {
    expect(findRouteKeyByPath("/missing")).toBeNull();
  });

  it("maps alternate languages for known routes and falls back home for unknown ones", () => {
    expect(alternatePathForLang("/psy/jagniecina", "en")).toBe("/dogs/lamb");
    expect(alternatePathForLang("/unknown", "pl")).toBe("/");
  });

  it("maps alternate languages for new hidden routes", () => {
    expect(alternatePathForLang("/skomponuj-pakiet/platnosc", "en")).toBe("/build-your-box/payment");
    expect(alternatePathForLang("/build-your-box/payment-failed", "pl")).toBe("/skomponuj-pakiet/platnosc-nieudana");
    expect(alternatePathForLang("/zrob-puszke", "en")).toBe("/your-dog-on-a-can");
    expect(alternatePathForLang("/account/payment/recover", "pl")).toBe("/konto/platnosc/napraw");
  });

  it("preserves query and hash when switching language or building localized stateful paths", () => {
    expect(
      alternatePathForLangPreservingState(
        "/skomponuj-pakiet/platnosc",
        "en",
        "?order=ord_123&token=keep",
        "#status",
      ),
    ).toBe("/build-your-box/payment?order=ord_123&token=keep#status");

    expect(
      localizedPathWithState("customerPaymentRecovery", "en", "token=abc", "card"),
    ).toBe("/account/payment/recover?token=abc#card");
  });
});
