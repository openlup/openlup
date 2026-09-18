import type {
  AdminCommerceFulfillmentOrderDetailRequest,
  AdminCommerceFulfillmentOrderDetailResponse,
  AdminCommerceFulfillmentOrdersListRequest,
  AdminCommerceFulfillmentOrdersListResponse,
} from "../../../src/domains/fulfillment/commerceFulfillmentContracts.js";
import { currentParcel, type FulfillmentParcelRow } from "../../../src/lib/currentFulfillmentParcel.js";
import {
  buildCommerceFulfillmentOrderDetailResponse,
  buildCommerceFulfillmentOrdersListResponse,
  type CommerceFulfillmentInventoryReservationRow,
  type CommerceFulfillmentLineRow,
  type CommerceFulfillmentOperationRow,
  type CommerceFulfillmentOrderContextRow,
  type CommerceFulfillmentOrderRow,
  type CommerceFulfillmentPaymentIntentRow,
  type CommerceFulfillmentShipmentRefRow,
} from "../../../src/domains/fulfillment/commerceFulfillmentReadModel.js";
import {
  CommerceFulfillmentPersistenceError,
  type CommerceFulfillmentMutationPort,
  type CommerceFulfillmentReadPort,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import type { SubscriptionCycleStatus } from "../../../src/domains/subscription/types.js";
import { createSupabaseCommerceFulfillmentMutationPort } from "./commerceFulfillmentMutationPort.js";

export interface CommerceFulfillmentSupabaseClient {
  from(table: string): SupabaseQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  in(column: string, values: unknown[]): SupabaseQueryBuilder;
  range(from: number, to: number): PromiseLike<SupabaseQueryResult>;
  maybeSingle(): PromiseLike<SupabaseQueryResult>;
}

interface SupabaseQueryResult {
  data: unknown;
  error: RpcError | null;
  count?: number | null;
}

export interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function createSupabaseCommerceFulfillmentPort(
  client: CommerceFulfillmentSupabaseClient,
): CommerceFulfillmentReadPort & CommerceFulfillmentMutationPort {
  return {
    ...createSupabaseCommerceFulfillmentMutationPort(client),
    async listCommerceFulfillmentOrders(
      request: AdminCommerceFulfillmentOrdersListRequest,
    ): Promise<AdminCommerceFulfillmentOrdersListResponse> {
      const offset = (request.page - 1) * request.pageSize;
      let query = client
        .from("commerce_fulfillment_orders")
        .select(
          "id, order_id, client_id, status, provider_kind, shipping_address_snapshot, created_at, updated_at",
          { count: "exact" },
        )
        .order("updated_at", { ascending: false });
      if (request.status) query = query.eq("status", request.status);

      const fulfillmentResult = await query.range(offset, offset + request.pageSize - 1);
      if (fulfillmentResult.error) {
        throw new CommerceFulfillmentPersistenceError("Commerce fulfillment list read failed");
      }
      const fulfillmentOrders = (fulfillmentResult.data ?? []) as CommerceFulfillmentOrderRow[];
      const related = await readRelatedRows(client, fulfillmentOrders);

      return buildCommerceFulfillmentOrdersListResponse({
        fulfillmentOrders,
        ...related,
        totalCount: fulfillmentResult.count ?? fulfillmentOrders.length,
        page: request.page,
        pageSize: request.pageSize,
      });
    },

    async getCommerceFulfillmentOrderDetail(
      request: AdminCommerceFulfillmentOrderDetailRequest,
    ): Promise<AdminCommerceFulfillmentOrderDetailResponse | null> {
      // `sequence_no` is projected only here, and only to resolve which parcel currently
      // represents the order; nothing downstream of this read reports it yet.
      let query = client
        .from("commerce_fulfillment_orders")
        .select("id, order_id, sequence_no, client_id, status, provider_kind, shipping_address_snapshot, created_at, updated_at");
      query = request.fulfillmentOrderId
        ? query.eq("id", request.fulfillmentOrderId)
        : query.eq("order_id", request.orderId);

      // Deliberately not `.maybeSingle()`: an order may now hold a replacement parcel as well
      // as the original, and PostgREST *errors* (PGRST116) when a single-object read matches two
      // rows. The by-`id` branch can only ever match one row, so it resolves to that same row.
      const fulfillmentResult = await query;
      if (fulfillmentResult.error) {
        throw new CommerceFulfillmentPersistenceError("Commerce fulfillment detail read failed");
      }
      const fulfillmentOrder = currentParcel((fulfillmentResult.data ?? []) as (CommerceFulfillmentOrderRow & FulfillmentParcelRow)[]);
      if (!fulfillmentOrder) return null;
      const related = await readRelatedRows(client, [fulfillmentOrder]);
      return buildCommerceFulfillmentOrderDetailResponse({
        fulfillmentOrder,
        lines: related.lines.filter((line) => line.fulfillment_order_id === fulfillmentOrder.id),
        latestOperation:
          related.latestOperations.find((operation) => operation.fulfillment_order_id === fulfillmentOrder.id) ??
          null,
        orderContext: requireSingle(related.orderContexts, fulfillmentOrder.order_id, "order context"),
        paymentIntent: requireSingle(related.paymentIntents, fulfillmentOrder.order_id, "payment intent"),
        inventoryReservations: related.inventoryReservations.filter(
          (reservation) => reservation.order_id === fulfillmentOrder.order_id,
        ),
        shipmentRef:
          related.shipmentRefs.find((ref) => ref.order_id === fulfillmentOrder.order_id && ref.active) ?? null,
        activeHoldCount: related.activeHoldCounts[fulfillmentOrder.order_id] ?? 0,
        subscriptionCycleStatus:
          related.subscriptionCycleStatuses[
            related.orderContexts.find((order) => order.id === fulfillmentOrder.order_id)?.subscription_cycle_id ?? ""
          ] ?? null,
      });
    },
  };
}

async function readRelatedRows(client: CommerceFulfillmentSupabaseClient, fulfillmentOrders: CommerceFulfillmentOrderRow[]) {
  const fulfillmentIds = fulfillmentOrders.map((order) => order.id);
  const orderIds = fulfillmentOrders.map((order) => order.order_id);
  if (!fulfillmentIds.length) {
    return {
      lines: [],
      latestOperations: [],
      orderContexts: [],
      paymentIntents: [],
      inventoryReservations: [],
      shipmentRefs: [],
      activeHoldCounts: {},
      subscriptionCycleStatuses: {},
    };
  }

  const [
    linesResult,
    operationsResult,
    orderContextsResult,
    paymentIntentsResult,
    reservationsResult,
    shipmentRefsResult,
    holdsResult,
  ] = await Promise.all([
    client
      .from("commerce_fulfillment_order_lines")
      .select("id, fulfillment_order_id, order_item_id, sku_id, sku, title, quantity, inventory_reservation_ids, product_snapshot")
      .in("fulfillment_order_id", fulfillmentIds)
      .order("created_at", { ascending: true }),
    client
      .from("commerce_fulfillment_operations")
      .select("id, fulfillment_order_id, operation_type, actor_user_id, occurred_at, payload")
      .in("fulfillment_order_id", fulfillmentIds)
      .order("occurred_at", { ascending: false }),
    client
      .from("commerce_orders")
      .select("id, status, mode, shipping_address_id, subscription_cycle_id")
      .in("id", orderIds),
    client
      .from("commerce_payment_intents")
      .select("id, order_id, status, provider_payment_id")
      .in("order_id", orderIds),
    client
      .from("inventory_reservations")
      .select("id, order_id, status, expires_at, location_id")
      .in("order_id", orderIds)
      .order("created_at", { ascending: false }),
    client
      .from("shipment_external_refs")
      .select("order_id, provider_tracking_id, active, created_at")
      .in("order_id", orderIds)
      .eq("active", true)
      .order("created_at", { ascending: false }),
    client.from("commerce_order_holds").select("order_id").in("order_id", orderIds).eq("status", "active"),
  ]);

  const results = [
    linesResult,
    operationsResult,
    orderContextsResult,
    paymentIntentsResult,
    reservationsResult,
    shipmentRefsResult,
    holdsResult,
  ];
  if (results.some((result) => result.error)) {
    throw new CommerceFulfillmentPersistenceError("Commerce fulfillment related rows read failed");
  }

  const orderContexts = (orderContextsResult.data ?? []) as CommerceFulfillmentOrderContextRow[];
  const inventoryReservations = await hydrateInventoryReservationLocations(
    client,
    (reservationsResult.data ?? []) as CommerceFulfillmentInventoryReservationRow[],
  );
  const cycleIds = [
    ...new Set(orderContexts.map((order) => order.subscription_cycle_id).filter((id): id is string => Boolean(id))),
  ];
  const cycleResult = cycleIds.length
    ? await client.from("subscription_cycles").select("id, status").in("id", cycleIds)
    : { data: [], error: null };
  if (cycleResult.error) {
    throw new CommerceFulfillmentPersistenceError("Commerce fulfillment subscription cycle read failed");
  }

  return {
    lines: (linesResult.data ?? []) as CommerceFulfillmentLineRow[],
    latestOperations: firstOperationPerFulfillment((operationsResult.data ?? []) as CommerceFulfillmentOperationRow[]),
    orderContexts,
    paymentIntents: (paymentIntentsResult.data ?? []) as CommerceFulfillmentPaymentIntentRow[],
    inventoryReservations,
    shipmentRefs: (shipmentRefsResult.data ?? []) as CommerceFulfillmentShipmentRefRow[],
    activeHoldCounts: countByOrder((holdsResult.data ?? []) as Array<{ order_id: string }>),
    subscriptionCycleStatuses: Object.fromEntries(
      ((cycleResult.data ?? []) as Array<{ id: string; status: SubscriptionCycleStatus }>).map((cycle) => [
        cycle.id,
        cycle.status,
      ]),
    ) as Record<string, SubscriptionCycleStatus | null>,
  };
}

async function hydrateInventoryReservationLocations(
  client: CommerceFulfillmentSupabaseClient,
  reservations: CommerceFulfillmentInventoryReservationRow[],
): Promise<CommerceFulfillmentInventoryReservationRow[]> {
  const locationIds = [
    ...new Set(reservations.map((reservation) => reservation.location_id).filter((id): id is string => Boolean(id))),
  ];
  if (!locationIds.length) {
    return reservations.map((reservation) => ({ ...reservation, inventory_locations: null }));
  }

  const locationResult = await client
    .from("inventory_locations")
    .select("id, code")
    .in("id", locationIds);
  if (locationResult.error) {
    return reservations.map((reservation) => ({ ...reservation, inventory_locations: null }));
  }

  const locationCodes = new Map(
    ((locationResult.data ?? []) as Array<{ id: string; code: string | null }>).map((location) => [
      location.id,
      location.code,
    ]),
  );
  return reservations.map((reservation) => ({
    ...reservation,
    inventory_locations: reservation.location_id
      ? { code: locationCodes.get(reservation.location_id) ?? null }
      : null,
  }));
}

function firstOperationPerFulfillment(rows: CommerceFulfillmentOperationRow[]): CommerceFulfillmentOperationRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.fulfillment_order_id)) return false;
    seen.add(row.fulfillment_order_id);
    return true;
  });
}

function countByOrder(rows: Array<{ order_id: string }>): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.order_id] = (counts[row.order_id] ?? 0) + 1;
    return counts;
  }, {});
}

function requireSingle<T extends { id?: string; order_id?: string }>(
  rows: T[],
  orderId: string,
  label: string,
): T {
  const row = rows.find((candidate) => candidate.id === orderId || candidate.order_id === orderId);
  if (!row) throw new CommerceFulfillmentPersistenceError(`Missing commerce fulfillment ${label}`);
  return row;
}
