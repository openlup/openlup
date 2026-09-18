import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type {
  PaidFulfillmentRecoveryOpsPort,
} from "../../domains/commerce/paidFulfillmentRecoveryOpsHandler.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

export function createPostgresPaidFulfillmentRecoveryOpsPort(
  executor: PgQueryExecutor,
): PaidFulfillmentRecoveryOpsPort {
  return {
    async readRecoveryInputs({ minimumAgeSeconds, limit, now, orderIds }) {
      const threshold = new Date(now.getTime() - minimumAgeSeconds * 1000);
      const scopedIds = [...new Set(orderIds ?? [])];
      const values: unknown[] = [["paid", "fulfillment_pending"], threshold, limit];
      const scope = scopedIds.length
        ? ` AND id = ANY($${values.push(scopedIds)}::uuid[])`
        : "";
      const { rows: orders } = await executor.query(
        `SELECT id, status, metadata->>'mode' AS mode, created_at, updated_at
           FROM commerce_orders
          WHERE status = ANY($1::text[]) AND updated_at <= $2${scope}
          ORDER BY updated_at ASC LIMIT $3`,
        values,
      );
      const matchedOrderIds = orders.map((row) => row.id);
      if (matchedOrderIds.length === 0) {
        return {
          orders: [], fulfillmentOrders: [], omnipackDispatchRefs: [],
          orderPaidOutboxEvents: [],
        };
      }
      const [{ rows: shipments }, { rows: events }] = await Promise.all([
        executor.query(
          `SELECT id, order_id, provider_type AS provider_kind, status, created_at, updated_at
             FROM fulfillment_shipments WHERE order_id = ANY($1::uuid[])
            ORDER BY created_at DESC`,
          [matchedOrderIds],
        ),
        executor.query(
          `SELECT id, event_type, status, aggregate_id, created_at, available_at,
                  attempts, metadata->>'updatedAt' AS updated_at
             FROM outbox_events
            WHERE event_type = $1 AND aggregate_id = ANY($2::uuid[])
            ORDER BY created_at DESC`,
          [COMMERCE_ORDER_PAID_EVENT_TYPE, matchedOrderIds],
        ),
      ]);
      return {
        orders: orders as never,
        fulfillmentOrders: shipments as never,
        omnipackDispatchRefs: [],
        orderPaidOutboxEvents: events as never,
      };
    },
    async requeueDiscardedOrderPaidOutboxEvents(input) {
      const eventIds = [...new Set(input.eventIds.filter(Boolean))];
      if (eventIds.length === 0) return { requeuedCount: 0, eventIds: [] };
      const { rows } = await executor.query(
        `SELECT id FROM outbox_requeue_discarded(
          p_event_ids => $1::uuid[], p_event_type => $2,
          p_limit => $3, p_requeued_by => $4, p_reason => $5)`,
        [eventIds, COMMERCE_ORDER_PAID_EVENT_TYPE, input.limit ?? eventIds.length,
          input.requeuedBy, input.reason],
      );
      return {
        requeuedCount: rows.length,
        eventIds: rows.map((row) => String(row.id)),
      };
    },
  };
}
