import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  runPaymentAdapterConformance,
  ScriptedPaymentTransportError,
} from "@openlup/platform/payments/testing";
import {
  assertPayPalCredentials,
  assertSafePayPalOrderId,
  createPayPalHttpClient,
  createPayPalPaymentAdapter,
  majorStringToMinor,
  minorToMajorString,
  PAYPAL_API_ORIGINS,
  PayPalTransportError,
  projectPayPalStaticCapabilities,
} from "../server/index.js";
import {
  buildPayPalWebhookInput,
  createPayPalSafetyFixture,
  PAYPAL_TEST_CANARIES,
  PAYPAL_TEST_CANCEL_URL,
  PAYPAL_TEST_OCCURRED_AT,
  PAYPAL_TEST_RETURN_URL,
  PAYPAL_TEST_WEBHOOK_ID,
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

function assertNoCanaryLeak(surface: unknown, extraCanaries: readonly string[] = []): void {
  const serialized = JSON.stringify(surface);
  const canaries = [
    PAYPAL_TEST_CANARIES.marker,
    PAYPAL_TEST_CANARIES.clientId,
    PAYPAL_TEST_CANARIES.clientSecret,
    PAYPAL_TEST_CANARIES.payerEmail,
    PAYPAL_TEST_CANARIES.payerName,
    ...extraCanaries,
  ];
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(encodeURIComponent(canary));
    expect(serialized).not.toContain(Buffer.from(canary, "utf8").toString("base64"));
  }
}

describe("recipes/payments/paypal — Stage 1 & Stage 2 conformance + security invariants", () => {
  it("passes the official @openlup/platform/payments/testing safety conformance suite", async () => {
    const fixture = createPayPalSafetyFixture();
    const report = await runPaymentAdapterConformance(fixture.subjects);

    expect(report.subjects.map((row) => row.subjectId)).toEqual(["attempt-eu-eur", "attempt-us-usd"]);
    expect(report.cases.every((row) => row.passed)).toBe(true);
    expect(report.cases.filter((row) => row.name.includes("capability:")).length).toBeGreaterThanOrEqual(20);
    expect(report.cases.filter((row) => row.name.includes("never settles"))).toHaveLength(6);

    for (const subject of report.subjects) {
      expect(subject.execution.dispatch.kind).toBe("dispatched");
      expect(subject.readback.kind).toBe("succeeded");
    }

    // Unsupported operations (refundCreate, authorizationCaptureSplit, close) stay absent on adapter ports.
    expect("refundCreate" in fixture.adapter).toBe(false);
    expect("refundCreate" in fixture.adapter.attemptPort).toBe(false);
    expect("refundCreate" in fixture.adapter.readbackPort).toBe(false);
    expect("close" in fixture.adapter.readbackPort).toBe(false);

    assertNoCanaryLeak(report);
    fixture.fake.assertDrained();
  });

  it("validates recipe.json against JSON Schema, exact disk inventory, and staticCapabilities parity", () => {
    const recipeSchema = JSON.parse(
      readFileSync(path.resolve(RECIPE_DIR, "../../schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(path.join(RECIPE_DIR, "recipe.json"), "utf8")) as Record<string, unknown>;

    expect(validateAgainstJsonSchema(manifest, recipeSchema)).toEqual([]);
    expect((manifest.summary as string).length).toBeLessThanOrEqual(240);

    // Negative control: invalid egress origin + extra property must fail schema validation.
    expect(
      validateAgainstJsonSchema(
        { ...manifest, egressOrigins: ["http://insecure.example.com"], extraKey: true },
        recipeSchema,
      ).length,
    ).toBeGreaterThanOrEqual(2);

    expect(manifest.staticCapabilities).toEqual(projectPayPalStaticCapabilities());

    const files = manifest.files as { allFiles: string[] };
    expect(files.allFiles).toHaveLength(9);
    for (const relPath of files.allFiles) {
      expect(existsSync(path.join(RECIPE_DIR, relPath)), `missing declared recipe file: ${relPath}`).toBe(true);
    }
    expect(files.allFiles).toEqual(listRecipeFilesOnDisk(RECIPE_DIR));
  });

  it("converts exact integer minor units and major decimal strings without IEEE-754 float math", () => {
    expect(minorToMajorString(1299, "EUR")).toBe("12.99");
    expect(minorToMajorString(5, "USD")).toBe("0.05");
    expect(minorToMajorString(0, "EUR")).toBe("0.00");
    expect(minorToMajorString(1000, "JPY")).toBe("1000");
    expect(minorToMajorString(1500, "KWD")).toBe("1.500");

    expect(majorStringToMinor("12.99", "EUR")).toBe(1299);
    expect(majorStringToMinor("0.05", "USD")).toBe(5);
    expect(majorStringToMinor("1000", "JPY")).toBe(1000);
    expect(majorStringToMinor("1.500", "KWD")).toBe(1500);

    expect(majorStringToMinor("12.9", "EUR")).toBeNull();
    expect(majorStringToMinor("12.999", "EUR")).toBeNull();
    expect(majorStringToMinor("-12.99", "EUR")).toBeNull();
    expect(majorStringToMinor(" 12.99", "EUR")).toBeNull();
    expect(majorStringToMinor("12.99", "XXX")).toBeNull();
    expect(() => minorToMajorString(100, "XXX")).toThrow("Invalid ISO-4217 currency code");
  });

  it("enforces cold-import zero-I/O, OAuth2 client_credentials caching, PayPal-Request-Id, and captureOrder", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("should not be called");
    });

    expect(() =>
      createPayPalHttpClient({
        mode: "test",
        credentials: { clientId: "", clientSecret: PAYPAL_TEST_CANARIES.clientSecret },
        fetchImpl: fetchSpy,
      }),
    ).toThrow(PayPalTransportError);
    expect(() =>
      assertPayPalCredentials({ clientId: "bad id", clientSecret: PAYPAL_TEST_CANARIES.clientSecret }),
    ).toThrow(PayPalTransportError);

    let dynamicCreds = { clientId: "", clientSecret: "" };
    const lazyClient = createPayPalHttpClient({
      mode: "test",
      credentials: () => dynamicCreds,
      fetchImpl: fetchSpy,
    });
    const lazyAdapter = createPayPalPaymentAdapter({
      client: lazyClient,
      webhookId: PAYPAL_TEST_WEBHOOK_ID,
      returnUrl: PAYPAL_TEST_RETURN_URL,
      cancelUrl: PAYPAL_TEST_CANCEL_URL,
      mode: "test",
      supportedCurrencies: ["EUR", "USD"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const missingCredsRes = await lazyAdapter.attemptPort.execute({
      attemptRef: "att-missing-creds",
      intentRef: "int-missing-creds",
      fingerprint: "fp-missing-creds",
      providerIdempotencyKey: "idem-missing-creds",
      money: { amountMinor: 2500, currency: "EUR" },
      mode: "test",
      purpose: "initial",
    });
    expect(missingCredsRes.dispatch).toMatchObject({
      kind: "notDispatched",
      evidence: { exact: true, phase: "before-dispatch" },
    });
    expect(missingCredsRes.diagnostics.diagnosticCode).toBe("PAYPAL_CREDENTIALS_MISSING");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Pre-dispatch input validation refusals with 0 HTTP calls.
    const modeMismatch = await lazyAdapter.attemptPort.execute({
      attemptRef: "att-mode",
      intentRef: "int-mode",
      fingerprint: "fp-mode",
      providerIdempotencyKey: "idem-mode",
      money: { amountMinor: 1000, currency: "EUR" },
      mode: "live",
      purpose: "initial",
    });
    expect(modeMismatch.dispatch.kind).toBe("notDispatched");
    expect(modeMismatch.diagnostics.diagnosticCode).toBe("PAYPAL_MODE_MISMATCH");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Real HTTP client flow: 1 OAuth2 token exchange + createOrder + captureOrder (reusing cached OAuth token).
    dynamicCreds = {
      clientId: PAYPAL_TEST_CANARIES.clientId,
      clientSecret: PAYPAL_TEST_CANARIES.clientSecret,
    };
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const liveFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body =
        typeof init?.body === "string" && urlStr.includes("/v2/")
          ? JSON.parse(init.body)
          : init?.body;
      calls.push({ url: urlStr, method: init?.method ?? "GET", headers, body });

      if (urlStr === `${PAYPAL_API_ORIGINS.test}/v1/oauth2/token`) {
        return new Response(
          JSON.stringify({ access_token: "oauth-token-cached-01", token_type: "Bearer", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr === `${PAYPAL_API_ORIGINS.test}/v2/checkout/orders`) {
        return new Response(
          JSON.stringify({
            id: "TEST_ORDER_0002",
            status: "CREATED",
            links: [
              { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=TEST_ORDER_0002" },
            ],
            create_time: PAYPAL_TEST_OCCURRED_AT,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr === `${PAYPAL_API_ORIGINS.test}/v2/checkout/orders/TEST_ORDER_0002/capture`) {
        return new Response(
          JSON.stringify({
            id: "TEST_ORDER_0002",
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: "att-1",
                custom_id: "int-1",
                amount: { currency_code: "EUR", value: "19.99" },
                payments: {
                  captures: [
                    {
                      id: "CAP-TEST_ORDER_0002",
                      status: "COMPLETED",
                      amount: { currency_code: "EUR", value: "19.99" },
                      update_time: PAYPAL_TEST_OCCURRED_AT,
                    },
                  ],
                },
              },
            ],
            update_time: PAYPAL_TEST_OCCURRED_AT,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const wiredClient = createPayPalHttpClient({
      mode: "test",
      credentials: dynamicCreds,
      fetchImpl: liveFetch,
    });
    const wiredAdapter = createPayPalPaymentAdapter({
      client: wiredClient,
      webhookId: PAYPAL_TEST_WEBHOOK_ID,
      returnUrl: PAYPAL_TEST_RETURN_URL,
      cancelUrl: PAYPAL_TEST_CANCEL_URL,
      mode: "test",
      supportedCurrencies: ["EUR"],
    });

    const exec = await wiredAdapter.attemptPort.execute({
      attemptRef: "att-1",
      intentRef: "int-1",
      fingerprint: "fp-1",
      providerIdempotencyKey: "paypal-req-1",
      money: { amountMinor: 1999, currency: "EUR" },
      mode: "test",
      purpose: "initial",
      payer: { email: PAYPAL_TEST_CANARIES.payerEmail, name: PAYPAL_TEST_CANARIES.payerName },
    });

    expect(exec.outcome).toEqual({ kind: "attempt", status: "requires_action" });
    expect(exec.handoff).toEqual({
      kind: "redirect",
      url: "https://www.sandbox.paypal.com/checkoutnow?token=TEST_ORDER_0002",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${PAYPAL_API_ORIGINS.test}/v1/oauth2/token`);
    expect(calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from(`${PAYPAL_TEST_CANARIES.clientId}:${PAYPAL_TEST_CANARIES.clientSecret}`).toString("base64")}`,
    );
    expect(calls[1]!.url).toBe(`${PAYPAL_API_ORIGINS.test}/v2/checkout/orders`);
    expect(calls[1]!.headers["paypal-request-id"]).toBe("paypal-req-1");
    expect(calls[1]!.headers.authorization).toBe("Bearer oauth-token-cached-01");
    assertNoCanaryLeak(exec);

    // Subsequent captureOrder reuses the cached OAuth token (only 1 extra HTTP call).
    const captured = await wiredClient.captureOrder("TEST_ORDER_0002", {
      idempotencyKey: "paypal-cap-1",
    });
    expect(captured.status).toBe("COMPLETED");
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url).toBe(`${PAYPAL_API_ORIGINS.test}/v2/checkout/orders/TEST_ORDER_0002/capture`);
    expect(calls[2]!.headers["paypal-request-id"]).toBe("paypal-cap-1");

    await expect(
      wiredClient.captureOrder("../evil", { idempotencyKey: "bad" }),
    ).rejects.toThrow(PayPalTransportError);
    expect(() => assertSafePayPalOrderId("bad/id")).toThrow(PayPalTransportError);
  });

  it("redacts leaked error bodies, maps transport faults safely, and enforces webhook readback guards", async () => {
    const errorClient = createPayPalHttpClient({
      mode: "live",
      credentials: {
        clientId: PAYPAL_TEST_CANARIES.clientId,
        clientSecret: PAYPAL_TEST_CANARIES.clientSecret,
      },
      fetchImpl: async (url) => {
        if (String(url).includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "live-tok", token_type: "Bearer", expires_in: 3600 }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ message: `secret ${PAYPAL_TEST_CANARIES.clientSecret} ${PAYPAL_TEST_CANARIES.marker}` }),
          { status: 500 },
        );
      },
    });

    let caught: unknown;
    try {
      await errorClient.getOrder("5O190127TN364715L");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayPalTransportError);
    expect((caught as PayPalTransportError).diagnosticCode).toBe("PAYPAL_HTTP_500");
    assertNoCanaryLeak({ message: (caught as Error).message });

    let getCalls = 0;
    const faultAdapter = createPayPalPaymentAdapter({
      client: {
        async createOrder() {
          throw new ScriptedPaymentTransportError("provider-5xx");
        },
        async getOrder() {
          getCalls += 1;
          throw new PayPalTransportError({
            diagnosticCode: "PAYPAL_REQUEST_TIMEOUT",
            httpStatus: null,
            phase: "unknown",
          });
        },
        async verifyWebhookSignature() {
          return { verification_status: "SUCCESS" };
        },
      },
      webhookId: PAYPAL_TEST_WEBHOOK_ID,
      returnUrl: PAYPAL_TEST_RETURN_URL,
      cancelUrl: PAYPAL_TEST_CANCEL_URL,
      mode: "test",
      supportedCurrencies: ["EUR"],
    });

    const uncertain = await faultAdapter.attemptPort.execute({
      attemptRef: "att-5xx",
      intentRef: "int-5xx",
      fingerprint: "fp-5xx",
      providerIdempotencyKey: "idem-5xx",
      money: { amountMinor: 2500, currency: "EUR" },
      mode: "test",
      purpose: "initial",
    });
    expect(uncertain.dispatch).toEqual({ kind: "unknown" });
    expect(uncertain.outcome).toEqual({ kind: "attempt", status: "processing" });

    const readTimeout = await faultAdapter.readbackPort.readPayment({
      identity: { provider: "paypal", providerPaymentRef: "5O190127TN364715T", intentRef: "i1", attemptRef: "a1" },
      expectedMoney: { amountMinor: 2500, currency: "EUR" },
      purpose: "active_checkout",
    });
    expect(readTimeout).toMatchObject({ kind: "unknown", reason: "timeout" });

    // Auth-before-parse: missing PayPal signature headers or non-paypal cert URLs fail closed at ZERO I/O.
    const beforeMalformed = getCalls;
    expect(
      await faultAdapter.verifyPort.verifyAndNormalize(
        buildPayPalWebhookInput({ orderId: "5O190127TN364715T", eventType: "CUSTOMER.DISPUTE.CREATED", omitSignatureHeaders: true }),
      ),
    ).toEqual({ kind: "refusal", reason: "signature" });
    expect(
      await faultAdapter.verifyPort.verifyAndNormalize(
        buildPayPalWebhookInput({ orderId: "5O190127TN364715T", certUrl: "https://evil.example.test/cert.pem" }),
      ),
    ).toEqual({ kind: "refusal", reason: "signature" });

    // Malformed payloads with valid header shape fail at zero getOrder calls.
    const validHeaders = buildPayPalWebhookInput({ orderId: "ORDER_A" }).headers;
    for (const rawBody of [
      new Uint8Array(0),
      new TextEncoder().encode("not-json"),
      new TextEncoder().encode('{"resource":{}}'),
      new TextEncoder().encode('{"resource":{"id":"../evil"}}'),
      new Uint8Array([0x7b, 0xff, 0xfe]),
    ]) {
      expect(
        await faultAdapter.verifyPort.verifyAndNormalize({
          rawBody,
          headers: validHeaders,
          receivedAt: PAYPAL_TEST_OCCURRED_AT,
        }),
      ).toEqual({ kind: "refusal", reason: "malformed" });
    }
    expect(getCalls).toBe(beforeMalformed);

    // Forged dispute signature fails before firing getOrder, and CUSTOMER.DISPUTE.RESOLVED is never blindly disputed.
    let disputeGetCalls = 0;
    const strictAdapter = createPayPalPaymentAdapter({
      client: {
        async createOrder() {
          throw new Error("unused");
        },
        async verifyWebhookSignature(req) {
          return {
            verification_status: req.transmission_sig === "valid-paypal-sig" ? "SUCCESS" : "FAILURE",
          };
        },
        async getOrder(orderId) {
          disputeGetCalls += 1;
          if (orderId === "ORDER_PENDING_CAP") {
            return {
              id: orderId,
              status: "COMPLETED",
              purchase_units: [
                {
                  reference_id: "att-p",
                  custom_id: "int-p",
                  amount: { currency_code: "EUR", value: "25.00" },
                  payments: {
                    captures: [
                      {
                        id: "CAP-PENDING",
                        status: "PENDING",
                        amount: { currency_code: "EUR", value: "25.00" },
                        update_time: PAYPAL_TEST_OCCURRED_AT,
                      },
                    ],
                  },
                },
              ],
            };
          }
          if (orderId === "ORDER_PARTIAL_CAP") {
            return {
              id: orderId,
              status: "COMPLETED",
              purchase_units: [
                {
                  reference_id: "att-part",
                  custom_id: "int-part",
                  amount: { currency_code: "EUR", value: "25.00" },
                  payments: {
                    captures: [
                      {
                        id: "CAP-PARTIAL",
                        status: "COMPLETED",
                        amount: { currency_code: "EUR", value: "10.00" },
                        update_time: PAYPAL_TEST_OCCURRED_AT,
                      },
                    ],
                  },
                },
              ],
            };
          }
          return {
            id: orderId,
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: "att-1",
                custom_id: "int-1",
                amount: { currency_code: "EUR", value: "25.00" },
                payments: {
                  captures: [
                    {
                      id: "CAP-1",
                      status: "COMPLETED",
                      amount: { currency_code: "EUR", value: "25.00" },
                      update_time: PAYPAL_TEST_OCCURRED_AT,
                    },
                  ],
                },
              },
            ],
          };
        },
      },
      webhookId: PAYPAL_TEST_WEBHOOK_ID,
      returnUrl: PAYPAL_TEST_RETURN_URL,
      cancelUrl: PAYPAL_TEST_CANCEL_URL,
      mode: "test",
      supportedCurrencies: ["EUR"],
    });
    expect(
      await strictAdapter.verifyPort.verifyAndNormalize(
        buildPayPalWebhookInput({
          orderId: "ORDER_COMPLETED_01",
          eventType: "CUSTOMER.DISPUTE.CREATED",
          signatureHeader: "forged-sig",
        }),
      ),
    ).toEqual({ kind: "refusal", reason: "signature" });
    expect(disputeGetCalls).toBe(0);

    expect(
      await strictAdapter.verifyPort.verifyAndNormalize(
        buildPayPalWebhookInput({
          orderId: "ORDER_COMPLETED_01",
          eventType: "CUSTOMER.DISPUTE.RESOLVED",
        }),
      ),
    ).toEqual({ kind: "refusal", reason: "unsupported-event" });

    // PENDING capture must stay pending (never settle as succeeded) in both webhook and readback.
    const pendingWh = await strictAdapter.verifyPort.verifyAndNormalize(
      buildPayPalWebhookInput({ orderId: "ORDER_PENDING_CAP" }),
    );
    expect(pendingWh).toMatchObject({ kind: "money", outcome: "pending" });
    expect(
      await strictAdapter.readbackPort.readPayment({
        identity: { provider: "paypal", providerPaymentRef: "ORDER_PENDING_CAP", intentRef: "int-p", attemptRef: "att-p" },
        expectedMoney: { amountMinor: 2500, currency: "EUR" },
        purpose: "active_checkout",
      }),
    ).toMatchObject({ kind: "pending" });

    // Partial capture amount mismatch must fail closed (never settle full order amount).
    expect(
      await strictAdapter.verifyPort.verifyAndNormalize(
        buildPayPalWebhookInput({ orderId: "ORDER_PARTIAL_CAP" }),
      ),
    ).toEqual({ kind: "refusal", reason: "malformed" });
    expect(
      await strictAdapter.readbackPort.readPayment({
        identity: { provider: "paypal", providerPaymentRef: "ORDER_PARTIAL_CAP", intentRef: "int-part", attemptRef: "att-part" },
        expectedMoney: { amountMinor: 2500, currency: "EUR" },
        purpose: "active_checkout",
      }),
    ).toMatchObject({ kind: "unknown", reason: "indeterminate" });

    // Confused deputy check: webhook asks for Order A, readback returns Order B -> signature refusal.
    const confusedAdapter = createPayPalPaymentAdapter({
      client: {
        async createOrder() {
          throw new Error("unused");
        },
        async verifyWebhookSignature() {
          return { verification_status: "SUCCESS" };
        },
        async getOrder() {
          return {
            id: "ORDER_OTHER_999",
            status: "COMPLETED",
            purchase_units: [{ amount: { currency_code: "EUR", value: "25.00" } }],
          };
        },
      },
      webhookId: PAYPAL_TEST_WEBHOOK_ID,
      returnUrl: PAYPAL_TEST_RETURN_URL,
      cancelUrl: PAYPAL_TEST_CANCEL_URL,
      mode: "test",
      supportedCurrencies: ["EUR"],
    });
    expect(
      await confusedAdapter.verifyPort.verifyAndNormalize(
        buildPayPalWebhookInput({ orderId: "ORDER_ASKED_001" }),
      ),
    ).toEqual({ kind: "refusal", reason: "signature" });
  });

  it("rejects planted-defect negative controls in runPaymentAdapterConformance", async () => {
    const fixture1 = createPayPalSafetyFixture();
    const brokenCapsSubjects = fixture1.subjects.map((subject) => ({
      ...subject,
      adapter: {
        ...subject.adapter,
        capabilities: {
          ...subject.adapter.capabilities,
          captureFlows: [
            {
              kind: "hosted_checkout",
              handoff: "redirect" as const,
              methodFamilies: ["wallet"] as const,
            },
          ],
        },
      },
    }));
    await expect(runPaymentAdapterConformance(brokenCapsSubjects)).rejects.toThrow(
      "payment_adapter_conformance:capture flow declared",
    );

    const fixture2 = createPayPalSafetyFixture();
    const leakyPortSubjects = fixture2.subjects.map((subject) => ({
      ...subject,
      adapter: {
        ...subject.adapter,
        readbackPort: {
          ...subject.adapter.readbackPort,
          refundCreate: async () => undefined,
        },
      },
    }));
    await expect(runPaymentAdapterConformance(leakyPortSubjects)).rejects.toThrow(
      "payment_adapter_conformance:refundCreate structurally unsupported",
    );
  });
});
