import { createPostgresFulfillmentStockSyncPort as createPlatformPostgresFulfillmentStockSyncPort } from "@openlup/platform/fulfillment";
import type {
  OmnipackInventoryClass,
  OmnipackStockSyncPort,
} from "../../domains/fulfillment/omnipackStockSyncContracts.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const CURSOR_READ = `SELECT status, last_stock_synced_at, last_movement_occurred_at, cursor
  FROM public.fulfillment_stock_sync_cursors WHERE source_key = $1::text`;
const CURSOR_WRITE = `INSERT INTO public.fulfillment_stock_sync_cursors(
    source_key,status,last_stock_synced_at,last_movement_occurred_at,cursor,error_code,updated_at)
  VALUES($1,$2,$3,$4,$5::jsonb,$6,now()) ON CONFLICT(source_key) DO UPDATE SET
    status=EXCLUDED.status,last_stock_synced_at=EXCLUDED.last_stock_synced_at,
    last_movement_occurred_at=EXCLUDED.last_movement_occurred_at,cursor=EXCLUDED.cursor,
    error_code=EXCLUDED.error_code,updated_at=now()`;

export interface PostgresFulfillmentStockSyncOptions {
  sourceKey: string;
  inventoryClasses?: ReadonlyMap<string, OmnipackInventoryClass>;
}

/** Direct persistence for the provider-neutral public stock/evidence forward,
 * delegating SKU classification and stock/evidence writes to @openlup/platform/fulfillment. */
export function createPostgresFulfillmentStockSyncPort(
  executor: PgQueryExecutor,
  options: PostgresFulfillmentStockSyncOptions,
): OmnipackStockSyncPort {
  const sourceKey = options.sourceKey.trim();
  const platformPort = createPlatformPostgresFulfillmentStockSyncPort(executor, {
    sourceKey,
    inventoryClasses: options.inventoryClasses,
    readLocalInventoryStock: async () => [],
  });
  return {
    async readCursor() {
      const row = executor.query ? (await executor.query(CURSOR_READ, [sourceKey])).rows[0] : null;
      if (!row) return null;
      return {
        status: cursorStatus(row.status),
        cursor: record(row.cursor),
        lastStockSyncedAt: nullableText(row.last_stock_synced_at),
        lastMovementOccurredAt: nullableText(row.last_movement_occurred_at),
      };
    },

    // The public platform has no inventory-balance relation. An empty local
    // projection is truthful: the worker still persists the external
    // observation, but never invents local on-hand or availability.
    async readLocalInventoryStock() { return []; },

    readSkuInventoryClasses(skus) {
      return platformPort.readSkuInventoryClasses(skus);
    },

    // Reservation truth belongs to a later inventory rail. Returning no rows
    // means "this kernel has no reservations", not a fabricated quantity.
    async readActiveReservations() { return new Map(); },

    async recordCursor(input) {
      const reason = text(input.error.reason).slice(0, 180) || null;
      await executor.query(CURSOR_WRITE, [
        sourceKey, input.status, input.lastStockSyncedAt,
        input.lastMovementOccurredAt, JSON.stringify(input.cursor), reason,
      ]);
    },

    recordStockSnapshot(input) {
      return platformPort.recordStockSnapshot({
        requestKey: input.idempotencyKey,
        snapshot: {
          providerRef: sourceKey,
          collectedAt: "",
          sourceRevision: null,
          revisionSource: "collection",
          quantityKind: "snapshot",
          skuRef: input.sku,
          totalQuantity: input.providerTotalQuantity,
          forSaleQuantity: input.providerForSaleQuantity,
          reservedOrUnavailableQuantity: input.providerReservedUnavailableQuantity,
          syncRunId: input.syncRunId,
        },
        local: {
          skuRef: input.sku,
          onHand: input.localOnHand,
          reserved: input.localReserved,
          unavailable: input.localUnavailable,
          safetyStock: input.localSafetyStock,
        },
        mismatchKind: input.mismatchKind,
        inventoryClass: input.inventoryClass,
      });
    },

    recordProviderStockCurrent(input) {
      return platformPort.recordProviderStockCurrent({
        requestKey: input.idempotencyKey,
        snapshot: {
          providerRef: sourceKey,
          collectedAt: input.lastSyncedAt,
          sourceRevision: null,
          revisionSource: "collection",
          quantityKind: "snapshot",
          skuRef: input.sku,
          totalQuantity: input.providerTotalQuantity,
          forSaleQuantity: input.providerForSaleQuantity,
          reservedOrUnavailableQuantity: input.providerReservedUnavailableQuantity,
          syncRunId: input.syncRunId,
        },
        inventoryClass: input.inventoryClass,
        lastSyncedAt: input.lastSyncedAt,
        staleAfter: input.staleAfter,
      });
    },

    recordLowStockEvidence(input) {
      return platformPort.recordLowStockEvidence({
        requestKey: input.idempotencyKey,
        skuRef: input.sku,
        thresholdKind: input.thresholdKind,
        severity: input.severity,
        providerForSaleQuantity: input.providerForSaleQuantity,
        localAvailableQuantity: input.localAvailableQuantity,
        syncRunId: "",
      });
    },

    resolveLowStockEvidence(input) {
      return platformPort.resolveLowStockEvidence({
        skuRef: input.sku,
        activeThresholdKinds: input.activeThresholdKinds,
        syncRunId: input.syncRunId,
      });
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function nullableText(value: unknown): string | null { return text(value) || null; }
function cursorStatus(value: unknown): "idle" | "running" | "succeeded" | "failed" {
  return value === "running" || value === "succeeded" || value === "failed" ? value : "idle";
}
