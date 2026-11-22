export type { CommerceOfferAvailabilityStatus, CommerceOfferAvailabilityRequestItem, CommerceOfferAvailability, CommerceOfferAvailabilityPort } from "./availability.js";
export type { RecoveryDestinationIntent, RecoveryDestinationPolicyInput, RecoveryDestinationSource, RecoveryDestinationState } from "./recovery.js";
export type { CommerceFulfillmentEligibilityInput, CartStatus, CheckoutStatus, OrderDraftStatus, OrderStatus, PaymentStatus, OmsFulfillmentBlockReason, OmsInventoryStatus } from "./state.js";
export type { CartDraft, CheckoutSessionPlaceholder, OrderDraftSummary, OrderSummary, PaymentSummary } from "./order.js";
export type AsyncCheckoutStatus = "pending_provider_action" | "requires_action" | "processing" | "paid" | "failed" | "expired";
export type CheckoutKind = "one_time" | "subscription_initial";
export type * from "./ports.js";
export type * from "./runtimePorts.js";
export type { ConfiguratorIntent, ConfiguratorIntentPersistenceResponse, CheckoutResumeDraftState, CheckoutResumeDraft, CommerceCustomerDefaultsSnapshot } from "./intent.js";
export type * from "./orderMoney.js";
export type { OmsPaymentStatus } from "./state.js";

// Shared fulfillment recovery DTOs.
export type * from "./fulfillmentRecovery.js";

// M11 K3a OMS browser-safe DTOs and ports; no imports from runtime schema modules.
export type * from "./omsTypes.js";

export type { CheckoutRecoveryReminderSchedule } from "./checkoutRecoveryReminders.js";

/** @experimental Address input for the versioned destination ingress. */
export interface DestinationAddressV2 {
  line1: string;
  line2?: string;
  city: string;
  subdivisionCode?: string;
  postalCode: string;
  countryCode: string;
}

/** @experimental Checkout input carrying a versioned destination address. */
export interface CheckoutCommandV2 {
  version: "commerce.checkout_command.v2";
  idempotencyKey: string;
  mode: "one_time" | "subscription";
  lines: { sku: string; quantity: number }[];
  customer: { firstName: string; lastName: string; email: string; phone: string };
  shippingAddress: DestinationAddressV2;
  currency: string;
  cadenceDays?: number;
}
