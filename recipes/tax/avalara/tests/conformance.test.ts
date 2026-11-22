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
import type { TaxCalculationPortV1, TaxReverseRequestV1 } from "@openlup/platform/tax/contracts";
import {
  AVALARA_ORIGINS,
  AvalaraTransportError,
  avalaraStaticTaxCapabilities,
  buildAvalaraCommitCode,
  buildAvalaraReversalCode,
  createAvalaraHttpClient,
  createAvalaraTaxAdapter,
  fractionalRateToPercentString,
  getCurrencyExponent,
  majorToMinorAmount,
  minorToMajorAmount,
  projectAvalaraTaxStaticCapabilities,
  resolvePinnedAvalaraOrigin,
  type AvalaraCreateTransactionPayload,
  type AvalaraTransactionResponse,
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

const EXPECTED_BASIC_AUTH = `Basic ${Buffer.from(
  `${FIXTURE_SENSITIVE_CANARIES.accountId}:${FIXTURE_SENSITIVE_CANARIES.licenseKey}`,
  "utf8",
).toString("base64")}`;

const ALL_CANARIES: readonly string[] = [
  FIXTURE_SENSITIVE_CANARIES.accountId,
  FIXTURE_SENSITIVE_CANARIES.licenseKey,
  FIXTURE_SENSITIVE_CANARIES.customerStreet,
  FIXTURE_SENSITIVE_CANARIES.customerPostal,
  Buffer.from(
    `${FIXTURE_SENSITIVE_CANARIES.accountId}:${FIXTURE_SENSITIVE_CANARIES.licenseKey}`,
    "utf8",
  ).toString("base64"),
  Buffer.from(FIXTURE_SENSITIVE_CANARIES.licenseKey, "utf8").toString("base64"),
  Buffer.from(FIXTURE_SENSITIVE_CANARIES.customerStreet, "utf8").toString("base64"),
  encodeURIComponent(FIXTURE_SENSITIVE_CANARIES.licenseKey),
  encodeURIComponent(FIXTURE_SENSITIVE_CANARIES.customerStreet),
];

function assertNoCanaryLeak(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const canary of ALL_CANARIES) {
    expect(serialized).not.toContain(canary);
  }
}

interface ObservedWireCall {
  readonly method: string;
  readonly pathname: string;
  readonly payload?: AvalaraCreateTransactionPayload | { readonly code: string };
}

interface ConformanceHarnessOptions {
  readonly wrapPort?: (
    basePort: TaxCalculationPortV1,
    counters: { incrementProviderClose: () => void },
  ) => TaxCalculationPortV1;
  readonly observedPayloads?: AvalaraCreateTransactionPayload[];
  readonly observedWireCalls?: ObservedWireCall[];
  readonly observedOutputs?: unknown[];
}

function createAvalaraConformanceSubject(
  options: ConformanceHarnessOptions = {},
): TaxConformanceSubjectV1 {
  return {
    async open(caseId: TaxConformanceCaseV1) {
      let commits = 0;
      let reversals = 0;
      let providerCloses = 0;
      let httpCalls = 0;
      const docsByCode = new Map<string, AvalaraTransactionResponse>();

      const voidPathRegex = new RegExp(
        `^/api/v2/companies/${FIXTURE_COMPANY_CODE}/transactions/([^/]+)/void$`,
        "u",
      );
      const getPathRegex = new RegExp(
        `^/api/v2/companies/${FIXTURE_COMPANY_CODE}/transactions/([^/]+)$`,
        "u",
      );

      const fetchImpl: FetchLike = async (urlString, init) => {
        httpCalls += 1;
        const url = new URL(urlString);
        const method = init?.method ?? "GET";
        expect(url.origin).toBe(AVALARA_ORIGINS.sandbox);
        expect(init?.redirect).toBe("error");
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers["authorization"]).toBe(EXPECTED_BASIC_AUTH);
        expect(headers["x-avalara-client"]).toBe("OpenLupRecipe; 1.0; OpenLup; 1.3.0; runtime");

        if (caseId === "unavailable") {
          options.observedWireCalls?.push({ method, pathname: url.pathname });
          return new Response(JSON.stringify({ error: { code: "ServiceUnavailable" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }

        const getMatch = method === "GET" ? getPathRegex.exec(url.pathname) : null;
        if (getMatch) {
          const txCode = decodeURIComponent(getMatch[1]!);
          options.observedWireCalls?.push({ method, pathname: url.pathname });
          const existing = docsByCode.get(txCode);
          if (!existing) {
            return new Response(JSON.stringify({ error: { code: "EntityNotFoundError" } }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify(existing), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        const voidMatch = method === "POST" ? voidPathRegex.exec(url.pathname) : null;
        if (voidMatch) {
          reversals += 1;
          const body = JSON.parse(init!.body as string) as { code: string };
          expect(body).toEqual({ code: "DocVoided" });
          const txCode = decodeURIComponent(voidMatch[1]!);
          options.observedWireCalls?.push({ method, pathname: url.pathname, payload: body });
          const existing = docsByCode.get(txCode);
          const cancelled: AvalaraTransactionResponse = existing
            ? { ...existing, status: "Cancelled" }
            : buildAvalaraResponse({ code: txCode, status: "Cancelled", lines: [] });
          docsByCode.set(txCode, cancelled);
          return new Response(JSON.stringify({ code: txCode, status: "Cancelled" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        expect(method).toBe("POST");
        expect(url.pathname).toBe("/api/v2/transactions/create");
        const payload = JSON.parse(init!.body as string) as AvalaraCreateTransactionPayload;
        options.observedPayloads?.push(payload);
        options.observedWireCalls?.push({ method, pathname: url.pathname, payload });

        if (payload.type === "SalesInvoice") {
          commits += 1;
          const doc = buildAvalaraResponse({
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
          });
          docsByCode.set(doc.code, doc);
          return new Response(JSON.stringify(doc), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }

        if (payload.type === "ReturnInvoice") {
          reversals += 1;
          const overrideTax =
            payload.taxOverride?.type === "TaxAmount" && typeof payload.taxOverride.taxAmount === "number"
              ? payload.taxOverride.taxAmount
              : 0;
          const doc = buildAvalaraResponse({
            code: payload.code!,
            status: "Committed",
            lines: payload.lines.map((line, idx) => ({
              lineNumber: line.number,
              lineAmount: line.amount,
              taxableAmount: line.amount,
              tax: idx === 0 ? overrideTax : 0,
              details: [],
            })),
          });
          docsByCode.set(doc.code, doc);
          return new Response(JSON.stringify(doc), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }

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
                        jurisType: "STA",
                        jurisCode: "08",
                        country: "US",
                        region: "CO",
                        taxType: "Sales",
                        rate: 0.029,
                        taxableAmount: 0,
                        tax: 0,
                        rateRuleId: 106,
                      },
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
      const basePort = createAvalaraTaxAdapter({
        client,
        companyCode: FIXTURE_COMPANY_CODE,
        scope: FIXTURE_SCOPE,
        marketPack: buildFixtureMarketPack(),
        clock: () => FIXTURE_NOW_ISO,
      });

      const observedPort: TaxCalculationPortV1 = options.observedOutputs
        ? {
            ...basePort,
            async quote(req) {
              const out = await basePort.quote(req);
              options.observedOutputs!.push(out);
              return out;
            },
            async closeCalculation(ref, reason, key) {
              const out = await basePort.closeCalculation(ref, reason, key);
              options.observedOutputs!.push(out);
              return out;
            },
            async commit(req) {
              const out = await basePort.commit(req);
              options.observedOutputs!.push(out);
              return out;
            },
            async reverse(req) {
              const out = await basePort.reverse(req);
              options.observedOutputs!.push(out);
              return out;
            },
          }
        : basePort;

      const port = options.wrapPort
        ? options.wrapPort(observedPort, {
            incrementProviderClose: () => {
              providerCloses += 1;
            },
          })
        : observedPort;

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
          advance = () => ({
            chargeAt: FIXTURE_LATER_ISO,
            current: buildBaseQuoteInput({ taxDate: FIXTURE_LATER_ISO }),
          });
          break;

        case "expiry":
          advance = () => ({
            chargeAt: FIXTURE_EXPIRED_ISO,
            current: buildBaseQuoteInput({ taxDate: FIXTURE_EXPIRED_ISO }),
          });
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
  it("passes all 16 isolated conformance cases with verified AvaTax REST v2 wire shapes and zero canary leakage", async () => {
    const observedPayloads: AvalaraCreateTransactionPayload[] = [];
    const observedWireCalls: ObservedWireCall[] = [];
    const observedOutputs: unknown[] = [];

    const completedCases = await runTaxAdapterConformance(
      createAvalaraConformanceSubject({ observedPayloads, observedWireCalls, observedOutputs }),
    );
    expect(completedCases).toHaveLength(16);

    // Wire-level assertions across all 4 AvaTax operations
    const salesOrders = observedPayloads.filter((p) => p.type === "SalesOrder");
    const salesInvoices = observedPayloads.filter((p) => p.type === "SalesInvoice");
    const returnInvoices = observedPayloads.filter((p) => p.type === "ReturnInvoice");
    const voidCalls = observedWireCalls.filter((c) => c.pathname.endsWith("/void"));

    expect(salesOrders.length).toBeGreaterThan(0);
    expect(salesInvoices.length).toBeGreaterThan(0);
    expect(returnInvoices.length).toBeGreaterThan(0);
    expect(voidCalls.length).toBeGreaterThan(0);

    for (const so of salesOrders) {
      expect(so.commit).toBe(false);
      expect(so.companyCode).toBe(FIXTURE_COMPANY_CODE);
      expect(so.date).toBe("2030-06-15");
      expect(so.addresses.shipFrom.country).toBe("US");
      expect(so.addresses.shipTo.country).toBe("US");
      expect(so.lines.length).toBeGreaterThan(0);
      expect(so.lines[0]?.taxCode).toBeTruthy();
      expect(so.customerCode).toMatch(/^ol-cust-[0-9a-f]{24}$/u);
    }

    for (const si of salesInvoices) {
      expect(si.commit).toBe(true);
      expect(si.code).toMatch(/^ol-[0-9a-f]{44}$/u);
      expect(si.lines[0]?.taxCode).toBe("P0000000");
    }

    for (const ri of returnInvoices) {
      expect(ri.commit).toBe(true);
      expect(ri.code).toMatch(/^ol-r-[0-9a-f]{42}$/u);
      expect(ri.referenceCode).toMatch(/^ol-[0-9a-f]{44}$/u);
      expect(ri.taxOverride).toBeDefined();
      expect(ri.lines[0]?.amount).toBeLessThan(0);
      expect(ri.lines[0]?.taxCode).toBe("P0000000");
    }

    for (const vc of voidCalls) {
      expect(vc.pathname).toMatch(
        new RegExp(`^/api/v2/companies/${FIXTURE_COMPANY_CODE}/transactions/ol-[0-9a-f]{44}/void$`, "u"),
      );
      expect(vc.payload).toEqual({ code: "DocVoided" });
    }

    // Raw, URL-encoded, and Base64 canary sweep across all captured port outputs
    expect(observedOutputs.length).toBeGreaterThan(0);
    assertNoCanaryLeak(observedOutputs);
  });

  it("planted-defect negative controls: runTaxAdapterConformance catches broken local_close and corrupted reversal deltas", async () => {
    // Defect 1: closeCalculation increments providerCloses -> MUST fail specifically on local_close
    const badCloseSubject = createAvalaraConformanceSubject({
      wrapPort: (basePort, counters) => ({
        ...basePort,
        async closeCalculation(...args) {
          counters.incrementProviderClose();
          return basePort.closeCalculation(...args);
        },
      }),
    });
    await expect(runTaxAdapterConformance(badCloseSubject)).rejects.toThrow(
      /tax_adapter_conformance:local_close/u,
    );

    // Defect 2: reverse returns a corrupted position delta -> MUST fail on a reversal case
    const badReverseSubject = createAvalaraConformanceSubject({
      wrapPort: (basePort) => ({
        ...basePort,
        async reverse(req) {
          const out = await basePort.reverse(req);
          if (out.kind === "reversed" && out.positions.length > 0) {
            return {
              ...out,
              positions: out.positions.map((p, idx) =>
                idx === 0 ? { ...p, netDeltaMinor: p.netDeltaMinor - 1 } : p,
              ),
            };
          }
          return out;
        },
      }),
    });
    await expect(runTaxAdapterConformance(badReverseSubject)).rejects.toThrow(
      /tax_adapter_conformance:(?:full_reversal|partial_then_full|idempotent_reverse|reference_conflict)/u,
    );
  });
});

describe("recipes/tax/avalara — precision, protocol, schema validation, recovery & transport hardening", () => {
  it("converts minor/major amounts with exact decimal half-away-from-zero rounding and validates ISO-4217 currencies", () => {
    expect(minorToMajorAmount(100, 2)).toBe(1);
    expect(minorToMajorAmount(1299, 2)).toBe(12.99);
    expect(minorToMajorAmount(-40, 2)).toBe(-0.4);
    expect(minorToMajorAmount(500, 0)).toBe(500);

    // Exact decimal half-cent cases where binary Math.round(x * 100) drifts
    expect(majorToMinorAmount(35.855, 2)).toBe(3586);
    expect(majorToMinorAmount(10.075, 2)).toBe(1008);
    expect(majorToMinorAmount(-100.005, 2)).toBe(-10001);
    expect(majorToMinorAmount(12.99, 2)).toBe(1299);
    expect(majorToMinorAmount(0.29, 2)).toBe(29);
    expect(majorToMinorAmount(1e-2, 2)).toBe(1);
    expect(majorToMinorAmount(0, 2)).toBe(0);

    expect(fractionalRateToPercentString(0.0825)).toBe("8.25");
    expect(fractionalRateToPercentString(0.029)).toBe("2.9");
    expect(fractionalRateToPercentString(0.0)).toBe("0");
    expect(fractionalRateToPercentString(0.1)).toBe("10");

    // Standard ISO-4217 currency acceptance and invalid-code rejection
    expect(getCurrencyExponent("USD")).toBe(2);
    expect(getCurrencyExponent("JPY")).toBe(0);
    expect(getCurrencyExponent("BHD")).toBe(3);
    expect(getCurrencyExponent("ZZZ")).toBeNull();
    expect(getCurrencyExponent("XXX")).toBeNull();
    expect(getCurrencyExponent("ABC")).toBeNull();
    expect(getCurrencyExponent("")).toBeNull();
    expect(getCurrencyExponent("usd")).toBeNull();
  });

  it("enforces scope.mode <-> client.environment alignment at adapter construction", () => {
    const sandboxClient = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const prodClient = createAvalaraHttpClient({
      environment: "production",
      credentials: buildFixtureCredentials,
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    expect(() =>
      createAvalaraTaxAdapter({
        client: prodClient,
        companyCode: FIXTURE_COMPANY_CODE,
        scope: { ...FIXTURE_SCOPE, mode: "test" },
        marketPack: buildFixtureMarketPack(),
        clock: () => FIXTURE_NOW_ISO,
      }),
    ).toThrow("avalara_scope_environment_mismatch");

    expect(() =>
      createAvalaraTaxAdapter({
        client: sandboxClient,
        companyCode: FIXTURE_COMPANY_CODE,
        scope: { ...FIXTURE_SCOPE, mode: "live" },
        marketPack: buildFixtureMarketPack(),
        clock: () => FIXTURE_NOW_ISO,
      }),
    ).toThrow("avalara_scope_environment_mismatch");
  });

  it("pins origins (including prototype keys), validates path/credentials, uses official AvaTax companies/.../void & GET readback, and cancels oversized streams", async () => {
    expect(resolvePinnedAvalaraOrigin("sandbox")).toBe("https://sandbox-rest.avatax.com");
    expect(resolvePinnedAvalaraOrigin("production")).toBe("https://rest.avatax.com");
    expect(() => resolvePinnedAvalaraOrigin("staging" as "sandbox")).toThrow(AvalaraTransportError);
    expect(() => resolvePinnedAvalaraOrigin("toString" as "sandbox")).toThrow(AvalaraTransportError);

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
      await expect(
        silentClient.voidTransaction(FIXTURE_COMPANY_CODE, badSeg, { code: "DocVoided" }),
      ).rejects.toMatchObject({
        code: "avalara_invalid_transaction_code",
        effect: "none",
      });
      await expect(silentClient.getTransactionByCode(FIXTURE_COMPANY_CODE, badSeg)).rejects.toMatchObject({
        code: "avalara_invalid_transaction_code",
        effect: "none",
      });
    }
    expect(ioCalls).toBe(0);

    // Reject colon in accountId before any network I/O
    const badCredsClient = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: () => ({ accountId: "bad:id", licenseKey: "valid-key" }),
      fetchImpl: async () => {
        ioCalls += 1;
        throw new Error("should_not_reach_network");
      },
    });
    await expect(
      badCredsClient.voidTransaction(FIXTURE_COMPANY_CODE, "ol-tx-1", { code: "DocVoided" }),
    ).rejects.toMatchObject({
      code: "avalara_credentials_missing",
      effect: "none",
    });
    expect(ioCalls).toBe(0);

    // Verify exact official VoidTransaction & GetTransactionByCode URLs and 404 -> null
    const seenRequests: { method: string; path: string }[] = [];
    const urlClient = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async (urlString, init) => {
        const u = new URL(urlString);
        seenRequests.push({ method: init?.method ?? "GET", path: u.pathname });
        if (init?.method === "GET") {
          return new Response(JSON.stringify({ error: { code: "EntityNotFoundError" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: "ol-tx-1", status: "Cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(await urlClient.getTransactionByCode(FIXTURE_COMPANY_CODE, "ol-tx-missing")).toBeNull();
    expect(await urlClient.voidTransaction(FIXTURE_COMPANY_CODE, "ol-tx-1", { code: "DocVoided" })).toEqual({
      code: "ol-tx-1",
      status: "Cancelled",
    });
    expect(seenRequests).toEqual([
      { method: "GET", path: `/api/v2/companies/${FIXTURE_COMPANY_CODE}/transactions/ol-tx-missing` },
      { method: "POST", path: `/api/v2/companies/${FIXTURE_COMPANY_CODE}/transactions/ol-tx-1/void` },
    ]);

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
      expect((error as AvalaraTransportError).code).toBe("avalara_InvalidAddress");
      assertNoCanaryLeak(JSON.stringify(error) + String(error));
    }
  });

  it("fails closed on empty Avalara details, unmapped county tax, negative rates, lineAmount/totalTax mismatch, and mixed rates", async () => {
    let nextResponse: AvalaraTransactionResponse = buildAvalaraResponse({ code: "SO-1", lines: [] });
    const client = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async () =>
        new Response(JSON.stringify(nextResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const port = createAvalaraTaxAdapter({
      client,
      companyCode: FIXTURE_COMPANY_CODE,
      scope: FIXTURE_SCOPE,
      marketPack: buildFixtureMarketPack(),
      clock: () => FIXTURE_NOW_ISO,
    });

    const req = makeTaxQuoteRequest("req-integrity", buildBaseQuoteInput());

    // 1. Empty details on a registered cell MUST return unavailable_evidence (never fabricate 0% taxable!)
    nextResponse = buildAvalaraResponse({
      code: "SO-EMPTY",
      lines: [{ lineNumber: "ol-m-line-1", lineAmount: 1, taxableAmount: 1, tax: 0, details: [] }],
    });
    expect(await port.quote(req)).toMatchObject({
      kind: "unavailable",
      code: "tax_coverage_evidence_unavailable",
    });

    // 2. Unmapped non-zero county detail MUST refuse tax_breakdown_incomplete
    nextResponse = buildAvalaraResponse({
      code: "SO-UNMAPPED-CNT",
      lines: [
        {
          lineNumber: "ol-m-line-1",
          lineAmount: 1,
          taxableAmount: 1,
          tax: 0.05,
          details: [
            {
              jurisType: "STA",
              jurisCode: "08",
              country: "US",
              region: "CO",
              taxType: "Sales",
              rate: 0.03,
              taxableAmount: 1,
              tax: 0.03,
            },
            {
              jurisType: "CNT",
              jurisCode: "031",
              country: "US",
              region: "CO",
              taxType: "Sales",
              rate: 0.02,
              taxableAmount: 1,
              tax: 0.02,
            },
          ],
        },
      ],
    });
    expect(await port.quote(req)).toMatchObject({
      kind: "refused",
      code: "tax_breakdown_incomplete",
    });

    // 3. Negative rate MUST refuse tax_breakdown_incomplete (never uncaught throw)
    nextResponse = buildAvalaraResponse({
      code: "SO-NEG-RATE",
      lines: [
        {
          lineNumber: "ol-m-line-1",
          lineAmount: 1,
          taxableAmount: 1,
          tax: 0,
          details: [
            {
              jurisType: "STA",
              jurisCode: "08",
              country: "US",
              region: "CO",
              taxType: "Sales",
              rate: -0.05,
              taxableAmount: 1,
              tax: 0,
            },
          ],
        },
      ],
    });
    expect(await port.quote(req)).toMatchObject({
      kind: "refused",
      code: "tax_breakdown_incomplete",
    });

    // 4. Echoed lineAmount mismatch MUST refuse tax_breakdown_incomplete
    nextResponse = buildAvalaraResponse({
      code: "SO-LINE-MISMATCH",
      lines: [
        {
          lineNumber: "ol-m-line-1",
          lineAmount: 9.99,
          taxableAmount: 9.99,
          tax: 0,
          details: [
            {
              jurisType: "STA",
              jurisCode: "08",
              country: "US",
              region: "CO",
              taxType: "Sales",
              rate: 0,
              taxableAmount: 9.99,
              tax: 0,
            },
          ],
        },
      ],
    });
    expect(await port.quote(req)).toMatchObject({
      kind: "refused",
      code: "tax_breakdown_incomplete",
    });

    // 5. Multiple distinct rates matching one cell MUST refuse tax_breakdown_incomplete
    nextResponse = buildAvalaraResponse({
      code: "SO-MULTI-RATE",
      lines: [
        {
          lineNumber: "ol-m-line-1",
          lineAmount: 1,
          taxableAmount: 1,
          tax: 0.05,
          details: [
            {
              jurisType: "STA",
              jurisCode: "08",
              country: "US",
              region: "CO",
              taxType: "Sales",
              rate: 0.02,
              taxableAmount: 1,
              tax: 0.02,
            },
            {
              jurisType: "STA",
              jurisCode: "08",
              country: "US",
              region: "CO",
              taxType: "Sales",
              rate: 0.03,
              taxableAmount: 1,
              tax: 0.03,
            },
          ],
        },
      ],
    });
    expect(await port.quote(req)).toMatchObject({
      kind: "refused",
      code: "tax_breakdown_incomplete",
    });

    // 6. Response totalTax mismatch MUST refuse tax_breakdown_incomplete
    nextResponse = {
      ...buildAvalaraResponse({
        code: "SO-TOTAL-MISMATCH",
        lines: [
          {
            lineNumber: "ol-m-line-1",
            lineAmount: 1,
            taxableAmount: 1,
            tax: 0.03,
            details: [
              {
                jurisType: "STA",
                jurisCode: "08",
                country: "US",
                region: "CO",
                taxType: "Sales",
                rate: 0.03,
                taxableAmount: 1,
                tax: 0.03,
              },
            ],
          },
        ],
      }),
      totalTax: 0.99,
    };
    expect(await port.quote(req)).toMatchObject({
      kind: "refused",
      code: "tax_breakdown_incomplete",
    });
  });

  it("validates closeCalculation/commit/reverse schemas, refuses out_of_scope commit, refuses partial mode:full void, and deduplicates multi-jurisdiction originalPositionRefs", async () => {
    let voidCalls = 0;
    let postCalls = 0;

    const client = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async (urlString, init) => {
        const u = new URL(urlString);
        if (u.pathname.endsWith("/void")) {
          voidCalls += 1;
          return new Response(JSON.stringify({ code: "should-not-void", status: "Cancelled" }), { status: 200 });
        }
        postCalls += 1;
        const payload = JSON.parse(init!.body as string) as AvalaraCreateTransactionPayload;
        return new Response(
          JSON.stringify(
            buildAvalaraResponse({
              code: payload.code ?? "SO-MULTI-JURIS",
              status: payload.commit ? "Committed" : "Temporary",
              lines: payload.lines.map((l) => ({
                lineNumber: l.number,
                lineAmount: l.amount,
                taxableAmount: l.amount,
                tax: 0.05,
                details: [
                  {
                    jurisType: "STA",
                    jurisCode: "08",
                    country: "US",
                    region: "CO",
                    taxType: "Sales",
                    rate: 0.03,
                    taxableAmount: l.amount,
                    tax: 0.03,
                    rateRuleId: 701,
                  },
                  {
                    jurisType: "CNT",
                    jurisCode: "031",
                    country: "US",
                    region: "CO",
                    taxType: "Sales",
                    rate: 0.02,
                    taxableAmount: l.amount,
                    tax: 0.02,
                    rateRuleId: 702,
                  },
                ],
              })),
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const basePack = buildFixtureMarketPack();
    const port = createAvalaraTaxAdapter({
      client,
      companyCode: FIXTURE_COMPANY_CODE,
      scope: FIXTURE_SCOPE,
      marketPack: {
        ...basePack,
        jurisdictions: [
          ...basePack.jurisdictions,
          {
            jurisdiction: "US-CO-DEN",
            level: "county",
            taxKind: "sales_tax",
            sourcing: "destination",
            country: "US",
            region: "CO",
            jurisType: "CNT",
            taxType: "Sales",
          },
        ],
        registrations: [
          ...basePack.registrations,
          {
            jurisdiction: "US-CO-DEN",
            taxKind: "sales_tax",
            state: "active",
            effective: { from: "2029-01-01T00:00:00.000Z" },
            evidenceRef: "reg-us-co-den",
          },
        ],
      },
      clock: () => FIXTURE_NOW_ISO,
    });

    // 1. Out-of-scope quote produces 0 HTTP calls and refuses commit at 0 HTTP calls
    const oosReq = makeTaxQuoteRequest(
      "req-oos-no-commit",
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
            acknowledgementRef: "ack-or-only",
          },
        ]),
      }),
    );
    const oosQuote = await port.quote(oosReq);
    expect(oosQuote.kind).toBe("final");
    expect(postCalls).toBe(0);
    if (oosQuote.kind !== "final") return;

    const oosCommit = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: oosQuote.evidence.calculationRef,
        evidenceDigest: oosQuote.evidenceDigest,
      },
      transactionRef: "tx-oos-refused",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-oos",
      intent: "apply",
    });
    expect(oosCommit).toMatchObject({ kind: "refused", code: "tax_calculation_unusable" });
    expect(postCalls).toBe(0);

    // 2. Schema validation on closeCalculation & commit (postedAt < capturedAt)
    const badClose = await port.closeCalculation(
      {
        scope: FIXTURE_SCOPE,
        ref: oosQuote.evidence.calculationRef,
        evidenceDigest: oosQuote.evidenceDigest,
      },
      { kind: "invalid_reason" } as unknown as Parameters<typeof port.closeCalculation>[1],
      "close-bad",
    );
    expect(badClose.kind).toBe("refused");

    // 3. Multi-jurisdiction merchandise line deduplicates originalPositionRefs in commit().positions
    const multiReq = makeTaxQuoteRequest(
      "req-multi-juris",
      buildBaseQuoteInput({
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
            jurisdiction: "US-CO-DEN",
            level: "county",
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
            jurisdiction: "US-CO-DEN",
            taxKind: "sales_tax",
            effective: { from: "2029-01-01T00:00:00.000Z" },
            actorRef: "actor-1",
            recordedAt: "2029-01-01T00:00:00.000Z",
            status: "registered",
          },
        ]),
      }),
    );
    const multiQuote = await port.quote(multiReq);
    expect(multiQuote.kind).toBe("final");
    if (multiQuote.kind !== "final") return;

    const badTimestampCommit = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: multiQuote.evidence.calculationRef,
        evidenceDigest: multiQuote.evidenceDigest,
      },
      transactionRef: "tx-bad-ts",
      capturedAt: FIXTURE_LATER_ISO,
      postedAt: FIXTURE_NOW_ISO, // earlier than capturedAt -> schema refuses
      captureEvidenceRef: "cap-bad-ts",
      intent: "apply",
    });
    expect(badTimestampCommit.kind).toBe("refused");

    const multiCommit = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: multiQuote.evidence.calculationRef,
        evidenceDigest: multiQuote.evidenceDigest,
      },
      transactionRef: "tx-multi-1",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-multi-1",
      intent: "apply",
    });
    expect(multiCommit.kind).toBe("committed");
    if (multiCommit.kind !== "committed") return;
    expect(multiCommit.positions).toHaveLength(1);
    expect(multiCommit.positions[0]?.originalPositionRef).toBe("ol-m-line-1");

    // 4. Reverse refuses mode:"full" with partial toMinor < payableMinor (0 /void calls!)
    const partialFullRefused = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: multiCommit.providerTransactionRef,
      reversalRef: "rev-bad-full",
      refundEvidenceRef: "ref-bad-full",
      currency: "USD",
      fromMinor: 0,
      toMinor: 50,
      mode: "full",
      intent: "apply",
      positions: [{ originalPositionRef: "ol-m-line-1", netDeltaMinor: -50, taxDeltaMinor: 0, feeDeltaMinor: 0 }],
    });
    expect(partialFullRefused).toMatchObject({ kind: "refused", code: "tax_reversal_unsubstantiated" });
    expect(voidCalls).toBe(0);

    // 5. Reverse refuses unknown originalPositionRef, positive delta, and missing feeEvidenceRef
    const unknownPos = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: multiCommit.providerTransactionRef,
      reversalRef: "rev-unknown-pos",
      refundEvidenceRef: "ref-unknown-pos",
      currency: "USD",
      fromMinor: 0,
      toMinor: 50,
      mode: "lines",
      intent: "apply",
      positions: [{ originalPositionRef: "ol-m-nonexistent", netDeltaMinor: -50, taxDeltaMinor: 0, feeDeltaMinor: 0 }],
    });
    expect(unknownPos).toMatchObject({ kind: "refused", code: "tax_reversal_unsubstantiated" });

    const positiveDelta = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: multiCommit.providerTransactionRef,
      reversalRef: "rev-pos-delta",
      refundEvidenceRef: "ref-pos-delta",
      currency: "USD",
      fromMinor: 0,
      toMinor: 50,
      mode: "lines",
      intent: "apply",
      positions: [{ originalPositionRef: "ol-m-line-1", netDeltaMinor: -60, taxDeltaMinor: 10, feeDeltaMinor: 0 }],
    });
    expect(positiveDelta.kind).toBe("refused");

    const missingFeeEvidence = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: multiCommit.providerTransactionRef,
      reversalRef: "rev-missing-fee-ev",
      refundEvidenceRef: "ref-missing-fee-ev",
      currency: "USD",
      fromMinor: 0,
      toMinor: 50,
      mode: "lines",
      intent: "apply",
      positions: [{ originalPositionRef: "ol-m-line-1", netDeltaMinor: -40, taxDeltaMinor: 0, feeDeltaMinor: -10 }],
    } satisfies TaxReverseRequestV1);
    expect(missingFeeEvidence.kind).toBe("refused");
  });

  it("supports safe intent:recover readback for commit, ReturnInvoice reversal, and DocVoided full void without duplicate POSTs", async () => {
    const wireLog: { method: string; path: string }[] = [];
    const preExistingDocs = new Map<string, AvalaraTransactionResponse>();

    const expectedCommitCode = buildAvalaraCommitCode(FIXTURE_COMPANY_CODE, FIXTURE_SCOPE, "tx-recover-1");
    const expectedReturnCode = buildAvalaraReversalCode(FIXTURE_COMPANY_CODE, FIXTURE_SCOPE, "rev-recover-ret-1");
    const expectedVoidCommitCode = buildAvalaraCommitCode(FIXTURE_COMPANY_CODE, FIXTURE_SCOPE, "tx-recover-void-1");

    // Pre-populate documents on Avalara side to simulate prior timeout after AvaTax persisted them
    preExistingDocs.set(
      expectedCommitCode,
      buildAvalaraResponse({
        code: expectedCommitCode,
        status: "Committed",
        lines: [
          {
            lineNumber: "ol-m-line-1",
            lineAmount: 1,
            taxableAmount: 1,
            tax: 0,
            details: [],
          },
        ],
      }),
    );
    preExistingDocs.set(
      expectedReturnCode,
      buildAvalaraResponse({
        code: expectedReturnCode,
        status: "Committed",
        lines: [
          {
            lineNumber: "ol-ret-1",
            lineAmount: -0.4,
            taxableAmount: -0.4,
            tax: 0,
            details: [],
          },
        ],
      }),
    );
    preExistingDocs.set(
      expectedVoidCommitCode,
      buildAvalaraResponse({
        code: expectedVoidCommitCode,
        status: "Committed",
        lines: [
          {
            lineNumber: "ol-m-line-1",
            lineAmount: 1,
            taxableAmount: 1,
            tax: 0,
            details: [],
          },
        ],
      }),
    );

    const client = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async (urlString, init) => {
        const u = new URL(urlString);
        const method = init?.method ?? "GET";
        wireLog.push({ method, path: u.pathname });

        if (method === "GET") {
          const code = decodeURIComponent(u.pathname.split("/").pop()!);
          const doc = preExistingDocs.get(code);
          if (!doc) {
            return new Response(JSON.stringify({ error: { code: "EntityNotFoundError" } }), { status: 404 });
          }
          return new Response(JSON.stringify(doc), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        const payload = JSON.parse(init!.body as string) as AvalaraCreateTransactionPayload;
        return new Response(
          JSON.stringify(
            buildAvalaraResponse({
              code: payload.code ?? "SO-REC",
              status: "Temporary",
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
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const port = createAvalaraTaxAdapter({
      client,
      companyCode: FIXTURE_COMPANY_CODE,
      scope: FIXTURE_SCOPE,
      marketPack: buildFixtureMarketPack(),
      clock: () => FIXTURE_NOW_ISO,
    });

    // 1. Recover commit -> GET readback finds existing Committed SalesInvoice, 0 POST create calls
    const q1 = await port.quote(makeTaxQuoteRequest("rec-q1", buildBaseQuoteInput()));
    expect(q1.kind).toBe("final");
    if (q1.kind !== "final") return;

    const postsBeforeCommitRecover = wireLog.filter((e) => e.method === "POST").length;
    const recoveredCommit = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: q1.evidence.calculationRef,
        evidenceDigest: q1.evidenceDigest,
      },
      transactionRef: "tx-recover-1",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-rec-1",
      intent: "recover",
    });
    expect(recoveredCommit).toMatchObject({ kind: "committed", providerTransactionRef: expectedCommitCode });
    expect(wireLog.filter((e) => e.method === "POST").length).toBe(postsBeforeCommitRecover);

    // 2. Recover ReturnInvoice -> GET readback finds existing Committed ReturnInvoice, 0 POST create calls
    const recoveredRet = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: expectedCommitCode,
      reversalRef: "rev-recover-ret-1",
      refundEvidenceRef: "ref-rec-1",
      currency: "USD",
      fromMinor: 0,
      toMinor: 40,
      mode: "lines",
      intent: "recover",
      positions: [{ originalPositionRef: "ol-m-line-1", netDeltaMinor: -40, taxDeltaMinor: 0, feeDeltaMinor: 0 }],
    });
    expect(recoveredRet).toMatchObject({ kind: "reversed", providerReversalRef: expectedReturnCode });
    expect(wireLog.filter((e) => e.method === "POST").length).toBe(postsBeforeCommitRecover);

    // 3. Recover DocVoided -> GET readback sees Cancelled status, 0 /void POST calls
    const q2 = await port.quote(makeTaxQuoteRequest("rec-q2", buildBaseQuoteInput()));
    expect(q2.kind).toBe("final");
    if (q2.kind !== "final") return;
    const c2 = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: q2.evidence.calculationRef,
        evidenceDigest: q2.evidenceDigest,
      },
      transactionRef: "tx-recover-void-1",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-rec-2",
      intent: "recover",
    });
    expect(c2.kind).toBe("committed");

    // Mark document as already Cancelled on Avalara side before recover reverse
    preExistingDocs.set(expectedVoidCommitCode, {
      ...preExistingDocs.get(expectedVoidCommitCode)!,
      status: "Cancelled",
    });
    const postsBeforeVoidRecover = wireLog.filter((e) => e.method === "POST").length;
    const recoveredVoid = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: expectedVoidCommitCode,
      reversalRef: "rev-recover-void-1",
      refundEvidenceRef: "ref-rec-void-1",
      currency: "USD",
      fromMinor: 0,
      toMinor: 100,
      mode: "full",
      intent: "recover",
      positions: [{ originalPositionRef: "ol-m-line-1", netDeltaMinor: -100, taxDeltaMinor: 0, feeDeltaMinor: 0 }],
    });
    expect(recoveredVoid).toMatchObject({ kind: "reversed", providerReversalRef: `void:${expectedVoidCommitCode}` });
    expect(wireLog.filter((e) => e.method === "POST").length).toBe(postsBeforeVoidRecover);
  });

  it("classifies mutating AvaTax conflict/timeout statuses (TransactionAlreadyExists, TransactionAlreadyCancelled, 408, 409) as effect:unknown and rejects mismatched SalesInvoice totalAmount", async () => {
    // 1. Mutating client conflict & timeout statuses MUST report effect:"unknown"
    const conflictCases: readonly {
      readonly status: number;
      readonly errorCode?: string;
      readonly retryable: boolean;
    }[] = [
      { status: 400, errorCode: "TransactionAlreadyExists", retryable: false },
      { status: 400, errorCode: "TransactionAlreadyCancelled", retryable: false },
      { status: 400, errorCode: "EntityAlreadyExists", retryable: false },
      { status: 400, errorCode: "TransactionLocked", retryable: false },
      { status: 409, errorCode: "Conflict", retryable: false },
      { status: 408, retryable: true },
    ];
    for (const tc of conflictCases) {
      const conflictClient = createAvalaraHttpClient({
        environment: "sandbox",
        credentials: buildFixtureCredentials,
        fetchImpl: async () =>
          new Response(
            tc.errorCode ? JSON.stringify({ error: { code: tc.errorCode } }) : "timeout",
            { status: tc.status, headers: { "content-type": "application/json" } },
          ),
      });
      await expect(
        conflictClient.voidTransaction(FIXTURE_COMPANY_CODE, "ol-tx-conflict", { code: "DocVoided" }),
      ).rejects.toMatchObject({
        effect: "unknown",
        retryable: tc.retryable,
      });
    }

    // 2. Commit & intent:"recover" readback MUST reject a SalesInvoice with mismatched totalAmount even when totalTax matches (0)
    const mismatchedCode = buildAvalaraCommitCode(FIXTURE_COMPANY_CODE, FIXTURE_SCOPE, "tx-net-mismatch");
    const mismatchClient = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async (urlString, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return new Response(
            JSON.stringify(
              buildAvalaraResponse({
                code: mismatchedCode,
                status: "Committed",
                lines: [{ lineNumber: "ol-m-line-1", lineAmount: 9.99, taxableAmount: 9.99, tax: 0, details: [] }],
              }),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const payload = JSON.parse(init!.body as string) as AvalaraCreateTransactionPayload;
        if (payload.type === "SalesInvoice") {
          return new Response(
            JSON.stringify(
              buildAvalaraResponse({
                code: payload.code!,
                status: "Committed",
                lines: [{ lineNumber: "ol-m-line-1", lineAmount: 9.99, taxableAmount: 9.99, tax: 0, details: [] }],
              }),
            ),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        expect(new URL(urlString).pathname).toBe("/api/v2/transactions/create");
        return new Response(
          JSON.stringify(
            buildAvalaraResponse({
              code: "SO-NET-CHECK",
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
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const mismatchPort = createAvalaraTaxAdapter({
      client: mismatchClient,
      companyCode: FIXTURE_COMPANY_CODE,
      scope: FIXTURE_SCOPE,
      marketPack: buildFixtureMarketPack(),
      clock: () => FIXTURE_NOW_ISO,
    });
    const quote = await mismatchPort.quote(makeTaxQuoteRequest("req-net-mismatch", buildBaseQuoteInput()));
    expect(quote.kind).toBe("final");
    if (quote.kind !== "final") return;

    const applyMismatch = await mismatchPort.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: quote.evidence.calculationRef,
        evidenceDigest: quote.evidenceDigest,
      },
      transactionRef: "tx-net-mismatch",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-net-mismatch",
      intent: "apply",
    });
    expect(applyMismatch).toEqual({
      kind: "unavailable",
      code: "tax_adapter_unavailable",
      effect: "unknown",
    });

    const recoverMismatch = await mismatchPort.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: quote.evidence.calculationRef,
        evidenceDigest: quote.evidenceDigest,
      },
      transactionRef: "tx-net-mismatch",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-net-mismatch",
      intent: "recover",
    });
    expect(recoverMismatch).toEqual({
      kind: "unavailable",
      code: "tax_adapter_unavailable",
      effect: "unknown",
    });
  });
});
