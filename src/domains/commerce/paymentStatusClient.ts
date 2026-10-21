import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import { PAYMENT_FAILURE_DISPLAY_HEADER } from "./paymentFailureDisplayContracts";
import {
  paymentStatusResponseSchema,
  type PaymentStatusRequest,
  type PaymentStatusResponse,
} from "./checkoutContracts";

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
