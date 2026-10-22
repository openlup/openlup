import type { FulfillmentNativeUnsupported } from './nativeUnsupported.js';
export interface FulfillmentReplacementRequest {
  idempotencyKey: string; actorUserId: string; orderId: string;
  reason: 'damaged' | 'lost' | 'returned_undelivered' | 'other'; metadata?: Record<string, unknown>;
}
export interface FulfillmentReplacementResult {
  contractVersion: 'commerce.v0';
  operation: { id: string; orderId: string; type: 'hold_created' | 'hold_released' | 'fulfillment_reviewed' | 'support_note' | 'shipping_address_updated' | 'order_marked_refunded' | 'order_cancelled_manual' | 'replacement_shipment_requested'; holdId: string | null; actorUserId: string | null; occurredAt: string; payload: Record<string, unknown> };
  replacement: { fulfillmentOrderId: string; orderId: string; sequenceNo: number; replacesFulfillmentOrderId: string; reason: FulfillmentReplacementRequest['reason']; status: string };
  releasedHoldIds: string[]; replayed: boolean;
}
/** Host owns atomic paid/contact/current-parcel/hold/reservation checks and actor-bound fingerprint/replay receipts. No confirmation or dispatch operation exists here. */
export interface FulfillmentReplacementPort {
  requestReplacementShipment(request: FulfillmentReplacementRequest): Promise<FulfillmentReplacementResult | FulfillmentNativeUnsupported>;
}
