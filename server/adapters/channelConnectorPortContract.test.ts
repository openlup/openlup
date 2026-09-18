import { describe, expect, it } from "vitest";

import { describeChannelConnectorPortContract } from "./channelConnectorPortContract.testFixtures.js";
import {
  createNoopChannelConnectorAdapter,
  listChannelOrderFixtures,
  noopChannelCapabilities,
} from "./noop_channel/noopChannelConnectorAdapter.js";
import { channelConnectorCapabilityViolations } from "../domains/channels/channelConnectorRegistry.js";
import type { ChannelConnectorPort } from "../../src/domains/channels/ports.js";

const validHeaders = { "x-simulator-signature": "valid" };

describeChannelConnectorPortContract({
  name: "simulator channel connector",
  createSubject: createNoopChannelConnectorAdapter,
  orderWebhook: {
    headers: validHeaders,
    rawBody: JSON.stringify({ fixture: "order-well-formed.json" }),
  },
  unmappedWebhook: {
    headers: validHeaders,
    rawBody: JSON.stringify({ fixture: "signal-unknown-vocabulary.json" }),
  },
  connectionRef: "sim-connection",
  fixtureFiles: [...listChannelOrderFixtures(), "signal-unknown-vocabulary.json"],
});

/**
 * The second subject exists to show the eight scenarios are satisfiable by a connector that is not
 * the simulator — a suite proven only against one implementation proves the suite matches that
 * implementation. This one declares no stable buyer identity, which exercises the branch the
 * simulator does not.
 */
const perOrderIdentityConnector = (): ChannelConnectorPort => {
  const order = {
    contractVersion: "channel.order.v1" as const,
    channelSlug: "other-market",
    externalOrderRef: "OTHER-1",
    externalOrderRevision: null,
    providerEventId: "other-evt-1",
    placedAt: "2026-08-12T09:00:00Z",
    currency: "SEK",
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
      recipientName: "Recipient",
      line1: "Street 2",
      line2: null,
      postalCode: "11122",
      city: "Stockholm",
      countryCode: "SE",
      phone: null,
      pickupPointRef: null,
    },
    lines: [
      {
        externalLineRef: "L1",
        sellable: { kind: "sku" as const, externalOfferRef: null, skuCode: "OTHER-A" },
        quantity: 1,
        unitGrossMinor: 900,
        lineGrossMinor: 900,
        lineDiscountMinor: 0,
        vatRateBps: 2500,
      },
    ],
    shipping: { grossMinor: 0, discountMinor: 0, methodLabel: null, carrierHint: null },
    totals: {
      itemsGrossMinor: 900,
      itemsDiscountMinor: 0,
      shippingGrossMinor: 0,
      shippingDiscountMinor: 0,
      grandTotalMinor: 900,
    },
    payment: {
      state: "paid_externally",
      externalPaymentRef: "OTHER-PAY-1",
      paidAt: "2026-08-12T09:05:00Z",
      methodLabel: null,
    },
    payloadDigest: "other-digest",
  };

  return {
    capabilities: {
      ...noopChannelCapabilities,
      connectorKind: "other_channel",
      connectorShape: "aggregator",
      supportsOrderPull: false,
      correlation: {
        orderRefField: "id",
        customerRefField: null,
        customerRefNullMeans: "unsupported",
        emailIsAlwaysMasked: false,
      },
    },
    orders: {
      async listChannelBindings() {
        return [];
      },
      async pullOrders() {
        return { orders: [], unmapped: [], nextCursor: null, watermarkAt: null };
      },
      async normalizeWebhook(input) {
        const body = JSON.parse(input.rawBody) as { fixture?: string };
        if (body.fixture === "signal-unknown-vocabulary.json") {
          return {
            kind: "unmapped",
            providerEventId: "other-evt-unmapped",
            signal: {
              vocabulary: "PENDING_MERCHANT_REVIEW",
              externalOrderRef: null,
              detail: null,
              payload: {},
            },
          };
        }
        return { kind: "order", providerEventId: order.providerEventId, order };
      },
      async acknowledgeOrder() {
        return { acknowledged: true };
      },
    },
  };
};

describeChannelConnectorPortContract({
  name: "per-order-identity connector",
  createSubject: perOrderIdentityConnector,
  orderWebhook: { headers: {}, rawBody: JSON.stringify({ fixture: "order.json" }) },
  unmappedWebhook: {
    headers: {},
    rawBody: JSON.stringify({ fixture: "signal-unknown-vocabulary.json" }),
  },
  connectionRef: "other-connection",
  fixtureFiles: ["order.json"],
});

describe("channel connector contract fixture", () => {
  it("fails closed on a bad signature before reading the body", async () => {
    const result = await createNoopChannelConnectorAdapter().orders.normalizeWebhook({
      headers: { "x-simulator-signature": "tampered" },
      rawBody: "not even json",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "rejected", reason: "signature" });
  });

  it("reports a malformed body separately from a bad signature", async () => {
    const result = await createNoopChannelConnectorAdapter().orders.normalizeWebhook({
      headers: validHeaders,
      rawBody: "{",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "rejected", reason: "malformed" });
  });

  it("catches a connector that claims a sub-port it does not carry", () => {
    const dishonest = createNoopChannelConnectorAdapter();
    const claimed: ChannelConnectorPort = {
      ...dishonest,
      capabilities: { ...dishonest.capabilities, supportsShipmentPush: true },
    };

    expect(channelConnectorCapabilityViolations(claimed)).toEqual([
      "shipments: declared true, present false",
    ]);
  });

  it("pulls every order fixture except the redelivery twin", async () => {
    const pulled = await createNoopChannelConnectorAdapter().orders.pullOrders({
      connectionRef: "sim-connection",
      channelExternalRef: null,
      since: null,
      cursor: null,
      limit: 50,
      signal: new AbortController().signal,
    });

    // Every `order-*.json` fixture except the redelivery twin is pulled, so this list grows with
    // the fixture directory on purpose: a scenario added without being pulled would be a scenario
    // the poll path never exercises.
    expect(pulled.orders.map((order) => order.externalOrderRef).sort()).toEqual([
      "SIM-1001",
      "SIM-1002",
      "SIM-1003",
    ]);
    expect(pulled.nextCursor).toBe("end");
  });

  it("terminates a poll loop rather than re-delivering forever", async () => {
    const pulled = await createNoopChannelConnectorAdapter().orders.pullOrders({
      connectionRef: "sim-connection",
      channelExternalRef: null,
      since: null,
      cursor: "end",
      limit: 50,
      signal: new AbortController().signal,
    });

    expect(pulled.orders).toEqual([]);
    expect(pulled.nextCursor).toBeNull();
  });
});
