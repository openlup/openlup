import type { NormalizedFulfillmentFact } from "@openlup/core/fulfillment";
import type { CanonicalLocalFulfillmentStatus } from "./index.js";
import type { FulfillmentRefusal } from "./dispatch.js";
export interface FulfillmentTrackingReference { trackingNumber: string; /** Normalized carrier kind, never a raw provider code. */ carrierRef: string | null; serviceRef: string | null; publicUrl: string | null }
/** Durable normalized envelope. eventKey, not the receivedAt-bearing fact fingerprint, deduplicates retries. */
export interface FulfillmentObservation {
  fact: NormalizedFulfillmentFact<CanonicalLocalFulfillmentStatus>;
  eventKind: "shipment.accepted" | "order.processing_started" | "order.picked" | "order.shipped" | "order.delivered" | "parcel.exception" | "parcel.cancelled";
  eventKey: string;
  firstReceivedAt: string;
  correlation: { orderRef: string | null; fulfillmentRef: string | null; externalRef: string | null; orderNumber: string | null; providerFulfillmentRef: string | null; parcelRef: string | null };
  trackingRefs: readonly FulfillmentTrackingReference[];
  /** Original provider status tokens; canonical status does not identify an occurrence. */
  providerStatus?: { primary: string | null; subStatus: string | null };
  diagnostics?: { admission?: { rejectedTrackingRefs: number; rejectedTrackingUrls: number }; refusal?: FulfillmentRefusal; stockContention?: { sqlState: "55P03"; phase: "provider_stock_consumed"; retryable: true }; annotation?: "recorded" | "failed"; recoveredPickedReceipt?: { receiptRef: string; closed: boolean } };
}
export interface FulfillmentObservationPort {
  /** Authenticate untouched bytes before parsing. Inputs live only during verification. */
  verifyAndNormalize(input: { rawBody: Uint8Array; headers: Readonly<Record<string, string>>; receivedAt: string }): Promise<{ kind: "verified"; observation: FulfillmentObservation } | { kind: "refused"; refusal: FulfillmentRefusal; diagnostics?: { invalidTimestamp: true } }>;
}
