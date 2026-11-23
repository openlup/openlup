import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_EXPORT_CONTRACT_VERSION,
  validateAccountingExportRecord,
} from "@openlup/platform/accounting";
import type {
  AccountingExportRecord,
  AccountingExportResult,
  AccountingLedgerExportPort,
  AccountingReadbackResult,
} from "@openlup/platform/accounting/contracts";
import {
  createScriptedAccountingFake,
  runAccountingAdapterConformance,
  ScriptedAccountingTransportError,
  type AccountingAdapterTestSubject,
  type AccountingScenarioHarness,
  type ScriptedAccountingOutcome,
} from "@openlup/platform/accounting/testing";
import type { OAuth2CachedToken, OAuth2TokenCache } from "@openlup/platform/adapter-kit";
import {
  XERO_API_ORIGIN,
  XERO_OAUTH_TOKEN_URL,
  XERO_PROVIDER_KIND,
  XeroClientError,
  assertSafeXeroTenantId,
  createXeroAdapter,
  createXeroHttpClient,
  escapeXeroWhereLiteral,
  minorUnitsToMajorDecimalString,
  projectXeroStaticCapabilities,
  xeroDefaultCapabilities,
} from "../server/index.js";
import {
  buildXeroExportRecord,
  FIXTURE_SENSITIVE_CANARIES,
  FIXTURE_TENANT_ID,
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
  pointer = "$",
): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}`);
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
      errors.push(`${pointer}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pointer}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${pointer}: does not match pattern ${schema.pattern}`);
    }
    if (
      schema.format === "date-time" &&
      (!RFC3339_DATE_TIME_REGEX.test(value) || !Number.isFinite(Date.parse(value)))
    ) {
      errors.push(`${pointer}: invalid date-time`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer}: length < minItems`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) errors.push(`${pointer}: duplicate items`);
    }
    if (schema.items) {
      value.forEach((item, idx) => {
        errors.push(...validateAgainstJsonSchema(item, schema.items!, `${pointer}[${idx}]`));
      });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in record)) errors.push(`${pointer}: missing required ${key}`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) errors.push(`${pointer}: unexpected property ${key}`);
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in record) {
          errors.push(...validateAgainstJsonSchema(record[key], propSchema, `${pointer}.${key}`));
        }
      }
    }
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) {
      if (branch.if && branch.then) {
        if (validateAgainstJsonSchema(value, branch.if, pointer).length === 0) {
          errors.push(...validateAgainstJsonSchema(value, branch.then, pointer));
        }
      } else {
        errors.push(...validateAgainstJsonSchema(value, branch, pointer));
      }
    }
  }
  return errors;
}

type XeroFakeCalls = {
  exportEntry: { readonly id: string };
  readEntry: { readonly id: string } | null;
};

function makeXeroHarness(
  outcome: ScriptedAccountingOutcome<{ readonly id: string }>,
  opts?: {
    readonly readback?: ScriptedAccountingOutcome<{ readonly id: string } | null>;
    readonly record?: AccountingExportRecord;
    readonly httpCounter?: { count: number };
  },
): AccountingScenarioHarness {
  const fake = createScriptedAccountingFake<XeroFakeCalls>();
  if (opts?.readback) {
    fake.enqueue("readEntry", opts.readback);
  } else {
    fake.enqueue("exportEntry", outcome);
  }
  const record = opts?.record ?? buildXeroExportRecord();

  const fetchImpl: typeof fetch = async (input, init) => {
    if (opts?.httpCounter) opts.httpCounter.count += 1;
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    expect(init?.redirect).toBe("error");

    if (url.toString() === XERO_OAUTH_TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: FIXTURE_SENSITIVE_CANARIES.accessToken,
          token_type: "Bearer",
          expires_in: 1800,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (
      url.origin === XERO_API_ORIGIN &&
      url.pathname === "/api.xro/2.0/ManualJournals" &&
      method === "PUT"
    ) {
      try {
        const res = await fake.invoke("exportEntry");
        return new Response(
          JSON.stringify({
            ManualJournals: [{ ManualJournalID: res.id, Narration: record.exportKey }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (err) {
        if (err instanceof ScriptedAccountingTransportError) {
          if (err.kind === "timeout") {
            const abortErr = new Error("aborted");
            abortErr.name = "AbortError";
            throw abortErr;
          }
          if (err.kind === "transport-error") {
            throw new TypeError("network_failure");
          }
          if (err.kind === "rate-limited-429") {
            return new Response(JSON.stringify({ Title: "Rate Limit Exceeded" }), {
              status: 429,
              headers: {
                "content-type": "application/json",
                ...(err.retryAfterSeconds !== undefined
                  ? { "retry-after": String(err.retryAfterSeconds) }
                  : {}),
              },
            });
          }
          if (err.kind === "http-failure") {
            return new Response(JSON.stringify({ Title: "Upstream Error" }), {
              status: err.status ?? 500,
              headers: { "content-type": "application/json" },
            });
          }
        }
        throw err;
      }
    }

    if (
      url.origin === XERO_API_ORIGIN &&
      url.pathname === "/api.xro/2.0/ManualJournals" &&
      method === "GET"
    ) {
      const found = await fake.invoke("readEntry");
      return new Response(
        JSON.stringify({
          ManualJournals: found
            ? [{ ManualJournalID: found.id, Narration: record.exportKey }]
            : [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`Unexpected URL in Xero conformance test: ${method} ${url.toString()}`);
  };

  const client = createXeroHttpClient({
    tenantId: FIXTURE_TENANT_ID,
    clientId: FIXTURE_SENSITIVE_CANARIES.clientId,
    clientSecret: FIXTURE_SENSITIVE_CANARIES.clientSecret,
    refreshToken: FIXTURE_SENSITIVE_CANARIES.refreshToken,
    fetchImpl,
  });

  const adapter = createXeroAdapter({ client });
  return {
    adapter,
    record,
    readIoCount: () => fake.calls.length,
    readFaultLog: () => fake.calls,
  };
}

describe("recipes/accounting/xero — Stage 1 manifest, cold-import & money math", () => {
  it("validates recipe.json against recipe.schema.json and matches staticCapabilities + disk allFiles", () => {
    const schema = JSON.parse(
      readFileSync(resolve(RECIPES_ROOT, "schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));

    expect(validateAgainstJsonSchema(manifest, schema)).toEqual([]);
    expect(manifest.status).toBe("verified");
    expect(manifest.providerKind).toBe(XERO_PROVIDER_KIND);
    expect(manifest.staticCapabilities).toEqual(projectXeroStaticCapabilities());

    const diskFiles = collectRelativeFiles(RECIPE_ROOT, RECIPE_ROOT);
    const manifestFiles = [...(manifest.files.allFiles as string[])];
    expect(manifestFiles).toEqual([...manifestFiles].sort());
    expect(manifestFiles).toEqual(diskFiles);
  });

  it("keeps barrel import cold and inert with zero I/O", () => {
    expect(xeroDefaultCapabilities.providerKind).toBe(XERO_PROVIDER_KIND);
    expect(xeroDefaultCapabilities.supportedCurrencies).toEqual([]);
    expect(xeroDefaultCapabilities.supportsReadback).toBe(true);
    expect(xeroDefaultCapabilities.supportsIdempotencyKey).toBe(true);
    expect(xeroDefaultCapabilities.requiresCredentials).toBe(true);
  });

  it("converts signed minor units to exact major decimal strings using Intl currency exponents and BigInt", () => {
    expect(minorUnitsToMajorDecimalString(4215, "GBP")).toBe("42.15");
    expect(minorUnitsToMajorDecimalString(-3500, "GBP")).toBe("-35.00");
    expect(minorUnitsToMajorDecimalString(-5, "EUR")).toBe("-0.05");
    expect(minorUnitsToMajorDecimalString(-1500, "JPY")).toBe("-1500");
    expect(minorUnitsToMajorDecimalString(1500, "BHD")).toBe("1.500");
  });
});

describe("recipes/accounting/xero — Stage 2 conformance, OAuth2 & negative controls", () => {
  it("passes runAccountingAdapterConformance([subject], { mode: 'full' }) with sensitive canary checks", async () => {
    const subject: AccountingAdapterTestSubject = {
      id: "xero",
      sensitiveValues: Object.values(FIXTURE_SENSITIVE_CANARIES),
      happyExport: () =>
        makeXeroHarness({ kind: "success", value: { id: "xero-mj-001" } }),
      certification: {
        http5xx: () => makeXeroHarness({ kind: "http-failure", status: 503 }),
        httpAuthFailure: () => makeXeroHarness({ kind: "http-failure", status: 401 }),
        httpConflict409: () => makeXeroHarness({ kind: "http-failure", status: 409 }),
        rateLimited429: () => makeXeroHarness({ kind: "rate-limited-429", retryAfterSeconds: 60 }),
        timeout: () => makeXeroHarness({ kind: "timeout" }),
        readbackFound: () =>
          makeXeroHarness(
            { kind: "success", value: { id: "unused" } },
            { readback: { kind: "success", value: { id: "xero-mj-001" } } },
          ),
      },
    };

    const evidence = await runAccountingAdapterConformance([subject], { mode: "full" });
    expect(evidence.contractVersion).toBe(ACCOUNTING_EXPORT_CONTRACT_VERSION);
    expect(evidence.mode).toBe("full");
    expect(evidence.qualifications).toHaveLength(1);
    expect(evidence.qualifications[0]!.ledger.filter((l) => l.role === "transport-fault")).toHaveLength(5);
    expect(evidence.qualifications[0]!.ledger.some((l) => l.role === "readback")).toBe(true);
  });

  it("performs zero HTTP requests (including OAuth2 token fetches) on preflight refusals", async () => {
    const httpCounter = { count: 0 };
    const harness = makeXeroHarness(
      { kind: "success", value: { id: "unused" } },
      { httpCounter },
    );
    const unbalanced: AccountingExportRecord = {
      ...harness.record,
      lines: [
        { accountCode: "120", side: "debit", amountMinor: 500 },
        { accountCode: "200", side: "credit", amountMinor: 400 },
      ],
    };
    const res = await harness.adapter.exportEntry(unbalanced);
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") {
      expect(res.reason).toBe("unbalanced_entry");
    }
    expect(httpCounter.count).toBe(0);
    expect(harness.readIoCount()).toBe(0);
  });

  it("enforces strict tenantId validation, OAuth2 Basic refresh, 401 invalidation, signed LineAmount wire format, and readback filtering", async () => {
    expect(() => assertSafeXeroTenantId("../bad")).toThrow(XeroClientError);
    expect(() => assertSafeXeroTenantId("not-a-uuid")).toThrow(XeroClientError);
    expect(() => assertSafeXeroTenantId("")).toThrow(XeroClientError);
    expect(() => assertSafeXeroTenantId(`${FIXTURE_TENANT_ID}/extra`)).toThrow(XeroClientError);
    expect(assertSafeXeroTenantId(FIXTURE_TENANT_ID)).toBe(FIXTURE_TENANT_ID);

    expect(escapeXeroWhereLiteral('ord"1\\a')).toBe('ord\\"1\\\\a');

    let tokenRequests = 0;
    let apiPutRequests = 0;
    let apiGetRequests = 0;
    let cachedToken: OAuth2CachedToken | null = null;
    const tokenCache: OAuth2TokenCache = {
      get: () => cachedToken,
      set: (t) => {
        cachedToken = t;
      },
      clear: () => {
        cachedToken = null;
      },
    };
    const capturedBodies: unknown[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(new Headers(init?.headers).entries());

      if (url.toString() === XERO_OAUTH_TOKEN_URL) {
        tokenRequests += 1;
        const expectedBasic = Buffer.from(
          `${FIXTURE_SENSITIVE_CANARIES.clientId}:${FIXTURE_SENSITIVE_CANARIES.clientSecret}`,
          "utf8",
        ).toString("base64");
        expect(headers.authorization).toBe(`Basic ${expectedBasic}`);
        expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
        expect(String(init?.body)).toContain("grant_type=refresh_token");

        const accessToken =
          tokenRequests === 1
            ? FIXTURE_SENSITIVE_CANARIES.accessToken
            : FIXTURE_SENSITIVE_CANARIES.rotatedAccessToken;
        return new Response(
          JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 1800 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (
        url.origin === XERO_API_ORIGIN &&
        url.pathname === "/api.xro/2.0/ManualJournals" &&
        method === "PUT"
      ) {
        apiPutRequests += 1;
        expect(headers["xero-tenant-id"]).toBe(FIXTURE_TENANT_ID);
        expect(headers["idempotency-key"]).toBe("ord-2001-sale");
        expect(headers["content-type"]).toBe("application/json");
        expect(headers.accept).toBe("application/json");
        capturedBodies.push(JSON.parse(String(init?.body)));

        if (apiPutRequests === 1) {
          expect(headers.authorization).toBe(`Bearer ${FIXTURE_SENSITIVE_CANARIES.accessToken}`);
          return new Response(
            JSON.stringify({
              ManualJournals: [{ ManualJournalID: "mj-901", Narration: "ord-2001-sale" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (apiPutRequests === 2) {
          expect(headers.authorization).toBe(`Bearer ${FIXTURE_SENSITIVE_CANARIES.accessToken}`);
          return new Response(JSON.stringify({ Title: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        expect(headers.authorization).toBe(
          `Bearer ${FIXTURE_SENSITIVE_CANARIES.rotatedAccessToken}`,
        );
        return new Response(
          JSON.stringify({
            ManualJournals: [{ ManualJournalID: "mj-902", Narration: "ord-2001-sale" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (
        url.origin === XERO_API_ORIGIN &&
        url.pathname === "/api.xro/2.0/ManualJournals" &&
        method === "GET"
      ) {
        apiGetRequests += 1;
        expect(headers["xero-tenant-id"]).toBe(FIXTURE_TENANT_ID);
        expect(url.searchParams.get("where")).toBe('Narration=="ord\\"2001"');
        return new Response(
          JSON.stringify({
            ManualJournals: [{ ManualJournalID: "mj-903", Narration: 'ord"2001' }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected request: ${method} ${url.toString()}`);
    };

    const client = createXeroHttpClient({
      tenantId: FIXTURE_TENANT_ID,
      clientId: FIXTURE_SENSITIVE_CANARIES.clientId,
      clientSecret: FIXTURE_SENSITIVE_CANARIES.clientSecret,
      refreshToken: FIXTURE_SENSITIVE_CANARIES.refreshToken,
      fetchImpl,
      tokenCache,
    });
    const adapter = createXeroAdapter({ client });

    const first = await adapter.exportEntry(buildXeroExportRecord());
    expect(first).toEqual({
      kind: "exported",
      providerKind: XERO_PROVIDER_KIND,
      externalRef: "mj-901",
      exportKey: "ord-2001-sale",
    });
    expect(capturedBodies[0]).toEqual({
      Narration: "ord-2001-sale",
      Date: "2000-01-15",
      Status: "POSTED",
      JournalLines: [
        {
          LineAmount: "42.15",
          AccountCode: "120",
          Description: "Clearing receivable",
        },
        {
          LineAmount: "-35.00",
          AccountCode: "200",
          Description: "Sales revenue",
        },
        {
          LineAmount: "-7.15",
          AccountCode: "820",
          Description: "VAT",
          TaxType: "OUTPUT2",
        },
      ],
    });

    // Second call hits 401 -> invalidates tokenCache.
    const unauthorized = await adapter.exportEntry(buildXeroExportRecord());
    expect(unauthorized.kind).toBe("refused");
    if (unauthorized.kind === "refused") {
      expect(unauthorized.reason).toBe("authentication_failed");
    }
    expect(cachedToken).toBeNull();
    expect(tokenRequests).toBe(1);

    // Third call fetches rotated token.
    const recovered = await adapter.exportEntry(buildXeroExportRecord());
    expect(recovered).toEqual({
      kind: "exported",
      providerKind: XERO_PROVIDER_KIND,
      externalRef: "mj-902",
      exportKey: "ord-2001-sale",
    });
    expect(tokenRequests).toBe(2);

    // Readback escapes double quotes safely in Xero where clause.
    const readback = await adapter.readEntryByKey!('ord"2001');
    expect(readback).toEqual({
      kind: "found",
      providerKind: XERO_PROVIDER_KIND,
      externalRef: "mj-903",
      exportKey: 'ord"2001',
    });
    expect(apiGetRequests).toBe(1);
  });

  it("rejects planted defects (negative controls: secret_leak and zero_io_refusal_failed)", async () => {
    const canary = FIXTURE_SENSITIVE_CANARIES.marker;
    const leakyHarness = (): AccountingScenarioHarness => {
      const base = makeXeroHarness({ kind: "success", value: { id: "mj-001" } });
      const leakyAdapter: AccountingLedgerExportPort = {
        capabilities: base.adapter.capabilities,
        async exportEntry(record, signal): Promise<AccountingExportResult> {
          const res = await base.adapter.exportEntry(record, signal);
          if (res.kind === "exported") {
            return { ...res, externalRef: `${res.externalRef}:${canary}` };
          }
          return res;
        },
        readEntryByKey: base.adapter.readEntryByKey,
      };
      return {
        adapter: leakyAdapter,
        record: base.record,
        readIoCount: base.readIoCount,
        readFaultLog: base.readFaultLog,
      };
    };

    await expect(
      runAccountingAdapterConformance([
        {
          id: "xero-leaky-defect",
          sensitiveValues: [canary],
          happyExport: leakyHarness,
        },
      ]),
    ).rejects.toThrow(/ACCOUNTING_CONFORMANCE:secret_leak/);

    const skippingPreflightHarness = (): AccountingScenarioHarness => {
      const fake = createScriptedAccountingFake<XeroFakeCalls>();
      fake.enqueue("exportEntry", { kind: "success", value: { id: "mj-002" } });
      const brokenAdapter: AccountingLedgerExportPort = {
        capabilities: xeroDefaultCapabilities,
        async exportEntry(record): Promise<AccountingExportResult> {
          const created = await fake.invoke("exportEntry");
          return {
            kind: "exported",
            providerKind: XERO_PROVIDER_KIND,
            externalRef: created.id,
            exportKey: record.exportKey,
          };
        },
        async readEntryByKey(exportKey): Promise<AccountingReadbackResult> {
          return { kind: "absent", providerKind: XERO_PROVIDER_KIND, exportKey };
        },
      };
      return {
        adapter: brokenAdapter,
        record: buildXeroExportRecord(),
        readIoCount: () => fake.calls.length,
        readFaultLog: () => fake.calls,
      };
    };

    await expect(
      runAccountingAdapterConformance([
        {
          id: "xero-preflight-skip-defect",
          happyExport: skippingPreflightHarness,
        },
      ]),
    ).rejects.toThrow(/ACCOUNTING_CONFORMANCE:zero_io_refusal_failed/);

    expect(
      validateAccountingExportRecord(buildXeroExportRecord(), xeroDefaultCapabilities),
    ).toBeNull();
  });
});
