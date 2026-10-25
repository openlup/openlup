/** Host-verified selection; never an authorization claim from a request body. */
export interface CustomerContext { principalId: string; clientId: string; graph: "managed" | "native" }
export type AccountReadRefusal = "FORBIDDEN" | "NOT_FOUND" | "UPSTREAM_UNAVAILABLE" | "INVALID_RESPONSE";
/** Owner DTOs stay host supplied, including private profile and market fields.
 * Null and thrown failures retain their existing host mappings. No cursor is promised.
 */
export interface AccountReadPort<Account, OrderList, OrderDetail> {
  getAccount(userId: string): Promise<Account | null>;
  listOrders(userId: string, input: { limit: number }): Promise<OrderList | null>;
  getOrderDetail(userId: string, orderId: string): Promise<OrderDetail | null>;
}

import type { AccountSupportMoney, SubscriptionPaymentMethodStatus } from "./commands.js";
import type { CustomerDocumentDeliveryStatus } from "./invoice.js";

export interface AccountProfile {
  clientId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  lifecycleStage: "lead" | "tester" | "customer" | "inactive"
}

export interface AccountAddress {
  addressId: string;
  kind: "shipping" | "billing" | "both";
  label: string | null;
  recipientName: string | null;
  contactPhone: string | null;
  companyName: string | null;
  taxId: string | null;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
  deliveryNotes: string | null;
  courierInstructions: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountBillingProfile {
  profileId: string;
  label: string | null;
  fullName: string;
  email: string;
  phone: string | null;
  companyName: string | null;
  taxId: string | null;
  companyVerificationLevel?: "registry_verified" | "provider_verified" | "manual_unverified" | "invalid" | null;
  companyIdentitySource?: string | null;
  companyIdentityEvidenceHash?: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Method/provider vocabulary is supplied by the selected host, never a platform provider list. */
export interface AccountPaymentPreference<Method extends string = string> {
  scope: "one_time" | "subscription" | "any";
  methodKind: Method;
  lastSelectedAt: string
}

export interface AccountPickupPoint {
  id: string;
  name: string;
  address: { line1: string; postalCode: string; city: string; country: string } | null
}

export interface AccountDeliverySelection {
  deliveryKind: "courier" | "parcel-locker";
  providerKind: string | null;
  carrierKind: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  pickupPoint: AccountPickupPoint | null;
}

export interface AccountDeliveryPreference<Provider extends string = string> extends AccountDeliverySelection {
  scope: "one_time" | "subscription" | "any";
  providerKind: Provider;
  carrierKind: string;
  carrierCode: string;
  serviceCode: string;
  lastSelectedAt: string;
}

export interface AccountEvent {
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: string | null;
  occurredAt: string
}

export interface AccountSubscriptionLine {
  lineId: string;
  variantId: string;
  qty: number;
  sortOrder: number;
  isAddon: boolean;
  title: string | null;
  sku: string | null;
  productSlug?: string | null;
  displayLabel?: string | null;
  accentColor?: string | null;
  unitPrice?: AccountSupportMoney | null;
  lineSubtotal?: AccountSupportMoney | null;
}

export interface AccountSubscription {
  subscriptionId: string;
  shippingAddressId: string | null;
  status: "pending_activation" | "active" | "paused" | "cancelled" | "activation_failed" | "completed";
  pausePreset: "2_weeks" | "1_month" | "indefinite" | null;
  pauseStartedAt: string | null;
  pauseEndsAt: string | null;
  cadenceDays: number;
  nextCycleAt: string | null;
  deliveryAlignment?: { state: "protected" | "aligned" };
  editCutoffAt: string | null;
  canEditUpcomingPackage: boolean;
  editBlockedReason: "not_active" | "edit_window_closed" | "cycle_locked" | "payment_blocked" | "missing_payment_method" | null;
  paymentMethodKind: string | null;
  paymentMethodStatus?: SubscriptionPaymentMethodStatus;
  templateVersion: number;
  sizeConstraint: Record<string, unknown> | null;
  packageSummary: string | null;
  recurringPrice: {
    subtotalGross: AccountSupportMoney;
    totalGross: AccountSupportMoney;
    currency: string;
    source: "frozen_quote_line" | "missing"
  }
  | null;
  nextCharge?: { totalGross: AccountSupportMoney; starterStage: "delivery2" | "graduation" | null } | null;
  lines: AccountSubscriptionLine[];
}

export interface AccountTrackingReference {
  providerKind: string;
  trackingNumber: string;
  trackingUrl: string | null;
  carrierKind: string | null;
  service: string | null;
  updatedAt: string | null
}

export interface AccountTrackingEvent {
  eventType: string;
  label: string;
  occurredAt: string | null;
  source: "webhook" | "reconciliation" | "manual" | "simulator" | "fulfillment"
}

export interface AccountInvoiceSummary {
  invoiceId: string;
  orderId: string;
  invoiceRef: string;
  status: string;
  providerInvoiceNumber: string | null;
  ksefNumber: string | null;
  ksefStatus: string;
  documentDeliveryStatus: CustomerDocumentDeliveryStatus;
  totalGross: AccountSupportMoney;
  issuedAt: string | null;
  downloadAvailable: boolean;
  downloadUrl: string | null;
  createdAt: string;
}

export interface AccountInvoiceDocument extends Omit<AccountInvoiceSummary, "totalGross"> {
  documentKey: string;
  role: "original" | "correction" | "replacement";
  artifact: "invoice" | "correction";
  isCurrent: boolean;
  totalGross: AccountSupportMoney | null;
}

export interface AccountOrderSummary {
  orderId: string;
  orderRef: string;
  orderNumber: string | null;
  subscriptionId: string | null;
  status: string;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  customerFulfillmentStep?: "paid" | "accepted" | "packing" | "transit" | "delivered" | "exception" | "cancelled";
  total: AccountSupportMoney;
  trackingNumber: string | null;
  trackingNumbers: string[];
  trackingUrl: string | null;
  carrierKind: string | null;
  service: string | null;
  trackingReferences: AccountTrackingReference[];
  trackingTimeline: AccountTrackingEvent[];
  deliverySelection: AccountDeliverySelection | null;
  invoice: AccountInvoiceSummary | null;
  invoiceDocuments: AccountInvoiceDocument[];
  invoiceRequestStatus: "not_requested" | "preparing" | "available";
  createdAt: string;
  updatedAt: string;
}

export interface AccountOrderLine {
  lineId: string;
  skuId: string | null;
  title: string;
  quantity: number;
  unitPrice: AccountSupportMoney;
  total: AccountSupportMoney;
  variantName: string | null;
  productSlug?: string | null;
  displayLabel?: string | null;
  accentColor?: string | null;
  listTotal?: AccountSupportMoney | null;
  discount?: AccountSupportMoney | null;
}

export interface AccountFulfillmentSummary {
  fulfillmentOrderId: string | null;
  status: string | null;
  providerKind: string | null;
  trackingNumber: string | null;
  trackingNumbers: string[];
  trackingReferences: AccountTrackingReference[];
  lastEventType: string | null;
  updatedAt: string | null;
  trackingTimeline: AccountTrackingEvent[];
}

export interface AccountOrderDetail extends AccountOrderSummary {
  subtotal: AccountSupportMoney;
  discount: AccountSupportMoney;
  shipping: AccountSupportMoney;
  tax: AccountSupportMoney;
  lines: AccountOrderLine[];
  fulfillment: AccountFulfillmentSummary | null;
}

export interface AccountOrderList {
  contractVersion: "customer.orders.v2";
  orders: AccountOrderSummary[]
}

export interface AccountOrderDetailResponse {
  contractVersion: "customer.orders.v2";
  order: AccountOrderDetail
}

export interface AccountActionRequired {
  actionId: string;
  kind: "payment_recovery"
  | "payment_method_missing"
  | "subscription_blocked"
  | "order_attention"
  | "invoice_attention";
  severity: "info" | "warning" | "critical";
  entityType: "subscription" | "order" | "invoice" | "account";
  entityId: string | null;
  subscriptionId: string | null;
  orderId: string | null;
  messageCode: AccountActionMessage;
  blockedReason: AccountActionMessage | null;
  title: string;
  body: string | null;
  cta: "repair_payment" | "view_subscription" | "view_order" | "contact_support" | null;
  failureCause: "needs_confirmation"
  | "method_cannot_recur"
  | "method_dead"
  | "method_data_invalid"
  | "method_missing"
  | "unknown";
  recoveryEligible: boolean;
  dueAt: string | null;
  nextRetryAt: string | null;
}

export type AccountActionMessage = "payment_blocked"
  | "payment_expired"
  | "missing_payment_method"
  | "payment_failed"
  | "payment_requires_action"
  | "subscription_edit_blocked"
  | "invoice_pdf_unavailable"
  | "subscription_activation_missing_mandate";

export interface AccountSnapshot<Extension = unknown> {
  contractVersion: "customer.account.v3";
  profile: AccountProfile;
  extension: Extension;
  subscriptions: AccountSubscription[];
  addresses: AccountAddress[];
  ordererProfiles: AccountBillingProfile[];
  billingProfiles: AccountBillingProfile[];
  paymentPreferences: AccountPaymentPreference[];
  deliveryPreferences: AccountDeliveryPreference[];
  recentOrders: AccountOrderSummary[];
  events: AccountEvent[];
  actionRequired: AccountActionRequired[];
}
