import { InventoryPersistenceError } from "./ports.js";

interface PurchaseReservationExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface PurchaseReservationInput {
  idempotencyKey: string;
  orderId: string;
  stockSourceKey: string;
  items: readonly { orderItemId: string; skuId: string; quantity: number }[];
  paymentStatus: "created" | "requires_action" | "processing" | "succeeded";
  /** Null selects the donor SQL default of thirty minutes. Checkout should use reservationPolicyFor. */
  expiresAt: string | null;
  metadata?: Record<string, unknown>;
  now: string;
}
export interface PurchaseReservationResult {
  contractVersion: "inventory.v0";
  status: "reserved";
  reservations: {
    orderItemId: string;
    reservationId: string;
    status: "reserved" | "committed" | "consumed" | "released" | "expired";
    replayed: boolean;
  }[];
  replayed: boolean;
}
export interface PurchaseInventoryReservationPort {
  reserveOrderItems(input: PurchaseReservationInput): Promise<PurchaseReservationResult>;
  releaseReservation(input: {
    idempotencyKey: string; reservationId: string; reason: string;
    metadata?: Record<string, unknown>; now: string;
  }): Promise<{ reservationId: string; status: string; replayed: boolean }>;
  expireReservations(input: { now: string; limit?: number }): Promise<{ expiredCount: number }>;
}

/** Native purchase seam. The host authenticates the trusted runtime and wires
 * checkout compensation/expiry. No provider dispatch, order cancellation or renewal mutation. */
export function createPostgresPurchaseReservationPort(executor: PurchaseReservationExecutor): PurchaseInventoryReservationPort {
  async function call<T>(sql: string, values: unknown[]): Promise<T> {
    const { rows } = await executor.query(sql, values).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "55P03") {
          throw new InventoryPersistenceError("Inventory admission temporarily unavailable", {
            code: "55P03", reason: "message" in error && error.message === "inventory_admission_busy"
              ? "inventory_admission_busy" : "inventory_lock_unavailable",
          });
        }
        if (error.code === "22023" && "message" in error && error.message === "inventory_admission_isolation_unsupported") {
          throw new InventoryPersistenceError("Inventory reservation RPC failed", { code: error.code });
        }
      }
      throw error;
    });
    const result = rows[0]?.result;
    if (rows.length !== 1 || !result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("fulfillment_purchase_reservation_response_invalid");
    }
    return result as T;
  }
  return {
    reserveOrderItems: input => call(`SELECT public.fulfillment_reserve_purchase_order_items(
      $1::text,$2::uuid,$3::text,$4::jsonb,$5::text,$6::timestamptz,$7::jsonb,$8::timestamptz) AS result`, [
      input.idempotencyKey, input.orderId, input.stockSourceKey, JSON.stringify(input.items),
      input.paymentStatus, input.expiresAt, JSON.stringify(input.metadata ?? {}), input.now,
    ]),
    releaseReservation: input => call(`SELECT public.fulfillment_release_purchase_reservation(
      $1::text,$2::uuid,$3::text,$4::jsonb,$5::timestamptz) AS result`, [
      input.idempotencyKey, input.reservationId, input.reason, JSON.stringify(input.metadata ?? {}), input.now,
    ]),
    expireReservations: input => call(`SELECT public.fulfillment_expire_purchase_reservations(
      $1::timestamptz,$2::integer) AS result`, [input.now, input.limit ?? 100]),
  };
}

/** Host-bound native cancellation and purchase release in one SQL transaction.
 * The caller withholds abandoned-order compensation for uncertain dispatch. */
export function createPostgresAbandonedCheckoutCompensationPort(
  executor: PurchaseReservationExecutor,
  now: () => string = () => new Date().toISOString(),
): {
  cancelAbandonedOrder(input: {
    idempotencyKey: string; orderId: string; reason: string;
  }): Promise<{ cancelled: boolean }>;
} {
  return {
    async cancelAbandonedOrder(input) {
      const { rows } = await executor.query(`SELECT public.commerce_cancel_abandoned_purchase_checkout(
        $1::text,$2::uuid,$3::text,$4::timestamptz) AS result`, [input.idempotencyKey, input.orderId, input.reason, now()]);
      const result = rows[0]?.result;
      if (rows.length !== 1 || !result || typeof result !== "object" || Array.isArray(result)
        || typeof (result as Record<string, unknown>).cancelled !== "boolean") {
        throw new Error("commerce_checkout_compensation_response_invalid");
      }
      return { cancelled: (result as Record<string, unknown>).cancelled === true };
    },
  };
}
