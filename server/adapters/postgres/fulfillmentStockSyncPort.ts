import { createHash } from "node:crypto";
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
const CLASSES_READ = `SELECT sku FROM public.catalog_skus WHERE sku = ANY($1::text[])`;
const CURRENT_WRITE = `SELECT public.fulfillment_record_stock_current(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS response`;
const SNAPSHOT_WRITE = `SELECT public.fulfillment_record_stock_snapshot(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS response`;
const EVIDENCE_WRITE = `SELECT public.fulfillment_record_stock_evidence(
  $1,$2,$3,$4,$5,$6,$7,$8) AS response`;
const EVIDENCE_RESOLVE = `SELECT public.fulfillment_resolve_stock_evidence(
  $1,$2,$3::text[],$4) AS response`;

export interface PostgresFulfillmentStockSyncOptions {
  sourceKey: string;
  inventoryClasses?: ReadonlyMap<string, OmnipackInventoryClass>;
}

/** Direct persistence for the provider-neutral public stock/evidence forward. */
export function createPostgresFulfillmentStockSyncPort(
  executor: PgQueryExecutor,
  options: PostgresFulfillmentStockSyncOptions,
): OmnipackStockSyncPort {
  const sourceKey = options.sourceKey.trim();
  if (!sourceKey) throw new Error("fulfillment_stock_source_key_required");
  return {
    async readCursor() {
      const row = first(await executor.query(CURSOR_READ, [sourceKey]));
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

    async readSkuInventoryClasses(skus) {
      if (skus.length === 0) return new Map();
      const rows = (await executor.query(CLASSES_READ, [skus])).rows;
      const catalog = new Set(rows.map((row) => text(row.sku)).filter(Boolean));
      return new Map(skus.map((sku) => [
        sku,
        options.inventoryClasses?.get(sku) ?? (catalog.has(sku) ? "sellable" : null),
      ]));
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

    async recordStockSnapshot(input) {
      const values = [
        sourceKey, input.idempotencyKey, fingerprint(input), input.sku,
        input.providerTotalQuantity, input.providerForSaleQuantity,
        input.providerReservedUnavailableQuantity, input.localOnHand,
        input.localReserved, input.localUnavailable, input.localSafetyStock,
        input.inventoryClass, input.syncRunId,
      ];
      return replayReadback(first(await executor.query(SNAPSHOT_WRITE, values))?.response);
    },

    async recordProviderStockCurrent(input) {
      const values = [
        sourceKey, input.idempotencyKey, fingerprint(input), input.sku,
        input.providerTotalQuantity, input.providerForSaleQuantity,
        input.providerReservedUnavailableQuantity, input.inventoryClass,
        input.lastSyncedAt, input.staleAfter, input.syncRunId,
      ];
      return replayReadback(first(await executor.query(CURRENT_WRITE, values))?.response);
    },

    async recordLowStockEvidence(input) {
      const values = [
        sourceKey, input.idempotencyKey, fingerprint(input), input.sku,
        input.thresholdKind, input.severity, input.providerForSaleQuantity,
        input.localAvailableQuantity,
      ];
      return { replayed: record(first(await executor.query(EVIDENCE_WRITE, values))?.response).replayed === true };
    },

    async resolveLowStockEvidence(input) {
      const response = record(first(await executor.query(EVIDENCE_RESOLVE, [
        sourceKey, input.sku, input.activeThresholdKinds, input.syncRunId,
      ]))?.response);
      return { resolved: integer(response.resolved) };
    },
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "evidence")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function first(result: { rows: Record<string, unknown>[] }): Record<string, unknown> | null {
  return result.rows[0] ?? null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function nullableText(value: unknown): string | null { return text(value) || null; }
function integer(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
function cursorStatus(value: unknown): "idle" | "running" | "succeeded" | "failed" {
  return value === "running" || value === "succeeded" || value === "failed" ? value : "idle";
}
function replayReadback(value: unknown): { replayed: boolean; readBack: boolean } {
  const result = record(value);
  return { replayed: result.replayed === true, readBack: result.readBack === true };
}
