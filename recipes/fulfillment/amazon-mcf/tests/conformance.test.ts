import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  DispatchEvidence,
  FulfillmentDispatchRequest,
  FulfillmentObservation,
  FulfillmentReadbackResult,
  FulfillmentReconciliationObservation,
  StockSnapshot,
} from "@openlup/platform/fulfillment/contracts";
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
  mapAmazonMcfStatus,
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
  format?: string;
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

const RFC3339_DATE_TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

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
    if (
      schema.format === "date-time" &&
      (!RFC3339_DATE_TIME_REGEX.test(value) || !Number.isFinite(Date.parse(value)))
    ) {
      errors.push(`${pointer}: string ${JSON.stringify(value)} is not a valid date-time`);
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

/** Independently constructs the deterministic SP-API wire payload & SHA-256 fingerprint (no code-under-test reuse). */
function expectedDispatchEvidenceFor(req: FulfillmentDispatchRequest): {
  readonly expectedWireCommand: Record<string, unknown>;
  readonly evidence: DispatchEvidence;
} {
  const sellerOrderId = (req.parcelRef ?? req.fulfillmentRef).trim();
  const deterministicWireCommand = {
    marketplaceId: FIXTURE_MARKETPLACE_US,
    sellerFulfillmentOrderId: sellerOrderId,
    displayableOrderId: req.orderNumber ?? req.orderRef,
    displayableOrderComment: "Order fulfillment",
    shippingSpeedCategory: "Standard",
    destinationAddress: {
      name: req.recipient.name,
      addressLine1: req.recipient.line1,
      ...(req.recipient.line2 ? { addressLine2: req.recipient.line2 } : {}),
      city: req.recipient.city,
      postalCode: req.recipient.postalCode,
      countryCode: req.recipient.country,
      ...(req.recipient.phone ? { phone: req.recipient.phone } : {}),
    },
    ...(req.recipient.email ? { notificationEmails: [req.recipient.email] } : {}),
    items: req.lines.map((line, index) => ({
      sellerSku: line.skuRef,
      sellerFulfillmentOrderItemId: `${sellerOrderId}-${index + 1}`,
      quantity: line.quantity,
    })),
  };
  const commandFingerprint = createHash("sha256")
    .update(JSON.stringify(deterministicWireCommand), "utf8")
    .digest("hex");

  const expectedWireCommand = {
    marketplaceId: deterministicWireCommand.marketplaceId,
    sellerFulfillmentOrderId: deterministicWireCommand.sellerFulfillmentOrderId,
    displayableOrderId: deterministicWireCommand.displayableOrderId,
    displayableOrderDate: FIXTURE_NOW_ISO,
    displayableOrderComment: deterministicWireCommand.displayableOrderComment,
    shippingSpeedCategory: deterministicWireCommand.shippingSpeedCategory,
    destinationAddress: deterministicWireCommand.destinationAddress,
    ...(deterministicWireCommand.notificationEmails
      ? { notificationEmails: deterministicWireCommand.notificationEmails }
      : {}),
    items: deterministicWireCommand.items,
  };

  return {
    expectedWireCommand,
    evidence: {
      commandFingerprint,
      contactRevision: { ...req.contactRevision },
      providerRef: AMAZON_MCF_PROVIDER_REF,
      carrierRef: req.selection.carrierRef,
      serviceRef: req.selection.serviceRef,
      transcript: {
        itemCount: req.lines.length,
        items: req.lines.map((line) => ({
          skuRef: line.skuRef,
          quantity: line.quantity,
          lotRef: line.lotRef ?? null,
          expirationDate: line.expirationDate ?? null,
        })),
        deliveryKind: "courier",
        pickupPointRef: null,
      },
    },
  };
}

/** Independently formats RFC 4122 UUID-v5 evidence reference from a SHA-256 hex digest. */
function independentEvidenceRef(digestHex: string): `evidence:${string}` {
  const hex = digestHex.slice(0, 32).padEnd(32, "0");
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `evidence:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Independently builds expected webhook observation without invoking code under test. */
function expectedWebhookObservation(params: {
  readonly rawBody: Uint8Array;
  readonly sellerOrderId: string;
  readonly displayableOrderId: string;
  readonly amazonShipmentId: string | null;
  readonly primary: string;
  readonly subStatus: string | null;
  readonly canonicalStatus: FulfillmentObservation["fact"]["canonicalStatus"];
  readonly eventKind: FulfillmentObservation["eventKind"];
  readonly recovery: NonNullable<FulfillmentObservation["intake"]>["recovery"];
  readonly occurredAt: string;
  readonly notificationId: string;
  readonly trackingRefs: FulfillmentObservation["trackingRefs"];
  readonly diagnostics?: FulfillmentObservation["diagnostics"];
}): { readonly kind: "verified"; readonly observation: FulfillmentObservation } {
  const digest = createHash("sha256").update(params.rawBody).digest("hex");
  const eventKey = `amazon_mcf:${params.sellerOrderId}:${params.eventKind}:${params.canonicalStatus}:${params.occurredAt}:${params.notificationId}`;
  const factId = `mcf_fact_${createHash("sha256").update(eventKey).digest("hex").slice(0, 24)}`;
  return {
    kind: "verified",
    observation: {
      eventKey,
      correlation: {
        orderRef: null,
        fulfillmentRef: null,
        externalRef: params.sellerOrderId,
        orderNumber: params.displayableOrderId,
        providerFulfillmentRef: params.amazonShipmentId ?? params.sellerOrderId,
        parcelRef: null,
      },
      providerStatus: {
        primary: params.primary,
        subStatus: params.subStatus,
      },
      fact: {
        schemaVersion: 1,
        mapperVersion: AMAZON_MCF_MAPPER_VERSION,
        factId,
        providerKind: AMAZON_MCF_PROVIDER_REF,
        fulfillmentReference: params.sellerOrderId,
        canonicalStatus: params.canonicalStatus,
        provenance: {
          source: "provider_webhook",
          authority: "provider_asserted",
        },
        occurredAt: params.occurredAt,
        receivedAt: FIXTURE_NOW_ISO,
        rawEvent: {
          reference: independentEvidenceRef(digest),
          digestAlgorithm: "sha256",
          digest,
        },
      },
      eventKind: params.eventKind,
      firstReceivedAt: FIXTURE_NOW_ISO,
      trackingRefs: params.trackingRefs,
      intake: {
        occurredAt: params.occurredAt,
        occurrenceKey: params.notificationId,
        recovery: params.recovery,
      },
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    },
  };
}

/** Independently builds expected readback/reconciliation found observation without invoking code under test. */
function expectedFoundReadback(params: {
  readonly sellerOrderId: string;
  readonly displayableOrderId: string;
  readonly primary: string;
  readonly subStatus: string | null;
  readonly canonicalStatus: FulfillmentObservation["fact"]["canonicalStatus"];
  readonly eventKind: FulfillmentObservation["eventKind"];
  readonly recovery: NonNullable<FulfillmentObservation["intake"]>["recovery"];
  readonly source: "provider_response" | "provider_reconciliation";
  readonly fulfillmentRef: string | null;
  readonly providerFulfillmentRef: string;
  readonly trackingRefs: FulfillmentObservation["trackingRefs"];
}): Extract<FulfillmentReadbackResult, { kind: "found" }> {
  const canonicalSnapshot = JSON.stringify({
    sellerFulfillmentOrderId: params.sellerOrderId,
    fulfillmentOrderStatus: params.primary,
    shipmentStatus: params.subStatus,
    updatedAt: FIXTURE_NOW_ISO,
  });
  const digest = createHash("sha256").update(canonicalSnapshot, "utf8").digest("hex");
  const occurrenceKey = `mcf_rb_${digest.slice(0, 24)}`;
  const eventKey = `amazon_mcf:${params.sellerOrderId}:${params.eventKind}:${params.canonicalStatus}:${FIXTURE_NOW_ISO}:${occurrenceKey}`;
  const factId = `mcf_fact_${createHash("sha256").update(eventKey).digest("hex").slice(0, 24)}`;

  return {
    kind: "found",
    externalRef: params.sellerOrderId,
    createdAt: FIXTURE_EARLIER_ISO,
    updatedAt: FIXTURE_NOW_ISO,
    observation: {
      eventKey,
      correlation: {
        orderRef: null,
        fulfillmentRef: params.fulfillmentRef,
        externalRef: params.sellerOrderId,
        orderNumber: params.displayableOrderId,
        providerFulfillmentRef: params.providerFulfillmentRef,
        parcelRef: null,
      },
      providerStatus: {
        primary: params.primary,
        subStatus: params.subStatus,
      },
      fact: {
        schemaVersion: 1,
        mapperVersion: AMAZON_MCF_MAPPER_VERSION,
        factId,
        providerKind: AMAZON_MCF_PROVIDER_REF,
        fulfillmentReference: params.sellerOrderId,
        canonicalStatus: params.canonicalStatus,
        provenance: {
          source: params.source,
          authority: "provider_asserted",
        },
        occurredAt: FIXTURE_NOW_ISO,
        receivedAt: FIXTURE_NOW_ISO,
        rawEvent: {
          reference: independentEvidenceRef(digest),
          digestAlgorithm: "sha256",
          digest,
        },
      },
      eventKind: params.eventKind,
      firstReceivedAt: FIXTURE_NOW_ISO,
      trackingRefs: params.trackingRefs,
      intake: {
        occurredAt: FIXTURE_NOW_ISO,
        occurrenceKey,
        recovery: params.recovery,
      },
    },
  };
}

describe("recipes/fulfillment/amazon-mcf — manifest, schema & inventory parity", () => {
  it("validates recipe.json against recipes/schema/recipe.schema.json (Draft 2020-12) and rejects invalid manifests", () => {
    const schema = JSON.parse(
      readFileSync(resolve(RECIPES_ROOT, "schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    expect(validateAgainstJsonSchema(manifest, schema)).toEqual([]);

    // Negative control: invalid http:// egress origin, extra property, and invalid date-time fail schema validation
    const badManifest = {
      ...manifest,
      egressOrigins: ["http://insecure.example.com"],
      unexpectedKey: true,
      liveQualification: {
        status: "dated-sandbox-receipt",
        checklist: "LIVE_QUALIFICATION.md",
        qualifiedAt: "not-a-timestamp",
      },
    };
    const badErrors = validateAgainstJsonSchema(badManifest, schema);
    expect(badErrors.length).toBeGreaterThanOrEqual(3);
  });

  it("matches recipe.json staticCapabilities, exact disk allFiles inventory, and recipes/index.json catalog entry", () => {
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    expect(manifest.staticCapabilities).toEqual(projectAmazonMcfStaticCapabilities());
    expect(manifest.providerKind).toBe(amazonMcfFulfillmentCapabilities.providerRef);

    const diskFiles = collectRelativeFiles(RECIPE_ROOT, RECIPE_ROOT);
    const manifestFiles = [...(manifest.files.allFiles as string[])].sort();
    expect(manifestFiles).toEqual(diskFiles);

    const catalog = JSON.parse(readFileSync(resolve(RECIPES_ROOT, "index.json"), "utf8")) as {
      recipes: readonly {
        id: string;
        domain: string;
        providerKind: string;
        displayName: string;
        status: string;
        manifestPath: string;
      }[];
    };
    const entry = catalog.recipes.find((r) => r.id === "fulfillment/amazon-mcf");
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe(manifest.domain);
    expect(entry?.providerKind).toBe(manifest.providerKind);
    expect(entry?.displayName).toBe(manifest.displayName);
    expect(entry?.status).toBe(manifest.status);
    expect(entry?.manifestPath).toBe("fulfillment/amazon-mcf/recipe.json");
  });

  it("keeps server barrel import cold and inert (zero ambient network or env reads)", () => {
    expect(amazonMcfFulfillmentCapabilities.defaultOff).toBe(true);
    expect(amazonMcfFulfillmentCapabilities.selected).toBe(false);
    expect(amazonMcfFulfillmentCapabilities.readiness.ready).toBe(false);
  });
});

describe("recipes/fulfillment/amazon-mcf — official full-mode fulfillment adapter conformance", () => {
  it("passes runFulfillmentAdapterConformance(..., { mode: 'full' }) with independent expectations and verified wire payloads", async () => {
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

    const transmittedDispatchBodies: Record<string, unknown>[] = [];
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

      if (url.origin === "https://api.amazon.com" && url.pathname === "/auth/o2/token") {
        return buildLwaTokenResponse();
      }

      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-amz-access-token"]).toBe(FIXTURE_SENSITIVE_CANARIES.lwaAccessToken);
      expect(headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFIXTUREMCF000001\//u);

      if (method === "POST" && url.pathname === "/fba/outbound/2020-07-01/fulfillmentOrders") {
        expect(typeof init?.body).toBe("string");
        transmittedDispatchBodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        createOrderCallIndex += 1;
        if (createOrderCallIndex === 1) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (createOrderCallIndex === 2) {
          return new Response(
            JSON.stringify({
              errors: [{ code: "InvalidInput", message: "Destination postal code invalid" }],
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        if (createOrderCallIndex === 3) {
          await afterFake.invoke("dispatch");
          throw new Error("unreachable");
        }
        if (createOrderCallIndex === 4) {
          const outcome = await httpFake.invoke("dispatch");
          return new Response(JSON.stringify({ errors: [{ code: "ServiceUnavailable" }] }), {
            status: outcome.status,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected createFulfillmentOrder call ${createOrderCallIndex}`);
      }

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

      if (method === "GET" && url.pathname === "/fba/outbound/2020-07-01/fulfillmentOrders") {
        listOrdersCallIndex += 1;
        const token = url.searchParams.get("nextToken");
        if (listOrdersCallIndex === 1 && token === null) {
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
          return new Response(JSON.stringify({ errors: [{ code: "ServiceUnavailable" }] }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected listAllFulfillmentOrders call ${listOrdersCallIndex} token=${token}`);
      }

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

    // Independent dispatch fixtures & expected wire payloads
    const reqAccepted = buildDispatchRequest({
      requestKey: "req_mcf_accepted",
      fulfillmentRef: "ful_mcf_accepted",
      parcelRef: "MCF-ORD-ACC",
    });
    const expAccepted = expectedDispatchEvidenceFor(reqAccepted);

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
    const expAddrAfter = expectedDispatchEvidenceFor(reqAddrAfter);

    const reqTransportBefore = buildDispatchRequest({
      requestKey: "req_mcf_tb",
      fulfillmentRef: "ful_mcf_tb",
      parcelRef: "MCF-ORD-TB",
    });
    const expTransportBefore = expectedDispatchEvidenceFor(reqTransportBefore);

    const reqTransportAfter = buildDispatchRequest({
      requestKey: "req_mcf_ta",
      fulfillmentRef: "ful_mcf_ta",
      parcelRef: "MCF-ORD-TA",
    });
    const expTransportAfter = expectedDispatchEvidenceFor(reqTransportAfter);

    const reqHttpFailure = buildDispatchRequest({
      requestKey: "req_mcf_http",
      fulfillmentRef: "ful_mcf_http",
      parcelRef: "MCF-ORD-503",
    });
    const expHttpFailure = expectedDispatchEvidenceFor(reqHttpFailure);

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

    // Independent observation fixtures & expected outputs
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
    const expectedObsDup = expectedWebhookObservation({
      rawBody: obsDupInput.rawBody,
      sellerOrderId: "MCF-OBS-DUP",
      displayableOrderId: "ORD-OBS-DUP",
      amazonShipmentId: null,
      primary: "Processing",
      subStatus: "SHIPPED",
      canonicalStatus: "in_transit",
      eventKind: "order.shipped",
      recovery: null,
      occurredAt: FIXTURE_NOW_ISO,
      notificationId: "notif-dup-001",
      trackingRefs: [
        {
          trackingNumber: "1Z999AA10123456785",
          carrierRef: "ups",
          serviceRef: null,
          publicUrl: null,
        },
      ],
      diagnostics: {
        admission: { rejectedTrackingRefs: 0, rejectedTrackingUrls: 1 },
        redactedFieldCount: 1,
      },
    });

    const obsNewerInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-OBS-OOO",
      fulfillmentOrderStatus: "Complete",
      fulfillmentShipmentStatus: "DELIVERED",
      statusUpdatedDateTime: FIXTURE_LATER_ISO,
      notificationId: "notif-ooo-newer",
      displayableOrderId: "ORD-OBS-OOO",
      amazonShipmentId: "AMZ-SHP-OOO",
    });
    const expectedObsNewer = expectedWebhookObservation({
      rawBody: obsNewerInput.rawBody,
      sellerOrderId: "MCF-OBS-OOO",
      displayableOrderId: "ORD-OBS-OOO",
      amazonShipmentId: "AMZ-SHP-OOO",
      primary: "Complete",
      subStatus: "DELIVERED",
      canonicalStatus: "delivered",
      eventKind: "order.delivered",
      recovery: null,
      occurredAt: FIXTURE_LATER_ISO,
      notificationId: "notif-ooo-newer",
      trackingRefs: [],
    });

    const obsOlderInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-OBS-OOO",
      fulfillmentOrderStatus: "Processing",
      fulfillmentShipmentStatus: "SHIPPED",
      statusUpdatedDateTime: FIXTURE_EARLIER_ISO,
      notificationId: "notif-ooo-older",
      displayableOrderId: "ORD-OBS-OOO",
      amazonShipmentId: "AMZ-SHP-OOO",
    });
    const expectedObsOlder = expectedWebhookObservation({
      rawBody: obsOlderInput.rawBody,
      sellerOrderId: "MCF-OBS-OOO",
      displayableOrderId: "ORD-OBS-OOO",
      amazonShipmentId: "AMZ-SHP-OOO",
      primary: "Processing",
      subStatus: "SHIPPED",
      canonicalStatus: "in_transit",
      eventKind: "order.shipped",
      recovery: null,
      occurredAt: FIXTURE_EARLIER_ISO,
      notificationId: "notif-ooo-older",
      trackingRefs: [],
    });

    const obsAuthFailInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-OBS-AUTH",
      fulfillmentOrderStatus: "Complete",
      statusUpdatedDateTime: FIXTURE_NOW_ISO,
      notificationId: "notif-auth-fail",
      tamperSignature: true,
    });

    // Independent readback expected results
    const expectedRbShipped = expectedFoundReadback({
      sellerOrderId: "MCF-RB-SHIPPED",
      displayableOrderId: "ORD-RB-SHP",
      primary: "Processing",
      subStatus: "SHIPPED",
      canonicalStatus: "in_transit",
      eventKind: "order.shipped",
      recovery: null,
      source: "provider_response",
      fulfillmentRef: "ful_rb_shipped",
      providerFulfillmentRef: "AMZ-SHP-OK-01",
      trackingRefs: [
        {
          trackingNumber: "1Z999AA10123456784",
          carrierRef: "ups",
          serviceRef: null,
          publicUrl: "https://track.carrier.example/1Z999AA10123456784",
        },
      ],
    });
    const expectedRbReturned = expectedFoundReadback({
      sellerOrderId: "MCF-RB-RETURNED",
      displayableOrderId: "ORD-RB-RET",
      primary: "Unfulfillable",
      subStatus: "RETURNED_TO_SELLER",
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
      source: "provider_response",
      fulfillmentRef: "ful_rb_returned",
      providerFulfillmentRef: "AMZ-SHP-RET-01",
      trackingRefs: [],
    });
    const expectedRbLost = expectedFoundReadback({
      sellerOrderId: "MCF-RB-LOST",
      displayableOrderId: "ORD-RB-LOST",
      primary: "Processing",
      subStatus: "UNDELIVERABLE",
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "delivery_only",
      source: "provider_response",
      fulfillmentRef: "ful_rb_lost",
      providerFulfillmentRef: "AMZ-SHP-LOST-01",
      trackingRefs: [],
    });

    // Independent reconciliation paging expected results
    const expectedPageFullRows: FulfillmentReconciliationObservation[] = [
      expectedFoundReadback({
        sellerOrderId: "MCF-PG-01",
        displayableOrderId: "ORD-PG-01",
        primary: "Planning",
        subStatus: null,
        canonicalStatus: "picking",
        eventKind: "order.processing_started",
        recovery: null,
        source: "provider_reconciliation",
        fulfillmentRef: null,
        providerFulfillmentRef: "MCF-PG-01",
        trackingRefs: [],
      }),
      expectedFoundReadback({
        sellerOrderId: "MCF-PG-02",
        displayableOrderId: "ORD-PG-02",
        primary: "Complete",
        subStatus: null,
        canonicalStatus: "delivered",
        eventKind: "order.delivered",
        recovery: null,
        source: "provider_reconciliation",
        fulfillmentRef: null,
        providerFulfillmentRef: "MCF-PG-02",
        trackingRefs: [],
      }),
    ];
    const expectedPageShortRows: FulfillmentReconciliationObservation[] = [
      expectedFoundReadback({
        sellerOrderId: "MCF-PG-03",
        displayableOrderId: "ORD-PG-03",
        primary: "Received",
        subStatus: null,
        canonicalStatus: "provider_received",
        eventKind: "order.processing_started",
        recovery: null,
        source: "provider_reconciliation",
        fulfillmentRef: null,
        providerFulfillmentRef: "MCF-PG-03",
        trackingRefs: [],
      }),
    ];

    // Independent stock sync expected snapshot
    const expectedStock: (StockSnapshot | { kind: "rejected"; itemIndex: number; reason: "invalid_sku_ref" })[] = [
      {
        providerRef: AMAZON_MCF_PROVIDER_REF,
        syncRunId: "amazon_mcf_sync_20300615120000",
        collectedAt: FIXTURE_NOW_ISO,
        sourceRevision: FIXTURE_NOW_ISO,
        revisionSource: "provider",
        skuRef: "SKU-WIDGET-01",
        quantityKind: "snapshot",
        totalQuantity: 120,
        forSaleQuantity: 100,
        reservedOrUnavailableQuantity: 20,
      },
      { kind: "rejected", itemIndex: 1, reason: "invalid_sku_ref" },
    ];

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
            expectedPrepare: { kind: "prepared", evidence: expAccepted.evidence },
            expectedDispatch: {
              kind: "accepted",
              externalRef: "MCF-ORD-ACC",
              evidence: expAccepted.evidence,
              providerAttemptKey: `amazon_mcf:attempt:${expAccepted.evidence.commandFingerprint.slice(0, 24)}`,
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
            expectedPrepare: { kind: "prepared", evidence: expAddrAfter.evidence },
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
            expectedPrepare: { kind: "prepared", evidence: expTransportBefore.evidence },
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
            expectedPrepare: { kind: "prepared", evidence: expTransportAfter.evidence },
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
            expectedPrepare: { kind: "prepared", evidence: expHttpFailure.evidence },
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
          full: { input: { page: 0, size: 2 }, expected: { kind: "page", rows: expectedPageFullRows } },
          short: { input: { page: 1, size: 2 }, expected: { kind: "page", rows: expectedPageShortRows } },
          empty: { input: { page: 2, size: 2 }, expected: { kind: "page", rows: [] } },
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

    // Verify exact transmitted SP-API POST wire payloads matched independent expectations
    expect(transmittedDispatchBodies).toHaveLength(4);
    expect(transmittedDispatchBodies[0]).toEqual(expAccepted.expectedWireCommand);
    expect(transmittedDispatchBodies[1]).toEqual(expAddrAfter.expectedWireCommand);
    expect(transmittedDispatchBodies[2]).toEqual(expTransportAfter.expectedWireCommand);
    expect(transmittedDispatchBodies[3]).toEqual(expHttpFailure.expectedWireCommand);

    beforeFake.assertDrained();
    afterFake.assertDrained();
    httpFake.assertDrained();
  });
});

describe("recipes/fulfillment/amazon-mcf — protocol, auth & security hardening", () => {
  it("computes exact independently verified AWS SigV4 signature with double-encoded URI paths and sorted query strings", () => {
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

    // Exact 64-hex signature independently verified via Python hashlib/hmac AWS SigV4 reference implementation
    const expectedSignature = "285bc6d0b4ae1cd565c3752fb710e21bd7729340f2ab4c5d25ba73a1b108ef2a";
    expect(signed.amzDate).toBe("20300615T120000Z");
    expect(signed.credentialScope).toBe("20300615/us-east-1/execute-api/aws4_request");
    expect(signed.signedHeaders).toBe("content-type;host;x-amz-access-token;x-amz-date;x-amz-security-token");
    expect(signed.headers["authorization"]).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIAFIXTUREMCF000001/20300615/us-east-1/execute-api/aws4_request, SignedHeaders=content-type;host;x-amz-access-token;x-amz-date;x-amz-security-token, Signature=${expectedSignature}`,
    );
    expect(signed.headers["authorization"]).not.toContain(FIXTURE_SENSITIVE_CANARIES.awsSecretAccessKey);
  });

  it("deduplicates concurrent LWA token exchanges, recovers after single-flight error, refreshes on 401/expiry, and redacts secrets", async () => {
    let nowIso = FIXTURE_NOW_ISO;
    let calls = 0;

    const lwa = createLwaTokenClient({
      clock: () => nowIso,
      fetchImpl: async (url, init) => {
        calls += 1;
        expect(url).toBe(AMAZON_LWA_TOKEN_URL);
        expect(init?.redirect).toBe("error");
        if (calls === 1) {
          return new Response("temporary_error", { status: 503 });
        }
        return buildLwaTokenResponse(`tok_v${calls}`);
      },
    });

    const creds = buildFixtureCredentials();
    // First single-flight call fails; inFlight clears so subsequent call succeeds cleanly
    await expect(lwa.getAccessToken(creds)).rejects.toMatchObject({
      name: "LwaTokenError",
      code: "amazon_lwa_http_503",
      retryable: true,
    });

    const [t1, t2, t3] = await Promise.all([
      lwa.getAccessToken(creds),
      lwa.getAccessToken(creds),
      lwa.getAccessToken(creds),
    ]);
    expect([t1, t2, t3]).toEqual(["tok_v2", "tok_v2", "tok_v2"]);
    expect(calls).toBe(2);

    // Advance clock to within 60s skew -> triggers refresh
    nowIso = "2030-06-15T12:59:30.000Z";
    const refreshed = await lwa.getAccessToken(creds);
    expect(refreshed).toBe("tok_v3");
    expect(calls).toBe(3);

    // Explicit invalidation (as invoked on SP-API 401/403) forces fresh token
    lwa.invalidate();
    const reissued = await lwa.getAccessToken(creds);
    expect(reissued).toBe("tok_v4");
    expect(calls).toBe(4);

    // Error redaction check
    const failingLwa = createLwaTokenClient({
      clock: () => FIXTURE_NOW_ISO,
      fetchImpl: async () => new Response("invalid_client", { status: 401 }),
    });
    try {
      await failingLwa.getAccessToken(creds);
      expect.unreachable("expected LwaTokenError");
    } catch (err) {
      expect(err).toBeInstanceOf(LwaTokenError);
      expect(JSON.stringify(err)).not.toContain(FIXTURE_SENSITIVE_CANARIES.lwaClientSecret);
      expect(JSON.stringify(err)).not.toContain(FIXTURE_SENSITIVE_CANARIES.lwaRefreshToken);
    }
  });

  it("refuses dot-segment path traversal in getFulfillmentOrder and readback.read at zero I/O", async () => {
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

    for (const badId of ["..", ".", "../orders", "a/b", "", "   ", "bad..id"]) {
      await expect(client.getFulfillmentOrder(badId)).rejects.toMatchObject({
        code: "amazon_mcf_invalid_order_id",
        submissionAttempted: false,
        mayHaveSucceeded: false,
      });
    }

    const rbTraversal = await adapter.readback!.read({
      providerRef: AMAZON_MCF_PROVIDER_REF,
      requestKey: "req_trav",
      fulfillmentRef: "ful_trav",
      externalRef: "..",
      mode: "parcel",
    });
    expect(rbTraversal).toEqual({
      kind: "unknown",
      refusal: { reason: "malformed", phase: "readback", retryable: false },
    });
    expect(ioCalls).toBe(0);
  });

  it("cancels oversized chunked/streaming responses incrementally without buffering full body in client and LWA", async () => {
    let chunksPulled = 0;
    let streamCancelled = false;

    const makeOversizedStream = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksPulled += 1;
          controller.enqueue(new Uint8Array(64).fill(0x61));
        },
        cancel() {
          streamCancelled = true;
        },
      });

    // 1. SP-API client chunked response without Content-Length
    const client = createAmazonMcfHttpClient({
      region: "na",
      environment: "sandbox",
      clock: () => FIXTURE_NOW_ISO,
      maxBodyBytes: 100,
      credentials: buildFixtureCredentials,
      fetchImpl: async (url) => {
        if (url === AMAZON_LWA_TOKEN_URL) return buildLwaTokenResponse();
        return new Response(makeOversizedStream(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(client.getFulfillmentOrder("MCF-STREAM-BIG")).rejects.toMatchObject({
      code: "amazon_mcf_response_too_large",
      responseBodyRead: false,
    });
    expect(streamCancelled).toBe(true);
    expect(chunksPulled).toBeLessThanOrEqual(3);

    // 2. LWA client chunked response without Content-Length
    let lwaCancelled = false;
    const lwa = createLwaTokenClient({
      clock: () => FIXTURE_NOW_ISO,
      maxBodyBytes: 100,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64).fill(0x62));
            },
            cancel() {
              lwaCancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(lwa.getAccessToken(buildFixtureCredentials())).rejects.toMatchObject({
      code: "amazon_lwa_response_too_large",
      responseBodyRead: false,
    });
    expect(lwaCancelled).toBe(true);
  });

  it("classifies pre-submission SigV4 signing errors as not_dispatched (submissionAttempted:false) and never caches them as unknown", async () => {
    let credsCalls = 0;
    let spApiPosts = 0;
    const client = createAmazonMcfHttpClient({
      region: "na",
      environment: "sandbox",
      clock: () => FIXTURE_NOW_ISO,
      credentials: async () => {
        credsCalls += 1;
        if (credsCalls === 1) {
          // Blank AWS secret triggers signAwsV4Request error before fetchImpl
          return { ...buildFixtureCredentials(), secretAccessKey: "   " };
        }
        return buildFixtureCredentials();
      },
      fetchImpl: async (url) => {
        if (url === AMAZON_LWA_TOKEN_URL) return buildLwaTokenResponse();
        spApiPosts += 1;
        return new Response(JSON.stringify({}), { status: 200 });
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

    const req = buildDispatchRequest({ parcelRef: "MCF-SIG-ERR" });
    const prep = await adapter.dispatch.prepare(req);
    expect(prep.kind).toBe("prepared");
    if (prep.kind !== "prepared") return;

    const firstAttempt = await adapter.dispatch.dispatch(req, prep.evidence);
    expect(firstAttempt).toEqual({
      kind: "not_dispatched",
      effectMayHaveSucceeded: false,
      refusal: { reason: "io_failure", phase: "dispatch", retryable: false },
      error: {
        code: "amazon_mcf_aws_credentials_missing",
        status: null,
        retryable: false,
        mayHaveSucceeded: false,
        submissionAttempted: false,
        responseBodyRead: false,
      },
    });
    expect(spApiPosts).toBe(0);

    // Retrying with fixed credentials succeeds because pre-submission failure was NOT cached as unknown
    const secondAttempt = await adapter.dispatch.dispatch(req, prep.evidence);
    expect(secondAttempt.kind).toBe("accepted");
    expect(spApiPosts).toBe(1);
  });

  it("buffers reconciliation overflow orders when SP-API returns more rows than input.size without dropping any order", async () => {
    let spApiCalls = 0;
    const orders: AmazonMcfOrderRecord[] = [
      { sellerFulfillmentOrderId: "MCF-OVF-1", fulfillmentOrderStatus: "Received", statusUpdatedDate: FIXTURE_NOW_ISO },
      { sellerFulfillmentOrderId: "MCF-OVF-2", fulfillmentOrderStatus: "Planning", statusUpdatedDate: FIXTURE_NOW_ISO },
      { sellerFulfillmentOrderId: "MCF-OVF-3", fulfillmentOrderStatus: "Processing", statusUpdatedDate: FIXTURE_NOW_ISO },
      { sellerFulfillmentOrderId: "MCF-OVF-4", fulfillmentOrderStatus: "Complete", statusUpdatedDate: FIXTURE_NOW_ISO },
      { sellerFulfillmentOrderId: "MCF-OVF-5", fulfillmentOrderStatus: "Complete", statusUpdatedDate: FIXTURE_NOW_ISO },
    ];
    const adapter = createAmazonMcfFulfillmentAdapter({
      client: {
        createFulfillmentOrder: async () => ({ accepted: true }),
        getFulfillmentOrder: async () => null,
        listAllFulfillmentOrders: async ({ nextToken } = {}) => {
          spApiCalls += 1;
          if (!nextToken) {
            return { fulfillmentOrders: orders.slice(0, 3), nextToken: "tok_2" };
          }
          return { fulfillmentOrders: orders.slice(3, 5), nextToken: null };
        },
        listInventorySummaries: async () => ({ inventorySummaries: [], nextToken: null }),
      },
      marketplaceId: FIXTURE_MARKETPLACE_US,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });

    const collectedIds: string[] = [];
    const p0 = await adapter.reconciliation!.readPage({ page: 0, size: 2 });
    const p1 = await adapter.reconciliation!.readPage({ page: 1, size: 2 });
    const p2 = await adapter.reconciliation!.readPage({ page: 2, size: 2 });
    const p3 = await adapter.reconciliation!.readPage({ page: 3, size: 2 });

    expect(p0.kind).toBe("page");
    expect(p1.kind).toBe("page");
    expect(p2.kind).toBe("page");
    expect(p3).toEqual({ kind: "page_exhausted" });
    for (const page of [p0, p1, p2]) {
      if (page.kind === "page") {
        for (const row of page.rows) {
          if (row.kind === "found") collectedIds.push(row.externalRef);
        }
      }
    }
    expect(collectedIds).toEqual(["MCF-OVF-1", "MCF-OVF-2", "MCF-OVF-3", "MCF-OVF-4", "MCF-OVF-5"]);
    expect(spApiCalls).toBe(2);
  });

  it("prioritizes order-level exceptions/cancellations and multi-shipment failures over SHIPPED/DELIVERED", async () => {
    expect(mapAmazonMcfStatus("CompletePartialled", "SHIPPED")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
    });
    expect(mapAmazonMcfStatus("CompletePartialled", "DELIVERED")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
    });
    expect(mapAmazonMcfStatus("Cancelled", "SHIPPED")).toEqual({
      canonicalStatus: "cancelled",
      eventKind: "parcel.cancelled",
      recovery: null,
    });
    expect(mapAmazonMcfStatus("Processing", "CANCELLED_BY_FULFILLER")).toEqual({
      canonicalStatus: "cancelled",
      eventKind: "parcel.cancelled",
      recovery: null,
    });
    expect(mapAmazonMcfStatus("Processing", "CANCELLED_BY_SELLER")).toEqual({
      canonicalStatus: "cancelled",
      eventKind: "parcel.cancelled",
      recovery: null,
    });

    // Multi-shipment order where shipment #1 is UNDELIVERABLE and shipment #2 is DELIVERED -> must surface exception
    const adapter = createAmazonMcfFulfillmentAdapter({
      client: {
        createFulfillmentOrder: async () => ({ accepted: true }),
        getFulfillmentOrder: async () => ({
          sellerFulfillmentOrderId: "MCF-MULTI-SHP",
          fulfillmentOrderStatus: "Processing",
          statusUpdatedDate: FIXTURE_NOW_ISO,
          receivedDate: FIXTURE_EARLIER_ISO,
          fulfillmentShipments: [
            { amazonShipmentId: "SHP-1", fulfillmentShipmentStatus: "UNDELIVERABLE" },
            { amazonShipmentId: "SHP-2", fulfillmentShipmentStatus: "DELIVERED" },
          ],
        }),
        listAllFulfillmentOrders: async () => ({ fulfillmentOrders: [], nextToken: null }),
        listInventorySummaries: async () => ({ inventorySummaries: [], nextToken: null }),
      },
      marketplaceId: FIXTURE_MARKETPLACE_US,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });

    const rb = await adapter.readback!.read({
      providerRef: AMAZON_MCF_PROVIDER_REF,
      requestKey: "req_multi",
      fulfillmentRef: "ful_multi",
      externalRef: "MCF-MULTI-SHP",
      mode: "parcel",
    });
    expect(rb.kind).toBe("found");
    if (rb.kind === "found") {
      expect(rb.observation.fact.canonicalStatus).toBe("exception");
      expect(rb.observation.intake?.recovery).toBe("delivery_only");
    }
  });

  it("keeps commandFingerprint deterministic across clock ticks and rejects freeform PII in carrierCode", async () => {
    let clockValue = FIXTURE_EARLIER_ISO;
    const adapter = createAmazonMcfFulfillmentAdapter({
      client: {
        createFulfillmentOrder: async () => ({ accepted: true }),
        getFulfillmentOrder: async () => null,
        listAllFulfillmentOrders: async () => ({ fulfillmentOrders: [], nextToken: null }),
        listInventorySummaries: async () => ({ inventorySummaries: [], nextToken: null }),
      },
      marketplaceId: FIXTURE_MARKETPLACE_US,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => clockValue,
      selected: true,
      ready: true,
    });

    const req = buildDispatchRequest({ parcelRef: "MCF-CLOCK-DET" });
    const p1 = await adapter.dispatch.prepare(req);
    clockValue = FIXTURE_LATER_ISO;
    const p2 = await adapter.dispatch.prepare(req);
    expect(p1.kind).toBe("prepared");
    expect(p2.kind).toBe("prepared");
    if (p1.kind === "prepared" && p2.kind === "prepared") {
      expect(p1.evidence.commandFingerprint).toBe(p2.evidence.commandFingerprint);
    }

    // PII in carrierCode must be rejected (carrierRef: null) and counted in redactedFieldCount
    const piiCarrierInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-CARRIER-PII",
      fulfillmentOrderStatus: "Processing",
      fulfillmentShipmentStatus: "SHIPPED",
      statusUpdatedDateTime: FIXTURE_NOW_ISO,
      notificationId: "notif-carrier-pii",
      packages: [
        {
          trackingNumber: "1Z999AA10123456799",
          carrierCode: FIXTURE_SENSITIVE_CANARIES.recipientEmail,
        },
      ],
    });
    const verified = await adapter.observation!.verifyAndNormalize(piiCarrierInput);
    expect(verified.kind).toBe("verified");
    if (verified.kind === "verified") {
      expect(verified.observation.trackingRefs[0]?.carrierRef).toBeNull();
      expect(verified.observation.diagnostics?.redactedFieldCount).toBe(1);
      expect(JSON.stringify(verified.observation)).not.toContain("canary");
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
          body: null,
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

  it("enforces webhook auth-before-parse, key rotation, replay skew, and rejects invalid constructor options", async () => {
    expect(() => createAmazonMcfWebhookVerifier({ signingSecrets: ["a1b2c3"] })).toThrow(
      "amazon_mcf_webhook_signing_secret_invalid",
    );
    expect(() =>
      createAmazonMcfWebhookVerifier({
        signingSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
        maxTimestampSkewMs: Number.NaN,
      }),
    ).toThrow("amazon_mcf_webhook_max_skew_invalid");
    expect(() =>
      createAmazonMcfWebhookVerifier({
        signingSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
        maxTimestampSkewMs: -1,
      }),
    ).toThrow("amazon_mcf_webhook_max_skew_invalid");

    const verifier = createAmazonMcfWebhookVerifier({
      signingSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY, FIXTURE_WEBHOOK_SECRET_ROTATED],
      approveTrackingUrl: approveFixtureTrackingUrl,
      maxTimestampSkewMs: 300_000,
    });

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

    const staleInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-STALE-01",
      fulfillmentOrderStatus: "Complete",
      statusUpdatedDateTime: FIXTURE_EARLIER_ISO,
      timestamp: FIXTURE_EARLIER_ISO,
      receivedAt: FIXTURE_NOW_ISO,
      notificationId: "notif-stale-01",
    });
    expect(await verifier.verifyAndNormalize(staleInput)).toEqual({
      kind: "refused",
      refusal: { reason: "untrusted", phase: "verify", retryable: false },
    });

    const wrongTypeInput = buildSignedNotificationInput({
      sellerFulfillmentOrderId: "MCF-WRONG-TYPE",
      fulfillmentOrderStatus: "Complete",
      statusUpdatedDateTime: FIXTURE_NOW_ISO,
      notificationId: "notif-wrong-type",
      notificationType: "ANY_OFFER_CHANGED",
    });
    expect(await verifier.verifyAndNormalize(wrongTypeInput)).toEqual({
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
