import type {
  AdminCommerceOrderHoldResponse,
  AdminCommerceOrderMarkRefundedResponse,
} from "../../../src/domains/commerce/omsContracts.js";
import {
  CommerceOmsConflictError,
  CommerceOmsPersistenceError,
  type CommerceOmsHoldPort,
  type CommerceOmsReadPort,
} from "../../../src/domains/commerce/omsPorts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import type { BackfillRow } from "../../domains/commerce/providerExceptionHoldHeal.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

type PublicHoldResponse = {
  hold?: { id?: unknown; orderId?: unknown; status?: unknown; reason?: unknown; note?: unknown };
  operationId?: unknown;
  replayed?: unknown;
};

export function createPostgresCommerceOmsPort(
  executor: PgQueryExecutor,
): CommerceOmsReadPort & CommerceOmsHoldPort {
  return {
    listOrders: unsupported,
    getOrderDetail: unsupported,
    async createHold(request) {
      return holdResponse(executor, await call(executor, "oms_create_hold", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_reason: request.reason,
        p_note: request.note ?? null,
        p_actor_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      }));
    },
    async releaseHold(request) {
      return holdResponse(executor, await call(executor, "oms_release_hold", {
        p_idempotency_key: request.idempotencyKey,
        p_hold_id: request.holdId,
        p_note: request.note ?? null,
        p_actor_id: request.actorUserId,
        p_proof_grade: null,
        p_metadata: request.metadata ?? {},
      }));
    },
    addNote: unsupported,
    updateShippingAddress: unsupported,
    // The replacement command is a managed-only routine: the platform migration
    // tree carries no `oms_request_replacement_shipment`. The port stays total and
    // refuses by name here rather than letting this lane silently succeed at
    // something it never performed.
    requestReplacementShipment: unsupported,
    async markRefunded(request): Promise<AdminCommerceOrderMarkRefundedResponse> {
      return transitionResponse(await call(executor, "oms_mark_refunded", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_reason: request.reason,
        p_actor_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      }));
    },
    async cancelOrder(request): Promise<AdminCommerceOrderMarkRefundedResponse> {
      return transitionResponse(await call(executor, "oms_cancel_unpaid_order", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_reason: request.reason,
        p_actor_id: request.actorUserId,
        p_metadata: request.metadata ?? {},
      }));
    },
  };
}

export function createPostgresProviderExceptionHealPort(executor: PgQueryExecutor) {
  return {
    // The kernel's half of the shared healable-hold predicate the managed
    // definition documents (managed migration 20260719100000): one definition,
    // one test surface. Three of its four safety filters port directly and are
    // applied below; the fourth deliberately does not, for the reason the
    // fulfilment rail already records at its own emitter --
    //   * `metadata->>'source' = '<integration>'`: names an integration by brand,
    //     which this kernel may not write, and metadata is caller-supplied and so
    //     forgeable. `created_by IS NULL` carries the non-forgeable half of the
    //     same question and is applied instead;
    //   * the provider-status allowlist ('suspended', 'shipping_failed') has no
    //     kernel counterpart: `fulfillment_shipment_operations` records that an
    //     exception was raised, not which provider vocabulary raised it, so the
    //     cleared status is the constant below rather than a value to filter on.
    async readHealableProviderExceptionHolds(): Promise<BackfillRow[]> {
      const { rows } = await executor.query(
        `SELECT h.id AS hold_id, h.order_id, s.id AS fulfillment_order_id,
                op.id AS cleared_evidence_id, 'exception' AS cleared_provider_status,
                NULL::text AS cleared_provider_sub_status,
                op.occurred_at AS cleared_occurred_at,
                NULL::text AS order_number, s.delivered_at
           FROM commerce_order_holds h
           JOIN commerce_orders o ON o.id = h.order_id
           JOIN fulfillment_shipments s ON s.order_id = h.order_id
           JOIN LATERAL (
             SELECT operation.id, operation.occurred_at
               FROM fulfillment_shipment_operations operation
              WHERE operation.shipment_id = s.id
                AND operation.operation_type = 'shipment_exception_raised'
              ORDER BY operation.occurred_at DESC LIMIT 1
           ) op ON true
          WHERE h.reason = 'fulfillment_exception' AND h.status = 'active'
            -- metadata is forgeable; created_by is not. Every hold an operator
            -- placed carries one, so a human hold can never be selected here.
            AND h.created_by IS NULL
            -- Delivery proof is semantically inapplicable to a terminal order:
            -- auto-releasing there would assert something that never happened.
            AND o.status NOT IN ('cancelled', 'refunded')
            -- A hold that names its shipment may only be healed by that shipment.
            -- One shipment per order holds today (fulfillment_shipments has a
            -- UNIQUE on order_id), so this fails closed if that ever relaxes.
            AND (h.metadata->>'shipmentId' IS NULL
                 OR h.metadata->>'shipmentId' = s.id::text)
            AND s.status = 'delivered' AND s.delivered_at IS NOT NULL
            AND op.occurred_at < s.delivered_at
          ORDER BY s.delivered_at ASC`,
      );
      return rows.map((row) => ({
        hold_id: requiredString(row.hold_id),
        order_id: requiredString(row.order_id),
        fulfillment_order_id: requiredString(row.fulfillment_order_id),
        cleared_evidence_id: requiredString(row.cleared_evidence_id),
        cleared_provider_status: "exception",
        cleared_provider_sub_status: null,
        cleared_occurred_at: date(row.cleared_occurred_at),
        order_number: nullableString(row.order_number),
        delivered_at: date(row.delivered_at),
      }));
    },
    async createSystemHold(input: {
      idempotencyKey: string;
      orderId: string;
      note?: string | null;
      metadata?: Record<string, unknown>;
    }) {
      return holdResponse(executor, await call(executor, "oms_create_system_hold", {
        p_idempotency_key: input.idempotencyKey,
        p_order_id: input.orderId,
        p_reason: "fulfillment_exception",
        p_note: input.note ?? null,
        p_metadata: input.metadata ?? {},
      }));
    },
    async releaseDelivered(row: BackfillRow) {
      await call(executor, "oms_release_hold", {
        p_idempotency_key: `commerce-heal:provider-exception:${row.hold_id}`,
        p_hold_id: row.hold_id,
        p_note: "delivery evidence confirmed",
        p_actor_id: null,
        p_proof_grade: "delivered",
        p_metadata: {
          shipmentId: row.fulfillment_order_id,
          deliveredAt: row.delivered_at,
          evidenceId: row.cleared_evidence_id,
        },
      });
    },
  };
}

async function holdResponse(
  executor: PgQueryExecutor,
  raw: unknown,
): Promise<AdminCommerceOrderHoldResponse> {
  const value = object(raw) as PublicHoldResponse;
  const hold = object(value.hold);
  const id = requiredString(hold.id);
  const { rows } = await executor.query(
    `SELECT created_at, released_at FROM commerce_order_holds WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new CommerceOmsPersistenceError("Commerce OMS hold readback failed");
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    hold: {
      id,
      orderId: requiredString(hold.orderId),
      status: requiredString(hold.status) as AdminCommerceOrderHoldResponse["hold"]["status"],
      reason: requiredString(hold.reason) as AdminCommerceOrderHoldResponse["hold"]["reason"],
      note: nullableString(hold.note),
      createdAt: date(rows[0].created_at),
      releasedAt: rows[0].released_at ? date(rows[0].released_at) : null,
    },
    operationId: requiredString(value.operationId),
    replayed: value.replayed === true,
  };
}

function transitionResponse(raw: unknown): AdminCommerceOrderMarkRefundedResponse {
  const value = object(raw);
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orderId: requiredString(value.orderId),
    status: requiredString(value.status) as AdminCommerceOrderMarkRefundedResponse["status"],
    replayed: value.replayed === true,
  };
}

async function call(
  executor: PgQueryExecutor,
  functionName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const keys = Object.keys(args);
  const namedArgs = keys.map((key, index) => `"${key}" => $${index + 1}`).join(", ");
  try {
    const { rows } = await executor.query(
      `SELECT ${functionName}(${namedArgs}) AS value`,
      keys.map((key) => parameter(args[key])),
    );
    return rows[0]?.value;
  } catch (error) {
    const code = object(error).code;
    if (code === "22023" || code === "23503" || code === "23505") {
      throw new CommerceOmsConflictError("Commerce OMS operation refused", { code });
    }
    throw new CommerceOmsPersistenceError("Commerce OMS operation failed", { code });
  }
}

function unsupported(): never {
  throw new CommerceOmsPersistenceError("Commerce OMS rich managed projection is unavailable on this bundle");
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value) throw new CommerceOmsPersistenceError("Commerce OMS response invalid"); return value; }
function nullableString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function date(value: unknown): string { return value instanceof Date ? value.toISOString() : requiredString(value); }
function parameter(value: unknown): unknown {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}
