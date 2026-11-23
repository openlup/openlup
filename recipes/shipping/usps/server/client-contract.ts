import {
  USPS_OAUTH_ORIGINS,
  UspsOAuth2Error,
  parseRetryAfterSeconds,
  type FetchLike,
  type UspsEnvironment,
  type UspsOAuth2TokenManager,
} from "./oauth.js";

export const USPS_API_ORIGINS: Readonly<Record<UspsEnvironment, string>> = USPS_OAUTH_ORIGINS;

export const USPS_BASE_RATES_SEARCH_PATH = "/prices/v3/base-rates/search" as const;

export const USPS_BASE_RATES_SEARCH_URLS: Readonly<Record<UspsEnvironment, string>> = Object.freeze({
  production: `${USPS_API_ORIGINS.production}${USPS_BASE_RATES_SEARCH_PATH}`,
  tem: `${USPS_API_ORIGINS.tem}${USPS_BASE_RATES_SEARCH_PATH}`,
});

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

export type UspsPriceType = "RETAIL" | "COMMERCIAL" | "CONTRACT" | "NSA";

export type UspsProcessingCategory =
  | "MACHINABLE"
  | "NON_MACHINABLE"
  | "LETTERS"
  | "FLATS"
  | "IRREGULAR";

export type UspsDestinationEntryFacilityType =
  | "NONE"
  | "DESTINATION_NETWORK_DISTRIBUTION_CENTER"
  | "DESTINATION_SECTIONAL_CENTER_FACILITY"
  | "DESTINATION_DELIVERY_UNIT";

export interface UspsBaseRatesSearchRequest {
  readonly originZIPCode: string;
  readonly destinationZIPCode: string;
  readonly weight: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly mailClass?: string;
  readonly mailClasses?: readonly string[];
  readonly priceType?: UspsPriceType;
  readonly mailingDate?: string;
  readonly rateIndicator?: string;
  readonly processingCategory?: UspsProcessingCategory;
  readonly destinationEntryFacilityType?: UspsDestinationEntryFacilityType;
}

export interface UspsRateDetail {
  readonly description?: string;
  readonly productName?: string;
  readonly mailClass?: string;
  readonly priceType?: string;
  readonly rateIndicator?: string;
  readonly processingCategory?: string;
  readonly destinationEntryFacilityType?: string;
  readonly zone?: string;
  readonly price?: number | string;
  readonly totalBasePrice?: number | string;
  readonly SKU?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly estimatedDeliveryDays?: number | { readonly min?: number; readonly max?: number };
  readonly deliveryDateGuaranteed?: boolean;
}

export interface UspsRateOption {
  readonly totalBasePrice?: number | string;
  readonly mailClass?: string;
  readonly description?: string;
  readonly productName?: string;
  readonly SKU?: string;
  readonly estimatedDeliveryDays?: number | { readonly min?: number; readonly max?: number };
  readonly deliveryDateGuaranteed?: boolean;
  readonly endDate?: string;
  readonly rates?: readonly UspsRateDetail[];
}

export interface UspsBaseRatesResponse {
  readonly rateOptions?: readonly UspsRateOption[];
  readonly rates?: readonly UspsRateDetail[];
}

export interface UspsRateClient {
  searchBaseRates(
    input: UspsBaseRatesSearchRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<UspsBaseRatesResponse>;
}

export interface UspsHttpClientOptions {
  readonly tokenManager: UspsOAuth2TokenManager;
  readonly environment: UspsEnvironment;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class UspsTransportError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(params: {
    readonly code: string;
    readonly status: number | null;
    readonly retryable: boolean;
    readonly retryAfterSeconds?: number;
  }) {
    super(params.code);
    this.name = "UspsTransportError";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable;
    if (params.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = params.retryAfterSeconds;
    }
  }
}

export function resolvePinnedUspsOrigin(environment: UspsEnvironment): string {
  if (!Object.hasOwn(USPS_API_ORIGINS, environment)) {
    throw new UspsTransportError({
      code: "usps_unsupported_environment",
      status: null,
      retryable: false,
    });
  }
  return USPS_API_ORIGINS[environment];
}

async function cancelResponseBodySafely(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore cancellation failures on rejected responses.
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredBytes = Number(contentLengthHeader);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await cancelResponseBodySafely(response);
      throw new UspsTransportError({
        code: "usps_response_too_large",
        status: response.status,
        retryable: false,
      });
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let totalBytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new UspsTransportError({
              code: "usps_response_too_large",
              status: response.status,
              retryable: false,
            });
          }
          text += decoder.decode(value, { stream: true });
        }
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock();
    }
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new UspsTransportError({
      code: "usps_response_too_large",
      status: response.status,
      retryable: false,
    });
  }
  return text;
}

/**
 * Hardened zero-dependency USPS Domestic Prices v3 HTTP client.
 * Pinned strictly to `https://apis.usps.com/prices/v3/base-rates/search` or
 * `https://apis-tem.usps.com/prices/v3/base-rates/search` with `redirect: "error"`,
 * streaming 512 KiB byte cap, 401 token invalidation, 429 `Retry-After` parsing,
 * and zero credential/body leakage in thrown errors.
 */
export function createUspsHttpClient(options: UspsHttpClientOptions): UspsRateClient {
  const expectedOrigin = resolvePinnedUspsOrigin(options.environment);
  const pinnedUrl = new URL(USPS_BASE_RATES_SEARCH_URLS[options.environment]);
  if (
    pinnedUrl.protocol !== "https:" ||
    pinnedUrl.origin !== expectedOrigin ||
    pinnedUrl.pathname !== USPS_BASE_RATES_SEARCH_PATH ||
    pinnedUrl.username ||
    pinnedUrl.password
  ) {
    throw new UspsTransportError({
      code: "usps_origin_mismatch",
      status: null,
      retryable: false,
    });
  }

  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes !== undefined &&
    Number.isFinite(options.maxResponseBytes) &&
    options.maxResponseBytes > 0
      ? Math.floor(options.maxResponseBytes)
      : DEFAULT_MAX_RESPONSE_BYTES;

  return {
    async searchBaseRates(
      input: UspsBaseRatesSearchRequest,
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<UspsBaseRatesResponse> {
      const externalSignal = callOptions?.signal;
      if (externalSignal?.aborted) {
        throw new UspsTransportError({
          code: "usps_timeout",
          status: null,
          retryable: true,
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onExternalAbort = () => controller.abort();
      if (externalSignal) {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }

      try {
        const accessToken = await options.tokenManager.getAccessToken(controller.signal);
        const response = await options.fetchImpl(pinnedUrl.href, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(input),
          redirect: "error",
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 401) {
            options.tokenManager.invalidate();
          }
          const retryAfterSeconds =
            response.status === 429
              ? parseRetryAfterSeconds(response.headers.get("retry-after"), Date.now())
              : undefined;
          await cancelResponseBodySafely(response);
          if (response.status === 429) {
            throw new UspsTransportError({
              code: "usps_rate_limited",
              status: 429,
              retryable: true,
              retryAfterSeconds,
            });
          }
          throw new UspsTransportError({
            code: `usps_http_${response.status}`,
            status: response.status,
            retryable: response.status >= 500 && response.status <= 599,
          });
        }

        const rawText = await readBoundedResponseText(response, maxResponseBytes);
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          throw new UspsTransportError({
            code: "usps_malformed_response",
            status: response.status,
            retryable: false,
          });
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new UspsTransportError({
            code: "usps_malformed_response",
            status: response.status,
            retryable: false,
          });
        }

        return parsed as UspsBaseRatesResponse;
      } catch (error) {
        if (error instanceof UspsTransportError || error instanceof UspsOAuth2Error) {
          throw error;
        }
        const isTimeout =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        throw new UspsTransportError({
          code: isTimeout ? "usps_timeout" : "usps_transport_error",
          status: null,
          retryable: true,
        });
      } finally {
        clearTimeout(timer);
        if (externalSignal) {
          externalSignal.removeEventListener("abort", onExternalAbort);
        }
      }
    },
  };
}
