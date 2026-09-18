import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerAddressesResponseSchema,
  type CustomerAddressesResponse,
} from "./contracts";
import {
  customerAddressDeleteRequestSchema,
  customerAddressUpsertRequestSchema,
  customerPetCreateRequestSchema,
  customerPetDeleteRequestSchema,
  customerPetMutationResponseSchema,
  customerPetsResponseSchema,
  customerPetUpdateRequestSchema,
  customerProfileUpdateRequestSchema,
  customerProfileUpdateResponseSchema,
  customerSubscriptionActionResponseSchema,
  customerSubscriptionActionSchema,
  type CustomerAddressDeleteRequest,
  type CustomerAddressUpsertRequest,
  type CustomerPetCreateRequest,
  type CustomerPetDeleteRequest,
  type CustomerPetMutationResponse,
  type CustomerPetsResponse,
  type CustomerPetUpdateRequest,
  type CustomerProfileUpdateRequest,
  type CustomerProfileUpdateResponse,
  type CustomerSubscriptionActionRequest,
  type CustomerSubscriptionActionResponse,
} from "./selfServiceContracts";
import {
  customerAccountV2ResponseSchema,
  customerBillingProfileDeleteRequestSchema,
  customerBillingProfilesResponseSchema,
  customerBillingProfileUpsertRequestSchema,
  customerInvoiceCorrectionRequestSchema,
  customerInvoiceCorrectionResponseSchema,
  customerOrderDetailResponseSchema,
  customerOrdersListResponseSchema,
  type CustomerAccountV2Response,
  type CustomerBillingProfileDeleteRequest,
  type CustomerBillingProfilesResponse,
  type CustomerBillingProfileUpsertRequest,
  type CustomerInvoiceCorrectionRequest,
  type CustomerInvoiceCorrectionResponse,
  type CustomerInvoiceDownloadArtifact,
  type CustomerOrderDetailResponse,
  type CustomerOrdersListResponse,
} from "./accountV2Contracts";
import {
  customerPaymentRecoveryStartRequestSchema,
  customerPaymentRecoveryStartResponseSchema,
  customerSubscriptionPreviewRequestSchema,
  customerSubscriptionPreviewResponseSchema,
  type CustomerPaymentRecoveryStartRequest,
  type CustomerPaymentRecoveryStartResponse,
  type CustomerSubscriptionPreviewRequest,
  type CustomerSubscriptionPreviewResponse,
} from "./subscriptionFacadeContracts";

const ACCOUNT_PATH = "/api/bff/customers/account";
const PROFILE_PATH = "/api/bff/customers/profile";
const PETS_PATH = "/api/bff/customers/pets";
const ADDRESSES_PATH = "/api/bff/customers/addresses";
const SUBSCRIPTION_ACTION_PATH = "/api/bff/customers/subscriptions/action";
const BILLING_PROFILES_PATH = "/api/bff/customers/billing-profiles";
const ORDERS_PATH = "/api/bff/customers/orders";
const ORDER_DETAIL_PATH = "/api/bff/customers/orders/detail";
const INVOICE_CORRECTION_PATH = "/api/bff/customers/invoices/correction-request";
const INVOICE_DOWNLOAD_PATH = "/api/bff/customers/invoices/download";
const SUBSCRIPTION_PREVIEW_PATH = "/api/bff/customers/subscriptions/preview";
const PAYMENT_RECOVERY_START_PATH = "/api/bff/customers/payment-recovery/start";

export function getCustomerAccount(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<CustomerAccountV2Response> {
  return requestBff(ACCOUNT_PATH, customerAccountV2ResponseSchema, {
    ...options,
    method: "GET",
    headers: withBearer(options.headers, accessToken),
  });
}

export function upsertCustomerBillingProfile(
  accessToken: string,
  body: CustomerBillingProfileUpsertRequest,
  options: BffRequestOptions = {},
): Promise<CustomerBillingProfilesResponse> {
  return requestBff(BILLING_PROFILES_PATH, customerBillingProfilesResponseSchema, {
    ...options,
    method: body.profileId ? "PATCH" : "POST",
    headers: withBearer(options.headers, accessToken),
    body: customerBillingProfileUpsertRequestSchema.parse(body),
  });
}

export function deleteCustomerBillingProfile(
  accessToken: string,
  body: CustomerBillingProfileDeleteRequest,
  options: BffRequestOptions = {},
): Promise<CustomerBillingProfilesResponse> {
  return requestBff(BILLING_PROFILES_PATH, customerBillingProfilesResponseSchema, {
    ...options,
    method: "DELETE",
    headers: withBearer(options.headers, accessToken),
    body: customerBillingProfileDeleteRequestSchema.parse(body),
  });
}

export function listCustomerOrders(
  accessToken: string,
  options: BffRequestOptions & { limit?: number } = {},
): Promise<CustomerOrdersListResponse> {
  const { limit, ...requestOptions } = options;
  const url = limit ? `${ORDERS_PATH}?limit=${encodeURIComponent(limit)}` : ORDERS_PATH;
  return requestBff(url, customerOrdersListResponseSchema, {
    ...requestOptions,
    method: "GET",
    headers: withBearer(requestOptions.headers, accessToken),
  });
}

export function getCustomerOrderDetail(
  accessToken: string,
  orderId: string,
  options: BffRequestOptions = {},
): Promise<CustomerOrderDetailResponse> {
  return requestBff(`${ORDER_DETAIL_PATH}?orderId=${encodeURIComponent(orderId)}`, customerOrderDetailResponseSchema, {
    ...options,
    method: "GET",
    headers: withBearer(options.headers, accessToken),
  });
}

export function requestCustomerInvoiceCorrection(
  accessToken: string,
  body: CustomerInvoiceCorrectionRequest,
  options: BffRequestOptions = {},
): Promise<CustomerInvoiceCorrectionResponse> {
  return requestBff(INVOICE_CORRECTION_PATH, customerInvoiceCorrectionResponseSchema, {
    ...options,
    method: "POST",
    headers: withBearer(options.headers, accessToken),
    body: customerInvoiceCorrectionRequestSchema.parse(body),
  });
}

export async function downloadCustomerInvoicePdf(
  accessToken: string,
  invoiceId: string,
  options: BffRequestOptions = {},
  artifact: CustomerInvoiceDownloadArtifact = "invoice",
): Promise<Blob> {
  const { fetcher = fetch, headers: initHeaders, body: _body, ...init } = options;
  const params = new URLSearchParams({ invoiceId });
  if (artifact === "correction") params.set("artifact", artifact);
  const response = await fetcher(`${INVOICE_DOWNLOAD_PATH}?${params.toString()}`, {
    ...init,
    method: "GET",
    headers: withBearer(initHeaders, accessToken),
  });
  if (!response.ok) throw new Error("customer_invoice_download_failed");
  return response.blob();
}

export function updateCustomerProfile(
  accessToken: string,
  body: CustomerProfileUpdateRequest,
  options: BffRequestOptions = {},
): Promise<CustomerProfileUpdateResponse> {
  return requestBff(PROFILE_PATH, customerProfileUpdateResponseSchema, {
    ...options,
    method: "PATCH",
    headers: withBearer(options.headers, accessToken),
    body: customerProfileUpdateRequestSchema.parse(body),
  });
}

export function listCustomerPets(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<CustomerPetsResponse> {
  return requestBff(PETS_PATH, customerPetsResponseSchema, {
    ...options,
    method: "GET",
    headers: withBearer(options.headers, accessToken),
  });
}

export function createCustomerPet(
  accessToken: string,
  body: CustomerPetCreateRequest,
  options: BffRequestOptions = {},
): Promise<CustomerPetMutationResponse> {
  return requestBff(PETS_PATH, customerPetMutationResponseSchema, {
    ...options,
    method: "POST",
    headers: withBearer(options.headers, accessToken),
    body: customerPetCreateRequestSchema.parse(body),
  });
}

export function updateCustomerPet(
  accessToken: string,
  body: CustomerPetUpdateRequest,
  options: BffRequestOptions = {},
): Promise<CustomerPetMutationResponse> {
  return requestBff(PETS_PATH, customerPetMutationResponseSchema, {
    ...options,
    method: "PATCH",
    headers: withBearer(options.headers, accessToken),
    body: customerPetUpdateRequestSchema.parse(body),
  });
}

export function removeCustomerPet(
  accessToken: string,
  body: CustomerPetDeleteRequest,
  options: BffRequestOptions = {},
): Promise<CustomerPetMutationResponse> {
  return requestBff(PETS_PATH, customerPetMutationResponseSchema, {
    ...options,
    method: "DELETE",
    headers: withBearer(options.headers, accessToken),
    body: customerPetDeleteRequestSchema.parse(body),
  });
}

export function upsertCustomerAddress(
  accessToken: string,
  body: CustomerAddressUpsertRequest,
  options: BffRequestOptions = {},
): Promise<CustomerAddressesResponse> {
  return requestBff(ADDRESSES_PATH, customerAddressesResponseSchema, {
    ...options,
    method: body.addressId ? "PATCH" : "POST",
    headers: withBearer(options.headers, accessToken),
    body: customerAddressUpsertRequestSchema.parse(body),
  });
}

export function deleteCustomerAddress(
  accessToken: string,
  body: CustomerAddressDeleteRequest,
  options: BffRequestOptions = {},
): Promise<CustomerAddressesResponse> {
  return requestBff(ADDRESSES_PATH, customerAddressesResponseSchema, {
    ...options,
    method: "DELETE",
    headers: withBearer(options.headers, accessToken),
    body: customerAddressDeleteRequestSchema.parse(body),
  });
}

export function applyCustomerSubscriptionAction(
  accessToken: string,
  body: CustomerSubscriptionActionRequest,
  options: BffRequestOptions = {},
): Promise<CustomerSubscriptionActionResponse> {
  return requestBff(SUBSCRIPTION_ACTION_PATH, customerSubscriptionActionResponseSchema, {
    ...options,
    method: "POST",
    headers: withBearer(options.headers, accessToken),
    body: customerSubscriptionActionSchema.parse(body),
  });
}

export function previewCustomerSubscriptionAction(
  accessToken: string,
  body: CustomerSubscriptionPreviewRequest,
  options: BffRequestOptions = {},
): Promise<CustomerSubscriptionPreviewResponse> {
  return requestBff(SUBSCRIPTION_PREVIEW_PATH, customerSubscriptionPreviewResponseSchema, {
    ...options,
    method: "POST",
    headers: withBearer(options.headers, accessToken),
    body: customerSubscriptionPreviewRequestSchema.parse(body),
  });
}

export function startCustomerPaymentRecovery(
  accessToken: string,
  body: CustomerPaymentRecoveryStartRequest,
  options: BffRequestOptions = {},
): Promise<CustomerPaymentRecoveryStartResponse> {
  return requestBff(PAYMENT_RECOVERY_START_PATH, customerPaymentRecoveryStartResponseSchema, {
    ...options,
    method: "POST",
    headers: withBearer(options.headers, accessToken),
    body: customerPaymentRecoveryStartRequestSchema.parse(body),
  });
}

function withBearer(init: HeadersInit | undefined, accessToken: string): Headers {
  const headers = new Headers(init);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
