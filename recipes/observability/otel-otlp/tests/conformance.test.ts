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
  OTEL_OTLP_STATIC_CAPABILITIES,
  OtelOtlpClientError,
  assertValidCollectorOrigin,
  createOtelOtlpHttpClient,
  createOtelOtlpTelemetryAdapter,
  projectOtelOtlpStaticCapabilities,
  type FetchLike,
  type OtlpExportLogsServiceRequest,
  type OtlpExportMetricsServiceRequest,
  type OtlpExportTraceServiceRequest,
} from "../server/index.js";
import {
  FIXTURE_AUTH_HEADER,
  FIXTURE_AUTH_SECRET,
  FIXTURE_CANARY_TOKEN,
  FIXTURE_COLLECTOR_ORIGIN,
  FIXTURE_CONFORMANCE_SPAN_EVENTS,
  FIXTURE_CUSTOM_HEADER_KEY,
  FIXTURE_CUSTOM_HEADER_VAL,
  FIXTURE_MULTI_SIGNAL_EVENTS,
  FIXTURE_NOW_ISO,
  FIXTURE_PII_EMAIL,
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

type OtlpFakeCalls = { exportSignal: Record<string, unknown> };

function makeOtlpHarness(
  outcome: ScriptedTelemetryOutcome<Record<string, unknown>>,
  options: { readonly enabled?: boolean } = {},
): TelemetryScenarioHarness {
  const enabled = options.enabled ?? true;
  const fake = createScriptedTelemetryFake<OtlpFakeCalls>();
  if (enabled) fake.enqueue("exportSignal", outcome);

  const sentPayloads: unknown[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe(FIXTURE_COLLECTOR_ORIGIN);
    expect(["/v1/traces", "/v1/metrics", "/v1/logs"]).toContain(url.pathname);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");

    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    expect(headers["authorization"]).toBe(FIXTURE_AUTH_HEADER);
    expect(headers[FIXTURE_CUSTOM_HEADER_KEY]).toBe(FIXTURE_CUSTOM_HEADER_VAL);
    expect(headers["content-type"]).toBe("application/json");

    sentPayloads.push(JSON.parse(String(init?.body ?? "{}")));

    try {
      const responseBody = await fake.invoke("exportSignal");
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

  const client = createOtelOtlpHttpClient({
    collectorOrigin: FIXTURE_COLLECTOR_ORIGIN,
    authorization: FIXTURE_AUTH_HEADER,
    headers: { [FIXTURE_CUSTOM_HEADER_KEY]: FIXTURE_CUSTOM_HEADER_VAL },
    fetchImpl,
  });

  const adapter = createOtelOtlpTelemetryAdapter({
    client,
    service: FIXTURE_SERVICE,
    enabled,
  });

  return {
    adapter,
    sampleEvents: FIXTURE_CONFORMANCE_SPAN_EVENTS,
    readIoCount: () => fake.calls.length,
    readSentPayloads: () => sentPayloads,
    readFaultLog: () => fake.calls,
  };
}

describe("recipes/observability/otel-otlp — Stages 1 & 2 conformance", () => {
  it("Stage 1: cold-import performs zero I/O and validates strict HTTPS collector origin at construction time", () => {
    let fetchCalls = 0;
    const spyFetch: FetchLike = async () => {
      fetchCalls += 1;
      throw new Error("Unexpected network call");
    };

    const client = createOtelOtlpHttpClient({
      collectorOrigin: FIXTURE_COLLECTOR_ORIGIN,
      fetchImpl: spyFetch,
    });
    const port = createOtelOtlpTelemetryAdapter({ client, service: FIXTURE_SERVICE });

    expect(fetchCalls).toBe(0);
    expect(port.capabilities.contractVersion).toBe(TELEMETRY_CONTRACT_VERSION);
    expect(port.capabilities.providerKind).toBe("otel_otlp");

    expect(() => assertValidCollectorOrigin("http://otel-collector.example.invalid")).toThrow(
      OtelOtlpClientError,
    );
    expect(() => assertValidCollectorOrigin("https://otel-collector.example.invalid/v1/traces")).toThrow(
      OtelOtlpClientError,
    );
    expect(() => assertValidCollectorOrigin("https://otel-collector.example.invalid/?a=1")).toThrow(
      OtelOtlpClientError,
    );
    expect(() => assertValidCollectorOrigin("https://otel-collector.example.invalid/#frag")).toThrow(
      OtelOtlpClientError,
    );
    expect(() => assertValidCollectorOrigin("https://user:pass@otel-collector.example.invalid")).toThrow(
      OtelOtlpClientError,
    );
    expect(() => assertValidCollectorOrigin("not-a-url")).toThrow(OtelOtlpClientError);
    expect(assertValidCollectorOrigin("https://otel-collector.example.invalid:4318")).toBe(
      "https://otel-collector.example.invalid:4318",
    );
    expect(fetchCalls).toBe(0);
  });

  it("Stage 2: passes full runTelemetryAdapterConformance with canary redaction and fail-open faults", async () => {
    const subject: TelemetryAdapterTestSubject = {
      id: "otel-otlp-http-json",
      sensitiveValues: [
        FIXTURE_AUTH_SECRET,
        FIXTURE_CUSTOM_HEADER_VAL,
        FIXTURE_CANARY_TOKEN,
        FIXTURE_PII_EMAIL,
      ],
      happyFlush: () => makeOtlpHarness({ kind: "success", value: {} }),
      disabledPort: () => makeOtlpHarness({ kind: "success", value: {} }, { enabled: false }),
      certification: {
        http5xx: () => makeOtlpHarness({ kind: "http-failure", status: 503 }),
        httpAuthFailure: () => makeOtlpHarness({ kind: "http-failure", status: 401 }),
        rateLimited429: () =>
          makeOtlpHarness({ kind: "rate-limited-429", retryAfterSeconds: 10 }),
        timeout: () => makeOtlpHarness({ kind: "timeout" }),
        transportError: () => makeOtlpHarness({ kind: "transport-error" }),
      },
    };

    const evidence = await runTelemetryAdapterConformance([subject], { mode: "full" });
    expect(evidence.contractVersion).toBe(TELEMETRY_CONTRACT_VERSION);
    expect(evidence.mode).toBe("full");
    expect(evidence.qualifications).toHaveLength(1);
    const qual = evidence.qualifications[0]!;
    expect(qual.providerKind).toBe("otel_otlp");
    expect(qual.ledger.some((e) => e.role === "redaction" && e.ioDelta === 1)).toBe(true);
    expect(qual.ledger.filter((e) => e.role === "transport-fault")).toHaveLength(5);
  });

  it("routes spans, metrics, and logs/errors to /v1/traces, /v1/metrics, and /v1/logs with OTLP JSON envelopes and redacted errors", async () => {
    const dispatched = new Map<string, unknown>();
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(FIXTURE_COLLECTOR_ORIGIN);
      expect(init?.redirect).toBe("error");
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      expect(headers["authorization"]).toBe(FIXTURE_AUTH_HEADER);
      expect(headers["content-type"]).toBe("application/json");
      dispatched.set(url.pathname, JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createOtelOtlpHttpClient({
      collectorOrigin: FIXTURE_COLLECTOR_ORIGIN,
      authorization: FIXTURE_AUTH_HEADER,
      fetchImpl,
    });
    const port = createOtelOtlpTelemetryAdapter({ client, service: FIXTURE_SERVICE });

    for (const ev of FIXTURE_MULTI_SIGNAL_EVENTS) {
      port.record(ev);
    }
    port.record({
      kind: "log",
      severity: "warn",
      message: `Canary ${FIXTURE_PII_EMAIL} with Bearer ${FIXTURE_CANARY_TOKEN}`,
      timestamp: FIXTURE_NOW_ISO,
      attributes: {
        authorization: FIXTURE_AUTH_HEADER,
        customer_email: FIXTURE_PII_EMAIL,
      },
    });

    const res = await port.flush();
    expect(res).toEqual({
      kind: "flushed",
      accepted: FIXTURE_MULTI_SIGNAL_EVENTS.length + 1,
      dropped: 0,
    });

    const traces = dispatched.get("/v1/traces") as OtlpExportTraceServiceRequest;
    const metrics = dispatched.get("/v1/metrics") as OtlpExportMetricsServiceRequest;
    const logs = dispatched.get("/v1/logs") as OtlpExportLogsServiceRequest;

    expect(traces.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);
    expect(metrics.resourceMetrics[0]!.scopeMetrics[0]!.metrics).toHaveLength(2);
    expect(logs.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(3);

    const logsSerialized = JSON.stringify(logs);
    expect(logsSerialized).not.toContain(FIXTURE_PII_EMAIL);
    expect(logsSerialized).not.toContain(FIXTURE_CANARY_TOKEN);
    expect(logsSerialized).not.toContain(FIXTURE_AUTH_SECRET);

    // Verify 403 error never leaks authorization header into error strings.
    const authFailClient = createOtelOtlpHttpClient({
      collectorOrigin: FIXTURE_COLLECTOR_ORIGIN,
      authorization: FIXTURE_AUTH_HEADER,
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    });
    try {
      await authFailClient.exportTraces(traces);
      expect.unreachable("expected 403 to throw");
    } catch (err) {
      expect(err).toMatchObject({
        name: "OtelOtlpClientError",
        kind: "auth_failed",
        diagnosticCode: "OTEL_OTLP_AUTH_FAILED",
        retryable: false,
        status: 403,
      });
      expect(String(err)).not.toContain(FIXTURE_AUTH_SECRET);
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
    expect(manifest.id).toBe("observability/otel-otlp");
    expect(schema.properties.domain.enum).toContain(manifest.domain);
    expect(manifest.providerKind).toBe("otel_otlp");
    expect(manifest.status).toBe("verified");
    expect(manifest.openlupPlatformRange).toBe("^1.4.0");
    expect(manifest.testedAgainstPlatformVersion).toBe("1.4.0-dev");
    expect(manifest.egressOrigins).toEqual(["https://{collectorHost}"]);
    expect(manifest.sdkPolicy).toBe("zero-dep-fetch");
    expect(manifest.webhookAuth).toBe("none");
    expect(manifest.browserSurface).toEqual({ kind: "none" });
    expect(manifest.supportedCurrenciesPolicy).toBe("not-applicable");
    expect(manifest.liveQualification).toEqual({
      status: "offline-protocol-only",
      checklist: "LIVE_QUALIFICATION.md",
    });
    expect(manifest.staticCapabilities).toEqual(
      projectOtelOtlpStaticCapabilities(OTEL_OTLP_STATIC_CAPABILITIES),
    );

    const diskFiles = collectRelativeFiles(RECIPE_ROOT, RECIPE_ROOT);
    expect(manifest.files.allFiles).toEqual(diskFiles);
    expect([...manifest.files.allFiles].sort()).toEqual(manifest.files.allFiles);
  });

  it("Negative control 1 (secret_leak): unredacted sink fails conformance", async () => {
    const queue: TelemetryEvent[] = [];
    const sent: unknown[] = [];
    const leakyPort: TelemetryPort = {
      capabilities: OTEL_OTLP_STATIC_CAPABILITIES,
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
            sampleEvents: FIXTURE_CONFORMANCE_SPAN_EVENTS,
            readIoCount: () => sent.length,
            readSentPayloads: () => sent,
          }),
          disabledPort: () => makeOtlpHarness({ kind: "success", value: {} }, { enabled: false }),
        },
      ]),
    ).rejects.toThrow(/TELEMETRY_CONFORMANCE:secret_leak/u);
  });

  it("Negative control 2 (disabled_port_io): disabled sink performing I/O fails conformance", async () => {
    await expect(
      runTelemetryAdapterConformance([
        {
          id: "planted-disabled-port-io",
          happyFlush: () => makeOtlpHarness({ kind: "success", value: {} }),
          // Planted defect: enabled remains true in disabledPort
          disabledPort: () => makeOtlpHarness({ kind: "success", value: {} }, { enabled: true }),
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
            happyFlush: () => makeOtlpHarness({ kind: "success", value: {} }),
            disabledPort: () => makeOtlpHarness({ kind: "success", value: {} }, { enabled: false }),
            certification: {
              http5xx: () => makeOtlpHarness({ kind: "http-failure", status: 503 }),
              httpAuthFailure: () => {
                const fake = createScriptedTelemetryFake<OtlpFakeCalls>();
                fake.enqueue("exportSignal", { kind: "http-failure", status: 401 });
                const port: TelemetryPort = {
                  capabilities: OTEL_OTLP_STATIC_CAPABILITIES,
                  record() {},
                  async flush() {
                    try {
                      await fake.invoke("exportSignal");
                    } catch {
                      // Wrongly marks auth failure as retryable: true
                    }
                    return {
                      kind: "failed",
                      accepted: 0,
                      dropped: FIXTURE_CONFORMANCE_SPAN_EVENTS.length,
                      retryable: true,
                      diagnosticCode: "OTEL_OTLP_WRONG_RETRYABLE",
                    };
                  },
                };
                return {
                  adapter: port,
                  sampleEvents: FIXTURE_CONFORMANCE_SPAN_EVENTS,
                  readIoCount: () => fake.calls.length,
                  readSentPayloads: () => [],
                  readFaultLog: () => fake.calls,
                };
              },
              rateLimited429: () => makeOtlpHarness({ kind: "rate-limited-429" }),
              timeout: () => makeOtlpHarness({ kind: "timeout" }),
              transportError: () => makeOtlpHarness({ kind: "transport-error" }),
            },
          },
        ],
        { mode: "full" },
      ),
    ).rejects.toThrow(/TELEMETRY_CONFORMANCE:fault_result_mismatch/u);
  });
});
