import type { SupabaseClient } from "@supabase/supabase-js";
import { ORDER_HEADER_MONEY_COLUMNS, ORDER_ITEM_MONEY_COLUMNS } from "../../../src/domains/commerce/types.js";
import { readCustomerInvoiceSummaries } from "./customerInvoiceSummaryReadModel.js";
import type {
  CustomerOrderHistoryReadStore,
  CustomerOrderHistoryRow,
} from "./customerOrderHistoryReadModels.js";
import {
  readActiveCustomerOrderHoldIds,
  readReleasedProviderExceptionEvidence,
  readReleasedProviderExceptionHolds,
} from "./customerOrderTrackingModels.js";

const ORDER_COLUMNS =
  `id, order_number, subscription_id, status, ${ORDER_HEADER_MONEY_COLUMNS}, created_at, updated_at, metadata`;
const ORDER_ITEM_COLUMNS =
  `id, sku_id, quantity, ${ORDER_ITEM_MONEY_COLUMNS}, product_snapshot, variant_snapshot`;

/** Managed persistence for order-history facts. Customer-safe mapping remains in the domain. */
export function createSupabaseCustomerOrderHistoryReadStore(
  customerClient: SupabaseClient,
  serviceClient: SupabaseClient,
): CustomerOrderHistoryReadStore {
  return {
    async readCustomerOrders(clientId, hiddenStatuses, limit) {
      return readMany(
        customerClient.from("commerce_orders")
          .select(ORDER_COLUMNS)
          .eq("client_id", clientId)
          .not("status", "in", `(${hiddenStatuses.join(",")})`)
          .order("created_at", { ascending: false })
          .limit(limit),
      );
    },
    async readCustomerOrder(clientId, orderId) {
      const { data, error } = await customerClient.from("commerce_orders")
        .select(ORDER_COLUMNS)
        .eq("id", orderId)
        .eq("client_id", clientId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as CustomerOrderHistoryRow | null;
    },
    readOrderLines: (orderId) => readMany(
      customerClient.from("commerce_order_items")
        .select(ORDER_ITEM_COLUMNS)
        .eq("order_id", orderId)
        .order("created_at", { ascending: true }),
    ),
    async readPaymentStatuses(orderIds) {
      const map = new Map<string, string>();
      if (orderIds.length === 0) return map;
      for (const row of await readMany(
        serviceClient.from("commerce_payments")
          .select("order_id, status, updated_at")
          .in("order_id", orderIds)
          .order("updated_at", { ascending: false }),
      )) if (!map.has(text(row.order_id))) map.set(text(row.order_id), text(row.status));
      return map;
    },
    // An order may hold more than one fulfilment row: the original at `sequence_no` 0
    // and a replacement parcel at 1, 2, … Ordered ascending by `(sequence_no, id)`, the
    // parcel that currently represents the order is the *last* row for that order, so
    // every consumer that collapses this list last-wins lands on the same parcel the
    // read models resolve explicitly. With one row per order the ordering is inert and
    // the result set is byte-identical to the unordered read it replaces.
    readFulfillments: (clientId, orderIds) => orderIds.length === 0
      ? Promise.resolve([])
      : readMany(
        serviceClient.from("commerce_fulfillment_orders")
          .select("id, order_id, sequence_no, status, provider_kind, updated_at")
          .eq("client_id", clientId)
          .in("order_id", orderIds)
          .order("sequence_no", { ascending: true })
          .order("id", { ascending: true }),
      ),
    // `fulfillment_order_id` says which parcel each reference was created for. The read still
    // groups by order - the read model narrows to the current parcel, because that is where the
    // parcel is resolved - but without this column there is nothing to narrow by.
    readTracking: (orderIds) => readGrouped(orderIds, "order_id", serviceClient.from("shipment_external_refs")
      .select("order_id, fulfillment_order_id, provider_kind, provider_tracking_id, tracking_url, carrier_kind, service, created_at, updated_at")
      .in("order_id", orderIds)
      .eq("active", true)
      .order("updated_at", { ascending: false })),
    readFulfillmentOperations: (orderIds) => readGrouped(orderIds, "order_id", serviceClient.from("commerce_fulfillment_operations")
      .select("order_id, operation_type, occurred_at")
      .in("order_id", orderIds)
      .order("occurred_at", { ascending: false })),
    readStatusEvidence: (orderIds) => readGrouped(orderIds, "order_id", serviceClient.from("omnipack_status_evidence")
      .select("id, order_id, fulfillment_order_id, provider_status, local_status, evidence_kind, occurred_at, created_at")
      .in("order_id", orderIds)
      .order("occurred_at", { ascending: false, nullsFirst: false })
      .limit(200)),
    readReleasedProviderExceptionHolds: (orderIds) =>
      readReleasedProviderExceptionHolds(serviceClient, orderIds),
    readReleasedProviderExceptionEvidence: (holds) =>
      readReleasedProviderExceptionEvidence(serviceClient, holds),
    readActiveHoldOrderIds: (orderIds) => readActiveCustomerOrderHoldIds(serviceClient, orderIds),
    readInvoiceSummaries: (orderIds) => readCustomerInvoiceSummaries(serviceClient, orderIds),
  };
}

async function readGrouped(
  ids: string[],
  key: string,
  query: PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<Map<string, CustomerOrderHistoryRow[]>> {
  const map = new Map<string, CustomerOrderHistoryRow[]>();
  if (ids.length === 0) return map;
  for (const row of await readMany(query)) {
    const id = text(row[key]);
    map.set(id, [...(map.get(id) ?? []), row]);
  }
  return map;
}

async function readMany(
  query: PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<CustomerOrderHistoryRow[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CustomerOrderHistoryRow[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
