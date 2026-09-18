import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerPaymentMethodSetupRequestSchema,
  customerPaymentMethodSetupResponseSchema,
  type CustomerPaymentMethodSetupRequest,
  type CustomerPaymentMethodSetupResponse,
} from "./paymentMethodSetupContracts";

const PATH = "/api/bff/customers/payment-method/setup";

/**
 * Mints a Stripe SetupIntent for the logged-in customer to add/replace the card on one of
 * their subscriptions (CJ63-A). The FE confirms the card with the returned `clientSecret`;
 * the `setup_intent.succeeded` webhook then binds the new subscription-scoped method ref.
 */
export function startCustomerCardSetup(
  accessToken: string,
  body: CustomerPaymentMethodSetupRequest,
  options: BffRequestOptions = {},
): Promise<CustomerPaymentMethodSetupResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(PATH, customerPaymentMethodSetupResponseSchema, {
    ...options,
    method: "POST",
    headers,
    body: customerPaymentMethodSetupRequestSchema.parse(body),
  });
}
