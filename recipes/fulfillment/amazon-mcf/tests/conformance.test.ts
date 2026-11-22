import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createScriptedFulfillmentFake,
  runFulfillmentAdapterConformance,
  type FulfillmentAdapterTestSubject,
} from "@openlup/platform/fulfillment/testing";
import {
  AMAZON_LWA_TOKEN_URL,
  AMAZON_MCF_MAPPER_VERSION,
  AMAZON_MCF_PROVIDER_REF,
  AmazonMcfTransportError,
  LwaTokenError,
  amazonMcfFulfillmentCapabilities,
  buildCanonicalQueryString,
  buildCanonicalUri,
  createAmazonMcfFulfillmentAdapter,
  createAmazonMcfHttpClient,
  createAmazonMcfWebhookVerifier,
  createLwaTokenClient,
  projectAmazonMcfStaticCapabilities,
  resolvePinnedAmazonMcfOrigin,
  signAwsV4Request,
  type AmazonMcfOrderRecord,
  type FetchLike,
} from "../server/index.js";
import {
  FIXTURE_EARLIER_ISO,
  FIXTURE_LATER_ISO,
  FIXTURE_MARKETPLACE_US,
  FIXTURE_NOW_ISO,
  FIXTURE_SENSITIVE_CANARIES,
  FIXTURE_WEBHOOK_SECRET_PRIMARY,
  FIXTURE_WEBHOOK_SECRET_ROTATED,
  approveFixtureTrackingUrl,
  buildDispatchRequest,
  buildFixtureCredentials,
  buildLwaTokenResponse,
  buildSignedNotificationInput,
  buildSpApiInventoryPayload,
  buildSpApiOrderPayload,
} from "./fixtures.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const RECIPE_ROOT = resolve(THIS_DIR, "..");
const RECIPES_ROOT = resolve(RECIPE_ROOT, "..", "..");

function collectRelativeFiles(dir: string, root: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const collected: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectRelativeFiles(full, root));
    } else if (entry.isFile()) {
      collected.push(relative(root, full).replace(/\\/gu, "/"));
    }
  }
  return collected.sort();
}

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

/** Zero-dependency Draft 2020-12 JSON Schema validator for recipe manifests. */
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
    errors.push(`${pointer}: value ${JSON.stringify(value)} not in enum`);
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
      if (seen.size !== value.length) {
        errors.push(`${pointer}: duplicate items violate uniqueItems`);
      }
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
        if (!(key in record)) {
          errors.push(`${pointer}: missing required property ${JSON.stringify(key)}`);
        }
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

describe("recipes/fulfillment/amazon-mcf — manifest, schema & inventory parity", () => {
  it("validates recipe.json against recipes/schema/recipe.schema.json (Draft 2020-12)", () => {
    const schema = JSON.parse(
      readFileSync(resolve(RECIPES_ROOT, "schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    const errors = validateAgainstJsonSchema(manifest, schema);
    expect(errors).toEqual([]);
  });

  it("matches recipe.json staticCapabilities and exact disk allFiles inventory", () => {
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    expect(manifest.staticCapabilities).toEqual(projectAmazonMcfStaticCapabilities());
    expect(manifest.providerKind).toBe(amazonMcfFulfillmentCapabilities.providerRef);

    const diskFiles = collectRelativeFiles(RECIPE_ROOT, RECIPE_ROOT);
    const manifestFiles = [...(manifest.files.allFiles as string[])].sort();
    expect(manifestFiles).toEqual(diskFiles);
  });

  it("keeps server barrel import cold and inert (zero ambient network or env reads)", () => {
    expect(amazonMcfFulfillmentCapabilities.defaultOff).toBe(true);
    expect(amazonMcfFulfillmentCapabilities.selected).toBe(false);
    expect(amazonMcfFulfillmentCapabilities.readiness.ready).toBe(false);
  });
});

describe("recipes/fulfillment/amazon-mcf — official full-mode fulfillment adapter conformance", () => {
  it("passes runFulfillmentAdapterConformance(..., { mode: 'full' }) with verified qualification ledger", async () => {
    let ioCount = 0;

    const beforeFake = createScriptedFulfillmentFake<{ dispatch: undefined }>();
    beforeFake.enqueue("dispatch", { kind: "transport-before-submission" });

    const afterFake = createScriptedFulfillmentFake<{ dispatch: undefined }>();
    afterFake.enqueue("dispatch", { kind: "transport-after-submission" });

    const httpFake = createScriptedFulfillmentFake<{ dispatch: { status: number } }>();
    httpFake.enqueue("dispatch", { kind: "http-failure", status: 503, response: { status: 503 } });

    const dispatchCalls = beforeFake.calls;
    const afterCalls = afterFake.calls;
    const httpCalls = httpFake.calls;

    // Track dispatch-originated credentials requests so fixture #3 triggers transport-before-submission cleanly.
    let createOrderCallIndex = 0;
    let credentialsCallIndex = 0;
    let listOrdersCallIndex = 0;
    let inventoryCallIndex = 0;

    const orderReturned: AmazonMcfOrderRecord = {
      sellerFulfillmentOrderId: "MCF-RB-RETURNED",
      displayableOrderId: "ORD-RB-RET",
      fulfillmentOrderStatus: "Unfulfillable",
      statusUpdatedDate: FIXTURE_NOW_ISO,
      receivedDate: FIXTURE_EARLIER_ISO,
      fulfillmentShipments: [
        {
          amazonShipmentId: "AMZ-SHP-RET-01",
          fulfillmentShipmentStatus: "RETURNED_TO_SELLER",
          shippingDate: FIXTURE_EARLIER_ISO,
          fulfillmentShipmentPackage: [],
        },
      ],
    };

    const orderLostCoarse: AmazonMcfOrderRecord = {
      sellerFulfillmentOrderId: "MCF-RB-LOST",
      displayableOrderId: "ORD-RB-LOST",
      fulfillmentOrderStatus: "Processing",
      statusUpdatedDate: FIXTURE_NOW_ISO,
      receivedDate: FIXTURE_EARLIER_ISO,
      fulfillmentShipments: [
        {
          amazonShipmentId: "AMZ-SHP-LOST-01",
          fulfillmentShipmentStatus: "UNDELIVERABLE",
          shippingDate: FIXTURE_EARLIER_ISO,
          fulfillmentShipmentPackage: [],
        },
      ],
    };

    const orderFoundShipped: AmazonMcfOrderRecord = {
      sellerFulfillmentOrderId: "MCF-RB-SHIPPED",
      displayableOrderId: "ORD-RB-SHP",
      fulfillmentOrderStatus: "Processing",
      statusUpdatedDate: FIXTURE_NOW_ISO,
      receivedDate: FIXTURE_EARLIER_ISO,
      fulfillmentShipments: [
        {
          amazonShipmentId: "AMZ-SHP-OK-01",
          fulfillmentShipmentStatus: "SHIPPED",
          shippingDate: FIXTURE_NOW_ISO,
          fulfillmentShipmentPackage: [
            {
              packageNumber: 1,
              carrierCode: "UPS",
              trackingNumber: "1Z999AA10123456784",
              trackingUrl: "https://track.carrier.example/1Z999AA10123456784",
            },
          ],
        },
      ],
    };

    const pageRowA: AmazonMcfOrderRecord = {
      sellerFulfillmentOrderId: "MCF-PG-01",
      displayableOrderId: "ORD-PG-01",
      fulfillmentOrderStatus: "Planning",
      statusUpdatedDate: FIXTURE_NOW_ISO,
      receivedDate: FIXTURE_EARLIER_ISO,
    };
    const pageRowB: AmazonMcfOrderRecord = {
      sellerFulfillmentOrderId: "MCF-PG-02",
      displayableOrderId: "ORD-PG-02",
      fulfillmentOrderStatus: "Complete",
      statusUpdatedDate: FIXTURE_NOW_ISO,
      receivedDate: FIXTURE_EARLIER_ISO,
    };
    const pageRowC: AmazonMcfOrderRecord = {
      sellerFulfillmentOrderId: "MCF-PG-03",
      displayableOrderId: "ORD-PG-03",
      fulfillmentOrderStatus: "Received",
      statusUpdatedDate: FIXTURE_NOW_ISO,
      receivedDate: FIXTURE_EARLIER_ISO,
    };

    const fetchImpl: FetchLike = async (urlString, init) => {
      ioCount += 1;
      const url = new URL(urlString);
      const method = (init?.method ?? "GET").toUpperCase();

      // 1. LWA token endpoint
      if (url.origin === "https://api.amazon.com" && url.pathname === "/auth/o2/token") {
        return buildLwaTokenResponse();
      }

      // Assert SigV4 + LWA headers on every SP-API call
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-amz-access-token"]).toBe(FIXTURE_SENSITIVE_CANARIES.lwaAccessToken);
      expect(headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFIXTUREMCF000001\//u);

      // 2. Dispatch POST /fba/outbound/2020-07-01/fulfillmentOrders
      if (method === "POST" && url.pathname === "/fba/outbound/2020-07-01/fulfillmentOrders") {
        createOrderCallIndex += 1;
        if (createOrderCallIndex === 1) {
          // Fixture #0: accepted
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (createOrderCallIndex === 2) {
          // Fixture #2: addressAfterSubmission -> SP-API 400 InvalidInput
          return new Response(
            JSON.stringify({
              errors: [{ code: "InvalidInput", message: "Destination postal code invalid" }],
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        if (createOrderCallIndex === 3) {
          // Fixture #4: transport-after-submission
          await afterFake.invoke("dispatch");
          throw new Error("unreachable");
        }
        if (createOrderCallIndex === 4) {
          // Fixture #5: http-failure 503
          const outcome = await httpFake.invoke("dispatch");
          return new Response(JSON.stringify({ errors: [{ code: "ServiceUnavailable" }] }), {
            status: outcome.status,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected createFulfillmentOrder call ${createOrderCallIndex}`);
      }

      // 3. Readback GET /fba/outbound/2020-07-01/fulfillmentOrders/:id
      if (method === "GET" && url.pathname.startsWith("/fba/outbound/2020-07-01/fulfillmentOrders/")) {
        const orderId = decodeURIComponent(
          url.pathname.slice("/fba/outbound/2020-07-01/fulfillmentOrders/".length),
        );
        if (orderId === "MCF-RB-SHIPPED") {
          return new Response(JSON.stringify(buildSpApiOrderPayload(orderFoundShipped)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (orderId === "MCF-RB-RETURNED") {
          return new Response(JSON.stringify(buildSpApiOrderPayload(orderReturned)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (orderId === "MCF-RB-LOST") {
          return new Response(JSON.stringify(buildSpApiOrderPayload(orderLostCoarse)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (orderId === "MCF-RB-MISSING") {
          return new Response(JSON.stringify({ errors: [{ code: "NotFound" }] }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if (orderId === "MCF-RB-ERROR") {
          return new Response(JSON.stringify({ errors: [{ code: "ServiceUnavailable" }] }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected readback id ${orderId}`);
      }

      // 4. Reconciliation paging GET /fba/outbound/2020-07-01/fulfillmentOrders
      if (method === "GET" && url.pathname === "/fba/outbound/2020-07-01/fulfillmentOrders") {
        listOrdersCallIndex += 1;
        const token = url.searchParams.get("nextToken");
        if (listOrdersCallIndex === 1 && token === null) {
          // full page (size 2)
          return new Response(
            JSON.stringify({
              payload: {
                fulfillmentOrders: [pageRowA, pageRowB],
                nextToken: "mcf_next_tok_1",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (listOrdersCallIndex === 2 && token === "mcf_next_tok_1") {
          // short page (1 < 2)
          return new Response(
            JSON.stringify({
              payload: {
                fulfillmentOrders: [pageRowC],
                nextToken: "mcf_next_tok_2",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (listOrdersCallIndex === 3 && token === "mcf_next_tok_2") {
          // empty page, nextToken null so next page returns page_exhausted
          return new Response(
            JSON.stringify({
              payload: {
                fulfillmentOrders: [],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (listOrdersCallIndex === 4 && token === null) {
          // failure page
          return new Response(JSON.stringify({ errors: [{ code: "ServiceUnavailable" }] }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected listAllFulfillmentOrders call ${listOrdersCallIndex} token=${token}`);
      }

      // 5. Stock sync GET /fba/inventory/v1/summaries
      if (method === "GET" && url.pathname === "/fba/inventory/v1/summaries") {
        inventoryCallIndex += 1;
        if (inventoryCallIndex === 1 || inventoryCallIndex === 2) {
          return new Response(
            JSON.stringify(
              buildSpApiInventoryPayload([
                {
                  sellerSku: "SKU-WIDGET-01",
                  totalQuantity: 120,
                  fulfillableQuantity: 100,
                  reservedQuantity: 15,
                  unfulfillableQuantity: 5,
                  lastUpdatedTime: FIXTURE_NOW_ISO,
                },
                {
                  sellerSku: "bad sku with spaces!",
                  totalQuantity: 5,
                  fulfillableQuantity: 5,
                  reservedQuantity: 0,
                  unfulfillableQuantity: 0,
                },
              ]),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (inventoryCallIndex === 3) {
          return new Response(JSON.stringify({ errors: [{ code: "ServiceUnavailable" }] }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected listInventorySummaries call ${inventoryCallIndex}`);
      }

      throw new Error(`unexpected request: ${method} ${urlString}`);
    };

    const client = createAmazonMcfHttpClient({
      region: "na",
      environment: "sandbox",
      fetchImpl,
      clock: () => FIXTURE_NOW_ISO,
      credentials: async () => {
        credentialsCallIndex += 1;
        // Call 1 = fixture #0 accepted, Call 2 = fixture #2 addressAfterSubmission, Call 3 = fixture #3 transport-before-submission
        if (credentialsCallIndex === 3) {
          await beforeFake.invoke("dispatch");
        }
        return buildFixtureCredentials();
      },
    });

    const adapter = createAmazonMcfFulfillmentAdapter({
      client,
      marketplaceId: FIXTURE_MARKETPLACE_US,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
      approveTrackingUrl: approveFixtureTrackingUrl,
    });

    // Helper adapter instance strictly to compute deterministic expected outputs without mutating test subject state.
    const helperAdapter = createAmazonMcfFulfillmentAdapter({
      client: {
        createFulfillmentOrder: async () => ({ accepted: true }),
        getFulfillmentOrder: async (id) => {
          if (id === "MCF-RB-SHIPPED") return orderFoundShipped;
          if (id === "MCF-RB-RETURNED") return orderReturned;
          if (id === "MCF-RB-LOST") return orderLostCoarse;
          return null;
        },
        listAllFulfillmentOrders: async ({ nextToken } = {}) => {
          if (!nextToken) return { fulfillmentOrders: [pageRowA, pageRowB], nextToken: "mcf_next_tok_1" };
          if (nextToken === "mcf_next_tok_1") return { fulfillmentOrders: [pageRowC], nextToken: "mcf_next_tok_2" };
          return { fulfillmentOrders: [], nextToken: null };
        },
        listInventorySummaries: async () => ({
          inventorySummaries: [
            {
              sellerSku: "SKU-WIDGET-01",
              totalQuantity: 120,
              fulfillableQuantity: 100,
              reservedQuantity: 15,
              unfulfillableQuantity: 5,
              lastUpdatedTime: FIXTURE_NOW_ISO,
            },
            {
              sellerSku: "bad sku with spaces!",
              totalQuantity: 5,
              fulfillableQuantity: 5,
              reservedQuantity: 0,
              unfulfillableQuantity: 0,
            },
          ],
          nextToken: null,
        }),
      },
      marketplaceId: FIXTURE_MARKETPLACE_US,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
      approveTrackingUrl: approveFixtureTrackingUrl,
    });

    // Build dispatch fixtures (7 distinct indices)
    const reqAccepted = buildDispatchRequest({
      requestKey: "req_mcf_accepted",
      fulfillmentRef: "ful_mcf_accepted",
      parcelRef: "MCF-ORD-ACC",
    });
    const prepAccepted = await helperAdapter.dispatch.prepare(reqAccepted);
    if (prepAccepted.kind !== "prepared") throw new Error("expected prepared");

    const reqAddrBefore = buildDispatchRequest({
      requestKey: "req_mcf_addr_before",
      fulfillmentRef: "ful_mcf_addr_before",
      parcelRef: "MCF-ORD-AB",
      recipientOverrides: { line1: "   " },
    });

    const reqAddrAfter = buildDispatchRequest({
      requestKey: "req_mcf_addr_after",
      fulfillmentRef: "ful_mcf_addr_after",
      parcelRef: "MCF-ORD-AA",
    });
    const prepAddrAfter = await helperAdapter.dispatch.prepare(reqAddrAfter);
    if (prepAddrAfter.kind !== "prepared") throw new Error("expected prepared");

    const reqTransportBefore = buildDispatchRequest({
      requestKey: "req_mcf_tb",
      fulfillmentRef: "ful_mcf_tb",
      parcelRef: "MCF-ORD-TB",
    });
    const prepTransportBefore = await helperAdapter.dispatch.prepare(reqTransportBefore);
    if (prepTransportBefore.kind !== "prepared") throw new Error("expected prepared");

    const reqTransportAfter = buildDispatchRequest({
      requestKey: "req_mcf_ta",
      fulfillmentRef: "ful_mcf_ta",
      parcelRef: "MCF-ORD-TA",
    });
    const prepTransportAfter = await helperAdapter.dispatch.prepare(reqTransportAfter);
    if (prepTransportAfter.kind !== "prepared") throw new Error("expected prepared");

    const reqHttpFailure = buildDispatchRequest({
      requestKey: "req_mcf_http",
      fulfillmentRef: "ful_mcf_http",
      parcelRef: "MCF-ORD-503",
    });
    const prepHttpFailure = await helperAdapter.dispatch.prepare(reqHttpFailure);
    if (prepHttpFailure.kind !== "prepared") throw new Error("expected prepared");

    const reqPickupPoint = buildDispatchRequest({
      requestKey: "req_mcf_locker",
      fulfillmentRef: "ful_mcf_locker",
      parcelRef: "MCF-ORD-LCK",
      selectionOverrides: {
        deliveryKind: "parcel-locker",
        pickupPoint: {
          id: "LOCKER-01",
          provider: "locker_net",
          name: "Downtown Locker",
          address: { line1: "100 Main St", postalCode: "98101", city: "Seattle", country: "US" },
        },
      },
    });

    // Build observation fixtures (5 distinct indices: dup0, dup1, newer, older, authFailure)
    const obsDupInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-OBS-DUP",
      fulfillmentOrderStatus: "Processing",
      fulfillmentShipmentStatus: "SHIPPED",
      statusUpdatedDateTime: FIXTURE_NOW_ISO,
      notificationId: "notif-dup-001",
      displayableOrderId: "ORD-OBS-DUP",
      packages: [
        {
          trackingNumber: "1Z999AA10123456785",
          carrierCode: "UPS",
          trackingUrl: `https://track.carrier.example/1Z999AA10123456785?signature=${FIXTURE_SENSITIVE_CANARIES.signedTrackingToken}`,
        },
      ],
    });
    const expectedObsDup = await helperAdapter.observation!.verifyAndNormalize(obsDupInput);

    const obsNewerInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-OBS-OOO",
      fulfillmentOrderStatus: "Complete",
      fulfillmentShipmentStatus: "DELIVERED",
      statusUpdatedDateTime: FIXTURE_LATER_ISO,
      notificationId: "notif-ooo-newer",
      displayableOrderId: "ORD-OBS-OOO",
      amazonShipmentId: "AMZ-SHP-OOO",
    });
    const expectedObsNewer = await helperAdapter.observation!.verifyAndNormalize(obsNewerInput);

    const obsOlderInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-OBS-OOO",
      fulfillmentOrderStatus: "Processing",
      fulfillmentShipmentStatus: "SHIPPED",
      statusUpdatedDateTime: FIXTURE_EARLIER_ISO,
      notificationId: "notif-ooo-older",
      displayableOrderId: "ORD-OBS-OOO",
      amazonShipmentId: "AMZ-SHP-OOO",
    });
    const expectedObsOlder = await helperAdapter.observation!.verifyAndNormalize(obsOlderInput);

    const obsAuthFailInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-OBS-AUTH",
      fulfillmentOrderStatus: "Complete",
      statusUpdatedDateTime: FIXTURE_NOW_ISO,
      notificationId: "notif-auth-fail",
      tamperSignature: true,
    });

    // Build readback expected results
    const expectedRbShipped = await helperAdapter.readback!.read({
      providerRef: AMAZON_MCF_PROVIDER_REF,
      requestKey: "req_rb_shipped",
      fulfillmentRef: "ful_rb_shipped",
      externalRef: "MCF-RB-SHIPPED",
      mode: "parcel",
    });
    const expectedRbReturned = await helperAdapter.readback!.read({
      providerRef: AMAZON_MCF_PROVIDER_REF,
      requestKey: "req_rb_returned",
      fulfillmentRef: "ful_rb_returned",
      externalRef: "MCF-RB-RETURNED",
      mode: "parcel",
    });
    const expectedRbLost = await helperAdapter.readback!.read({
      providerRef: AMAZON_MCF_PROVIDER_REF,
      requestKey: "req_rb_lost",
      fulfillmentRef: "ful_rb_lost",
      externalRef: "MCF-RB-LOST",
      mode: "parcel",
    });

    // Build expected paging results
    const expectedPageFull = await helperAdapter.reconciliation!.readPage({ page: 0, size: 2 });
    const expectedPageShort = await helperAdapter.reconciliation!.readPage({ page: 1, size: 2 });
    const expectedPageEmpty = await helperAdapter.reconciliation!.readPage({ page: 2, size: 2 });
    if (
      expectedPageFull.kind !== "page" ||
      expectedPageShort.kind !== "page" ||
      expectedPageEmpty.kind !== "page"
    ) {
      throw new Error("expected page outcomes");
    }

    const expectedStock = await helperAdapter.stockSync!.getStock();

    const subject: FulfillmentAdapterTestSubject = {
      subjectId: "recipe:fulfillment/amazon-mcf",
      adapter,
      approveTrackingUrl: approveFixtureTrackingUrl,
      readIoCount: () => ioCount,
      sensitiveValues: Object.values(FIXTURE_SENSITIVE_CANARIES),
      fixtures: {
        dispatch: [
          {
            input: reqAccepted,
            expectedPrepare: prepAccepted,
            expectedDispatch: {
              kind: "accepted",
              externalRef: "MCF-ORD-ACC",
              evidence: prepAccepted.evidence,
              providerAttemptKey: `amazon_mcf:attempt:${prepAccepted.evidence.commandFingerprint.slice(0, 24)}`,
              labelKey: "amazon_mcf:receipt:MCF-ORD-ACC",
              receiptKey: "amazon_mcf:receipt:MCF-ORD-ACC",
            },
            replay: true,
          },
          {
            input: reqAddrBefore,
            expectedPrepare: {
              kind: "refused",
              refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false },
            },
          },
          {
            input: reqAddrAfter,
            expectedPrepare: prepAddrAfter,
            expectedDispatch: {
              kind: "not_dispatched",
              effectMayHaveSucceeded: false,
              refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false },
              error: {
                code: "amazon_mcf_InvalidInput",
                status: 400,
                retryable: false,
                mayHaveSucceeded: false,
                submissionAttempted: true,
                responseBodyRead: true,
              },
            },
          },
          {
            input: reqTransportBefore,
            expectedPrepare: prepTransportBefore,
            expectedDispatch: {
              kind: "not_dispatched",
              effectMayHaveSucceeded: false,
              refusal: { reason: "io_failure", phase: "dispatch", retryable: true },
              error: {
                code: "amazon_mcf_transport_before_submission",
                status: null,
                retryable: true,
                mayHaveSucceeded: false,
                submissionAttempted: false,
                responseBodyRead: false,
              },
            },
          },
          {
            input: reqTransportAfter,
            expectedPrepare: prepTransportAfter,
            expectedDispatch: {
              kind: "unknown",
              effectMayHaveSucceeded: true,
              refusal: { reason: "io_failure", phase: "dispatch", retryable: true },
              error: {
                code: "amazon_mcf_transport_error",
                status: null,
                retryable: true,
                mayHaveSucceeded: true,
                submissionAttempted: true,
                responseBodyRead: false,
              },
            },
            replay: true,
          },
          {
            input: reqHttpFailure,
            expectedPrepare: prepHttpFailure,
            expectedDispatch: {
              kind: "unknown",
              effectMayHaveSucceeded: true,
              refusal: { reason: "io_failure", phase: "dispatch", retryable: true },
              error: {
                code: "amazon_mcf_http_503",
                status: 503,
                retryable: true,
                mayHaveSucceeded: true,
                submissionAttempted: true,
                responseBodyRead: false,
              },
            },
            replay: true,
          },
          {
            input: reqPickupPoint,
            expectedPrepare: {
              kind: "refused",
              refusal: { reason: "unsupported", phase: "prepare", retryable: false },
            },
          },
        ],
        label: {
          create: [
            {
              input: [reqAccepted],
              expected: {
                kind: "refused",
                refusal: { reason: "unsupported", phase: "dispatch", retryable: false },
              },
            },
          ],
          read: [
            {
              input: [{ objectRef: "obj_001", mediaType: "application/pdf", externalRef: "MCF-ORD-ACC" }],
              expected: {
                kind: "refused",
                refusal: { reason: "unsupported", phase: "dispatch", retryable: false },
              },
            },
          ],
          void: [
            {
              input: [{ parcelRef: "MCF-ORD-ACC", document: null }],
              expected: {
                providerDeletion: "unconfirmed",
                labelDeleted: false,
                canProceed: false,
                refusal: { reason: "unsupported", phase: "dispatch", retryable: false },
              },
            },
          ],
        },
        observation: [
          { input: [obsDupInput], expected: expectedObsDup },
          { input: [obsDupInput], expected: expectedObsDup },
          { input: [obsNewerInput], expected: expectedObsNewer },
          { input: [obsOlderInput], expected: expectedObsOlder },
          {
            input: [obsAuthFailInput],
            expected: {
              kind: "refused",
              refusal: { reason: "untrusted", phase: "verify", retryable: false },
            },
          },
        ],
        readback: [
          {
            input: [
              {
                providerRef: AMAZON_MCF_PROVIDER_REF,
                requestKey: "req_rb_shipped",
                fulfillmentRef: "ful_rb_shipped",
                externalRef: "MCF-RB-SHIPPED",
                mode: "parcel",
              },
            ],
            expected: expectedRbShipped,
          },
          {
            input: [
              {
                providerRef: AMAZON_MCF_PROVIDER_REF,
                requestKey: "req_rb_returned",
                fulfillmentRef: "ful_rb_returned",
                externalRef: "MCF-RB-RETURNED",
                mode: "parcel",
              },
            ],
            expected: expectedRbReturned,
          },
          {
            input: [
              {
                providerRef: AMAZON_MCF_PROVIDER_REF,
                requestKey: "req_rb_lost",
                fulfillmentRef: "ful_rb_lost",
                externalRef: "MCF-RB-LOST",
                mode: "parcel",
              },
            ],
            expected: expectedRbLost,
          },
          {
            input: [
              {
                providerRef: AMAZON_MCF_PROVIDER_REF,
                requestKey: "req_rb_missing",
                fulfillmentRef: "ful_rb_missing",
                externalRef: "MCF-RB-MISSING",
                mode: "parcel",
              },
            ],
            localMissing: true,
            expected: {
              kind: "unknown",
              refusal: { reason: "local_missing", phase: "readback", retryable: false },
            },
          },
          {
            input: [
              {
                providerRef: AMAZON_MCF_PROVIDER_REF,
                requestKey: "req_rb_error",
                fulfillmentRef: "ful_rb_error",
                externalRef: "MCF-RB-ERROR",
                mode: "command",
              },
            ],
            expected: {
              kind: "unknown",
              refusal: { reason: "io_failure", phase: "readback", retryable: true },
            },
          },
        ],
        stockSync: [
          {
            operation: "getStock",
            input: [],
            expected: expectedStock,
          },
        ],
        productSync: [
          {
            operation: "listStockedSkus",
            input: [],
            expected: {
              kind: "refused",
              refusal: { reason: "unsupported", phase: "sync", retryable: false },
            },
          },
        ],
      },
      certification: {
        profile: "adapter",
        dispatch: {
          addressBeforeSubmission: 1,
          addressAfterSubmission: 2,
          transport: {
            "transport-before-submission": { fixture: 3, calls: dispatchCalls },
            "transport-after-submission": { fixture: 4, calls: afterCalls },
            "http-failure": { fixture: 5, calls: httpCalls },
          },
        },
        observation: {
          duplicate: [0, 1],
          outOfOrder: [2, 3],
          authenticationFailure: 4,
        },
        exceptions: {
          returned: 1,
          lostCoarse: 2,
        },
        paging: {
          full: { input: { page: 0, size: 2 }, expected: expectedPageFull },
          short: { input: { page: 1, size: 2 }, expected: expectedPageShort },
          empty: { input: { page: 2, size: 2 }, expected: expectedPageEmpty },
          exhausted: { input: { page: 3, size: 2 }, expected: { kind: "page_exhausted" } },
          failure: {
            input: { page: 0, size: 2 },
            expected: {
              kind: "failed",
              refusal: { reason: "io_failure", phase: "readback", retryable: true },
              error: {
                code: "amazon_mcf_http_503",
                status: 503,
                retryable: true,
                mayHaveSucceeded: false,
                submissionAttempted: true,
                responseBodyRead: false,
              },
            },
          },
        },
        stockSync: [
          {
            operation: "getStock",
            success: { input: [], expected: expectedStock },
            failure: {
              input: [],
              throws: { reason: "io_failure", phase: "sync", retryable: true },
            },
          },
        ],
        snapshotOnly: true,
      },
    };

    const result = await runFulfillmentAdapterConformance([subject], { mode: "full" });
    expect(result.mode).toBe("full");
    expect(result.subjects).toEqual([
      { subjectId: "recipe:fulfillment/amazon-mcf", providerRef: AMAZON_MCF_PROVIDER_REF },
    ]);
    expect(result.qualifications).toHaveLength(1);
    const qual = result.qualifications[0]!;
    expect(qual.profile).toBe("adapter");
    expect(qual.capabilityDigest).toBe(
      createHash("sha256").update(JSON.stringify(adapter.capabilities)).digest("hex"),
    );
    expect(qual.declarations).toEqual([
      { capability: "courierPickup", declared: "unsupported", probe: "no_port" },
    ]);

    beforeFake.assertDrained();
    afterFake.assertDrained();
    httpFake.assertDrained();
  });
});

describe("recipes/fulfillment/amazon-mcf — protocol, auth & security hardening", () => {
  it("computes deterministic AWS SigV4 signatures with double-encoded URI paths and sorted query strings", () => {
    expect(buildCanonicalUri("/fba/outbound/2020-07-01/fulfillmentOrders/ORD%201+2")).toBe(
      "/fba/outbound/2020-07-01/fulfillmentOrders/ORD%25201%252B2",
    );
    const query = buildCanonicalQueryString(
      new URLSearchParams([
        ["z", "1"],
        ["a", "hello world!"],
        ["a", "alpha"],
      ]),
    );
    expect(query).toBe("a=alpha&a=hello%20world%21&z=1");

    const signed = signAwsV4Request({
      method: "POST",
      url: new URL("https://sellingpartnerapi-na.amazon.com/fba/outbound/2020-07-01/fulfillmentOrders"),
      region: "us-east-1",
      service: "execute-api",
      headers: {
        "content-type": "application/json",
        "x-amz-access-token": FIXTURE_SENSITIVE_CANARIES.lwaAccessToken,
      },
      body: new TextEncoder().encode('{"hello":"world"}'),
      credentials: buildFixtureCredentials(),
      timestampIso: FIXTURE_NOW_ISO,
    });

    expect(signed.amzDate).toBe("20300615T120000Z");
    expect(signed.credentialScope).toBe("20300615/us-east-1/execute-api/aws4_request");
    expect(signed.signedHeaders).toBe("content-type;host;x-amz-access-token;x-amz-date;x-amz-security-token");
    expect(signed.headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAFIXTUREMCF000001\/20300615\/us-east-1\/execute-api\/aws4_request, SignedHeaders=content-type;host;x-amz-access-token;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/u,
    );
    expect(signed.headers["authorization"]).not.toContain(FIXTURE_SENSITIVE_CANARIES.awsSecretAccessKey);
  });

  it("deduplicates concurrent LWA token exchanges (single-flight), refreshes before expiry, and redacts secrets on error", async () => {
    let nowIso = FIXTURE_NOW_ISO;
    let calls = 0;

    const lwa = createLwaTokenClient({
      clock: () => nowIso,
      fetchImpl: async (url, init) => {
        calls += 1;
        expect(url).toBe(AMAZON_LWA_TOKEN_URL);
        expect(init?.redirect).toBe("error");
        return buildLwaTokenResponse(`tok_v${calls}`);
      },
    });

    const creds = buildFixtureCredentials();
    const [t1, t2, t3] = await Promise.all([
      lwa.getAccessToken(creds),
      lwa.getAccessToken(creds),
      lwa.getAccessToken(creds),
    ]);
    expect([t1, t2, t3]).toEqual(["tok_v1", "tok_v1", "tok_v1"]);
    expect(calls).toBe(1);

    // Advance clock to within 60s skew -> triggers refresh
    nowIso = "2030-06-15T12:59:30.000Z";
    const refreshed = await lwa.getAccessToken(creds);
    expect(refreshed).toBe("tok_v2");
    expect(calls).toBe(2);

    // Error redaction check
    const failingLwa = createLwaTokenClient({
      clock: () => FIXTURE_NOW_ISO,
      fetchImpl: async () => new Response("invalid_client", { status: 401 }),
    });
    await expect(failingLwa.getAccessToken(creds)).rejects.toMatchObject({
      name: "LwaTokenError",
      code: "amazon_lwa_http_401",
      status: 401,
      retryable: false,
    });
    try {
      await failingLwa.getAccessToken(creds);
    } catch (err) {
      expect(err).toBeInstanceOf(LwaTokenError);
      expect(JSON.stringify(err)).not.toContain(FIXTURE_SENSITIVE_CANARIES.lwaClientSecret);
      expect(JSON.stringify(err)).not.toContain(FIXTURE_SENSITIVE_CANARIES.lwaRefreshToken);
    }
  });

  it("pins regional HTTPS origins and rejects unknown regions or environments", () => {
    expect(resolvePinnedAmazonMcfOrigin("na", "live")).toEqual({
      origin: "https://sellingpartnerapi-na.amazon.com",
      awsRegion: "us-east-1",
    });
    expect(resolvePinnedAmazonMcfOrigin("eu", "sandbox")).toEqual({
      origin: "https://sandbox.sellingpartnerapi-eu.amazon.com",
      awsRegion: "eu-west-1",
    });
    expect(resolvePinnedAmazonMcfOrigin("fe", "live")).toEqual({
      origin: "https://sellingpartnerapi-fe.amazon.com",
      awsRegion: "us-west-2",
    });

    expect(() => resolvePinnedAmazonMcfOrigin("xx" as "na", "live")).toThrow(AmazonMcfTransportError);
    expect(() => resolvePinnedAmazonMcfOrigin("na", "staging" as "live")).toThrow(AmazonMcfTransportError);
  });

  it("keeps request timeout active through response body reading", async () => {
    const client = createAmazonMcfHttpClient({
      region: "na",
      environment: "sandbox",
      clock: () => FIXTURE_NOW_ISO,
      timeoutMs: 30,
      credentials: buildFixtureCredentials,
      fetchImpl: async (urlString, init) => {
        if (urlString === AMAZON_LWA_TOKEN_URL) return buildLwaTokenResponse();
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted_body_read")));
            }),
        } as unknown as Response;
      },
    });

    await expect(client.getFulfillmentOrder("MCF-SLOW-BODY")).rejects.toMatchObject({
      code: "amazon_mcf_timeout",
      retryable: true,
    });
  });

  it("enforces webhook auth-before-parse, key rotation, replay skew, and rejects short keys (planted-defect negative controls)", async () => {
    // Reject short HMAC secret
    expect(() => createAmazonMcfWebhookVerifier({ signingSecrets: ["a1b2c3"] })).toThrow(
      "amazon_mcf_webhook_signing_secret_invalid",
    );

    const verifier = createAmazonMcfWebhookVerifier({
      signingSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY, FIXTURE_WEBHOOK_SECRET_ROTATED],
      approveTrackingUrl: approveFixtureTrackingUrl,
      maxTimestampSkewMs: 300_000,
    });

    // Rotated key verifies cleanly
    const rotatedInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-ROT-01",
      fulfillmentOrderStatus: "Complete",
      statusUpdatedDateTime: FIXTURE_NOW_ISO,
      notificationId: "notif-rot-01",
      secretHex: FIXTURE_WEBHOOK_SECRET_ROTATED,
    });
    const rotatedResult = await verifier.verifyAndNormalize(rotatedInput);
    expect(rotatedResult.kind).toBe("verified");
    if (rotatedResult.kind === "verified") {
      expect(rotatedResult.observation.fact.mapperVersion).toBe(AMAZON_MCF_MAPPER_VERSION);
    }

    // Auth-before-parse: invalid JSON with bad signature returns untrusted (NOT malformed)
    const badJsonBadSig = await verifier.verifyAndNormalize({
      rawBody: new TextEncoder().encode("{not-json"),
      headers: {
        "x-mcf-timestamp": FIXTURE_NOW_ISO,
        "x-mcf-signature": `sha256=${"f".repeat(64)}`,
      },
      receivedAt: FIXTURE_NOW_ISO,
    });
    expect(badJsonBadSig).toEqual({
      kind: "refused",
      refusal: { reason: "untrusted", phase: "verify", retryable: false },
    });

    // Stale timestamp beyond maxTimestampSkewMs is refused as untrusted before parsing
    const staleInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-STALE-01",
      fulfillmentOrderStatus: "Complete",
      statusUpdatedDateTime: FIXTURE_EARLIER_ISO,
      timestamp: FIXTURE_EARLIER_ISO,
      receivedAt: FIXTURE_NOW_ISO,
      notificationId: "notif-stale-01",
    });
    const staleResult = await verifier.verifyAndNormalize(staleInput);
    expect(staleResult).toEqual({
      kind: "refused",
      refusal: { reason: "untrusted", phase: "verify", retryable: false },
    });

    // Unsupported notification type is refused after valid auth
    const wrongTypeInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-WRONG-TYPE",
      fulfillmentOrderStatus: "Complete",
      statusUpdatedDateTime: FIXTURE_NOW_ISO,
      notificationId: "notif-wrong-type",
      notificationType: "ANY_OFFER_CHANGED",
    });
    const wrongTypeResult = await verifier.verifyAndNormalize(wrongTypeInput);
    expect(wrongTypeResult).toEqual({
      kind: "refused",
      refusal: { reason: "unsupported_event", phase: "normalize", retryable: false },
    });
  });

  it("refuses stockSync.getStockMovements with stock_movements_unsupported at zero I/O", async () => {
    let ioCalls = 0;
    const client = createAmazonMcfHttpClient({
      region: "na",
      environment: "sandbox",
      clock: () => FIXTURE_NOW_ISO,
      credentials: buildFixtureCredentials,
      fetchImpl: async () => {
        ioCalls += 1;
        throw new Error("should_not_call_network");
      },
    });
    const adapter = createAmazonMcfFulfillmentAdapter({
      client,
      marketplaceId: FIXTURE_MARKETPLACE_US,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });

    await expect(adapter.stockSync!.getStockMovements()).rejects.toEqual({
      reason: "stock_movements_unsupported",
      phase: "sync",
      retryable: false,
    });
    expect(ioCalls).toBe(0);
  });
});
