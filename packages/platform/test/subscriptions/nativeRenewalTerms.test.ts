import { describe, expect, it } from "vitest";
import { createNativeRenewalCodec } from "../../src/subscriptions/nativeRenewalCodec.js";
import { nativeRenewalPrice, nativeRenewalTermsSchema } from "../../src/subscriptions/nativeRenewalTerms.js";
import { resolveThresholdShipping, summarizeThresholdShipping } from "../../src/shipping/thresholdPolicy.js";
import { mapInvoiceClaimToProviderSnapshot } from "../../src/invoicing/snapshot.js";
import type { RenewalRetainedTerms } from "../../src/subscriptions/contracts/renewal.js";

const at = "2026-01-01T00:00:00.123456Z";
const sub = "abcdef01-2345-4678-9abc-def012345678", client = "abcdef02-2345-4678-9abc-def012345678";
const shipping = { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 640, freeThresholdMinor: 7300 } as const;
const line = (unitAmountMinor: number) => ({ lineOrdinal: 1, sku: "SYNTHETIC-REFILL", quantity: 1, unitAmountMinor });
function terms(discount = 1800): RenewalRetainedTerms {
  return { version: "native.renewal-terms.v1", shippingTerms: shipping, minimumPayableMinor: 55, normalCadenceDays: [10, 20, 30],
    starterPack: { schemaVersion: "1", basisTemplateVersion: 1, starterIntervalDays: 7,
      delivery2: { discountBps: 2500, discountMinor: discount, basisSubtotalMinor: 9000 },
      graduation: { cadenceDays: 20, lines: [{ sku: "SYNTHETIC-REFILL", qty: 2, sortOrder: 0, isAddon: false,
        quoteLine: { unitPriceGross: { amountMinor: 6000 }, lineSubtotalGross: { amountMinor: 12000 } } }] } } };
}
function row(retained?: RenewalRetainedTerms, subtotal = 9000) {
  return { subscription_id: sub, client_id: client, cadence_days: 7, template_version: 1, scheduled_at: at,
    currency_code: "XXX", stock_source_key: "synthetic-stock", settlement_channel_key: "sandbox", authorization_ref: "synthetic-authorization",
    payer_account_ref: null, unattended_charge_authorized_at: at, next_cycle_number: 1, paid_cycle_count: 1,
    activation_cycle_id: "abcdef03-2345-4678-9abc-def012345678", activation_cycle_paid: true, delivery_admission: "allowed",
    purchase_facts: { templateId: "synthetic-template", shippingAmountMinor: 0, acquisitionRef: null,
      ...(retained ? { renewalTerms: retained } : {}) }, lines: [line(subtotal)] };
}

describe("retained renewal pricing characterization", () => {
  it.each([7299, 7300, 7301])("agrees with threshold shipping after discounts leave %i", product => {
    const current = row(terms(9000 - product));
    const price = nativeRenewalPrice(current, current.lines, 2);
    const fee = resolveThresholdShipping(shipping, product).grossMinor;
    expect(price).toMatchObject({ productSubtotalAmountMinor: 9000, discountAmountMinor: 9000 - product,
      shippingAmountMinor: fee, totalAmountMinor: product + fee, shippingTerms: shipping });
    const display = { productPayableMinor: product, totalMinor: price.totalAmountMinor, shippingGrossMinor: fee,
      shippingDiscountMinor: 0, terms: shipping };
    expect(summarizeThresholdShipping(display)).toMatchObject({ shippingIsFree: product >= 7300,
      remainingMinor: product < 7300 ? 7300 - product : 0 });
    expect(summarizeThresholdShipping({ ...display, stale: true }).remainingMinor).toBe(0);
    const invoice = mapInvoiceClaimToProviderSnapshot({ orderRef: "synthetic-renewal", issueDate: "2026-01-01", sellDate: "2026-01-01",
      currency: "XXX", seller: {}, buyerSnapshot: { name: "Synthetic buyer" }, documentKind: "receipt", governmentClearanceRequired: false,
      payment: {}, linesSnapshot: [{ name: "Refill", quantity: 1, unitGrossMinor: 9000, totalGrossMinor: 9000, vatRate: "0" }],
      totalGrossMinor: product + fee, totalNetMinor: product + fee,
      orderMoney: { subtotalCents: 9000, discountCents: 9000 - product, totalCents: product + fee } },
    { defaultBuyerLabel: "Buyer", defaultLineLabel: "Product", deliveryLabel: "Delivery", defaultTaxRate: "0" });
    expect(invoice.lines.reduce((sum, item) => sum + item.totalGrossMinor, 0)).toBe(price.totalAmountMinor);
    expect(invoice.chargedTotalGrossMinor).toBe(price.totalAmountMinor);
  });

  it("keeps frozen delivery-two money after a template bump or list-price change", () => {
    const retained = terms();
    retained.linePricing = [{ sku: "SYNTHETIC-REFILL", quantity: 1, unitAmountMinor: 9000, isAddon: false,
      quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: 12000 }] } }];
    const current = { ...row(retained), template_version: 3 };
    expect(nativeRenewalPrice(current, current.lines, 2)).toMatchObject({ discountAmountMinor: 1800, totalAmountMinor: 7840 });
  });

  it("uses the saved list target for changed lines and the saved fallback only without complete evidence", () => {
    const retained = terms();
    retained.linePricing = [{ sku: "SYNTHETIC-REFILL", quantity: 1, unitAmountMinor: 10000, isAddon: false,
      quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: 12001 }] } }];
    const current = row(retained, 10000);
    expect(nativeRenewalPrice(current, current.lines, 2).discountAmountMinor).toBe(999);
    retained.linePricing = [];
    expect(nativeRenewalPrice(current, current.lines, 2).discountAmountMinor).toBe(2500);
    const tiny = row(retained, 50);
    expect(nativeRenewalPrice(tiny, tiny.lines, 2).discountAmountMinor).toBe(0);
    expect(nativeRenewalPrice(current, current.lines, 3).discountAmountMinor).toBe(0);
  });

  it("computes delivery-two discounts in exact integers beyond float precision", () => {
    const large = (unitAmountMinor: number, discountBps: number, list?: number) => {
      const retained = terms();
      retained.starterPack!.delivery2 = { discountBps, discountMinor: 1, basisSubtotalMinor: 10_000 };
      retained.linePricing = list === undefined ? [] : [{ sku: "SYNTHETIC-REFILL", quantity: 1, unitAmountMinor, isAddon: false,
        quoteLine: { pricingComponents: [{ componentType: "base_unit", amountMinor: list }] } }];
      const current = row(retained, unitAmountMinor);
      return nativeRenewalPrice(current, current.lines, 2).discountAmountMinor;
    };
    // Reference integer results: subtotal - ceil(list × (10 000 - bps) / 10 000), and round(subtotal × bps / 10 000).
    expect(large(1_275_605_109_999, 1, 1_275_605_109_999)).toBe(127_560_510);
    expect(large(16_361_442_052_567, 7388)).toBe(12_087_833_388_436);
  });

  it("retains old wire bytes and accepts uppercase schedule UUIDs by value", () => {
    const codec = createNativeRenewalCodec(), current = row();
    const schedule = { subscriptionId: sub.toUpperCase(), scheduledAt: at, scheduledInstant: Date.parse(at) };
    const old = codec.freeze(current, schedule), wire = codec.encode(old);
    expect(old.frozenRevision).toBe("native.purchase-renewal.v1");
    expect(codec.encode(codec.decode(wire))).toEqual(wire);
    const next = codec.freeze(row(terms()), schedule);
    expect(next).toMatchObject({ subscriptionId: sub, frozenRevision: "native.purchase-renewal.v2",
      pricingSnapshot: { totalAmountMinor: 7840 }, orderSnapshot: { shippingQuoteRef: { kind: "retained_shipping" } } });
    expect(codec.decode(codec.encode(next))).toEqual(next);
    const damaged = { ...next, pricingSnapshot: { ...next.pricingSnapshot, totalAmountMinor: 1 } };
    damaged.frozenFingerprint = codec.fingerprint(damaged);
    expect(() => codec.encode(damaged)).toThrow("snapshot_inconsistent");
  });

  it("refuses damaged terms instead of treating them as an ordinary or free renewal", () => {
    expect(() => nativeRenewalTermsSchema.parse({ ...terms(), shippingTerms: null })).toThrow();
    expect(() => nativeRenewalTermsSchema.parse({ ...terms(), normalCadenceDays: [10] })).toThrow();
    expect(() => nativeRenewalTermsSchema.parse({ ...terms(), minimumPayableMinor: 8000 })).toThrow();
    expect(() => nativeRenewalPrice(row({ ...terms(), shippingTerms: { ...shipping, currency: "YYY" } }), [line(9000)], 2)).toThrow("currency_mismatch");
  });

  it("keeps the zero-shipping marker when only acquisition terms were added", () => {
    const retained = terms(); delete retained.shippingTerms;
    const codec = createNativeRenewalCodec(), schedule = { subscriptionId: sub, scheduledAt: at, scheduledInstant: Date.parse(at) };
    const snapshot = codec.freeze(row(retained), schedule);
    expect(snapshot.pricingSnapshot).toMatchObject({ discountAmountMinor: 1800, totalAmountMinor: 7200, shippingAmountMinor: 0 });
    expect(snapshot.orderSnapshot.shippingQuoteRef).toBeNull();
    const bound = codec.withDestination!(snapshot, "abcdef04-2345-4678-9abc-def012345678");
    expect(bound.orderSnapshot.shippingQuoteRef).toEqual({ kind: "zero_shipping", shippingAmountMinor: 0 });
    expect(codec.decode(codec.encode(bound))).toEqual(bound);
  });
});
