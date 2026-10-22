import type { FulfillmentRefusal } from "./dispatch.js";
/** Collection identity never masquerades as a monotonic provider revision. */
interface SyncIdentity {
  providerRef: string; syncRunId: string; collectedAt: string;
  sourceRevision: string | null; revisionSource: "provider" | "collection" | "unknown";
}
export interface StockSnapshot extends SyncIdentity {
  skuRef: string; quantityKind: "snapshot"; totalQuantity: number; forSaleQuantity: number; reservedOrUnavailableQuantity: number;
}
export interface StockMovement extends SyncIdentity {
  skuRef: string; quantityKind: "movement"; quantity: number; occurredAt: string | null;
  operationType: string | null; documentRef: string | null; lotRef: string | null; expirationDate: string | null;
}
export interface SyncCursor {
  status: "idle" | "running" | "succeeded" | "failed";
  lastStockSyncedAt: string | null; lastMovementOccurredAt: string | null;
  /** Sanitized continuation only; no credentials, URLs or arbitrary provider payload. */
  continuation: { nextRef: string | null; startLocalDate: string | null; endLocalDate: string | null };
  /** G15: successful sellable coverage gaps; legacy absent values read as []. */
  coverageGapSkus?: readonly string[];
  refusal: FulfillmentRefusal | null;
  /** Bounded diagnostics and run evidence in the existing cursor JSON, never raw errors. */
  syncRunId?: string;
  counts?: { checked: number; updated: number; movements: number; rejected: number; failures: number; providerCalls: number; readBacks: number };
  items?: readonly { itemIndex: number; skuRef: string | null; status: "recorded" | "failed" | "rejected"; reason?: string;
    activeReserved?: number; sellableNow?: number | null; coverageGapQuantity?: number }[];
  alerts?: readonly { skuRef: string; thresholdKind: Exclude<Threshold, "forecast">; severity: "info" | "warning" | "critical";
    providerForSaleQuantity: number; localAvailableQuantity: number; detectedAt: string;
    activeReserved?: number; coverageGapQuantity?: number; gapHours?: number; thresholdHours?: number }[];
  staleSync?: { gapHours: number; thresholdHours: number; detectedAt: string };
  error?: { reason: string; providerError?: { operation: "get_stock" | "get_stock_movements"; status: number | null; code: string; retryable: boolean } } | null;
}
export interface LocalStock { skuRef: string; onHand: number; reserved: number; unavailable: number; safetyStock: number }
type Threshold = "safety_stock" | "reservation_coverage" | "forecast" | "stale_sync";
type Conflict = "unknown_sku" | "ean_conflict" | "kind_quantity_conflict";
export interface FulfillmentStockSyncProvider {
  /** Rejected rows carry only their input index and a closed reason, never an unsafe reference. */
  getStock(): Promise<(StockSnapshot | { kind: "rejected"; itemIndex: number; reason: "invalid_sku_ref" })[]>;
  getStockMovements(input?: { startLocalDate?: string; endLocalDate?: string; size?: number }): Promise<(StockMovement | { kind: "rejected"; itemIndex: number; reason: "invalid_sku_ref" })[]>;
}
export interface FulfillmentStockSyncPort {
  readCursor(): Promise<SyncCursor | null>;
  /** G16: unaggregated lines at the worker clock; quantity retains the four local balances. */
  readLocalInventoryStock(requestedAt: string): Promise<readonly {
    skuRef: string; quantity: Pick<LocalStock, "onHand" | "reserved" | "unavailable" | "safetyStock">;
    fulfillable: boolean; locationStatus: "active" | "inactive";
    lotStatus: "available" | "quarantined" | "expired" | "recalled" | null; expiresAt: string | null;
  }[]>;
  readSkuInventoryClasses(skus: string[]): Promise<Map<string, "sellable" | "packaging" | null>>;
  readActiveReservations(skus: string[], requestedAt: string): Promise<Map<string, number>>;
  recordCursor(input: SyncCursor): Promise<void>;
  recordStockSnapshot(input: { requestKey: string; snapshot: StockSnapshot; local: LocalStock; mismatchKind: "none"; inventoryClass: "sellable" | "packaging" | null }): Promise<{ replayed: boolean; readBack: boolean }>;
  recordProviderStockCurrent(input: { requestKey: string; snapshot: StockSnapshot; inventoryClass: "sellable" | "packaging" | null; lastSyncedAt: string; staleAfter: string }): Promise<{ replayed: boolean; readBack: boolean }>;
  recordMovement(input: { requestKey: string; movement: StockMovement }): Promise<{ replayed: boolean; readBack: boolean }>;
  recordLowStockEvidence(input: { requestKey: string; skuRef: string; thresholdKind: Exclude<Threshold, "forecast">; severity: "info" | "warning" | "critical"; providerForSaleQuantity: number; localAvailableQuantity: number; syncRunId: string }): Promise<{ replayed: boolean }>;
  resolveLowStockEvidence(input: { skuRef: string; activeThresholdKinds: Threshold[]; syncRunId: string }): Promise<{ resolved: number }>;
}
interface ProductPack { ean: string; quantity: number }
export interface FulfillmentProductSyncProvider {
  /** null means skipped (no private push metadata), never a newly created local SKU. */
  ensureProduct(sku: string): Promise<{ replayed: boolean } | null>;
  getProductPacks(sku: string): Promise<ProductPack[]>;
  addProductPack(sku: string, pack: ProductPack): Promise<void>;
  listStockedSkus(): Promise<string[]>;
}
export interface FulfillmentProductSyncPort {
  listLocalProductPacks(): Promise<{ sku: string; packs: (ProductPack & { kind: "unit" | "collective" })[] }[]>;
  markPackSynced(input: { sku: string; ean: string }): Promise<void>;
  upsertPulledPack(input: { sku: string; ean: string; quantity: number; kind: "unit" | "collective" }): Promise<{ conflict: "none" | "local_locked_mismatch" | "ean_owned_by_other_sku" | "sku_not_found"; replayed: boolean }>;
  recordReconciliationEvidence(input: { requestKey: string; sku: string; ean: string | null; conflictKind: Conflict; providerQuantity: number; identity: SyncIdentity; refusal: FulfillmentRefusal | null }): Promise<{ replayed: boolean }>;
  resolveReconciliationEvidence(input: { sku: string; activeConflictKinds: Conflict[]; syncRunId: string }): Promise<{ resolved: number }>;
}
