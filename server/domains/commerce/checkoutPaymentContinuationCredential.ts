import { createCheckoutPaymentContinuationCodec as createCodec, mintPaymentContinuationOnFreshAction as mintFresh } from "@openlup/platform/commerce/server";
import type * as Core from "@openlup/platform/commerce/server";
const executionRails = ["stripe", "tpay"] as const;
type Rail = (typeof executionRails)[number];
export type CheckoutPaymentContinuationInput = Core.CheckoutPaymentContinuationInput<Rail>;
export type CheckoutPaymentContinuationClaims = Core.CheckoutPaymentContinuationClaims<Rail>;
export type CheckoutPaymentContinuationCodec = Core.CheckoutPaymentContinuationCodec<Rail>;
export type CheckoutPaymentContinuationMinter = Core.CheckoutPaymentContinuationMinter<Rail>;
export type { CheckoutCookieResponse } from "@openlup/platform/commerce/server";
export const CHECKOUT_PAYMENT_CONTINUATION_COOKIE = "__Host-openlup_checkout_continuation";
export function createCheckoutPaymentContinuationCodec(rootSecret: string | undefined, options: { now?: () => Date; ttlSeconds?: number } = {}) { return createCodec(rootSecret, { ...options, cookieName: CHECKOUT_PAYMENT_CONTINUATION_COOKIE, executionRails }); }
export function mintPaymentContinuationOnFreshAction(input: Parameters<typeof mintFresh<Rail>>[0]) { mintFresh(input, executionRails); }
