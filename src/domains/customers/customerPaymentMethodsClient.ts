import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerPaymentMethodsResponseSchema,
  type CustomerPaymentMethodsResponse,
} from "./contracts";

const PATH = "/api/bff/customers/payment-methods";

export function getCustomerPaymentMethods(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<CustomerPaymentMethodsResponse> {
  return requestBff(PATH, customerPaymentMethodsResponseSchema, {
    ...options,
    method: "GET",
    headers: withBearer(options.headers, accessToken),
  });
}

function withBearer(init: HeadersInit | undefined, accessToken: string): Headers {
  const headers = new Headers(init);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
