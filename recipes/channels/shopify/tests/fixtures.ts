import { createHmac } from "node:crypto";
import {
  createScriptedChannelFake,
  ScriptedChannelTransportError,
  type ChannelAdapterTestSubject,
  type ChannelPullHarness,
  type ScriptedChannelOutcome,
} from "@openlup/platform/channels/testing";
import {
  createShopifyChannelAdapter,
  createShopifyHttpClient,
  type ShopifyOrderResource,
} from "../server/index.js";

/** Synthetic high-visibility canaries used to prove zero secret/PII leakage (ADR-001). */
export const SHOPIFY_TEST_CANARIES = Object.freeze({
  marker: "shopify-canary-marker/alpha+01",
  accessToken: "shopify_canary_admin_token_0001",
  webhookSecret: "shopify_canary_webhook_secret_0001",
  webhookSecretRotated: "shopify_canary_webhook_secret_0002",
  buyerEmail: "shopify-canary-buyer@example.invalid",
});

export const SHOPIFY_TEST_SHOP_DOMAIN = "acme-canary-shop";
export const SHOPIFY_TEST_CHANNEL_SLUG = "shopify-us";
export const SHOPIFY_TEST_OCCURRED_AT = "2030-06-15T12:00:00.000Z";

export function signShopifyWebhook(rawBody: string, secret: string = SHOPIFY_TEST_CANARIES.webhookSecret): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export function buildSampleShopifyOrder(overrides?: Partial<ShopifyOrderResource>): ShopifyOrderResource {
  return {
    id: 820982911946154,
    name: "#1001",
    created_at: SHOPIFY_TEST_OCCURRED_AT,
    updated_at: "2030-06-15T12:01:00.000Z",
    processed_at: "2030-06-15T12:00:05.000Z",
    currency: "USD",
    financial_status: "paid",
    taxes_included: true,
    total_price: "31.00",
    checkout_id: 901414060,
    payment_gateway_names: ["shopify_payments"],
    email: SHOPIFY_TEST_CANARIES.buyerEmail,
    customer: {
      id: 115310627314723,
      email: SHOPIFY_TEST_CANARIES.buyerEmail,
      first_name: "Ada",
      last_name: "Lovelace",
    },
    shipping_address: {
      name: "Ada Lovelace",
      first_name: "Ada",
      last_name: "Lovelace",
      address1: "100 Main St",
      address2: "Suite 4B",
      zip: "10001",
      city: "New York",
      country_code: "US",
    },
    line_items: [
      {
        id: 866550311766439,
        product_id: 788032119674292,
        variant_id: 42311223344556,
        sku: "STARTER-PACK-01",
        quantity: 2,
        price: "15.00",
        total_discount: "3.00",
        tax_lines: [{ rate: 0.23, price: "5.04" }],
      },
    ],
    shipping_lines: [
      {
        id: 271878346596884,
        title: "Standard Ground",
        code: "STD_GND",
        price: "5.00",
        discount_allocations: [{ amount: "1.00" }],
      },
    ],
    ...overrides,
  };
}

export function buildSignedShopifyWebhook(input: {
  topic: string;
  bodyObj: unknown;
  webhookId?: string;
  secret?: string;
  shopHeader?: string;
  overrideSignature?: string;
}): {
  headers: Readonly<Record<string, string>>;
  rawBody: string;
} {
  const rawBody = typeof input.bodyObj === "string" ? input.bodyObj : JSON.stringify(input.bodyObj);
  const hmac = input.overrideSignature ?? signShopifyWebhook(rawBody, input.secret);
  return {
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": input.topic,
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-webhook-id": input.webhookId ?? `wh-${input.topic}-001`,
      "x-shopify-shop-domain": input.shopHeader ?? `${SHOPIFY_TEST_SHOP_DOMAIN}.myshopify.com`,
    },
    rawBody,
  };
}

export function createShopifySubject(): ChannelAdapterTestSubject {
  const paidOrder = buildSampleShopifyOrder();
  const unmappedOrder = buildSampleShopifyOrder({
    id: 820982911946159,
    financial_status: "future_clearing_state",
  });

  return {
    id: "shopify-storefront-channel",
    sensitiveValues: [
      SHOPIFY_TEST_CANARIES.marker,
      SHOPIFY_TEST_CANARIES.accessToken,
      SHOPIFY_TEST_CANARIES.webhookSecret,
      SHOPIFY_TEST_CANARIES.webhookSecretRotated,
    ],
    createWebhookAdapter: () => {
      let ioCount = 0;
      const client = createShopifyHttpClient({
        shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
        accessToken: SHOPIFY_TEST_CANARIES.accessToken,
        fetchImpl: async () => {
          ioCount += 1;
          throw new Error("unexpected_io_during_webhook");
        },
      });
      const connector = createShopifyChannelAdapter({
        client,
        shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
        channelSlug: SHOPIFY_TEST_CHANNEL_SLUG,
        webhookSecrets: [
          SHOPIFY_TEST_CANARIES.webhookSecret,
          SHOPIFY_TEST_CANARIES.webhookSecretRotated,
        ],
      });
      return {
        adapter: connector.orders,
        capabilities: connector.capabilities,
        readIoCount: () => ioCount,
      };
    },
    validOrderWebhook: buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: paidOrder,
      webhookId: "wh-paid-001",
    }),
    badSignatureWebhook: buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: paidOrder,
      webhookId: "wh-bad-001",
      overrideSignature: Buffer.from("forged-signature", "utf8").toString("base64"),
    }),
    unmappedVocabularyWebhook: buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: unmappedOrder,
      webhookId: "wh-unmapped-001",
    }),
    ignoredTopicWebhook: buildSignedShopifyWebhook({
      topic: "products/update",
      bodyObj: { id: 991122, title: "Updated Product" },
      webhookId: "wh-ignored-001",
    }),
    malformedWebhook: buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: "{not-valid-json",
      webhookId: "wh-malformed-001",
    }),
    happyPullOrders: () => makeShopifyPullHarness({
      kind: "success",
      value: new Response(JSON.stringify({ orders: [paidOrder] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }),
    pullCertification: {
      http5xx: () => makeShopifyPullHarness({ kind: "http-failure", status: 503 }),
      httpAuthFailure: () => makeShopifyPullHarness({ kind: "http-failure", status: 401 }),
      rateLimited429: () => makeShopifyPullHarness({ kind: "rate-limited-429", retryAfterSeconds: 30 }),
      timeout: () => makeShopifyPullHarness({ kind: "timeout" }),
      transportError: () => makeShopifyPullHarness({ kind: "transport-error" }),
    },
  };
}

function makeShopifyPullHarness(outcome: ScriptedChannelOutcome<Response>): ChannelPullHarness {
  const fake = createScriptedChannelFake<{ listOrders: Response }>();
  fake.enqueue("listOrders", outcome);
  const client = createShopifyHttpClient({
    shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
    accessToken: SHOPIFY_TEST_CANARIES.accessToken,
    fetchImpl: async () => {
      try {
        return await fake.invoke("listOrders");
      } catch (err) {
        if (err instanceof ScriptedChannelTransportError) {
          if (err.kind === "http-failure") {
            return new Response(JSON.stringify({ errors: "Upstream error" }), {
              status: err.status ?? 500,
              headers: { "content-type": "application/json" },
            });
          }
          if (err.kind === "rate-limited-429") {
            return new Response(JSON.stringify({ errors: "Rate limited" }), {
              status: 429,
              headers: {
                "content-type": "application/json",
                ...(err.retryAfterSeconds !== undefined ? { "retry-after": String(err.retryAfterSeconds) } : {}),
              },
            });
          }
        }
        throw err;
      }
    },
  });
  const connector = createShopifyChannelAdapter({
    client,
    shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
    channelSlug: SHOPIFY_TEST_CHANNEL_SLUG,
    webhookSecrets: [SHOPIFY_TEST_CANARIES.webhookSecret],
  });
  return {
    adapter: connector.orders,
    capabilities: connector.capabilities,
    input: {
      connectionRef: "conn-shopify-1",
      channelExternalRef: null,
      since: "2030-06-15T00:00:00.000Z",
      cursor: null,
      limit: 50,
    },
    readIoCount: () => fake.calls.length,
    readFaultLog: () => fake.calls,
  };
}
