import { createHash, createHmac } from "node:crypto";
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
  type ChannelAdapterTestSubject,
  type ChannelPullHarness,
  type ScriptedChannelOutcome,
} from "../../src/channels/testing/index.js";

const WEBHOOK_SECRET = "channel-webhook-canary-marker";

function signBody(rawBody: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
}

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

function makeAdapter(
  fake: ReturnType<typeof createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>>,
): ChannelOrderSourcePort {
  return {
    async listChannelBindings() { return []; },
    async pullOrders() {
      const orders = await fake.invoke("pull");
      return { orders, unmapped: [], nextCursor: null, watermarkAt: "2000-01-15T10:00:00.000Z" };
    },
    async normalizeWebhook({ headers, rawBody }) {
      if (headers["x-sig"] !== signBody(rawBody)) return { kind: "rejected", reason: "signature" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return { kind: "rejected", reason: "malformed" };
      }
      if (typeof parsed !== "object" || parsed === null) return { kind: "rejected", reason: "malformed" };
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

function makePullHarness(
  outcome: ScriptedChannelOutcome<readonly NormalizedChannelOrder[]>,
  caps: ChannelConnectorCapabilities = CAPS,
): ChannelPullHarness {
  const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
  fake.enqueue("pull", outcome);
  return {
    adapter: makeAdapter(fake),
    capabilities: caps,
    input: { connectionRef: "conn-1", channelExternalRef: null, since: null, cursor: null, limit: 10 },
    readIoCount: () => fake.calls.length,
    readFaultLog: () => fake.calls,
  };
}

function buildValidSubject(overrides: Partial<ChannelAdapterTestSubject> = {}): ChannelAdapterTestSubject {
  const validBody = '{"id":"ext-ord-1"}';
  const unmappedBody = '{"id":"ext-ord-2"}';
  const ignoredBody = '{"id":"p-1"}';
  const malformedBody = "{not-json";
  return {
    id: "synthetic-channel",
    createWebhookAdapter: () => {
      const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
      return { adapter: makeAdapter(fake), capabilities: CAPS, readIoCount: () => fake.calls.length };
    },
    validOrderWebhook: { headers: { "x-sig": signBody(validBody), "x-topic": "orders/paid" }, rawBody: validBody },
    badSignatureWebhook: { headers: { "x-sig": "bad", "x-topic": "orders/paid" }, rawBody: validBody },
    unmappedVocabularyWebhook: { headers: { "x-sig": signBody(unmappedBody), "x-topic": "orders/unknown" }, rawBody: unmappedBody },
    ignoredTopicWebhook: { headers: { "x-sig": signBody(ignoredBody), "x-topic": "products/update" }, rawBody: ignoredBody },
    malformedWebhook: { headers: { "x-sig": signBody(malformedBody), "x-topic": "orders/paid" }, rawBody: malformedBody },
    happyPullOrders: () => makePullHarness({ kind: "success", value: [sampleOrder(validBody)] }),
    pullCertification: {
      http5xx: () => makePullHarness({ kind: "http-failure", status: 503 }),
      httpAuthFailure: () => makePullHarness({ kind: "http-failure", status: 401 }),
      rateLimited429: () => makePullHarness({ kind: "rate-limited-429", retryAfterSeconds: 30 }),
      timeout: () => makePullHarness({ kind: "timeout" }),
      transportError: () => makePullHarness({ kind: "transport-error" }),
    },
    sensitiveValues: [WEBHOOK_SECRET],
    ...overrides,
  };
}

describe("@openlup/platform/channels/testing", () => {
  it("certifies webhook auth, tamper resistance, malformed rejection, unmapped B3, pullOrders, and 5 fault scenarios in full mode", async () => {
    const evidence = await runChannelAdapterConformance([buildValidSubject()], { mode: "full" });
    expect(evidence.qualifications).toHaveLength(1);
    // 4 baseline webhooks + tamperedBodyWebhook + malformedWebhook + happyPullOrders + 5 pull faults = 12
    expect(evidence.qualifications[0]!.ledger).toHaveLength(12);
  });

  it("enforces negative controls for signature bypass, body tampering, missing full-mode fixtures, eventId drift, unmapped validation, and swallowed pull faults", async () => {
    // 1. Bad signature accepted
    await expect(
      runChannelAdapterConformance([
        buildValidSubject({
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
        }),
      ]),
    ).rejects.toThrow(/CHANNEL_CONFORMANCE:webhook_kind_mismatch/);

    // 2. Body tamper accepted (header-only signature check)
    await expect(
      runChannelAdapterConformance(
        [
          buildValidSubject({
            id: "header-only-sig",
            createWebhookAdapter: () => {
              const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
              const base = makeAdapter(fake);
              return {
                adapter: {
                  ...base,
                  normalizeWebhook: async ({ headers, rawBody }) => {
                    if (headers["x-sig"] === "bad") return { kind: "rejected", reason: "signature" };
                    return base.normalizeWebhook({
                      headers: { ...headers, "x-sig": signBody(rawBody) },
                      rawBody,
                      signal: new AbortController().signal,
                    });
                  },
                },
                capabilities: CAPS,
                readIoCount: () => fake.calls.length,
              };
            },
          }),
        ],
        { mode: "full" },
      ),
    ).rejects.toThrow(/CHANNEL_CONFORMANCE:webhook_kind_mismatch/);

    // 3. Webhook-only connector in full mode missing malformedWebhook
    const webhookOnlyCaps: ChannelConnectorCapabilities = { ...CAPS, supportsOrderPull: false };
    await expect(
      runChannelAdapterConformance(
        [
          buildValidSubject({
            id: "webhook-only-no-malformed",
            createWebhookAdapter: () => {
              const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
              return { adapter: makeAdapter(fake), capabilities: webhookOnlyCaps, readIoCount: () => fake.calls.length };
            },
            malformedWebhook: undefined,
          }),
        ],
        { mode: "full" },
      ),
    ).rejects.toThrow(/CHANNEL_CONFORMANCE:missing_malformed_webhook/);

    // 4. Pull-capable connector in full mode missing pullCertification
    await expect(
      runChannelAdapterConformance(
        [buildValidSubject({ id: "missing-pull-cert", pullCertification: undefined })],
        { mode: "full" },
      ),
    ).rejects.toThrow(/CHANNEL_CONFORMANCE:missing_pull_certification/);

    // 5. Pull fault silently swallowed into empty orders
    await expect(
      runChannelAdapterConformance(
        [
          buildValidSubject({
            id: "swallow-pull-fault",
            pullCertification: {
              ...buildValidSubject().pullCertification!,
              http5xx: () => {
                const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
                fake.enqueue("pull", { kind: "http-failure", status: 503 });
                const base = makeAdapter(fake);
                return {
                  adapter: {
                    ...base,
                    pullOrders: async () => {
                      try {
                        await fake.invoke("pull");
                      } catch {
                        return { orders: [], unmapped: [], nextCursor: null, watermarkAt: null };
                      }
                      return { orders: [], unmapped: [], nextCursor: null, watermarkAt: null };
                    },
                  },
                  capabilities: CAPS,
                  input: { connectionRef: "conn-1", channelExternalRef: null, since: null, cursor: null, limit: 10 },
                  readIoCount: () => fake.calls.length,
                  readFaultLog: () => fake.calls,
                };
              },
            },
          }),
        ],
        { mode: "full" },
      ),
    ).rejects.toThrow(/CHANNEL_CONFORMANCE:pull_fault_swallowed/);

    // 6. providerEventId mismatch between webhook wrapper and order
    await expect(
      runChannelAdapterConformance([
        buildValidSubject({
          id: "event-id-drift",
          createWebhookAdapter: () => {
            const fake = createScriptedChannelFake<{ pull: readonly NormalizedChannelOrder[] }>();
            const base = makeAdapter(fake);
            return {
              adapter: {
                ...base,
                normalizeWebhook: async (input) => {
                  const res = await base.normalizeWebhook(input);
                  if (res.kind === "order") return { ...res, providerEventId: "evt-different" };
                  return res;
                },
              },
              capabilities: CAPS,
              readIoCount: () => fake.calls.length,
            };
          },
        }),
      ]),
    ).rejects.toThrow(/CHANNEL_CONFORMANCE:provider_event_id_mismatch/);

    // 7. Invalid pulled.unmapped entry rejected
    await expect(
      runChannelAdapterConformance([
        buildValidSubject({
          id: "bad-unmapped-pull",
          happyPullOrders: () => {
            const base = makePullHarness({ kind: "success", value: [sampleOrder('{"id":"ext-ord-1"}')] });
            return {
              ...base,
              adapter: {
                ...base.adapter,
                pullOrders: async (input) => {
                  const res = await base.adapter.pullOrders(input);
                  return { ...res, unmapped: [{ vocabulary: "", externalOrderRef: null, detail: null, payload: {} }] };
                },
              },
            };
          },
        }),
      ]),
    ).rejects.toThrow(/CHANNEL_CONFORMANCE:invalid_pulled_unmapped/);
  });
});
