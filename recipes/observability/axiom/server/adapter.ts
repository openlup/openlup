import { HardenedFetchError, sanitizeDiagnosticCode } from "@openlup/platform/adapter-kit";
import {
  createSafeTelemetryPort,
  projectTelemetryStaticCapabilities,
  scrubTelemetryEvent,
  TELEMETRY_CONTRACT_VERSION,
  type TelemetryCapabilities,
  type TelemetryEvent,
  type TelemetryFlushResult,
  type TelemetryPort,
} from "@openlup/platform/observability";
import {
  AxiomClientError,
  type AxiomClient,
  type AxiomEventRecord,
} from "./client-contract.js";

export const AXIOM_PROVIDER_KIND = "axiom" as const;
export const DEFAULT_AXIOM_MAX_BATCH_SIZE = 100;
export const DEFAULT_AXIOM_SERVICE = "openlup" as const;

export const AXIOM_STATIC_CAPABILITIES: TelemetryCapabilities = Object.freeze({
  contractVersion: TELEMETRY_CONTRACT_VERSION,
  providerKind: AXIOM_PROVIDER_KIND,
  supportsSpans: true,
  supportsMetrics: true,
  supportsLogs: true,
  supportsErrors: true,
  maxBatchSize: DEFAULT_AXIOM_MAX_BATCH_SIZE,
  requiresCredentials: true,
});

export function projectAxiomStaticCapabilities(
  capabilities: TelemetryCapabilities = AXIOM_STATIC_CAPABILITIES,
): TelemetryCapabilities {
  return projectTelemetryStaticCapabilities(capabilities);
}

export interface CreateAxiomTelemetryAdapterOptions {
  readonly client: AxiomClient;
  readonly service?: string;
  readonly enabled?: boolean;
  readonly maxBatchSize?: number;
}

export function mapTelemetryEventToAxiomRecord(
  event: TelemetryEvent,
  service: string,
): AxiomEventRecord {
  const scrubbed = scrubTelemetryEvent(event);
  switch (scrubbed.kind) {
    case "span":
      return {
        _time: scrubbed.startedAt,
        kind: "span",
        service,
        name: scrubbed.name,
        durationMs: scrubbed.durationMs,
        status: scrubbed.status,
        ...(scrubbed.traceId !== undefined ? { traceId: scrubbed.traceId } : {}),
        ...(scrubbed.spanId !== undefined ? { spanId: scrubbed.spanId } : {}),
        ...(scrubbed.attributes !== undefined ? { attributes: scrubbed.attributes } : {}),
      };
    case "metric":
      return {
        _time: scrubbed.timestamp,
        kind: "metric",
        service,
        metricKind: scrubbed.metricKind,
        name: scrubbed.name,
        value: scrubbed.value,
        ...(scrubbed.unit !== undefined ? { unit: scrubbed.unit } : {}),
        ...(scrubbed.attributes !== undefined ? { attributes: scrubbed.attributes } : {}),
      };
    case "log":
      return {
        _time: scrubbed.timestamp,
        kind: "log",
        service,
        severity: scrubbed.severity,
        message: scrubbed.message,
        ...(scrubbed.attributes !== undefined ? { attributes: scrubbed.attributes } : {}),
      };
    case "error":
      return {
        _time: scrubbed.timestamp,
        kind: "error",
        service,
        code: scrubbed.code,
        message: scrubbed.message,
        ...(scrubbed.attributes !== undefined ? { attributes: scrubbed.attributes } : {}),
      };
  }
}

function mapExportFailure(err: unknown, dropped: number): TelemetryFlushResult {
  if (err instanceof AxiomClientError) {
    return {
      kind: "failed",
      accepted: 0,
      dropped,
      retryable: err.retryable,
      diagnosticCode: err.diagnosticCode,
    };
  }
  if (err instanceof HardenedFetchError) {
    if (err.kind === "http_error" && (err.status === 401 || err.status === 403)) {
      return {
        kind: "failed",
        accepted: 0,
        dropped,
        retryable: false,
        diagnosticCode: "AXIOM_AUTH_FAILED",
      };
    }
    if (err.kind === "http_error" && err.status === 429) {
      return {
        kind: "failed",
        accepted: 0,
        dropped,
        retryable: true,
        diagnosticCode: "AXIOM_RATE_LIMITED",
      };
    }
    if (err.kind === "http_error" && err.status !== undefined && err.status >= 500) {
      return {
        kind: "failed",
        accepted: 0,
        dropped,
        retryable: true,
        diagnosticCode: "AXIOM_SERVER_ERROR",
      };
    }
    if (err.kind === "http_error") {
      return {
        kind: "failed",
        accepted: 0,
        dropped,
        retryable: false,
        diagnosticCode: "AXIOM_CLIENT_ERROR",
      };
    }
    return {
      kind: "failed",
      accepted: 0,
      dropped,
      retryable: err.kind !== "origin_rejected",
      diagnosticCode: sanitizeDiagnosticCode(`AXIOM_${err.kind.toUpperCase()}`, "AXIOM_TRANSPORT_ERROR"),
    };
  }
  if (err && typeof err === "object") {
    const candidate = err as {
      readonly kind?: unknown;
      readonly status?: unknown;
      readonly name?: unknown;
    };
    if (
      candidate.kind === "http-failure" &&
      (candidate.status === 401 || candidate.status === 403)
    ) {
      return {
        kind: "failed",
        accepted: 0,
        dropped,
        retryable: false,
        diagnosticCode: "AXIOM_AUTH_FAILED",
      };
    }
    if (candidate.kind === "rate-limited-429" || candidate.status === 429) {
      return {
        kind: "failed",
        accepted: 0,
        dropped,
        retryable: true,
        diagnosticCode: "AXIOM_RATE_LIMITED",
      };
    }
    if (candidate.kind === "timeout" || candidate.name === "AbortError") {
      return {
        kind: "failed",
        accepted: 0,
        dropped,
        retryable: true,
        diagnosticCode: "AXIOM_TIMEOUT",
      };
    }
  }
  return {
    kind: "failed",
    accepted: 0,
    dropped,
    retryable: true,
    diagnosticCode: "AXIOM_EXPORT_FAILED",
  };
}

/**
 * Constructs a fail-open, ingress-scrubbed `TelemetryPort` backed by Axiom Ingest API v1.
 * When `enabled` is `false`, `record()` / `flush()` perform zero I/O and return `noop`.
 */
export function createAxiomTelemetryAdapter(
  options: CreateAxiomTelemetryAdapterOptions,
): TelemetryPort {
  const service =
    typeof options.service === "string" && options.service.trim().length > 0
      ? options.service.trim()
      : DEFAULT_AXIOM_SERVICE;
  const maxBatchSize =
    options.maxBatchSize !== undefined &&
    Number.isSafeInteger(options.maxBatchSize) &&
    options.maxBatchSize > 0 &&
    options.maxBatchSize <= 10_000
      ? options.maxBatchSize
      : DEFAULT_AXIOM_MAX_BATCH_SIZE;

  const capabilities: TelemetryCapabilities = Object.freeze({
    ...AXIOM_STATIC_CAPABILITIES,
    maxBatchSize,
  });

  return createSafeTelemetryPort({
    capabilities,
    enabled: options.enabled,
    async exportBatch(events, signal): Promise<TelemetryFlushResult> {
      const records = events.map((event) => mapTelemetryEventToAxiomRecord(event, service));
      try {
        const res = await options.client.ingest(records, signal);
        const accepted = Math.max(0, Math.min(events.length, Math.trunc(res.ingested)));
        const dropped = Math.max(0, events.length - accepted);
        return {
          kind: "flushed",
          accepted,
          dropped,
        };
      } catch (err) {
        return mapExportFailure(err, events.length);
      }
    },
  });
}
