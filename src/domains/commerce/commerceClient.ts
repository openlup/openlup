import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import { PAYMENT_FAILURE_DISPLAY_HEADER } from "./paymentFailureDisplayContracts";
import { z } from "../../lib/validation/zod.js";
import {
  createOrderDraftResponseSchema,
  publicCreateQuoteBatchResponseSchema,
  publicCreateQuoteResponseSchema,
  type CreateOrderDraftRequest,
  type CreateOrderDraftResponse,
  type CreateQuoteBatchRequestInput,
  type CreateQuoteBatchResponse,
  type CreateQuoteRequestInput,
  type PublicCreateQuoteRequestInput,
  type PublicCreateQuoteResponse,
} from "./contracts";
import {
  commerceOfferPricingResponseSchema,
  type CommerceOfferPricingResponse,
} from "./offerPricingContracts";
import {
  configuratorOfferLayoutResponseSchema,
  type ConfiguratorOfferLayoutResponse,
} from "./offerLayoutContracts";
import {
  configuratorIntentPersistenceResponseSchema,
  type ConfiguratorIntentPersistenceRequest,
  type ConfiguratorIntentPersistenceResponse,
} from "./configuratorIntentPersistenceContracts";
import {
  stockNotifyResponseSchema,
  type StockNotifyRequest,
  type StockNotifyResponse,
} from "./stockNotifyContracts";
import {
  commerceRecommendationBatchResponseSchema,
  commerceRecommendationResponseSchema,
  type CommerceRecommendationBatchRequest,
  type CommerceRecommendationBatchResponse,
  type CommerceRecommendationRequest,
  type CommerceRecommendationResponse,
} from "./recommendationContracts";
import {
  commerceProductCompatibilityResponseSchema,
  type CommerceProductCompatibilityRequest,
  type CommerceProductCompatibilityResponse,
} from "./productCompatibilityContracts";
import {
  checkoutResponseSchema,
  paymentStatusResponseSchema,
  type CheckoutRequest,
  type CheckoutResponse,
  type PaymentStatusRequest,
  type PaymentStatusResponse,
} from "./checkoutContracts";
import {
  ORDER_RECAP_V2_CONTRACT_VERSION,
  ORDER_RECAP_V3_CONTRACT_VERSION,
  ORDER_RECAP_V4_CONTRACT_VERSION,
  orderRecapResponseSchema,
  orderRecapV3ResponseSchema,
  orderRecapV4ResponseSchema,
  type OrderRecapRequest,
  type OrderRecapResponse,
  type OrderRecapV3Response,
  type OrderRecapV4Response,
} from "./orderRecapContracts";
import {
  tpayPaymentChannelsResponseSchema,
  type TpayPaymentChannelsResponse,
} from "./tpayChannelsContracts";

export function submitCheckout(
  request: CheckoutRequest,
  options: BffRequestOptions = {},
): Promise<CheckoutResponse> {
  return requestBff("/api/bff/commerce/checkout", checkoutResponseSchema, {
    timeoutMs: 25_000,
    ...options,
    method: "POST",
    body: request,
  });
}

export function getCommercePaymentStatus(
  request: PaymentStatusRequest,
  options: BffRequestOptions = {},
): Promise<PaymentStatusResponse> {
  const headers = new Headers(options.headers);
  headers.set(PAYMENT_FAILURE_DISPLAY_HEADER, "1");
  return requestBff(
    `/api/bff/commerce/payment-status?${new URLSearchParams(request).toString()}`,
    paymentStatusResponseSchema,
    {
      ...options,
      method: "GET",
      headers,
    },
  );
}

export function getCommerceOrderRecap(
  request: OrderRecapRequest & { contractVersion: typeof ORDER_RECAP_V3_CONTRACT_VERSION },
  options?: BffRequestOptions,
): Promise<OrderRecapV3Response>;
export function getCommerceOrderRecap(
  request: OrderRecapRequest & { contractVersion: typeof ORDER_RECAP_V4_CONTRACT_VERSION },
  options?: BffRequestOptions,
): Promise<OrderRecapV4Response>;
export function getCommerceOrderRecap(
  request: Omit<OrderRecapRequest, "contractVersion"> & {
    contractVersion?: typeof ORDER_RECAP_V2_CONTRACT_VERSION;
  },
  options?: BffRequestOptions,
): Promise<OrderRecapResponse>;
export function getCommerceOrderRecap(
  request: OrderRecapRequest,
  options: BffRequestOptions = {},
): Promise<OrderRecapResponse | OrderRecapV3Response | OrderRecapV4Response> {
  const params = new URLSearchParams({
    orderId: request.orderId,
    clientId: request.clientId,
  });
  if (request.contractVersion) {
    params.set("contractVersion", request.contractVersion);
  }
  const url = `/api/bff/commerce/order-recap?${params.toString()}`;
  if (request.contractVersion === ORDER_RECAP_V3_CONTRACT_VERSION) {
    return requestBff(url, orderRecapV3ResponseSchema, {
      ...options,
      method: "GET",
    });
  }
  if (request.contractVersion === ORDER_RECAP_V4_CONTRACT_VERSION) {
    return requestBff(url, orderRecapV4ResponseSchema, {
      ...options,
      method: "GET",
    });
  }
  return requestBff(url, orderRecapResponseSchema, {
    ...options,
    method: "GET",
  });
}

export function getTpayPaymentChannels(
  options: BffRequestOptions = {},
): Promise<TpayPaymentChannelsResponse> {
  return requestBff(
    "/api/bff/commerce/tpay-channels",
    tpayPaymentChannelsResponseSchema,
    {
      ...options,
      method: "GET",
    },
  );
}

const tpaySimulatorResultResponseSchema = z
  .object({
    provider: z.literal("tpay"),
    simulator: z.literal(true),
    providerPaymentId: z.string().trim().min(1),
    paymentEventId: z.string().trim().min(1),
    paymentIntentId: z.string().trim().min(1),
    resultStatus: z.enum(["succeeded", "failed", "expired"]),
    aliasResult: z.enum(["accepted", "rejected"]).nullable().optional(),
    methodRefReplayed: z.boolean().nullable().optional(),
    replayed: z.boolean(),
  })
  .strict();

export type TpaySimulatorResultStatus = "succeeded" | "failed" | "expired";
export type TpaySimulatorAliasResult = "accepted" | "rejected";

export function applyTpaySimulatorPaymentResult(
  request: {
    providerPaymentId: string;
    resultStatus: TpaySimulatorResultStatus;
    amountMinor?: number | null;
    aliasResult?: TpaySimulatorAliasResult | null;
    clientId?: string | null;
    subscriptionId?: string | null;
    providerMethodRef?: string | null;
  },
  options: BffRequestOptions = {},
): Promise<z.infer<typeof tpaySimulatorResultResponseSchema>> {
  return requestBff(
    "/api/bff/payment/webhooks/tpay-simulator",
    tpaySimulatorResultResponseSchema,
    {
      ...options,
      method: "POST",
      body: request,
    },
  );
}

export function persistConfiguratorIntent(
  request: ConfiguratorIntentPersistenceRequest,
  options: BffRequestOptions = {},
): Promise<ConfiguratorIntentPersistenceResponse> {
  return requestBff(
    "/api/bff/commerce/configurator-intent",
    configuratorIntentPersistenceResponseSchema,
    {
      ...options,
      method: "POST",
      body: request,
    },
  );
}

export function notifyWhenInStock(
  request: StockNotifyRequest,
  options: BffRequestOptions = {},
): Promise<StockNotifyResponse> {
  return requestBff("/api/bff/commerce/stock-notify", stockNotifyResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}

export function createCommerceRecommendation(
  request: CommerceRecommendationRequest,
  options: BffRequestOptions = {},
): Promise<CommerceRecommendationResponse> {
  return requestBff(
    "/api/bff/commerce/recommendation",
    commerceRecommendationResponseSchema,
    {
      ...options,
      method: "POST",
      body: request,
    },
  );
}

export function createCommerceRecommendationBatch(
  request: CommerceRecommendationBatchRequest,
  options: BffRequestOptions = {},
): Promise<CommerceRecommendationBatchResponse> {
  return requestBff(
    "/api/bff/commerce/recommendation-batch",
    commerceRecommendationBatchResponseSchema,
    {
      ...options,
      method: "POST",
      body: request,
    },
  );
}

export function getCommerceProductCompatibility(
  request: CommerceProductCompatibilityRequest,
  options: BffRequestOptions = {},
): Promise<CommerceProductCompatibilityResponse> {
  return requestBff(
    "/api/bff/commerce/product-compatibility",
    commerceProductCompatibilityResponseSchema,
    {
      ...options,
      method: "POST",
      body: request,
    },
  );
}

export function createCommerceQuote(
  request: PublicCreateQuoteRequestInput,
  options: BffRequestOptions = {},
): Promise<PublicCreateQuoteResponse> {
  return requestBff("/api/bff/commerce/quote", publicCreateQuoteResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}

export function createCommerceQuoteBatch(
  request: CreateQuoteBatchRequestInput,
  options: BffRequestOptions = {},
): Promise<CreateQuoteBatchResponse> {
  return requestBff("/api/bff/commerce/quote-batch", publicCreateQuoteBatchResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}

export function getCommerceOfferPricing(
  options: BffRequestOptions = {},
): Promise<CommerceOfferPricingResponse> {
  return requestBff(
    "/api/bff/commerce/offer-pricing",
    commerceOfferPricingResponseSchema,
    { ...options, method: "GET" },
  );
}

export function getConfiguratorOfferLayout(
  options: BffRequestOptions = {},
): Promise<ConfiguratorOfferLayoutResponse> {
  return requestBff(
    "/api/bff/commerce/offer-layout",
    configuratorOfferLayoutResponseSchema,
    // Bounded, unlike the other GETs here, because the package step WAITS on this
    // one rather than rendering around it: an unanswered request would hold the
    // offer behind a spinner indefinitely. This is the most droppable call in the
    // flow — it decides merchandising, and its failure path is already the
    // fail-safe default — so it gets the shortest leash. Caller may override.
    { timeoutMs: 4_000, ...options, method: "GET" },
  );
}

export function createCommerceOrderDraft(
  request: CreateOrderDraftRequest,
  options: BffRequestOptions = {},
): Promise<CreateOrderDraftResponse> {
  return requestBff("/api/bff/commerce/order-draft", createOrderDraftResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}
