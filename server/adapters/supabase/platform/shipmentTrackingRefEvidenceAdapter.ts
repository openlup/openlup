import type { ObservabilityEvidencePort } from "../../../../src/domains/platform/observabilityPorts.js";
import { selectRows, type SupabaseObservabilityClient } from "./observabilityEvidenceQueries.js";
import {
  countHandedOverWithoutTrackingRef,
  HANDED_OVER_TRACKING_REF_STATUSES,
  type DeliveredStatusEvidenceRow,
  type HandedOverFulfillmentRow,
  type ShipmentTrackingRefRow,
} from "../../../domains/platform/shipmentTrackingRefEvidence.js";

// Decorator rather than another read inside the base evidence port: that file
// is at its source-size cap, and two plain PostgREST reads plus a pure join are
// cheaper than an RPC for two counts.
export function withShipmentTrackingRefEvidence(
  base: ObservabilityEvidencePort,
  client: SupabaseObservabilityClient,
): ObservabilityEvidencePort {
  return {
    async collectSnapshot(now) {
      const [snapshot, fulfillmentOrders] = await Promise.all([
        base.collectSnapshot(now),
        selectRows<HandedOverFulfillmentRow>(
          client.from<HandedOverFulfillmentRow>("commerce_fulfillment_orders")
            .select("id,order_id,status,handed_over_at,updated_at")
            .in("status", HANDED_OVER_TRACKING_REF_STATUSES)
            .order("updated_at", { ascending: false })
            .limit(2000),
          "commerce_fulfillment_orders_handed_over_tracking_ref",
        ),
      ]);
      // Both follow-up reads are scoped to the candidate set and skipped whole
      // when there is no candidate, so a quiet system costs one query.
      const [trackingRefs, deliveredEvidence] = fulfillmentOrders.length === 0
        ? [[], []]
        : await Promise.all([
          selectRows<ShipmentTrackingRefRow>(
            client.from<ShipmentTrackingRefRow>("shipment_external_refs")
              .select("order_id,active")
              .eq("active", true)
              .in("order_id", fulfillmentOrders.map((row) => row.order_id))
              .limit(2000),
            "shipment_external_refs_active_tracking_ref",
          ),
          selectRows<DeliveredStatusEvidenceRow>(
            client.from<DeliveredStatusEvidenceRow>("omnipack_status_evidence")
              .select("fulfillment_order_id,local_status")
              .in("fulfillment_order_id", fulfillmentOrders.map((row) => row.id))
              .limit(2000),
            "omnipack_status_evidence_delivered_tracking_ref",
          ),
        ]);
      return {
        ...snapshot,
        omnipack: {
          ...snapshot.omnipack,
          handedOverWithoutTrackingRefCount: countHandedOverWithoutTrackingRef({
            fulfillmentOrders,
            trackingRefs,
            deliveredEvidence,
            now,
          }),
        },
      };
    },
  };
}
