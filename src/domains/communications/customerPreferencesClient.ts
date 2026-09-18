import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerCommunicationPreferencesResponseSchema,
  updateCustomerCommunicationPreferencesRequestSchema,
  type CustomerCommunicationPreferencesResponse,
  type UpdateCustomerCommunicationPreferencesRequest,
} from "./customerPreferencesContracts";

const PATH = "/api/bff/customers/communication-preferences";

export function getCustomerCommunicationPreferences(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<CustomerCommunicationPreferencesResponse> {
  return requestBff(PATH, customerCommunicationPreferencesResponseSchema, {
    ...options,
    method: "GET",
    headers: withBearer(options.headers, accessToken),
  });
}

export function updateCustomerCommunicationPreferences(
  accessToken: string,
  body: UpdateCustomerCommunicationPreferencesRequest,
  options: BffRequestOptions = {},
): Promise<CustomerCommunicationPreferencesResponse> {
  return requestBff(PATH, customerCommunicationPreferencesResponseSchema, {
    ...options,
    method: "PATCH",
    headers: withBearer(options.headers, accessToken),
    body: updateCustomerCommunicationPreferencesRequestSchema.parse(body),
  });
}

function withBearer(init: HeadersInit | undefined, accessToken: string): Headers {
  const headers = new Headers(init);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
