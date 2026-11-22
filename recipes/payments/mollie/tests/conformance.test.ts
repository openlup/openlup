import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  runPaymentAdapterConformance,
  ScriptedPaymentTransportError,
} from "@openlup/platform/payments/testing";
import {
  assertMollieKeyMatchesMode,
  assertSafeMolliePaymentId,
  createMollieHttpClient,
  createMolliePaymentAdapter,
  majorStringToMinor,
  minorToMajorString,
  MOLLIE_API_ORIGIN,
  MollieTransportError,
  projectMollieStaticCapabilities,
} from "../server/index.js";
import {
  buildMollieWebhookInput,
  createMollieSafetyFixture,
  MOLLIE_TEST_CANARIES,
  MOLLIE_TEST_EXPIRES_AT,
  MOLLIE_TEST_OCCURRED_AT,
  MOLLIE_TEST_REDIRECT_URL,
  MOLLIE_TEST_WEBHOOK_URL,
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
    MOLLIE_TEST_CANARIES.apiKeyTest,
    MOLLIE_TEST_CANARIES.apiKeyLive,
    MOLLIE_TEST_CANARIES.payerEmail,
    MOLLIE_TEST_CANARIES.payerName,
    ...extraCanaries,
  ];
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(encodeURIComponent(canary));
    expect(serialized).not.toContain(Buffer.from(canary, "utf8").toString("base64"));
  }
}

describe("recipes/payments/mollie — Stage 1 & Stage 2 conformance + security invariants", () => {
  it("passes the official @openlup/platform/payments/testing safety conformance suite", async () => {
    const fixture = createMollieSafetyFixture();
    const report = await runPaymentAdapterConformance(fixture.subjects);

    expect(report.subjects.map((row) => row.subjectId)).toEqual(["attempt-eu-eur", "attempt-us-usd"]);
    expect(report.cases.every((row) => row.passed)).toBe(true);
    expect(report.cases.filter((row) => row.name.includes("capability:")).length).toBeGreaterThanOrEqual(20);
    expect(report.cases.filter((row) => row.name.includes("never settles"))).toHaveLength(6);

    for (const subject of report.subjects) {
      expect(subject.execution.dispatch.kind).toBe("dispatched");
      expect(subject.readback.kind).toBe("succeeded");
    }

    expect(fixture.cancelRequests.length).toBeGreaterThanOrEqual(2);
    expect(fixture.unattendedRequests.length).toBeGreaterThan(0);

    // refundCreate / authorizationCaptureSplit must stay absent on adapter ports.
    expect("refundCreate" in fixture.adapter).toBe(false);
    expect("refundCreate" in fixture.adapter.attemptPort).toBe(false);
    expect("refundCreate" in fixture.adapter.readbackPort).toBe(false);
    expect("createRefund" in fixture.adapter).toBe(false);
    expect("createRefund" in fixture.adapter.attemptPort).toBe(false);
    expect("createRefund" in fixture.adapter.readbackPort).toBe(false);

    assertNoCanaryLeak(report);
    fixture.fake.assertDrained();
  });

  it("validates recipe.json against JSON Schema, exact disk inventory, index.json, and staticCapabilities parity", () => {
    const recipeSchema = JSON.parse(
      readFileSync(path.resolve(RECIPE_DIR, "../../schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(path.join(RECIPE_DIR, "recipe.json"), "utf8")) as Record<string, unknown>;
    const index = JSON.parse(readFileSync(path.resolve(RECIPE_DIR, "../../index.json"), "utf8")) as {
      recipes: Array<{ id: string; manifestPath: string }>;
    };

    expect(validateAgainstJsonSchema(manifest, recipeSchema)).toEqual([]);
    expect((manifest.summary as string).length).toBeLessThanOrEqual(240);

    // Negative control: invalid egress origin + extra property must fail schema validation.
    expect(
      validateAgainstJsonSchema(
        { ...manifest, egressOrigins: ["http://insecure.example.com"], extraKey: true },
        recipeSchema,
      ).length,
    ).toBeGreaterThanOrEqual(2);

    expect(manifest.staticCapabilities).toEqual(projectMollieStaticCapabilities());

    const files = manifest.files as { allFiles: string[] };
    expect(files.allFiles).toHaveLength(9);
    for (const relPath of files.allFiles) {
      expect(existsSync(path.join(RECIPE_DIR, relPath)), `missing declared recipe file: ${relPath}`).toBe(true);
    }
    expect(files.allFiles).toEqual(listRecipeFilesOnDisk(RECIPE_DIR));

    expect(index.recipes).toContainEqual(
      expect.objectContaining({ id: "payments/mollie", manifestPath: "payments/mollie/recipe.json" }),
    );
  });

  it("converts exact integer minor units and major decimal strings without IEEE-754 float math", () => {
    expect(minorToMajorString(1299, "EUR")).toBe("12.99");
    expect(minorToMajorString(5, "EUR")).toBe("0.05");
    expect(minorToMajorString(0, "EUR")).toBe("0.00");
    expect(minorToMajorString(1000, "JPY")).toBe("1000");
    expect(minorToMajorString(1500, "KWD")).toBe("1.500");

    expect(majorStringToMinor("12.99", "EUR")).toBe(1299);
    expect(majorStringToMinor("0.05", "EUR")).toBe(5);
    expect(majorStringToMinor("0.00", "EUR")).toBe(0);
    expect(majorStringToMinor("1000", "JPY")).toBe(1000);
    expect(majorStringToMinor("1.500", "KWD")).toBe(1500);

    // Reject wrong decimal precision, negatives, whitespace, overflow, and invalid codes.
    expect(majorStringToMinor("12.9", "EUR")).toBeNull();
    expect(majorStringToMinor("12.999", "EUR")).toBeNull();
    expect(majorStringToMinor("-12.99", "EUR")).toBeNull();
    expect(majorStringToMinor(" 12.99", "EUR")).toBeNull();
    expect(majorStringToMinor("12.99 ", "EUR")).toBeNull();
    expect(majorStringToMinor("1000.00", "JPY")).toBeNull();
    expect(majorStringToMinor("99999999999999999.99", "EUR")).toBeNull();
    expect(majorStringToMinor("12.99", "XXX")).toBeNull();
    expect(majorStringToMinor("12.99", "ZZZ")).toBeNull();
    expect(() => minorToMajorString(100, "XXX")).toThrow("Invalid ISO-4217 currency code");
    expect(() => minorToMajorString(-1, "EUR")).toThrow("Invalid minor unit amount");
  });

  it("enforces cold-import zero-I/O, mode-key prefix guard, pre-dispatch refusals, first/recurring sequenceType, and createRefund", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("should not be called");
    });

    // Eager key-mode guard at construction when apiKey is a static string.
    expect(() =>
      createMollieHttpClient({ mode: "test", apiKey: MOLLIE_TEST_CANARIES.apiKeyLive, fetchImpl: fetchSpy }),
    ).toThrow(MollieTransportError);
    expect(() =>
      createMollieHttpClient({ mode: "live", apiKey: MOLLIE_TEST_CANARIES.apiKeyTest, fetchImpl: fetchSpy }),
    ).toThrow(MollieTransportError);
    expect(() => assertMollieKeyMatchesMode("test_123", "test")).toThrow(MollieTransportError);
    expect(() => assertMollieKeyMatchesMode("test_with space_123", "test")).toThrow(MollieTransportError);
    expect(() => assertMollieKeyMatchesMode("", "test")).toThrow(MollieTransportError);

    // Lazy resolver mismatch refuses before dispatch with 0 HTTP calls.
    let dynamicKey = MOLLIE_TEST_CANARIES.apiKeyLive;
    const lazyClient = createMollieHttpClient({
      mode: "test",
      apiKey: () => dynamicKey,
      fetchImpl: fetchSpy,
    });
    const lazyAdapter = createMolliePaymentAdapter({
      client: lazyClient,
      redirectUrl: MOLLIE_TEST_REDIRECT_URL,
      mode: "test",
      supportedCurrencies: ["EUR", "USD"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const keyMismatchResult = await lazyAdapter.attemptPort.execute({
      attemptRef: "att-key-mismatch",
      intentRef: "int-key-mismatch",
      fingerprint: "fp-key-mismatch",
      providerIdempotencyKey: "idem-key-mismatch",
      money: { amountMinor: 2500, currency: "EUR" },
      mode: "test",
      purpose: "initial",
    });
    expect(keyMismatchResult.dispatch).toMatchObject({
      kind: "notDispatched",
      evidence: { exact: true, phase: "before-dispatch" },
    });
    expect(keyMismatchResult.diagnostics.diagnosticCode).toBe("MOLLIE_KEY_MODE_MISMATCH");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Zero-I/O pre-dispatch refusals for invalid inputs.
    const preDispatchCases = [
      {
        label: "mode mismatch",
        input: {
          attemptRef: "a1",
          intentRef: "i1",
          fingerprint: "f1",
          providerIdempotencyKey: "k1",
          money: { amountMinor: 1000, currency: "EUR" },
          mode: "live" as const,
          purpose: "initial" as const,
        },
        code: "MOLLIE_MODE_MISMATCH",
      },
      {
        label: "saveForFutureUse without customerRef",
        input: {
          attemptRef: "a2",
          intentRef: "i2",
          fingerprint: "f2",
          providerIdempotencyKey: "k2",
          money: { amountMinor: 1000, currency: "EUR" },
          mode: "test" as const,
          purpose: "initial" as const,
          saveForFutureUse: true,
        },
        code: "MOLLIE_MISSING_CUSTOMER_REF",
      },
      {
        label: "renewal-unattended with one_time",
        input: {
          attemptRef: "a3",
          intentRef: "i3",
          fingerprint: "f3",
          providerIdempotencyKey: "k3",
          money: { amountMinor: 1000, currency: "EUR" },
          mode: "test" as const,
          purpose: "renewal-unattended" as const,
          orderMode: "one_time" as const,
          customerRef: "cst_1",
          storedMethod: { reference: "mdt_1", mandate: {} },
        },
        code: "MOLLIE_INVALID_RENEWAL_ORDER_MODE",
      },
      {
        label: "renewal-unattended missing customerRef",
        input: {
          attemptRef: "a4",
          intentRef: "i4",
          fingerprint: "f4",
          providerIdempotencyKey: "k4",
          money: { amountMinor: 1000, currency: "EUR" },
          mode: "test" as const,
          purpose: "renewal-unattended" as const,
          orderMode: "subscription_cycle" as const,
          storedMethod: { reference: "mdt_1", mandate: {} },
        },
        code: "MOLLIE_MISSING_CUSTOMER_REF",
      },
      {
        label: "unsupported method family one-time-code",
        input: {
          attemptRef: "a5",
          intentRef: "i5",
          fingerprint: "f5",
          providerIdempotencyKey: "k5",
          money: { amountMinor: 1000, currency: "EUR" },
          mode: "test" as const,
          purpose: "initial" as const,
          methodSelection: { family: "one-time-code" as const },
        },
        code: "MOLLIE_UNSUPPORTED_METHOD_FAMILY",
      },
      {
        label: "missing idempotency key",
        input: {
          attemptRef: "a6",
          intentRef: "i6",
          fingerprint: "f6",
          providerIdempotencyKey: "",
          money: { amountMinor: 1000, currency: "EUR" },
          mode: "test" as const,
          purpose: "initial" as const,
        },
        code: "MOLLIE_MISSING_ATTEMPT_IDENTITY",
      },
    ];

    for (const row of preDispatchCases) {
      const res = await lazyAdapter.attemptPort.execute(row.input);
      expect(res.dispatch.kind, row.label).toBe("notDispatched");
      expect(res.diagnostics.diagnosticCode, row.label).toBe(row.code);
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    // Valid HTTP client call: saveForFutureUse -> sequenceType:"first", pinned origin, redirect:"error".
    dynamicKey = MOLLIE_TEST_CANARIES.apiKeyTest;
    const calls: Array<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> | null }> = [];
    const liveFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const parsedBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url: urlStr, init, body: parsedBody });
      if (urlStr.endsWith("/refunds")) {
        return new Response(
          JSON.stringify({
            resource: "refund",
            id: "re_refund001",
            amount: { value: "5.00", currency: "EUR" },
            status: "queued",
            paymentId: "tr_first0001",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          resource: "payment",
          id: "tr_first0001",
          mode: "test",
          status: "open",
          amount: { value: "19.99", currency: "EUR" },
          sequenceType: "first",
          createdAt: MOLLIE_TEST_OCCURRED_AT,
          expiresAt: MOLLIE_TEST_EXPIRES_AT,
          _links: {
            checkout: { href: "https://www.mollie.com/checkout/select-method/tr_first0001" },
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const wiredClient = createMollieHttpClient({
      mode: "test",
      apiKey: MOLLIE_TEST_CANARIES.apiKeyTest,
      fetchImpl: liveFetch,
    });
    const wiredAdapter = createMolliePaymentAdapter({
      client: wiredClient,
      redirectUrl: MOLLIE_TEST_REDIRECT_URL,
      webhookUrl: MOLLIE_TEST_WEBHOOK_URL,
      mode: "test",
      supportedCurrencies: ["EUR"],
    });

    const firstExec = await wiredAdapter.attemptPort.execute({
      attemptRef: "att-first",
      intentRef: "int-first",
      fingerprint: "fp-first",
      providerIdempotencyKey: "idem-first",
      money: { amountMinor: 1999, currency: "EUR" },
      mode: "test",
      purpose: "initial",
      customerRef: "cst_first_1",
      saveForFutureUse: true,
      payer: { email: MOLLIE_TEST_CANARIES.payerEmail, name: MOLLIE_TEST_CANARIES.payerName },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${MOLLIE_API_ORIGIN}/v2/payments`);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: `Bearer ${MOLLIE_TEST_CANARIES.apiKeyTest}`,
      "idempotency-key": "idem-first",
    });
    expect(calls[0]!.body).toMatchObject({
      amount: { currency: "EUR", value: "19.99" },
      sequenceType: "first",
      customerId: "cst_first_1",
      redirectUrl: MOLLIE_TEST_REDIRECT_URL,
      webhookUrl: MOLLIE_TEST_WEBHOOK_URL,
    });
    expect(firstExec.outcome).toEqual({ kind: "attempt", status: "requires_action" });
    expect(firstExec.handoff).toEqual({
      kind: "redirect",
      url: "https://www.mollie.com/checkout/select-method/tr_first0001",
    });
    assertNoCanaryLeak(firstExec);

    // createRefund works exclusively on MollieClient and blocks path traversal.
    const refund = await wiredClient.createRefund(
      "tr_first0001",
      { amount: { currency: "EUR", value: "5.00" } },
      { idempotencyKey: "idem-refund-1" },
    );
    expect(refund.id).toBe("re_refund001");
    expect(calls[1]!.url).toBe(`${MOLLIE_API_ORIGIN}/v2/payments/tr_first0001/refunds`);

    await expect(
      wiredClient.createRefund("../evil", { amount: { currency: "EUR", value: "5.00" } }, { idempotencyKey: "k" }),
    ).rejects.toThrow(MollieTransportError);
    expect(() => assertSafeMolliePaymentId("tr_abc/../x")).toThrow(MollieTransportError);
  });

  it("enforces streaming response byte cap, redacted error bodies, and uncertain transport dispatch", async () => {
    let cancelCalled = false;
    let reads = 0;
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(64).fill(0x61));
        if (reads >= 10) controller.close();
      },
      cancel() {
        cancelCalled = true;
      },
    });

    const cappedClient = createMollieHttpClient({
      mode: "test",
      apiKey: MOLLIE_TEST_CANARIES.apiKeyTest,
      maxResponseBytes: 100,
      fetchImpl: async () => new Response(oversizedStream, { status: 200 }),
    });

    await expect(cappedClient.getPayment("tr_capped001")).rejects.toMatchObject({
      diagnosticCode: "MOLLIE_RESPONSE_TOO_LARGE",
      phase: "unknown",
    });
    expect(cancelCalled).toBe(true);

    // Error body with canaries is cancelled and redacted from MollieTransportError.
    let errorBodyCanceled = false;
    const leakBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `{"detail":"leak ${MOLLIE_TEST_CANARIES.apiKeyTest} ${MOLLIE_TEST_CANARIES.payerEmail}"}`,
          ),
        );
        controller.close();
      },
      cancel() {
        errorBodyCanceled = true;
      },
    });
    const errorClient = createMollieHttpClient({
      mode: "test",
      apiKey: MOLLIE_TEST_CANARIES.apiKeyTest,
      fetchImpl: async () => new Response(leakBody, { status: 500 }),
    });

    let caught: unknown;
    try {
      await errorClient.getPayment("tr_err001");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MollieTransportError);
    expect((caught as MollieTransportError).diagnosticCode).toBe("MOLLIE_HTTP_500");
    expect(errorBodyCanceled).toBe(true);
    assertNoCanaryLeak({ message: (caught as Error).message });

    // Transport 5xx in adapter emits status:"processing" (never sent_to_provider) and dispatch:"unknown".
    const faultAdapter = createMolliePaymentAdapter({
      client: {
        async createPayment() {
          throw new ScriptedPaymentTransportError("provider-5xx");
        },
        async getPayment() {
          throw new MollieTransportError({ diagnosticCode: "MOLLIE_REQUEST_TIMEOUT", httpStatus: null, phase: "unknown" });
        },
        async cancelPayment() {
          throw new MollieTransportError({ diagnosticCode: "MOLLIE_HTTP_422", httpStatus: 422, phase: "before-dispatch" });
        },
      },
      redirectUrl: MOLLIE_TEST_REDIRECT_URL,
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

    // Timeout on readPayment -> unknown/timeout; 422 on close -> unknown/indeterminate.
    const readTimeout = await faultAdapter.readbackPort.readPayment({
      identity: { provider: "mollie", providerPaymentRef: "tr_timeout1", intentRef: "i1", attemptRef: "a1" },
      expectedMoney: { amountMinor: 2500, currency: "EUR" },
      purpose: "active_checkout",
    });
    expect(readTimeout).toMatchObject({ kind: "unknown", reason: "timeout" });

    const close422 = await faultAdapter.readbackPort.close!({
      identity: { provider: "mollie", providerPaymentRef: "tr_422", intentRef: "i1", attemptRef: "a1" },
      expectedMoney: { amountMinor: 2500, currency: "EUR" },
      purpose: "active_checkout",
    });
    expect(close422).toMatchObject({ kind: "unknown", reason: "indeterminate" });
  });

  it("enforces readback-authenticated webhook guards: zero-I/O malformed, confused-deputy, live/test mismatch, and reusableMethod gating", async () => {
    let getCalls = 0;
    let nextPaymentResponse: Record<string, unknown> = {
      id: "tr_valid001",
      mode: "test",
      status: "paid",
      amount: { value: "25.00", currency: "EUR" },
      customerId: "cst_123",
      mandateId: "mdt_456",
      method: "creditcard",
      paidAt: MOLLIE_TEST_OCCURRED_AT,
    };

    const adapter = createMolliePaymentAdapter({
      client: {
        async createPayment() {
          throw new Error("unused");
        },
        async getPayment() {
          getCalls += 1;
          return nextPaymentResponse as never;
        },
        async cancelPayment() {
          throw new Error("unused");
        },
      },
      redirectUrl: MOLLIE_TEST_REDIRECT_URL,
      mode: "test",
      supportedCurrencies: ["EUR"],
    });

    // Zero-I/O malformed bodies (missing id, duplicate id, traversal id, invalid UTF-8, JSON body).
    const malformedBodies = [
      new Uint8Array(0),
      new TextEncoder().encode("foo=bar"),
      new TextEncoder().encode("id=tr_one&id=tr_two"),
      new TextEncoder().encode("id=../evil"),
      new TextEncoder().encode("id=bad_prefix_123"),
      new TextEncoder().encode('{"id":"tr_valid001"}'),
      new Uint8Array([0x69, 0x64, 0x3d, 0xff, 0xfe]),
    ];
    for (const rawBody of malformedBodies) {
      const res = await adapter.verifyPort.verifyAndNormalize({
        rawBody,
        headers: {},
        receivedAt: MOLLIE_TEST_OCCURRED_AT,
      });
      expect(res).toEqual({ kind: "refusal", reason: "malformed" });
    }
    expect(getCalls).toBe(0);

    // Confused deputy: webhook asks for tr_valid001, server returns tr_other999 -> signature refusal.
    nextPaymentResponse = {
      id: "tr_other999",
      mode: "test",
      status: "paid",
      amount: { value: "25.00", currency: "EUR" },
      paidAt: MOLLIE_TEST_OCCURRED_AT,
    };
    expect(
      await adapter.verifyPort.verifyAndNormalize(buildMollieWebhookInput("tr_valid001")),
    ).toEqual({ kind: "refusal", reason: "signature" });

    // Also confused deputy on readPayment & close -> unknown/indeterminate.
    expect(
      await adapter.readbackPort.readPayment({
        identity: { provider: "mollie", providerPaymentRef: "tr_valid001", intentRef: "i1", attemptRef: "a1" },
        expectedMoney: { amountMinor: 2500, currency: "EUR" },
        purpose: "active_checkout",
      }),
    ).toMatchObject({ kind: "unknown", reason: "indeterminate" });

    // Live/test mismatch -> unsupported-event in webhook, unknown/indeterminate in readback.
    nextPaymentResponse = {
      id: "tr_valid001",
      mode: "live",
      status: "paid",
      amount: { value: "25.00", currency: "EUR" },
      paidAt: MOLLIE_TEST_OCCURRED_AT,
    };
    expect(
      await adapter.verifyPort.verifyAndNormalize(buildMollieWebhookInput("tr_valid001")),
    ).toEqual({ kind: "refusal", reason: "unsupported-event" });

    // reusableMethod attached ONLY when status === "paid" and mandateId is present.
    nextPaymentResponse = {
      id: "tr_valid001",
      mode: "test",
      status: "paid",
      amount: { value: "25.00", currency: "EUR" },
      customerId: "cst_123",
      mandateId: "mdt_456",
      method: "creditcard",
      paidAt: MOLLIE_TEST_OCCURRED_AT,
    };
    const paidWithMandate = await adapter.verifyPort.verifyAndNormalize(
      buildMollieWebhookInput("tr_valid001"),
    );
    expect(paidWithMandate.kind).toBe("money");
    if (paidWithMandate.kind !== "money") throw new Error("expected money");
    expect(paidWithMandate.reusableMethod).toEqual({
      providerCustomerRef: "cst_123",
      providerMethodRef: "mdt_456",
      providerMandateRef: "mdt_456",
      methodKind: "creditcard",
      status: "active",
    });

    // Failed, open, refunded, and disputed MUST NOT attach reusableMethod even when mandateId is present.
    for (const variant of [
      { status: "failed", failedAt: MOLLIE_TEST_OCCURRED_AT },
      { status: "open", createdAt: MOLLIE_TEST_OCCURRED_AT },
      { status: "paid", amountRefunded: { value: "10.00", currency: "EUR" }, paidAt: MOLLIE_TEST_OCCURRED_AT },
      { status: "paid", amountChargedBack: { value: "25.00", currency: "EUR" }, paidAt: MOLLIE_TEST_OCCURRED_AT },
    ]) {
      nextPaymentResponse = {
        id: "tr_valid001",
        mode: "test",
        amount: { value: "25.00", currency: "EUR" },
        customerId: "cst_123",
        mandateId: "mdt_456",
        ...variant,
      };
      const ev = await adapter.verifyPort.verifyAndNormalize(buildMollieWebhookInput("tr_valid001"));
      expect(ev.kind).toBe("money");
      if (ev.kind !== "money") throw new Error("expected money");
      expect(ev.reusableMethod).toBeUndefined();
    }

    // Regression (mollie-a-1): Mollie session timeout (status:"expired" without card failureReason)
    // MUST classify as indeterminate (NOT credentialDead / hard_do_not_retry), while
    // details.failureReason:"card_expired" MUST classify as hard_do_not_retry.
    nextPaymentResponse = {
      id: "tr_expiredSession01",
      mode: "test",
      status: "expired",
      amount: { value: "25.00", currency: "EUR" },
      expiredAt: MOLLIE_TEST_OCCURRED_AT,
    };
    const expiredSession = await adapter.verifyPort.verifyAndNormalize(
      buildMollieWebhookInput("tr_expiredSession01"),
    );
    expect(expiredSession.kind).toBe("money");
    if (expiredSession.kind !== "money") throw new Error("expected money");
    expect(expiredSession.outcome).toBe("failed");
    expect(expiredSession.refusal?.code).toBe("indeterminate");

    nextPaymentResponse = {
      id: "tr_expiredCard01",
      mode: "test",
      status: "failed",
      amount: { value: "25.00", currency: "EUR" },
      failedAt: MOLLIE_TEST_OCCURRED_AT,
      details: { failureReason: "card_expired", failureMessage: "The card has expired" },
    };
    const expiredCard = await adapter.verifyPort.verifyAndNormalize(
      buildMollieWebhookInput("tr_expiredCard01"),
    );
    expect(expiredCard.kind).toBe("money");
    if (expiredCard.kind !== "money") throw new Error("expected money");
    expect(expiredCard.outcome).toBe("failed");
    expect(expiredCard.refusal?.code).toBe("hard_do_not_retry");
  });

  it("rejects planted-defect negative controls in runPaymentAdapterConformance", async () => {
    // Defect #1: Declared method family missing from capabilities fails capture flow conformance.
    const fixture1 = createMollieSafetyFixture();
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
              methodFamilies: ["card", "bank-redirect"] as const,
            },
          ],
        },
      },
    }));
    await expect(runPaymentAdapterConformance(brokenCapsSubjects)).rejects.toThrow(
      "payment_adapter_conformance:capture flow declared",
    );

    // Defect #2: Exposing refundCreate on readbackPort violates unsupported-operation invariant.
    const fixture2 = createMollieSafetyFixture();
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
