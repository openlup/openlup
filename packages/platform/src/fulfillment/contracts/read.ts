import type { CustomerFulfillmentStep } from './index.js';
import type { SubscriptionCycleStatus } from '@openlup/core/subscription';
import type { PaymentIntentStatus } from '@openlup/core/payment';
import type { FulfillmentNativeUnsupported } from './nativeUnsupported.js';
export type FulfillmentOrderStatus = 'draft' | 'pending_payment' | 'paid' | 'failed' | 'expired' | 'fulfillment_pending' | 'cancelled' | 'fulfilled' | 'refunded';
export type FulfillmentPaymentStatus = 'not_started' | PaymentIntentStatus;
export interface FulfillmentCommerceOrder {
  id: string; orderId: string; clientId: string | null;
  status: 'created' | 'packed' | 'label_pending' | 'label_created' | 'handed_over' | 'in_transit' | 'delivered' | 'exception' | 'cancelled';
  providerKind: string | null; providerTrackingId: string | null;
  shippingAddress: { addressId: string; clientId: string; label: string | null; line1: string; line2: string | null; city: string; postalCode: string; country: string };
  lines: { id: string | null; orderItemId: string; skuId: string; sku: string; title: string | null; quantity: number; inventoryReservationIds: string[]; productSnapshot: Record<string, unknown> }[];
  payment: { paymentIntentId: string; paymentStatus: FulfillmentPaymentStatus; providerPaymentId: string | null };
  inventory: { status: 'not_checked' | 'reserved' | 'missing' | 'released' | 'expired' | 'consumed' | 'review_required'; reservationId: string | null; reservationStatus: 'reserved' | 'consumed' | 'released' | 'expired' | null; expiresAt: string | null; locationId: string | null; locationCode: string | null };
  omsEligibility: { allowed: boolean; reason: 'order_not_paid' | 'payment_not_succeeded' | 'subscription_cycle_not_paid' | 'active_hold' | 'missing_shipping_address' | 'inventory_review' | 'risk_review' | null };
  latestOperation: { id: string; type: 'created' | 'packed' | 'provider_attempt_recorded' | 'label_created' | 'handed_over' | 'tracking_event_recorded' | 'cancelled'; occurredAt: string; actorUserId: string | null; payload: Record<string, unknown> } | null;
  createdAt: string; updatedAt: string;
}
export interface FulfillmentOrdersListRequest { page: number; pageSize: number; status?: FulfillmentCommerceOrder['status'] }
export interface FulfillmentOrderDetailRequest { fulfillmentOrderId?: string; orderId?: string }
export interface FulfillmentOrdersListResponse { contractVersion: 'commerce.fulfillment.v0'; orders: FulfillmentCommerceOrder[]; totalCount: number; page: number; pageSize: number }
export interface FulfillmentOrderDetailResponse { contractVersion: 'commerce.fulfillment.v0'; order: FulfillmentCommerceOrder }
/** Host-owned persisted projections. Payment statuses already come from the payments projection. */
export interface FulfillmentCommerceReadPort {
  listCommerceFulfillmentOrders(request: FulfillmentOrdersListRequest): Promise<FulfillmentOrdersListResponse | FulfillmentNativeUnsupported>;
  getCommerceFulfillmentOrderDetail(request: FulfillmentOrderDetailRequest): Promise<FulfillmentOrderDetailResponse | null | FulfillmentNativeUnsupported>;
}
export interface FulfillmentShipmentsOverviewRequest { shippedFilter: 'today' | '7d' | '30d' | 'all' }
/** Bucket rows are opaque host data; native shipment counts cannot replace these buckets. */
export interface FulfillmentShipmentsOverviewResponse { approved: Record<string, unknown>[]; packing: Record<string, unknown>[]; shippedToday: number; shipped: Record<string, unknown>[] }
export interface FulfillmentShipmentsOverviewPort {
  getShipmentsOverview(request: FulfillmentShipmentsOverviewRequest): Promise<FulfillmentShipmentsOverviewResponse | FulfillmentNativeUnsupported>;
}
/** Existing commerce eligibility remains host-owned; the read model only supplies its facts. */
export interface FulfillmentCommerceReadPolicy {
  evaluateCommerceFulfillmentEligibility(input: {
    orderMode: 'one_time' | 'subscription_cycle'; orderStatus: FulfillmentOrderStatus; paymentStatus: FulfillmentPaymentStatus;
    subscriptionCycleStatus: SubscriptionCycleStatus | null; activeHoldCount: number; hasShippingAddress: boolean;
    inventoryStatus: FulfillmentCommerceOrder['inventory']['status'];
  }): FulfillmentCommerceOrder['omsEligibility'];
}

export interface FulfillmentProgressInput {
  status: string; paymentStatus?: string | null; fulfillmentStatus?: string | null;
  customerFulfillmentStep?: CustomerFulfillmentStep | null;
  trackingTimeline: { eventType: string }[];
}
export interface FulfillmentProgressPresentation {
  completedSteps: CustomerFulfillmentStep[];
  currentStep: CustomerFulfillmentStep | null;
}
