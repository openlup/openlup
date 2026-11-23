import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TELEMETRY_CONTRACT_VERSION,
  type TelemetryEvent,
  type TelemetryPort,
} from "@openlup/platform/observability";
import {
  createScriptedTelemetryFake,
  runTelemetryAdapterConformance,
  ScriptedTelemetryTransportError,
  type ScriptedTelemetryOutcome,
  type TelemetryAdapterTestSubject,
  type TelemetryScenarioHarness,
} from "@openlup/platform/observability/testing";
import {
  AXIOM_ORIGIN,
  AXIOM_STATIC_CAPABILITIES,
  AxiomClientError,
  assertValidAxiomApiToken,
  assertValidAxiomDataset,
  createAxiomHttpClient,
  createAxiomTelemetryAdapter,
  projectAxiomStaticCapabilities,
  type AxiomEventRecord,
  type AxiomIngestResponse,
  type FetchLike,
} from "../server/index.js";
import {
  FIXTURE_API_TOKEN,
  FIXTURE_CANARY_TOKEN,
  FIXTURE_DATASET,
  FIXTURE_NOW_ISO,
  FIXTURE_PII_EMAIL,
  FIXTURE_SAMPLE_EVENTS,
  FIXTURE_SERVICE,
} from "./fixtures.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const RECIPE_ROOT = resolve(THIS_DIR, "..");
const RECIPES_ROOT = resolve(RECIPE_ROOT, "..", "..");

function collectRelativeFiles(dir: string, root: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRelativeFiles(full, root));
    } else if (entry.isFile()) {
      out.push(relative(root, full).replace(/\\/gu, "/"));
    }
  }
  return out.sort();
}

type AxiomFakeCalls = { ingest: AxiomIngestResponse };

function makeAxiomHarness(
  outcome: ScriptedTelemetryOutcome<AxiomIngestResponse>,
  options: { readonly enabled?: boolean } = {},
): TelemetryScenarioHarness {
  const enabled = options.enabled ?? true;
  const fake = createScriptedTelemetryFake<AxiomFakeCalls>();
  if (enabled) fake.enqueue("ingest", outcome);

  const sentPayloads: AxiomEventRecord[][] = [];
  const observedHeaders: Record<string, string>[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe(AXIOM_ORIGIN);
    expect(url.pathname).toBe(`/v1/datasets/${encodeURIComponent(FIXTURE_DATASET)}/ingest`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");

    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    expect(headers["authorization"]).toBe(`Bearer ${FIXTURE_API_TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    observedHeaders.push(headers);

    const parsedBody = JSON.parse(String(init?.body ?? "[]")) as AxiomEventRecord[];
    sentPayloads.push(parsedBody);

    try {
      const responseBody = await fake.invoke("ingest");
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      if (err instanceof ScriptedTelemetryTransportError) {
        if (err.kind === "http-failure") {
          return new Response(JSON.stringify({ message: "error" }), {
            status: err.status ?? 500,
            headers: { "content-type": "application/json" },
          });
        }
        if (err.kind === "rate-limited-429") {
          return new Response(JSON.stringify({ message: "rate_limited" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              ...(err.retryAfterSeconds !== undefined
                ? { "retry-after": String(err.retryAfterSeconds) }
                : {}),
            },
          });
        }
      }
      throw err;
    }
  };

  const client = createAxiomHttpClient({
    dataset: FIXTURE_DATASET,
    apiToken: FIXTURE_API_TOKEN,
    fetchImpl,
  });

  const adapter = createAxiomTelemetryAdapter({
    client,
    service: FIXTURE_SERVICE,
    enabled,
  });

  return {
    adapter,
    sampleEvents: FIXTURE_SAMPLE_EVENTS,
    readIoCount: () => fake.calls.length,
    readSentPayloads: () => sentPayloads,
    readFaultLog: () => fake.calls,
  };
}

describe("recipes/observability/axiom — Stages 1 & 2 conformance", () => {
  it("Stage 1: cold-import and client/adapter construction perform zero I/O and reject invalid config", () => {
    let fetchCalls = 0;
    const spyFetch: FetchLike = async () => {
      fetchCalls += 1;
      throw new Error("Unexpected network call");
    };

    const client = createAxiomHttpClient({
      dataset: FIXTURE_DATASET,
      apiToken: FIXTURE_API_TOKEN,
      fetchImpl: spyFetch,
    });
    const port = createAxiomTelemetryAdapter({ client, service: FIXTURE_SERVICE });

    expect(fetchCalls).toBe(0);
    expect(port.capabilities.contractVersion).toBe(TELEMETRY_CONTRACT_VERSION);
    expect(port.capabilities.providerKind).toBe("axiom");

    expect(() => assertValidAxiomDataset("")).toThrow(AxiomClientError);
    expect(() => assertValidAxiomDataset("..")).toThrow(AxiomClientError);
    expect(() => assertValidAxiomDataset("bad/dataset")).toThrow(AxiomClientError);
    expect(() => assertValidAxiomDataset("bad dataset")).toThrow(AxiomClientError);
    expect(() => assertValidAxiomApiToken("")).toThrow(AxiomClientError);
    expect(() => assertValidAxiomApiToken("   ")).toThrow(AxiomClientError);
    expect(() => assertValidAxiomApiToken("bad\ntoken")).toThrow(AxiomClientError);
    expect(fetchCalls).toBe(0);
  });

  it("Stage 2: passes full runTelemetryAdapterConformance with canary redaction and fail-open faults", async () => {
    const subject: TelemetryAdapterTestSubject = {
      id: "axiom-ingest-v1",
      sensitiveValues: [FIXTURE_API_TOKEN, FIXTURE_CANARY_TOKEN, FIXTURE_PII_EMAIL],
      happyFlush: () =>
        makeAxiomHarness({
          kind: "success",
          value: { ingested: FIXTURE_SAMPLE_EVENTS.length, failed: 0 },
        }),
      disabledPort: () =>
        makeAxiomHarness(
          { kind: "success", value: { ingested: 0, failed: 0 } },
          { enabled: false },
        ),
      certification: {
        http5xx: () => makeAxiomHarness({ kind: "http-failure", status: 503 }),
        httpAuthFailure: () => makeAxiomHarness({ kind: "http-failure", status: 401 }),
        rateLimited429: () =>
          makeAxiomHarness({ kind: "rate-limited-429", retryAfterSeconds: 15 }),
        timeout: () => makeAxiomHarness({ kind: "timeout" }),
        transportError: () => makeAxiomHarness({ kind: "transport-error" }),
      },
    };

    const evidence = await runTelemetryAdapterConformance([subject], { mode: "full" });
    expect(evidence.contractVersion).toBe(TELEMETRY_CONTRACT_VERSION);
    expect(evidence.mode).toBe("full");
    expect(evidence.qualifications).toHaveLength(1);
    const qual = evidence.qualifications[0]!;
    expect(qual.providerKind).toBe("axiom");
    expect(qual.ledger.some((e) => e.role === "redaction" && e.ioDelta === 1)).toBe(true);
    expect(qual.ledger.filter((e) => e.role === "transport-fault")).toHaveLength(5);
  });

  it("HTTP client pins origin, enforces redirect: 'error', shapes Axiom events, and never leaks tokens in errors", async () => {
    const capturedBodies: AxiomEventRecord[][] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      expect(url.href).toBe(`${AXIOM_ORIGIN}/v1/datasets/${FIXTURE_DATASET}/ingest`);
      expect(init?.redirect).toBe("error");
      capturedBodies.push(JSON.parse(String(init?.body)) as AxiomEventRecord[]);
      return new Response(JSON.stringify({ ingested: 1, failed: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createAxiomHttpClient({
      dataset: FIXTURE_DATASET,
      apiToken: FIXTURE_API_TOKEN,
      fetchImpl,
    });
    const port = createAxiomTelemetryAdapter({ client, service: FIXTURE_SERVICE });

    port.record({
      kind: "log",
      severity: "warn",
      message: `Attempt with Bearer ${FIXTURE_CANARY_TOKEN} by ${FIXTURE_PII_EMAIL}`,
      timestamp: FIXTURE_NOW_ISO,
      attributes: {
        api_key: FIXTURE_API_TOKEN,
        customer_email: FIXTURE_PII_EMAIL,
        tenant: "storefront-a",
      },
    });
    const res = await port.flush();
    expect(res).toEqual({ kind: "flushed", accepted: 1, dropped: 0 });
    expect(capturedBodies).toHaveLength(1);
    const record = capturedBodies[0]![0]!;
    expect(record._time).toBe(FIXTURE_NOW_ISO);
    expect(record.kind).toBe("log");
    expect(record.service).toBe(FIXTURE_SERVICE);
    expect(record.attributes?.["api_key"]).toBe("[redacted]");
    expect(record.attributes?.["customer_email"]).toBe("[redacted]");
    expect(record.attributes?.["tenant"]).toBe("storefront-a");
    expect(JSON.stringify(record)).not.toContain(FIXTURE_API_TOKEN);
    expect(JSON.stringify(record)).not.toContain(FIXTURE_CANARY_TOKEN);
    expect(JSON.stringify(record)).not.toContain(FIXTURE_PII_EMAIL);

    // Verify 403 / 500 error messages never reflect the apiToken.
    const authFailClient = createAxiomHttpClient({
      dataset: FIXTURE_DATASET,
      apiToken: FIXTURE_API_TOKEN,
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    });
    await expect(authFailClient.ingest([record])).rejects.toMatchObject({
      name: "AxiomClientError",
      kind: "auth_failed",
      diagnosticCode: "AXIOM_AUTH_FAILED",
      retryable: false,
      status: 403,
    });
    try {
      await authFailClient.ingest([record]);
    } catch (err) {
      expect(String(err)).not.toContain(FIXTURE_API_TOKEN);
    }
  });

  it("recipe.json matches schema constraints, staticCapabilities, and sorted disk allFiles", () => {
    const manifestRaw = readFileSync(resolve(RECIPE_ROOT, "recipe.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      schemaVersion: number;
      id: string;
      domain: string;
      providerKind: string;
      status: string;
      openlupPlatformRange: string;
      testedAgainstPlatformVersion: string;
      contractImports: string[];
      conformanceRunner: { importPath: string; exportName: string; mode?: string };
      sdkPolicy: string;
      egressOrigins: string[];
      webhookAuth: string;
      browserSurface: { kind: string };
      supportedCurrenciesPolicy: string;
      staticCapabilities: unknown;
      liveQualification: { status: string; checklist: string };
      files: { allFiles: string[] };
    };
    const schema = JSON.parse(
      readFileSync(resolve(RECIPES_ROOT, "schema", "recipe.schema.json"), "utf8"),
    ) as { properties: { domain: { enum: string[] }; sdkPolicy: { enum: string[] } } };

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.id).toBe("observability/axiom");
    expect(schema.properties.domain.enum).toContain(manifest.domain);
    expect(manifest.providerKind).toBe("axiom");
    expect(manifest.status).toBe("exemplar");
    expect(manifest.openlupPlatformRange).toBe("^1.4.0");
    expect(manifest.testedAgainstPlatformVersion).toBe("1.4.0-dev");
    expect(manifest.egressOrigins).toEqual([AXIOM_ORIGIN]);
    expect(manifest.sdkPolicy).toBe("zero-dep-fetch");
    expect(manifest.webhookAuth).toBe("none");
    expect(manifest.browserSurface).toEqual({ kind: "none" });
    expect(manifest.supportedCurrenciesPolicy).toBe("not-applicable");
    expect(manifest.liveQualification).toEqual({
      status: "offline-protocol-only",
      checklist: "LIVE_QUALIFICATION.md",
    });
    expect(manifest.staticCapabilities).toEqual(
      projectAxiomStaticCapabilities(AXIOM_STATIC_CAPABILITIES),
    );

    const diskFiles = collectRelativeFiles(RECIPE_ROOT, RECIPE_ROOT);
    expect(manifest.files.allFiles).toEqual(diskFiles);
    expect([...manifest.files.allFiles].sort()).toEqual(manifest.files.allFiles);
  });

  it("Negative control 1 (secret_leak): unredacted sink fails conformance", async () => {
    const queue: TelemetryEvent[] = [];
    const sent: unknown[] = [];
    const leakyPort: TelemetryPort = {
      capabilities: AXIOM_STATIC_CAPABILITIES,
      record(ev) {
        queue.push(ev);
      },
      async flush() {
        if (queue.length === 0) return { kind: "noop", accepted: 0, dropped: 0 };
        const batch = queue.splice(0, queue.length);
        sent.push(batch);
        return { kind: "flushed", accepted: batch.length, dropped: 0 };
      },
    };
    await expect(
      runTelemetryAdapterConformance([
        {
          id: "planted-secret-leak",
          happyFlush: () => ({
            adapter: leakyPort,
            sampleEvents: FIXTURE_SAMPLE_EVENTS,
            readIoCount: () => sent.length,
            readSentPayloads: () => sent,
          }),
          disabledPort: () =>
            makeAxiomHarness(
              { kind: "success", value: { ingested: 0, failed: 0 } },
              { enabled: false },
            ),
        },
      ]),
    ).rejects.toThrow(/TELEMETRY_CONFORMANCE:secret_leak/u);
  });

  it("Negative control 2 (disabled_port_io): disabled sink performing I/O fails conformance", async () => {
    await expect(
      runTelemetryAdapterConformance([
        {
          id: "planted-disabled-port-io",
          happyFlush: () =>
            makeAxiomHarness({
              kind: "success",
              value: { ingested: FIXTURE_SAMPLE_EVENTS.length, failed: 0 },
            }),
          // Planted defect: enabled remains true in disabledPort
          disabledPort: () =>
            makeAxiomHarness(
              { kind: "success", value: { ingested: FIXTURE_SAMPLE_EVENTS.length, failed: 0 } },
              { enabled: true },
            ),
        },
      ]),
    ).rejects.toThrow(/TELEMETRY_CONFORMANCE:disabled_port_io/u);
  });

  it("Negative control 3 (fault_result_mismatch): misclassified 401 as retryable fails full certification", async () => {
    await expect(
      runTelemetryAdapterConformance(
        [
          {
            id: "planted-auth-retryable",
            happyFlush: () =>
              makeAxiomHarness({
                kind: "success",
                value: { ingested: FIXTURE_SAMPLE_EVENTS.length, failed: 0 },
              }),
            disabledPort: () =>
              makeAxiomHarness(
                { kind: "success", value: { ingested: 0, failed: 0 } },
                { enabled: false },
              ),
            certification: {
              http5xx: () => makeAxiomHarness({ kind: "http-failure", status: 503 }),
              // Planted defect: returns 503-style retryable failure instead of 401 auth failure
              httpAuthFailure: () => {
                const fake = createScriptedTelemetryFake<AxiomFakeCalls>();
                fake.enqueue("ingest", { kind: "http-failure", status: 401 });
                const port: TelemetryPort = {
                  capabilities: AXIOM_STATIC_CAPABILITIES,
                  record() {},
                  async flush() {
                    try {
                      await fake.invoke("ingest");
                    } catch {
                      // Wrongly marks auth failure as retryable: true
                    }
                    return {
                      kind: "failed",
                      accepted: 0,
                      dropped: FIXTURE_SAMPLE_EVENTS.length,
                      retryable: true,
                      diagnosticCode: "AXIOM_WRONG_RETRYABLE",
                    };
                  },
                };
                return {
                  adapter: port,
                  sampleEvents: FIXTURE_SAMPLE_EVENTS,
                  readIoCount: () => fake.calls.length,
                  readSentPayloads: () => [],
                  readFaultLog: () => fake.calls,
                };
              },
              rateLimited429: () => makeAxiomHarness({ kind: "rate-limited-429" }),
              timeout: () => makeAxiomHarness({ kind: "timeout" }),
              transportError: () => makeAxiomHarness({ kind: "transport-error" }),
            },
          },
        ],
        { mode: "full" },
      ),
    ).rejects.toThrow(/TELEMETRY_CONFORMANCE:fault_result_mismatch/u);
  });
});
