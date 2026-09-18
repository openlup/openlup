import type {
  OmsFulfillmentOperationRow,
  OmsFulfillmentOrderRow,
  OmsOmnipackDispatchRefRow,
  OmsOmnipackStatusEvidenceRow,
  OmsReleasedProviderExceptionHoldRow,
  OmsShipmentExternalRefRow,
} from "./omsFulfillmentSummary.js";
import { adminCommerceOrdersListResponseSchema, type AdminCommerceOrdersListResponse, type AdminOmsOrderListItem as OmsOrderListItem, type AdminOmsOrderSearchMatch } from "./omsContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import type { SubscriptionCycleStatus } from "../subscription/types.js";
import { summarizeOmsListOrders } from "./omsReadModelListSummary.js";
import { summarizeOmsListTotals } from "./omsListTotals.js";
import { findCustomer, findPet } from "./omsReadModelHelpers.js";
import { buildOmsOrderRowCore } from "./omsReadModelRowCore.js";
import type { OmsAccountingInvoiceRow, OmsAccountingOutboxRow, OmsCustomerRow, OmsInventoryReservationRow, OmsOrderItemRow, OmsOrderRow, OmsPaymentAttemptRow, OmsPaymentIntentRow, OmsPetRow } from "./omsReadModelRows.js";

export function buildOmsOrderListResponse(input: {
  orders: OmsOrderRow[];
  paymentIntents: OmsPaymentIntentRow[];
  paymentAttempts?: OmsPaymentAttemptRow[];
  activeHoldCounts: Record<string, number>;
  activeHoldReasons?: Record<string, OmsOrderListItem["activeHoldReasons"]>;
  fulfillmentHealthDigests?: Record<string, OmsOrderListItem["fulfillmentHealthDigest"]>;
  customers?: OmsCustomerRow[];
  pets?: OmsPetRow[];
  orderItems?: OmsOrderItemRow[];
  inventoryReservations?: OmsInventoryReservationRow[];
  fulfillmentOrders?: OmsFulfillmentOrderRow[];
  fulfillmentOperations?: OmsFulfillmentOperationRow[];
  shipmentExternalRefs?: OmsShipmentExternalRefRow[];
  omnipackDispatchRefs?: OmsOmnipackDispatchRefRow[];
  omnipackStatusEvidence?: OmsOmnipackStatusEvidenceRow[];
  releasedProviderExceptionHolds?: OmsReleasedProviderExceptionHoldRow[];
  accountingInvoices?: OmsAccountingInvoiceRow[];
  accountingOutbox?: OmsAccountingOutboxRow[];
  subscriptionCycleStatuses?: Record<string, SubscriptionCycleStatus | null>;
  searchMatches?: Record<string, AdminOmsOrderSearchMatch>;
  summaryCounts?: AdminCommerceOrdersListResponse["summaryCounts"];
  summaryTotals?: AdminCommerceOrdersListResponse["summaryTotals"];
  totalCount: number;
  page: number;
  pageSize: number;
}): AdminCommerceOrdersListResponse {
  const orders = input.orders.map((order) => {
    // The list's only job on top of the shared core is to narrow each collection
    // to this order; the detail hands the core the singletons it already loaded.
    const { row: listItem } = buildOmsOrderRowCore({
      order,
      activeHoldCount: input.activeHoldCounts[order.id] ?? 0,
      paymentIntents: input.paymentIntents,
      paymentAttempts: input.paymentAttempts ?? [],
      identity: { customer: findCustomer(order, input.customers ?? []), pet: findPet(order, input.pets ?? []) },
      orderItems: input.orderItems?.filter((item) => item.order_id === order.id),
      inventoryReservations: (input.inventoryReservations ?? []).filter((reservation) => reservation.order_id === order.id),
      fulfillmentOrders: (input.fulfillmentOrders ?? []).filter((candidate) => candidate.order_id === order.id),
      fulfillmentOperations: input.fulfillmentOperations ?? [],
      shipmentExternalRefs: (input.shipmentExternalRefs ?? []).filter((candidate) => candidate.order_id === order.id),
      dispatchRefs: input.omnipackDispatchRefs ?? [],
      statusEvidence: input.omnipackStatusEvidence ?? [],
      releasedProviderExceptionHolds: (input.releasedProviderExceptionHolds ?? []).filter((hold) => hold.order_id === order.id),
      accountingInvoice: (input.accountingInvoices ?? []).find((invoice) => invoice.order_id === order.id) ?? null,
      accountingOutbox: input.accountingOutbox ?? [],
      subscriptionCycleStatus: order.subscription_cycle_id ? input.subscriptionCycleStatuses?.[order.subscription_cycle_id] ?? null : null,
    });
    // Both diagnostics arrive as per-order maps built by the read that owns the
    // rows they are derived from - the hold `reason` column for one, the health
    // builder for the other - exactly as `activeHoldCounts` already does. A caller
    // that supplies neither gets the quiet row it would have got before this wave.
    const diagnostics = {
      activeHoldReasons: input.activeHoldReasons?.[order.id] ?? [],
      fulfillmentHealthDigest: input.fulfillmentHealthDigests?.[order.id] ?? { healthStatus: "ok" as const, attentionReasons: [] },
    };
    const match = input.searchMatches?.[order.id];
    return match ? { ...listItem, ...diagnostics, match } : { ...listItem, ...diagnostics };
  });

  return adminCommerceOrdersListResponseSchema.parse({
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orders,
    summaryCounts: input.summaryCounts ?? summarizeOmsListOrders(orders),
    summaryTotals: input.summaryTotals ?? summarizeOmsListTotals(orders),
    totalCount: input.totalCount,
    page: input.page,
    pageSize: input.pageSize,
  });
}
