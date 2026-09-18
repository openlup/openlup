import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerEligibilityLookupRequestSchema,
  customerEligibilityLookupResponseSchema,
  type CustomerEligibilityLookupRequest,
  type CustomerEligibilityLookupResponse,
} from "./customerEligibilityContracts";

/**
 * Look up early customer recognition + first-order eligibility by email.
 * See {@link CustomerEligibilityLookupResponse} for the (PII-free) shape.
 */
export function lookupCustomerEligibility(
  request: CustomerEligibilityLookupRequest,
  options: BffRequestOptions = {},
): Promise<CustomerEligibilityLookupResponse> {
  return requestBff(
    "/api/bff/commerce/customer-eligibility",
    customerEligibilityLookupResponseSchema,
    {
      ...options,
      method: "POST",
      body: customerEligibilityLookupRequestSchema.parse(request),
    },
  );
}
