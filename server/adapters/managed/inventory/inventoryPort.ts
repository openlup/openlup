import { calculateInventoryAtp, availableNow } from "../../../../src/domains/inventory/atp.js";
import {
  INVENTORY_CONTRACT_VERSION,
  type AdminInventoryReservationsRequest,
  type AdminInventoryStockAdjustmentRequest,
  type AdminInventoryStockRequest,
  type InventoryAtpRequest,
  type InventoryAtpResult,
  type InventoryReservationsListResponse,
  type InventoryStockLine,
  type InventoryStockListResponse,
} from "../../../../src/domains/inventory/contracts.js";
import {
  InventoryConflictError,
  InventoryPersistenceError,
  type InventoryMutationPort,
  type InventoryReadPort,
} from "../../../../src/domains/inventory/ports.js";
import { readSubscriptionForecast } from "./subscriptionForecast.js";

export interface ManagedInventoryClient {
  from(table: string): ManagedQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface ManagedQueryBuilder extends PromiseLike<ManagedQueryResult> {
  select(columns: string, options?: Record<string, unknown>): ManagedQueryBuilder;
  order(column: string, options?: Record<string, unknown>): ManagedQueryBuilder;
  eq(column: string, value: unknown): ManagedQueryBuilder;
  in(column: string, values: unknown[]): ManagedQueryBuilder;
  range(from: number, to: number): PromiseLike<ManagedQueryResult>;
}

interface ManagedQueryResult {
  data: unknown;
  error: RpcError | null;
  count?: number | null;
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function createManagedInventoryPort(
  client: ManagedInventoryClient,
): InventoryReadPort & InventoryMutationPort {
  return {
    async listStock(request: AdminInventoryStockRequest): Promise<InventoryStockListResponse> {
      const offset = (request.page - 1) * request.pageSize;
      let query = stockQuery(client);
      if (request.skuId) query = query.eq("sku_id", request.skuId);
      if (request.locationId) query = query.eq("location_id", request.locationId);

      const result = await query.range(offset, offset + request.pageSize - 1);
      if (result.error) throw new InventoryPersistenceError("Inventory stock read failed");
      const stock = ((result.data ?? []) as InventoryBalanceRow[])
        .map(mapStockRow)
        .filter((line) => request.includeZero || availableNow(line) > 0)
        .map((line) => ({ ...line, availableNow: availableNow(line) }));

      return {
        contractVersion: INVENTORY_CONTRACT_VERSION,
        stock,
        totalCount: result.count ?? stock.length,
        page: request.page,
        pageSize: request.pageSize,
      };
    },

    async listReservations(request: AdminInventoryReservationsRequest): Promise<InventoryReservationsListResponse> {
      const offset = (request.page - 1) * request.pageSize;
      let query = client
        .from("inventory_reservations")
        .select("id, order_id, subscription_cycle_id, status, kind, expires_at, created_at", { count: "exact" })
        .order("created_at", { ascending: false });
      if (request.status) query = query.eq("status", request.status);
      if (request.orderId) query = query.eq("order_id", request.orderId);

      const result = await query.range(offset, offset + request.pageSize - 1);
      if (result.error) throw new InventoryPersistenceError("Inventory reservations read failed");
      const rows = (result.data ?? []) as InventoryReservationRow[];
      return {
        contractVersion: INVENTORY_CONTRACT_VERSION,
        reservations: rows.map((row) => ({
          id: row.id,
          orderId: row.order_id,
          subscriptionCycleId: row.subscription_cycle_id,
          status: row.status,
          kind: row.kind,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        })),
        totalCount: result.count ?? rows.length,
        page: request.page,
        pageSize: request.pageSize,
      };
    },

    async checkAtp(request: InventoryAtpRequest): Promise<InventoryAtpResult> {
      const skuIds = [...new Set(request.lines.map((line) => line.skuId))];
      const result = await stockQuery(client).in("sku_id", skuIds);
      if (result.error) throw new InventoryPersistenceError("Inventory ATP read failed");
      return calculateInventoryAtp({
        request,
        stock: ((result.data ?? []) as InventoryBalanceRow[]).map(mapStockRow),
      });
    },

    forecastSubscriptions: (request) => readSubscriptionForecast(client, request),

    async adjustStock(request: AdminInventoryStockAdjustmentRequest & { actorUserId: string }) {
      const { data, error } = await client.rpc("inventory_adjust_stock", {
        p_idempotency_key: request.idempotencyKey,
        p_sku_id: request.skuId,
        p_location_id: request.locationId,
        p_lot_id: request.lotId ?? null,
        p_quantity_delta: request.quantityDelta,
        p_reason: request.reason,
        p_actor_user_id: request.actorUserId,
        p_metadata: { note: request.note ?? null },
      });
      if (error) throw mapRpcError(error);
      return data as { contractVersion: "inventory.v0"; replayed: boolean };
    },
  };
}

function stockQuery(client: ManagedInventoryClient) {
  return client
    .from("inventory_balances")
    .select(
      "sku_id, location_id, lot_id, on_hand, reserved, unavailable, incoming, safety_stock, catalog_skus!inventory_balances_sku_id_fkey!inner(sku), inventory_locations!inventory_balances_location_id_fkey!inner(code, kind, status, fulfillable), inventory_lots!inventory_balances_lot_id_fkey(lot_code, status, expires_at)",
      { count: "exact" },
    )
    .order("updated_at", { ascending: false });
}

function mapStockRow(row: InventoryBalanceRow): InventoryStockLine {
  return {
    skuId: row.sku_id,
    sku: row.catalog_skus?.sku ?? "unknown",
    locationId: row.location_id,
    locationCode: row.inventory_locations?.code ?? "unknown",
    locationKind: row.inventory_locations?.kind ?? "virtual",
    locationStatus: row.inventory_locations?.status ?? "inactive",
    fulfillable: row.inventory_locations?.fulfillable ?? false,
    lotId: row.lot_id,
    lotCode: row.inventory_lots?.lot_code ?? null,
    lotStatus: row.inventory_lots?.status ?? null,
    expiresAt: row.inventory_lots?.expires_at ?? null,
    onHand: row.on_hand,
    reserved: row.reserved,
    unavailable: row.unavailable,
    incoming: row.incoming,
    safetyStock: row.safety_stock,
  };
}

function mapRpcError(error: RpcError): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (error.code === "23505" || /inventory_.*(?:conflict|insufficient|negative|reserved)/.test(text)) {
    return new InventoryConflictError("Inventory mutation conflict", { code: error.code });
  }
  return new InventoryPersistenceError("Inventory RPC failed", { code: error.code });
}

interface InventoryBalanceRow {
  sku_id: string;
  location_id: string;
  lot_id: string | null;
  on_hand: number;
  reserved: number;
  unavailable: number;
  incoming: number;
  safety_stock: number;
  catalog_skus?: { sku?: string } | null;
  inventory_locations?: {
    code?: string;
    kind?: InventoryStockLine["locationKind"];
    status?: InventoryStockLine["locationStatus"];
    fulfillable?: boolean;
  } | null;
  inventory_lots?: {
    lot_code?: string | null;
    status?: InventoryStockLine["lotStatus"];
    expires_at?: string | null;
  } | null;
}

interface InventoryReservationRow {
  id: string;
  order_id: string;
  subscription_cycle_id: string | null;
  status: "reserved" | "released" | "consumed" | "expired";
  kind: "checkout_payment_window" | "subscription_retry_window" | "manual_ops";
  expires_at: string | null;
  created_at: string;
}
