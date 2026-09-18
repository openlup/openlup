import type { OmnipackStockSyncPort } from "../../domains/fulfillment/omnipackStockSyncContracts.js";
import type { InventoryStockLine } from "../../../src/domains/inventory/contracts.js";

export interface OmnipackStockSyncSupabaseClient {
  from(table: string): SupabaseQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface SupabaseOmnipackStockSyncPortOptions {
  inventoryClasses?: ReadonlyMap<string, "sellable" | "packaging">;
}

interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns?: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  in(column: string, values: unknown[]): PromiseLike<SupabaseQueryResult>;
  maybeSingle(): PromiseLike<SupabaseQueryResult>;
}

interface SupabaseQueryResult {
  data: unknown;
  error: RpcError | null;
}

interface RpcError {
  code?: string;
  message?: string;
}

export function createSupabaseOmnipackStockSyncPort(
  client: OmnipackStockSyncSupabaseClient,
  options: SupabaseOmnipackStockSyncPortOptions = {},
): OmnipackStockSyncPort {
  return {
    async readCursor() {
      const result = await client
        .from("omnipack_stock_sync_cursors")
        .select("status, cursor, last_stock_synced_at, last_movement_occurred_at")
        .eq("provider_kind", "omnipack")
        .maybeSingle();
      if (result.error) throw new Error(`omnipack_stock_sync_cursor_read_failed:${result.error.code ?? "unknown"}`);
      const row = result.data as Record<string, unknown> | null;
      return row
        ? {
            status: readCursorStatus(row.status),
            cursor: asRecord(row.cursor),
            lastStockSyncedAt: readNullableText(row.last_stock_synced_at),
            lastMovementOccurredAt: readNullableText(row.last_movement_occurred_at),
          }
        : null;
    },

    async readLocalInventoryStock(): Promise<InventoryStockLine[]> {
      const result = await client
        .from("inventory_balances")
        .select("sku_id, location_id, lot_id, on_hand, reserved, unavailable, incoming, safety_stock, catalog_skus!inventory_balances_sku_id_fkey!inner(sku), inventory_locations!inventory_balances_location_id_fkey!inner(code, kind, status, fulfillable), inventory_lots!inventory_balances_lot_id_fkey(lot_code, status, expires_at)");
      if (result.error) throw new Error(`omnipack_stock_sync_inventory_read_failed:${result.error.code ?? "unknown"}`);
      return (Array.isArray(result.data) ? result.data : []).map(mapStockRow);
    },

    async readSkuInventoryClasses(skus) {
      if (skus.length === 0) return new Map();
      const catalogResult = await client
        .from("catalog_skus")
        .select("sku")
        .in("sku", skus);
      if (catalogResult.error) throw new Error(`omnipack_stock_sync_catalog_read_failed:${catalogResult.error.code ?? "unknown"}`);

      const result = new Map<string, "sellable" | "packaging" | null>();
      for (const raw of Array.isArray(catalogResult.data) ? catalogResult.data : []) {
        const row = asRecord(raw);
        const sku = readNullableText(row.sku);
        if (sku) result.set(sku, "sellable");
      }
      for (const sku of skus) {
        const configuredClass = options.inventoryClasses?.get(sku);
        if (configuredClass) result.set(sku, configuredClass);
      }
      for (const sku of skus) if (!result.has(sku)) result.set(sku, null);
      return result;
    },

    async readActiveReservations(skus, requestedAt) {
      if (skus.length === 0) return new Map();
      const result = await client
        .from("inventory_reservations")
        .select("quantity, status, expires_at, metadata, catalog_skus!inventory_reservations_sku_id_fkey!inner(sku), commerce_orders!inventory_reservations_order_id_fkey!inner(status)")
        .in("catalog_skus.sku", skus);
      if (result.error) throw new Error(`omnipack_stock_sync_reservations_read_failed:${result.error.code ?? "unknown"}`);

      const reservedBySku = new Map<string, number>();
      for (const raw of Array.isArray(result.data) ? result.data : []) {
        const row = asRecord(raw);
        const sku = readSku(row.catalog_skus);
        const orderStatus = readNullableText(asRecord(row.commerce_orders).status);
        const expiresAt = readNullableText(row.expires_at);
        if (!sku || row.status !== "reserved") continue;
        if (readNullableText(asRecord(row.metadata).providerKind) !== "omnipack") continue;
        if (orderStatus && TERMINAL_ORDER_STATUSES.has(orderStatus)) continue;
        if (expiresAt && Date.parse(expiresAt) <= Date.parse(requestedAt)) continue;
        reservedBySku.set(sku, (reservedBySku.get(sku) ?? 0) + readInteger(row.quantity));
      }
      return reservedBySku;
    },

    async recordCursor(input): Promise<void> {
      const { error } = await client.rpc("omnipack_upsert_stock_sync_cursor", {
        p_status: input.status,
        p_last_stock_synced_at: input.lastStockSyncedAt,
        p_last_movement_occurred_at: input.lastMovementOccurredAt,
        p_cursor: input.cursor,
        p_error: input.error,
      });
      if (error) throw new Error(`omnipack_stock_sync_cursor_write_failed:${error.code ?? "unknown"}`);
    },

    async recordStockSnapshot(input): Promise<{ replayed: boolean; readBack: boolean }> {
      const { data, error } = await client.rpc("omnipack_record_stock_snapshot", {
        p_idempotency_key: input.idempotencyKey,
        p_sku: input.sku,
        p_provider_total_quantity: input.providerTotalQuantity,
        p_provider_for_sale_quantity: input.providerForSaleQuantity,
        p_provider_reserved_unavailable_quantity: input.providerReservedUnavailableQuantity,
        p_local_on_hand: input.localOnHand,
        p_local_reserved: input.localReserved,
        p_local_unavailable: input.localUnavailable,
        p_local_safety_stock: input.localSafetyStock,
        p_mismatch_kind: input.mismatchKind,
        p_inventory_class: input.inventoryClass,
        p_sync_run_id: input.syncRunId,
        p_evidence: input.evidence,
      });
      if (error) throw new Error(`omnipack_stock_sync_snapshot_write_failed:${error.code ?? "unknown"}`);

      const readBack = await client
        .from("omnipack_stock_snapshots")
        .select("idempotency_key, sku, mismatch_kind")
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      if (readBack.error) throw new Error(`omnipack_stock_sync_snapshot_readback_failed:${readBack.error.code ?? "unknown"}`);
      const row = readBack.data as Record<string, unknown> | null;

      return {
        replayed: (data as Record<string, unknown> | null)?.replayed === true,
        readBack: row?.idempotency_key === input.idempotencyKey && row.sku === input.sku,
      };
    },

    async recordProviderStockCurrent(input): Promise<{ replayed: boolean; readBack: boolean }> {
      const { data, error } = await client.rpc("fulfillment_provider_upsert_stock_current", {
        p_idempotency_key: input.idempotencyKey,
        p_provider_kind: "omnipack",
        p_sku: input.sku,
        p_provider_total_quantity: input.providerTotalQuantity,
        p_provider_for_sale_quantity: input.providerForSaleQuantity,
        p_provider_reserved_unavailable_quantity: input.providerReservedUnavailableQuantity,
        p_inventory_class: input.inventoryClass,
        p_last_synced_at: input.lastSyncedAt,
        p_stale_after: input.staleAfter,
        p_sync_run_id: input.syncRunId,
        p_evidence: input.evidence,
      });
      if (error) throw new Error(`omnipack_stock_sync_current_write_failed:${error.code ?? "unknown"}`);

      const readBack = await client
        .from("fulfillment_provider_stock_current")
        .select("provider_kind, sku, provider_for_sale_quantity, stale_after")
        .eq("provider_kind", "omnipack")
        .eq("sku", input.sku)
        .maybeSingle();
      if (readBack.error) throw new Error(`omnipack_stock_sync_current_readback_failed:${readBack.error.code ?? "unknown"}`);
      const row = readBack.data as Record<string, unknown> | null;

      return {
        replayed: (data as Record<string, unknown> | null)?.replayed === true,
        readBack: row?.provider_kind === "omnipack" && row.sku === input.sku,
      };
    },

    async recordLowStockEvidence(input): Promise<{ replayed: boolean }> {
      const { data, error } = await client.rpc("omnipack_record_low_stock_evidence", {
        p_idempotency_key: input.idempotencyKey,
        p_sku: input.sku,
        p_threshold_kind: input.thresholdKind,
        p_severity: input.severity,
        p_provider_for_sale_quantity: input.providerForSaleQuantity,
        p_local_available_quantity: input.localAvailableQuantity,
        p_forecast_days: null,
        p_evidence: input.evidence,
      });
      if (error) throw new Error(`omnipack_stock_sync_low_stock_write_failed:${error.code ?? "unknown"}`);
      return { replayed: (data as Record<string, unknown> | null)?.replayed === true };
    },

    async resolveLowStockEvidence(input): Promise<{ resolved: number }> {
      const { data, error } = await client.rpc("omnipack_resolve_low_stock_evidence", {
        p_sku: input.sku,
        p_active_threshold_kinds: input.activeThresholdKinds,
        p_sync_run_id: input.syncRunId,
        p_evidence: input.evidence,
      });
      if (error) throw new Error(`omnipack_stock_sync_low_stock_resolve_failed:${error.code ?? "unknown"}`);
      const resolved = (data as Record<string, unknown> | null)?.resolved;
      return { resolved: typeof resolved === "number" ? resolved : 0 };
    },
  };
}

function mapStockRow(raw: unknown): InventoryStockLine {
  const row = raw as Record<string, unknown>;
  const location = asRecord(row.inventory_locations);
  const lot = asRecord(row.inventory_lots);
  return {
    skuId: readText(row.sku_id, "00000000-0000-4000-8000-000000000000"),
    sku: readSku(row.catalog_skus) || "unknown",
    locationId: readText(row.location_id, "00000000-0000-4000-8000-000000000000"),
    locationCode: readText(location.code, "unknown"),
    locationKind: readLocationKind(location.kind),
    locationStatus: location.status === "active" ? "active" : "inactive",
    fulfillable: location.fulfillable === true,
    lotId: readNullableText(row.lot_id),
    lotCode: readNullableText(lot.lot_code),
    lotStatus: readLotStatus(lot.status),
    expiresAt: readNullableText(lot.expires_at),
    onHand: readInteger(row.on_hand),
    reserved: readInteger(row.reserved),
    unavailable: readInteger(row.unavailable),
    incoming: readInteger(row.incoming),
    safetyStock: readInteger(row.safety_stock),
  };
}

function readSku(value: unknown): string {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" && typeof (row as Record<string, unknown>).sku === "string"
    ? String((row as Record<string, unknown>).sku)
    : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readLocationKind(value: unknown): InventoryStockLine["locationKind"] {
  return value === "internal_warehouse" || value === "third_party_logistics" || value === "supplier" || value === "quarantine" || value === "virtual"
    ? value
    : "virtual";
}

function readLotStatus(value: unknown): InventoryStockLine["lotStatus"] {
  return value === "available" || value === "quarantined" || value === "expired" || value === "recalled" ? value : null;
}

const TERMINAL_ORDER_STATUSES = new Set(["cancelled", "failed", "expired"]);

function readCursorStatus(value: unknown): "idle" | "running" | "succeeded" | "failed" {
  return value === "running" || value === "succeeded" || value === "failed" ? value : "idle";
}
