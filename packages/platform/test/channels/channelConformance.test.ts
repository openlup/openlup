import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ChannelConnectorCapabilities,
  ChannelOrderSourcePort,
  NormalizedChannelOrder,
} from "../../src/channels/contracts/index.js";
import { CHANNEL_ORDER_PAID_EXTERNALLY_STATE } from "../../src/channels/index.js";
import {
  createScriptedChannelFake,
  runChannelAdapterConformance,
} from "../../src/channels/testing/index.js";

const CAPS: ChannelConnectorCapabilities = {
  connectorKind: "synthetic_channel",
  connectorShape: "direct",
  supportsChannelDiscovery: false,
  supportsOrderPull: true,
  supportsOrderWebhook: true,
  supportsOrderAck: false,
  supportsListingLink: false,
  supportsStockPush: false,
  supportsPricePush: false,
  supportsShipmentPush: false,
  correlation: {
    orderRefField: "id",
    customerRefField: "customer.id",
    customerRefNullMeans: "per_order_identity",
    emailIsAlwaysMasked: false,
  },
};

function sampleOrder(rawBody: string): NormalizedChannelOrder {
  return {
    contractVersion: "channel.order.v1",
    channelSlug: "synthetic",
    externalOrderRef: "ext-ord-1",
    externalOrderRevision: "v1",
    providerEventId: "evt-1",
    placedAt: "2000-01-15T10:00:00.000Z",
    currency: "USD",
    buyer: {
      externalCustomerRef: "cust-1",
      email: "buyer@example.invalid",
      emailIsMasked: false,
      firstName: "Ada",
      lastName: "Lovelace",
      phone: null,
      taxId: null,
      companyName: null,
    },
    shipTo: {
      recipientName: "Ada Lovelace",
      line1: "100 Main St",
      line2: null,
      postalCode: "10001",
      city: "New York",
      countryCode: "US",
      phone: null,
      pickupPointRef: null,
    },
    lines: [
      {
        externalLineRef: "line-1",
        sellable: { kind: "sku", externalOfferRef: "offer-1", skuCode: "SKU-1" },
        quantity: 2,
        unitGrossMinor: 1000,
        lineGrossMinor: 2000,
        lineDiscountMinor: 200,
        vatRateBps: 0,
      },
    ],
    shipping: { grossMinor: 500, discountMinor: 0, methodLabel: "Standard", carrierHint: "usps" },
    totals: {
      itemsGrossMinor: 2000,
      itemsDiscountMinor: 200,
      shippingGrossMinor: 500,
      shippingDiscountMinor: 0,
      grandTotalMinor: 2300,
    },
    payment: {
      state: CHANNEL_ORDER_PAID_EXTERNALLY_STATE,
      externalPaymentRef: "pay-1",
      paidAt: "2000-01-15T10:00:00.000Z",
      methodLabel: "card",
    },
    payloadDigest: createHash("sha256").update(rawBody).digest("hex"),
  };
}

function makeAdapter(fake: ReturnType<typeof createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>>): ChannelOrderSourcePort {
  return {
    async listChannelBindings() { return []; },
    async pullOrders() {
      const orders = await fake.invoke("pull");
      return { orders, unmapped: [], nextCursor: null, watermarkAt: "2000-01-15T10:00:00.000Z" };
    },
    async normalizeWebhook({ headers, rawBody }) {
      if (headers["x-sig"] !== "valid") return { kind: "rejected", reason: "signature" };
      const topic = headers["x-topic"];
      if (topic === "orders/paid") {
        return { kind: "order", providerEventId: "evt-1", order: sampleOrder(rawBody) };
      }
      if (topic === "orders/unknown") {
        return { kind: "unmapped", providerEventId: "evt-2", signal: { vocabulary: "orders/unknown", externalOrderRef: null, detail: null, payload: {} } };
      }
      return { kind: "ignored", providerEventId: "evt-3", reason: "non_order_topic" };
    },
    async acknowledgeOrder() { return { acknowledged: false }; },
  };
}

describe("@openlup/platform/channels/testing", () => {
  it("certifies webhook auth, normalized order schema, unmapped B3 preservation, and pullOrders", async () => {
    const evidence = await runChannelAdapterConformance(
      [
        {
          id: "synthetic-channel",
          createWebhookAdapter: () => {
            const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
            return { adapter: makeAdapter(fake), capabilities: CAPS, readIoCount: () => fake.calls.length };
          },
          validOrderWebhook: { headers: { "x-sig": "valid", "x-topic": "orders/paid" }, rawBody: '{"id":"ext-ord-1"}' },
          badSignatureWebhook: { headers: { "x-sig": "bad", "x-topic": "orders/paid" }, rawBody: '{"id":"ext-ord-1"}' },
          unmappedVocabularyWebhook: { headers: { "x-sig": "valid", "x-topic": "orders/unknown" }, rawBody: '{"id":"ext-ord-2"}' },
          ignoredTopicWebhook: { headers: { "x-sig": "valid", "x-topic": "products/update" }, rawBody: '{"id":"p-1"}' },
          happyPullOrders: () => {
            const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
            fake.enqueue("pull", { kind: "success", value: [sampleOrder('{"id":"ext-ord-1"}')] });
            return {
              adapter: makeAdapter(fake),
              capabilities: CAPS,
              input: { connectionRef: "conn-1", channelExternalRef: null, since: null, cursor: null, limit: 10 },
              readIoCount: () => fake.calls.length,
              readFaultLog: () => fake.calls,
            };
          },
        },
      ],
      { mode: "full" },
    );
    expect(evidence.qualifications).toHaveLength(1);
    expect(evidence.qualifications[0]!.ledger).toHaveLength(5);
  });

  it("rejects adapters that accept bad webhook signatures (negative control)", async () => {
    await expect(
      runChannelAdapterConformance([
        {
          id: "broken-sig",
          createWebhookAdapter: () => {
            const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
            const base = makeAdapter(fake);
            return {
              adapter: {
                ...base,
                normalizeWebhook: async ({ rawBody }) => ({ kind: "order", providerEventId: "evt-1", order: sampleOrder(rawBody) }),
              },
              capabilities: CAPS,
              readIoCount: () => fake.calls.length,
            };
          },
          validOrderWebhook: { headers: { "x-sig": "valid", "x-topic": "orders/paid" }, rawBody: '{"id":"ext-ord-1"}' },
          badSignatureWebhook: { headers: { "x-sig": "bad", "x-topic": "orders/paid" }, rawBody: '{"id":"ext-ord-1"}' },
          unmappedVocabularyWebhook: { headers: { "x-sig": "valid", "x-topic": "orders/unknown" }, rawBody: '{"id":"ext-ord-2"}' },
          ignoredTopicWebhook: { headers: { "x-sig": "valid", "x-topic": "products/update" }, rawBody: '{"id":"p-1"}' },
        },
      ]),
    ).rejects.toThrow(/CHANNEL_CONFORMANCE:webhook_kind_mismatch/);
  });
});
