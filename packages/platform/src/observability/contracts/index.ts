export type TelemetryContractVersion = "observability.telemetry.v1";

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

export type TelemetryEvent =
  | {
      readonly kind: "span";
      readonly name: string;
      readonly startedAt: string;
      readonly durationMs: number;
      readonly status: "ok" | "error";
      readonly traceId?: string;
      readonly spanId?: string;
      readonly attributes?: TelemetryAttributes;
    }
  | {
      readonly kind: "metric";
      readonly metricKind: "counter" | "gauge" | "histogram";
      readonly name: string;
      readonly value: number;
      readonly unit?: string;
      readonly timestamp: string;
      readonly attributes?: TelemetryAttributes;
    }
  | {
      readonly kind: "log";
      readonly severity: "debug" | "info" | "warn" | "error";
      readonly message: string;
      readonly timestamp: string;
      readonly attributes?: TelemetryAttributes;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly timestamp: string;
      readonly attributes?: TelemetryAttributes;
    };

export type TelemetryFlushResult =
  | { readonly kind: "flushed"; readonly accepted: number; readonly dropped: number }
  | { readonly kind: "noop"; readonly accepted: 0; readonly dropped: 0 }
  | {
      readonly kind: "failed";
      readonly accepted: 0;
      readonly dropped: number;
      readonly retryable: boolean;
      readonly diagnosticCode: string;
    };

export interface TelemetryCapabilities {
  readonly contractVersion: TelemetryContractVersion;
  readonly providerKind: string;
  readonly supportsSpans: boolean;
  readonly supportsMetrics: boolean;
  readonly supportsLogs: boolean;
  readonly supportsErrors: boolean;
  readonly maxBatchSize: number;
  readonly requiresCredentials: boolean;
}

export interface TelemetryPort {
  readonly capabilities: TelemetryCapabilities;
  record(event: TelemetryEvent): void;
  flush(signal?: AbortSignal): Promise<TelemetryFlushResult>;
  shutdown?(signal?: AbortSignal): Promise<void>;
}
