import { describe, expect, it, vi } from "vitest";
import {
  createChannelWebhookHandler,
  emptyChannelWebhookPort,
  type ChannelIngestOutcome,
  type ChannelWebhookPort,
} from "@openlup/platform/channels/server";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import {
  createShopifyChannelAdapter,
  createShopifyHttpClient,
} from "../server/index.js";
import {
  buildSampleShopifyOrder,
  buildSignedShopifyWebhook,
  SHOPIFY_TEST_CANARIES,
  SHOPIFY_TEST_CHANNEL_SLUG,
  SHOPIFY_TEST_SHOP_DOMAIN,
} from "./fixtures.js";

function createMockHttpResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let jsonBody: unknown = null;

  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
      return res;
    },
  };

  return {
    res: res as unknown as HttpResponse,
    readStatus: () => statusCode,
    readHeaders: () => headers,
    readJson: () => jsonBody,
  };
}

/**
 * Stage 3 Real-Flow Mount Proof (ADR-001):
 * Wires Shopify ChannelOrderSourcePort into createChannelWebhookHandler
 * from @openlup/platform/channels/server.
 */
describe("recipes/channels/shopify — Stage 3 real-flow mount proof (+ negative controls)", () => {
  it("ingests valid HMAC orders/paid webhooks via createChannelWebhookHandler and rejects bad HMAC with 0 ingest calls", async () => {
    const connector = createShopifyChannelAdapter({
      client: createShopifyHttpClient({
        shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
        accessToken: SHOPIFY_TEST_CANARIES.accessToken,
        fetchImpl: async () => {
          throw new Error("webhook path must not call Shopify Admin API");
        },
      }),
      shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
      channelSlug: SHOPIFY_TEST_CHANNEL_SLUG,
      webhookSecrets: [SHOPIFY_TEST_CANARIES.webhookSecret],
    });

    const ingestedOrders: unknown[] = [];
    const quarantinedSignals: unknown[] = [];

    const port: ChannelWebhookPort = {
      ingestOrder: vi.fn(async (order): Promise<ChannelIngestOutcome> => {
        ingestedOrders.push(order);
        return {
          kind: "settled",
          ledgerId: "ledger-shopify-1",
          orderId: "order-openlup-1",
          paymentIntentId: "pi-shopify-1",
        };
      }),
      quarantineSignal: vi.fn(async (input) => {
        quarantinedSignals.push(input);
        return { quarantineId: "quar-shopify-1" };
      }),
    };

    const makeHandler = (enabled = true) =>
      createChannelWebhookHandler({
        connectorKind: connector.capabilities.connectorKind,
        enabled: () => enabled,
        verifyToken: () => true,
        connector: connector.orders,
        port,
        readRawBody: async (req) => String((req as unknown as { rawBody: string }).rawBody),
      });

    const handler = makeHandler(true);

    // 1. Valid HMAC orders/paid webhook ingests cleanly through createChannelWebhookHandler.
    const validSigned = buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: buildSampleShopifyOrder(),
      webhookId: "wh-mount-paid-1",
    });
    const validReq = {
      method: "POST",
      headers: validSigned.headers,
      query: {},
      rawBody: validSigned.rawBody,
    } as unknown as HttpRequest;
    const validRes = createMockHttpResponse();

    await handler(validReq, validRes.res);
    expect(validRes.readStatus()).toBe(200);
    expect(validRes.readJson()).toEqual({
      ok: true,
      data: {
        connectorKind: "shopify",
        status: "settled",
        providerEventId: "wh-mount-paid-1",
        externalOrderRef: "820982911946154",
        ledgerId: "ledger-shopify-1",
        orderId: "order-openlup-1",
        paymentIntentId: "pi-shopify-1",
      },
    });
    expect(port.ingestOrder).toHaveBeenCalledTimes(1);
    expect(port.quarantineSignal).toHaveBeenCalledTimes(0);

    // 2. Bad HMAC signature fails closed with 0 ingest calls and 0 quarantine calls.
    // Note: createChannelWebhookHandler maps normalized.reason === "signature" to FORBIDDEN (403).
    const badSigned = buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: buildSampleShopifyOrder(),
      webhookId: "wh-mount-bad-1",
      overrideSignature: Buffer.from("invalid-hmac-signature", "utf8").toString("base64"),
    });
    const badReq = {
      method: "POST",
      headers: badSigned.headers,
      query: {},
      rawBody: badSigned.rawBody,
    } as unknown as HttpRequest;
    const badRes = createMockHttpResponse();

    await handler(badReq, badRes.res);
    expect(badRes.readStatus()).toBe(403);
    expect(badRes.readJson()).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN",
        details: { connectorKind: "shopify", reason: "signature_rejected" },
      },
    });
    expect(port.ingestOrder).toHaveBeenCalledTimes(1);
    expect(port.quarantineSignal).toHaveBeenCalledTimes(0);

    // 3. Valid HMAC unmapped financial_status quarantines loudly (B3) without dropping or ingesting.
    const unmappedSigned = buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: buildSampleShopifyOrder({ id: 820982911946155, financial_status: "unknown_wire_state" }),
      webhookId: "wh-mount-unmapped-1",
    });
    const unmappedReq = {
      method: "POST",
      headers: unmappedSigned.headers,
      query: {},
      rawBody: unmappedSigned.rawBody,
    } as unknown as HttpRequest;
    const unmappedRes = createMockHttpResponse();

    await handler(unmappedReq, unmappedRes.res);
    expect(unmappedRes.readStatus()).toBe(200);
    expect(unmappedRes.readJson()).toMatchObject({
      ok: true,
      data: {
        connectorKind: "shopify",
        status: "quarantined",
        reason: "unmapped_vocabulary",
        vocabulary: "unknown_wire_state",
        quarantineId: "quar-shopify-1",
      },
    });
    expect(port.ingestOrder).toHaveBeenCalledTimes(1);
    expect(port.quarantineSignal).toHaveBeenCalledTimes(1);

    // Proof: secret canaries never appear in handler responses or persisted payloads.
    const serialized = JSON.stringify({
      validJson: validRes.readJson(),
      badJson: badRes.readJson(),
      unmappedJson: unmappedRes.readJson(),
      ingestedOrders,
      quarantinedSignals,
    });
    for (const canary of [
      SHOPIFY_TEST_CANARIES.marker,
      SHOPIFY_TEST_CANARIES.accessToken,
      SHOPIFY_TEST_CANARIES.webhookSecret,
    ]) {
      expect(serialized).not.toContain(canary);
    }

    // NEGATIVE CONTROL #1: Feature flag disabled refuses with 503 and 0 ingest calls.
    const disabledHandler = makeHandler(false);
    const disabledRes = createMockHttpResponse();
    await disabledHandler(validReq, disabledRes.res);
    expect(disabledRes.readStatus()).toBe(503);
    expect(port.ingestOrder).toHaveBeenCalledTimes(1);

    // NEGATIVE CONTROL #2: emptyChannelWebhookPort refuses any durable write attempt.
    const emptyPort = emptyChannelWebhookPort();
    await expect(emptyPort.ingestOrder(ingestedOrders[0] as never)).rejects.toThrow(
      "channel_webhook_port_unavailable",
    );
  });
});
