import { CommerceRuntimeConflictError, CommerceRuntimePersistenceError, type FinalizedCheckoutOrder } from "../../../../src/domains/commerce/runtimePorts.js";
import type { HiddenCheckoutRuntimeReservation } from "../../../../src/domains/commerce/runtimeContracts.js";

/** Exact legacy response decoding and scoped error adaptation; execution stays in its port. */
export interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function mapReservation(
  data: unknown,
  _order: FinalizedCheckoutOrder,
  item: FinalizedCheckoutOrder["items"][number],
): HiddenCheckoutRuntimeReservation {
  if (!data || typeof data !== "object") {
    throw new CommerceRuntimePersistenceError("Inventory reservation response invalid");
  }
  const record = data as Record<string, unknown>;
  const reservationId = readString(record, "reservationId");
  const reservationIds = Array.isArray(record.reservationIds)
    ? record.reservationIds.filter((id): id is string => typeof id === "string")
    : [reservationId];
  return {
    reservationId,
    reservationIds,
    orderItemId: item.orderItemId,
    skuId: item.skuId,
    sku: item.sku,
    status: "reserved",
    replayed: record.replayed === true,
  };
}

export function mapBatchReservations(
  data: unknown,
  order: FinalizedCheckoutOrder,
): HiddenCheckoutRuntimeReservation[] {
  if (!data || typeof data !== "object") throw new CommerceRuntimePersistenceError("Inventory reservation response invalid");
  const reservations = (data as Record<string, unknown>).reservations;
  if (!Array.isArray(reservations)) throw new CommerceRuntimePersistenceError("Inventory reservation response invalid");
  return order.items.map((item) => {
    const row = reservations.find((candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null && (candidate as Record<string, unknown>).orderItemId === item.orderItemId,
    );
    if (!row) throw new CommerceRuntimePersistenceError("Inventory reservation response invalid");
    return mapReservation(row, order, item);
  });
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CommerceRuntimePersistenceError("Inventory reservation response invalid");
  }
  return raw;
}

export function mapRpcError(error: RpcError): Error {
  const busy = inventoryAdmissionFailureDetails(error);
  if (busy) return new CommerceRuntimePersistenceError("Inventory admission temporarily unavailable", busy);
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (error.code === "23505" || /inventory_.*(?:conflict|insufficient|invalid|negative|reserved|not_found|not_releasable)/.test(text)) {
    return new CommerceRuntimeConflictError("Inventory reservation conflict", { code: error.code });
  }
  return new CommerceRuntimePersistenceError("Inventory reservation RPC failed", { code: error.code });
}

/** Call only for an RPC whose protected stock work participates in inventory admission. */
function inventoryAdmissionFailureDetails(error: unknown): {
  code: "55P03"; reason: "inventory_admission_busy" | "inventory_lock_unavailable";
} | null {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "55P03") return null;
  return {
    code: "55P03",
    reason: "message" in error && error.message === "inventory_admission_busy"
      ? "inventory_admission_busy" : "inventory_lock_unavailable",
  };
}
