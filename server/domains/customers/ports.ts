import type {
  CustomerAddressesResponse,
  CustomerDeliveryPreference,
  CustomerDeliveryPreferenceUpsertRequest,
  CustomerMeResponse,
  CustomerPaymentPreference,
  CustomerPaymentMethodsResponse,
  CustomerPaymentPreferenceUpsertRequest,
} from "../../../src/domains/customers/contracts.js";
import type {
  CustomerAccountResponse,
  CustomerAddressDeleteRequest,
  CustomerAddressUpsertRequest,
  CustomerPetCreateRequest,
  CustomerPetDeleteRequest,
  CustomerPetMutationResponse,
  CustomerPetsResponse,
  CustomerPetUpdateRequest,
  CustomerProfileUpdateRequest,
  CustomerProfileUpdateResponse,
  CustomerSubscriptionActionRequest,
  CustomerSubscriptionActionResponse,
} from "../../../src/domains/customers/selfServiceContracts.js";
import type {
  CustomerAccountV2Response,
  CustomerBillingProfileDeleteRequest,
  CustomerBillingProfileUpsertRequest,
  CustomerBillingProfilesResponse,
  CustomerInvoiceCorrectionRequest,
  CustomerInvoiceCorrectionResponse,
  CustomerInvoiceDownloadArtifact,
  CustomerOrderDetailResponse,
  CustomerOrdersListRequest,
  CustomerOrdersListResponse,
} from "../../../src/domains/customers/accountV2Contracts.js";
import type {
  CustomerPaymentRecoveryStartRequest,
  CustomerPaymentRecoveryStartResponse,
  CustomerSubscriptionPreviewRequest,
  CustomerSubscriptionPreviewResponse,
} from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import type { CustomerSubscriptionControlResponse } from "../../../src/domains/customers/subscriptionControlContracts.js";

export interface CustomerMePort {
  // Resolves an authenticated Supabase auth user id to the owning client row.
  // Returns null when no client row is linked to that auth user.
  getCustomerMe(userId: string): Promise<CustomerMeResponse | null>;
}

export interface CustomerPaymentPreferencesPort {
  listPaymentPreferences(userId: string): Promise<CustomerPaymentPreference[] | null>;
  upsertPaymentPreference(
    userId: string,
    input: CustomerPaymentPreferenceUpsertRequest,
  ): Promise<CustomerPaymentPreference | null>;
}

export interface CustomerPaymentMethodsPort {
  listPaymentMethods(userId: string): Promise<CustomerPaymentMethodsResponse["paymentMethods"] | null>;
}

export interface PaymentMethodSetupResolution {
  clientId: string;
  subscriptionId: string;
  providerCustomerRef: string | null;
}

export interface CustomerPaymentMethodSetupPort {
  resolveSubscriptionForCardSetup(input: {
    userId: string;
    subscriptionId: string;
  }): Promise<PaymentMethodSetupResolution | null>;
}

export interface CustomerDeliveryPreferencesPort {
  listDeliveryPreferences(userId: string): Promise<CustomerDeliveryPreference[] | null>;
  upsertDeliveryPreference(
    userId: string,
    input: CustomerDeliveryPreferenceUpsertRequest,
  ): Promise<CustomerDeliveryPreference | null>;
}

export interface CustomerAddressBookPort {
  getAddressBook(userId: string): Promise<CustomerAddressesResponse | null>;
}

export interface CustomerAccountPort {
  getAccount(userId: string): Promise<CustomerAccountResponse | CustomerAccountV2Response | null>;
}

export interface CustomerProfileMutationPort {
  updateProfile(
    userId: string,
    input: CustomerProfileUpdateRequest,
  ): Promise<CustomerProfileUpdateResponse | null>;
}

export interface CustomerPetsPort {
  listPets(userId: string): Promise<CustomerPetsResponse | null>;
  createPet(userId: string, input: CustomerPetCreateRequest): Promise<CustomerPetMutationResponse | null>;
  updatePet(userId: string, input: CustomerPetUpdateRequest): Promise<CustomerPetMutationResponse | null>;
  removePet(userId: string, input: CustomerPetDeleteRequest): Promise<CustomerPetMutationResponse | null>;
}

export interface CustomerAddressMutationPort {
  upsertAddress(userId: string, input: CustomerAddressUpsertRequest): Promise<CustomerAddressesResponse | null>;
  deleteAddress(userId: string, input: CustomerAddressDeleteRequest): Promise<CustomerAddressesResponse | null>;
}

export interface CustomerSubscriptionActionPort {
  applyAction(
    userId: string,
    input: CustomerSubscriptionActionRequest,
  ): Promise<CustomerSubscriptionActionResponse | null>;
}

export interface CustomerSubscriptionPreviewPort {
  previewAction(
    userId: string,
    input: CustomerSubscriptionPreviewRequest,
  ): Promise<CustomerSubscriptionPreviewResponse | null>;
}

export interface CustomerSubscriptionControlPort {
  getSnapshot(userId: string): Promise<CustomerSubscriptionControlResponse | null>;
}

export interface CustomerPaymentRecoveryStartPort {
  startPaymentRecovery(
    userId: string,
    input: CustomerPaymentRecoveryStartRequest,
  ): Promise<CustomerPaymentRecoveryStartResponse | null>;
}

export interface CustomerBillingProfilesPort {
  listBillingProfiles(userId: string): Promise<CustomerBillingProfilesResponse | null>;
  upsertBillingProfile(
    userId: string,
    input: CustomerBillingProfileUpsertRequest,
  ): Promise<CustomerBillingProfilesResponse | null>;
  deleteBillingProfile(
    userId: string,
    input: CustomerBillingProfileDeleteRequest,
  ): Promise<CustomerBillingProfilesResponse | null>;
}

export interface CustomerOrdersPort {
  listOrders(userId: string, input: CustomerOrdersListRequest): Promise<CustomerOrdersListResponse | null>;
  getOrderDetail(userId: string, orderId: string): Promise<CustomerOrderDetailResponse | null>;
}

export interface CustomerInvoiceCorrectionPort {
  requestInvoiceCorrection(
    userId: string,
    input: CustomerInvoiceCorrectionRequest,
  ): Promise<CustomerInvoiceCorrectionResponse | null>;
}

export interface CustomerInvoiceDownloadTicket {
  invoiceId: string;
  invoiceRef: string;
  providerKind: "fakturownia" | string;
  providerInvoiceId: string;
  providerInvoiceNumber: string | null;
  artifact: CustomerInvoiceDownloadArtifact;
  fileName: string;
}

export interface CustomerInvoiceDownloadPort {
  getInvoiceDownloadTicket(
    userId: string,
    invoiceId: string,
    artifact?: CustomerInvoiceDownloadArtifact,
  ): Promise<CustomerInvoiceDownloadTicket | null>;
}
