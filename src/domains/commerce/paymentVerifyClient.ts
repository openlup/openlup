import { z } from "@/lib/validation/zod";
import { requestBff, type BffRequestOptions } from "@/lib/bff/client";

/**
 * Buyer-triggered "verify now" for a payment attempt the browser just watched
 * fail client-side (a pre-charge provider rejection emits no webhook, so the
 * backend would otherwise stay `processing` until the reconciliation cron).
 * The server reads the live provider state and applies only terminal truth;
 * this client never sends an outcome. Separate module from `commerceClient`
 * (that file sits at the shrink-only 300-LOC cap).
 */

export const paymentVerifyResponseSchema = z
  .object({
    status: z.string(),
    verified: z.boolean(),
    applied: z.boolean(),
  })
  .passthrough();

export type PaymentVerifyResponse = z.infer<typeof paymentVerifyResponseSchema>;

export interface PaymentVerifyRequest {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
}

export function verifyCommercePaymentNow(
  request: PaymentVerifyRequest,
  options: BffRequestOptions = {},
): Promise<PaymentVerifyResponse> {
  return requestBff("/api/bff/commerce/payment-verify", paymentVerifyResponseSchema, {
    ...options,
    method: "POST",
    body: request,
  });
}

/**
 * Fire the verify and wait at most `timeoutMs` — navigation to the failure
 * page must never block on network health. Errors and timeouts resolve to
 * null; the reconciliation cron remains the safety net.
 */
export function verifyCommercePaymentNowBounded(
  request: PaymentVerifyRequest,
  timeoutMs = 2500,
): Promise<PaymentVerifyResponse | null> {
  return Promise.race([
    verifyCommercePaymentNow(request).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}
