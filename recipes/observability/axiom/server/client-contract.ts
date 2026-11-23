import {
  createHardenedFetch,
  HardenedFetchError,
  sanitizeDiagnosticCode,
} from "@openlup/platform/adapter-kit";
import type { TelemetryAttributes, TelemetryEvent } from "@openlup/platform/observability/contracts";

export const AXIOM_ORIGIN = "https://api.axiom.co" as const;
export const AXIOM_DATASET_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 262_144;
const CONTROL_CHARS_PATTERN = /[\r\n\p{Cc}\p{Cf}]/u;

export type FetchLike = typeof fetch;

export interface AxiomEventRecord {
  readonly _time: string;
  readonly kind: TelemetryEvent["kind"];
  readonly service: string;
  readonly name?: string;
  readonly severity?: "debug" | "info" | "warn" | "error";
  readonly status?: "ok" | "error";
  readonly durationMs?: number;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly metricKind?: "counter" | "gauge" | "histogram";
  readonly value?: number;
  readonly unit?: string;
  readonly code?: string;
  readonly message?: string;
  readonly attributes?: TelemetryAttributes;
}

export interface AxiomIngestFailure {
  readonly timestamp?: string;
  readonly error?: string;
}

export interface AxiomIngestResponse {
  readonly ingested: number;
  readonly failed: number;
  readonly failures?: readonly AxiomIngestFailure[];
}

export interface AxiomClient {
  ingest(
    events: readonly AxiomEventRecord[],
    signal?: AbortSignal,
  ): Promise<AxiomIngestResponse>;
}

export interface AxiomHttpClientOptions {
  readonly dataset: string;
  readonly apiToken: string;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly clock?: () => number;
}

export class AxiomClientError extends Error {
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
    readonly kind: AxiomClientError["kind"];
    readonly diagnosticCode: string;
    readonly retryable: boolean;
    readonly status?: number;
    readonly retryAfterSeconds?: number;
  }) {
    const safeCode = sanitizeDiagnosticCode(params.diagnosticCode, "AXIOM_ERROR");
    super(safeCode);
    this.name = "AxiomClientError";
    this.kind = params.kind;
    this.diagnosticCode = safeCode;
    this.retryable = params.retryable;
    if (params.status !== undefined) this.status = params.status;
    if (params.retryAfterSeconds !== undefined) this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export function assertValidAxiomDataset(dataset: string): string {
  if (
    typeof dataset !== "string" ||
    dataset === "." ||
    dataset === ".." ||
    !AXIOM_DATASET_PATTERN.test(dataset)
  ) {
    throw new AxiomClientError({
      kind: "config_error",
      diagnosticCode: "AXIOM_INVALID_DATASET",
      retryable: false,
    });
  }
  return dataset;
}

export function assertValidAxiomApiToken(apiToken: string): string {
  if (typeof apiToken !== "string") {
    throw new AxiomClientError({
      kind: "config_error",
      diagnosticCode: "AXIOM_INVALID_API_TOKEN",
      retryable: false,
    });
  }
  const trimmed = apiToken.trim();
  if (trimmed.length === 0 || CONTROL_CHARS_PATTERN.test(trimmed)) {
    throw new AxiomClientError({
      kind: "config_error",
      diagnosticCode: "AXIOM_INVALID_API_TOKEN",
      retryable: false,
    });
  }
  return trimmed;
}

function mapHardenedFetchError(err: HardenedFetchError): AxiomClientError {
  if (err.kind === "http_error") {
    if (err.status === 401 || err.status === 403) {
      return new AxiomClientError({
        kind: "auth_failed",
        diagnosticCode: "AXIOM_AUTH_FAILED",
        retryable: false,
        status: err.status,
      });
    }
    if (err.status === 429) {
      return new AxiomClientError({
        kind: "rate_limited",
        diagnosticCode: "AXIOM_RATE_LIMITED",
        retryable: true,
        status: err.status,
        retryAfterSeconds: err.retryAfterSeconds,
      });
    }
    if (err.status !== undefined && err.status >= 500) {
      return new AxiomClientError({
        kind: "server_error",
        diagnosticCode: "AXIOM_SERVER_ERROR",
        retryable: true,
        status: err.status,
      });
    }
    return new AxiomClientError({
      kind: "client_error",
      diagnosticCode: "AXIOM_CLIENT_ERROR",
      retryable: false,
      status: err.status,
    });
  }
  if (err.kind === "timeout") {
    return new AxiomClientError({
      kind: "timeout",
      diagnosticCode: "AXIOM_TIMEOUT",
      retryable: true,
    });
  }
  if (err.kind === "network_error") {
    return new AxiomClientError({
      kind: "network_error",
      diagnosticCode: "AXIOM_NETWORK_ERROR",
      retryable: true,
    });
  }
  if (err.kind === "origin_rejected") {
    return new AxiomClientError({
      kind: "config_error",
      diagnosticCode: "AXIOM_ORIGIN_REJECTED",
      retryable: false,
    });
  }
  return new AxiomClientError({
    kind: "malformed_response",
    diagnosticCode: sanitizeDiagnosticCode(
      err.kind === "body_too_large" ? "AXIOM_RESPONSE_TOO_LARGE" : "AXIOM_MALFORMED_JSON",
      "AXIOM_MALFORMED_RESPONSE",
    ),
    retryable: true,
    status: err.status,
  });
}

function parseIngestResponse(rawText: string, expectedCount: number): AxiomIngestResponse {
  if (rawText.trim().length === 0) {
    return { ingested: expectedCount, failed: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new AxiomClientError({
      kind: "malformed_response",
      diagnosticCode: "AXIOM_MALFORMED_JSON",
      retryable: true,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ingested: expectedCount, failed: 0 };
  }
  const obj = parsed as Record<string, unknown>;
  const ingested =
    typeof obj["ingested"] === "number" && Number.isFinite(obj["ingested"]) && obj["ingested"] >= 0
      ? Math.trunc(obj["ingested"])
      : expectedCount;
  const failed =
    typeof obj["failed"] === "number" && Number.isFinite(obj["failed"]) && obj["failed"] >= 0
      ? Math.trunc(obj["failed"])
      : Math.max(0, expectedCount - ingested);
  const failures = Array.isArray(obj["failures"])
    ? obj["failures"]
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .slice(0, 16)
        .map((item) => ({
          ...(typeof item["timestamp"] === "string" ? { timestamp: item["timestamp"] } : {}),
          ...(typeof item["error"] === "string" ? { error: item["error"].slice(0, 128) } : {}),
        }))
    : undefined;
  return {
    ingested,
    failed,
    ...(failures && failures.length > 0 ? { failures } : {}),
  };
}

/**
 * Zero-dependency Axiom Ingest v1 HTTP client backed by `@openlup/platform/adapter-kit` `createHardenedFetch`.
 * Pins egress to `https://api.axiom.co`, validates dataset and Bearer token at construction time,
 * enforces `redirect: "error"`, and emits only sanitized diagnostic errors with zero secret reflection.
 */
export function createAxiomHttpClient(options: AxiomHttpClientOptions): AxiomClient {
  const dataset = assertValidAxiomDataset(options.dataset);
  const token = assertValidAxiomApiToken(options.apiToken);
  if (typeof options.fetchImpl !== "function") {
    throw new AxiomClientError({
      kind: "config_error",
      diagnosticCode: "AXIOM_MISSING_FETCH",
      retryable: false,
    });
  }

  const hardened = createHardenedFetch({
    allowedOrigins: [AXIOM_ORIGIN],
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    clock: options.clock,
    defaultHeaders: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  });

  const ingestUrl = `${AXIOM_ORIGIN}/v1/datasets/${encodeURIComponent(dataset)}/ingest`;

  return Object.freeze({
    async ingest(
      events: readonly AxiomEventRecord[],
      signal?: AbortSignal,
    ): Promise<AxiomIngestResponse> {
      if (events.length === 0) {
        return { ingested: 0, failed: 0 };
      }
      try {
        const res = await hardened.fetchBytes(ingestUrl, {
          method: "POST",
          body: JSON.stringify(events),
          signal,
        });
        const text = new TextDecoder().decode(res.body);
        return parseIngestResponse(text, events.length);
      } catch (err) {
        if (err instanceof AxiomClientError) throw err;
        if (err instanceof HardenedFetchError) {
          throw mapHardenedFetchError(err);
        }
        throw new AxiomClientError({
          kind: "network_error",
          diagnosticCode: "AXIOM_UNEXPECTED_TRANSPORT_ERROR",
          retryable: true,
        });
      }
    },
  });
}
