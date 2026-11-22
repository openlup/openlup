import { describe, expect, it } from "vitest";
import {
  createNoopTelemetryPort,
  createSafeTelemetryPort,
  TELEMETRY_CONTRACT_VERSION,
  type TelemetryCapabilities,
  type TelemetryEvent,
} from "../../src/observability/index.js";
import {
  createScriptedTelemetryFake,
  runTelemetryAdapterConformance,
  ScriptedTelemetryTransportError,
  type ScriptedTelemetryOutcome,
  type TelemetryScenarioHarness,
} from "../../src/observability/testing/index.js";

type SinkCalls = { ingest: number };

const CAPS: TelemetryCapabilities = {
  contractVersion: TELEMETRY_CONTRACT_VERSION,
  providerKind: "synthetic_sink",
  supportsSpans: true,
  supportsMetrics: true,
  supportsLogs: true,
  supportsErrors: true,
  maxBatchSize: 50,
  requiresCredentials: true,
};

const SAMPLE_EVENTS: readonly TelemetryEvent[] = [
  { kind: "span", name: "checkout.quote", startedAt: "2000-01-01T00:00:00.000Z", durationMs: 12, status: "ok" },
  { kind: "metric", metricKind: "counter", name: "orders.created", value: 1, timestamp: "2000-01-01T00:00:00.000Z" },
];

function makeHarness(
  outcome: ScriptedTelemetryOutcome<number>,
  enabled = true,
): TelemetryScenarioHarness {
  const fake = createScriptedTelemetryFake<SinkCalls>();
  if (enabled) fake.enqueue("ingest", outcome);
  const payloads: unknown[] = [];

  const adapter = createSafeTelemetryPort({
    capabilities: CAPS,
    enabled,
    async exportBatch(events) {
      payloads.push(events);
      try {
        const accepted = await fake.invoke("ingest");
        return { kind: "flushed", accepted, dropped: 0 };
      } catch (err) {
        if (err instanceof ScriptedTelemetryTransportError) {
          const retryable = !(err.kind === "http-failure" && (err.status === 401 || err.status === 403));
          return {
            kind: "failed",
            accepted: 0,
            dropped: events.length,
            retryable,
            diagnosticCode: retryable ? "TELEMETRY_RETRYABLE_FAULT" : "TELEMETRY_AUTH_FAILED",
          };
        }
        return { kind: "failed", accepted: 0, dropped: events.length, retryable: true, diagnosticCode: "TELEMETRY_ERROR" };
      }
    },
  });

  return {
    adapter,
    sampleEvents: SAMPLE_EVENTS,
    readIoCount: () => fake.calls.length,
    readSentPayloads: () => payloads,
    readFaultLog: () => fake.calls,
  };
}

describe("@openlup/platform/observability and /testing", () => {
  it("certifies a fail-open redacted telemetry adapter in full mode", async () => {
    const evidence = await runTelemetryAdapterConformance(
      [
        {
          id: "synthetic-sink",
          happyFlush: () => makeHarness({ kind: "success", value: 2 }),
          disabledPort: () => makeHarness({ kind: "success", value: 0 }, false),
          certification: {
            http5xx: () => makeHarness({ kind: "http-failure", status: 503 }),
            httpAuthFailure: () => makeHarness({ kind: "http-failure", status: 401 }),
            rateLimited429: () => makeHarness({ kind: "rate-limited-429", retryAfterSeconds: 10 }),
            timeout: () => makeHarness({ kind: "timeout" }),
            transportError: () => makeHarness({ kind: "transport-error" }),
          },
        },
      ],
      { mode: "full" },
    );
    expect(evidence.qualifications).toHaveLength(1);
    expect(evidence.qualifications[0]!.ledger.some((e) => e.role === "redaction")).toBe(true);
    expect(evidence.qualifications[0]!.ledger.filter((e) => e.role === "transport-fault")).toHaveLength(5);

    const noop = createNoopTelemetryPort();
    noop.record(SAMPLE_EVENTS[0]!);
    expect(await noop.flush()).toEqual({ kind: "noop", accepted: 0, dropped: 0 });
  });

  it("fails if an unredacted sink leaks PII or auth headers into outbound payloads (negative control)", async () => {
    const leakyPayloads: unknown[] = [];
    const queue: TelemetryEvent[] = [];
    const leakyAdapter = {
      capabilities: CAPS,
      record(ev: TelemetryEvent) { queue.push(ev); },
      async flush() {
        if (queue.length === 0) return { kind: "noop" as const, accepted: 0 as const, dropped: 0 as const };
        const batch = queue.splice(0, queue.length);
        leakyPayloads.push(batch);
        return { kind: "flushed" as const, accepted: batch.length, dropped: 0 };
      },
    };
    const makeLeaky = (): TelemetryScenarioHarness => ({
      adapter: leakyAdapter,
      sampleEvents: SAMPLE_EVENTS,
      readIoCount: () => leakyPayloads.length,
      readSentPayloads: () => leakyPayloads,
    });
    await expect(
      runTelemetryAdapterConformance([
        {
          id: "leaky-sink",
          happyFlush: makeLeaky,
          disabledPort: () => makeHarness({ kind: "success", value: 0 }, false),
        },
      ]),
    ).rejects.toThrow(/TELEMETRY_CONFORMANCE:secret_leak/);

    // Empty readSentPayloads() cannot vacuously pass happyFlush or pii_redaction
    await expect(
      runTelemetryAdapterConformance([
        {
          id: "empty-payload-sink",
          happyFlush: () => ({ ...makeHarness({ kind: "success", value: 2 }), readSentPayloads: () => [] }),
          disabledPort: () => makeHarness({ kind: "success", value: 0 }, false),
        },
      ]),
    ).rejects.toThrow(/TELEMETRY_CONFORMANCE:happy_flush_failed/);
  });
});
