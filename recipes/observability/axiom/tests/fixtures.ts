import type { TelemetryEvent } from "@openlup/platform/observability/contracts";

export const FIXTURE_DATASET = "openlup.telemetry-sandbox_v1";
export const FIXTURE_SERVICE = "openlup-storefront-test";
export const FIXTURE_NOW_ISO = "2000-06-15T12:00:00.000Z";

// Programmatically joined to avoid static secret scanner false positives while verifying redaction & error isolation.
export const FIXTURE_CANARY_TOKEN = ["axiom", "canary", "marker", "alpha+01"].join("-");
export const FIXTURE_API_TOKEN = ["axiom-canary-marker", "alpha+01"].join("/");
export const FIXTURE_PII_EMAIL = "buyer-canary@example.invalid";

export const FIXTURE_SAMPLE_EVENTS: readonly TelemetryEvent[] = [
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
