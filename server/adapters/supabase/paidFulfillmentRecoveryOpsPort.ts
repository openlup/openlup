import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type {
  PaidFulfillmentDispatchRefRow,
  PaidFulfillmentOrderEvidenceRow,
  PaidFulfillmentOrderRow,
  PaidFulfillmentOutboxEventRow,
} from "../../domains/commerce/paidFulfillmentRecovery.js";
import {
  type RequeueDiscardedOrderPaidOutboxResult,
} from "../../domains/commerce/paidFulfillmentRecovery.js";
import type {
  PaidFulfillmentRecoveryOpsPort,
  PaidFulfillmentRecoveryReadPort,
} from "../../domains/commerce/paidFulfillmentRecoveryOpsHandler.js";

type QueryResult = PromiseLike<{ data: unknown[] | null; error: { message?: string; code?: string } | null }>;
type SupabaseReadBuilder = QueryResult & {
  in(column: string, values: string[]): SupabaseReadBuilder;
  lte(column: string, value: string): SupabaseReadBuilder;
  eq(column: string, value: string): SupabaseReadBuilder;
  order(column: string, options?: { ascending?: boolean }): SupabaseReadBuilder;
  limit(count: number): SupabaseReadBuilder;
};

export interface PaidFulfillmentRecoverySupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
  from(table: string): {
    select(columns: string): SupabaseReadBuilder;
  };
}

interface PaidFulfillmentRecoveryRequeueClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export async function requeueDiscardedOrderPaidOutboxEvents(
  client: PaidFulfillmentRecoveryRequeueClient,
  input: {
    eventIds: string[];
    requeuedBy: string;
    reason: string;
    limit?: number;
  },
): Promise<RequeueDiscardedOrderPaidOutboxResult> {
  const eventIds = [...new Set(input.eventIds.filter(Boolean))];
  if (eventIds.length === 0) return { requeuedCount: 0, eventIds: [] };
  const { data, error } = await client.rpc("outbox_requeue_discarded", {
    p_event_ids: eventIds,
    p_event_type: COMMERCE_ORDER_PAID_EVENT_TYPE,
    p_limit: input.limit ?? eventIds.length,
    p_requeued_by: input.requeuedBy,
    p_reason: input.reason,
  });
  if (error) {
    throw new Error(
      `outbox_requeue_discarded_failed:${error.message ?? error.code ?? "unknown"}`,
    );
  }
  const rows = Array.isArray(data) ? (data as Array<{ id?: unknown }>) : [];
  return {
    requeuedCount: rows.length,
    eventIds: rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string"),
  };
}

export function createSupabasePaidFulfillmentRecoveryOpsPort(
  client: PaidFulfillmentRecoverySupabaseClient,
): PaidFulfillmentRecoveryOpsPort {
  return {
    ...createSupabasePaidFulfillmentRecoveryReadPort(client),
    requeueDiscardedOrderPaidOutboxEvents(input) {
      return requeueDiscardedOrderPaidOutboxEvents(client, input);
    },
  };
}

export function createSupabasePaidFulfillmentRecoveryReadPort(
  client: PaidFulfillmentRecoverySupabaseClient,
): PaidFulfillmentRecoveryReadPort {
  return {
    async readRecoveryInputs({ minimumAgeSeconds, limit, now, orderIds }) {
      const threshold = new Date(now.getTime() - minimumAgeSeconds * 1000).toISOString();
      const scopedOrderIds = [...new Set(orderIds ?? [])];
      let ordersQuery = client
        .from("commerce_orders")
        .select("id,status,mode,created_at,updated_at")
        .in("status", ["paid", "fulfillment_pending"])
        .lte("updated_at", threshold)
        .order("updated_at", { ascending: true })
        .limit(limit);
      if (scopedOrderIds.length > 0) {
        ordersQuery = ordersQuery.in("id", scopedOrderIds);
      }
      const orders = await readRows<PaidFulfillmentOrderRow>(
        ordersQuery,
        "paid_fulfillment_recovery_orders_read_failed",
      );
      const matchedOrderIds = orders.map((row) => row.id);
      if (matchedOrderIds.length === 0) {
        return {
          orders,
          fulfillmentOrders: [],
          omnipackDispatchRefs: [],
          orderPaidOutboxEvents: [],
        };
      }

      const [fulfillmentOrders, outboxEvents] = await Promise.all([
        readRows<PaidFulfillmentOrderEvidenceRow>(
          client
            .from("commerce_fulfillment_orders")
            .select("id,order_id,provider_kind,status,created_at,updated_at")
            .in("order_id", matchedOrderIds),
          "paid_fulfillment_recovery_fulfillment_read_failed",
        ),
        readRows<PaidFulfillmentOutboxEventRow>(
          client
            .from("outbox_events")
            .select("id,event_type,status,aggregate_id,created_at,available_at,attempts")
            .eq("event_type", COMMERCE_ORDER_PAID_EVENT_TYPE)
            .in("aggregate_id", matchedOrderIds)
            .order("created_at", { ascending: false })
            .limit(Math.max(limit * 3, matchedOrderIds.length)),
          "paid_fulfillment_recovery_outbox_read_failed",
        ),
      ]);

      const fulfillmentIds = fulfillmentOrders.map((row) => row.id);
      const omnipackDispatchRefs = fulfillmentIds.length === 0
        ? []
        : await readRows<PaidFulfillmentDispatchRefRow>(
          client
            .from("omnipack_dispatch_refs")
            .select("id,fulfillment_order_id,provider_order_id,status,created_at,updated_at")
            .in("fulfillment_order_id", fulfillmentIds),
          "paid_fulfillment_recovery_dispatch_refs_read_failed",
        );

      return {
        orders,
        fulfillmentOrders,
        omnipackDispatchRefs,
        orderPaidOutboxEvents: outboxEvents,
      };
    },
  };
}

async function readRows<T>(query: QueryResult, errorPrefix: string): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${errorPrefix}:${error.message ?? error.code ?? "unknown"}`);
  return (data ?? []) as T[];
}
