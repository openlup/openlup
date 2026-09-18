import type { CustomerOrderDetailResponse, CustomerOrdersListResponse } from "../../../src/domains/customers/accountV2Contracts.js";
import { currentParcelPerOrder } from "../../../src/lib/currentFulfillmentParcel.js";
import { formatCustomerOrderReference } from "../../../src/lib/orderRef.js";
import type { ReleasedProviderExceptionHold, ResolvedProviderExceptionRecovery } from "../../../src/lib/customerFulfillmentCanon.js";
import { CUSTOMER_ORDERS_CONTRACT_VERSION } from "../../../src/domains/customers/accountV2Contracts.js";
import {
  buildCustomerFulfillmentSummary,
  buildCustomerTrackingSummary,
  buildCustomerRecoveryMap,
  customerStepFromCustomerOrder,
  type CustomerOrderTrackingCompanions,
} from "./customerOrderTrackingModels.js";
import type { CustomerInvoiceHistorySummary } from "./customerInvoiceSummaryReadModel.js";
import { resolveDeliverySelectionEvidence, summarizeDeliverySelection } from "../../../src/domains/shipping/contracts.js";
import { deriveOrderMoney, type CanonicalOrderMoney } from "../../../src/domains/commerce/types.js";
import {
  customerOrderMoney,
  mapCustomerOrderLines,
  toOrderMoneyHeader,
  toOrderMoneyItem,
} from "../../domains/customers/customerOrderHistoryMoney.js";

export type CustomerOrderHistoryRow = Record<string, unknown>;
type Row = CustomerOrderHistoryRow;
type OrderSummary = CustomerOrdersListResponse["orders"][number];
type OrderDetail = CustomerOrderDetailResponse["order"];

// Terminal "dead" order statuses the customer account never lists — a cancelled or
// expired order is unrecoverable clutter. Recoverable/problematic orders stay
// `pending_payment`/`failed` (see apply_result_recoverable_decline), so they remain.
const HIDDEN_ORDER_STATUSES = ["cancelled", "expired"] as const;

export interface CustomerOrderHistoryReadStore {
  readCustomerOrders(clientId: string, hiddenStatuses: readonly string[], limit: number): Promise<Row[]>;
  readCustomerOrder(clientId: string, orderId: string): Promise<Row | null>;
  readOrderLines(orderId: string): Promise<Row[]>;
  readPaymentStatuses(orderIds: string[]): Promise<Map<string, string>>;
  readFulfillments(clientId: string, orderIds: string[]): Promise<Row[]>;
  readTracking(orderIds: string[]): Promise<Map<string, Row[]>>;
  readFulfillmentOperations(orderIds: string[]): Promise<Map<string, Row[]>>;
  readStatusEvidence(orderIds: string[]): Promise<Map<string, Row[]>>;
  readReleasedProviderExceptionHolds(orderIds: string[]): Promise<Map<string, ReleasedProviderExceptionHold[]>>;
  readReleasedProviderExceptionEvidence(
    holds: Map<string, ReleasedProviderExceptionHold[]>,
  ): Promise<Map<string, Row[]>>;
  readActiveHoldOrderIds(orderIds: string[]): Promise<Set<string>>;
  readInvoiceSummaries(orderIds: string[]): Promise<Map<string, CustomerInvoiceHistorySummary>>;
}

export async function readCustomerOrderSummaries(
  store: CustomerOrderHistoryReadStore,
  clientId: string,
  limit: number,
): Promise<CustomerOrdersListResponse> {
  const orders = await store.readCustomerOrders(clientId, HIDDEN_ORDER_STATUSES, limit);
  const maps = await readOrderCompanions(store, clientId, orders.map((row) => text(row.id)));
  return {
    contractVersion: CUSTOMER_ORDERS_CONTRACT_VERSION,
    orders: orders.map((row) => mapOrderSummary(row, maps)),
  };
}

export async function readCustomerOrderDetail(
  store: CustomerOrderHistoryReadStore,
  clientId: string,
  orderId: string,
): Promise<CustomerOrderDetailResponse | null> {
  const orderRow = await store.readCustomerOrder(clientId, orderId);
  if (!orderRow) return null;

  const [lineRows, maps] = await Promise.all([
    store.readOrderLines(orderId),
    readOrderCompanions(store, clientId, [orderId]),
  ]);
  const orderMoney = deriveOrderMoney(
    toOrderMoneyHeader(orderRow),
    lineRows.map(toOrderMoneyItem),
  );
  const summary = mapOrderSummary(orderRow, maps, orderMoney);
  return {
    contractVersion: CUSTOMER_ORDERS_CONTRACT_VERSION,
    order: {
      ...summary,
      subtotal: customerOrderMoney(orderMoney.subtotal, orderMoney.currency),
      discount: customerOrderMoney(orderMoney.productDiscount, orderMoney.currency),
      // The v1 customer contract has no separate delivery-discount field. Keep
      // its existing `shipping` field as the effective amount so
      // subtotal - discount + shipping = total remains true for free delivery.
      shipping: customerOrderMoney(orderMoney.shippingEffective, orderMoney.currency),
      tax: customerOrderMoney(orderMoney.tax, orderMoney.currency),
      lines: mapCustomerOrderLines(lineRows, orderMoney.lines, orderMoney.currency),
      fulfillment: maps.fulfillment.get(orderId) ?? null,
    },
  };
}

async function readOrderCompanions(store: CustomerOrderHistoryReadStore, clientId: string, orderIds: string[]) {
  const [payments, fulfillments, tracking, operations, evidence, releasedProviderExceptionHolds, activeHoldOrderIds, invoices] = await Promise.all([
    store.readPaymentStatuses(orderIds),
    store.readFulfillments(clientId, orderIds),
    store.readTracking(orderIds),
    store.readFulfillmentOperations(orderIds),
    store.readStatusEvidence(orderIds),
    store.readReleasedProviderExceptionHolds(orderIds),
    store.readActiveHoldOrderIds(orderIds),
    store.readInvoiceSummaries(orderIds),
  ]);
  for (const [orderId, rows] of (await store.readReleasedProviderExceptionEvidence(releasedProviderExceptionHolds))) {
    const known = new Set((evidence.get(orderId) ?? []).map((row) => text(row.id)));
    evidence.set(orderId, [...(evidence.get(orderId) ?? []), ...rows.filter((row) => !known.has(text(row.id)))]);
  }
  const recovery = buildCustomerRecoveryMap(fulfillments, evidence, releasedProviderExceptionHolds);
  return {
    payments,
    invoices,
    tracking,
    operations,
    evidence,
    recovery,
    activeHoldOrderIds,
    fulfillment: buildFulfillmentMap(fulfillments, { tracking, operations, evidence }, recovery),
  };
}

function buildFulfillmentMap(
  fulfillments: Row[],
  companions: CustomerOrderTrackingCompanions,
  recovery: Map<string, ResolvedProviderExceptionRecovery>,
) {
  const map = new Map<string, OrderDetail["fulfillment"]>();
  for (const [orderId, row] of currentParcelPerOrder(fulfillments)) {
    const trackingSummary = buildCustomerTrackingSummary(orderId, companions, recovery.get(orderId), text(row.id));
    const operation = companions.operations.get(orderId)?.[0] ?? null;
    map.set(orderId, buildCustomerFulfillmentSummary(row, trackingSummary, operation));
  }
  return map;
}

function mapOrderSummary(
  row: Row,
  maps: Awaited<ReturnType<typeof readOrderCompanions>>,
  orderMoney: CanonicalOrderMoney = deriveOrderMoney(toOrderMoneyHeader(row)),
): OrderSummary {
  const orderId = text(row.id);
  const fulfillment = maps.fulfillment.get(orderId);
  const trackingSummary = buildCustomerTrackingSummary(orderId, maps, maps.recovery.get(orderId), fulfillment?.fulfillmentOrderId ?? null);
  const invoiceHistory = maps.invoices.get(orderId) ?? null;
  const invoice = invoiceHistory?.invoice ?? null;
  return {
    orderId,
    orderRef: `order_${orderId}`,
    orderNumber: nullableText(row.order_number) ?? formatCustomerOrderReference(orderId),
    subscriptionId: nullableText(row.subscription_id),
    status: text(row.status),
    paymentStatus: maps.payments.get(orderId) ?? null,
    fulfillmentStatus: fulfillment?.status ?? null,
    customerFulfillmentStep: customerStepFromCustomerOrder(
      text(row.status), fulfillment?.status ?? null, maps.evidence.get(orderId) ?? [], maps.recovery.get(orderId), maps.activeHoldOrderIds.has(orderId),
    ),
    // `orderMoney.currency` is `commerce_orders.currency`, carried through
    // `deriveOrderMoney`: the order states what its own total means.
    total: customerOrderMoney(orderMoney.total, orderMoney.currency),
    trackingNumber: trackingSummary.trackingNumber,
    trackingNumbers: trackingSummary.trackingNumbers,
    trackingUrl: trackingSummary.trackingUrl,
    carrierKind: trackingSummary.carrierKind,
    service: trackingSummary.service,
    trackingReferences: trackingSummary.trackingReferences,
    trackingTimeline: trackingSummary.trackingTimeline,
    deliverySelection: summarizeDeliverySelection(
      resolveDeliverySelectionEvidence({ orderMetadata: row.metadata }).selection,
    ),
    invoice,
    invoiceDocuments: invoiceHistory?.invoiceDocuments ?? [],
    invoiceRequestStatus: invoice?.downloadAvailable
      ? "available"
      : invoiceHistory || orderHasB2bInvoiceRequest(row)
        ? "preparing"
        : "not_requested",
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function orderHasB2bInvoiceRequest(row: Row): boolean {
  const metadata = record(row.metadata);
  const topLevel = record(metadata.invoiceBuyerSnapshot);
  const runtime = record(record(metadata.runtimeFinalize).invoiceBuyerSnapshot);
  return nullableText(topLevel.taxId) !== null || nullableText(runtime.taxId) !== null;
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
