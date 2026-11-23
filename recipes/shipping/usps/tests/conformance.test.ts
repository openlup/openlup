import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  projectCarrierRateStaticCapabilities,
} from "@openlup/platform/shipping";
import type { CarrierRateQuotePort } from "@openlup/platform/shipping/contracts";
import {
  ScriptedShippingRateTransportError,
  createScriptedShippingRateFake,
  runShippingRateAdapterConformance,
  type ScriptedShippingRateOutcome,
  type ShippingRateAdapterTestSubject,
  type ShippingRateScenarioHarness,
} from "@openlup/platform/shipping/testing";
import {
  USPS_BASE_RATES_SEARCH_URLS,
  USPS_OAUTH_TOKEN_URLS,
  USPS_PROVIDER_KIND,
  UspsOAuth2Error,
  UspsTransportError,
  createUspsCarrierRateAdapter,
  createUspsHttpClient,
  createUspsOAuth2TokenManager,
  parseUspsMajorAmountToMinor,
  parseUspsZipCode,
  projectUspsStaticCapabilities,
  type FetchLike,
  type UspsBaseRatesResponse,
  type UspsBaseRatesSearchRequest,
  type UspsEnvironment,
} from "../server/index.js";
import {
  FIXTURE_CANARIES,
  FIXTURE_NOW_MS,
  FIXTURE_SENSITIVE_VALUES,
  buildBaseQuoteRequest,
  buildOAuthTokenPayload,
  buildUspsEmptyRatesResponse,
  buildUspsMultiServiceRatesResponse,
  buildUspsTopLevelRatesResponse,
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

function assertNoCanaryLeak(payload: unknown): void {
  const serialized = JSON.stringify(payload) ?? "";
  for (const secret of FIXTURE_SENSITIVE_VALUES) {
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encodeURIComponent(secret));
  }
}

function buildConformanceHarness(
  outcome: ScriptedShippingRateOutcome<UspsBaseRatesResponse>,
  environment: UspsEnvironment = "tem",
): ShippingRateScenarioHarness {
  const fake = createScriptedShippingRateFake<{ searchBaseRates: UspsBaseRatesResponse }>();
  fake.enqueue("searchBaseRates", outcome);

  const nowMs = FIXTURE_NOW_MS;
  let rateIoCount = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    expect(init?.redirect).toBe("error");
    if (url === USPS_OAUTH_TOKEN_URLS[environment]) {
      return new Response(JSON.stringify(buildOAuthTokenPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    expect(url).toBe(USPS_BASE_RATES_SEARCH_URLS[environment]);
    rateIoCount += 1;
    try {
      const payload = await fake.invoke("searchBaseRates");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (error instanceof ScriptedShippingRateTransportError) {
        if (error.kind === "http-failure") {
          return new Response(
            JSON.stringify({
              error: { message: FIXTURE_CANARIES.rawErrorLeak },
            }),
            { status: error.status ?? 500 },
          );
        }
        if (error.kind === "rate-limited-429") {
          return new Response(
            JSON.stringify({ error: { message: FIXTURE_CANARIES.rawErrorLeak } }),
            {
              status: 429,
              headers:
                error.retryAfterSeconds !== undefined
                  ? { "retry-after": String(error.retryAfterSeconds) }
                  : {},
            },
          );
        }
        if (error.kind === "timeout") {
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        throw new TypeError("Simulated network failure");
      }
      throw error;
    }
  };

  const tokenManager = createUspsOAuth2TokenManager({
    clientId: FIXTURE_CANARIES.clientId,
    clientSecret: FIXTURE_CANARIES.clientSecret,
    environment,
    fetchImpl,
    clock: () => nowMs,
  });

  const client = createUspsHttpClient({
    tokenManager,
    environment,
    fetchImpl,
  });

  const adapter = createUspsCarrierRateAdapter({
    client,
    priceType: "RETAIL",
    processingCategory: "MACHINABLE",
    destinationEntryFacilityType: "NONE",
  });

  return {
    adapter,
    request: buildBaseQuoteRequest(),
    readIoCount: () => rateIoCount,
    readFaultLog: () => fake.calls,
  };
}

describe("recipes/shipping/usps — Stage 1 & 2 Conformance", () => {
  it("keeps server barrel completely inert on cold import (0 fetch calls, 0 ambient I/O)", async () => {
    const originalFetch = globalThis.fetch;
    let ambientFetchCalls = 0;
    globalThis.fetch = (async () => {
      ambientFetchCalls += 1;
      throw new Error("Ambient fetch must never be called");
    }) as typeof fetch;

    try {
      const mod = await import("../server/index.js");
      expect(typeof mod.createUspsCarrierRateAdapter).toBe("function");
      expect(typeof mod.createUspsHttpClient).toBe("function");
      expect(typeof mod.createUspsOAuth2TokenManager).toBe("function");
      expect(mod.uspsCarrierRateCapabilities.providerKind).toBe("usps");
      expect(ambientFetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes full @openlup/platform/shipping/testing conformance runner with zero canary leaks", async () => {
    const subject: ShippingRateAdapterTestSubject = {
      id: "usps-domestic-v3-tem",
      happyQuote: () =>
        buildConformanceHarness({
          kind: "success",
          value: buildUspsMultiServiceRatesResponse(),
        }),
      noRatesQuote: () =>
        buildConformanceHarness({
          kind: "success",
          value: buildUspsEmptyRatesResponse(),
        }),
      sensitiveValues: FIXTURE_SENSITIVE_VALUES,
      certification: {
        http5xx: () => buildConformanceHarness({ kind: "http-failure", status: 503 }),
        httpAuthFailure: () => buildConformanceHarness({ kind: "http-failure", status: 401 }),
        rateLimited429: () =>
          buildConformanceHarness({ kind: "rate-limited-429", retryAfterSeconds: 42 }),
        timeout: () => buildConformanceHarness({ kind: "timeout" }),
        transportError: () => buildConformanceHarness({ kind: "transport-error" }),
      },
    };

    const evidence = await runShippingRateAdapterConformance([subject], { mode: "full" });
    expect(evidence.contractVersion).toBe(CARRIER_RATE_QUOTE_CONTRACT_VERSION);
    expect(evidence.mode).toBe("full");
    expect(evidence.qualifications).toHaveLength(1);
    expect(evidence.qualifications[0]?.providerKind).toBe(USPS_PROVIDER_KIND);
    expect(evidence.qualifications[0]?.ledger.length).toBeGreaterThanOrEqual(14);
  });

  it("refuses invalid US origin/destination ZIP codes at 0 I/O and accepts 5-digit and ZIP+4 formats", async () => {
    let clientCalls = 0;
    const seenRequests: UspsBaseRatesSearchRequest[] = [];
    const adapter = createUspsCarrierRateAdapter({
      client: {
        async searchBaseRates(input) {
          clientCalls += 1;
          seenRequests.push(input);
          return buildUspsTopLevelRatesResponse();
        },
      },
    });

    for (const badZip of ["", "1234", "ABCDE", "K1A 0B1", "10001-12"]) {
      const originBad = await adapter.quoteRates(
        buildBaseQuoteRequest({
          origin: { countryCode: "US", postalCode: badZip },
        }),
      );
      expect(originBad).toEqual({
        kind: "refused",
        providerKind: "usps",
        reason: "invalid_address",
        retryable: false,
        diagnosticCode:
          badZip.trim().length === 0 ? "INVALID_ORIGIN_ADDRESS" : "USPS_INVALID_ORIGIN_POSTAL_CODE",
      });

      const destBad = await adapter.quoteRates(
        buildBaseQuoteRequest({
          destination: { countryCode: "US", postalCode: badZip },
        }),
      );
      expect(destBad).toEqual({
        kind: "refused",
        providerKind: "usps",
        reason: "invalid_address",
        retryable: false,
        diagnosticCode:
          badZip.trim().length === 0
            ? "INVALID_DESTINATION_ADDRESS"
            : "USPS_INVALID_DESTINATION_POSTAL_CODE",
      });
    }
    expect(clientCalls).toBe(0);

    const ok = await adapter.quoteRates(
      buildBaseQuoteRequest({
        origin: { countryCode: "US", postalCode: "90210-4411" },
        destination: { countryCode: "US", postalCode: "10001" },
      }),
    );
    expect(clientCalls).toBe(1);
    expect(seenRequests[0]).toMatchObject({
      originZIPCode: "90210",
      destinationZIPCode: "10001",
      weight: 1.9996,
      length: 10,
      width: 5.98,
      height: 4.02,
      mailingDate: "2030-03-17",
    });
    expect(ok.kind).toBe("quoted");
    if (ok.kind === "quoted") {
      expect(ok.rates.map((r) => r.amountMinor)).toEqual([725, 1240]);
    }
  });

  it("converts USPS decimal prices via Intl.NumberFormat + BigInt without float drift, sorts rates, and respects serviceFilter", async () => {
    expect(parseUspsZipCode("10001-1234")).toBe("10001");
    expect(parseUspsZipCode("invalid")).toBeNull();
    expect(parseUspsMajorAmountToMinor("10.075", "USD")).toBe(1008);
    expect(parseUspsMajorAmountToMinor(35.855, "USD")).toBe(3586);
    expect(parseUspsMajorAmountToMinor("19.99", "USD")).toBe(1999);
    expect(parseUspsMajorAmountToMinor(10, "USD")).toBe(1000);
    expect(parseUspsMajorAmountToMinor(-1, "USD")).toBeNull();
    expect(parseUspsMajorAmountToMinor("bad", "USD")).toBeNull();

    const adapter = createUspsCarrierRateAdapter({
      client: {
        async searchBaseRates() {
          return buildUspsMultiServiceRatesResponse();
        },
      },
      mailClasses: ["USPS_GROUND_ADVANTAGE", "PRIORITY_MAIL", "PRIORITY_MAIL_EXPRESS"],
    });

    const allRates = await adapter.quoteRates(buildBaseQuoteRequest());
    expect(allRates.kind).toBe("quoted");
    if (allRates.kind === "quoted") {
      expect(allRates.rates.map((r) => [r.serviceCode, r.amountMinor])).toEqual([
        ["USPS_GROUND_ADVANTAGE", 895],
        ["PRIORITY_MAIL", 1008],
        ["PRIORITY_MAIL_EXPRESS", 3145],
      ]);
      expect(allRates.rates[0]?.providerRateRef).toBe("DGA00003");
      expect(allRates.rates[2]?.deliveryDateGuaranteed).toBe(true);
      expect(allRates.rates[2]?.estimatedTransitDays).toEqual({ min: 1, max: 2 });
    }

    const filtered = await adapter.quoteRates(
      buildBaseQuoteRequest({ serviceFilter: ["PRIORITY_MAIL"] }),
    );
    expect(filtered.kind).toBe("quoted");
    if (filtered.kind === "quoted") {
      expect(filtered.rates).toHaveLength(1);
      expect(filtered.rates[0]?.serviceCode).toBe("PRIORITY_MAIL");
    }

    const noMatch = await adapter.quoteRates(
      buildBaseQuoteRequest({ serviceFilter: ["NON_EXISTENT_MAIL_CLASS"] }),
    );
    expect(noMatch).toEqual({
      kind: "no_rates",
      providerKind: "usps",
      diagnosticCode: "USPS_NO_MATCHING_RATES",
    });
  });

  it("refuses malformed 2xx payloads cleanly without throwing", async () => {
    for (const malformed of [
      { unexpected: true },
      { rateOptions: "not-an-array" },
      { rateOptions: [{ totalBasePrice: "not-a-number", rates: [{ mailClass: "PRIORITY_MAIL" }] }] },
      { rates: [{ mailClass: "PRIORITY_MAIL", price: -5 }] },
    ]) {
      const adapter = createUspsCarrierRateAdapter({
        client: {
          async searchBaseRates() {
            return malformed as UspsBaseRatesResponse;
          },
        },
      });
      const result = await adapter.quoteRates(buildBaseQuoteRequest());
      expect(result.kind).toBe("refused");
      if (result.kind === "refused") {
        expect(result.reason).toBe("provider_error");
        expect(result.retryable).toBe(false);
      }
    }
  });

  it("enforces single-flight deduplication, clock refresh skew, 401 invalidation, and secret redaction in OAuth2 token manager", async () => {
    const nowMsInitial = FIXTURE_NOW_MS;
    let nowMs = nowMsInitial;
    let tokenFetchCalls = 0;
    let currentToken = FIXTURE_CANARIES.accessToken;
    let releaseGate: (() => void) | null = null;

    const fetchImpl: FetchLike = async (url, init) => {
      tokenFetchCalls += 1;
      expect(url).toBe(USPS_OAUTH_TOKEN_URLS.production);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(init?.body as string)).toEqual({
        client_id: FIXTURE_CANARIES.clientId,
        client_secret: FIXTURE_CANARIES.clientSecret,
        grant_type: "client_credentials",
      });
      if (releaseGate) {
        await new Promise<void>((resolveGate) => {
          releaseGate = resolveGate;
        });
      }
      return new Response(JSON.stringify(buildOAuthTokenPayload(currentToken, 3600)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const manager = createUspsOAuth2TokenManager({
      clientId: FIXTURE_CANARIES.clientId,
      clientSecret: FIXTURE_CANARIES.clientSecret,
      environment: "production",
      fetchImpl,
      clock: () => nowMs,
      refreshSkewSeconds: 60,
    });

    // Single-flight concurrent deduplication: 5 parallel calls -> 1 fetch
    let gateResolver!: () => void;
    const gatePromise = new Promise<void>((r) => {
      gateResolver = r;
    });
    const gatedManager = createUspsOAuth2TokenManager({
      clientId: FIXTURE_CANARIES.clientId,
      clientSecret: FIXTURE_CANARIES.clientSecret,
      environment: "production",
      fetchImpl: async (url, init) => {
        await gatePromise;
        return fetchImpl(url, init);
      },
      clock: () => nowMs,
      refreshSkewSeconds: 60,
    });

    const parallel = Promise.all([
      gatedManager.getAccessToken(),
      gatedManager.getAccessToken(),
      gatedManager.getAccessToken(),
      gatedManager.getAccessToken(),
      gatedManager.getAccessToken(),
    ]);
    gateResolver();
    const tokens = await parallel;
    expect(tokenFetchCalls).toBe(1);
    expect(tokens).toEqual(Array(5).fill(FIXTURE_CANARIES.accessToken));

    // Cached hit before skew window (3600s - 61s = 3539s later)
    nowMs += 3539 * 1000;
    expect(await gatedManager.getAccessToken()).toBe(FIXTURE_CANARIES.accessToken);
    expect(tokenFetchCalls).toBe(1);

    // Proactive refresh inside 60s skew window (3540s later)
    nowMs += 1000;
    currentToken = FIXTURE_CANARIES.refreshedToken;
    expect(await gatedManager.getAccessToken()).toBe(FIXTURE_CANARIES.refreshedToken);
    expect(tokenFetchCalls).toBe(2);

    // Explicit invalidate() forces immediate refresh even without clock advance
    currentToken = FIXTURE_CANARIES.accessToken;
    gatedManager.invalidate();
    expect(await gatedManager.getAccessToken()).toBe(FIXTURE_CANARIES.accessToken);
    expect(tokenFetchCalls).toBe(3);

    // Error redaction + 429 Retry-After + streaming byte cap on OAuth2
    const errorManager = createUspsOAuth2TokenManager({
      clientId: FIXTURE_CANARIES.clientId,
      clientSecret: FIXTURE_CANARIES.clientSecret,
      environment: "tem",
      maxResponseBytes: 32,
      clock: () => nowMs,
      fetchImpl: async () =>
        new Response(JSON.stringify({ leak: FIXTURE_CANARIES.rawErrorLeak }), {
          status: 429,
          headers: { "retry-after": "17" },
        }),
    });
    await expect(errorManager.getAccessToken()).rejects.toMatchObject({
      name: "UspsOAuth2Error",
      code: "usps_oauth_rate_limited",
      status: 429,
      retryable: true,
      retryAfterSeconds: 17,
    });
    try {
      await errorManager.getAccessToken();
    } catch (err) {
      assertNoCanaryLeak({ message: (err as Error).message, err });
    }

    const oversizedManager = createUspsOAuth2TokenManager({
      clientId: FIXTURE_CANARIES.clientId,
      clientSecret: FIXTURE_CANARIES.clientSecret,
      environment: "tem",
      maxResponseBytes: 16,
      clock: () => nowMs,
      fetchImpl: async () =>
        new Response(JSON.stringify(buildOAuthTokenPayload()), { status: 200 }),
    });
    await expect(oversizedManager.getAccessToken()).rejects.toBeInstanceOf(UspsOAuth2Error);
    void manager;
  });

  it("enforces pinned origin, 401 token invalidation, streaming byte cap, and Retry-After in USPS HTTP client", async () => {
    let invalidateCount = 0;
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedRedirect: RequestRedirect | undefined;

    const fakeTokenManager = {
      async getAccessToken() {
        return FIXTURE_CANARIES.accessToken;
      },
      invalidate() {
        invalidateCount += 1;
      },
    };

    const client401 = createUspsHttpClient({
      tokenManager: fakeTokenManager,
      environment: "production",
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedRedirect = init?.redirect;
        capturedAuth = (init?.headers as Record<string, string>)["authorization"] ?? "";
        return new Response(
          JSON.stringify({ leak: FIXTURE_CANARIES.rawErrorLeak }),
          { status: 401 },
        );
      },
    });

    await expect(
      client401.searchBaseRates({
        originZIPCode: "90210",
        destinationZIPCode: "10001",
        weight: 2,
        length: 10,
        width: 6,
        height: 4,
      }),
    ).rejects.toMatchObject({
      name: "UspsTransportError",
      code: "usps_http_401",
      status: 401,
      retryable: false,
    });
    expect(capturedUrl).toBe("https://apis.usps.com/prices/v3/base-rates/search");
    expect(capturedRedirect).toBe("error");
    expect(capturedAuth).toBe(`Bearer ${FIXTURE_CANARIES.accessToken}`);
    expect(invalidateCount).toBe(1);

    // Streaming byte cap with chunked ReadableStream exceeding maxResponseBytes
    let streamCancelled = false;
    const clientOversized = createUspsHttpClient({
      tokenManager: fakeTokenManager,
      environment: "tem",
      maxResponseBytes: 20,
      fetchImpl: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("123456789012345"));
            controller.enqueue(new TextEncoder().encode("123456789012345"));
          },
          cancel() {
            streamCancelled = true;
          },
        });
        return new Response(stream, { status: 200 });
      },
    });

    await expect(
      clientOversized.searchBaseRates({
        originZIPCode: "90210",
        destinationZIPCode: "10001",
        weight: 2,
        length: 10,
        width: 6,
        height: 4,
      }),
    ).rejects.toThrow(UspsTransportError);
    expect(streamCancelled).toBe(true);
  });

  it("matches recipe.json against schema, staticCapabilities, and exact sorted on-disk file inventory", () => {
    const schema = JSON.parse(
      readFileSync(resolve(RECIPES_ROOT, "schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8")) as {
      id: string;
      domain: string;
      providerKind: string;
      staticCapabilities: unknown;
      files: { allFiles: string[] };
    };

    const schemaErrors = validateAgainstJsonSchema(manifest, schema);
    expect(schemaErrors).toEqual([]);
    expect(manifest.id).toBe("shipping/usps");
    expect(manifest.domain).toBe("shipping");
    expect(manifest.providerKind).toBe(USPS_PROVIDER_KIND);
    expect(manifest.staticCapabilities).toEqual(projectUspsStaticCapabilities());
    expect(manifest.staticCapabilities).toEqual(
      projectCarrierRateStaticCapabilities(
        createUspsCarrierRateAdapter({
          client: {
            async searchBaseRates() {
              return buildUspsEmptyRatesResponse();
            },
          },
        }).capabilities,
      ),
    );

    const onDiskFiles = collectRelativeFiles(RECIPE_ROOT, RECIPE_ROOT);
    expect([...manifest.files.allFiles].sort()).toEqual(onDiskFiles);
    expect(manifest.files.allFiles).toEqual(onDiskFiles);
  });

  it("negative control 1: catches an adapter that makes I/O on unsupported country (zero_io_violation)", async () => {
    const realHarness = buildConformanceHarness({
      kind: "success",
      value: buildUspsMultiServiceRatesResponse(),
    });
    let defectiveIo = 0;
    const defectiveAdapter: CarrierRateQuotePort = {
      capabilities: realHarness.adapter.capabilities,
      async quoteRates(req) {
        if (req.destination.countryCode !== "US") {
          defectiveIo += 1;
        }
        return realHarness.adapter.quoteRates(req);
      },
    };

    const subject: ShippingRateAdapterTestSubject = {
      id: "planted-defect-zero-io",
      happyQuote: () => ({
        ...realHarness,
        adapter: defectiveAdapter,
        readIoCount: () => realHarness.readIoCount() + defectiveIo,
      }),
      noRatesQuote: () =>
        buildConformanceHarness({
          kind: "success",
          value: buildUspsEmptyRatesResponse(),
        }),
    };

    await expect(runShippingRateAdapterConformance([subject])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:zero_io_violation/,
    );
  });

  it("negative control 2: catches an adapter that drops retryAfterSeconds on 429 (retry_after_mismatch)", async () => {
    const buildFaulty429Harness = (): ShippingRateScenarioHarness => {
      const inner = buildConformanceHarness({ kind: "rate-limited-429", retryAfterSeconds: 30 });
      return {
        ...inner,
        adapter: {
          capabilities: inner.adapter.capabilities,
          async quoteRates(req) {
            const res = await inner.adapter.quoteRates(req);
            if (res.kind === "refused" && res.reason === "rate_limited") {
              return {
                kind: "refused",
                providerKind: res.providerKind,
                reason: res.reason,
                retryable: true,
                diagnosticCode: res.diagnosticCode,
              };
            }
            return res;
          },
        },
      };
    };

    const subject: ShippingRateAdapterTestSubject = {
      id: "planted-defect-429-retry-after",
      happyQuote: () =>
        buildConformanceHarness({
          kind: "success",
          value: buildUspsMultiServiceRatesResponse(),
        }),
      noRatesQuote: () =>
        buildConformanceHarness({
          kind: "success",
          value: buildUspsEmptyRatesResponse(),
        }),
      certification: {
        http5xx: () => buildConformanceHarness({ kind: "http-failure", status: 503 }),
        httpAuthFailure: () => buildConformanceHarness({ kind: "http-failure", status: 401 }),
        rateLimited429: buildFaulty429Harness,
        timeout: () => buildConformanceHarness({ kind: "timeout" }),
        transportError: () => buildConformanceHarness({ kind: "transport-error" }),
      },
    };

    await expect(runShippingRateAdapterConformance([subject], { mode: "full" })).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:retry_after_mismatch/,
    );
  });

  it("negative control 3: catches an adapter that leaks a sensitive canary in diagnostics (secret_leak)", async () => {
    const buildLeakyHarness = (): ShippingRateScenarioHarness => {
      const inner = buildConformanceHarness({
        kind: "success",
        value: buildUspsMultiServiceRatesResponse(),
      });
      return {
        ...inner,
        adapter: {
          capabilities: inner.adapter.capabilities,
          async quoteRates(req) {
            const res = await inner.adapter.quoteRates(req);
            if (res.kind === "quoted") {
              return {
                ...res,
                providerShipmentRef: `leak:${FIXTURE_CANARIES.accessToken}`,
              };
            }
            return res;
          },
        },
      };
    };

    const subject: ShippingRateAdapterTestSubject = {
      id: "planted-defect-secret-leak",
      happyQuote: buildLeakyHarness,
      noRatesQuote: () =>
        buildConformanceHarness({
          kind: "success",
          value: buildUspsEmptyRatesResponse(),
        }),
      sensitiveValues: FIXTURE_SENSITIVE_VALUES,
    };

    await expect(runShippingRateAdapterConformance([subject])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:secret_leak/,
    );
  });
});
