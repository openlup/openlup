import { z } from "zod";
import type {
  TelemetryAttributes,
  TelemetryCapabilities,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetryPort,
} from "./contracts/index.js";

export type * from "./contracts/index.js";

export const TELEMETRY_CONTRACT_VERSION = "observability.telemetry.v1" as const;

const PROVIDER_KIND_PATTERN = /^[a-z][a-z0-9_-]{1,47}$/u;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|passwd|authorization|cookie|api[_-]?key|credential|email|phone|ssn|card[_-]?number|cvv|iban)/iu;
const EMAIL_VALUE_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const BEARER_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu;

export const telemetryCapabilitiesSchema = z.strictObject({
  contractVersion: z.literal(TELEMETRY_CONTRACT_VERSION),
  providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
  supportsSpans: z.boolean(),
  supportsMetrics: z.boolean(),
  supportsLogs: z.boolean(),
  supportsErrors: z.boolean(),
  maxBatchSize: z.number().int().positive().max(10_000),
  requiresCredentials: z.boolean(),
});

export const telemetryFlushResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("flushed"),
    accepted: z.number().int().min(0),
    dropped: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal("noop"),
    accepted: z.literal(0),
    dropped: z.literal(0),
  }),
  z.strictObject({
    kind: z.literal("failed"),
    accepted: z.literal(0),
    dropped: z.number().int().min(0),
    retryable: z.boolean(),
    diagnosticCode: z.string().regex(DIAGNOSTIC_CODE_PATTERN),
  }),
]);

export function projectTelemetryStaticCapabilities(
  capabilities: TelemetryCapabilities,
): TelemetryCapabilities {
  return {
    contractVersion: capabilities.contractVersion,
    providerKind: capabilities.providerKind,
    supportsSpans: capabilities.supportsSpans,
    supportsMetrics: capabilities.supportsMetrics,
    supportsLogs: capabilities.supportsLogs,
    supportsErrors: capabilities.supportsErrors,
    maxBatchSize: capabilities.maxBatchSize,
    requiresCredentials: capabilities.requiresCredentials,
  };
}

export function scrubTelemetryString(value: string, maxLength = 512): string {
  const scrubbed = value
    .replace(EMAIL_VALUE_PATTERN, "[redacted_email]")
    .replace(BEARER_VALUE_PATTERN, "[redacted_auth]");
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength - 3)}...` : scrubbed;
}

export function scrubTelemetryAttributes(
  attributes: TelemetryAttributes | undefined,
): TelemetryAttributes | undefined {
  if (!attributes) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, val] of Object.entries(attributes)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
    } else if (typeof val === "string") {
      out[key] = scrubTelemetryString(val);
    } else if (typeof val === "number") {
      out[key] = Number.isFinite(val) ? val : 0;
    } else if (typeof val === "boolean") {
      out[key] = val;
    }
  }
  return out;
}

export function scrubTelemetryEvent(event: TelemetryEvent): TelemetryEvent {
  const attributes = scrubTelemetryAttributes(event.attributes);
  switch (event.kind) {
    case "span":
      return {
        ...event,
        name: scrubTelemetryString(event.name, 160),
        durationMs: Number.isFinite(event.durationMs) && event.durationMs >= 0 ? event.durationMs : 0,
        ...(attributes !== undefined ? { attributes } : {}),
      };
    case "metric":
      return {
        ...event,
        name: scrubTelemetryString(event.name, 160),
        value: Number.isFinite(event.value) ? event.value : 0,
        ...(attributes !== undefined ? { attributes } : {}),
      };
    case "log":
      return {
        ...event,
        message: scrubTelemetryString(event.message),
        ...(attributes !== undefined ? { attributes } : {}),
      };
    case "error":
      return {
        ...event,
        code: scrubTelemetryString(event.code, 64),
        message: scrubTelemetryString(event.message),
        ...(attributes !== undefined ? { attributes } : {}),
      };
  }
}

export function createNoopTelemetryPort(providerKind = "noop_telemetry"): TelemetryPort {
  return {
    capabilities: {
      contractVersion: TELEMETRY_CONTRACT_VERSION,
      providerKind,
      supportsSpans: true,
      supportsMetrics: true,
      supportsLogs: true,
      supportsErrors: true,
      maxBatchSize: 100,
      requiresCredentials: false,
    },
    record(): void {},
    async flush(): Promise<TelemetryFlushResult> {
      return { kind: "noop", accepted: 0, dropped: 0 };
    },
    async shutdown(): Promise<void> {},
  };
}

/**
 * Passive fail-open wrapper: scrubs every event on ingress, bounds memory via maxBatchSize,
 * and guarantees record() / flush() / shutdown() never throw into application flows.
 */
export function createSafeTelemetryPort(input: {
  readonly capabilities: TelemetryCapabilities;
  readonly enabled?: boolean;
  readonly exportBatch: (
    events: readonly TelemetryEvent[],
    signal?: AbortSignal,
  ) => Promise<TelemetryFlushResult>;
}): TelemetryPort {
  const enabled = input.enabled ?? true;
  const rawMax = input.capabilities.maxBatchSize;
  const maxBatch =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.min(Math.floor(rawMax), 10_000)
      : 100;
  const queue: TelemetryEvent[] = [];
  let droppedSinceFlush = 0;

  async function flush(signal?: AbortSignal): Promise<TelemetryFlushResult> {
    if (!enabled || queue.length === 0) {
      droppedSinceFlush = 0;
      return { kind: "noop", accepted: 0, dropped: 0 };
    }
    const batch = queue.splice(0, queue.length);
    const preDropped = droppedSinceFlush;
    droppedSinceFlush = 0;
    try {
      const res = await input.exportBatch(batch, signal);
      if (res.kind === "flushed") {
        return { kind: "flushed", accepted: res.accepted, dropped: res.dropped + preDropped };
      }
      if (res.kind === "failed") {
        return { ...res, dropped: res.dropped + preDropped };
      }
      return res;
    } catch {
      return {
        kind: "failed",
        accepted: 0,
        dropped: batch.length + preDropped,
        retryable: true,
        diagnosticCode: "TELEMETRY_EXPORT_THREW",
      };
    }
  }

  return {
    capabilities: input.capabilities,
    record(event: TelemetryEvent): void {
      if (!enabled) return;
      try {
        const scrubbed = scrubTelemetryEvent(event);
        if (queue.length >= maxBatch) {
          queue.shift();
          droppedSinceFlush += 1;
        }
        queue.push(scrubbed);
      } catch {
        droppedSinceFlush += 1;
      }
    },
    flush,
    async shutdown(signal?: AbortSignal): Promise<void> {
      try {
        await flush(signal);
      } catch {
        // Passive fail-open shutdown.
      }
    },
  };
}
