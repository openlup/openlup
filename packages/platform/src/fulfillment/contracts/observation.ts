import type { NormalizedFulfillmentFact } from "@openlup/core/fulfillment";
import type { CanonicalLocalFulfillmentStatus } from "./index.js";
import type { FulfillmentRefusal } from "./dispatch.js";
/** Explicit adopter policy, forwarded through each durable observation projection. */
export interface FulfillmentObservationCodecs {
  approveReference?(value: string): boolean;
  /** Overrides the query/fragment default; HTTPS, no credentials and URL approval still apply. */
  trackingUrl?(url: string): string | null;
}
export interface FulfillmentTrackingReference { trackingNumber: string; /** Normalized carrier kind, never a raw provider code. */ carrierRef: string | null; serviceRef: string | null; publicUrl: string | null }
/** Durable normalized envelope. eventKey, not the receivedAt-bearing fact fingerprint, deduplicates retries. */
export interface FulfillmentObservation {
  fact: NormalizedFulfillmentFact<CanonicalLocalFulfillmentStatus>;
  eventKind: "shipment.accepted" | "shipment.preparing" | "shipment.packed" | "shipment.in_transit" | "shipment.delivered" | "order.processing_started" | "order.picked" | "order.shipped" | "order.delivered" | "parcel.exception" | "parcel.cancelled";
  eventKey: string;
  firstReceivedAt: string;
  correlation: { orderRef: string | null; fulfillmentRef: string | null; externalRef: string | null; orderNumber: string | null; providerFulfillmentRef: string | null; parcelRef: string | null };
  trackingRefs: readonly FulfillmentTrackingReference[];
  /** Adapter-owned occurrence identity and closed recovery policy; no raw status interpretation in stores. */
  intake?: { occurrenceKey: string; recovery: "provider_recovered" | "delivery_only" | "manual" | null };
  /** Original provider status tokens; canonical status does not identify an occurrence. */
  providerStatus?: { primary: string | null; subStatus: string | null; /** Neutral aliases; legacy fields remain the compatibility carrier. */ code?: string | null; detailCode?: string | null };
  diagnostics?: { redactedFieldCount?: number; admission?: { rejectedTrackingRefs: number; rejectedTrackingUrls: number }; refusal?: FulfillmentRefusal; stockContention?: { sqlState: "55P03"; phase: "provider_stock_consumed"; retryable: true }; annotation?: "recorded" | "failed"; recoveredPickedReceipt?: { receiptRef: string; closed: boolean } };
}
export interface FulfillmentObservationPort {
  /** Authenticate untouched bytes before parsing. Inputs live only during verification. */
  verifyAndNormalize(input: { rawBody: Uint8Array; headers: Readonly<Record<string, string>>; receivedAt: string }): Promise<{ kind: "verified"; observation: FulfillmentObservation } | { kind: "refused"; refusal: FulfillmentRefusal; diagnostics?: { invalidTimestamp?: true; rejectedCorrelationRefs?: number } }>;
}
