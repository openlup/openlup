import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
  type FinalizedCheckoutOrder,
  type InventoryCheckoutReservationPort,
} from "../../../../src/domains/commerce/runtimePorts.js";
import type { HiddenCheckoutRuntimeReservation } from "../../../../src/domains/commerce/runtimeContracts.js";
import { normalizedTtlMinutes, reservationPolicyFor } from "../../../../src/domains/commerce/reservationPolicy.js";
import type { CheckoutCompensationPort } from "../../../domains/commerce/commerceCheckoutCompensation.js";
export interface ManagedInventoryReservationClient {
  from(table: string): ManagedQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface ManagedQueryBuilder extends PromiseLike<ManagedQueryResult> {
  select(columns: string): ManagedQueryBuilder;
  eq(column: string, value: unknown): ManagedQueryBuilder;
}

interface ManagedQueryResult {
  data: unknown;
  error: RpcError | null;
}
interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}
// The order-cancelling half of the compensation contract is durable persistence,
// not reservation policy, so composition injects it (server/adapters/supabase/commerce/checkoutCompensation.ts).
export type InventoryReservationCompensation = Pick<CheckoutCompensationPort, "cancelAbandonedOrder" | "cancelUnstartedPromotionOrder">;

export function createManagedInventoryReservationPort(
  client: ManagedInventoryReservationClient,
  options: { now?: () => Date; checkoutReservationTtlMinutes?: number | null; legacySchemaFallback?: InventoryReservationLegacySchemaFallbackConfig; compensation?: InventoryReservationCompensation } = {},
): InventoryCheckoutReservationPort & InventoryReservationCompensation {
  const now = options.now ?? (() => new Date());
  const checkoutReservationTtlMinutes =
    options.checkoutReservationTtlMinutes ?? readCheckoutReservationTtlMinutes();
  const legacySchemaFallback = options.legacySchemaFallback ?? { enabled: false, environmentLabel: "unknown" };

  return {
    async reserveOrderItems(input): Promise<HiddenCheckoutRuntimeReservation[]> {
      const reservationKind = input.order.mode === "subscription_cycle" ? "subscription_retry_window" : "checkout_payment_window";
      const policy = reservationPolicyFor({
        reservationKind,
        paymentTargetKind: input.order.mode === "subscription_cycle" ? "subscription_cycle" : "one_time_order",
        orderMode: input.order.mode,
        now: now(),
        checkoutTtlMinutes: checkoutReservationTtlMinutes,
      });
      const providerKind = selectedDeliveryProviderKind(input.metadata);
      const metadata = { source: "commerce.runtime.hidden.v0", ...stockAuthorityMetadata(input.metadata) };
      const batchArgs = {
        p_idempotency_key: input.idempotencyKey,
        p_order_id: input.order.orderId,
        p_subscription_cycle_id: input.order.subscriptionCycleId,
        p_items: input.order.items.map((item) => ({
          orderItemId: item.orderItemId,
          skuId: item.skuId,
          quantity: item.quantity,
        })),
        p_kind: reservationKind,
        p_payment_status: input.paymentStatus,
        p_expires_at: policy.expiresAt,
        p_metadata: metadata,
        p_provider_kind: providerKind,
      };
      const batch = await reserveItemsWithSchemaFallback(client, batchArgs, { providerKind, legacySchemaFallback });
      if (batch.error) throw mapRpcError(batch.error);
      if (!batch.fallback) {
        return mapBatchReservations(batch.data, input.order);
      }
      return reserveOrderItemsOneByOne(client, input, {
        reservationKind,
        expiresAt: policy.expiresAt,
        metadata,
        providerKind,
        legacySchemaFallback,
      });
    },

    async releaseOrderReservations(input): Promise<{ releasedCount: number }> {
      const result = await client
        .from("inventory_reservations")
        .select("id")
        .eq("order_id", input.orderId)
        .eq("status", "reserved");
      if (result.error) throw new CommerceRuntimePersistenceError("Inventory reservation read failed");
      const rows = (result.data ?? []) as Array<{ id: string }>;
      let releasedCount = 0;
      for (const row of rows) {
        const { error } = await client.rpc("inventory_release_reservation", {
          p_idempotency_key: `${input.idempotencyKey}:${row.id}`,
          p_reservation_id: row.id,
          p_reason: input.reason,
          p_metadata: { source: "commerce.runtime.hidden.v0" },
        });
        if (error) throw mapRpcError(error);
        releasedCount += 1;
      }
      return { releasedCount };
    },

    async cancelAbandonedOrder(input: Parameters<CheckoutCompensationPort["cancelAbandonedOrder"]>[0]): Promise<{ cancelled: boolean }> {
      return requireCompensation(options.compensation).cancelAbandonedOrder(input);
    },

    async cancelUnstartedPromotionOrder(input: Parameters<CheckoutCompensationPort["cancelUnstartedPromotionOrder"]>[0]): Promise<{ cancelled: boolean }> {
      return requireCompensation(options.compensation).cancelUnstartedPromotionOrder(input);
    },
  };
}
// Fail closed: a composition wiring this port as the checkout compensation port
// must inject the cancellation half — never report a compensation that never ran.
function requireCompensation(port: InventoryReservationCompensation | undefined): InventoryReservationCompensation {
  if (!port) throw new CommerceRuntimePersistenceError("Checkout compensation adapter not composed");
  return port;
}

type ReserveOrderItemsArgs = {
  p_idempotency_key: string; p_order_id: string; p_subscription_cycle_id: string | null;
  p_items: Array<{ orderItemId: string; skuId: string; quantity: number }>;
  p_kind: string; p_payment_status: string; p_expires_at: string | null;
  p_metadata: Record<string, unknown>; p_provider_kind: string | null;
};

type ReserveOrderArgs = {
  p_idempotency_key: string; p_order_id: string; p_order_item_id: string;
  p_subscription_cycle_id: string | null; p_sku_id: string; p_quantity: number;
  p_kind: string; p_payment_status: string; p_expires_at: string | null;
  p_metadata: Record<string, unknown>; p_provider_kind: string | null;
};

export interface InventoryReservationLegacySchemaFallbackConfig { enabled: boolean; environmentLabel: string }

type ReservationSchemaFallbackContext = { providerKind: string | null; legacySchemaFallback: InventoryReservationLegacySchemaFallbackConfig };

async function reserveItemsWithSchemaFallback(
  client: ManagedInventoryReservationClient,
  args: ReserveOrderItemsArgs,
  context: ReservationSchemaFallbackContext,
): Promise<{ data: unknown; error: RpcError | null; fallback: boolean }> {
  const result = await client.rpc("inventory_reserve_order_items", args);
  if (!result.error || !canRetryLegacyReservationRpc(result.error)) {
    return { ...result, fallback: false };
  }
  if (!context.legacySchemaFallback.enabled) return { ...result, fallback: false };

  console.warn("inventory_reserve_order_items_schema_fallback", fallbackWarningPayload(context));
  return { data: null, error: null, fallback: true };
}

async function reserveOrderItemsOneByOne(
  client: ManagedInventoryReservationClient,
  input: Parameters<InventoryCheckoutReservationPort["reserveOrderItems"]>[0],
  context: {
    reservationKind: string;
    expiresAt: string | null;
    metadata: Record<string, unknown>;
    providerKind: string | null;
    legacySchemaFallback: InventoryReservationLegacySchemaFallbackConfig;
  },
): Promise<HiddenCheckoutRuntimeReservation[]> {
  const reservations: HiddenCheckoutRuntimeReservation[] = [];
  for (const item of input.order.items) {
    const args = {
      p_idempotency_key: `${input.idempotencyKey}:${item.orderItemId}`,
      p_order_id: input.order.orderId,
      p_order_item_id: item.orderItemId,
      p_subscription_cycle_id: input.order.subscriptionCycleId,
      p_sku_id: item.skuId,
      p_quantity: item.quantity,
      p_kind: context.reservationKind,
      p_payment_status: input.paymentStatus,
      p_expires_at: context.expiresAt,
      p_metadata: context.metadata,
      p_provider_kind: context.providerKind,
    };
    const { data, error } = await reserveWithSchemaFallback(client, args, {
      providerKind: context.providerKind, legacySchemaFallback: context.legacySchemaFallback,
    });
    if (error) throw mapRpcError(error);
    reservations.push(mapReservation(data, input.order, item));
  }
  return reservations;
}

async function reserveWithSchemaFallback(
  client: ManagedInventoryReservationClient,
  args: ReserveOrderArgs,
  context: ReservationSchemaFallbackContext,
): Promise<{ data: unknown; error: RpcError | null }> {
  const result = await client.rpc("inventory_reserve_order", args);
  if (!result.error || !canRetryLegacyReservationRpc(result.error)) return result;
  if (!context.legacySchemaFallback.enabled) return result;

  console.warn("inventory_reserve_order_provider_kind_schema_fallback", fallbackWarningPayload(context));
  const { p_provider_kind: _providerKind, ...legacyArgs } = args;
  return client.rpc("inventory_reserve_order", {
    ...legacyArgs,
    p_metadata: {
      source: "commerce.runtime.hidden.v0",
      schemaFallback: "legacy_inventory_reserve_order_without_provider_kind",
    },
  });
}

function selectedDeliveryProviderKind(metadata: Record<string, unknown> | undefined): string | null {
  const direct = readProviderKind((metadata?.selectedDelivery as Record<string, unknown> | undefined)?.providerKind);
  if (direct) return direct;
  const runtimeFinalize = metadata?.runtimeFinalize;
  if (!runtimeFinalize || typeof runtimeFinalize !== "object") return null;
  const selectedDelivery = (runtimeFinalize as Record<string, unknown>).selectedDelivery;
  return readProviderKind((selectedDelivery as Record<string, unknown> | undefined)?.providerKind);
}

function stockAuthorityMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const providerKind = selectedDeliveryProviderKind(metadata);
  if (providerKind !== "omnipack") return {};
  return { providerKind, stockAuthority: "external_stock_master_with_local_reservations" };
}

function readProviderKind(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function readCheckoutReservationTtlMinutes(): number {
  const raw = Number(process.env.COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES);
  return normalizedTtlMinutes(raw);
}

function canRetryLegacyReservationRpc(error: RpcError): boolean {
  const combined = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`;
  return /\bPGRST202\b|\b42883\b|could not find.*function|function .* does not exist|schema cache/i.test(combined);
}

function fallbackWarningPayload(context: ReservationSchemaFallbackContext): string {
  return JSON.stringify({
    providerKind: context.providerKind ?? "local_atp",
    environment: context.legacySchemaFallback.environmentLabel,
  });
}

function mapReservation(
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

function mapBatchReservations(
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

function mapRpcError(error: RpcError): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (error.code === "23505" || /inventory_.*(?:conflict|insufficient|invalid|negative|reserved|not_found|not_releasable)/.test(text)) {
    return new CommerceRuntimeConflictError("Inventory reservation conflict", { code: error.code });
  }
  return new CommerceRuntimePersistenceError("Inventory reservation RPC failed", { code: error.code });
}
