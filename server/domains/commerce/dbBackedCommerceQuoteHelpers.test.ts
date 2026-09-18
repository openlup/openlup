import { describe, expect, it, vi } from "vitest";
import {
  CommercePriceAuthorityError,
  type CommercePriceAuthorityPort,
} from "../../../src/domains/pricing/ports.js";
import type { ResolvedPrice } from "../../../src/domains/pricing/types.js";
import { buildLineBreakdown } from "../../../src/domains/commerce/pricingBreakdown.js";
import { CommerceQuoteError } from "../../../src/domains/commerce/ports.js";
import {
  assertSubscriptionCheapest,
  calculateIncludedVat,
  mapPricingComponent,
  resolveStrictQuotePrice,
  toGrossMinor,
} from "./dbBackedCommerceQuoteHelpers.js";

describe("db backed commerce quote helpers", () => {
  it("uses the supplied tax rate for net/gross conversion and included VAT", () => {
    expect(toGrossMinor(price({ amountKind: "net", unitPriceMinor: 10000 }), 2300)).toBe(12300);
    expect(calculateIncludedVat(12300, 2300)).toEqual({ netMinor: 10000, vatMinor: 2300 });
  });

  it("uses the supplied tax rate when comparing subscription and one-time prices", () => {
    expect(() =>
      assertSubscriptionCheapest({
        requestSku: "EXAMPLE-SKU-ALPHA",
        modeAtLine: "subscription",
        resolved: price({ mode: "subscription", amountKind: "net", unitPriceMinor: 10000 }),
        oneTime: price({ mode: "one_time", amountKind: "gross", unitPriceMinor: 10000 }),
        vatRateBps: 2300,
      }),
    ).toThrow("Subscription price must not exceed active one-time price");
  });

  it("maps only named strict-authority refusals to a safe quote error", async () => {
    const refusal = new CommercePriceAuthorityError("base_price_ambiguous");
    const rawAdapterError = new Error("raw adapter query failure");
    const authority: CommercePriceAuthorityPort = {
      resolvePrice: vi.fn()
        .mockRejectedValueOnce(refusal)
        .mockRejectedValueOnce(rawAdapterError),
    };
    const input = {
      commercePriceAuthorityPort: authority,
      variantId: "variant-alpha",
      mode: "one_time" as const,
      regionCode: "EXAMPLE",
      currency: "USD",
      channel: "test",
      atTime: "2026-06-05T10:00:00.000Z",
    };

    await expect(resolveStrictQuotePrice(input)).rejects.toMatchObject({
      name: "CommerceQuoteError",
      code: "PRICE_NOT_CONFIGURED",
      details: { reason: "base_price_ambiguous" },
    });
    await expect(resolveStrictQuotePrice(input)).rejects.toBe(rawAdapterError);
  });

  it("carries every component type the quote transport declares", () => {
    for (const componentType of
      ["base_unit", "mode_discount", "qty_tier", "promo", "loyalty", "shipping", "bundle"] as const) {
      expect(mapPricingComponent({
        sequence: 0,
        component_type: componentType,
        amount_minor: -250,
        reason_code: "example_reason",
        reason_payload: { example: true },
      }, "line")).toEqual({
        scope: "line",
        componentType,
        amountMinor: -250,
        reasonCode: "example_reason",
        reasonPayload: { example: true },
      });
    }
  });

  it("carries the kernel-produced bundle component after the wave-A3 widening", () => {
    // Wave A2 pinned this exact input as REFUSED while the transport union lagged the
    // kernel vocabulary; wave A3 widened the union together with the
    // order_line_pricing_breakdown component_type CHECK, so the same real kernel
    // output must now map through unchanged.
    const components = buildLineBreakdown({
      variant_id: "variant-alpha",
      line_qty: 2,
      base_unit_price_minor: 1000,
      resolved_unit_price_minor: 1000,
      matched_tier_min_qty: 1,
      mode_at_line: "one_time",
      mode_resolved_via_fallback: false,
      bundle_allocated_discount_minor: 250,
    });
    const carried = components.find((component) => component.component_type === "bundle");

    expect(carried).toBeDefined();
    expect(mapPricingComponent(carried!, "line")).toMatchObject({
      scope: "line",
      componentType: "bundle",
      amountMinor: -250,
    });
  });

  it("refuses a component type the quote transport cannot carry, loudly", () => {
    // The kernel and transport vocabularies currently coincide, so no real kernel
    // output can exercise this branch; the guard exists for the NEXT kernel widening,
    // and this constructed value is deliberately outside both vocabularies.
    const uncarried = {
      sequence: 0,
      component_type: "not_a_transport_type",
      amount_minor: -1,
      reason_code: "example_reason",
      reason_payload: {},
    } as unknown as Parameters<typeof mapPricingComponent>[0];

    expect(() => mapPricingComponent(uncarried, "line")).toThrow(CommerceQuoteError);
    expect(() => mapPricingComponent(uncarried, "line"))
      .toThrow("Pricing component type is not carried by the quote transport");
    try {
      mapPricingComponent(uncarried, "line");
    } catch (error) {
      expect(error).toBeInstanceOf(CommerceQuoteError);
      expect((error as CommerceQuoteError).code).toBe("PRICING_INVARIANT_VIOLATION");
      expect((error as CommerceQuoteError).details).toMatchObject({ componentType: "not_a_transport_type" });
    }
  });
});

function price(overrides: Partial<ResolvedPrice>): ResolvedPrice {
  return {
    variantId: "variant-alpha",
    mode: "one_time",
    matchedMinQty: 1,
    unitPriceMinor: 10000,
    amountKind: "gross",
    priceListId: "list-example",
    priceEntryId: "price-example",
    resolvedAt: "2026-06-05T10:00:00.000Z",
    ...overrides,
  };
}
