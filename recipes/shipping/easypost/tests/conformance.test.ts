import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createScriptedShippingRateFake,
  runShippingRateAdapterConformance,
  type ScriptedShippingRateOutcome,
  type ShippingRateAdapterTestSubject,
  type ShippingRateScenarioHarness,
} from "@openlup/platform/shipping/testing";
import type { CarrierRateQuoteResult } from "@openlup/platform/shipping/contracts";
import {
  createEasyPostCarrierRateAdapter,
  createEasyPostHttpClient,
  EASYPOST_SHIPMENTS_URL,
  easypostCarrierRateCapabilities,
  EasyPostTransportError,
  gramsToOunces,
  mmToInches,
  parseExactDecimalToMinor,
  parseRetryAfterHeader,
  projectEasyPostStaticCapabilities,
  type EasyPostCreateShipmentInput,
  type EasyPostRateClient,
  type EasyPostShipmentResponse,
} from "../server/index.js";
import {
  createEmptyRatesShipmentResponse,
  createHappyMultiCarrierShipmentResponse,
  EASYPOST_BASE_REQUEST,
  EASYPOST_DECIMAL_MONEY_CASES,
  EASYPOST_TEST_CANARIES,
} from "./fixtures.js";

const RECIPE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type EasyPostFakeCalls = {
  createShipmentRates: EasyPostShipmentResponse;
};

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
    EASYPOST_TEST_CANARIES.apiKey,
    EASYPOST_TEST_CANARIES.altApiKey,
    EASYPOST_TEST_CANARIES.rawErrorSecret,
    ...extraCanaries,
  ];
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(encodeURIComponent(canary));
    expect(serialized).not.toContain(Buffer.from(canary, "utf8").toString("base64"));
  }
}

function createScriptedHarness(
  outcome: ScriptedShippingRateOutcome<EasyPostShipmentResponse>,
  adapterConfig?: {
    readonly supportedCurrencies?: readonly string[];
    readonly supportedOriginCountries?: readonly string[] | "any";
    readonly supportedDestinationCountries?: readonly string[] | "any";
    readonly mutateResult?: (result: CarrierRateQuoteResult) => CarrierRateQuoteResult;
  },
): ShippingRateScenarioHarness & { readonly recordedInputs: EasyPostCreateShipmentInput[] } {
  const fake = createScriptedShippingRateFake<EasyPostFakeCalls>();
  fake.enqueue("createShipmentRates", outcome);
  const recordedInputs: EasyPostCreateShipmentInput[] = [];

  const client: EasyPostRateClient = {
    async createShipmentRates(input) {
      recordedInputs.push(input);
      return fake.invoke("createShipmentRates");
    },
  };

  const baseAdapter = createEasyPostCarrierRateAdapter({
    client,
    supportedCurrencies: adapterConfig?.supportedCurrencies,
    supportedOriginCountries: adapterConfig?.supportedOriginCountries,
    supportedDestinationCountries: adapterConfig?.supportedDestinationCountries,
  });

  const adapter = adapterConfig?.mutateResult
    ? {
        capabilities: baseAdapter.capabilities,
        async quoteRates(req: typeof EASYPOST_BASE_REQUEST) {
          const res = await baseAdapter.quoteRates(req);
          return adapterConfig.mutateResult!(res);
        },
      }
    : baseAdapter;

  return {
    adapter,
    request: EASYPOST_BASE_REQUEST,
    readIoCount: () => fake.calls.length,
    readFaultLog: () => fake.calls,
    recordedInputs,
  };
}

function makeConformanceSubject(
  id: string,
  adapterConfig?: {
    readonly supportedCurrencies?: readonly string[];
    readonly supportedOriginCountries?: readonly string[] | "any";
    readonly supportedDestinationCountries?: readonly string[] | "any";
  },
): ShippingRateAdapterTestSubject {
  return {
    id,
    sensitiveValues: [
      EASYPOST_TEST_CANARIES.apiKey,
      EASYPOST_TEST_CANARIES.altApiKey,
      EASYPOST_TEST_CANARIES.rawErrorSecret,
    ],
    happyQuote: () =>
      createScriptedHarness(
        { kind: "success", value: createHappyMultiCarrierShipmentResponse() },
        adapterConfig,
      ),
    noRatesQuote: () =>
      createScriptedHarness(
        { kind: "success", value: createEmptyRatesShipmentResponse() },
        adapterConfig,
      ),
    certification: {
      http5xx: () => createScriptedHarness({ kind: "http-failure", status: 503 }, adapterConfig),
      httpAuthFailure: () =>
        createScriptedHarness({ kind: "http-failure", status: 401 }, adapterConfig),
      rateLimited429: () =>
        createScriptedHarness(
          { kind: "rate-limited-429", retryAfterSeconds: 30 },
          adapterConfig,
        ),
      timeout: () => createScriptedHarness({ kind: "timeout" }, adapterConfig),
      transportError: () =>
        createScriptedHarness({ kind: "transport-error" }, adapterConfig),
    },
  };
}

describe("recipes/shipping/easypost — Stages 1 & 2 conformance + security invariants", () => {
  it("enforces cold-import zero-I/O and zero ambient fetch on module load and construction", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not invoke fetch during import or construction");
    });

    const freshClient = createEasyPostHttpClient({
      apiKey: EASYPOST_TEST_CANARIES.apiKey,
      fetchImpl: fetchSpy,
    });
    const freshAdapter = createEasyPostCarrierRateAdapter({
      client: freshClient,
      supportedCurrencies: ["USD", "EUR"],
      supportedOriginCountries: ["US"],
      supportedDestinationCountries: ["US", "CA"],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(freshAdapter.capabilities.providerKind).toBe("easypost");

    // Pre-flight zero-I/O refusal triggers zero HTTP calls.
    const refused = await freshAdapter.quoteRates({
      ...EASYPOST_BASE_REQUEST,
      destination: { countryCode: "AU", postalCode: "2000" },
    });
    expect(refused).toEqual({
      kind: "refused",
      providerKind: "easypost",
      reason: "unsupported_country",
      retryable: false,
      diagnosticCode: "UNSUPPORTED_DESTINATION_COUNTRY",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes full @openlup/platform/shipping/testing conformance for default and host-configured subjects", async () => {
    const evidence = await runShippingRateAdapterConformance(
      [
        makeConformanceSubject("easypost-default"),
        makeConformanceSubject("easypost-host-configured", {
          supportedCurrencies: ["USD", "EUR"],
          supportedOriginCountries: ["US"],
          supportedDestinationCountries: ["US", "CA"],
        }),
      ],
      { mode: "full" },
    );

    expect(evidence.mode).toBe("full");
    expect(evidence.qualifications).toHaveLength(2);
    for (const qual of evidence.qualifications) {
      expect(qual.providerKind).toBe("easypost");
      expect(qual.capabilityDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(qual.ledger.filter((entry) => entry.role === "zero-io-refusal").every((e) => e.ioDelta === 0)).toBe(true);
      expect(qual.ledger.filter((entry) => entry.role === "transport-fault")).toHaveLength(5);
    }

    const hostQual = evidence.qualifications[1]!;
    const refusalScenarios = hostQual.ledger
      .filter((entry) => entry.role === "zero-io-refusal")
      .map((entry) => entry.scenario);
    expect(refusalScenarios).toContain("unsupported_origin_country");
    expect(refusalScenarios).toContain("unsupported_country");
    expect(refusalScenarios).toContain("unsupported_currency");
    assertNoCanaryLeak(evidence);
  });

  it("converts grams/millimeters and exact BigInt decimal money strings without float drift", () => {
    // 850 g -> 29.98 oz; 1 g -> 0.04 oz; 0.1 g equivalent clamp -> 0.01 oz min
    expect(gramsToOunces(850)).toBe(29.98);
    expect(gramsToOunces(1)).toBe(0.01 * 4); // 0.04
    expect(gramsToOunces(0.1)).toBe(0.01);

    // 254 mm -> 10 in; 203 mm -> 7.99 in; 102 mm -> 4.02 in
    expect(mmToInches(254)).toBe(10);
    expect(mmToInches(203)).toBe(7.99);
    expect(mmToInches(102)).toBe(4.02);

    for (const tc of EASYPOST_DECIMAL_MONEY_CASES) {
      expect(parseExactDecimalToMinor(tc.raw, tc.currency)).toBe(tc.expectedMinor);
    }
  });

  it("maps units, filters currencies & serviceFilter, sorts deterministically, and handles malformed 2xx payloads", async () => {
    const harness = createScriptedHarness({
      kind: "success",
      value: createHappyMultiCarrierShipmentResponse(),
    });

    const quoted = await harness.adapter.quoteRates(EASYPOST_BASE_REQUEST);
    expect(harness.recordedInputs).toHaveLength(1);
    expect(harness.recordedInputs[0]).toEqual({
      shipment: {
        from_address: {
          country: "US",
          zip: "94107",
          state: "CA",
          city: "San Francisco",
        },
        to_address: {
          country: "US",
          zip: "10001",
          state: "NY",
          city: "New York",
          residential: true,
        },
        parcel: {
          weight: 29.98,
          length: 10,
          width: 7.99,
          height: 4.02,
        },
        reference: "ep-quote-req-001",
      },
    });

    expect(quoted).toEqual({
      kind: "quoted",
      providerKind: "easypost",
      currency: "USD",
      providerShipmentRef: "shp_ep_fixture_001",
      rates: [
        {
          carrierCode: "USPS",
          serviceCode: "Priority",
          serviceName: "USPS Priority",
          deliveryKind: "courier",
          amountMinor: 795,
          currency: "USD",
          estimatedTransitDays: { min: 3, max: 3 },
          deliveryDateGuaranteed: false,
          providerRateRef: "rate_usps_priority",
        },
        {
          carrierCode: "UPS",
          serviceCode: "Ground",
          serviceName: "UPS Ground",
          deliveryKind: "courier",
          amountMinor: 1140,
          currency: "USD",
          estimatedTransitDays: { min: 4, max: 4 },
          deliveryDateGuaranteed: false,
          providerRateRef: "rate_ups_ground",
        },
        {
          carrierCode: "FedEx",
          serviceCode: "2Day",
          serviceName: "FedEx 2Day",
          deliveryKind: "courier",
          amountMinor: 1850,
          currency: "USD",
          estimatedTransitDays: { min: 2, max: 2 },
          deliveryDateGuaranteed: true,
          providerRateRef: "rate_fedex_2day",
        },
      ],
    });

    // serviceFilter matches either bare service or `${carrier}:${service}`.
    const filteredHarness = createScriptedHarness({
      kind: "success",
      value: createHappyMultiCarrierShipmentResponse(),
    });
    const filtered = await filteredHarness.adapter.quoteRates({
      ...EASYPOST_BASE_REQUEST,
      serviceFilter: ["UPS:Ground", "2Day"],
    });
    expect(filtered.kind).toBe("quoted");
    if (filtered.kind !== "quoted") throw new Error("expected quoted");
    expect(filtered.rates.map((r) => `${r.carrierCode}:${r.serviceCode}`)).toEqual([
      "UPS:Ground",
      "FedEx:2Day",
    ]);

    // Filter leaving zero eligible rates returns no_rates.
    const noMatchHarness = createScriptedHarness({
      kind: "success",
      value: createHappyMultiCarrierShipmentResponse(),
    });
    const noMatch = await noMatchHarness.adapter.quoteRates({
      ...EASYPOST_BASE_REQUEST,
      serviceFilter: ["NonExistentService"],
    });
    expect(noMatch).toEqual({
      kind: "no_rates",
      providerKind: "easypost",
      diagnosticCode: "NO_ELIGIBLE_RATES",
    });

    // Malformed 2xx payloads refuse cleanly without throwing.
    const malformedPayloads: unknown[] = [
      null,
      {},
      { id: "shp_bad", rates: "not-an-array" },
      { id: "shp_bad", rates: [{ carrier: "USPS", service: "Priority", currency: "USD", rate: "7.955" }] },
      { id: "shp_bad", rates: [{ carrier: "", service: "Priority", currency: "USD", rate: "7.95" }] },
    ];
    for (const payload of malformedPayloads) {
      const badClient: EasyPostRateClient = {
        async createShipmentRates() {
          return payload as EasyPostShipmentResponse;
        },
      };
      const badAdapter = createEasyPostCarrierRateAdapter({ client: badClient });
      const res = await badAdapter.quoteRates(EASYPOST_BASE_REQUEST);
      expect(res).toEqual({
        kind: "refused",
        providerKind: "easypost",
        reason: "provider_error",
        retryable: false,
        diagnosticCode: "EASYPOST_MALFORMED_RESPONSE",
      });
    }
  });

  it("hardens HTTP client: Basic Auth, redirect:error, body cap, cancel non-2xx, Retry-After, timeouts, and canary redaction", async () => {
    // Reject empty/whitespace apiKey at construction without echoing apiKey.
    for (const badKey of ["", "   ", "bad\nkey", "bad key"]) {
      let caught: unknown;
      try {
        createEasyPostHttpClient({
          apiKey: badKey,
          fetchImpl: vi.fn(),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EasyPostTransportError);
      assertNoCanaryLeak(String(caught));
    }

    // Verify Basic Auth header, pinned shipments URL, and redirect: "error".
    const expectedBasic = `Basic ${Buffer.from(`${EASYPOST_TEST_CANARIES.apiKey}:`, "utf8").toString("base64")}`;
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(EASYPOST_SHIPMENTS_URL);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(expectedBasic);
      expect(headers["content-type"]).toBe("application/json");
      return new Response(JSON.stringify(createHappyMultiCarrierShipmentResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createEasyPostHttpClient({
      apiKey: EASYPOST_TEST_CANARIES.apiKey,
      fetchImpl: fetchSpy,
    });
    const ok = await client.createShipmentRates({
      shipment: {
        from_address: { country: "US", zip: "94107" },
        to_address: { country: "US", zip: "10001" },
        parcel: { weight: 16 },
      },
    });
    expect(ok.id).toBe("shp_ep_fixture_001");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Non-2xx body must be cancelled and raw error body + apiKey must NEVER leak.
    const cancelSpy401 = vi.fn(async () => undefined);
    const fakeBody401 = {
      cancel: cancelSpy401,
      getReader: () => {
        throw new Error("non-2xx body must not be read");
      },
    } as unknown as ReadableStream<Uint8Array>;

    const authClient = createEasyPostHttpClient({
      apiKey: EASYPOST_TEST_CANARIES.apiKey,
      fetchImpl: async () =>
        ({
          ok: false,
          status: 401,
          headers: new Headers(),
          body: fakeBody401,
        }) as unknown as Response,
    });
    const authAdapter = createEasyPostCarrierRateAdapter({ client: authClient });
    const authRefusal = await authAdapter.quoteRates(EASYPOST_BASE_REQUEST);
    expect(cancelSpy401).toHaveBeenCalledTimes(1);
    expect(authRefusal).toEqual({
      kind: "refused",
      providerKind: "easypost",
      reason: "authentication_failed",
      retryable: false,
      diagnosticCode: "EASYPOST_HTTP_401",
    });
    assertNoCanaryLeak(authRefusal);

    // 429 Retry-After parsing (integer seconds and HTTP-date).
    const fixedNowMs = Date.parse("2000-06-01T12:00:00.000Z");
    expect(parseRetryAfterHeader("45", fixedNowMs)).toBe(45);
    expect(parseRetryAfterHeader("120000", fixedNowMs)).toBe(86_400);
    expect(parseRetryAfterHeader("Thu, 01 Jun 2000 12:01:15 GMT", fixedNowMs)).toBe(75);
    expect(parseRetryAfterHeader("0", fixedNowMs)).toBeUndefined();
    expect(parseRetryAfterHeader("invalid", fixedNowMs)).toBeUndefined();

    const rateLimitClient = createEasyPostHttpClient({
      apiKey: EASYPOST_TEST_CANARIES.apiKey,
      now: () => fixedNowMs,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: EASYPOST_TEST_CANARIES.rawErrorSecret }), {
          status: 429,
          headers: { "retry-after": "Thu, 01 Jun 2000 12:00:42 GMT" },
        }),
    });
    const rateLimitAdapter = createEasyPostCarrierRateAdapter({ client: rateLimitClient });
    const rateLimited = await rateLimitAdapter.quoteRates(EASYPOST_BASE_REQUEST);
    expect(rateLimited).toEqual({
      kind: "refused",
      providerKind: "easypost",
      reason: "rate_limited",
      retryable: true,
      diagnosticCode: "EASYPOST_HTTP_429",
      retryAfterSeconds: 42,
    });
    assertNoCanaryLeak(rateLimited);

    // Streaming byte cap exceeded cancels reader and refuses safely.
    const streamCancelSpy = vi.fn(async () => undefined);
    const oversizedChunk = new Uint8Array(64).fill(0x61);
    let reads = 0;
    const oversizedResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return reads <= 3
              ? { done: false, value: oversizedChunk }
              : { done: true, value: undefined };
          },
          cancel: streamCancelSpy,
          releaseLock: () => undefined,
        }),
      },
    } as unknown as Response;

    const cappedClient = createEasyPostHttpClient({
      apiKey: EASYPOST_TEST_CANARIES.apiKey,
      maxResponseBytes: 100,
      fetchImpl: async () => oversizedResponse,
    });
    const cappedAdapter = createEasyPostCarrierRateAdapter({ client: cappedClient });
    const cappedResult = await cappedAdapter.quoteRates(EASYPOST_BASE_REQUEST);
    expect(streamCancelSpy).toHaveBeenCalledTimes(1);
    expect(cappedResult).toEqual({
      kind: "refused",
      providerKind: "easypost",
      reason: "provider_error",
      retryable: false,
      diagnosticCode: "EASYPOST_RESPONSE_TOO_LARGE",
    });

    // Malformed non-JSON 2xx response maps cleanly.
    const malformedJsonClient = createEasyPostHttpClient({
      apiKey: EASYPOST_TEST_CANARIES.apiKey,
      fetchImpl: async () =>
        new Response(`<html>${EASYPOST_TEST_CANARIES.rawErrorSecret}</html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    const malformedJsonAdapter = createEasyPostCarrierRateAdapter({ client: malformedJsonClient });
    const malformedJsonRes = await malformedJsonAdapter.quoteRates(EASYPOST_BASE_REQUEST);
    expect(malformedJsonRes).toEqual({
      kind: "refused",
      providerKind: "easypost",
      reason: "provider_error",
      retryable: false,
      diagnosticCode: "EASYPOST_MALFORMED_RESPONSE",
    });
    assertNoCanaryLeak(malformedJsonRes);

    // Caller AbortSignal triggers timeout refusal without leaking message.
    const abortController = new AbortController();
    abortController.abort(new Error(EASYPOST_TEST_CANARIES.rawErrorSecret));
    const abortClient = createEasyPostHttpClient({
      apiKey: EASYPOST_TEST_CANARIES.apiKey,
      fetchImpl: async () => {
        throw new Error("should not reach fetch when caller signal already aborted");
      },
    });
    const abortAdapter = createEasyPostCarrierRateAdapter({ client: abortClient });
    const abortRes = await abortAdapter.quoteRates({
      ...EASYPOST_BASE_REQUEST,
      signal: abortController.signal,
    });
    expect(abortRes).toEqual({
      kind: "refused",
      providerKind: "easypost",
      reason: "timeout",
      retryable: true,
      diagnosticCode: "EASYPOST_TIMEOUT",
    });
    assertNoCanaryLeak(abortRes);
  });

  it("validates recipe.json against schema, staticCapabilities parity, and exact sorted disk inventory", () => {
    const recipeSchema = JSON.parse(
      readFileSync(path.resolve(RECIPE_DIR, "../../schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(
      readFileSync(path.join(RECIPE_DIR, "recipe.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(validateAgainstJsonSchema(manifest, recipeSchema)).toEqual([]);
    expect((manifest.summary as string).length).toBeLessThanOrEqual(240);

    // Negative control: invalid egress origin + extra property fails schema validation.
    expect(
      validateAgainstJsonSchema(
        { ...manifest, egressOrigins: ["http://insecure.example.com"], extraKey: true },
        recipeSchema,
      ).length,
    ).toBeGreaterThanOrEqual(2);

    expect(manifest.staticCapabilities).toEqual(
      projectEasyPostStaticCapabilities(easypostCarrierRateCapabilities),
    );

    const files = manifest.files as { allFiles: string[] };
    for (const relPath of files.allFiles) {
      expect(existsSync(path.join(RECIPE_DIR, relPath)), `missing recipe file: ${relPath}`).toBe(
        true,
      );
    }
    expect(files.allFiles).toEqual(listRecipeFilesOnDisk(RECIPE_DIR));
  });

  it("rejects planted-defect negative controls in runShippingRateAdapterConformance", async () => {
    // Defect #1: Dropped retryAfterSeconds on HTTP 429 must fail full-mode certification.
    const base1 = makeConformanceSubject("defect-dropped-retry-after");
    const droppedRetryAfter: ShippingRateAdapterTestSubject = {
      ...base1,
      certification: {
        ...base1.certification!,
        rateLimited429: () =>
          createScriptedHarness(
            { kind: "rate-limited-429", retryAfterSeconds: 45 },
            {
              mutateResult: (res) =>
                res.kind === "refused"
                  ? {
                      kind: "refused",
                      providerKind: res.providerKind,
                      reason: res.reason,
                      retryable: res.retryable,
                      diagnosticCode: res.diagnosticCode,
                    }
                  : res,
            },
          ),
      },
    };
    await expect(
      runShippingRateAdapterConformance([droppedRetryAfter], { mode: "full" }),
    ).rejects.toThrow(/SHIPPING_RATE_CONFORMANCE:retry_after_mismatch/);

    // Defect #2: Leaking a sensitive canary into rate output must fail secret_leak check.
    const base2 = makeConformanceSubject("defect-canary-leak");
    const leakedCanary: ShippingRateAdapterTestSubject = {
      ...base2,
      happyQuote: () =>
        createScriptedHarness(
          { kind: "success", value: createHappyMultiCarrierShipmentResponse() },
          {
            mutateResult: (res) =>
              res.kind === "quoted"
                ? {
                    ...res,
                    rates: res.rates.map((r, idx) =>
                      idx === 0
                        ? { ...r, serviceName: `${r.serviceName} ${EASYPOST_TEST_CANARIES.apiKey}` }
                        : r,
                    ),
                  }
                : res,
          },
        ),
    };
    await expect(
      runShippingRateAdapterConformance([leakedCanary], { mode: "full" }),
    ).rejects.toThrow(/SHIPPING_RATE_CONFORMANCE:secret_leak/);
  });
});
