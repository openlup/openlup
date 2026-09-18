export type SoakCaseKind = "fast-read" | "read" | "dynamic-post";

export type SoakCase = {
  name: string;
  method: "GET" | "POST";
  path: string;
  kind: SoakCaseKind;
  expectedStatuses: number[];
  body?: unknown;
};

export type SoakSample = {
  caseName: string;
  kind: SoakCaseKind;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ok: boolean;
  unexpected4xx: boolean;
  fiveXx: boolean;
};

export type SoakConfig = {
  baseUrl: string;
  durationSeconds: number;
  concurrency: number;
  timeoutMs: number;
  artifactPath: string;
  enforceThresholds: boolean;
  thresholds: {
    fastReadP95Ms: number;
    dynamicPostP95Ms: number;
    dynamicPostP99Ms: number;
    rssPeakBytes: number;
  };
};

export type MemoryCpuSnapshot = {
  cpuUserMicros: number;
  cpuSystemMicros: number;
  rssBytes: number;
  rssPeakBytes: number;
};

export const DEFAULT_SOAK_ARTIFACT_PATH = "test-results/local-soak/summary.json";

export function parseSoakConfig(env: NodeJS.ProcessEnv = process.env): SoakConfig {
  const baseUrl = env.LOCAL_SOAK_BASE_URL ?? env.SOAK_BASE_URL ?? "";
  if (!baseUrl) throw new Error("LOCAL_SOAK_BASE_URL is required");
  const parsedBase = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBase.protocol)) {
    throw new Error("LOCAL_SOAK_BASE_URL must be http or https");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(parsedBase.hostname)) {
    throw new Error(`Refusing local soak against non-local host ${parsedBase.hostname}`);
  }

  return {
    baseUrl: parsedBase.origin,
    durationSeconds: readPositiveInt(env.SOAK_DURATION_SECONDS, 300, "SOAK_DURATION_SECONDS"),
    concurrency: readPositiveInt(env.SOAK_CONCURRENCY, 8, "SOAK_CONCURRENCY"),
    timeoutMs: readPositiveInt(env.SOAK_REQUEST_TIMEOUT_MS, 15_000, "SOAK_REQUEST_TIMEOUT_MS"),
    artifactPath: env.SOAK_ARTIFACT_PATH ?? DEFAULT_SOAK_ARTIFACT_PATH,
    enforceThresholds: env.SOAK_ENFORCE_THRESHOLDS !== "0",
    thresholds: {
      fastReadP95Ms: readPositiveInt(env.SOAK_FAST_READ_P95_MS, 150, "SOAK_FAST_READ_P95_MS"),
      dynamicPostP95Ms: readPositiveInt(env.SOAK_DYNAMIC_POST_P95_MS, 750, "SOAK_DYNAMIC_POST_P95_MS"),
      dynamicPostP99Ms: readPositiveInt(env.SOAK_DYNAMIC_POST_P99_MS, 1_500, "SOAK_DYNAMIC_POST_P99_MS"),
      rssPeakBytes: readPositiveInt(env.SOAK_RSS_PEAK_MB, 1_536, "SOAK_RSS_PEAK_MB") * 1024 * 1024,
    },
  };
}

export function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function buildRecommendationRequest() {
  return {
    petProfile: {
      ageBand: "adult",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: [],
      dailyKcalOverride: 328,
    },
    selectedFlavorSlugs: ["lamb"],
    desiredSizeKind: "feeding_days",
    cadenceDays: 21,
    consciousAllergenOverride: false,
  };
}

export function buildQuoteRequest(recommendation: { lines?: Array<{ variantId: string; sku: string; qty: number }> }) {
  const lines = recommendation.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("Cannot build quote request without recommendation lines");
  }
  return {
    mode: "one_time",
    lines: lines.map((line) => ({
      variantId: line.variantId,
      sku: line.sku,
      quantity: line.qty,
      modeAtLine: "one_time",
    })),
    sizeConstraint: { kind: "feeding_days", value: 21, dailyKcalOverride: 328 },
    petProfileContext: {
      ageBand: "adult",
      breed: "labrador",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: [],
      dailyKcalOverride: 328,
    },
    locale: "pl",
    visitorId: "local-soak",
  };
}

export const CONFIGURATOR_OFFER_POLICY_V2_CAPABILITY = "commerce.offer-policy.v2";

export function buildConfiguratorQuoteRequest(
  recommendation: { lines?: Array<{ variantId: string; sku: string; qty: number }> },
) {
  return {
    ...buildQuoteRequest(recommendation),
    visitorId: "hidden-preview-email-matrix",
    pricingPolicy: { capability: CONFIGURATOR_OFFER_POLICY_V2_CAPABILITY },
  };
}

export function buildSoakCases(input: {
  productSlug: string;
  recommendation: { lines?: Array<{ variantId: string; sku: string; qty: number }> };
}): SoakCase[] {
  return [
    { name: "health", method: "GET", path: "/api/bff/health", kind: "fast-read", expectedStatuses: [200] },
    { name: "catalog-products", method: "GET", path: "/api/bff/catalog/products", kind: "fast-read", expectedStatuses: [200] },
    { name: "product-detail", method: "GET", path: `/api/bff/catalog/products/${input.productSlug}`, kind: "read", expectedStatuses: [200] },
    {
      name: "product-compatibility",
      method: "POST",
      path: "/api/bff/commerce/product-compatibility",
      kind: "dynamic-post",
      expectedStatuses: [200],
      body: { allergenSlugs: [] },
    },
    {
      name: "recommendation",
      method: "POST",
      path: "/api/bff/commerce/recommendation",
      kind: "dynamic-post",
      expectedStatuses: [200],
      body: buildRecommendationRequest(),
    },
    {
      name: "quote",
      method: "POST",
      path: "/api/bff/commerce/quote",
      kind: "dynamic-post",
      expectedStatuses: [200],
      body: buildQuoteRequest(input.recommendation),
    },
  ];
}

export function classifyStatus(status: number, expectedStatuses: number[]): Pick<SoakSample, "ok" | "unexpected4xx" | "fiveXx"> {
  const ok = expectedStatuses.includes(status);
  return {
    ok,
    unexpected4xx: !ok && status >= 400 && status < 500,
    fiveXx: status >= 500,
  };
}

export function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}
