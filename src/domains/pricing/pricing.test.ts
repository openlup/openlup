import { describe, expect, it } from "vitest";
import { PRICING_MODES, PRICING_AMOUNT_KINDS } from "./types.js";
import { CommercePriceAuthorityError, PricingResolverNotConfiguredError } from "./ports.js";

describe("pricing domain primitives", () => {
  it("exposes the canonical pricing modes", () => {
    expect(PRICING_MODES).toEqual(["one_time", "subscription", "any"]);
  });

  it("exposes both gross and net amount kinds", () => {
    expect(PRICING_AMOUNT_KINDS).toEqual(["gross", "net"]);
  });

  it("PricingResolverNotConfiguredError carries the query context in its message", () => {
    const error = new PricingResolverNotConfiguredError({
      variantId: "variant-example",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "EXAMPLE",
      currency: "USD",
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PricingResolverNotConfiguredError");
    expect(error.message).toContain("variant-example");
    expect(error.message).toContain("one_time");
    expect(error.message).toContain("EXAMPLE/USD");
  });

  it("keeps strict money-authority refusals named", () => {
    const error = new CommercePriceAuthorityError("subscription_price_policy_ambiguous");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CommercePriceAuthorityError");
    expect(error.code).toBe("subscription_price_policy_ambiguous");
    expect(error.message).toBe("subscription_price_policy_ambiguous");
  });
});
