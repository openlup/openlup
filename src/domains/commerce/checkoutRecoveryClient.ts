import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  checkoutRecoveryPayResponseSchema,
  checkoutRecoveryRedeemResponseSchema,
  checkoutRecoveryStartRequestSchema,
  checkoutRecoveryStartResponseSchema,
  type CheckoutRecoveryPayRequest,
  type CheckoutRecoveryPayResponse,
  type CheckoutRecoveryRedeemRequest,
  type CheckoutRecoveryRedeemResponse,
  type CheckoutRecoveryStartRequest,
  type CheckoutRecoveryStartResponse,
} from "./checkoutRecoveryContracts";
import {
  checkoutInlineRecoveryPayRequestSchema,
  checkoutInlineRecoveryPayResponseSchema,
  type CheckoutInlineRecoveryPayRequest,
  type CheckoutInlineRecoveryPayResponse,
} from "./checkoutInlineRecoveryContracts";

const REDEEM_PATH = "/api/bff/commerce/checkout-recovery/redeem";
const PAY_PATH = "/api/bff/commerce/checkout-recovery/pay";
const START_PATH = "/api/bff/customers/checkout-recovery/start";
const INLINE_PAY_PATH = "/api/bff/commerce/checkout-recovery/inline-pay";

/** Same-tab retry authenticated by the HttpOnly continuation cookie. */
export function payCheckoutInlineRecovery(
  request: CheckoutInlineRecoveryPayRequest,
  options: BffRequestOptions = {},
): Promise<CheckoutInlineRecoveryPayResponse> {
  return requestBff(INLINE_PAY_PATH, checkoutInlineRecoveryPayResponseSchema, {
    timeoutMs: 25_000,
    ...options,
    method: "POST",
    body: checkoutInlineRecoveryPayRequestSchema.parse(request),
  });
}

/**
 * Validate a recovery token and load the order summary for the pay page (W4).
 * Token-authenticated: no login header is sent (the token IS the credential).
 */
export function redeemCheckoutRecovery(
  request: CheckoutRecoveryRedeemRequest,
  options: BffRequestOptions = {},
): Promise<CheckoutRecoveryRedeemResponse> {
  return requestBff(REDEEM_PATH, checkoutRecoveryRedeemResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}

/**
 * Start a fresh payment attempt only after redeem resolved the order as
 * retryable. Active provider artifacts are resumed from redeem, never here.
 */
export function payCheckoutRecovery(
  request: CheckoutRecoveryPayRequest,
  options: BffRequestOptions = {},
): Promise<CheckoutRecoveryPayResponse> {
  return requestBff(PAY_PATH, checkoutRecoveryPayResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}

/**
 * In-account CTA (W5): mint a fresh recovery token for the logged-in customer's
 * own unpaid subscription order. Authed (sends the customer session bearer); the
 * raw token in the response deep-links into the same W4 pay-page.
 */
export function startCheckoutRecovery(
  accessToken: string,
  request: CheckoutRecoveryStartRequest,
  options: BffRequestOptions = {},
): Promise<CheckoutRecoveryStartResponse> {
  return requestBff(START_PATH, checkoutRecoveryStartResponseSchema, {
    ...options,
    method: "POST",
    headers: withBearer(options.headers, accessToken),
    body: checkoutRecoveryStartRequestSchema.parse(request),
  });
}

function withBearer(init: HeadersInit | undefined, accessToken: string): Headers {
  const headers = new Headers(init);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
