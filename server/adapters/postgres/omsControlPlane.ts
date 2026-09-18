import {
  OMS_CONTROL_PLANE_VERSION,
  omsControlPlaneActions,
  omsControlPlaneDetailResponseSchema,
  omsControlPlaneListResponseSchema,
  type CommerceOmsControlPlanePort,
  type CommerceOmsOperatorResolver,
  type OmsControlPlaneOrder,
} from "../../../src/domains/commerce/omsControlPlane.js";
import { CommerceOmsPersistenceError } from "../../../src/domains/commerce/omsPorts.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

type Row = Record<string, unknown>;

export function createPostgresCommerceOmsControlPlane(
  executor: PgQueryExecutor,
): CommerceOmsControlPlanePort & CommerceOmsOperatorResolver {
  return {
    async resolveOperator(principalId) {
      const rows = await query(executor,
        "SELECT public.oms_control_resolve_operator($1::uuid) AS actor_id",
        [principalId]);
      return nullableString(rows[0]?.actor_id);
    },
    async listOrders(request) {
      const filters = [request.status ?? null];
      const [rows, countRows] = await Promise.all([
        query(executor, `${ORDER_SELECT}
          WHERE ($1::text IS NULL OR orders.status = $1)
            AND ${NOT_WITHDRAWN}
          ORDER BY orders.created_at DESC, orders.id DESC
          LIMIT $2 OFFSET $3`, [filters[0], request.pageSize, (request.page - 1) * request.pageSize]),
        query(executor, `SELECT count(*)::integer AS total_count FROM public.commerce_orders orders
          WHERE ($1::text IS NULL OR orders.status = $1)
            AND ${NOT_WITHDRAWN}`, filters),
      ]);
      return omsControlPlaneListResponseSchema.parse({
        contractVersion: OMS_CONTROL_PLANE_VERSION,
        orders: rows.map(mapOrder),
        totalCount: number(countRows[0]?.total_count),
        page: request.page,
        pageSize: request.pageSize,
      });
    },
    async getOrderDetail(request) {
      const orderRows = await query(executor, `${ORDER_SELECT} WHERE orders.id = $1`, [request.orderId]);
      if (!orderRows[0]) return null;
      const [holds, operations] = await Promise.all([
        query(executor, `SELECT id, status, reason, note, created_at, released_at
          FROM public.commerce_order_holds WHERE order_id = $1
          ORDER BY created_at DESC, id DESC`, [request.orderId]),
        query(executor, `SELECT id, operation_type, hold_id, actor_id, occurred_at
          FROM public.commerce_order_operations WHERE order_id = $1
          ORDER BY occurred_at DESC, id DESC`, [request.orderId]),
      ]);
      return omsControlPlaneDetailResponseSchema.parse({
        contractVersion: OMS_CONTROL_PLANE_VERSION,
        order: mapOrder(orderRows[0]),
        holds: holds.map((row) => ({
          id: string(row.id), status: string(row.status), reason: string(row.reason),
          note: nullableString(row.note), createdAt: date(row.created_at),
          releasedAt: row.released_at ? date(row.released_at) : null,
        })),
        operations: operations.map((row) => ({
          id: string(row.id), action: string(row.operation_type), holdId: nullableString(row.hold_id),
          actorId: nullableString(row.actor_id), occurredAt: date(row.occurred_at),
        })),
      });
    },
  };
}

// Bundle parity with the managed queue RPC, which hides withdrawn checkout rows
// in its `scoped_orders` CTE (20260903190000). `control_plane_v1` is the
// projection whose whole purpose is that both bundles answer alike, so the
// predicate is restated here rather than left to the managed path alone -
// otherwise the same request returns different rows and a different totalCount
// depending on which bundle serves it.
//
// FAILS CLOSED, exactly as the SQL does: the captured-payment clause means a
// marker written in error can never hide an order that took money. The
// control-plane request contract carries no `includeWithdrawn`, so - as on the
// managed side - these rows are simply out of scope for this projection.
const NOT_WITHDRAWN = `NOT (
              orders.status = 'cancelled'
              AND (
                orders.metadata ? 'supersededByStableJourneyKey'
                OR orders.metadata ->> 'checkoutAbandoned' = 'checkout_journey_consumed'
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM public.commerce_payments pay
                 WHERE pay.order_id = orders.id
                   AND pay.status IN ('succeeded', 'refunded', 'partially_refunded', 'disputed')
              )
            )`;

const ORDER_SELECT = `SELECT
  orders.id, orders.status, orders.source_kind, orders.source_order_ref,
  orders.total_amount_minor, orders.currency_code, orders.created_at, orders.updated_at,
  shipment.status AS shipment_status,
  COALESCE(active_holds.active_count, 0)::integer AS active_hold_count,
  COALESCE(active_holds.reasons, ARRAY[]::text[]) AS active_hold_reasons
FROM public.commerce_orders orders
LEFT JOIN public.fulfillment_shipments shipment ON shipment.order_id = orders.id
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS active_count,
         array_agg(hold.reason ORDER BY hold.created_at DESC) AS reasons
  FROM public.commerce_order_holds hold
  WHERE hold.order_id = orders.id AND hold.status = 'active'
) active_holds ON true`;

function mapOrder(row: Row): OmsControlPlaneOrder {
  const status = string(row.status) as OmsControlPlaneOrder["status"];
  const activeHoldCount = number(row.active_hold_count);
  const amount = nullableNumber(row.total_amount_minor);
  const currency = nullableString(row.currency_code);
  return {
    orderId: string(row.id), status,
    sourceKind: string(row.source_kind), sourceOrderRef: nullableString(row.source_order_ref),
    money: amount === null || currency === null ? null : { amountMinor: amount, currency },
    shipmentStatus: nullableString(row.shipment_status) as OmsControlPlaneOrder["shipmentStatus"],
    activeHoldCount,
    activeHoldReasons: array(row.active_hold_reasons) as OmsControlPlaneOrder["activeHoldReasons"],
    actions: omsControlPlaneActions(status, activeHoldCount),
    createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

async function query(executor: PgQueryExecutor, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    const result = await executor.query(sql, params);
    return result.rows;
  } catch (error) {
    throw new CommerceOmsPersistenceError("OMS control-plane query failed", { code: object(error).code });
  }
}

function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function string(value: unknown): string { if (typeof value !== "string" || !value) throw new CommerceOmsPersistenceError("OMS control-plane response invalid"); return value; }
function nullableString(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function number(value: unknown): number { const parsed = typeof value === "number" ? value : Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CommerceOmsPersistenceError("OMS control-plane number invalid"); return parsed; }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
function array(value: unknown): string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : []; }
function date(value: unknown): string { if (value instanceof Date) return value.toISOString(); return string(value); }
