import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import {
  customerStepForTerminalOrder,
  customerStepFromTimedSignals,
  phaseIndexForStep,
  type CustomerFulfillmentStep,
} from "@/domains/fulfillment/types";
import type { Subscription } from "./subscriptionEditModel";

type Order = CustomerAccountV2Response["recentOrders"][number];

export type { CustomerFulfillmentStep };

// SOURCE OF TRUTH for fulfillment status: config/fulfillment-status-map.json via
// src/domains/fulfillment/statusMap.ts. Do NOT add a parallel status→phase mapper
// here — extend the map. The customer step is derived from the order's REAL
// signals (order status, durable fulfillment status, latest provider evidence),
// so the internal `label_created` (set at OUR dispatch) can never overstate a box
// the provider has not started.

function orderSignals(
  order: Pick<Order, "fulfillmentStatus" | "status" | "customerFulfillmentStep">,
): Array<string | null | undefined> {
  return [order.status, order.fulfillmentStatus];
}

/** The single customer step (Layer C) for an order. */
export function customerFulfillmentStep(
  order: Pick<Order, "fulfillmentStatus" | "status" | "trackingTimeline" | "customerFulfillmentStep">,
): CustomerFulfillmentStep {
  if (order.customerFulfillmentStep) return order.customerFulfillmentStep;
  // Same rule as the server read model, from the same canon function: a
  // cancelled/refunded order never presents as delivered, whatever the timeline
  // says. This fallback only runs when the server omitted the derived step.
  return customerStepForTerminalOrder(order.status)
    ?? customerStepFromTimedSignals(
      orderSignals(order),
      order.trackingTimeline.map((event) => ({ token: event.eventType, occurredAt: event.occurredAt })),
    );
}

/**
 * Linear progress-bar index: 0 = paid (opłacone), 1 = accepted (przyjęte),
 * 2 = packing (przygotowanie), 3 = in transit (w drodze), 4 = delivered
 * (dostarczone). Off-track exception/cancelled pin to 1/0. Reads real signals
 * only — no fabricated progress.
 */
export function orderPhaseIndex(
  order: Pick<Order, "fulfillmentStatus" | "status" | "trackingTimeline" | "customerFulfillmentStep">,
): number {
  return phaseIndexForStep(customerFulfillmentStep(order));
}

// A paid subscription parcel remains the primary timeline item after handoff.
// The timeline only flips to the renewal once the durable fulfillment record is
// terminal. `customerFulfillmentStep` still resolves the displayed customer
// step below from the canonical status map; this is only the lifecycle boundary.
const FULFILLMENT_TERMINAL = new Set(["delivered", "cancelled"]);

// Order-level statuses that are not a real, paid, in-warehouse box.
const NON_ACTIVE_ORDER_STATUSES = new Set(["pending_payment", "cancelled", "refunded"]);

export interface InFlightDelivery {
  orderId: string;
  /** 0 = paid, 1 = accepted, 2 = packing (always < 3 here — shipped boxes are excluded). */
  phaseIndex: number;
  /** The resolved customer step, so callers render an accurate label without re-deriving. */
  step: CustomerFulfillmentStep;
}

/**
 * The subscription's current, already-paid delivery that is still being
 * fulfilled (until it is delivered or cancelled). This is the true "nearest
 * delivery" for a freshly-created subscription, where `nextCycleAt` is already
 * the NEXT renewal (cycle #2). Handed-over and in-transit parcels remain
 * primary so the account does not imply that a later renewal has overtaken a
 * paid box still on its way.
 */
export function selectInFlightDelivery(
  account: CustomerAccountV2Response,
  subscription: Subscription,
): InFlightDelivery | null {
  const order = (account.recentOrders ?? [])
    .filter((candidate) => candidate.subscriptionId === subscription.subscriptionId)
    .filter((candidate) => !NON_ACTIVE_ORDER_STATUSES.has(candidate.status.toLowerCase()))
    .filter((candidate) => {
      const fulfillmentStatus = candidate.fulfillmentStatus?.toLowerCase() ?? null;
      return fulfillmentStatus === null || !FULFILLMENT_TERMINAL.has(fulfillmentStatus);
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  if (!order) return null;
  return { orderId: order.orderId, phaseIndex: orderPhaseIndex(order), step: customerFulfillmentStep(order) };
}
