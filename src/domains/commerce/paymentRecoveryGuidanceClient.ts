import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import type { PaymentStatusContinuationRequest } from "./paymentContinuationContracts.js";
import { PAYMENT_FAILURE_DISPLAY_HEADER } from "./paymentFailureDisplayContracts.js";
import {
  PAYMENT_RECOVERY_GUIDANCE_HEADER, paymentRecoveryStatusResponseSchema,
  type PaymentRecoveryStatusResponse,
} from "./paymentRecoveryGuidanceContracts.js";

export function getPaymentRecoveryStatus(
  request: PaymentStatusContinuationRequest,
  options: BffRequestOptions & { recoveryToken?: string } = {},
): Promise<PaymentRecoveryStatusResponse> {
  const { recoveryToken, ...transport } = options;
  const headers = new Headers(transport.headers);
  headers.set(PAYMENT_FAILURE_DISPLAY_HEADER, "1");
  headers.set(PAYMENT_RECOVERY_GUIDANCE_HEADER, "1");
  if (recoveryToken) headers.set("Authorization", `Bearer ${recoveryToken}`);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request)) if (value !== undefined) query.set(key, value);
  return requestBff(`/api/bff/commerce/payment-status?${query}`, paymentRecoveryStatusResponseSchema,
    { ...transport, method: "GET", headers });
}
