import { createHash, createHmac } from "node:crypto";
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
  SHIPBOB_MAPPER_VERSION,
  SHIPBOB_ORIGINS,
  SHIPBOB_PROVIDER_REF,
  ShipBobTransportError,
  computeStandardWebhookSignature,
  createShipBobFulfillmentAdapter,
  createShipBobHttpClient,
  createShipBobWebhookVerifier,
  mapShipBobStatus,
  projectShipBobStaticCapabilities,
  resolvePinnedShipBobOrigin,
  shipbobFulfillmentCapabilities,
  type FetchLike,
  type ShipBobOrderRecord,
} from "../server/index.js";
import {
  FIXTURE_CHANNEL_ID,
  FIXTURE_EARLIER_ISO,
  FIXTURE_LATER_ISO,
  FIXTURE_NOW_ISO,
  FIXTURE_SENSITIVE_CANARIES,
  FIXTURE_WEBHOOK_SECRET_PRIMARY,
  FIXTURE_WEBHOOK_SECRET_ROTATED,
  approveFixtureTrackingUrl,
  buildDispatchRequest,
  buildShipBobInventoryPayload,
  buildShipBobOrderPayload,
  buildSignedShipBobWebhookInput,
  toEpochSecondsString,
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

/** Independently builds the deterministic ShipBob POST /1.0/order wire payload & SHA-256 fingerprint. */
function expectedDispatchEvidenceFor(req: FulfillmentDispatchRequest): {
  readonly expectedWireCommand: Record<string, unknown>;
  readonly evidence: DispatchEvidence;
} {
  const referenceId = (req.parcelRef ?? req.fulfillmentRef).trim();
  const expectedWireCommand = {
    reference_id: referenceId,
    order_number: req.orderNumber ?? req.orderRef,
    shipping_method: req.selection.serviceRef ?? "Standard",
    recipient: {
      name: req.recipient.name,
      address: {
        address1: req.recipient.line1,
        ...(req.recipient.line2 ? { address2: req.recipient.line2 } : {}),
        city: req.recipient.city,
        zip_code: req.recipient.postalCode,
        country: req.recipient.country,
      },
      ...(req.recipient.email ? { email: req.recipient.email } : {}),
      ...(req.recipient.phone ? { phone_number: req.recipient.phone } : {}),
    },
    products: req.lines.map((line) => ({
      reference_id: line.skuRef,
      quantity: line.quantity,
    })),
  };

  const commandFingerprint = createHash("sha256")
    .update(JSON.stringify(expectedWireCommand), "utf8")
    .digest("hex");

  return {
    expectedWireCommand,
    evidence: {
      commandFingerprint,
      contactRevision: { ...req.contactRevision },
      providerRef: SHIPBOB_PROVIDER_REF,
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
  readonly externalRef: string;
  readonly orderNumber: string | null;
  readonly providerFulfillmentRef: string;
  readonly parcelRef: string | null;
  readonly primary: string;
  readonly subStatus: string | null;
  readonly canonicalStatus: FulfillmentObservation["fact"]["canonicalStatus"];
  readonly eventKind: FulfillmentObservation["eventKind"];
  readonly recovery: NonNullable<FulfillmentObservation["intake"]>["recovery"];
  readonly occurredAt: string;
  readonly webhookId: string;
  readonly trackingRefs: FulfillmentObservation["trackingRefs"];
  readonly diagnostics?: FulfillmentObservation["diagnostics"];
}): { readonly kind: "verified"; readonly observation: FulfillmentObservation } {
  const digest = createHash("sha256").update(params.rawBody).digest("hex");
  const eventKey = `shipbob:${params.externalRef}:${params.eventKind}:${params.canonicalStatus}:${params.occurredAt}:${params.webhookId}`;
  const factId = `sb_fact_${createHash("sha256").update(eventKey).digest("hex").slice(0, 24)}`;
  return {
    kind: "verified",
    observation: {
      eventKey,
      correlation: {
        orderRef: null,
        fulfillmentRef: null,
        externalRef: params.externalRef,
        orderNumber: params.orderNumber,
        providerFulfillmentRef: params.providerFulfillmentRef,
        parcelRef: params.parcelRef,
      },
      providerStatus: {
        primary: params.primary,
        subStatus: params.subStatus,
      },
      fact: {
        schemaVersion: 1,
        mapperVersion: SHIPBOB_MAPPER_VERSION,
        factId,
        providerKind: SHIPBOB_PROVIDER_REF,
        fulfillmentReference: params.externalRef,
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
        occurrenceKey: params.webhookId,
        recovery: params.recovery,
      },
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    },
  };
}

/** Independently builds expected readback/reconciliation found observation without invoking code under test. */
function expectedFoundReadback(params: {
  readonly externalRef: string;
  readonly orderId: number | null;
  readonly referenceId: string | null;
  readonly orderNumber: string | null;
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
    id: params.orderId,
    reference_id: params.referenceId,
    status: params.primary,
    shipmentStatus: params.subStatus,
    updatedAt: FIXTURE_NOW_ISO,
  });
  const digest = createHash("sha256").update(canonicalSnapshot, "utf8").digest("hex");
  const occurrenceKey = `sb_rb_${digest.slice(0, 24)}`;
  const eventKey = `shipbob:${params.externalRef}:${params.eventKind}:${params.canonicalStatus}:${FIXTURE_NOW_ISO}:${occurrenceKey}`;
  const factId = `sb_fact_${createHash("sha256").update(eventKey).digest("hex").slice(0, 24)}`;

  return {
    kind: "found",
    externalRef: params.externalRef,
    createdAt: FIXTURE_EARLIER_ISO,
    updatedAt: FIXTURE_NOW_ISO,
    observation: {
      eventKey,
      correlation: {
        orderRef: null,
        fulfillmentRef: params.fulfillmentRef,
        externalRef: params.externalRef,
        orderNumber: params.orderNumber,
        providerFulfillmentRef: params.providerFulfillmentRef,
        parcelRef: params.referenceId,
      },
      providerStatus: {
        primary: params.primary,
        subStatus: params.subStatus,
      },
      fact: {
        schemaVersion: 1,
        mapperVersion: SHIPBOB_MAPPER_VERSION,
        factId,
        providerKind: SHIPBOB_PROVIDER_REF,
        fulfillmentReference: params.externalRef,
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

describe("recipes/fulfillment/shipbob — manifest, schema & inventory parity", () => {
  it("validates recipe.json against recipes/schema/recipe.schema.json (Draft 2020-12) and rejects invalid manifests", () => {
    const schema = JSON.parse(
      readFileSync(resolve(RECIPES_ROOT, "schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    expect(validateAgainstJsonSchema(manifest, schema)).toEqual([]);

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
    expect(manifest.staticCapabilities).toEqual(projectShipBobStaticCapabilities());
    expect(manifest.providerKind).toBe(shipbobFulfillmentCapabilities.providerRef);
    expect(manifest.summary.length).toBeLessThanOrEqual(240);

    const diskFiles = collectRelativeFiles(RECIPE_ROOT, RECIPE_ROOT);
    const manifestFiles = [...(manifest.files.allFiles as string[])];
    expect(manifestFiles).toEqual([...manifestFiles].sort());
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
    const entry = catalog.recipes.find((r) => r.id === "fulfillment/shipbob");
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe(manifest.domain);
    expect(entry?.providerKind).toBe(manifest.providerKind);
    expect(entry?.displayName).toBe(manifest.displayName);
    expect(entry?.status).toBe(manifest.status);
    expect(entry?.manifestPath).toBe("fulfillment/shipbob/recipe.json");
  });

  it("keeps server barrel import cold and inert (zero ambient network or env reads)", () => {
    expect(shipbobFulfillmentCapabilities.defaultOff).toBe(true);
    expect(shipbobFulfillmentCapabilities.selected).toBe(false);
    expect(shipbobFulfillmentCapabilities.readiness.ready).toBe(false);
    expect(shipbobFulfillmentCapabilities.operations.cancel).toEqual({
      supported: false,
      reason: "not_exposed",
    });
  });
});

describe("recipes/fulfillment/shipbob — official full-mode fulfillment adapter conformance", () => {
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
    let tokenCallIndex = 0;
    let listOrdersCallIndex = 0;
    let inventoryCallIndex = 0;

    const orderReturned: ShipBobOrderRecord = {
      id: 200201,
      reference_id: "SB-RB-RETURNED",
      order_number: "ORD-RB-RET",
      status: "Exception",
      last_updated_at: FIXTURE_NOW_ISO,
      created_date: FIXTURE_EARLIER_ISO,
      shipments: [
        {
          id: "700201",
          status: "Returned",
          last_updated_at: FIXTURE_EARLIER_ISO,
        },
      ],
    };

    const orderLostCoarse: ShipBobOrderRecord = {
      id: 200202,
      reference_id: "SB-RB-LOST",
      order_number: "ORD-RB-LOST",
      status: "Processing",
      last_updated_at: FIXTURE_NOW_ISO,
      created_date: FIXTURE_EARLIER_ISO,
      shipments: [
        {
          id: "700202",
          status: "DeliveryException",
          last_updated_at: FIXTURE_EARLIER_ISO,
        },
      ],
    };

    const orderFoundShipped: ShipBobOrderRecord = {
      id: 200203,
      reference_id: "SB-RB-SHIPPED",
      order_number: "ORD-RB-SHP",
      status: "Processing",
      last_updated_at: FIXTURE_NOW_ISO,
      created_date: FIXTURE_EARLIER_ISO,
      shipments: [
        {
          id: "700203",
          status: "InTransit",
          last_updated_at: FIXTURE_NOW_ISO,
          tracking: {
            tracking_number: "1Z999AA10123456784",
            carrier: "UPS",
            tracking_url: "https://track.carrier.example/1Z999AA10123456784",
          },
        },
      ],
    };

    const orderFoundByRef: ShipBobOrderRecord = {
      id: 200204,
      reference_id: "SB-RB-BYREF",
      order_number: "ORD-RB-REF",
      status: "Completed",
      last_updated_at: FIXTURE_NOW_ISO,
      created_date: FIXTURE_EARLIER_ISO,
    };

    const pageRowA: ShipBobOrderRecord = {
      id: 300101,
      reference_id: "SB-PG-01",
      order_number: "ORD-PG-01",
      status: "Picked",
      last_updated_at: FIXTURE_NOW_ISO,
      created_date: FIXTURE_EARLIER_ISO,
    };
    const pageRowB: ShipBobOrderRecord = {
      id: 300102,
      reference_id: "SB-PG-02",
      order_number: "ORD-PG-02",
      status: "Completed",
      last_updated_at: FIXTURE_NOW_ISO,
      created_date: FIXTURE_EARLIER_ISO,
    };
    const pageRowC: ShipBobOrderRecord = {
      id: 300103,
      reference_id: "SB-PG-03",
      order_number: "ORD-PG-03",
      status: "Processing",
      last_updated_at: FIXTURE_NOW_ISO,
      created_date: FIXTURE_EARLIER_ISO,
    };

    const fetchImpl: FetchLike = async (urlString, init) => {
      ioCount += 1;
      const url = new URL(urlString);
      const method = (init?.method ?? "GET").toUpperCase();
      expect(url.origin).toBe(SHIPBOB_ORIGINS.sandbox);
      expect(init?.redirect).toBe("error");

      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["authorization"]).toBe(`Bearer ${FIXTURE_SENSITIVE_CANARIES.patToken}`);
      expect(headers["shipbob_channel_id"]).toBe(FIXTURE_CHANNEL_ID);

      if (method === "POST" && url.pathname === "/1.0/order") {
        expect(typeof init?.body).toBe("string");
        const parsedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        transmittedDispatchBodies.push(parsedBody);
        createOrderCallIndex += 1;
        if (createOrderCallIndex === 1) {
          return new Response(
            JSON.stringify({
              id: 900101,
              reference_id: parsedBody["reference_id"],
              status: "Processing",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (createOrderCallIndex === 2) {
          return new Response(
            JSON.stringify({ message: "Invalid zip_code for destination address" }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        }
        if (createOrderCallIndex === 3) {
          await afterFake.invoke("dispatch");
          throw new Error("unreachable");
        }
        if (createOrderCallIndex === 4) {
          const outcome = await httpFake.invoke("dispatch");
          return new Response("upstream unavailable", {
            status: outcome.status,
            headers: { "content-type": "text/plain" },
          });
        }
        throw new Error(`unexpected createOrder call ${createOrderCallIndex}`);
      }

      if (method === "GET" && url.pathname.startsWith("/1.0/order/")) {
        const orderId = decodeURIComponent(url.pathname.slice("/1.0/order/".length));
        if (orderId === "200203") {
          return new Response(JSON.stringify(buildShipBobOrderPayload(orderFoundShipped)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (orderId === "200201") {
          return new Response(JSON.stringify(buildShipBobOrderPayload(orderReturned)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (orderId === "200202") {
          return new Response(JSON.stringify(buildShipBobOrderPayload(orderLostCoarse)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (orderId === "999404") {
          return new Response(JSON.stringify({ message: "Not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if (orderId === "999503") {
          return new Response(JSON.stringify({ message: "Service unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected getOrder id ${orderId}`);
      }

      if (method === "GET" && url.pathname === "/1.0/order" && url.searchParams.has("ReferenceIds")) {
        const refId = url.searchParams.get("ReferenceIds");
        if (refId === "SB-RB-BYREF") {
          return new Response(JSON.stringify([buildShipBobOrderPayload(orderFoundByRef)]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "GET" && url.pathname === "/1.0/order") {
        listOrdersCallIndex += 1;
        const page = Number(url.searchParams.get("Page"));
        const limit = Number(url.searchParams.get("Limit"));
        expect(limit).toBe(2);

        if (listOrdersCallIndex === 1 && page === 1) {
          return new Response(
            JSON.stringify([buildShipBobOrderPayload(pageRowA), buildShipBobOrderPayload(pageRowB)]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (listOrdersCallIndex === 2 && page === 2) {
          return new Response(JSON.stringify([buildShipBobOrderPayload(pageRowC)]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (listOrdersCallIndex === 3 && page === 3) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (listOrdersCallIndex === 4 && page === 1) {
          return new Response(JSON.stringify({ message: "Service unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected listOrders call ${listOrdersCallIndex} page=${page}`);
      }

      if (method === "GET" && url.pathname === "/1.0/inventory") {
        inventoryCallIndex += 1;
        if (inventoryCallIndex === 1 || inventoryCallIndex === 2) {
          return new Response(
            JSON.stringify(
              buildShipBobInventoryPayload([
                {
                  sku: "SKU-WIDGET-01",
                  total_on_hand_quantity: 120,
                  total_fulfillable_quantity: 100,
                  total_committed_quantity: 15,
                  total_awaiting_quantity: 5,
                  last_updated_date: FIXTURE_NOW_ISO,
                },
                {
                  sku: "bad sku with spaces!",
                  total_on_hand_quantity: 5,
                  total_fulfillable_quantity: 5,
                  total_committed_quantity: 0,
                  total_awaiting_quantity: 0,
                  last_updated_date: null,
                },
              ]),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (inventoryCallIndex === 3) {
          return new Response(JSON.stringify({ message: "Service unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected listInventory call ${inventoryCallIndex}`);
      }

      throw new Error(`unexpected request: ${method} ${urlString}`);
    };

    const client = createShipBobHttpClient({
      environment: "sandbox",
      channelId: FIXTURE_CHANNEL_ID,
      fetchImpl,
      token: async () => {
        tokenCallIndex += 1;
        if (tokenCallIndex === 3) {
          await beforeFake.invoke("dispatch");
        }
        return FIXTURE_SENSITIVE_CANARIES.patToken;
      },
    });

    const adapter = createShipBobFulfillmentAdapter({
      client,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
      approveTrackingUrl: approveFixtureTrackingUrl,
    });

    // Independent dispatch fixtures
    const reqAccepted = buildDispatchRequest({
      requestKey: "req_sb_accepted",
      fulfillmentRef: "ful_sb_accepted",
      parcelRef: "SB-ORD-ACC",
    });
    const expAccepted = expectedDispatchEvidenceFor(reqAccepted);

    const reqAddrBefore = buildDispatchRequest({
      requestKey: "req_sb_addr_before",
      fulfillmentRef: "ful_sb_addr_before",
      parcelRef: "SB-ORD-AB",
      recipientOverrides: { line1: "   " },
    });

    const reqAddrAfter = buildDispatchRequest({
      requestKey: "req_sb_addr_after",
      fulfillmentRef: "ful_sb_addr_after",
      parcelRef: "SB-ORD-AA",
    });
    const expAddrAfter = expectedDispatchEvidenceFor(reqAddrAfter);

    const reqTransportBefore = buildDispatchRequest({
      requestKey: "req_sb_tb",
      fulfillmentRef: "ful_sb_tb",
      parcelRef: "SB-ORD-TB",
    });
    const expTransportBefore = expectedDispatchEvidenceFor(reqTransportBefore);

    const reqTransportAfter = buildDispatchRequest({
      requestKey: "req_sb_ta",
      fulfillmentRef: "ful_sb_ta",
      parcelRef: "SB-ORD-TA",
    });
    const expTransportAfter = expectedDispatchEvidenceFor(reqTransportAfter);

    const reqHttpFailure = buildDispatchRequest({
      requestKey: "req_sb_http",
      fulfillmentRef: "ful_sb_http",
      parcelRef: "SB-ORD-503",
    });
    const expHttpFailure = expectedDispatchEvidenceFor(reqHttpFailure);

    const reqPickupPoint = buildDispatchRequest({
      requestKey: "req_sb_locker",
      fulfillmentRef: "ful_sb_locker",
      parcelRef: "SB-ORD-LCK",
      selectionOverrides: {
        deliveryKind: "parcel-locker",
        pickupPoint: {
          id: "LOCKER-01",
          provider: "locker_net",
          name: "Downtown Locker",
          address: { line1: "100 Main St", postalCode: "60601", city: "Chicago", country: "US" },
        },
      },
    });

    // Independent observation fixtures
    const obsDupInput = buildSignedShipBobWebhookInput({
      webhookId: "msg_dup_001",
      topic: "order_shipped",
      orderId: 800001,
      referenceId: "SB-OBS-DUP",
      orderNumber: "ORD-OBS-DUP",
      status: "Processing",
      shipmentStatus: "LabeledCreated",
      shipmentId: "SHP-DUP-01",
      lastUpdatedAt: FIXTURE_NOW_ISO,
      tracking: {
        tracking_number: "1Z999AA10123456785",
        carrier: "UPS",
        tracking_url: `https://track.carrier.example/1Z999AA10123456785?signature=${FIXTURE_SENSITIVE_CANARIES.signedTrackingToken}`,
      },
    });
    const expectedObsDup = expectedWebhookObservation({
      rawBody: obsDupInput.rawBody,
      externalRef: "800001",
      orderNumber: "ORD-OBS-DUP",
      providerFulfillmentRef: "SHP-DUP-01",
      parcelRef: "SB-OBS-DUP",
      primary: "Processing",
      subStatus: "LabeledCreated",
      canonicalStatus: "in_transit",
      eventKind: "order.shipped",
      recovery: null,
      occurredAt: FIXTURE_NOW_ISO,
      webhookId: "msg_dup_001",
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

    const obsNewerInput = buildSignedShipBobWebhookInput({
      webhookId: "msg_ooo_newer",
      topic: "order_shipment_delivered",
      orderId: 800002,
      referenceId: "SB-OBS-OOO",
      orderNumber: "ORD-OBS-OOO",
      status: "Completed",
      shipmentStatus: "Delivered",
      shipmentId: "SHP-OOO-01",
      lastUpdatedAt: FIXTURE_LATER_ISO,
    });
    const expectedObsNewer = expectedWebhookObservation({
      rawBody: obsNewerInput.rawBody,
      externalRef: "800002",
      orderNumber: "ORD-OBS-OOO",
      providerFulfillmentRef: "SHP-OOO-01",
      parcelRef: "SB-OBS-OOO",
      primary: "Completed",
      subStatus: "Delivered",
      canonicalStatus: "delivered",
      eventKind: "order.delivered",
      recovery: null,
      occurredAt: FIXTURE_LATER_ISO,
      webhookId: "msg_ooo_newer",
      trackingRefs: [],
    });

    const obsOlderInput = buildSignedShipBobWebhookInput({
      webhookId: "msg_ooo_older",
      topic: "order_shipped",
      orderId: 800002,
      referenceId: "SB-OBS-OOO",
      orderNumber: "ORD-OBS-OOO",
      status: "Processing",
      shipmentStatus: "InTransit",
      shipmentId: "SHP-OOO-01",
      lastUpdatedAt: FIXTURE_EARLIER_ISO,
    });
    const expectedObsOlder = expectedWebhookObservation({
      rawBody: obsOlderInput.rawBody,
      externalRef: "800002",
      orderNumber: "ORD-OBS-OOO",
      providerFulfillmentRef: "SHP-OOO-01",
      parcelRef: "SB-OBS-OOO",
      primary: "Processing",
      subStatus: "InTransit",
      canonicalStatus: "in_transit",
      eventKind: "order.shipped",
      recovery: null,
      occurredAt: FIXTURE_EARLIER_ISO,
      webhookId: "msg_ooo_older",
      trackingRefs: [],
    });

    const obsAuthFailInput = buildSignedShipBobWebhookInput({
      webhookId: "msg_auth_fail",
      topic: "order_shipment_delivered",
      orderId: 800003,
      status: "Completed",
      lastUpdatedAt: FIXTURE_NOW_ISO,
      tamperSignature: true,
    });

    // Independent readback expected results
    const expectedRbShipped = expectedFoundReadback({
      externalRef: "200203",
      orderId: 200203,
      referenceId: "SB-RB-SHIPPED",
      orderNumber: "ORD-RB-SHP",
      primary: "Processing",
      subStatus: "InTransit",
      canonicalStatus: "in_transit",
      eventKind: "order.shipped",
      recovery: null,
      source: "provider_response",
      fulfillmentRef: "ful_rb_shipped",
      providerFulfillmentRef: "700203",
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
      externalRef: "200201",
      orderId: 200201,
      referenceId: "SB-RB-RETURNED",
      orderNumber: "ORD-RB-RET",
      primary: "Exception",
      subStatus: "Returned",
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
      source: "provider_response",
      fulfillmentRef: "ful_rb_returned",
      providerFulfillmentRef: "700201",
      trackingRefs: [],
    });
    const expectedRbLost = expectedFoundReadback({
      externalRef: "200202",
      orderId: 200202,
      referenceId: "SB-RB-LOST",
      orderNumber: "ORD-RB-LOST",
      primary: "Processing",
      subStatus: "DeliveryException",
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "delivery_only",
      source: "provider_response",
      fulfillmentRef: "ful_rb_lost",
      providerFulfillmentRef: "700202",
      trackingRefs: [],
    });
    const expectedRbByRef = expectedFoundReadback({
      externalRef: "SB-RB-BYREF",
      orderId: 200204,
      referenceId: "SB-RB-BYREF",
      orderNumber: "ORD-RB-REF",
      primary: "Completed",
      subStatus: null,
      canonicalStatus: "in_transit",
      eventKind: "order.shipped",
      recovery: null,
      source: "provider_response",
      fulfillmentRef: "ful_rb_byref",
      providerFulfillmentRef: "200204",
      trackingRefs: [],
    });

    // Independent reconciliation paging expected results
    const expectedPageFullRows: FulfillmentReconciliationObservation[] = [
      expectedFoundReadback({
        externalRef: "300101",
        orderId: 300101,
        referenceId: "SB-PG-01",
        orderNumber: "ORD-PG-01",
        primary: "Picked",
        subStatus: null,
        canonicalStatus: "picking",
        eventKind: "order.processing_started",
        recovery: null,
        source: "provider_reconciliation",
        fulfillmentRef: null,
        providerFulfillmentRef: "300101",
        trackingRefs: [],
      }),
      expectedFoundReadback({
        externalRef: "300102",
        orderId: 300102,
        referenceId: "SB-PG-02",
        orderNumber: "ORD-PG-02",
        primary: "Completed",
        subStatus: null,
        canonicalStatus: "in_transit",
        eventKind: "order.shipped",
        recovery: null,
        source: "provider_reconciliation",
        fulfillmentRef: null,
        providerFulfillmentRef: "300102",
        trackingRefs: [],
      }),
    ];
    const expectedPageShortRows: FulfillmentReconciliationObservation[] = [
      expectedFoundReadback({
        externalRef: "300103",
        orderId: 300103,
        referenceId: "SB-PG-03",
        orderNumber: "ORD-PG-03",
        primary: "Processing",
        subStatus: null,
        canonicalStatus: "provider_received",
        eventKind: "order.processing_started",
        recovery: null,
        source: "provider_reconciliation",
        fulfillmentRef: null,
        providerFulfillmentRef: "300103",
        trackingRefs: [],
      }),
    ];

    const expectedStock: (StockSnapshot | { kind: "rejected"; itemIndex: number; reason: "invalid_sku_ref" })[] = [
      {
        providerRef: SHIPBOB_PROVIDER_REF,
        syncRunId: "shipbob_sync_20300615120000",
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
      subjectId: "recipe:fulfillment/shipbob",
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
              externalRef: "900101",
              evidence: expAccepted.evidence,
              providerAttemptKey: `shipbob:attempt:${expAccepted.evidence.commandFingerprint.slice(0, 24)}`,
              labelKey: "shipbob:receipt:900101",
              receiptKey: "shipbob:receipt:900101",
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
                code: "shipbob_http_422",
                status: 422,
                retryable: false,
                mayHaveSucceeded: false,
                submissionAttempted: true,
                responseBodyRead: false,
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
                code: "shipbob_transport_before_submission",
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
                code: "shipbob_transport_error",
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
                code: "shipbob_http_503",
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
              input: [{ objectRef: "obj_001", mediaType: "application/pdf", externalRef: "900101" }],
              expected: {
                kind: "refused",
                refusal: { reason: "unsupported", phase: "dispatch", retryable: false },
              },
            },
          ],
          void: [
            {
              input: [{ parcelRef: "900101", document: null }],
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
                providerRef: SHIPBOB_PROVIDER_REF,
                requestKey: "req_rb_shipped",
                fulfillmentRef: "ful_rb_shipped",
                externalRef: "200203",
                mode: "parcel",
              },
            ],
            expected: expectedRbShipped,
          },
          {
            input: [
              {
                providerRef: SHIPBOB_PROVIDER_REF,
                requestKey: "req_rb_returned",
                fulfillmentRef: "ful_rb_returned",
                externalRef: "200201",
                mode: "parcel",
              },
            ],
            expected: expectedRbReturned,
          },
          {
            input: [
              {
                providerRef: SHIPBOB_PROVIDER_REF,
                requestKey: "req_rb_lost",
                fulfillmentRef: "ful_rb_lost",
                externalRef: "200202",
                mode: "parcel",
              },
            ],
            expected: expectedRbLost,
          },
          {
            input: [
              {
                providerRef: SHIPBOB_PROVIDER_REF,
                requestKey: "req_rb_byref",
                fulfillmentRef: "ful_rb_byref",
                externalRef: "SB-RB-BYREF",
                mode: "parcel",
              },
            ],
            expected: expectedRbByRef,
          },
          {
            input: [
              {
                providerRef: SHIPBOB_PROVIDER_REF,
                requestKey: "req_rb_missing",
                fulfillmentRef: "ful_rb_missing",
                externalRef: "999404",
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
                providerRef: SHIPBOB_PROVIDER_REF,
                requestKey: "req_rb_error",
                fulfillmentRef: "ful_rb_error",
                externalRef: "999503",
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
                code: "shipbob_http_503",
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
      { subjectId: "recipe:fulfillment/shipbob", providerRef: SHIPBOB_PROVIDER_REF },
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
    expect(qual.ledger.length).toBeGreaterThan(0);

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

describe("recipes/fulfillment/shipbob — protocol, Standard Webhooks & security hardening", () => {
  it("verifies Standard Webhooks whsec_ rotation, multi-sig headers, timestamp skew, single-byte tamper, and auth-before-parse", async () => {
    expect(() =>
      createShipBobWebhookVerifier({ webhookSigningSecrets: ["not_whsec_secret"] }),
    ).toThrow("shipbob_webhook_signing_secret_invalid");
    expect(() =>
      createShipBobWebhookVerifier({
        webhookSigningSecrets: ["whsec_" + Buffer.from("short", "utf8").toString("base64")],
      }),
    ).toThrow("shipbob_webhook_signing_secret_invalid");
    expect(() =>
      createShipBobWebhookVerifier({ webhookSigningSecrets: ["whsec_not*valid*base64"] }),
    ).toThrow("shipbob_webhook_signing_secret_invalid");
    expect(() =>
      createShipBobWebhookVerifier({
        webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
        maxTimestampSkewMs: Number.NaN,
      }),
    ).toThrow("shipbob_webhook_max_skew_invalid");
    expect(() =>
      createShipBobWebhookVerifier({
        webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
        maxTimestampSkewMs: -1,
      }),
    ).toThrow("shipbob_webhook_max_skew_invalid");

    const verifier = createShipBobWebhookVerifier({
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY, FIXTURE_WEBHOOK_SECRET_ROTATED],
      approveTrackingUrl: approveFixtureTrackingUrl,
      maxTimestampSkewMs: 600_000,
    });

    // Multi-sig header (first invalid, second valid with rotated key)
    const rotatedMultiSigInput = buildSignedShipBobWebhookInput({
      webhookId: "msg_rot_01",
      topic: "order_shipment_delivered",
      orderId: 500001,
      status: "Completed",
      shipmentStatus: "Delivered",
      lastUpdatedAt: FIXTURE_NOW_ISO,
      secretWhsec: FIXTURE_WEBHOOK_SECRET_ROTATED,
      extraInvalidSignature: true,
    });
    const rotatedResult = await verifier.verifyAndNormalize(rotatedMultiSigInput);
    expect(rotatedResult.kind).toBe("verified");
    if (rotatedResult.kind === "verified") {
      expect(rotatedResult.observation.fact.mapperVersion).toBe(SHIPBOB_MAPPER_VERSION);
      expect(rotatedResult.observation.fact.canonicalStatus).toBe("delivered");
    }

    // Single-byte body tamper negative control must fail auth before normalize
    const tamperedBody = new Uint8Array(rotatedMultiSigInput.rawBody);
    const braceIdx = tamperedBody.indexOf(0x35); // '5' in 500001
    expect(braceIdx).toBeGreaterThan(-1);
    tamperedBody[braceIdx] = 0x36; // '6'
    expect(
      await verifier.verifyAndNormalize({
        ...rotatedMultiSigInput,
        rawBody: tamperedBody,
      }),
    ).toEqual({
      kind: "refused",
      refusal: { reason: "untrusted", phase: "verify", retryable: false },
    });

    // Auth-before-parse: malformed JSON with invalid signature refuses as untrusted, not malformed
    expect(
      await verifier.verifyAndNormalize({
        rawBody: new TextEncoder().encode("{not-json"),
        headers: {
          "webhook-id": "msg_bad_json",
          "webhook-timestamp": toEpochSecondsString(FIXTURE_NOW_ISO),
          "webhook-signature": `v1,${Buffer.alloc(32, 1).toString("base64")}`,
        },
        receivedAt: FIXTURE_NOW_ISO,
      }),
    ).toEqual({
      kind: "refused",
      refusal: { reason: "untrusted", phase: "verify", retryable: false },
    });

    // Stale timestamp outside 600s window refuses as untrusted
    const staleInput = buildSignedShipBobWebhookInput({
      webhookId: "msg_stale_01",
      topic: "order_shipped",
      orderId: 500002,
      status: "Completed",
      lastUpdatedAt: FIXTURE_EARLIER_ISO,
      headerTimestampIso: FIXTURE_EARLIER_ISO,
      receivedAt: FIXTURE_NOW_ISO,
    });
    expect(await verifier.verifyAndNormalize(staleInput)).toEqual({
      kind: "refused",
      refusal: { reason: "untrusted", phase: "verify", retryable: false },
    });

    // Independent HMAC-SHA256 verification against node:crypto directly
    const rawKey = Buffer.from(FIXTURE_WEBHOOK_SECRET_PRIMARY.slice("whsec_".length), "base64");
    const tsSec = toEpochSecondsString(FIXTURE_NOW_ISO);
    const bodyBytes = new TextEncoder().encode(
      JSON.stringify({
        topic: "inventory_updated",
        data: { id: 500003, status: "Completed" },
      }),
    );
    const expectedSig =
      "v1," +
      createHmac("sha256", rawKey)
        .update(`msg_wrong_topic.${tsSec}.`, "utf8")
        .update(bodyBytes)
        .digest("base64");
    expect(
      await verifier.verifyAndNormalize({
        rawBody: bodyBytes,
        headers: {
          "webhook-id": "msg_wrong_topic",
          "webhook-timestamp": tsSec,
          "webhook-signature": expectedSig,
        },
        receivedAt: FIXTURE_NOW_ISO,
      }),
    ).toEqual({
      kind: "refused",
      refusal: { reason: "unsupported_event", phase: "normalize", retryable: false },
    });
  });

  it("validates shipbob_channel_id header and supports optional omission", async () => {
    for (const badChannelId of ["", "abc", "123\r\n", "1".repeat(21), "123 456"]) {
      expect(() =>
        createShipBobHttpClient({
          environment: "sandbox",
          token: FIXTURE_SENSITIVE_CANARIES.patToken,
          channelId: badChannelId,
          fetchImpl: async () => new Response("{}", { status: 200 }),
        }),
      ).toThrow(ShipBobTransportError);
    }

    const seenHeaders: Record<string, string>[] = [];
    const clientNoChannel = createShipBobHttpClient({
      environment: "live",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      fetchImpl: async (url, init) => {
        expect(url).toBe(`${SHIPBOB_ORIGINS.live}/1.0/order/12345`);
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(
          JSON.stringify(buildShipBobOrderPayload({ id: 12345, status: "Processing" })),
          { status: 200 },
        );
      },
    });
    const order = await clientNoChannel.getOrder("12345");
    expect(order?.id).toBe(12345);
    expect("shipbob_channel_id" in seenHeaders[0]!).toBe(false);

    const clientWithChannel = createShipBobHttpClient({
      environment: "sandbox",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      channelId: FIXTURE_CHANNEL_ID,
      fetchImpl: async (_url, init) => {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(
          JSON.stringify(buildShipBobOrderPayload({ id: 12345, status: "Processing" })),
          { status: 200 },
        );
      },
    });
    await clientWithChannel.getOrder("12345");
    expect(seenHeaders[1]!["shipbob_channel_id"]).toBe(FIXTURE_CHANNEL_ID);
  });

  it("exposes cancelOrder on ShipBobClient with path-traversal refusal while keeping adapter cancel unsupported", async () => {
    let ioCalls = 0;
    const calledUrls: string[] = [];
    const client = createShipBobHttpClient({
      environment: "sandbox",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      fetchImpl: async (url, init) => {
        ioCalls += 1;
        calledUrls.push(`${init?.method} ${url}`);
        return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
      },
    });

    for (const badId of ["..", ".", "../orders", "a/b", "a\\b", "", "   ", "bad..id", "a".repeat(129), "123\n456"]) {
      await expect(client.getOrder(badId)).rejects.toMatchObject({
        code: "shipbob_invalid_order_id",
        submissionAttempted: false,
        mayHaveSucceeded: false,
      });
      await expect(client.cancelOrder(badId)).rejects.toMatchObject({
        code: "shipbob_invalid_order_id",
        submissionAttempted: false,
        mayHaveSucceeded: false,
      });
    }
    expect(ioCalls).toBe(0);

    const cancelled = await client.cancelOrder("778899");
    expect(cancelled).toEqual({ cancelled: true });
    expect(calledUrls).toEqual(["POST https://sandbox-api.shipbob.com/1.0/order/778899/cancel"]);

    const adapter = createShipBobFulfillmentAdapter({
      client,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });
    expect(adapter.capabilities.operations.cancel).toEqual({
      supported: false,
      reason: "not_exposed",
    });

    const rbTraversal = await adapter.readback!.read({
      providerRef: SHIPBOB_PROVIDER_REF,
      requestKey: "req_trav",
      fulfillmentRef: "ful_trav",
      externalRef: "..",
      mode: "parcel",
    });
    expect(rbTraversal).toEqual({
      kind: "unknown",
      refusal: { reason: "malformed", phase: "readback", retryable: false },
    });
    expect(ioCalls).toBe(1);
  });

  it("cancels oversized streaming responses immediately, cancels non-2xx bodies, and redacts sensitive canaries", async () => {
    let chunksPulled = 0;
    let streamCancelled = false;
    let errorBodyCancelled = false;

    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(new Uint8Array(64).fill(0x61));
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const client = createShipBobHttpClient({
      environment: "sandbox",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      maxBodyBytes: 100,
      fetchImpl: async (url) => {
        if (url.endsWith("/999")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                c.enqueue(
                  new TextEncoder().encode(
                    `error leak ${FIXTURE_SENSITIVE_CANARIES.patToken} ${FIXTURE_SENSITIVE_CANARIES.recipientEmail}`,
                  ),
                );
                c.close();
              },
              cancel() {
                errorBodyCancelled = true;
              },
            }),
            { status: 400 },
          );
        }
        return new Response(oversizedStream, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.getOrder("123456")).rejects.toMatchObject({
      code: "shipbob_response_too_large",
      responseBodyRead: false,
    });
    expect(streamCancelled).toBe(true);
    expect(chunksPulled).toBeLessThanOrEqual(3);

    try {
      await client.getOrder("999");
      expect.unreachable("expected ShipBobTransportError");
    } catch (err) {
      expect(err).toBeInstanceOf(ShipBobTransportError);
      expect(errorBodyCancelled).toBe(true);
      const serialized = JSON.stringify(err);
      for (const canary of Object.values(FIXTURE_SENSITIVE_CANARIES)) {
        expect(serialized).not.toContain(canary);
      }
    }
  });

  it("caches 409 Conflict as unknown for 0-I/O replay while never caching pre-send invalid token errors", async () => {
    let tokenValue = "   ";
    let postCalls = 0;
    const client = createShipBobHttpClient({
      environment: "sandbox",
      token: () => tokenValue,
      fetchImpl: async () => {
        postCalls += 1;
        return new Response(JSON.stringify({ message: "Duplicate reference_id" }), { status: 409 });
      },
    });
    const adapter = createShipBobFulfillmentAdapter({
      client,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });

    const req = buildDispatchRequest({ parcelRef: "SB-409-REPLAY" });
    const prep = await adapter.dispatch.prepare(req);
    expect(prep.kind).toBe("prepared");
    if (prep.kind !== "prepared") return;

    // 1. Pre-send invalid token -> not_dispatched (submissionAttempted: false, ioDelta: 0)
    const preSendFail = await adapter.dispatch.dispatch(req, prep.evidence);
    expect(preSendFail).toEqual({
      kind: "not_dispatched",
      effectMayHaveSucceeded: false,
      refusal: { reason: "io_failure", phase: "dispatch", retryable: false },
      error: {
        code: "shipbob_token_invalid",
        status: null,
        retryable: false,
        mayHaveSucceeded: false,
        submissionAttempted: false,
        responseBodyRead: false,
      },
    });
    expect(postCalls).toBe(0);

    // 2. Fix token -> HTTP 409 maps to unknown (mayHaveSucceeded: true)
    tokenValue = FIXTURE_SENSITIVE_CANARIES.patToken;
    const firstConflict = await adapter.dispatch.dispatch(req, prep.evidence);
    expect(firstConflict).toEqual({
      kind: "unknown",
      effectMayHaveSucceeded: true,
      refusal: { reason: "io_failure", phase: "dispatch", retryable: true },
      error: {
        code: "shipbob_http_409",
        status: 409,
        retryable: true,
        mayHaveSucceeded: true,
        submissionAttempted: true,
        responseBodyRead: false,
      },
    });
    expect(postCalls).toBe(1);

    // 3. Replay returns cached unknown at 0 I/O
    const replayConflict = await adapter.dispatch.dispatch(req, prep.evidence);
    expect(replayConflict).toEqual(firstConflict);
    expect(postCalls).toBe(1);
  });

  it("prioritizes exceptions and cancellations over Delivered/InTransit across statuses, topics, and multi-shipments", async () => {
    expect(mapShipBobStatus("Exception", "Delivered")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
    });
    expect(mapShipBobStatus("OnHold", "InTransit")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
    });
    expect(mapShipBobStatus("Completed", "Returned")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
    });
    expect(mapShipBobStatus("Processing", "InTransit", "order_shipment_onhold")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
    });
    expect(mapShipBobStatus("Completed", "Delivered", "order_shipment_exception")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
    });
    expect(mapShipBobStatus("Delivered", "Lost")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "delivery_only",
    });
    expect(mapShipBobStatus("Cancelled", "Delivered")).toEqual({
      canonicalStatus: "cancelled",
      eventKind: "parcel.cancelled",
      recovery: null,
    });
    expect(mapShipBobStatus("Processing", "Shipped", "order_shipment_cancelled")).toEqual({
      canonicalStatus: "cancelled",
      eventKind: "parcel.cancelled",
      recovery: null,
    });
    expect(mapShipBobStatus("ImportReview")).toEqual({
      canonicalStatus: "provider_received",
      eventKind: "order.processing_started",
      recovery: null,
    });
    expect(mapShipBobStatus("Packed")).toEqual({
      canonicalStatus: "packed",
      eventKind: "order.picked",
      recovery: null,
    });

    // Multi-shipment order where shipment #1 is DeliveryException and shipment #2 is Delivered -> must surface exception
    // Also verifies readback identity mismatch guard
    const adapter = createShipBobFulfillmentAdapter({
      client: {
        createOrder: async () => null,
        getOrder: async (id) =>
          id === "555001"
            ? {
                id: 555001,
                status: "Processing",
                last_updated_at: FIXTURE_NOW_ISO,
                shipments: [
                  { id: "S1", status: "DeliveryException" },
                  { id: "S2", status: "Delivered" },
                ],
              }
            : { id: 999999, status: "Completed", last_updated_at: FIXTURE_NOW_ISO },
        getOrderByReferenceId: async () => ({
          id: 999999,
          reference_id: "WRONG-REF",
          status: "Completed",
          last_updated_at: FIXTURE_NOW_ISO,
        }),
        cancelOrder: async () => ({ cancelled: true }),
        listOrders: async () => [],
        listInventory: async () => [],
      },
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });

    const rbMulti = await adapter.readback!.read({
      providerRef: SHIPBOB_PROVIDER_REF,
      requestKey: "req_multi",
      fulfillmentRef: "ful_multi",
      externalRef: "555001",
      mode: "parcel",
    });
    expect(rbMulti.kind).toBe("found");
    if (rbMulti.kind === "found") {
      expect(rbMulti.observation.fact.canonicalStatus).toBe("exception");
      expect(rbMulti.observation.intake?.recovery).toBe("delivery_only");
    }

    // Readback identity mismatch returns unknown/malformed
    expect(
      await adapter.readback!.read({
        providerRef: SHIPBOB_PROVIDER_REF,
        requestKey: "req_mismatch_num",
        fulfillmentRef: "ful_mismatch_num",
        externalRef: "555002",
        mode: "parcel",
      }),
    ).toEqual({
      kind: "unknown",
      refusal: { reason: "malformed", phase: "readback", retryable: false },
    });
    expect(
      await adapter.readback!.read({
        providerRef: SHIPBOB_PROVIDER_REF,
        requestKey: "req_mismatch_ref",
        fulfillmentRef: "ful_mismatch_ref",
        externalRef: "EXPECTED-REF",
        mode: "parcel",
      }),
    ).toEqual({
      kind: "unknown",
      refusal: { reason: "malformed", phase: "readback", retryable: false },
    });
  });

  it("pins HTTPS origins, enforces timeout through body reading, paginates stock sync, and refuses stock movements at 0 I/O", async () => {
    expect(resolvePinnedShipBobOrigin("live")).toBe("https://api.shipbob.com");
    expect(resolvePinnedShipBobOrigin("sandbox")).toBe("https://sandbox-api.shipbob.com");
    expect(() => resolvePinnedShipBobOrigin("toString" as "live")).toThrow(ShipBobTransportError);
    expect(() => resolvePinnedShipBobOrigin("staging" as "live")).toThrow(ShipBobTransportError);

    const slowClient = createShipBobHttpClient({
      environment: "sandbox",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      timeoutMs: 30,
      fetchImpl: async (_url, init) =>
        ({
          ok: true,
          status: 200,
          body: null,
          headers: new Headers({ "content-type": "application/json" }),
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted_body_read")));
            }),
        }) as unknown as Response,
    });
    await expect(slowClient.getOrder("12345")).rejects.toMatchObject({
      code: "shipbob_timeout",
      retryable: true,
    });

    // Multi-page 1-based inventory sync & zero-I/O getStockMovements refusal
    let inventoryCalls = 0;
    const pagedAdapter = createShipBobFulfillmentAdapter({
      client: {
        createOrder: async () => null,
        getOrder: async () => null,
        getOrderByReferenceId: async () => null,
        cancelOrder: async () => ({ cancelled: true }),
        listOrders: async () => [],
        listInventory: async ({ page, limit }) => {
          inventoryCalls += 1;
          expect(limit).toBe(2);
          if (page === 1) {
            return [
              {
                sku: "SKU-A",
                total_on_hand_quantity: 50,
                total_fulfillable_quantity: 45,
                total_committed_quantity: 3,
                total_awaiting_quantity: 2,
                last_updated_date: FIXTURE_NOW_ISO,
              },
              {
                sku: "SKU-B",
                total_on_hand_quantity: 30,
                total_fulfillable_quantity: 20,
                total_committed_quantity: 10,
                total_awaiting_quantity: 0,
                last_updated_date: null,
              },
            ];
          }
          return [
            {
              sku: "SKU-C",
              total_on_hand_quantity: 10,
              total_fulfillable_quantity: 10,
              total_committed_quantity: 0,
              total_awaiting_quantity: 0,
              last_updated_date: FIXTURE_NOW_ISO,
            },
          ];
        },
      },
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
      inventoryPageSize: 2,
    });

    const snapshots = await pagedAdapter.stockSync!.getStock();
    expect(inventoryCalls).toBe(2);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[1]).toMatchObject({
      skuRef: "SKU-B",
      totalQuantity: 30,
      forSaleQuantity: 20,
      reservedOrUnavailableQuantity: 10,
      revisionSource: "collection",
    });

    const callsBeforeMovements = inventoryCalls;
    await expect(pagedAdapter.stockSync!.getStockMovements()).rejects.toEqual({
      reason: "stock_movements_unsupported",
      phase: "sync",
      retryable: false,
    });
    expect(inventoryCalls).toBe(callsBeforeMovements);
  });

  it("hardens malformed 2xx createOrder/listOrders/listInventory responses, HTTP 408, negative/NaN stock counts, and webhook precedence + v2025 dotted topics", async () => {
    // 1. Empty or structurally malformed 2xx POST /1.0/order -> throws shipbob_malformed_response & adapter returns+caches unknown (never accepted)
    let createHttpCalls = 0;
    const malformedHttpClient = createShipBobHttpClient({
      environment: "sandbox",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      fetchImpl: async (urlString) => {
        const u = new URL(urlString);
        if (u.pathname === "/1.0/order" && !u.search) {
          createHttpCalls += 1;
          return new Response("", { status: 200 });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const malformedAdapter = createShipBobFulfillmentAdapter({
      client: malformedHttpClient,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });
    const reqMalformed = buildDispatchRequest({
      requestKey: "req_sb_malformed_200",
      fulfillmentRef: "ful_sb_malformed_200",
      parcelRef: "SB-MALFORMED-200",
    });
    const preparedMalformed = await malformedAdapter.dispatch.prepare(reqMalformed);
    expect(preparedMalformed.kind).toBe("prepared");
    if (preparedMalformed.kind !== "prepared") throw new Error("expected prepared");
    const firstDispatch = await malformedAdapter.dispatch.dispatch(reqMalformed, preparedMalformed.evidence);
    expect(firstDispatch).toMatchObject({
      kind: "unknown",
      effectMayHaveSucceeded: true,
      error: { code: "shipbob_malformed_response", mayHaveSucceeded: true },
    });
    // Replay returns cached unknown at 0 additional HTTP calls
    const replayDispatch = await malformedAdapter.dispatch.dispatch(reqMalformed, preparedMalformed.evidence);
    expect(replayDispatch.kind).toBe("unknown");
    expect(createHttpCalls).toBe(1);

    // Defensive adapter guard: mismatched reference_id from injected structural client -> unknown (never accepted)
    const mismatchedAdapter = createShipBobFulfillmentAdapter({
      client: {
        createOrder: async () => ({
          id: 999111,
          reference_id: "SB-WRONG-REF",
          status: "Processing",
          shipments: [],
        }),
        getOrder: async () => null,
        getOrderByReferenceId: async () => null,
        cancelOrder: async () => ({ cancelled: true }),
        listOrders: async () => [],
        listInventory: async () => [],
      },
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });
    const reqMismatch = buildDispatchRequest({
      requestKey: "req_sb_ref_mismatch",
      fulfillmentRef: "ful_sb_ref_mismatch",
      parcelRef: "SB-EXPECTED-REF",
    });
    const prepMismatch = await mismatchedAdapter.dispatch.prepare(reqMismatch);
    expect(prepMismatch.kind).toBe("prepared");
    if (prepMismatch.kind !== "prepared") throw new Error("expected prepared");
    expect(await mismatchedAdapter.dispatch.dispatch(reqMismatch, prepMismatch.evidence)).toMatchObject({
      kind: "unknown",
      effectMayHaveSucceeded: true,
      error: { code: "shipbob_malformed_response" },
    });

    // 2. Non-array / empty 2xx listOrders & listInventory MUST fail with shipbob_malformed_response (never coerce to [])
    const badPage = await malformedAdapter.reconciliation!.readPage({ page: 0, size: 10 });
    expect(badPage).toMatchObject({
      kind: "failed",
      refusal: { reason: "io_failure", phase: "readback", retryable: true },
      error: { code: "shipbob_malformed_response" },
    });
    await expect(malformedAdapter.stockSync!.getStock()).rejects.toMatchObject({
      reason: "io_failure",
      phase: "sync",
      code: "shipbob_malformed_response",
    });

    // 3. HTTP 408 on mutating createOrder classified as uncertain (mayHaveSucceeded: true, retryable: true)
    const http408Client = createShipBobHttpClient({
      environment: "sandbox",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      fetchImpl: async () => new Response("timeout", { status: 408 }),
    });
    await expect(
      http408Client.createOrder({
        reference_id: "SB-408",
        order_number: "ORD-408",
        shipping_method: "Standard",
        recipient: {
          name: "Test",
          address: { address1: "1 Main", city: "Austin", country: "US", zip_code: "78701" },
        },
        products: [{ reference_id: "SKU-1", quantity: 1 }],
      }),
    ).rejects.toMatchObject({
      code: "shipbob_http_408",
      retryable: true,
      mayHaveSucceeded: true,
    });

    // 4. StockSync sanitizes negative, NaN, and forSale > total quantities
    const dirtyStockAdapter = createShipBobFulfillmentAdapter({
      client: {
        createOrder: async () => null,
        getOrder: async () => null,
        getOrderByReferenceId: async () => null,
        cancelOrder: async () => ({ cancelled: true }),
        listOrders: async () => [],
        listInventory: async () => [
          {
            sku: "SKU-NEG",
            total_on_hand_quantity: -5,
            total_fulfillable_quantity: Number.NaN,
            total_committed_quantity: 0,
            total_awaiting_quantity: 0,
            last_updated_date: null,
          },
          {
            sku: "SKU-EXCEED",
            total_on_hand_quantity: 4,
            total_fulfillable_quantity: 10,
            total_committed_quantity: 0,
            total_awaiting_quantity: 0,
            last_updated_date: FIXTURE_NOW_ISO,
          },
        ],
      },
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });
    const sanitized = await dirtyStockAdapter.stockSync!.getStock();
    expect(sanitized[0]).toMatchObject({
      skuRef: "SKU-NEG",
      totalQuantity: 0,
      forSaleQuantity: 0,
      reservedOrUnavailableQuantity: 0,
    });
    expect(sanitized[1]).toMatchObject({
      skuRef: "SKU-EXCEED",
      totalQuantity: 10,
      forSaleQuantity: 10,
      reservedOrUnavailableQuantity: 0,
    });

    // 5. Webhook top-level shipment_status:"Delivered" MUST NOT mask DeliveryException in shipments[],
    //    and v2025 dotted topics order.shipment.on_hold & order.delivered map accurately.
    const verifier = createShipBobWebhookVerifier({
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
    });

    const maskedExceptionBody = Buffer.from(
      JSON.stringify({
        topic: "order_shipment_delivered",
        data: {
          id: 901001,
          reference_id: "SB-MASK-01",
          status: "Processing",
          shipment_status: "Delivered",
          last_updated_at: FIXTURE_NOW_ISO,
          shipments: [{ id: 1, status: "DeliveryException" }],
        },
      }),
      "utf8",
    );
    const tsSec = String(Math.floor(Date.parse(FIXTURE_NOW_ISO) / 1000));
    const maskedSig = computeStandardWebhookSignature(
      "msg_masked_ex",
      tsSec,
      maskedExceptionBody,
      FIXTURE_WEBHOOK_SECRET_PRIMARY,
    );
    const maskedRes = await verifier.verifyAndNormalize({
      rawBody: maskedExceptionBody,
      headers: {
        "webhook-id": "msg_masked_ex",
        "webhook-timestamp": tsSec,
        "webhook-signature": maskedSig,
      },
      receivedAt: FIXTURE_NOW_ISO,
    });
    expect(maskedRes.kind).toBe("verified");
    if (maskedRes.kind !== "verified") throw new Error("expected verified");
    expect(maskedRes.observation.fact.canonicalStatus).toBe("exception");
    expect(maskedRes.observation.intake?.recovery).toBe("delivery_only");

    // v2025 dotted topics: order.shipment.on_hold + InTransit -> exception (manual); order.delivered + Completed -> delivered
    expect(mapShipBobStatus("Processing", "InTransit", "order.shipment.on_hold")).toEqual({
      canonicalStatus: "exception",
      eventKind: "parcel.exception",
      recovery: "manual",
    });
    expect(mapShipBobStatus("Completed", "Completed", "order.delivered")).toEqual({
      canonicalStatus: "delivered",
      eventKind: "order.delivered",
      recovery: null,
    });
  });
});
