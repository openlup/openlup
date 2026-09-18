import type { AdminCommerceOrdersListResponse } from "./omsContracts.js";

export function summarizeOmsListOrders(
  orders: AdminCommerceOrdersListResponse["orders"],
): AdminCommerceOrdersListResponse["summaryCounts"] {
  return {
    needsAttention: orders.filter((order) => order.attentionReason !== "none").length,
    activeHold: orders.filter((order) => order.activeHoldCount > 0).length,
    readyForFulfillment: orders.filter((order) => order.nextAction === "create_fulfillment").length,
    paymentIssues: orders.filter((order) => order.attentionReason === "payment_required").length,
    inventoryRisk: orders.filter((order) => order.attentionReason === "inventory_missing").length,
    fulfillmentBlocked: orders.filter((order) => order.attentionReason === "fulfillment_blocked").length,
    fulfillmentExceptions: orders.filter((order) => order.attentionReason === "fulfillment_exception").length,
    invoiceIssues: orders.filter((order) => order.nextAction === "review_invoice").length,
    omnipackDispatchedNotPicked: orders.filter((order) => order.providerOpsStatus === "omnipack_dispatched_not_picked").length,
  };
}
