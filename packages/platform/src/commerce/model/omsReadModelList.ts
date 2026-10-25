import type { SubscriptionCycleStatus } from "@openlup/core/subscription";
import { adminCommerceOrdersListResponseSchema,type AdminCommerceOrdersListResponse,type AdminOmsOrderSearchMatch,type AdminOmsOrderListItem as OmsOrderListItem } from "../oms/omsContracts.js";
import type {
OmsFulfillmentOperationRow,
OmsFulfillmentOrderRow,
OmsProviderDispatchRefRow,
OmsProviderStatusEvidenceRow,
OmsReleasedProviderExceptionHoldRow,
OmsShipmentExternalRefRow,
} from "./omsFulfillmentSummary.js";
import { summarizeOmsListTotals } from "./omsListTotals.js";
import { findCustomer } from "./omsReadModelHelpers.js";
import { summarizeOmsListOrders } from "./omsReadModelListSummary.js";
import type { OmsReadModelProjections } from "./omsReadModelProjections.js";
import { buildOmsOrderRowCore } from "./omsReadModelRowCore.js";
import type { OmsAccountingInvoiceRow,OmsAccountingOutboxRow,OmsCustomerRow,OmsInventoryReservationRow,OmsOrderItemRow,OmsOrderRow,OmsPaymentAttemptRow,OmsPaymentIntentRow } from "./omsReadModelRows.js";
import { COMMERCE_CONTRACT_VERSION } from "../../pricing/contracts/index.js";

export function buildOmsOrderListResponse(input: {
  orders: OmsOrderRow[];
  identityExtras?: Record<string, Record<string, unknown>>;
  projections?: OmsReadModelProjections;
  paymentIntents: OmsPaymentIntentRow[];
  paymentAttempts?: OmsPaymentAttemptRow[];
  activeHoldCounts: Record<string, number>;
  activeHoldReasons?: Record<string, OmsOrderListItem["activeHoldReasons"]>;
  fulfillmentHealthDigests?: Record<string, OmsOrderListItem["fulfillmentHealthDigest"]>;
  customers?: OmsCustomerRow[];
  orderItems?: OmsOrderItemRow[];
  inventoryReservations?: OmsInventoryReservationRow[];
  fulfillmentOrders?: OmsFulfillmentOrderRow[];
  fulfillmentOperations?: OmsFulfillmentOperationRow[];
  shipmentExternalRefs?: OmsShipmentExternalRefRow[];
  providerDispatchRefs?: OmsProviderDispatchRefRow[];
  providerStatusEvidence?: OmsProviderStatusEvidenceRow[];
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
      projections: input.projections,
      order,
      activeHoldCount: input.activeHoldCounts[order.id] ?? 0,
      paymentIntents: input.paymentIntents,
      paymentAttempts: input.paymentAttempts ?? [],
      identity: { customer: findCustomer(order, input.customers ?? []), ...input.identityExtras?.[order.id] },
      orderItems: input.orderItems?.filter((item) => item.order_id === order.id),
      inventoryReservations: (input.inventoryReservations ?? []).filter((reservation) => reservation.order_id === order.id),
      fulfillmentOrders: (input.fulfillmentOrders ?? []).filter((candidate) => candidate.order_id === order.id),
      fulfillmentOperations: input.fulfillmentOperations ?? [],
      shipmentExternalRefs: (input.shipmentExternalRefs ?? []).filter((candidate) => candidate.order_id === order.id),
      dispatchRefs: input.providerDispatchRefs ?? [],
      statusEvidence: input.providerStatusEvidence ?? [],
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

  return (input.projections?.parseList ?? (value => adminCommerceOrdersListResponseSchema.parse(value)))({
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orders,
    summaryCounts: input.summaryCounts ?? summarizeOmsListOrders(orders, input.projections),
    summaryTotals: input.summaryTotals ?? summarizeOmsListTotals(orders, input.projections?.currency),
    totalCount: input.totalCount,
    page: input.page,
    pageSize: input.pageSize,
  });
}
