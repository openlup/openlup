import { expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import * as contracts from "../../src/commerce/contracts/index.js";
import type { CommerceOfferAvailabilityPort } from "../../src/commerce/contracts/index.js";
import { buildOrderDeliveryContact, CommerceOrderDraftPriceChangedError, CommerceOrderDraftUnsupportedMoneyError, createOfferAvailabilitySchemas, messageOf, offerAvailabilityRequestItems, uuidFromOrderRef } from "../../src/commerce/index.js";

it("keeps the contracts entry type-only and fits the availability success and refusal boundary", async () => {
  expect(Object.keys(contracts)).toEqual([]);
  const schemas = createOfferAvailabilitySchemas(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string().regex(/^[A-Z-]+$/));
  const items = offerAvailabilityRequestItems([
    { sku: "ITEM-B", slug: "item-b", variantId: "variant-b" },
    { sku: "ITEM-A", slug: "item-a", variantId: "variant-a" },
  ], "subscription");
  expect(items).toEqual([
    { sku: "ITEM-B", productSlug: "item-b", variantId: "variant-b", requestedQuantity: 1, checkoutMode: "subscription" },
    { sku: "ITEM-A", productSlug: "item-a", variantId: "variant-a", requestedQuantity: 1, checkoutMode: "subscription" },
  ]);
  expect(offerAvailabilityRequestItems([], "one_time")).toEqual([]);
  expect(schemas.commerceOfferAvailabilityRequestItemSchema.safeParse({ ...items[0], requestedQuantity: 0 }).success).toBe(false);
  expect(schemas.commerceOfferAvailabilityRequestItemSchema.safeParse({ ...items[0], extra: true }).success).toBe(false);
  const unknown = { sku: "ITEM-B", productSlug: "item-b", variantId: "variant-b", status: "unknown" as const,
    visibleInConfigurator: true, sellableNow: null, reasonCode: "unavailable", source: "host" };
  const port: CommerceOfferAvailabilityPort = { async getAvailability(input) {
    expect(input.items).toEqual(items);
    return [schemas.commerceOfferAvailabilitySchema.parse(unknown)];
  } };
  expect(await port.getAvailability({ items })).toEqual([unknown]);
  expectTypeOf<Parameters<CommerceOfferAvailabilityPort["getAvailability"]>[0]["items"]>().toEqualTypeOf<readonly contracts.CommerceOfferAvailabilityRequestItem[]>();
});

it("preserves order-owned delivery authority and exact helper/error results", () => {
  const contact = { recipientName: " Buyer A ", contactEmail: "buyer@example.test", contactPhone: "123456789",
    line1: "Example 1", city: "Example", postalCode: "00000", country: "AA" };
  expect(buildOrderDeliveryContact(contact)).toEqual({ ...contact, recipientName: "Buyer A", schemaVersion: 1,
    source: "checkout_submission", revision: 1, line2: null, selectedDelivery: null, deliveryInstructions: null, courierInstructions: null });
  const delivery = { serviceRef: "service-a" };
  expect(buildOrderDeliveryContact({ ...contact, selectedDelivery: delivery, line2: "Unit 2", deliveryInstructions: "Note", courierInstructions: "Gate" }))
    .toMatchObject({ selectedDelivery: delivery, line2: "Unit 2", deliveryInstructions: "Note", courierInstructions: "Gate" });
  expect(uuidFromOrderRef("order_a")).toBe("a");
  expect(uuidFromOrderRef("prefix_order_a")).toBe("prefix_order_a");
  expect(messageOf(new Error("refused"), "draft")).toBe("draft: refused");
  expect(messageOf(null, "draft")).toBe("draft: unknown");
  const details = { reason: "claim_changed" };
  expect(new CommerceOrderDraftPriceChangedError(undefined, details)).toMatchObject({ name: "CommerceOrderDraftPriceChangedError", details });
  expect(new CommerceOrderDraftUnsupportedMoneyError("zero_payable_unsupported")).toMatchObject({ name: "CommerceOrderDraftUnsupportedMoneyError", reason: "zero_payable_unsupported" });
});

it("fits host-specialized ports and keeps offer binding out of the client request", async () => {
  type Intent = { offerVersion?: string; minimumUnits?: number };
  type Quote = { totalMinor: number };
  const policy: contracts.CheckoutOfferPolicyPort<Intent, Quote> = {
    async resolve({ intent, checkoutKind }) {
      expect(checkoutKind).toBe("one_time");
      return intent.offerVersion === "offer-a.v2" ? { kind: "bound", offerVersion: intent.offerVersion } : { kind: "refused", reason: "unknown_offer" };
    },
    async evidence({ offerVersion, quote }) { return { offerVersion, totalMinor: quote.totalMinor }; },
  };
  expect(await policy.resolve({ intent: {}, checkoutKind: "one_time" })).toEqual({ kind: "refused", reason: "unknown_offer" });
  expect(await policy.resolve({ intent: { offerVersion: "offer-a.v2" }, checkoutKind: "one_time" })).toEqual({ kind: "bound", offerVersion: "offer-a.v2" });
  expect(await policy.evidence({ intent: {}, offerVersion: "offer-a.v2", quote: { totalMinor: 120 } })).toEqual({ offerVersion: "offer-a.v2", totalMinor: 120 });
  type QuotePort = import("../../src/commerce/index.js").CommerceQuotePort<Intent, Quote, { traceId?: string }>;
  const quotePort: QuotePort = { async createQuote(_request, options) {
    expect(options?.offerVersion).toBe("offer-a.v2");
    expect(options?.traceId).toBe("trace-a");
    return { totalMinor: 120 };
  } };
  expect(await quotePort.createQuote({}, { offerVersion: "offer-a.v2", traceId: "trace-a" })).toEqual({ totalMinor: 120 });
  type Vocabulary = { currency: "XXX"; intentStatus: "paid"; executionProvider: "provider-a";
    executionAttemptStatus: "processing"; nextActionKind: "none"; attemptStatus: "created"; targetKind: "order" };
  type PaymentPort = contracts.PaymentControlRuntimePort<Vocabulary, { resultStatus: "paid" }>;
  type Evidence = Parameters<NonNullable<PaymentPort["reopenInteractivePreparedAttempt"]>>[0]["evidence"];
  expectTypeOf<Evidence>().toEqualTypeOf<never>();
  type HostPort = contracts.PreparedProviderAttemptRuntimePort<Vocabulary, { resultStatus: "paid" }, { mode: "trusted_pre_dispatch" }>;
  expectTypeOf<Parameters<HostPort["prepareProviderAttempt"]>[0]["provider"]>().toEqualTypeOf<"provider-a">();
  expectTypeOf<Parameters<NonNullable<HostPort["reopenInteractivePreparedAttempt"]>>[0]["evidence"]>().toEqualTypeOf<{ mode: "trusted_pre_dispatch" }>();
});
