import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  referenceCheckoutResponseSchema,
  type ReferenceCheckoutRequest,
  type ReferenceCheckoutResponse,
} from "./checkoutCommandContracts";

/** Submit the neutral local-reference checkout; server-only credentials and provider selection stay server-side. */
export function submitReferenceCheckout(request: ReferenceCheckoutRequest, options: BffRequestOptions = {}): Promise<ReferenceCheckoutResponse> {
  return requestBff("/api/bff/commerce/checkouts", referenceCheckoutResponseSchema, {
    timeoutMs: 25_000, ...options, method: "POST", body: request,
  });
}
