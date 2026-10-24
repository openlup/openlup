import type { FulfillmentObservation } from "./contracts/index.js";
/** Ledger effects for an already accepted observation; acceptance and retry belong to the caller. */
interface FulfillmentObservationPort<TrackingStatus> {
  markProviderStockConsumed(input: { idempotencyKey: string; fulfillmentOrderId: string }): Promise<{ replayed: boolean }>;
  markHandedOver(input: { idempotencyKey: string; fulfillmentOrderId: string; suppressDispatched: boolean }): Promise<{ replayed: boolean }>;
  recordTrackingReference(input: {
    idempotencyKey: string;
    orderId: string;
    fulfillmentOrderId: string;
    trackingNumber: string;
    trackingUrl: string | null;
    carrierKind: string | null;
    service: string | null;
    status: TrackingStatus;
    observation: FulfillmentObservation;
  }): Promise<{ replayed: boolean; readBack: boolean }>;
}

interface FulfillmentObservationTrackingReference {
  trackingNumber: string;
  trackingUrl?: string | null;
  carrierKind?: string | null;
  service?: string | null;
}


interface FulfillmentObservationInput<LocalStatus, TrackingStatus> {
  port: FulfillmentObservationPort<TrackingStatus>;
  localStatus: LocalStatus;
  ids: { orderId: string; fulfillmentOrderId: string };
  observation: FulfillmentObservation;
  trackingRefs: readonly FulfillmentObservationTrackingReference[];
  stockIdempotencyKey: string;
  handoffIdempotencyKey: string;
  trackingIdempotencyKey: (trackingNumber: string) => string;
  issueAccountingInvoice?: () => Promise<void>;
  onReplayed?: () => void;
  onTrackingRecorded?: (result: { replayed: boolean; readBack: boolean }) => void;
}

/** Pure status decisions/projection; the mechanism owns every effect and await. */
interface FulfillmentObservationStatusPolicy<LocalStatus, TrackingStatus> {
  consumesStock(status: LocalStatus): boolean;
  handsOver(status: LocalStatus): boolean;
  suppressDispatched(status: LocalStatus): boolean;
  trackingStatus(status: LocalStatus): TrackingStatus;
}

/** Stock → durable handover → every tracking reference → optional invoice. No catches or retries. */
export async function applyFulfillmentObservationEffects<LocalStatus, TrackingStatus>(
  input: FulfillmentObservationInput<LocalStatus, TrackingStatus>,
  policy: FulfillmentObservationStatusPolicy<LocalStatus, TrackingStatus>,
): Promise<void> {
  const { fulfillmentOrderId, orderId } = input.ids;
  if (policy.consumesStock(input.localStatus)) {
    const consumed = await input.port.markProviderStockConsumed({
      idempotencyKey: input.stockIdempotencyKey,
      fulfillmentOrderId,
    });
    if (consumed.replayed) input.onReplayed?.();
  }
  if (!policy.handsOver(input.localStatus)) return;

  const handoff = await input.port.markHandedOver({
    idempotencyKey: input.handoffIdempotencyKey,
    fulfillmentOrderId,
    suppressDispatched: policy.suppressDispatched(input.localStatus),
  });
  if (handoff.replayed) input.onReplayed?.();

  for (const trackingRef of input.trackingRefs) {
    const tracking = await input.port.recordTrackingReference({
      idempotencyKey: input.trackingIdempotencyKey(trackingRef.trackingNumber),
      orderId,
      fulfillmentOrderId,
      trackingNumber: trackingRef.trackingNumber,
      trackingUrl: trackingRef.trackingUrl ?? null,
      carrierKind: trackingRef.carrierKind ?? null,
      service: trackingRef.service ?? null,
      status: policy.trackingStatus(input.localStatus),
      observation: input.observation,
    });
    input.onTrackingRecorded?.(tracking);
  }
  await input.issueAccountingInvoice?.();
}
