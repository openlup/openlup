import {
  createHardenedFetch,
  HardenedFetchError,
  sanitizeDiagnosticCode,
} from "@openlup/platform/adapter-kit";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 262_144;
const CONTROL_CHARS_PATTERN = /[\r\n\p{Cc}\p{Cf}]/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export type FetchLike = typeof fetch;

export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly boolValue: boolean };

export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export interface OtlpResource {
  readonly attributes: readonly OtlpKeyValue[];
}

export interface OtlpInstrumentationScope {
  readonly name: string;
  readonly version?: string;
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly status: { readonly code: number };
  readonly attributes?: readonly OtlpKeyValue[];
}

export interface OtlpNumberDataPoint {
  readonly timeUnixNano: string;
  readonly asInt?: string;
  readonly asDouble?: number;
  readonly attributes?: readonly OtlpKeyValue[];
}

export interface OtlpHistogramDataPoint {
  readonly timeUnixNano: string;
  readonly count: string;
  readonly sum: number;
  readonly attributes?: readonly OtlpKeyValue[];
}

export interface OtlpMetric {
  readonly name: string;
  readonly unit: string;
  readonly sum?: {
    readonly aggregationTemporality: number;
    readonly isMonotonic: boolean;
    readonly dataPoints: readonly OtlpNumberDataPoint[];
  };
  readonly gauge?: {
    readonly dataPoints: readonly OtlpNumberDataPoint[];
  };
  readonly histogram?: {
    readonly aggregationTemporality: number;
    readonly dataPoints: readonly OtlpHistogramDataPoint[];
  };
}

export interface OtlpLogRecord {
  readonly timeUnixNano: string;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: { readonly stringValue: string };
  readonly attributes?: readonly OtlpKeyValue[];
}

export interface OtlpExportTraceServiceRequest {
  readonly resourceSpans: readonly {
    readonly resource: OtlpResource;
    readonly scopeSpans: readonly {
      readonly scope: OtlpInstrumentationScope;
      readonly spans: readonly OtlpSpan[];
    }[];
  }[];
}

export interface OtlpExportMetricsServiceRequest {
  readonly resourceMetrics: readonly {
    readonly resource: OtlpResource;
    readonly scopeMetrics: readonly {
      readonly scope: OtlpInstrumentationScope;
      readonly metrics: readonly OtlpMetric[];
    }[];
  }[];
}

export interface OtlpExportLogsServiceRequest {
  readonly resourceLogs: readonly {
    readonly resource: OtlpResource;
    readonly scopeLogs: readonly {
      readonly scope: OtlpInstrumentationScope;
      readonly logRecords: readonly OtlpLogRecord[];
    }[];
  }[];
}

export interface OtlpExportResult {
  readonly rejectedCount: number;
}

export interface OtelOtlpClient {
  exportTraces(
    payload: OtlpExportTraceServiceRequest,
    signal?: AbortSignal,
  ): Promise<OtlpExportResult>;
  exportMetrics(
    payload: OtlpExportMetricsServiceRequest,
    signal?: AbortSignal,
  ): Promise<OtlpExportResult>;
  exportLogs(
    payload: OtlpExportLogsServiceRequest,
    signal?: AbortSignal,
  ): Promise<OtlpExportResult>;
}

export interface OtelOtlpHttpClientOptions {
  readonly collectorOrigin: string;
  readonly fetchImpl: FetchLike;
  readonly authorization?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly clock?: () => number;
}

export class OtelOtlpClientError extends Error {
  readonly kind:
    | "config_error"
    | "auth_failed"
    | "rate_limited"
    | "server_error"
    | "client_error"
    | "timeout"
    | "network_error"
    | "malformed_response";
  readonly diagnosticCode: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly retryable: boolean;

  constructor(params: {
    readonly kind: OtelOtlpClientError["kind"];
    readonly diagnosticCode: string;
    readonly retryable: boolean;
    readonly status?: number;
    readonly retryAfterSeconds?: number;
  }) {
    const safeCode = sanitizeDiagnosticCode(params.diagnosticCode, "OTEL_OTLP_ERROR");
    super(safeCode);
    this.name = "OtelOtlpClientError";
    this.kind = params.kind;
    this.diagnosticCode = safeCode;
    this.retryable = params.retryable;
    if (params.status !== undefined) this.status = params.status;
    if (params.retryAfterSeconds !== undefined) this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export function assertValidCollectorOrigin(collectorOrigin: string): string {
  if (typeof collectorOrigin !== "string" || collectorOrigin.length === 0) {
    throw new OtelOtlpClientError({
      kind: "config_error",
      diagnosticCode: "OTEL_OTLP_INVALID_ORIGIN",
      retryable: false,
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(collectorOrigin);
  } catch {
    throw new OtelOtlpClientError({
      kind: "config_error",
      diagnosticCode: "OTEL_OTLP_INVALID_ORIGIN",
      retryable: false,
    });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    collectorOrigin !== parsed.origin
  ) {
    throw new OtelOtlpClientError({
      kind: "config_error",
      diagnosticCode: "OTEL_OTLP_INVALID_ORIGIN",
      retryable: false,
    });
  }
  return parsed.origin;
}

function buildValidatedDefaultHeaders(options: OtelOtlpHttpClientOptions): Record<string, string> {
  const out: Record<string, string> = {};
  if (options.headers) {
    for (const [rawKey, rawVal] of Object.entries(options.headers)) {
      const key = rawKey.trim().toLowerCase();
      if (
        !HEADER_NAME_PATTERN.test(key) ||
        key === "content-type" ||
        key === "host" ||
        typeof rawVal !== "string" ||
        CONTROL_CHARS_PATTERN.test(rawVal)
      ) {
        throw new OtelOtlpClientError({
          kind: "config_error",
          diagnosticCode: "OTEL_OTLP_INVALID_HEADER",
          retryable: false,
        });
      }
      out[key] = rawVal.trim();
    }
  }
  if (options.authorization !== undefined) {
    const trimmed = options.authorization.trim();
    if (trimmed.length === 0 || CONTROL_CHARS_PATTERN.test(trimmed)) {
      throw new OtelOtlpClientError({
        kind: "config_error",
        diagnosticCode: "OTEL_OTLP_INVALID_AUTHORIZATION",
        retryable: false,
      });
    }
    out["authorization"] = trimmed;
  }
  out["content-type"] = "application/json";
  out["accept"] = "application/json";
  return out;
}

function mapHardenedFetchError(err: HardenedFetchError): OtelOtlpClientError {
  if (err.kind === "http_error") {
    if (err.status === 401 || err.status === 403) {
      return new OtelOtlpClientError({
        kind: "auth_failed",
        diagnosticCode: "OTEL_OTLP_AUTH_FAILED",
        retryable: false,
        status: err.status,
      });
    }
    if (err.status === 429) {
      return new OtelOtlpClientError({
        kind: "rate_limited",
        diagnosticCode: "OTEL_OTLP_RATE_LIMITED",
        retryable: true,
        status: err.status,
        retryAfterSeconds: err.retryAfterSeconds,
      });
    }
    if (err.status !== undefined && err.status >= 500) {
      return new OtelOtlpClientError({
        kind: "server_error",
        diagnosticCode: "OTEL_OTLP_SERVER_ERROR",
        retryable: true,
        status: err.status,
      });
    }
    return new OtelOtlpClientError({
      kind: "client_error",
      diagnosticCode: "OTEL_OTLP_CLIENT_ERROR",
      retryable: false,
      status: err.status,
    });
  }
  if (err.kind === "timeout") {
    return new OtelOtlpClientError({
      kind: "timeout",
      diagnosticCode: "OTEL_OTLP_TIMEOUT",
      retryable: true,
    });
  }
  if (err.kind === "network_error") {
    return new OtelOtlpClientError({
      kind: "network_error",
      diagnosticCode: "OTEL_OTLP_NETWORK_ERROR",
      retryable: true,
    });
  }
  if (err.kind === "origin_rejected") {
    return new OtelOtlpClientError({
      kind: "config_error",
      diagnosticCode: "OTEL_OTLP_ORIGIN_REJECTED",
      retryable: false,
    });
  }
  return new OtelOtlpClientError({
    kind: "malformed_response",
    diagnosticCode: sanitizeDiagnosticCode(
      err.kind === "body_too_large" ? "OTEL_OTLP_RESPONSE_TOO_LARGE" : "OTEL_OTLP_MALFORMED_JSON",
      "OTEL_OTLP_MALFORMED_RESPONSE",
    ),
    retryable: true,
    status: err.status,
  });
}

function toNonNegativeCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return 0;
}

function parseOtlpResponse(
  rawText: string,
  rejectedField: "rejectedSpans" | "rejectedDataPoints" | "rejectedLogRecords",
): OtlpExportResult {
  if (rawText.trim().length === 0) {
    return { rejectedCount: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new OtelOtlpClientError({
      kind: "malformed_response",
      diagnosticCode: "OTEL_OTLP_MALFORMED_JSON",
      retryable: true,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rejectedCount: 0 };
  }
  const obj = parsed as Record<string, unknown>;
  const partial = obj["partialSuccess"];
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    return { rejectedCount: 0 };
  }
  const rejectedCount = toNonNegativeCount(
    (partial as Record<string, unknown>)[rejectedField],
  );
  return { rejectedCount };
}

/**
 * Zero-dependency OpenTelemetry OTLP/HTTP JSON client built on `@openlup/platform/adapter-kit`.
 * Validates a strict HTTPS collector origin (zero path/query/userinfo) at construction time,
 * pins egress with `createHardenedFetch`, enforces `redirect: "error"`, and emits redacted errors.
 */
export function createOtelOtlpHttpClient(options: OtelOtlpHttpClientOptions): OtelOtlpClient {
  const origin = assertValidCollectorOrigin(options.collectorOrigin);
  if (typeof options.fetchImpl !== "function") {
    throw new OtelOtlpClientError({
      kind: "config_error",
      diagnosticCode: "OTEL_OTLP_MISSING_FETCH",
      retryable: false,
    });
  }
  const defaultHeaders = buildValidatedDefaultHeaders(options);

  const hardened = createHardenedFetch({
    allowedOrigins: [origin],
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    clock: options.clock,
    defaultHeaders,
  });

  async function postSignal(
    path: "/v1/traces" | "/v1/metrics" | "/v1/logs",
    rejectedField: "rejectedSpans" | "rejectedDataPoints" | "rejectedLogRecords",
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<OtlpExportResult> {
    try {
      const res = await hardened.fetchBytes(`${origin}${path}`, {
        method: "POST",
        body: JSON.stringify(payload),
        signal,
      });
      const text = new TextDecoder().decode(res.body);
      return parseOtlpResponse(text, rejectedField);
    } catch (err) {
      if (err instanceof OtelOtlpClientError) throw err;
      if (err instanceof HardenedFetchError) {
        throw mapHardenedFetchError(err);
      }
      throw new OtelOtlpClientError({
        kind: "network_error",
        diagnosticCode: "OTEL_OTLP_UNEXPECTED_TRANSPORT_ERROR",
        retryable: true,
      });
    }
  }

  return Object.freeze({
    exportTraces(payload: OtlpExportTraceServiceRequest, signal?: AbortSignal) {
      return postSignal("/v1/traces", "rejectedSpans", payload, signal);
    },
    exportMetrics(payload: OtlpExportMetricsServiceRequest, signal?: AbortSignal) {
      return postSignal("/v1/metrics", "rejectedDataPoints", payload, signal);
    },
    exportLogs(payload: OtlpExportLogsServiceRequest, signal?: AbortSignal) {
      return postSignal("/v1/logs", "rejectedLogRecords", payload, signal);
    },
  });
}
