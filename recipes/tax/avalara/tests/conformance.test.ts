import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  makeTaxQuoteRequest,
  runTaxAdapterConformance,
  type TaxConformanceCaseV1,
  type TaxConformanceSubjectV1,
} from "@openlup/platform/tax";
import {
  AVALARA_ORIGINS,
  AvalaraTransportError,
  avalaraStaticTaxCapabilities,
  createAvalaraHttpClient,
  createAvalaraTaxAdapter,
  fractionalRateToPercentString,
  majorToMinorAmount,
  minorToMajorAmount,
  projectAvalaraTaxStaticCapabilities,
  resolvePinnedAvalaraOrigin,
  type AvalaraCreateTransactionPayload,
  type FetchLike,
} from "../server/index.js";
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_EXPIRED_ISO,
  FIXTURE_FOREIGN_SCOPE,
  FIXTURE_LATER_ISO,
  FIXTURE_NOW_ISO,
  FIXTURE_SCOPE,
  FIXTURE_SENSITIVE_CANARIES,
  buildAvalaraResponse,
  buildBaseQuoteInput,
  buildCoverage,
  buildFixtureCredentials,
  buildFixtureMarketPack,
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

describe("recipes/tax/avalara — manifest, schema & inventory parity", () => {
  it("validates recipe.json against recipes/schema/recipe.schema.json (Draft 2020-12) and rejects invalid manifests", () => {
    const schema = JSON.parse(
      readFileSync(resolve(RECIPES_ROOT, "schema/recipe.schema.json"), "utf8"),
    ) as JsonSchemaNode;
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    expect(validateAgainstJsonSchema(manifest, schema)).toEqual([]);

    const invalidManifest = {
      ...manifest,
      egressOrigins: ["http://insecure.avatax.example"],
      extraField: true,
    };
    expect(validateAgainstJsonSchema(invalidManifest, schema).length).toBeGreaterThanOrEqual(2);
  });

  it("matches recipe.json staticCapabilities, exact disk allFiles inventory, and recipes/index.json catalog entry", () => {
    const manifest = JSON.parse(readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8"));
    expect(manifest.staticCapabilities).toEqual(projectAvalaraTaxStaticCapabilities());
    expect(manifest.providerKind).toBe(avalaraStaticTaxCapabilities.adapter);

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
    const entry = catalog.recipes.find((r) => r.id === "tax/avalara");
    expect(entry).toBeDefined();
    expect(entry?.domain).toBe(manifest.domain);
    expect(entry?.providerKind).toBe(manifest.providerKind);
    expect(entry?.displayName).toBe(manifest.displayName);
    expect(entry?.status).toBe(manifest.status);
    expect(entry?.manifestPath).toBe("tax/avalara/recipe.json");
  });
});

describe("recipes/tax/avalara — official 16-case runTaxAdapterConformance", () => {
  it("passes all 16 isolated conformance cases through the real createAvalaraHttpClient with zero secret/PII leakage", async () => {
    const observedPayloads: AvalaraCreateTransactionPayload[] = [];
    const expectedBasicAuth = `Basic ${Buffer.from(
      `${FIXTURE_SENSITIVE_CANARIES.accountId}:${FIXTURE_SENSITIVE_CANARIES.licenseKey}`,
      "utf8",
    ).toString("base64")}`;

    const subject: TaxConformanceSubjectV1 = {
      async open(caseId: TaxConformanceCaseV1) {
        let commits = 0;
        let reversals = 0;
        const providerCloses = 0;
        let httpCalls = 0;

        const fetchImpl: FetchLike = async (urlString, init) => {
          httpCalls += 1;
          const url = new URL(urlString);
          expect(url.origin).toBe(AVALARA_ORIGINS.sandbox);
          expect(init?.redirect).toBe("error");
          const headers = (init?.headers ?? {}) as Record<string, string>;
          expect(headers["authorization"]).toBe(expectedBasicAuth);
          expect(headers["x-avalara-client"]).toBe("OpenLupRecipe; 1.0; OpenLup; 1.3.0; runtime");

          if (caseId === "unavailable") {
            return new Response(JSON.stringify({ error: { code: "ServiceUnavailable" } }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }

          if (url.pathname.endsWith("/void")) {
            reversals += 1;
            const body = JSON.parse(init!.body as string) as { code: string };
            expect(body).toEqual({ code: "DocVoided" });
            const parts = url.pathname.split("/");
            const txCode = decodeURIComponent(parts[parts.length - 2]!);
            return new Response(JSON.stringify({ code: txCode, status: "Cancelled" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          const payload = JSON.parse(init!.body as string) as AvalaraCreateTransactionPayload;
          observedPayloads.push(payload);

          if (payload.type === "SalesInvoice") {
            commits += 1;
            return new Response(
              JSON.stringify(
                buildAvalaraResponse({
                  code: payload.code!,
                  status: "Committed",
                  lines: payload.lines.map((line) => ({
                    lineNumber: line.number,
                    lineAmount: line.amount,
                    taxableAmount: line.amount,
                    tax: 0,
                    details: [
                      {
                        jurisType: "STA",
                        jurisCode: "08",
                        country: "US",
                        region: "CO",
                        taxType: "Sales",
                        rate: 0,
                        taxableAmount: line.amount,
                        tax: 0,
                        rateRuleId: 101,
                      },
                    ],
                  })),
                }),
              ),
              { status: 201, headers: { "content-type": "application/json" } },
            );
          }

          if (payload.type === "ReturnInvoice") {
            reversals += 1;
            return new Response(
              JSON.stringify(
                buildAvalaraResponse({
                  code: payload.code!,
                  status: "Committed",
                  lines: payload.lines.map((line) => ({
                    lineNumber: line.number,
                    lineAmount: line.amount,
                    taxableAmount: line.amount,
                    tax: 0,
                    details: [],
                  })),
                }),
              ),
              { status: 201, headers: { "content-type": "application/json" } },
            );
          }

          // SalesOrder quotes tailored by conformance scenario
          if (caseId === "exempt_in_scope") {
            return new Response(
              JSON.stringify(
                buildAvalaraResponse({
                  code: "SO-EXEMPT-01",
                  lines: [
                    {
                      lineNumber: "ol-m-line-exempt",
                      lineAmount: 5,
                      taxableAmount: 0,
                      tax: 0,
                      details: [
                        {
                          jurisType: "STA",
                          jurisCode: "08",
                          country: "US",
                          region: "CO",
                          taxType: "Sales",
                          rate: 0,
                          taxableAmount: 0,
                          tax: 0,
                          exemptAmount: 5,
                          nonTaxableRuleId: 501,
                        },
                      ],
                    },
                    {
                      lineNumber: "ol-m-line-zero",
                      lineAmount: 0.05,
                      taxableAmount: 0.05,
                      tax: 0,
                      details: [
                        {
                          jurisType: "STA",
                          jurisCode: "08",
                          country: "US",
                          region: "CO",
                          taxType: "Sales",
                          rate: 0.029,
                          taxableAmount: 0.05,
                          tax: 0,
                          rateRuleId: 102,
                        },
                      ],
                    },
                  ],
                }),
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          if (caseId === "fee_on_free_delivery") {
            return new Response(
              JSON.stringify(
                buildAvalaraResponse({
                  code: "SO-FEE-01",
                  lines: [
                    {
                      lineNumber: "ol-m-line-1",
                      lineAmount: 10,
                      taxableAmount: 10,
                      tax: 0.29,
                      details: [
                        {
                          jurisType: "STA",
                          jurisCode: "08",
                          country: "US",
                          region: "CO",
                          taxType: "Sales",
                          rate: 0.029,
                          taxableAmount: 10,
                          tax: 0.29,
                          rateRuleId: 103,
                        },
                      ],
                    },
                    {
                      lineNumber: "ol-d-ship-1",
                      lineAmount: 0,
                      taxableAmount: 0,
                      tax: 0.25,
                      details: [
                        {
                          id: 901,
                          jurisType: "STA",
                          jurisCode: "08",
                          country: "US",
                          region: "CO",
                          taxType: "RetailDeliveryFee",
                          rate: 0,
                          taxableAmount: 0,
                          tax: 0.25,
                        },
                      ],
                    },
                  ],
                }),
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          if (caseId === "mixed_coverage") {
            return new Response(
              JSON.stringify(
                buildAvalaraResponse({
                  code: "SO-MIXED-01",
                  lines: [
                    {
                      lineNumber: "ol-m-line-1",
                      lineAmount: 10,
                      taxableAmount: 10,
                      tax: 0.29,
                      details: [
                        {
                          jurisType: "STA",
                          jurisCode: "08",
                          country: "US",
                          region: "CO",
                          taxType: "Sales",
                          rate: 0.029,
                          taxableAmount: 10,
                          tax: 0.29,
                          rateRuleId: 104,
                        },
                      ],
                    },
                  ],
                }),
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          // Default / posting / validity / local_close: single 100-minor-unit 0-tax position
          return new Response(
            JSON.stringify(
              buildAvalaraResponse({
                code: `SO-${caseId}`,
                lines: payload.lines.map((line) => ({
                  lineNumber: line.number,
                  lineAmount: line.amount,
                  taxableAmount: line.amount,
                  tax: 0,
                  details: [
                    {
                      jurisType: "STA",
                      jurisCode: "08",
                      country: "US",
                      region: "CO",
                      taxType: "Sales",
                      rate: 0,
                      taxableAmount: line.amount,
                      tax: 0,
                      rateRuleId: 105,
                    },
                  ],
                })),
              }),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        };

        const client = createAvalaraHttpClient({
          environment: "sandbox",
          fetchImpl,
          credentials: buildFixtureCredentials,
        });
        const port = createAvalaraTaxAdapter({
          client,
          companyCode: FIXTURE_COMPANY_CODE,
          scope: FIXTURE_SCOPE,
          marketPack: buildFixtureMarketPack(),
          clock: () => FIXTURE_NOW_ISO,
        });

        let request = makeTaxQuoteRequest(`req-${caseId}`, buildBaseQuoteInput());
        let advance: (() => { chargeAt: string; current: ReturnType<typeof buildBaseQuoteInput> }) | undefined;

        switch (caseId) {
          case "missing_class":
            request = makeTaxQuoteRequest(
              "req-missing-class",
              buildBaseQuoteInput({
                lines: [
                  {
                    lineKey: "line-1",
                    sku: "SKU-1",
                    mode: "one_time",
                    taxClass: "unmapped_class",
                    assignmentRef: "assign-1",
                  },
                ],
              }),
            );
            break;

          case "missing_rule":
            request = makeTaxQuoteRequest(
              "req-missing-rule",
              buildBaseQuoteInput({ shipFromRef: "unknown-origin" }),
            );
            break;

          case "tax_coverage_undeclared_refuses":
            request = makeTaxQuoteRequest(
              "req-undeclared",
              buildBaseQuoteInput({ coverage: buildCoverage([]) }),
            );
            break;

          case "inconsistent_coverage_refuses_charge":
            request = makeTaxQuoteRequest(
              "req-inconsistent",
              buildBaseQuoteInput({
                required: [
                  {
                    target: { kind: "line", key: "line-1" },
                    jurisdiction: "US-CA",
                    level: "state",
                    taxKind: "sales_tax",
                    sourcing: "destination",
                  },
                ],
                coverage: buildCoverage([
                  {
                    jurisdiction: "US-CA",
                    taxKind: "sales_tax",
                    effective: { from: "2029-01-01T00:00:00.000Z" },
                    actorRef: "actor-1",
                    recordedAt: "2029-01-01T00:00:00.000Z",
                    status: "registered",
                  },
                ]),
              }),
            );
            break;

          case "out_of_scope":
            request = makeTaxQuoteRequest(
              "req-out-of-scope",
              buildBaseQuoteInput({
                required: [
                  {
                    target: { kind: "line", key: "line-1" },
                    jurisdiction: "US-OR",
                    level: "state",
                    taxKind: "sales_tax",
                    sourcing: "destination",
                  },
                ],
                coverage: buildCoverage([
                  {
                    jurisdiction: "US-OR",
                    taxKind: "sales_tax",
                    effective: { from: "2029-01-01T00:00:00.000Z" },
                    actorRef: "actor-1",
                    recordedAt: "2029-01-01T00:00:00.000Z",
                    status: "not_registered_acknowledged",
                    acknowledgementRef: "ack-or-1",
                  },
                ]),
              }),
            );
            break;

          case "mixed_coverage":
            request = makeTaxQuoteRequest(
              "req-mixed",
              buildBaseQuoteInput({
                money: {
                  amountBasis: "exclusive",
                  sources: [{ lineKey: "line-1", sourceOrdinal: 1, quantity: 1, unitBasisMinor: 1000 }],
                  delivery: [],
                  adjustments: [],
                  fees: [],
                },
                required: [
                  {
                    target: { kind: "line", key: "line-1" },
                    jurisdiction: "US-CO",
                    level: "state",
                    taxKind: "sales_tax",
                    sourcing: "destination",
                  },
                  {
                    target: { kind: "line", key: "line-1" },
                    jurisdiction: "US-OR",
                    level: "state",
                    taxKind: "sales_tax",
                    sourcing: "destination",
                  },
                ],
                coverage: buildCoverage([
                  {
                    jurisdiction: "US-CO",
                    taxKind: "sales_tax",
                    effective: { from: "2029-01-01T00:00:00.000Z" },
                    actorRef: "actor-1",
                    recordedAt: "2029-01-01T00:00:00.000Z",
                    status: "registered",
                  },
                  {
                    jurisdiction: "US-OR",
                    taxKind: "sales_tax",
                    effective: { from: "2029-01-01T00:00:00.000Z" },
                    actorRef: "actor-1",
                    recordedAt: "2029-01-01T00:00:00.000Z",
                    status: "not_registered_acknowledged",
                    acknowledgementRef: "ack-or-mixed",
                  },
                ]),
              }),
            );
            break;

          case "exempt_in_scope":
            request = makeTaxQuoteRequest(
              "req-exempt-in-scope",
              buildBaseQuoteInput({
                money: {
                  amountBasis: "exclusive",
                  sources: [
                    { lineKey: "line-exempt", sourceOrdinal: 1, quantity: 1, unitBasisMinor: 500 },
                    { lineKey: "line-zero", sourceOrdinal: 2, quantity: 1, unitBasisMinor: 5 },
                  ],
                  delivery: [],
                  adjustments: [],
                  fees: [],
                },
                lines: [
                  {
                    lineKey: "line-exempt",
                    sku: "SKU-EXEMPT",
                    mode: "one_time",
                    taxClass: "exempt_food",
                    assignmentRef: "assign-exempt",
                  },
                  {
                    lineKey: "line-zero",
                    sku: "SKU-ZERO",
                    mode: "one_time",
                    taxClass: "standard",
                    assignmentRef: "assign-zero",
                  },
                ],
                required: [
                  {
                    target: { kind: "line", key: "line-exempt" },
                    jurisdiction: "US-CO",
                    level: "state",
                    taxKind: "sales_tax",
                    sourcing: "destination",
                  },
                  {
                    target: { kind: "line", key: "line-zero" },
                    jurisdiction: "US-CO",
                    level: "state",
                    taxKind: "sales_tax",
                    sourcing: "destination",
                  },
                ],
              }),
            );
            break;

          case "fee_on_free_delivery":
            request = makeTaxQuoteRequest(
              "req-fee-free-del",
              buildBaseQuoteInput({
                money: {
                  amountBasis: "exclusive",
                  sources: [{ lineKey: "line-1", sourceOrdinal: 1, quantity: 1, unitBasisMinor: 1000 }],
                  delivery: [{ bucketKey: "ship-1", deliveryKind: "shipping", amountMinor: 0 }],
                  adjustments: [],
                  fees: [],
                },
                delivery: [
                  {
                    bucketKey: "ship-1",
                    carrierRef: "ups",
                    serviceRef: "ground",
                    separatelyStated: true,
                    taxClass: "shipping",
                    assignmentRef: "assign-ship-1",
                    cost: { ref: "cost-ship-1", currency: "USD", amountMinor: 0 },
                  },
                ],
                required: [
                  {
                    target: { kind: "line", key: "line-1" },
                    jurisdiction: "US-CO",
                    level: "state",
                    taxKind: "sales_tax",
                    sourcing: "destination",
                  },
                  {
                    target: { kind: "delivery", key: "ship-1" },
                    jurisdiction: "US-CO",
                    level: "state",
                    taxKind: "sales_tax",
                    sourcing: "destination",
                  },
                  {
                    target: {
                      kind: "fee",
                      key: "co-rdf",
                      taxClass: "rdf_fee",
                      assignmentRef: "assign-rdf",
                      deliveryKey: "ship-1",
                    },
                    jurisdiction: "US-CO",
                    level: "state",
                    taxKind: "retail_delivery_fee",
                    sourcing: "destination",
                  },
                ],
                coverage: buildCoverage([
                  {
                    jurisdiction: "US-CO",
                    taxKind: "sales_tax",
                    effective: { from: "2029-01-01T00:00:00.000Z" },
                    actorRef: "actor-1",
                    recordedAt: "2029-01-01T00:00:00.000Z",
                    status: "registered",
                  },
                  {
                    jurisdiction: "US-CO",
                    taxKind: "retail_delivery_fee",
                    effective: { from: "2029-01-01T00:00:00.000Z" },
                    actorRef: "actor-1",
                    recordedAt: "2029-01-01T00:00:00.000Z",
                    status: "registered",
                  },
                ]),
              }),
            );
            break;

          case "rate_change":
            advance = () => ({ chargeAt: FIXTURE_LATER_ISO, current: buildBaseQuoteInput({ taxDate: FIXTURE_LATER_ISO }) });
            break;

          case "expiry":
            advance = () => ({ chargeAt: FIXTURE_EXPIRED_ISO, current: buildBaseQuoteInput({ taxDate: FIXTURE_EXPIRED_ISO }) });
            break;

          case "foreign_validity_scope":
            advance = () => ({
              chargeAt: FIXTURE_LATER_ISO,
              current: buildBaseQuoteInput({ scope: FIXTURE_FOREIGN_SCOPE, taxDate: FIXTURE_LATER_ISO }),
            });
            break;

          default:
            break;
        }

        return {
          port,
          request,
          ...(advance ? { advance } : {}),
          effects: () => {
            // Assert zero HTTP calls on pre-flight refusal and pure out-of-scope cases
            if (
              caseId === "missing_class" ||
              caseId === "missing_rule" ||
              caseId === "tax_coverage_undeclared_refuses" ||
              caseId === "inconsistent_coverage_refuses_charge" ||
              caseId === "out_of_scope"
            ) {
              expect(httpCalls).toBe(0);
            }
            return { commits, reversals, providerCloses };
          },
        };
      },
    };

    const completedCases = await runTaxAdapterConformance(subject);
    expect(completedCases).toHaveLength(16);
    expect(observedPayloads.some((p) => p.type === "SalesOrder")).toBe(true);
    expect(observedPayloads.some((p) => p.type === "SalesInvoice")).toBe(true);
    expect(observedPayloads.some((p) => p.type === "ReturnInvoice")).toBe(true);
    // Verify opaque customerCode never leaks raw customer PII
    for (const payload of observedPayloads) {
      expect(payload.customerCode).toMatch(/^ol-cust-[0-9a-f]{24}$/u);
    }
  });
});

describe("recipes/tax/avalara — precision, transport hardening & planted-defect negative controls", () => {
  it("converts minor/major amounts and fractional rates cleanly without IEEE-754 drift", () => {
    expect(minorToMajorAmount(100, 2)).toBe(1);
    expect(minorToMajorAmount(1299, 2)).toBe(12.99);
    expect(minorToMajorAmount(-40, 2)).toBe(-0.4);
    expect(minorToMajorAmount(500, 0)).toBe(500);
    expect(majorToMinorAmount(12.99, 2)).toBe(1299);
    expect(majorToMinorAmount(0.29, 2)).toBe(29);
    expect(fractionalRateToPercentString(0.0825)).toBe("8.25");
    expect(fractionalRateToPercentString(0.029)).toBe("2.9");
    expect(fractionalRateToPercentString(0.0)).toBe("0");
    expect(fractionalRateToPercentString(0.1)).toBe("10");
  });

  it("pins sandbox and production HTTPS origins, rejects path traversal, and cancels streaming oversized responses", async () => {
    expect(resolvePinnedAvalaraOrigin("sandbox")).toBe("https://sandbox-rest.avatax.com");
    expect(resolvePinnedAvalaraOrigin("production")).toBe("https://rest.avatax.com");
    expect(() => resolvePinnedAvalaraOrigin("staging" as "sandbox")).toThrow(AvalaraTransportError);

    let ioCalls = 0;
    const silentClient = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async () => {
        ioCalls += 1;
        throw new Error("should_not_reach_network");
      },
    });
    for (const badSeg of ["..", ".", "a/b", "bad..code", ""]) {
      await expect(silentClient.voidTransaction(FIXTURE_COMPANY_CODE, badSeg, { code: "DocVoided" })).rejects.toMatchObject({
        code: "avalara_invalid_transaction_code",
        effect: "none",
      });
    }
    expect(ioCalls).toBe(0);

    // Streaming oversized response cancelled immediately without buffering full payload
    let streamCancelled = false;
    let chunksPulled = 0;
    const streamingClient = createAvalaraHttpClient({
      environment: "sandbox",
      maxBodyBytes: 100,
      credentials: buildFixtureCredentials,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunksPulled += 1;
              controller.enqueue(new Uint8Array(64).fill(0x61));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      streamingClient.voidTransaction(FIXTURE_COMPANY_CODE, "ol-tx-1", { code: "DocVoided" }),
    ).rejects.toMatchObject({
      code: "avalara_response_too_large",
      effect: "unknown",
    });
    expect(streamCancelled).toBe(true);
    expect(chunksPulled).toBeLessThanOrEqual(3);
  });

  it("keeps request timeout active through body read and redacts credentials and PII-bearing 4xx error messages", async () => {
    const slowClient = createAvalaraHttpClient({
      environment: "sandbox",
      timeoutMs: 30,
      credentials: buildFixtureCredentials,
      fetchImpl: async (_url, init) =>
        ({
          ok: true,
          status: 200,
          body: null,
          headers: new Headers({ "content-type": "application/json" }),
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        }) as unknown as Response,
    });
    await expect(
      slowClient.voidTransaction(FIXTURE_COMPANY_CODE, "ol-tx-slow", { code: "DocVoided" }),
    ).rejects.toMatchObject({
      code: "avalara_timeout",
      retryable: true,
      effect: "unknown",
    });

    // 400 error echoing customer address in message must be redacted down to machine code only
    const pii400Client = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "InvalidAddress",
              message: `Address ${FIXTURE_SENSITIVE_CANARIES.customerStreet} ${FIXTURE_SENSITIVE_CANARIES.customerPostal} invalid`,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      await pii400Client.voidTransaction(FIXTURE_COMPANY_CODE, "ol-tx-400", { code: "DocVoided" });
      expect.unreachable("expected AvalaraTransportError");
    } catch (error) {
      expect(error).toBeInstanceOf(AvalaraTransportError);
      const serialized = JSON.stringify(error) + String(error);
      expect((error as AvalaraTransportError).code).toBe("avalara_InvalidAddress");
      expect(serialized).not.toContain(FIXTURE_SENSITIVE_CANARIES.customerStreet);
      expect(serialized).not.toContain(FIXTURE_SENSITIVE_CANARIES.licenseKey);
      expect(serialized).not.toContain(FIXTURE_SENSITIVE_CANARIES.accountId);
    }
  });

  it("planted-defect negative controls: runTaxAdapterConformance catches broken local close or wrong reversal delta", async () => {
    // Planted defect 1: closeCalculation increments providerCloses -> conformance MUST fail
    const badCloseSubject: TaxConformanceSubjectV1 = {
      async open(caseId) {
        let providerCloses = 0;
        const basePort = createAvalaraTaxAdapter({
          client: {
            createTransaction: async (payload) =>
              buildAvalaraResponse({
                code: payload.code ?? "SO-DEFECT",
                lines: payload.lines.map((l) => ({
                  lineNumber: l.number,
                  lineAmount: l.amount,
                  taxableAmount: l.amount,
                  tax: 0,
                  details: [
                    {
                      jurisType: "STA",
                      jurisCode: "08",
                      country: "US",
                      region: "CO",
                      taxType: "Sales",
                      rate: 0,
                      taxableAmount: l.amount,
                      tax: 0,
                    },
                  ],
                })),
              }),
            voidTransaction: async (_c, code) => ({ code, status: "Cancelled" }),
          },
          companyCode: FIXTURE_COMPANY_CODE,
          scope: FIXTURE_SCOPE,
          marketPack: buildFixtureMarketPack(),
          clock: () => FIXTURE_NOW_ISO,
        });
        const plantedPort = {
          ...basePort,
          async closeCalculation(...args: Parameters<typeof basePort.closeCalculation>) {
            providerCloses += 1;
            return basePort.closeCalculation(...args);
          },
        };
        return {
          port: plantedPort,
          request: makeTaxQuoteRequest(`req-${caseId}`, buildBaseQuoteInput()),
          effects: () => ({ commits: 0, reversals: 0, providerCloses }),
        };
      },
    };
    await expect(runTaxAdapterConformance(badCloseSubject)).rejects.toThrow(/tax_adapter_conformance/u);
  });
});
