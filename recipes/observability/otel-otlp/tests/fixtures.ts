import type { TelemetryEvent } from "@openlup/platform/observability/contracts";

export const FIXTURE_COLLECTOR_ORIGIN = "https://otel-collector.example.invalid";
export const FIXTURE_SERVICE = "openlup-storefront-test";
export const FIXTURE_NOW_ISO = "2000-06-15T12:00:00.000Z";

// Programmatically joined to avoid static secret scanner false positives while verifying redaction & error isolation.
export const FIXTURE_CANARY_TOKEN = ["otel", "canary", "marker", "alpha+01"].join("-");
export const FIXTURE_AUTH_SECRET = ["otel-canary-marker", "alpha+01"].join("/");
export const FIXTURE_AUTH_HEADER = ["Bearer", FIXTURE_AUTH_SECRET].join(" ");
export const FIXTURE_CUSTOM_HEADER_KEY = "x-otel-tenant-key";
export const FIXTURE_CUSTOM_HEADER_VAL = ["tenant", "canary", "marker", "01"].join("-");
export const FIXTURE_PII_EMAIL = "buyer-canary@example.invalid";

// Single-signal batch for runTelemetryAdapterConformance (ensures 1 HTTP call / ioDelta === 1 on happyFlush).
export const FIXTURE_CONFORMANCE_SPAN_EVENTS: readonly TelemetryEvent[] = [
  {
    kind: "span",
    name: "commerce.quote.create",
    startedAt: FIXTURE_NOW_ISO,
    durationMs: 14.5,
    status: "ok",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    attributes: {
      route: "/api/commerce/quote",
      cacheHit: false,
      lineCount: 2,
    },
  },
  {
    kind: "span",
    name: "commerce.quote.price_resolve",
    startedAt: FIXTURE_NOW_ISO,
    durationMs: 3.2,
    status: "ok",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "b7ad6b7169203331",
    attributes: {
      mode: "subscription",
    },
  },
];

// Multi-signal batch exercising /v1/traces, /v1/metrics, and /v1/logs.
export const FIXTURE_MULTI_SIGNAL_EVENTS: readonly TelemetryEvent[] = [
  FIXTURE_CONFORMANCE_SPAN_EVENTS[0]!,
  {
    kind: "metric",
    metricKind: "counter",
    name: "commerce.quote.completed",
    value: 1,
    unit: "1",
    timestamp: FIXTURE_NOW_ISO,
    attributes: {
      mode: "subscription",
    },
  },
  {
    kind: "metric",
    metricKind: "gauge",
    name: "commerce.cart.line_count",
    value: 2,
    unit: "1",
    timestamp: FIXTURE_NOW_ISO,
  },
  {
    kind: "log",
    severity: "info",
    message: "Quote calculated cleanly",
    timestamp: FIXTURE_NOW_ISO,
    attributes: {
      region: "ZZ",
    },
  },
  {
    kind: "error",
    code: "QUOTE_PROMO_IGNORED",
    message: "Optional promotion code ignored",
    timestamp: FIXTURE_NOW_ISO,
    attributes: {
      recoverable: true,
    },
  },
];
