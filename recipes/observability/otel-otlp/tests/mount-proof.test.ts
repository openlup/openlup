import { describe, expect, it } from "vitest";
import type { PricingResolverPort } from "@openlup/core/pricing";
import { createNoopTelemetryPort, type TelemetryPort } from "@openlup/platform/observability";
import {
  createDbBackedCommerceQuotePort,
  type CommerceQuoteCatalogItem,
  type CreateQuoteRequest,
} from "@openlup/platform/pricing";
import {
  createOtelOtlpHttpClient,
  createOtelOtlpTelemetryAdapter,
  type FetchLike,
  type OtlpExportMetricsServiceRequest,
  type OtlpExportTraceServiceRequest,
} from "../server/index.js";
import {
  FIXTURE_AUTH_HEADER,
  FIXTURE_AUTH_SECRET,
  FIXTURE_CANARY_TOKEN,
  FIXTURE_COLLECTOR_ORIGIN,
  FIXTURE_NOW_ISO,
  FIXTURE_PII_EMAIL,
  FIXTURE_SERVICE,
} from "./fixtures.js";

function createTestQuoteEngine() {
  const catalogItem: CommerceQuoteCatalogItem = {
    skuId: "sku-item-alpha-400",
    skuCode: "opaque:item-alpha.v1",
    variantId: "variant-item-alpha-400",
    productSlug: "item-alpha",
    netWeightG: 400,
    isPrimarySku: true,
    isAddon: false,
    sellability: { oneTime: true, subscription: true },
    documentRevision: { id: "doc-rev-1", digest: "digest-1" },
  };

  const pricingResolverPort: PricingResolverPort = {
    async resolvePrice(query) {
      return {
        variantId: query.variantId,
        mode: query.mode,
        matchedMinQty: 1,
        unitPriceMinor: query.mode === "subscription" ? 1340 : 1490,
        amountKind: "gross",
        priceListId: "pl-test-1",
        priceEntryId: "pe-test-1",
        resolvedAt: FIXTURE_NOW_ISO,
      };
    },
  };

  const taxProfile = {
    included: true as const,
    country: "ZZ",
    category: "example_category",
    vatRateBps: 800,
    legalBasis: "Example VAT rule",
  };

  return createDbBackedCommerceQuotePort({
    quoteCatalogReadPort: {
      listQuoteCatalogItems: async () => [catalogItem],
    },
    isStrictD1Quote: false,
    pricingResolverPort,
    taxProfile,
    supportedTaxProfiles: [taxProfile],
    regionCode: "ZZ",
    currency: "XXX",
    now: () => FIXTURE_NOW_ISO,
    hasPromotionCodePort: false,
    lineContext: () => ({}),
    quoteContext: (request) => () => ({
      mode: request.mode,
      cadenceDays: request.cadenceDays ?? null,
      promoCodes: request.promoCodes,
    }),
    resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: async () => ({
      discounts: [],
      codeRejections: [],
      codeRejectionDetails: [],
    }),
  });
}

async function executeObservedQuote(
  quoteEngine: ReturnType<typeof createTestQuoteEngine>,
  request: CreateQuoteRequest,
  telemetry: TelemetryPort,
) {
  const startedMs = Date.now();
  try {
    const response = await quoteEngine.createQuote(request);
    telemetry.record({
      kind: "span",
      name: "commerce.quote.create",
      startedAt: FIXTURE_NOW_ISO,
      durationMs: Math.max(0, Date.now() - startedMs),
      status: "ok",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      attributes: {
        mode: request.mode,
        lineCount: response.quote.lines.length,
        customer_email: FIXTURE_PII_EMAIL,
        authorization: `Bearer ${FIXTURE_CANARY_TOKEN}`,
      },
    });
    telemetry.record({
      kind: "metric",
      metricKind: "histogram",
      name: "commerce.quote.payable_minor",
      value: response.quote.totalGross.amountMinor,
      unit: "minor",
      timestamp: FIXTURE_NOW_ISO,
      attributes: {
        currency: response.quote.currency,
      },
    });
    const flushResult = await telemetry.flush();
    return { response, flushResult };
  } catch (err) {
    telemetry.record({
      kind: "error",
      code: "COMMERCE_QUOTE_ERROR",
      message: err instanceof Error ? err.message : "unknown_error",
      timestamp: FIXTURE_NOW_ISO,
    });
    await telemetry.flush();
    throw err;
  }
}

describe("recipes/observability/otel-otlp — Stage 3 real-flow mount proof", () => {
  const quoteRequest: CreateQuoteRequest = {
    mode: "subscription",
    cadenceDays: 21,
    promoCodes: [],
    lines: [{ sku: "opaque:item-alpha.v1", quantity: 2 }],
  };

  it("(a) records & flushes scrubbed OTLP spans and metrics around @openlup/platform/pricing without altering quote truth", async () => {
    const quoteEngine = createTestQuoteEngine();
    const baseline = await quoteEngine.createQuote(quoteRequest);

    const capturedByPath = new Map<string, unknown>();
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(FIXTURE_COLLECTOR_ORIGIN);
      capturedByPath.set(url.pathname, JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const telemetry = createOtelOtlpTelemetryAdapter({
      client: createOtelOtlpHttpClient({
        collectorOrigin: FIXTURE_COLLECTOR_ORIGIN,
        authorization: FIXTURE_AUTH_HEADER,
        fetchImpl,
      }),
      service: FIXTURE_SERVICE,
    });

    const observed = await executeObservedQuote(quoteEngine, quoteRequest, telemetry);
    expect(observed.response).toEqual(baseline);
    expect(observed.flushResult).toEqual({ kind: "flushed", accepted: 2, dropped: 0 });

    const traceReq = capturedByPath.get("/v1/traces") as OtlpExportTraceServiceRequest;
    const metricReq = capturedByPath.get("/v1/metrics") as OtlpExportMetricsServiceRequest;
    expect(traceReq.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);
    expect(metricReq.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.histogram?.dataPoints[0]!.sum).toBe(
      baseline.quote.totalGross.amountMinor,
    );

    const serializedAll = JSON.stringify([...capturedByPath.values()]);
    expect(serializedAll).not.toContain(FIXTURE_PII_EMAIL);
    expect(serializedAll).not.toContain(FIXTURE_CANARY_TOKEN);
    expect(serializedAll).not.toContain(FIXTURE_AUTH_SECRET);
  });

  it("(b) collector 503 outage and timeout fail open and never break the quote application flow", async () => {
    const quoteEngine = createTestQuoteEngine();
    const baseline = await quoteEngine.createQuote(quoteRequest);

    const outagePort = createOtelOtlpTelemetryAdapter({
      client: createOtelOtlpHttpClient({
        collectorOrigin: FIXTURE_COLLECTOR_ORIGIN,
        fetchImpl: async () => new Response("collector unavailable", { status: 503 }),
      }),
      service: FIXTURE_SERVICE,
    });

    const outageResult = await executeObservedQuote(quoteEngine, quoteRequest, outagePort);
    expect(outageResult.response).toEqual(baseline);
    expect(outageResult.flushResult).toEqual({
      kind: "failed",
      accepted: 0,
      dropped: 2,
      retryable: true,
      diagnosticCode: "OTEL_OTLP_SERVER_ERROR",
    });

    const timeoutPort = createOtelOtlpTelemetryAdapter({
      client: createOtelOtlpHttpClient({
        collectorOrigin: FIXTURE_COLLECTOR_ORIGIN,
        fetchImpl: async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      }),
      service: FIXTURE_SERVICE,
    });

    const timeoutResult = await executeObservedQuote(quoteEngine, quoteRequest, timeoutPort);
    expect(timeoutResult.response).toEqual(baseline);
    expect(timeoutResult.flushResult).toEqual({
      kind: "failed",
      accepted: 0,
      dropped: 2,
      retryable: true,
      diagnosticCode: "OTEL_OTLP_TIMEOUT",
    });
  });

  it("(c) negative control: detaching the OTLP telemetry sink drops captured telemetry to 0", async () => {
    const quoteEngine = createTestQuoteEngine();
    let httpCalls = 0;

    const disabledOtlpPort = createOtelOtlpTelemetryAdapter({
      client: createOtelOtlpHttpClient({
        collectorOrigin: FIXTURE_COLLECTOR_ORIGIN,
        fetchImpl: async () => {
          httpCalls += 1;
          return new Response(JSON.stringify({}), { status: 200 });
        },
      }),
      service: FIXTURE_SERVICE,
      enabled: false,
    });

    const disabledOut = await executeObservedQuote(quoteEngine, quoteRequest, disabledOtlpPort);
    expect(disabledOut.flushResult).toEqual({ kind: "noop", accepted: 0, dropped: 0 });
    expect(httpCalls).toBe(0);

    const detachedOut = await executeObservedQuote(
      quoteEngine,
      quoteRequest,
      createNoopTelemetryPort(),
    );
    expect(detachedOut.flushResult).toEqual({ kind: "noop", accepted: 0, dropped: 0 });
    expect(httpCalls).toBe(0);
  });
});
