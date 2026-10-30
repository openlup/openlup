import type { NormalizedChannelOrder, ChannelPurchaseCapture } from "../../src/channels/index.js";
import type { ChannelRetainedPurchaseContext } from "../../src/channels/server/index.js";
export const id = (number: number): string => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
export const digest = "c".repeat(64);
export function orderFixture(): NormalizedChannelOrder {
  return {
    contractVersion: "channel.order.v1", channelSlug: "synthetic-surface", externalOrderRef: "sale:47",
    externalOrderRevision: "revision:8", providerEventId: "delivery:903", placedAt: "2026-02-12T08:11:00+01:00", currency: "EUR",
    buyer: { externalCustomerRef: "buyer:61", email: "relay@example.test", emailIsMasked: true,
      firstName: "Zoë", lastName: null, phone: null, taxId: null, companyName: null },
    shipTo: { recipientName: "Zoë Example", line1: "Example Lane 7", line2: null, postalCode: "10115", city: "Example",
      countryCode: "DE", phone: null, pickupPointRef: "locker:24" },
    lines: [{ externalLineRef: "line:19", sellable: { kind: "sku", externalOfferRef: "offer:53", skuCode: "PART-A" },
      quantity: 3, unitGrossMinor: 3, lineGrossMinor: 9, lineDiscountMinor: 4, vatRateBps: 1900 }],
    shipping: { grossMinor: 7, discountMinor: 2, methodLabel: "Collected service", carrierHint: null },
    totals: { itemsGrossMinor: 9, itemsDiscountMinor: 4, shippingGrossMinor: 7, shippingDiscountMinor: 2, grandTotalMinor: 10 },
    payment: { state: "paid_externally", externalPaymentRef: "collection:78", paidAt: "2026-02-12T08:13:17+01:00", methodLabel: null },
    payloadDigest: "wire:χ:512",
  };
}
export function purchaseFixture(): { capture: ChannelPurchaseCapture; context: ChannelRetainedPurchaseContext } {
  const order = orderFixture();
  order.lines[0].sellable = { kind: "bundle", externalOfferRef: "offer:53", bundleCode: null };
  const scope = { connectionId: id(101), channelId: id(102), connectorKind: "synthetic_source", sellerRef: "seller:23",
    environmentRef: "test-region", connectionVersion: 11, registryVersion: 17, currency: "EUR", regionCode: "DE" };
  const namespace = { applicationRef: "application:29", channelExternalRef: "surface:31" };
  const context: ChannelRetainedPurchaseContext = {
    scope, namespace, channelSlug: order.channelSlug,
    listing: { id: id(103), version: 21, scope, bundleId: id(104), externalOfferRef: "offer:53", state: "approved", manualStop: false, approvalId: id(105) },
    bundle: { bundleId: id(104), code: "LOCKED-KIT", compositionDigest: digest, lockedAt: "2026-02-10T10:12:00Z",
      fulfillmentMode: "virtual", constraintRef: null, components: [{ skuId: id(107), skuCode: "PART-A", quantity: 1, isAddon: false }] },
    firstApproval: { id: id(105), listingId: id(103), qualificationId: id(106), listingVersion: 19, approvedBy: id(108),
      approvedAt: "2026-02-10T10:13:00Z", bundleDigest: digest, requestedPrice: { grossMinor: 41, currency: "EUR" },
      controlledDigest: digest, termsDigest: digest, policyRef: "policy:43", firstBasisApprovalId: id(105), recoveryPolicy: "same_approved_offer_when_ready" },
    firstQualification: { id: id(106), listingId: id(103), listingVersion: 18, connectionVersion: 9, registryVersion: 15,
      bundleDigest: digest, catalogHead: { protocol: "catalog.v1", headDigest: null }, purchaseMode: "one_time", sourceDigest: digest,
      policyRef: "policy:43", policyDigest: digest, mapping: [{ skuId: id(107), externalProductRef: "product:59" }],
      basis: [{ skuId: id(107), weightMinor: 1, priceListId: "list:67", priceEntryId: "entry:71", resolvedAt: "2026-02-10T10:01:00Z",
        sourceMode: "one_time", sourceAmountKind: "gross", matchedMinQty: 1 }], requestedPrice: { grossMinor: 41, currency: "EUR" },
      validUntil: "2026-02-10T10:20:00Z", disposition: "qualified", reasons: [],
      offer: { observationRef: "observation:73", observedAt: "2026-02-10T10:02:00Z", scope, externalOfferRef: "offer:53",
        revisionRef: null, controlledDigest: digest, products: [{ externalProductRef: "product:59", quantity: 1,
          unitIdentifiers: [{ kind: "synthetic", issuer: "fixture", value: "unit:79" }] }], price: { grossMinor: 41, currency: "EUR" },
        terms: { digest, deliveryRef: "delivery:83", returnsRef: null, documentPolicyRef: "document:89", fiscalProfileRef: "fiscal:97" },
        sellingState: "ACTIVE", restrictions: [] },
    },
  };
  const capture: ChannelPurchaseCapture = { schemaVersion: "channel.purchase-source.v1", captureId: id(110), scope, namespace,
    execution: { actorId: id(111), jobRunId: id(112) }, providerEventId: order.providerEventId, externalOrderRef: order.externalOrderRef,
    externalOrderRevision: order.externalOrderRevision, normalized: order, normalizedDigest: digest, rawSourceDigest: "d".repeat(64),
    products: [{ externalLineRef: "line:19", externalOfferRef: "offer:53", purchasedAt: "2026-02-12T07:12:00Z",
      products: [{ externalProductRef: "product:59", quantityPerSet: 1 }] }],
    capturedAt: "2026-02-12T07:20:00Z", pagePacketRef: id(113) };
  return { capture, context };
}
