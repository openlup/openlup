import type { FulfillmentNativeUnsupported } from './nativeUnsupported.js';
/** Host transaction inputs. actorUserId and idempotencyKey are required for attribution and replay receipts. */
interface MutationInput { idempotencyKey: string; actorUserId: string; metadata?: Record<string, unknown> }
interface ParcelMutationInput extends MutationInput { fulfillmentOrderId: string }
type AdminCommerceFulfillmentCreateRequest = MutationInput & { orderId: string };
type AdminCommerceFulfillmentRecordProviderAttemptRequest = ParcelMutationInput & { providerKind: string; status: 'recorded' | 'succeeded' | 'failed'; requestPayload?: Record<string, unknown>; responsePayload?: Record<string, unknown>; error?: string | null };
type AdminCommerceFulfillmentRecordLabelRequest = ParcelMutationInput & { providerKind: string; providerTrackingId: string; labelUrl?: string | null; deliveryEstimateDays?: number | null; rawProviderPayload?: Record<string, unknown> };
type AdminCommerceFulfillmentHandOffRequest = ParcelMutationInput;
type AdminCommerceFulfillmentTrackingEventRequest = ParcelMutationInput & { status: 'in_transit' | 'delivered' | 'exception'; providerTrackingId?: string; rawEvent?: Record<string, unknown> };
type AdminCommerceFulfillmentCancelRequest = ParcelMutationInput & { reason: string };
export interface FulfillmentOperatorMutationResult { contractVersion: 'commerce.fulfillment.v0'; fulfillmentOrderId: string; orderId: string; status: 'created' | 'packed' | 'label_pending' | 'label_created' | 'handed_over' | 'in_transit' | 'delivered' | 'exception' | 'cancelled'; replayed: boolean }
export interface FulfillmentOperatorMutationPort {
  createCommerceFulfillmentOrder(
    request: AdminCommerceFulfillmentCreateRequest & { actorUserId: string },
  ): Promise<FulfillmentOperatorMutationResult | FulfillmentNativeUnsupported>;
  recordCommerceFulfillmentProviderAttempt(
    request: AdminCommerceFulfillmentRecordProviderAttemptRequest & { actorUserId: string },
  ): Promise<FulfillmentOperatorMutationResult | FulfillmentNativeUnsupported>;
  recordCommerceFulfillmentLabel(
    request: AdminCommerceFulfillmentRecordLabelRequest & { actorUserId: string },
  ): Promise<FulfillmentOperatorMutationResult | FulfillmentNativeUnsupported>;
  handOffCommerceFulfillmentOrder(
    request: AdminCommerceFulfillmentHandOffRequest & { actorUserId: string },
  ): Promise<FulfillmentOperatorMutationResult | FulfillmentNativeUnsupported>;
  recordCommerceFulfillmentTrackingEvent(
    request: AdminCommerceFulfillmentTrackingEventRequest & { actorUserId: string },
  ): Promise<FulfillmentOperatorMutationResult | FulfillmentNativeUnsupported>;
  cancelCommerceFulfillmentOrder(
    request: AdminCommerceFulfillmentCancelRequest & { actorUserId: string },
  ): Promise<FulfillmentOperatorMutationResult | FulfillmentNativeUnsupported>;
}
