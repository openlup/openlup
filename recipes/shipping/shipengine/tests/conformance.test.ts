import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  projectCarrierRateStaticCapabilities,
} from "@openlup/platform/shipping";
import { runShippingRateAdapterConformance } from "@openlup/platform/shipping/testing";
import {
  assertValidShipEngineApiKey,
  createShipEngineHttpClient,
  createShipEngineRateAdapter,
  decimalAmountToMinor,
  minorToMajorNumber,
  projectShipEngineStaticCapabilities,
  SHIPENGINE_API_ORIGIN,
  ShipEngineTransportError,
} from "../server/index.js";
import {
  createShipEngineFullSubject,
  createShipEngineScenarioHarness,
  SHIPENGINE_BASE_REQUEST,
  SHIPENGINE_HAPPY_PAYLOAD,
  SHIPENGINE_TEST_CANARIES,
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

function assertNoCanaryLeak(surface: unknown): void {
  const serialized = JSON.stringify(surface);
  for (const canary of Object.values(SHIPENGINE_TEST_CANARIES)) {
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(encodeURIComponent(canary));
    expect(serialized).not.toContain(Buffer.from(canary, "utf8").toString("base64"));
  }
}

describe("recipes/shipping/shipengine — Stage 1 & Stage 2 conformance + security invariants", () => {
  it("passes the official @openlup/platform/shipping/testing full-mode conformance suite", async () => {
    const evidence = await runShippingRateAdapterConformance([createShipEngineFullSubject()], {
      mode: "full",
    });

    expect(evidence.contractVersion).toBe(CARRIER_RATE_QUOTE_CONTRACT_VERSION);
    expect(evidence.mode).toBe("full");
    expect(evidence.qualifications).toHaveLength(1);
    const qual = evidence.qualifications[0]!;
    expect(qual.providerKind).toBe("shipengine");
    expect(qual.capabilityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(qual.ledger.filter((e) => e.role === "zero-io-refusal").every((e) => e.ioDelta === 0)).toBe(true);
    expect(qual.ledger.filter((e) => e.role === "transport-fault")).toHaveLength(5);
    assertNoCanaryLeak(evidence);
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

    const projected = projectShipEngineStaticCapabilities();
    expect(manifest.staticCapabilities).toEqual(projected);
    expect(manifest.staticCapabilities).toEqual(
      projectCarrierRateStaticCapabilities(projected, { redactSupportedCurrencies: true }),
    );

    const files = manifest.files as { allFiles: string[] };
    expect(files.allFiles).toHaveLength(8);
    for (const relPath of files.allFiles) {
      expect(existsSync(path.join(RECIPE_DIR, relPath)), `missing declared recipe file: ${relPath}`).toBe(true);
    }
    expect(files.allFiles).toEqual(listRecipeFilesOnDisk(RECIPE_DIR));
  });

  it("converts ShipEngine decimal amounts via BigInt + Intl without IEEE-754 float drift", () => {
    expect(decimalAmountToMinor(19.99, "USD")).toBe(1999);
    expect(decimalAmountToMinor("19.99", "USD")).toBe(1999);
    expect(decimalAmountToMinor(0.05, "EUR")).toBe(5);
    expect(decimalAmountToMinor(1000, "JPY")).toBe(1000);
    expect(decimalAmountToMinor("1.500", "KWD")).toBe(1500);
    expect(minorToMajorNumber(1999, "USD")).toBe(19.99);
    expect(minorToMajorNumber(1000, "JPY")).toBe(1000);

    expect(decimalAmountToMinor("12.999", "USD")).toBeNull();
    expect(decimalAmountToMinor(-5, "USD")).toBeNull();
    expect(decimalAmountToMinor("12.99", "XXX")).toBeNull();
  });

  it("enforces cold-import zero-I/O, pinned HTTPS egress, sorted rates, and redacted API-Key errors", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("should not be called");
    });

    expect(() =>
      createShipEngineHttpClient({ apiKey: "", fetchImpl: fetchSpy }),
    ).toThrow(ShipEngineTransportError);
    expect(() => assertValidShipEngineApiKey("short")).toThrow(ShipEngineTransportError);

    let dynamicKey = "";
    const lazyAdapter = createShipEngineRateAdapter({
      client: createShipEngineHttpClient({ apiKey: () => dynamicKey, fetchImpl: fetchSpy }),
      carrierIds: ["se-123456"],
      supportedCurrencies: ["USD"],
    });

    const missingKeyRes = await lazyAdapter.quoteRates(SHIPENGINE_BASE_REQUEST);
    expect(missingKeyRes).toMatchObject({
      kind: "refused",
      reason: "authentication_failed",
      retryable: false,
      diagnosticCode: "SHIPENGINE_CREDENTIALS_MISSING",
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    dynamicKey = SHIPENGINE_TEST_CANARIES.apiKey;
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const liveAdapter = createShipEngineRateAdapter({
      client: createShipEngineHttpClient({
        apiKey: dynamicKey,
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return new Response(JSON.stringify(SHIPENGINE_HAPPY_PAYLOAD), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
      carrierIds: ["se-123456"],
      supportedCurrencies: ["USD"],
    });

    const quoted = await liveAdapter.quoteRates(SHIPENGINE_BASE_REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SHIPENGINE_API_ORIGIN}/v1/rates`);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(new Headers(calls[0]!.init?.headers).get("api-key")).toBe(
      SHIPENGINE_TEST_CANARIES.apiKey,
    );
    expect(quoted.kind).toBe("quoted");
    if (quoted.kind !== "quoted") throw new Error("expected quoted");
    // Cheapest rate (9.45 + 1.50 = 1095) sorted before 29.95 (2995).
    expect(quoted.rates.map((r) => [r.serviceCode, r.amountMinor])).toEqual([
      ["ups_ground", 1095],
      ["ups_next_day_air", 2995],
    ]);
    assertNoCanaryLeak(quoted);
  });

  it("rejects planted-defect negative controls in runShippingRateAdapterConformance", async () => {
    const base = createShipEngineFullSubject();

    // Negative control #1: Dropping retryAfterSeconds on HTTP 429 fails certification.
    const droppedRetryAfter = {
      ...base,
      certification: {
        ...base.certification!,
        rateLimited429: () =>
          createShipEngineScenarioHarness({
            kind: "rate-limited-429",
            retryAfterSeconds: 45,
            response: new Response(JSON.stringify({ message: "rate limit" }), {
              status: 429,
              // Missing retry-after header simulates dropped retryAfterSeconds.
            }),
          }),
      },
    };
    await expect(runShippingRateAdapterConformance([droppedRetryAfter], { mode: "full" })).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:retry_after_mismatch/,
    );

    // Negative control #2: Proxy adapter is rejected by conformance runner.
    const proxied = {
      ...base,
      happyQuote: () => {
        const harness = base.happyQuote();
        return { ...harness, adapter: new Proxy(harness.adapter, {}) };
      },
    };
    await expect(runShippingRateAdapterConformance([proxied], { mode: "full" })).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:proxy_rejected/,
    );
  });
});
