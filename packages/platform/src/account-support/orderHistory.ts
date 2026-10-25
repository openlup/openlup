import { currentParcelPerOrder, rowsForParcel } from "@openlup/core/fulfillment";
import {
  deriveOrderMoney,
  customerSafeEvidenceToken,
  customerStepForTerminalOrder,
  customerStepFromTimedSignals,
  resolveProviderExceptionRecovery
} from "../commerce/index.js";
import type {
  CanonicalOrderMoney,
  CanonicalOrderMoneyLine,
  OrderMoneyHeaderRow,
  OrderMoneyItemRow,
  ReleasedProviderExceptionHold,
  ResolvedProviderExceptionRecovery
} from "../commerce/contracts/index.js";
import { resolveDeliverySelectionEvidence, summarizeDeliverySelection } from "../shipping/index.js";
import type {
  AccountOrderSummary,
  AccountOrderDetailResponse,
  AccountOrderList,
  AccountOrderLine,
  AccountFulfillmentSummary,
  AccountInvoiceSummary,
  AccountInvoiceDocument
} from "./contracts/account.js";

export const CUSTOMER_ORDERS_CONTRACT_VERSION = "customer.orders.v2" as const;
export type CustomerOrderHistoryRow = Record<string, unknown>;
type Row = CustomerOrderHistoryRow;
type Tracking = Pick<AccountOrderSummary, "trackingReferences"
  | "trackingNumbers"
  | "trackingNumber"
  | "trackingUrl"
  | "carrierKind"
  | "service"
  | "trackingTimeline">;

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
  readReleasedProviderExceptionEvidence(holds: Map<string, ReleasedProviderExceptionHold[]>): Promise<Map<string, Row[]>>;
  readActiveHoldOrderIds(orderIds: string[]): Promise<Set<string>>;
  readInvoiceSummaries(
    orderIds: string[]
  ): Promise<
    Map<string, { invoice: AccountInvoiceSummary | null; invoiceDocuments: AccountInvoiceDocument[] }>
  >;
}

/** Catalogue/captured-label policy is injected in its entirety, including private extension keys. */
export interface CustomerOrderLinePresentationPort {
  display(row: Row): Pick<AccountOrderLine, "title" | "variantName" | "productSlug" | "displayLabel" | "accentColor">;
}

export interface CustomerOrderHistoryProjectionPort {
  automaticHoldSource: string;
  automaticReleaseSource: string;
  orderReference(orderId: string): string;
  fulfillmentEvidence(input: {
    trackingRefs: Row[];
    statusEvidenceRows: Row[];
    operationRows: Row[];
    recovery?: ResolvedProviderExceptionRecovery
  }): Tracking;
  presentation: CustomerOrderLinePresentationPort;
}

export async function readCustomerOrderSummaries(
  store: CustomerOrderHistoryReadStore,
  clientId: string,
  limit: number,
  projection: CustomerOrderHistoryProjectionPort
): Promise<AccountOrderList> {
  const rows = await store.readCustomerOrders(clientId, ["cancelled", "expired"], limit);
  const maps = await companions(store, clientId, rows.map(row => text(row.id)), projection);
  return {
    contractVersion: CUSTOMER_ORDERS_CONTRACT_VERSION,
    orders: rows.map(row => summary(row, maps, projection))
  };
}

export async function readCustomerOrderDetail(
  store: CustomerOrderHistoryReadStore,
  clientId: string,
  orderId: string,
  projection: CustomerOrderHistoryProjectionPort
): Promise<AccountOrderDetailResponse | null> {
  const row = await store.readCustomerOrder(clientId, orderId);
  if (!row) return null;
  const [lines, maps] = await Promise.all([store.readOrderLines(orderId), companions(store, clientId, [orderId], projection)]);
  const money = deriveOrderMoney(toOrderMoneyHeader(row), lines.map(toOrderMoneyItem));
  return {
    contractVersion: CUSTOMER_ORDERS_CONTRACT_VERSION,
    order: {
      ...summary(row, maps, projection, money),
      subtotal: customerOrderMoney(money.subtotal, money.currency),
      discount: customerOrderMoney(money.productDiscount, money.currency),
      shipping: customerOrderMoney(money.shippingEffective, money.currency),
      tax: customerOrderMoney(money.tax, money.currency),
      lines: mapCustomerOrderLines(lines, money.lines, money.currency, projection.presentation),
      fulfillment: maps.fulfillment.get(orderId) ?? null
    }
  };
}

async function companions(
  store: CustomerOrderHistoryReadStore,
  clientId: string,
  ids: string[],
  projection: CustomerOrderHistoryProjectionPort
) {
  const [payments, parcels, tracking, operations, evidence, holds, active, invoices] = await Promise.all([
    store.readPaymentStatuses(ids),
    store.readFulfillments(clientId, ids),
    store.readTracking(ids),
    store.readFulfillmentOperations(ids),
    store.readStatusEvidence(ids),
    store.readReleasedProviderExceptionHolds(ids),
    store.readActiveHoldOrderIds(ids),
    store.readInvoiceSummaries(ids),
  ]);
  const released = await store.readReleasedProviderExceptionEvidence(holds);
  for (const [id, rows] of released) {
    const known = new Set((evidence.get(id) ?? []).map(row => text(row.id)));
    evidence.set(id, [...(evidence.get(id) ?? []), ...rows.filter(row => !known.has(text(row.id)))]);
  }
  const recovery = new Map<string, ResolvedProviderExceptionRecovery>();
  for (const parcel of parcels) {
    const id = text(parcel.order_id);
    if (!id) continue;
    recovery.set(
      id,
      resolveProviderExceptionRecovery({
        fulfillmentOrderId: nullableText(parcel.id),
        releasedHolds: holds.get(id) ?? [],
        automaticHoldSource: projection.automaticHoldSource,
        automaticReleaseSource: projection.automaticReleaseSource,
        statusEvidence: (evidence.get(id) ?? []).map(row => ({
          id: nullableText(row.id),
          fulfillmentOrderId: nullableText(row.fulfillment_order_id),
          providerStatus: nullableText(row.provider_status),
          localStatus: nullableText(row.local_status),
          token: customerSafeEvidenceToken(nullableText(row.local_status), nullableText(row.provider_status)),
          occurredAt: nullableText(row.occurred_at)
        }))
      })
    );
  }
  const readTracking = (id: string, parcelId: string | null) => projection.fulfillmentEvidence({
    trackingRefs: rowsForParcel(tracking.get(id) ?? [], parcelId),
    statusEvidenceRows: evidence.get(id) ?? [],
    operationRows: operations.get(id) ?? [],
    recovery: recovery.get(id)
  });
  const fulfillment = new Map<string, AccountFulfillmentSummary>();
  for (const [id, parcel] of currentParcelPerOrder(parcels)) {
    const details = readTracking(id, text(parcel.id)), op = operations.get(id)?.[0];
    fulfillment.set(
      id,
      {
        fulfillmentOrderId: text(parcel.id) || null,
        status: nullableText(parcel.status),
        providerKind: nullableText(parcel.provider_kind) ?? details.trackingReferences[0]?.providerKind ?? null,
        trackingNumber: details.trackingNumber,
        trackingNumbers: details.trackingNumbers,
        trackingReferences: details.trackingReferences,
        lastEventType: nullableText(op?.operation_type) ?? details.trackingTimeline[0]?.eventType ?? null,
        updatedAt: nullableText(parcel.updated_at) ?? nullableText(op?.occurred_at),
        trackingTimeline: details.trackingTimeline
      }
    );
  }
  return { payments, evidence, recovery, active, invoices, fulfillment, readTracking };
}

function summary(
  row: Row,
  maps: Awaited<ReturnType<typeof companions>>,
  projection: CustomerOrderHistoryProjectionPort,
  money: CanonicalOrderMoney = deriveOrderMoney(toOrderMoneyHeader(row))
): AccountOrderSummary {
  const id = text(row.id),
    parcel = maps.fulfillment.get(id),
    tracking = maps.readTracking(id, parcel?.fulfillmentOrderId ?? null),
    history = maps.invoices.get(id) ?? null,
    invoice = history?.invoice ?? null;
  const metadata = record(row.metadata);
  const requested = nullableText(record(metadata.invoiceBuyerSnapshot).taxId) !== null
    || nullableText(record(record(metadata.runtimeFinalize).invoiceBuyerSnapshot).taxId) !== null;
  const customerFulfillmentStep = maps.active.has(id)
    ? "exception"
    : customerStepForTerminalOrder(text(row.status))
    ?? customerStepFromTimedSignals(
      [text(row.status), parcel?.status ?? null],
      (maps.evidence.get(id) ?? []).map(value => ({
        id: nullableText(value.id),
        token: customerSafeEvidenceToken(nullableText(value.local_status), nullableText(value.provider_status)),
        occurredAt: nullableText(value.occurred_at)
      })),
      maps.recovery.get(id)
    );
  return {
    orderId: id,
    orderRef: `order_${id}`,
    orderNumber: nullableText(row.order_number) ?? projection.orderReference(id),
    subscriptionId: nullableText(row.subscription_id),
    status: text(row.status),
    paymentStatus: maps.payments.get(id) ?? null,
    fulfillmentStatus: parcel?.status ?? null,
    customerFulfillmentStep,
    total: customerOrderMoney(money.total, money.currency),
    ...tracking,
    deliverySelection: summarizeDeliverySelection(resolveDeliverySelectionEvidence({ orderMetadata: row.metadata }).selection),
    invoice,
    invoiceDocuments: history?.invoiceDocuments ?? [],
    invoiceRequestStatus: invoice?.downloadAvailable ? "available" : history || requested ? "preparing" : "not_requested",
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  };
}

export function mapCustomerOrderLines(
  rows: readonly Row[],
  moneyLines: readonly CanonicalOrderMoneyLine[],
  currency: string,
  presentation: CustomerOrderLinePresentationPort
): AccountOrderLine[] {
  return rows.map((row, index) => {
    const money = moneyLines[index],
      total = money?.catalogTotal ?? Number(row.total_cents ?? 0),
      list = lineListTotalMinor(record(row.product_snapshot)),
      saving = list !== null && list > total;
    return {
      lineId: text(row.id),
      skuId: nullableText(row.sku_id),
      ...presentation.display(row),
      quantity: Number(row.quantity),
      unitPrice: customerOrderMoney(money?.catalogUnit ?? row.unit_price_cents, currency),
      total: customerOrderMoney(total, currency),
      listTotal: saving ? customerOrderMoney(list, currency) : null,
      discount: saving ? customerOrderMoney(list - total, currency) : null
    };
  });
}

export function lineListTotalMinor(snapshot: Row): number | null {
  const components = record(snapshot.quoteLine).pricingComponents;
  if (!Array.isArray(components)) return null;
  let result = 0, found = false;
  for (const value of components) {
    const component = record(value);
    if (component.componentType === "base_unit") {
      result += Number(component.amountMinor ?? 0);
      found = true;
    }
  }
  return found ? result : null;
}

export function customerOrderMoney(value: unknown, currency: string) {
  return { amountMinor: Number(value ?? 0), currency };
}

export function toOrderMoneyHeader(row: Row): OrderMoneyHeaderRow {
  return {
    id: text(row.id),
    currency: text(row.currency),
    subtotal_cents: Number(row.subtotal_cents),
    discount_cents: Number(row.discount_cents),
    shipping_cents: Number(row.shipping_cents),
    shipping_discount_cents: Number(row.shipping_discount_cents ?? 0),
    tax_cents: Number(row.tax_cents),
    total_cents: Number(row.total_cents)
  };
}

export function toOrderMoneyItem(row: Row): OrderMoneyItemRow {
  const number = (value: unknown) => typeof value === "number" ? value : null;
  return {
    id: text(row.id),
    quantity: Number(row.quantity),
    unit_price_cents: Number(row.unit_price_cents),
    total_cents: Number(row.total_cents),
    discount_allocated_cents: number(row.discount_allocated_cents),
    effective_total_cents: number(row.effective_total_cents),
    effective_net_cents: number(row.effective_net_cents),
    vat_rate_bps: Number(row.vat_rate_bps)
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
