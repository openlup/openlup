import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerDeliveryPreferencesResponseSchema,
  customerDeliveryPreferenceUpsertRequestSchema,
  customerDeliveryPreferenceUpsertResponseSchema,
  customerPaymentPreferencesResponseSchema,
  customerPaymentPreferenceUpsertRequestSchema,
  customerPaymentPreferenceUpsertResponseSchema,
  type CustomerDeliveryPreferencesResponse,
  type CustomerDeliveryPreferenceUpsertRequest,
  type CustomerDeliveryPreferenceUpsertResponse,
  type CustomerPaymentPreferencesResponse,
  type CustomerPaymentPreferenceUpsertRequest,
  type CustomerPaymentPreferenceUpsertResponse,
} from "./contracts";

const PATH = "/api/bff/customers/preferences";
const DELIVERY_PATH = "/api/bff/customers/delivery-preferences";

export function getCustomerPaymentPreferences(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<CustomerPaymentPreferencesResponse> {
  const headers = withBearer(options.headers, accessToken);

  return requestBff(PATH, customerPaymentPreferencesResponseSchema, {
    ...options,
    method: "GET",
    headers,
  });
}

export function upsertCustomerPaymentPreference(
  accessToken: string,
  body: CustomerPaymentPreferenceUpsertRequest,
  options: BffRequestOptions = {},
): Promise<CustomerPaymentPreferenceUpsertResponse> {
  const headers = withBearer(options.headers, accessToken);

  return requestBff(PATH, customerPaymentPreferenceUpsertResponseSchema, {
    ...options,
    method: "PATCH",
    headers,
    body: customerPaymentPreferenceUpsertRequestSchema.parse(body),
  });
}

export function getCustomerDeliveryPreferences(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<CustomerDeliveryPreferencesResponse> {
  const headers = withBearer(options.headers, accessToken);

  return requestBff(DELIVERY_PATH, customerDeliveryPreferencesResponseSchema, {
    ...options,
    method: "GET",
    headers,
  });
}

export function upsertCustomerDeliveryPreference(
  accessToken: string,
  body: CustomerDeliveryPreferenceUpsertRequest,
  options: BffRequestOptions = {},
): Promise<CustomerDeliveryPreferenceUpsertResponse> {
  const headers = withBearer(options.headers, accessToken);

  return requestBff(DELIVERY_PATH, customerDeliveryPreferenceUpsertResponseSchema, {
    ...options,
    method: "PATCH",
    headers,
    body: customerDeliveryPreferenceUpsertRequestSchema.parse(body),
  });
}

function withBearer(init: HeadersInit | undefined, accessToken: string): Headers {
  const headers = new Headers(init);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
