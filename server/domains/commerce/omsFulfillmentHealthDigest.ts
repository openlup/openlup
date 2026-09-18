import type { OmsOrderDetail } from "../../../src/domains/commerce/omsContracts.js";
import type {
  OmsFulfillmentOrderRow,
  OmsOmnipackStatusEvidenceRow,
} from "../../../src/domains/commerce/omsFulfillmentSummary.js";
import type { OmsOrderRow, OmsPaymentIntentRow } from "../../../src/domains/commerce/omsReadModelRows.js";
import { paymentStatusForOrder } from "../../../src/domains/commerce/omsReadModelHelpers.js";
import { buildOmsFulfillmentHealth, type OmsFulfillmentHealth } from "./omsFulfillmentHealth.js";
import type { OmsHealthDispatchRefRow } from "./omsOmnipackDispatchHealth.js";

export type OmsFulfillmentHealthDigest = OmsOrderDetail["fulfillmentHealthDigest"];

// The detail snapshot reduced to the two fields a queue row can show.
export function omsFulfillmentHealthDigest(health: OmsFulfillmentHealth): OmsFulfillmentHealthDigest {
  return { healthStatus: health.healthStatus, attentionReasons: health.attentionReasons };
}

// Digests for a whole list page from rows the list read already holds: one pure pass, zero queries.
// `orderPaidOutboxEvents` is not accepted - it costs a query per page to split three causes of one fact.
export function buildOmsFulfillmentHealthDigests(input: {
  orders: OmsOrderRow[];
  paymentIntents: OmsPaymentIntentRow[];
  fulfillmentOrders: OmsFulfillmentOrderRow[];
  dispatchRefs: OmsHealthDispatchRefRow[];
  statusEvidence: OmsOmnipackStatusEvidenceRow[];
  now?: Date;
}): Record<string, OmsFulfillmentHealthDigest> {
  return Object.fromEntries(input.orders.map((order) => {
    const fulfillmentOrders = input.fulfillmentOrders.filter((row) => row.order_id === order.id);
    // Narrowed before the call: the builder's own filter is a no-op when an order has
    // no fulfillment order, so the whole page would let a sibling decide this digest.
    const ids = new Set(fulfillmentOrders.map((row) => row.id));
    return [order.id, omsFulfillmentHealthDigest(buildOmsFulfillmentHealth({
      order,
      paymentStatus: paymentStatusForOrder(order.id, input.paymentIntents),
      fulfillmentOrders,
      dispatchRefs: input.dispatchRefs.filter((row) => ids.has(row.fulfillment_order_id)),
      statusEvidence: input.statusEvidence.filter((row) => ids.has(row.fulfillment_order_id)),
      now: input.now,
    }))];
  }));
}
