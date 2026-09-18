import type { OmsOrderDetail } from "./omsContracts.js";

export function canCancelFulfillment(
  status: OmsOrderDetail["fulfillmentStatus"],
  providerCancellation: {
    activeHoldCount: number;
    orderMode: "one_time" | "subscription_cycle";
    orderStatus: OmsOrderDetail["status"];
    providerCancellationConfirmed: boolean;
  },
): boolean {
  if (status === "created" || status === "packed" || status === "label_pending") return true;
  return status === "exception"
    && providerCancellation.activeHoldCount === 0
    && providerCancellation.orderMode === "one_time"
    && (providerCancellation.orderStatus === "paid" || providerCancellation.orderStatus === "fulfillment_pending")
    && providerCancellation.providerCancellationConfirmed;
}
