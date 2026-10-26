import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../../src/http/index.js";
import { providerPayerFromRequest, createCheckoutClientAction } from "../../src/commerce/server/index.js";

describe("commerce checkout provider payment helpers", () => {
  it("builds sanitized payer evidence from request headers and checkout intent contact", () => {
    expect(providerPayerFromRequest(
      {
        headers: {
          "x-forwarded-for": " 192.0.2.10, 198.51.100.10 ",
          "user-agent": ["openlupTest/1.0"],
        },
      } as unknown as HttpRequest,
      {
        contact: {
          email: "buyer@example.test",
          firstName: "Buyer",
          lastName: "Example",
        },
      } as never,
    )).toEqual({
      email: "buyer@example.test",
      name: "Buyer Example",
      ip: "192.0.2.10",
      userAgent: "openlupTest/1.0",
    });
  });
});

describe("injected checkout action roles", () => {
  const action = createCheckoutClientAction("embedded", "redirect");
  it("projects only the action belonging to the supplied role while processing", () => {
    expect(action({ provider: "embedded", status: "processing", providerClientSecret: "synthetic-secret", providerRedirectUrl: null })).toEqual({ kind: "provider_embedded", provider: "embedded", clientSecret: "synthetic-secret" });
    expect(action({ provider: "redirect", status: "processing", providerClientSecret: null, providerRedirectUrl: "https://example.test/action" })).toEqual({ kind: "redirect", url: "https://example.test/action" });
    expect(action({ provider: "redirect", status: "processing", providerClientSecret: null, providerRedirectUrl: null })).toEqual({ kind: "none" });
    expect(action({ provider: "embedded", status: "failed", providerClientSecret: "synthetic-secret", providerRedirectUrl: null })).toEqual({ kind: "none" });
  });
});
