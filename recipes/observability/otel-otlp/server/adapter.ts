import { HardenedFetchError, sanitizeDiagnosticCode } from "@openlup/platform/adapter-kit";
import {
  createSafeTelemetryPort,
  projectTelemetryStaticCapabilities,
  scrubTelemetryEvent,
  TELEMETRY_CONTRACT_VERSION,
  type TelemetryAttributes,
  type TelemetryCapabilities,
  type TelemetryEvent,
  type TelemetryFlushResult,
  type TelemetryPort,
} from "@openlup/platform/observability";
import {
  OtelOtlpClientError,
  type OtelOtlpClient,
  type OtlpExportLogsServiceRequest,
  type OtlpExportMetricsServiceRequest,
  type OtlpExportTraceServiceRequest,
  type OtlpInstrumentationScope,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpMetric,
  type OtlpResource,
  type OtlpSpan,
} from "./client-contract.js";

export const OTEL_OTLP_PROVIDER_KIND = "otel_otlp" as const;
export const DEFAULT_OTEL_OTLP_MAX_BATCH_SIZE = 100;
export const DEFAULT_OTEL_OTLP_SERVICE = "openlup" as const;

const SCOPE_META: OtlpInstrumentationScope = Object.freeze({
  name: "@openlup/observability-otel-otlp",
  version: "1.0.0",
});

const DEFAULT_TRACE_ID = "00000000000000000000000000000000";
const DEFAULT_SPAN_ID = "0000000000000001";
const TRACE_ID_HEX_PATTERN = /^[0-9a-f]{32}$/iu;
const SPAN_ID_HEX_PATTERN = /^[0-9a-f]{16}$/iu;

export const OTEL_OTLP_STATIC_CAPABILITIES: TelemetryCapabilities = Object.freeze({
  contractVersion: TELEMETRY_CONTRACT_VERSION,
  providerKind: OTEL_OTLP_PROVIDER_KIND,
  supportsSpans: true,
  supportsMetrics: true,
  supportsLogs: true,
  supportsErrors: true,
  maxBatchSize: DEFAULT_OTEL_OTLP_MAX_BATCH_SIZE,
  requiresCredentials: false,
});

export function projectOtelOtlpStaticCapabilities(
  capabilities: TelemetryCapabilities = OTEL_OTLP_STATIC_CAPABILITIES,
): TelemetryCapabilities {
  return projectTelemetryStaticCapabilities(capabilities);
}

export interface CreateOtelOtlpTelemetryAdapterOptions {
  readonly client: OtelOtlpClient;
  readonly service?: string;
  readonly enabled?: boolean;
  readonly maxBatchSize?: number;
}

function isoToUnixNanoString(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "0";
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

function addDurationMsNanoString(startIso: string, durationMs: number): string {
  const ms = Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "0";
  const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  const startNs = BigInt(Math.trunc(ms)) * 1_000_000n;
  const deltaNs = BigInt(Math.round(safeDuration * 1_000_000));
  return (startNs + deltaNs).toString();
}

function toOtlpAttributes(
  attributes: TelemetryAttributes | undefined,
): readonly OtlpKeyValue[] | undefined {
  if (!attributes) return undefined;
  const entries = Object.entries(attributes);
  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) => {
    if (typeof value === "boolean") {
      return { key, value: { boolValue: value } };
    }
    if (typeof value === "number") {
      if (Number.isSafeInteger(value)) {
        return { key, value: { intValue: String(value) } };
      }
      return { key, value: { doubleValue: value } };
    }
    return { key, value: { stringValue: value } };
  });
}

function buildResource(service: string): OtlpResource {
  return {
    attributes: [{ key: "service.name", value: { stringValue: service } }],
  };
}

function toOtlpSpan(event: Extract<TelemetryEvent, { readonly kind: "span" }>): OtlpSpan {
  const attributes = toOtlpAttributes(event.attributes);
  const traceId =
    event.traceId && TRACE_ID_HEX_PATTERN.test(event.traceId)
      ? event.traceId.toLowerCase()
      : DEFAULT_TRACE_ID;
  const spanId =
    event.spanId && SPAN_ID_HEX_PATTERN.test(event.spanId)
      ? event.spanId.toLowerCase()
      : DEFAULT_SPAN_ID;
  return {
    traceId,
    spanId,
    name: event.name,
    kind: 1,
    startTimeUnixNano: isoToUnixNanoString(event.startedAt),
    endTimeUnixNano: addDurationMsNanoString(event.startedAt, event.durationMs),
    status: { code: event.status === "error" ? 2 : 1 },
    ...(attributes !== undefined ? { attributes } : {}),
  };
}

function toOtlpMetric(event: Extract<TelemetryEvent, { readonly kind: "metric" }>): OtlpMetric {
  const attributes = toOtlpAttributes(event.attributes);
  const timeUnixNano = isoToUnixNanoString(event.timestamp);
  const pointValue = Number.isSafeInteger(event.value)
    ? { asInt: String(event.value) }
    : { asDouble: event.value };
  const numberPoint = {
    timeUnixNano,
    ...pointValue,
    ...(attributes !== undefined ? { attributes } : {}),
  };

  if (event.metricKind === "counter") {
    return {
      name: event.name,
      unit: event.unit ?? "1",
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [numberPoint],
      },
    };
  }
  if (event.metricKind === "histogram") {
    return {
      name: event.name,
      unit: event.unit ?? "1",
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [
          {
            timeUnixNano,
            count: "1",
            sum: event.value,
            ...(attributes !== undefined ? { attributes } : {}),
          },
        ],
      },
    };
  }
  return {
    name: event.name,
    unit: event.unit ?? "1",
    gauge: {
      dataPoints: [numberPoint],
    },
  };
}

function severityToNumber(severity: "debug" | "info" | "warn" | "error"): number {
  switch (severity) {
    case "debug":
      return 5;
    case "info":
      return 9;
    case "warn":
      return 13;
    case "error":
      return 17;
  }
}

function toOtlpLogRecord(
  event: Extract<TelemetryEvent, { readonly kind: "log" | "error" }>,
): OtlpLogRecord {
  const baseAttrs = toOtlpAttributes(event.attributes) ?? [];
  if (event.kind === "log") {
    return {
      timeUnixNano: isoToUnixNanoString(event.timestamp),
      severityNumber: severityToNumber(event.severity),
      severityText: event.severity.toUpperCase(),
      body: { stringValue: event.message },
      ...(baseAttrs.length > 0 ? { attributes: baseAttrs } : {}),
    };
  }
  return {
    timeUnixNano: isoToUnixNanoString(event.timestamp),
    severityNumber: 17,
    severityText: "ERROR",
    body: { stringValue: event.message },
    attributes: [{ key: "exception.type", value: { stringValue: event.code } }, ...baseAttrs],
  };
}

export interface OtlpSignalPayloads {
  readonly traces?: OtlpExportTraceServiceRequest;
  readonly spanCount: number;
  readonly metrics?: OtlpExportMetricsServiceRequest;
  readonly metricCount: number;
  readonly logs?: OtlpExportLogsServiceRequest;
  readonly logCount: number;
}

export function mapTelemetryEventsToOtlpPayloads(
  events: readonly TelemetryEvent[],
  service: string,
): OtlpSignalPayloads {
  const spans: OtlpSpan[] = [];
  const metrics: OtlpMetric[] = [];
  const logRecords: OtlpLogRecord[] = [];
  const resource = buildResource(service);

  for (const raw of events) {
    const event = scrubTelemetryEvent(raw);
    switch (event.kind) {
      case "span":
        spans.push(toOtlpSpan(event));
        break;
      case "metric":
        metrics.push(toOtlpMetric(event));
        break;
      case "log":
      case "error":
        logRecords.push(toOtlpLogRecord(event));
        break;
    }
  }

  return {
    spanCount: spans.length,
    metricCount: metrics.length,
    logCount: logRecords.length,
    ...(spans.length > 0
      ? {
          traces: {
            resourceSpans: [
              {
                resource,
                scopeSpans: [{ scope: SCOPE_META, spans }],
              },
            ],
          },
        }
      : {}),
    ...(metrics.length > 0
      ? {
          metrics: {
            resourceMetrics: [
              {
                resource,
                scopeMetrics: [{ scope: SCOPE_META, metrics }],
              },
            ],
          },
        }
      : {}),
    ...(logRecords.length > 0
      ? {
          logs: {
            resourceLogs: [
              {
                resource,
                scopeLogs: [{ scope: SCOPE_META, logRecords }],
              },
            ],
          },
        }
      : {}),
  };
}

function classifyFailure(err: unknown): {
  readonly retryable: boolean;
  readonly diagnosticCode: string;
} {
  if (err instanceof OtelOtlpClientError) {
    return { retryable: err.retryable, diagnosticCode: err.diagnosticCode };
  }
  if (err instanceof HardenedFetchError) {
    if (err.kind === "http_error" && (err.status === 401 || err.status === 403)) {
      return { retryable: false, diagnosticCode: "OTEL_OTLP_AUTH_FAILED" };
    }
    if (err.kind === "http_error" && err.status === 429) {
      return { retryable: true, diagnosticCode: "OTEL_OTLP_RATE_LIMITED" };
    }
    if (err.kind === "http_error" && err.status !== undefined && err.status >= 500) {
      return { retryable: true, diagnosticCode: "OTEL_OTLP_SERVER_ERROR" };
    }
    if (err.kind === "http_error") {
      return { retryable: false, diagnosticCode: "OTEL_OTLP_CLIENT_ERROR" };
    }
    return {
      retryable: err.kind !== "origin_rejected",
      diagnosticCode: sanitizeDiagnosticCode(
        `OTEL_OTLP_${err.kind.toUpperCase()}`,
        "OTEL_OTLP_TRANSPORT_ERROR",
      ),
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
      return { retryable: false, diagnosticCode: "OTEL_OTLP_AUTH_FAILED" };
    }
    if (candidate.kind === "rate-limited-429" || candidate.status === 429) {
      return { retryable: true, diagnosticCode: "OTEL_OTLP_RATE_LIMITED" };
    }
    if (candidate.kind === "timeout" || candidate.name === "AbortError") {
      return { retryable: true, diagnosticCode: "OTEL_OTLP_TIMEOUT" };
    }
  }
  return { retryable: true, diagnosticCode: "OTEL_OTLP_EXPORT_FAILED" };
}

/**
 * Constructs a fail-open, ingress-scrubbed `TelemetryPort` backed by OpenTelemetry OTLP/HTTP JSON.
 * Single-signal batches issue 1 HTTP request; mixed batches dispatch once per present signal
 * (`/v1/traces`, `/v1/metrics`, `/v1/logs`). When `enabled` is `false`, zero I/O is performed.
 */
export function createOtelOtlpTelemetryAdapter(
  options: CreateOtelOtlpTelemetryAdapterOptions,
): TelemetryPort {
  const service =
    typeof options.service === "string" && options.service.trim().length > 0
      ? options.service.trim()
      : DEFAULT_OTEL_OTLP_SERVICE;
  const maxBatchSize =
    options.maxBatchSize !== undefined &&
    Number.isSafeInteger(options.maxBatchSize) &&
    options.maxBatchSize > 0 &&
    options.maxBatchSize <= 10_000
      ? options.maxBatchSize
      : DEFAULT_OTEL_OTLP_MAX_BATCH_SIZE;

  const capabilities: TelemetryCapabilities = Object.freeze({
    ...OTEL_OTLP_STATIC_CAPABILITIES,
    maxBatchSize,
  });

  return createSafeTelemetryPort({
    capabilities,
    enabled: options.enabled,
    async exportBatch(events, signal): Promise<TelemetryFlushResult> {
      const grouped = mapTelemetryEventsToOtlpPayloads(events, service);
      const dispatches: Array<{
        readonly count: number;
        readonly run: () => Promise<{ readonly rejectedCount: number }>;
      }> = [];

      if (grouped.traces) {
        const payload = grouped.traces;
        dispatches.push({
          count: grouped.spanCount,
          run: () => options.client.exportTraces(payload, signal),
        });
      }
      if (grouped.metrics) {
        const payload = grouped.metrics;
        dispatches.push({
          count: grouped.metricCount,
          run: () => options.client.exportMetrics(payload, signal),
        });
      }
      if (grouped.logs) {
        const payload = grouped.logs;
        dispatches.push({
          count: grouped.logCount,
          run: () => options.client.exportLogs(payload, signal),
        });
      }

      if (dispatches.length === 0) {
        return { kind: "noop", accepted: 0, dropped: 0 };
      }

      let accepted = 0;
      let dropped = 0;
      let firstFailure: { readonly retryable: boolean; readonly diagnosticCode: string } | null =
        null;

      for (const dispatch of dispatches) {
        try {
          const res = await dispatch.run();
          const rejected = Math.max(0, Math.min(dispatch.count, Math.trunc(res.rejectedCount)));
          accepted += dispatch.count - rejected;
          dropped += rejected;
        } catch (err) {
          dropped += dispatch.count;
          if (!firstFailure) {
            firstFailure = classifyFailure(err);
          }
        }
      }

      if (accepted === 0 && firstFailure) {
        return {
          kind: "failed",
          accepted: 0,
          dropped,
          retryable: firstFailure.retryable,
          diagnosticCode: firstFailure.diagnosticCode,
        };
      }

      return {
        kind: "flushed",
        accepted,
        dropped,
      };
    },
  });
}
