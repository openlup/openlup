import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CHANNEL_ORDER_PAID_EXTERNALLY_STATE } from "@openlup/platform/channels";
import { runChannelAdapterConformance } from "@openlup/platform/channels/testing";
import {
  assertValidShopifyAccessToken,
  assertValidShopifyShopDomain,
  createShopifyChannelAdapter,
  createShopifyHttpClient,
  parseShopifyDecimalToMinor,
  parseShopifyNextPageCursor,
  shopifyChannelCapabilities,
  ShopifyTransportError,
} from "../server/index.js";
import {
  buildSampleShopifyOrder,
  buildSignedShopifyWebhook,
  createShopifySubject,
  SHOPIFY_TEST_CANARIES,
  SHOPIFY_TEST_CHANNEL_SLUG,
  SHOPIFY_TEST_SHOP_DOMAIN,
} from "./fixtures.js";

const RECIPE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface JsonSchemaNode {
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  uniqueItems?: boolean;
  required?: readonly string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  allOf?: readonly JsonSchemaNode[];
  if?: JsonSchemaNode;
  then?: JsonSchemaNode;
}

/** Lightweight Draft 2020-12 JSON Schema validator (zero external dependencies). */
function validateAgainstJsonSchema(
  value: unknown,
  schema: JsonSchemaNode,
  root: JsonSchemaNode = schema,
  pointer = "$",
): string[] {
  if (schema.$ref) {
    const refName = schema.$ref.replace(/^#\/\$defs\//u, "");
    const target = root.$defs?.[refName];
    if (!target) return [`${pointer}: unresolved $ref ${schema.$ref}`];
    return validateAgainstJsonSchema(value, target, root, pointer);
  }
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pointer}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    const actualType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actualType !== schema.type) {
      errors.push(`${pointer}: expected type ${schema.type}, got ${actualType}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pointer}: string longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${pointer}: string ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) errors.push(`${pointer}: duplicate items violate uniqueItems`);
    }
    if (schema.items) {
      value.forEach((item, idx) => {
        errors.push(...validateAgainstJsonSchema(item, schema.items!, root, `${pointer}[${idx}]`));
      });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in record)) errors.push(`${pointer}: missing required property ${JSON.stringify(key)}`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) {
          errors.push(`${pointer}: unexpected additional property ${JSON.stringify(key)}`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in record) {
          errors.push(...validateAgainstJsonSchema(record[key], propSchema, root, `${pointer}.${key}`));
        }
      }
    }
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) {
      if (branch.if && branch.then) {
        if (validateAgainstJsonSchema(value, branch.if, root, pointer).length === 0) {
          errors.push(...validateAgainstJsonSchema(value, branch.then, root, pointer));
        }
      } else {
        errors.push(...validateAgainstJsonSchema(value, branch, root, pointer));
      }
    }
  }
  return errors;
}

function listRecipeFilesOnDisk(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listRecipeFilesOnDisk(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results.sort();
}

function assertNoSecretLeak(surface: unknown): void {
  const serialized = JSON.stringify(surface);
  for (const canary of [
    SHOPIFY_TEST_CANARIES.marker,
    SHOPIFY_TEST_CANARIES.accessToken,
    SHOPIFY_TEST_CANARIES.webhookSecret,
    SHOPIFY_TEST_CANARIES.webhookSecretRotated,
  ]) {
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(encodeURIComponent(canary));
    expect(serialized).not.toContain(Buffer.from(canary, "utf8").toString("base64"));
  }
}

describe("recipes/channels/shopify — Stage 1 & Stage 2 conformance + security invariants", () => {
  it("passes the official @openlup/platform/channels/testing full-mode conformance suite", async () => {
    const evidence = await runChannelAdapterConformance([createShopifySubject()], { mode: "full" });
    expect(evidence.contractVersion).toBe("channel.order.v1");
    expect(evidence.mode).toBe("full");
    expect(evidence.qualifications).toHaveLength(1);
    const qual = evidence.qualifications[0]!;
    expect(qual.connectorKind).toBe("shopify");
    expect(qual.ledger).toHaveLength(12);
    expect(qual.ledger.filter((e) => e.role === "webhook").every((e) => e.ioDelta === 0)).toBe(true);
    assertNoSecretLeak(evidence);
  });

  it("validates recipe.json against JSON Schema, exact disk inventory, and staticCapabilities parity", () => {
    const recipeSchema = JSON.parse(
      readFileSync(path.resolve(RECIPE_DIR, "../../schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(path.join(RECIPE_DIR, "recipe.json"), "utf8")) as Record<string, unknown>;

    expect(validateAgainstJsonSchema(manifest, recipeSchema)).toEqual([]);
    expect((manifest.summary as string).length).toBeLessThanOrEqual(240);

    // Negative control: invalid egress origin + extra key fails schema validation.
    expect(
      validateAgainstJsonSchema(
        { ...manifest, egressOrigins: ["http://insecure.example.com"], extraKey: true },
        recipeSchema,
      ).length,
    ).toBeGreaterThanOrEqual(2);

    expect(manifest.staticCapabilities).toEqual(shopifyChannelCapabilities);

    const files = manifest.files as { allFiles: string[] };
    expect(files.allFiles).toHaveLength(8);
    for (const relPath of files.allFiles) {
      expect(existsSync(path.join(RECIPE_DIR, relPath)), `missing declared recipe file: ${relPath}`).toBe(true);
    }
    expect(files.allFiles).toEqual(listRecipeFilesOnDisk(RECIPE_DIR));
  });

  it("enforces strict shopDomain pinning, auth-before-parse HMAC, BigInt/Intl money, and B3 unmapped preservation", async () => {
    // Reject unsafe shopDomain shapes at construction.
    for (const badDomain of [
      "myshop.myshopify.com",
      "https://myshop.myshopify.com",
      "BadShop",
      "-leading-hyphen",
      "trailing-hyphen-",
      "a",
      "evil.com/path",
    ]) {
      expect(() => assertValidShopifyShopDomain(badDomain)).toThrow(ShopifyTransportError);
    }
    expect(assertValidShopifyShopDomain("acme-store")).toEqual({
      shopDomain: "acme-store",
      origin: "https://acme-store.myshopify.com",
    });
    expect(() => assertValidShopifyAccessToken("short")).toThrow(ShopifyTransportError);

    // Exact BigInt + Intl minor unit parsing.
    expect(parseShopifyDecimalToMinor("31.00", "USD")).toBe(3100);
    expect(parseShopifyDecimalToMinor("0.05", "EUR")).toBe(5);
    expect(parseShopifyDecimalToMinor("1000", "JPY")).toBe(1000);
    expect(parseShopifyDecimalToMinor("1.500", "KWD")).toBe(1500);
    expect(parseShopifyDecimalToMinor("12.999", "USD")).toBeNull();
    expect(parseShopifyDecimalToMinor("-1.00", "USD")).toBeNull();

    const connector = createShopifyChannelAdapter({
      client: createShopifyHttpClient({
        shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
        accessToken: SHOPIFY_TEST_CANARIES.accessToken,
        fetchImpl: async () => {
          throw new Error("unused");
        },
      }),
      shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
      channelSlug: SHOPIFY_TEST_CHANNEL_SLUG,
      webhookSecrets: [SHOPIFY_TEST_CANARIES.webhookSecret, SHOPIFY_TEST_CANARIES.webhookSecretRotated],
    });
    const signal = new AbortController().signal;

    // Auth-before-parse: invalid JSON with bad HMAC MUST return signature rejection, never malformed.
    const invalidJsonBadSig = await connector.orders.normalizeWebhook({
      headers: {
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": "bm90LXZhbGlk",
      },
      rawBody: "{not-valid-json",
      signal,
    });
    expect(invalidJsonBadSig).toEqual({ kind: "rejected", reason: "signature" });

    // Valid rotated secret + mismatched x-shopify-shop-domain header rejects as signature.
    const wrongShop = buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: buildSampleShopifyOrder(),
      secret: SHOPIFY_TEST_CANARIES.webhookSecretRotated,
      shopHeader: "other-shop.myshopify.com",
    });
    expect(
      await connector.orders.normalizeWebhook({ ...wrongShop, signal }),
    ).toEqual({ kind: "rejected", reason: "signature" });

    // Valid rotated secret + valid orders/paid normalizes exact channel.order.v1 totals.
    const rotatedSigned = buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: buildSampleShopifyOrder(),
      secret: SHOPIFY_TEST_CANARIES.webhookSecretRotated,
      webhookId: "wh-rot-1",
    });
    const normalized = await connector.orders.normalizeWebhook({ ...rotatedSigned, signal });
    expect(normalized.kind).toBe("order");
    if (normalized.kind !== "order") throw new Error("expected order");
    expect(normalized.order.payment.state).toBe(CHANNEL_ORDER_PAID_EXTERNALLY_STATE);
    expect(normalized.order.totals).toEqual({
      itemsGrossMinor: 3000,
      itemsDiscountMinor: 300,
      shippingGrossMinor: 500,
      shippingDiscountMinor: 100,
      grandTotalMinor: 3100,
    });
    expect(normalized.order.lines[0]?.vatRateBps).toBe(2300);

    // Money mismatch on total_price surfaces loudly as unmapped (B3) instead of fabricating.
    const mismatchedOrder = buildSignedShopifyWebhook({
      topic: "orders/paid",
      bodyObj: buildSampleShopifyOrder({ total_price: "99.99" }),
      webhookId: "wh-mismatch-1",
    });
    const unmappedRes = await connector.orders.normalizeWebhook({ ...mismatchedOrder, signal });
    expect(unmappedRes).toMatchObject({
      kind: "unmapped",
      providerEventId: "wh-mismatch-1",
      signal: { vocabulary: "money_mismatch", externalOrderRef: "820982911946154" },
    });
  });

  it("supports Link page_info cursor pagination and Retry-After 429 cooldowns", async () => {
    let nowMs = 1_700_000_000_000;
    const expectedOrigin = `https://${SHOPIFY_TEST_SHOP_DOMAIN}.myshopify.com`;
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      calls.push({ url: urlStr, init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ orders: [buildSampleShopifyOrder()] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: `<${expectedOrigin}/admin/api/2025-01/orders.json?limit=50&page_info=cursor_page_2>; rel="next"`,
          },
        });
      }
      if (calls.length === 2) {
        return new Response(JSON.stringify({ errors: "Exceeded 2 calls per second" }), {
          status: 429,
          headers: { "retry-after": "15" },
        });
      }
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });

    const client = createShopifyHttpClient({
      shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
      accessToken: SHOPIFY_TEST_CANARIES.accessToken,
      fetchImpl: fetchSpy,
      clock: () => nowMs,
    });
    const connector = createShopifyChannelAdapter({
      client,
      shopDomain: SHOPIFY_TEST_SHOP_DOMAIN,
      channelSlug: SHOPIFY_TEST_CHANNEL_SLUG,
      webhookSecrets: [SHOPIFY_TEST_CANARIES.webhookSecret],
    });
    const signal = new AbortController().signal;

    const page1 = await connector.orders.pullOrders({
      connectionRef: "conn-1",
      channelExternalRef: null,
      since: "2030-06-15T00:00:00.000Z",
      cursor: null,
      limit: 50,
      signal,
    });
    expect(page1.orders).toHaveLength(1);
    expect(page1.nextCursor).toBe("cursor_page_2");
    expect(calls[0]!.url).toContain("financial_status=paid");
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(new Headers(calls[0]!.init?.headers).get("x-shopify-access-token")).toBe(
      SHOPIFY_TEST_CANARIES.accessToken,
    );

    // Reject foreign origin Link headers to prevent SSRF cursor steering.
    expect(
      parseShopifyNextPageCursor(
        '<https://evil.example.com/orders.json?page_info=abc>; rel="next"',
        expectedOrigin,
      ),
    ).toBeNull();

    // Second request hits 429 and arms Retry-After cooldown.
    await expect(
      connector.orders.pullOrders({
        connectionRef: "conn-1",
        channelExternalRef: null,
        since: null,
        cursor: page1.nextCursor,
        limit: 50,
        signal,
      }),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 15,
    });
    expect(calls[1]!.url).toContain("page_info=cursor_page_2");
    expect(calls[1]!.url).not.toContain("financial_status=");

    // Subsequent call during cooldown refuses at ZERO HTTP I/O.
    nowMs += 5_000;
    await expect(
      connector.orders.pullOrders({
        connectionRef: "conn-1",
        channelExternalRef: null,
        since: null,
        cursor: page1.nextCursor,
        limit: 50,
        signal,
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "SHOPIFY_COOLDOWN_ACTIVE",
      retryAfterSeconds: 10,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects planted-defect negative controls in runChannelAdapterConformance", async () => {
    const base = createShopifySubject();

    // Negative control #1: Broken HMAC verification that accepts invalid signatures fails conformance.
    const brokenSigSubject = {
      ...base,
      createWebhookAdapter: () => {
        const inner = base.createWebhookAdapter();
        return {
          ...inner,
          adapter: {
            ...inner.adapter,
            async normalizeWebhook(input: Parameters<typeof inner.adapter.normalizeWebhook>[0]) {
              const res = await inner.adapter.normalizeWebhook(input);
              if (res.kind === "rejected" && res.reason === "signature") {
                return { kind: "ignored" as const, providerEventId: "bypass", reason: "broken" };
              }
              return res;
            },
          },
        };
      },
    };
    await expect(runChannelAdapterConformance([brokenSigSubject])).rejects.toThrow(
      /CHANNEL_CONFORMANCE:webhook_kind_mismatch/,
    );

    // Negative control #2: Tampered grandTotalMinor violates normalizedChannelOrderSchema invariant.
    const badTotalsSubject = {
      ...base,
      createWebhookAdapter: () => {
        const inner = base.createWebhookAdapter();
        return {
          ...inner,
          adapter: {
            ...inner.adapter,
            async normalizeWebhook(input: Parameters<typeof inner.adapter.normalizeWebhook>[0]) {
              const res = await inner.adapter.normalizeWebhook(input);
              if (res.kind === "order") {
                return {
                  ...res,
                  order: {
                    ...res.order,
                    totals: { ...res.order.totals, grandTotalMinor: res.order.totals.grandTotalMinor + 1 },
                  },
                };
              }
              return res;
            },
          },
        };
      },
    };
    await expect(runChannelAdapterConformance([badTotalsSubject])).rejects.toThrow(
      /CHANNEL_CONFORMANCE:invalid_normalized_order/,
    );
  });
});
