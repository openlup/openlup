import { describe, expect, it, vi } from "vitest";
import { resolveBundleExpansion } from "./channelBundleIngestStep.js";
import type { NormalizedChannelOrder } from "../../../src/domains/channels/orderContracts.js";

function order(sellable: Record<string, unknown>): NormalizedChannelOrder {
  return {
    contractVersion: "channel.order.v1",
    channelSlug: "sim-market",
    externalOrderRef: "EXT-1",
    externalOrderRevision: null,
    providerEventId: "evt-1",
    placedAt: "2026-08-14T09:00:00Z",
    currency: "XTS",
    buyer: {
      externalCustomerRef: null,
      email: null,
      emailIsMasked: false,
      firstName: null,
      lastName: null,
      phone: null,
      taxId: null,
      companyName: null,
    },
    shipTo: {
      recipientName: "Buyer",
      line1: "Street 1",
      line2: null,
      postalCode: "10115",
      city: "Berlin",
      countryCode: "DE",
      phone: null,
      pickupPointRef: null,
    },
    lines: [
      {
        externalLineRef: "L1",
        sellable,
        quantity: 1,
        unitGrossMinor: 1700,
        lineGrossMinor: 1700,
        lineDiscountMinor: 0,
        vatRateBps: 500,
      },
    ],
    shipping: { grossMinor: 0, discountMinor: 0, methodLabel: null, carrierHint: null },
    totals: {
      itemsGrossMinor: 1700,
      itemsDiscountMinor: 0,
      shippingGrossMinor: 0,
      shippingDiscountMinor: 0,
      grandTotalMinor: 1700,
    },
    payment: {
      state: "paid_externally",
      externalPaymentRef: "PAY-1",
      paidAt: "2026-08-14T09:05:00Z",
      methodLabel: null,
    },
    payloadDigest: "digest-1",
  } as NormalizedChannelOrder;
}

const skuOrder = order({ kind: "sku", externalOfferRef: "OFFER-1", skuCode: "SKU-A" });
const bundleOrder = order({ kind: "bundle", externalOfferRef: "OFFER-1", bundleCode: "starter" });

const bundles = {
  readActiveBundleCompositions: vi.fn(async () => [
    {
      bundleCode: "starter",
      components: [
        { skuCode: "SKU-A", quantity: 1, referenceUnitPriceMinor: 1000 },
        { skuCode: "SKU-B", quantity: 1, referenceUnitPriceMinor: 700 },
      ],
    },
  ]),
};

describe("channel bundle ingest step", () => {
  it("does not touch the catalogue for an order with no bundle line", async () => {
    const read = { readActiveBundleCompositions: vi.fn() };
    const result = await resolveBundleExpansion({ bundles: read, order: skuOrder, currency: "XTS" });

    expect(result).toEqual({ ok: true, lines: undefined });
    expect(read.readActiveBundleCompositions).not.toHaveBeenCalled();
  });

  // `undefined` and `[]` are different answers: the store reads undefined as "write the wire lines"
  // and an empty array would be an order with no lines at all.
  it("answers undefined rather than an empty set when nothing was expanded", async () => {
    const result = await resolveBundleExpansion({ bundles, order: skuOrder, currency: "XTS" });
    expect(result.ok === true && result.lines).toBeUndefined();
  });

  it("expands a bundle line through the catalogue, in the channel's currency", async () => {
    const result = await resolveBundleExpansion({ bundles, order: bundleOrder, currency: "XTS" });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.lines).toHaveLength(2);
    expect(bundles.readActiveBundleCompositions).toHaveBeenCalledWith({ currency: "XTS" });
  });

  it("refuses a bundle line where no catalogue is bound, naming the wire token", async () => {
    const result = await resolveBundleExpansion({
      bundles: undefined,
      order: bundleOrder,
      currency: "XTS",
    });

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.refusal.kind).toBe("unmapped_sellable");
    expect(result.refusal.vocabulary).toBe("starter");
    expect(result.refusal.detail).toContain("no bundle catalogue is bound");
  });

  it("says an unmapped code is not sellable TODAY, which is what the active read means", async () => {
    const result = await resolveBundleExpansion({
      bundles: { readActiveBundleCompositions: vi.fn(async () => []) },
      order: bundleOrder,
      currency: "XTS",
    });

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.refusal.kind).toBe("unmapped_sellable");
    expect(result.refusal.detail).toContain("today");
  });

  it("passes a money refusal through with the allocator's own reason", async () => {
    const result = await resolveBundleExpansion({
      bundles: {
        readActiveBundleCompositions: vi.fn(async () => [
          {
            bundleCode: "starter",
            components: [{ skuCode: "SKU-A", quantity: 1, referenceUnitPriceMinor: null }],
          },
        ]),
      },
      order: bundleOrder,
      currency: "XTS",
    });

    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.refusal.kind).toBe("money_mismatch");
    expect(result.refusal.detail).toContain("reference price");
  });
});
