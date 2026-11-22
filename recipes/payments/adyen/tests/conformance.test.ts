import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  runPaymentAdapterConformance,
  ScriptedPaymentTransportError,
} from "@openlup/platform/payments/testing";
import {
  ADYEN_TEST_CHECKOUT_ORIGIN,
  AdyenTransportError,
  createAdyenHttpClient,
  createAdyenPaymentAdapter,
  escapeAdyenHmacField,
  projectAdyenStaticCapabilities,
  resolveAdyenCheckoutBaseUrl,
} from "../server/index.js";
import { mountAdyenDropin, parseAdyenSessionHandoff } from "../browser/index.js";
import {
  ADYEN_TEST_CANARIES,
  ADYEN_TEST_MERCHANT_ACCOUNT,
  ADYEN_TEST_RETURN_URL,
  buildSignedAdyenWebhook,
  createAdyenSafetyFixture,
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
    ADYEN_TEST_CANARIES.apiKey,
    ADYEN_TEST_CANARIES.hmacKeyHex,
    ADYEN_TEST_CANARIES.sessionData,
    ADYEN_TEST_CANARIES.payerEmail,
    ADYEN_TEST_CANARIES.payerName,
    ...extraCanaries,
  ];
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(encodeURIComponent(canary));
  }
}

describe("recipes/payments/adyen — Stage 1 & Stage 2 conformance + anti-slop gates", () => {
  it("passes the official @openlup/platform/payments/testing safety conformance suite", async () => {
    const fixture = createAdyenSafetyFixture();
    const report = await runPaymentAdapterConformance(fixture.subjects);

    expect(report.subjects.map((row) => row.subjectId)).toEqual(["attempt-us-usd", "attempt-eu-eur"]);
    expect(report.cases.every((row) => row.passed)).toBe(true);
    expect(report.cases.filter((row) => row.name.includes("capability:")).length).toBeGreaterThanOrEqual(20);
    expect(report.cases.filter((row) => row.name.includes("never settles"))).toHaveLength(6);

    for (const subject of report.subjects) {
      expect(subject.execution.dispatch.kind).toBe("dispatched");
      expect(subject.readback.kind).toBe("unsupported");
      expect(subject.execution).not.toHaveProperty("handoff");
    }

    // Async Adyen /cancels returns honest "pending" (never fabricated terminal "failed").
    expect(fixture.cancelRequests.length).toBeGreaterThanOrEqual(2);
    expect(fixture.unattendedRequests.length).toBeGreaterThan(0);
    assertNoCanaryLeak(report);
    fixture.fake.assertDrained();
  });

  it("validates recipe.json and browser/csp.json against JSON Schemas, exact disk inventory, and staticCapabilities parity", () => {
    const recipeSchema = JSON.parse(
      readFileSync(path.resolve(RECIPE_DIR, "../../schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const cspSchema = JSON.parse(
      readFileSync(path.resolve(RECIPE_DIR, "../../schema/csp.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(path.join(RECIPE_DIR, "recipe.json"), "utf8")) as Record<string, unknown>;
    const csp = JSON.parse(readFileSync(path.join(RECIPE_DIR, "browser/csp.json"), "utf8")) as Record<string, unknown>;
    const index = JSON.parse(readFileSync(path.resolve(RECIPE_DIR, "../../index.json"), "utf8")) as {
      recipes: Array<{ id: string; manifestPath: string }>;
    };

    // Full JSON Schema validation (including egressOrigins regex with {liveUrlPrefix} and if/then browserSurface).
    expect(validateAgainstJsonSchema(manifest, recipeSchema)).toEqual([]);
    expect(validateAgainstJsonSchema(csp, cspSchema)).toEqual([]);

    // Negative control: invalid egress origin or unexpected extra property must fail schema validation.
    expect(
      validateAgainstJsonSchema(
        { ...manifest, egressOrigins: ["http://insecure.example.com"], extraKey: true },
        recipeSchema,
      ).length,
    ).toBeGreaterThanOrEqual(2);

    expect(manifest.staticCapabilities).toEqual(projectAdyenStaticCapabilities());

    // Exact bidirectional parity between files.allFiles and files on disk.
    const files = manifest.files as { allFiles: string[] };
    for (const relPath of files.allFiles) {
      expect(existsSync(path.join(RECIPE_DIR, relPath)), `missing declared recipe file: ${relPath}`).toBe(true);
    }
    expect([...files.allFiles].sort()).toEqual(listRecipeFilesOnDisk(RECIPE_DIR));

    // Recipe is indexed in recipes/index.json.
    expect(index.recipes).toContainEqual(
      expect.objectContaining({ id: "payments/adyen", manifestPath: "payments/adyen/recipe.json" }),
    );
  });

  it("enforces cold-import zero-I/O, strict origin/prefix/redirect hardening, and honest dispatch uncertainty on transport faults", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("should not be called during construction");
    });

    const httpClient = createAdyenHttpClient({
      mode: "test",
      apiKey: () => ADYEN_TEST_CANARIES.apiKey,
      fetchImpl: fetchSpy,
    });
    const adapter = createAdyenPaymentAdapter({
      client: httpClient,
      merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
      returnUrl: ADYEN_TEST_RETURN_URL,
      hmacKeysHex: [ADYEN_TEST_CANARIES.hmacKeyHex],
      mode: "test",
      supportedCurrencies: ["USD"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Live URL prefix injection guard.
    expect(resolveAdyenCheckoutBaseUrl({ mode: "test" })).toBe(`${ADYEN_TEST_CHECKOUT_ORIGIN}/v71`);
    expect(resolveAdyenCheckoutBaseUrl({ mode: "live", liveUrlPrefix: "1797a841fbb37ca7-AdyenDemo" })).toBe(
      "https://1797a841fbb37ca7-AdyenDemo-checkout-live.adyenpayments.com/v71",
    );
    expect(() => resolveAdyenCheckoutBaseUrl({ mode: "live" })).toThrow();
    expect(() => resolveAdyenCheckoutBaseUrl({ mode: "live", liveUrlPrefix: "evil.example.com/x" })).toThrow();

    // Zero-I/O currency refusal before any HTTP call.
    const refused = await adapter.attemptPort.execute({
      attemptRef: "att-1",
      intentRef: "int-1",
      fingerprint: "fp-1",
      providerIdempotencyKey: "idem-1",
      money: { amountMinor: 1000, currency: "EUR" },
      mode: "test",
      purpose: "initial",
      payer: { email: ADYEN_TEST_CANARIES.payerEmail, name: ADYEN_TEST_CANARIES.payerName },
    });
    expect(refused.dispatch.kind).toBe("notDispatched");
    expect(fetchSpy).not.toHaveBeenCalled();
    assertNoCanaryLeak(refused);

    // Outbound HTTP request pins HTTPS origin, passes redirect:"error", X-API-Key, Idempotency-Key.
    const capturedCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const liveFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          id: "CS_SESSION_01",
          sessionData: ADYEN_TEST_CANARIES.sessionData,
          amount: { currency: "USD", value: 2500 },
          reference: "int-2",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const wiredClient = createAdyenHttpClient({
      mode: "test",
      apiKey: ADYEN_TEST_CANARIES.apiKey,
      fetchImpl: liveFetch,
    });
    const wiredAdapter = createAdyenPaymentAdapter({
      client: wiredClient,
      merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
      returnUrl: ADYEN_TEST_RETURN_URL,
      hmacKeysHex: [ADYEN_TEST_CANARIES.hmacKeyHex],
      mode: "test",
      supportedCurrencies: ["USD"],
    });

    const envelope = await wiredAdapter.attemptPort.execute({
      attemptRef: "att-2",
      intentRef: "int-2",
      fingerprint: "fp-2",
      providerIdempotencyKey: "idem-2",
      money: { amountMinor: 2500, currency: "USD" },
      mode: "test",
      purpose: "initial",
      payer: { email: ADYEN_TEST_CANARIES.payerEmail, name: ADYEN_TEST_CANARIES.payerName },
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.url).toBe("https://checkout-test.adyen.com/v71/sessions");
    expect(capturedCalls[0]!.init?.redirect).toBe("error");
    expect(capturedCalls[0]!.init?.headers).toMatchObject({
      "x-api-key": ADYEN_TEST_CANARIES.apiKey,
      "idempotency-key": "idem-2",
    });
    expect(envelope.handoff?.kind).toBe("client-confirmed");

    // Canary scan across diagnostics + persistence (sessionData MUST stay strictly inside transient handoff).
    assertNoCanaryLeak({ diagnostics: envelope.diagnostics, persistence: envelope.persistence });

    // Transport 5xx must preserve dispatch uncertainty (never fabricate exact notDispatched).
    const faultAdapter = createAdyenPaymentAdapter({
      client: {
        async createSession() {
          throw new ScriptedPaymentTransportError("provider-5xx");
        },
        async createPayment() {
          return {
            pspReference: "8836_REDIRECT_HTTP",
            resultCode: "RedirectShopper",
            action: { type: "redirect", url: "http://insecure.example.test/pay" },
          };
        },
      },
      merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
      returnUrl: ADYEN_TEST_RETURN_URL,
      hmacKeysHex: [ADYEN_TEST_CANARIES.hmacKeyHex],
      mode: "test",
      supportedCurrencies: ["USD"],
    });
    const uncertain = await faultAdapter.attemptPort.execute({
      attemptRef: "att-5xx",
      intentRef: "int-5xx",
      fingerprint: "fp-5xx",
      providerIdempotencyKey: "idem-5xx",
      money: { amountMinor: 2500, currency: "USD" },
      mode: "test",
      purpose: "initial",
    });
    expect(uncertain.dispatch).toEqual({ kind: "unknown" });
    expect(uncertain.outcome).toEqual({ kind: "attempt", status: "processing" });

    // Non-HTTPS redirect action URL is refused rather than emitted as a redirect handoff.
    const badRedirect = await faultAdapter.attemptPort.execute({
      attemptRef: "att-redir",
      intentRef: "int-redir",
      fingerprint: "fp-redir",
      providerIdempotencyKey: "idem-redir",
      money: { amountMinor: 2500, currency: "USD" },
      mode: "test",
      purpose: "initial",
      methodSelection: { family: "bank-redirect" },
    });
    expect(badRedirect.handoff).toBeUndefined();
    expect(badRedirect.diagnostics.diagnosticCode).toBe("ADYEN_INVALID_REDIRECT_URL");

    // Path traversal refusal on cancelPayment.
    await expect(
      wiredClient.cancelPayment("../evil", { merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT, reference: "c1" }, { idempotencyKey: "k1" }),
    ).rejects.toThrow("Invalid Adyen pspReference");
  });

  it("redacts raw provider error bodies and secrets in AdyenTransportError and execution envelopes", async () => {
    const errorFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 500,
          message: `Internal leak ${ADYEN_TEST_CANARIES.apiKey} ${ADYEN_TEST_CANARIES.payerEmail}`,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createAdyenHttpClient({
      mode: "test",
      apiKey: ADYEN_TEST_CANARIES.apiKey,
      fetchImpl: errorFetch,
    });

    let thrownError: unknown;
    try {
      await client.createSession(
        {
          merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
          amount: { currency: "USD", value: 1000 },
          reference: "int-err",
          returnUrl: ADYEN_TEST_RETURN_URL,
        },
        { idempotencyKey: "idem-err" },
      );
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(AdyenTransportError);
    expect((thrownError as AdyenTransportError).diagnosticCode).toBe("ADYEN_HTTP_500");
    assertNoCanaryLeak({ message: (thrownError as Error).message });
  });

  it("enforces HMAC-authoritative intentRef, safe reusableMethod gating, key-length/rotation rules, and planted-defect negative controls", async () => {
    const rotatedKeyHex = "ffeeddcc".repeat(8);
    const inertClient = createAdyenHttpClient({
      mode: "test",
      apiKey: ADYEN_TEST_CANARIES.apiKey,
      fetchImpl: async () => {
        throw new Error("no outbound HTTP during webhook verification");
      },
    });

    // Reject weak/short HMAC hex keys (< 16 bytes / 32 hex chars).
    expect(() =>
      createAdyenPaymentAdapter({
        client: inertClient,
        merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
        returnUrl: ADYEN_TEST_RETURN_URL,
        hmacKeysHex: ["abcd"],
        mode: "test",
        supportedCurrencies: ["USD"],
      }),
    ).toThrow("Invalid Adyen HMAC hex key");

    const adapter = createAdyenPaymentAdapter({
      client: inertClient,
      merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
      returnUrl: ADYEN_TEST_RETURN_URL,
      hmacKeysHex: [rotatedKeyHex, ADYEN_TEST_CANARIES.hmacKeyHex],
      mode: "test",
      supportedCurrencies: ["USD"],
    });

    // Verify canonical backslash + colon escaping order (`\` -> `\\`, `:` -> `\:`).
    expect(escapeAdyenHmacField("a\\b:c")).toBe("a\\\\b\\:c");

    // Signed with secondary (rotating) key, special characters in merchantReference, missing eventDate -> providerOccurredAt: null.
    const webhook = buildSignedAdyenWebhook({
      pspReference: "8836999900001111",
      merchantReference: "ord:2026\\01",
      attemptRef: "attempt-special",
      amount: { value: 1999, currency: "USD" },
      eventCode: "AUTHORISATION",
      success: "true",
      eventDate: null,
      hmacKeyHex: ADYEN_TEST_CANARIES.hmacKeyHex,
    });

    const verified = await adapter.verifyPort.verifyAndNormalize(webhook);
    expect(verified.kind).toBe("money");
    if (verified.kind !== "money") throw new Error("expected money evidence");
    expect(verified.intentRef).toBe("ord:2026\\01");
    expect(verified.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(verified.providerOccurredAt).toBeNull();
    assertNoCanaryLeak(verified, [rotatedKeyHex]);

    // Security regression #1: unsigned metadata.intentRef differing from HMAC-signed merchantReference MUST be refused.
    const spoofedIntent = buildSignedAdyenWebhook({
      pspReference: "8836999900001112",
      merchantReference: "intent-authentic",
      intentRef: "intent-spoofed-victim",
      amount: { value: 1999, currency: "USD" },
      eventCode: "AUTHORISATION",
      success: "true",
      hmacKeyHex: rotatedKeyHex,
    });
    expect(await adapter.verifyPort.verifyAndNormalize(spoofedIntent)).toEqual({
      kind: "refusal",
      reason: "malformed",
    });

    // Security regression #2: failed RECURRING_CONTRACT must never attach reusableMethod with status:"active".
    const failedContract = buildSignedAdyenWebhook({
      pspReference: "8836999900001113",
      merchantReference: "intent-contract-fail",
      eventCode: "RECURRING_CONTRACT",
      success: "false",
      recurringDetailReference: "TOKEN_FAILED_1",
      shopperReference: "shopper-1",
      hmacKeyHex: rotatedKeyHex,
    });
    const failedContractResult = await adapter.verifyPort.verifyAndNormalize(failedContract);
    expect(failedContractResult.kind).toBe("method");
    if (failedContractResult.kind !== "method") throw new Error("expected method evidence");
    expect(failedContractResult.outcome).toBe("failed");
    expect(failedContractResult.reusableMethod).toBeUndefined();

    // Security regression #3: failed/refunded/disputed money events with recurring additionalData must never attach reusableMethod.
    for (const [eventCode, success] of [
      ["AUTHORISATION", "false"],
      ["REFUND", "true"],
      ["CHARGEBACK", "true"],
    ] as const) {
      const nonSuccessEvent = buildSignedAdyenWebhook({
        pspReference: `8836_${eventCode}`,
        merchantReference: "intent-no-active-method",
        amount: { value: 1999, currency: "USD" },
        eventCode,
        success,
        recurringDetailReference: "TOKEN_SHOULD_NOT_ACTIVATE",
        shopperReference: "shopper-1",
        hmacKeyHex: rotatedKeyHex,
      });
      const res = await adapter.verifyPort.verifyAndNormalize(nonSuccessEvent);
      expect(res.kind).toBe("money");
      if (res.kind !== "money") throw new Error("expected money evidence");
      expect(res.reusableMethod).toBeUndefined();
    }

    // CHARGEBACK with success:"false" is ignored as unsupported-event.
    const failedChargeback = buildSignedAdyenWebhook({
      pspReference: "8836_CB_FALSE",
      merchantReference: "intent-cb-false",
      amount: { value: 1999, currency: "USD" },
      eventCode: "CHARGEBACK",
      success: "false",
      hmacKeyHex: rotatedKeyHex,
    });
    expect(await adapter.verifyPort.verifyAndNormalize(failedChargeback)).toEqual({
      kind: "refusal",
      reason: "unsupported-event",
    });

    // Planted-defect negative control #1: live/test mismatch is rejected even with valid HMAC.
    const liveMismatch = buildSignedAdyenWebhook({
      pspReference: "8836999900002222",
      merchantReference: "intent-live",
      amount: { value: 1999, currency: "USD" },
      eventCode: "AUTHORISATION",
      success: "true",
      live: "true",
      hmacKeyHex: rotatedKeyHex,
    });
    expect(await adapter.verifyPort.verifyAndNormalize(liveMismatch)).toEqual({
      kind: "refusal",
      reason: "unsupported-event",
    });

    // Planted-defect negative control #2: single-byte mutation breaks HMAC verification.
    const mutatedBytes = new Uint8Array(webhook.rawBody);
    const bodyStr = new TextDecoder().decode(mutatedBytes).replace("1999", "1998");
    const mutatedResult = await adapter.verifyPort.verifyAndNormalize({
      ...webhook,
      rawBody: new TextEncoder().encode(bodyStr),
    });
    expect(mutatedResult).toEqual({ kind: "refusal", reason: "signature" });
  });

  it("verifies browser Drop-in contract and degraded/fallback states cleanly", async () => {
    const copy = {
      unavailable: "Payment form unavailable",
      loading: "Loading payment options...",
      loadFailed: "Could not load payment form",
      loadRetry: "Try again",
      loadAlternative: "Use another method",
    };

    // Missing/malformed handoff transitions to unavailable without throwing.
    expect(parseAdyenSessionHandoff("not-json")).toBeNull();
    const unavailableStates: unknown[] = [];
    const handleMissing = await mountAdyenDropin({
      handoffPayload: null,
      environment: "test",
      clientKey: "test_CLIENT_KEY",
      container: {},
      copy,
      loader: null,
      onStateChange: (s) => unavailableStates.push(s),
      onSettled: () => undefined,
    });
    expect(handleMissing).toBeNull();
    expect(unavailableStates).toEqual([{ status: "unavailable", message: copy.unavailable }]);

    // Script load failure transitions to explicit loadFailed with retry/alternative labels.
    const failedStates: unknown[] = [];
    const validPayload = JSON.stringify({ id: "CS_1", sessionData: ADYEN_TEST_CANARIES.sessionData });
    await mountAdyenDropin({
      handoffPayload: validPayload,
      environment: "test",
      clientKey: "test_CLIENT_KEY",
      container: {},
      copy,
      loader: {
        async load() {
          throw new Error("CDN blocked");
        },
      },
      onStateChange: (s) => failedStates.push(s),
      onSettled: () => undefined,
    });
    expect(failedStates).toEqual([
      { status: "loading", message: copy.loading },
      {
        status: "loadFailed",
        message: copy.loadFailed,
        retryLabel: copy.loadRetry,
        alternativeLabel: copy.loadAlternative,
      },
    ]);

    // Happy mount + settlement callback.
    const happyStates: unknown[] = [];
    const settlements: unknown[] = [];
    const unmount = vi.fn();
    const handle = await mountAdyenDropin({
      handoffPayload: validPayload,
      environment: "test",
      clientKey: "test_CLIENT_KEY",
      container: { id: "dropin-root" },
      copy,
      loader: {
        async load(opts) {
          expect(opts.session.id).toBe("CS_1");
          return {
            mount() {
              opts.onPaymentCompleted({ resultCode: "Authorised" });
              return { unmount };
            },
          };
        },
      },
      onStateChange: (s) => happyStates.push(s),
      onSettled: (s) => settlements.push(s),
    });
    expect(happyStates).toEqual([
      { status: "loading", message: copy.loading },
      { status: "ready" },
    ]);
    expect(settlements).toEqual([{ status: "submitted", resultCode: "Authorised" }]);
    handle?.unmount();
    expect(unmount).toHaveBeenCalledTimes(1);
  });
});
