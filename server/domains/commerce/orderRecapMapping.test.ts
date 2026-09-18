import { describe, expect, it } from "vitest";
import {
  frozenOrderLineLabel,
  buildEffectiveRecapAddress,
  mapOrderRecapLines,
  readQuoteContextFromMetadata,
  toOrderMoneyItem,
} from "./orderRecapMapping.js";
import { deliveryContactFixture } from "../../../src/domains/commerce/omsClient.fixtures.js";

/**
 * Deliberately NOT the platform default, for the same reason as the customer
 * order-history mapper's test: the recap must denominate a line in the currency stored on
 * the order it recaps, and only a non-default value can falsify a re-introduced literal.
 */
const STORED_CURRENCY = "EUR";

describe("order recap canonical-money mapping", () => {
  it("keeps one frozen-label precedence for recaps and transactional mail", () => {
    expect(frozenOrderLineLabel(
      { title: "Frozen item title" },
      { title: "Frozen unit title", name: "Ignored unit name" },
    )).toBe("Frozen unit title");
    expect(frozenOrderLineLabel({ name: "Frozen item name" }, {}))
      .toBe("Frozen item name");
    expect(frozenOrderLineLabel({}, {})).toBeNull();
  });

  it("keeps the customer line total catalog-priced while money is effective", () => {
    const [line] = mapOrderRecapLines(
      [{
        quantity: 1,
        total_cents: 1_000,
        product_snapshot: { title: "Wołowina", sku: "LEGACY-BEEF-400" },
        variant_snapshot: { sku: "OPENLUP-BEEF-400", formatCode: "can_400g" },
      }],
      [{
        id: "line-1",
        quantity: 1,
        catalogUnit: 1_000,
        catalogTotal: 1_000,
        discountAllocated: 100,
        effectiveGross: 900,
        effectiveNet: 833,
        vatRateBps: 800,
      }],
      STORED_CURRENCY,
    );

    expect(line).toMatchObject({
      total: { amountMinor: 1_000, currency: STORED_CURRENCY },
      sku: "OPENLUP-BEEF-400",
      variantCode: "can_400g",
      catalogUnitGross: 1_000,
      catalogTotalGross: 1_000,
      discountAllocated: 100,
      effectiveGross: 900,
      effectiveNet: 833,
      vatRateBps: 800,
    });
  });

  it("nulls invalid persisted identifiers instead of breaking recap display", () => {
    const [line] = mapOrderRecapLines(
      [{
        quantity: 1,
        total_cents: 1_000,
        product_snapshot: { title: "Wołowina", sku: "unsafe sku" },
        variant_snapshot: { formatCode: "../../customer" },
      }],
      [{
        id: "line-1",
        quantity: 1,
        catalogUnit: 1_000,
        catalogTotal: 1_000,
        discountAllocated: 0,
        effectiveGross: 1_000,
        effectiveNet: 1_000,
        vatRateBps: 0,
      }],
      STORED_CURRENCY,
    );

    expect(line).toMatchObject({ title: "Wołowina", sku: null, variantCode: null });
  });

  it("maps nullable canonical columns and reads quote context without quote money", () => {
    expect(toOrderMoneyItem({
      id: "line-1",
      quantity: 1,
      unit_price_cents: 1_000,
      total_cents: 1_000,
      discount_allocated_cents: null,
      effective_total_cents: null,
      effective_net_cents: null,
      vat_rate_bps: 800,
    })).toMatchObject({ effective_total_cents: null });
    expect(readQuoteContextFromMetadata({
      quoteSnapshot: { quote: { context: { cadenceDays: 30 }, totalGross: 99_999 } },
    })).toEqual({ cadenceDays: 30 });
  });

  it("resolves parcel then order override then immutable order contact", () => {
    const contact = (line1: string, revision: number) =>
      deliveryContactFixture({ source: "test", revision, line1 }).canonical;
    const metadata = {
      runtimeFinalize: { deliveryContact: contact("Baseline 1", 1) },
      deliveryContactOverride: contact("Override 2", 2),
    };

    expect(buildEffectiveRecapAddress(metadata, {
      deliveryContact: contact("Parcel 3", 3),
    })?.line1).toBe("Parcel 3");
    expect(buildEffectiveRecapAddress(metadata, {})?.line1).toBe("Override 2");
    expect(buildEffectiveRecapAddress({ runtimeFinalize: metadata.runtimeFinalize }, {})?.line1)
      .toBe("Baseline 1");
    expect(buildEffectiveRecapAddress({}, {})).toBeNull();
    const legacyAddress = deliveryContactFixture({ line1: "Legacy 4" }).address;
    expect(buildEffectiveRecapAddress({}, {}, {
      ...legacyAddress,
      postal_code: legacyAddress.postalCode,
    })?.line1).toBe("Legacy 4");
    const mutableAddress = deliveryContactFixture({ line1: "Must not leak" }).address;
    expect(buildEffectiveRecapAddress({
      runtimeFinalize: { deliveryContact: { schemaVersion: 1, revision: "broken" } },
    }, {}, {
      ...mutableAddress,
      postal_code: mutableAddress.postalCode,
    })).toBeNull();
  });
});
