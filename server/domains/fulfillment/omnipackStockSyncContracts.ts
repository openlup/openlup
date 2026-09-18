import type { InventoryStockLine } from "../../../src/domains/inventory/contracts.js";

export interface OmnipackStockEvidence {
  provider: "omnipack";
  sku: string;
  totalQuantity: number;
  forSaleQuantity: number;
  reservedOrUnavailableQuantity: number;
}

export interface OmnipackStockMovementEvidence {
  provider: "omnipack";
  sku: string;
  occurredAt: string | null;
  quantity: number;
  operationType: string | null;
  warehouseDocumentNumber: string | null;
  lotNumber: string | null;
  expirationDate: string | null;
}

export interface OmnipackStockSyncProvider {
  getStock(): Promise<OmnipackStockEvidence[]>;
  getStockMovements(params?: { startLocalDate?: string; endLocalDate?: string; size?: number }): Promise<OmnipackStockMovementEvidence[]>;
}

export interface OmnipackLocalInventoryBalance {
  sku: string;
  onHand: number;
  reserved: number;
  unavailable: number;
  safetyStock: number;
}

export type OmnipackStockMismatchKind = "none";
export type OmnipackInventoryClass = "sellable" | "packaging";
export type OmnipackLowStockThresholdKind = "safety_stock" | "reservation_coverage" | "forecast" | "stale_sync";

export interface OmnipackStockSyncCursor {
  status: "idle" | "running" | "succeeded" | "failed";
  lastStockSyncedAt: string | null;
  lastMovementOccurredAt: string | null;
  cursor: Record<string, unknown>;
}

export interface OmnipackStockSyncPort {
  readCursor(): Promise<OmnipackStockSyncCursor | null>;
  readLocalInventoryStock(): Promise<InventoryStockLine[]>;
  readSkuInventoryClasses(skus: string[]): Promise<Map<string, OmnipackInventoryClass | null>>;
  readActiveReservations(skus: string[], requestedAt: string): Promise<Map<string, number>>;
  recordCursor(input: { status: "running" | "succeeded" | "failed"; lastStockSyncedAt: string | null; lastMovementOccurredAt: string | null; cursor: Record<string, unknown>; error: Record<string, unknown> }): Promise<void>;
  recordStockSnapshot(input: { idempotencyKey: string; sku: string; providerTotalQuantity: number; providerForSaleQuantity: number; providerReservedUnavailableQuantity: number; localOnHand: number; localReserved: number; localUnavailable: number; localSafetyStock: number; mismatchKind: OmnipackStockMismatchKind; inventoryClass: OmnipackInventoryClass | null; syncRunId: string; evidence: Record<string, unknown> }): Promise<{ replayed: boolean; readBack: boolean }>;
  recordProviderStockCurrent(input: { idempotencyKey: string; sku: string; providerTotalQuantity: number; providerForSaleQuantity: number; providerReservedUnavailableQuantity: number; inventoryClass: OmnipackInventoryClass | null; lastSyncedAt: string; staleAfter: string; syncRunId: string; evidence: Record<string, unknown> }): Promise<{ replayed: boolean; readBack: boolean }>;
  recordLowStockEvidence(input: { idempotencyKey: string; sku: string; thresholdKind: Exclude<OmnipackLowStockThresholdKind, "forecast">; severity: "info" | "warning" | "critical"; providerForSaleQuantity: number; localAvailableQuantity: number; evidence: Record<string, unknown> }): Promise<{ replayed: boolean }>;
  resolveLowStockEvidence(input: { sku: string; activeThresholdKinds: OmnipackLowStockThresholdKind[]; syncRunId: string; evidence: Record<string, unknown> }): Promise<{ resolved: number }>;
}

export interface OmnipackStockSyncResult {
  ok: boolean;
  checked: number;
  updated: number;
  mismatches: number;
  reservationCoverage: number;
  unclassified: number;
  lowStock: number;
  movements: number;
  replayed: number;
  failures: number;
  providerCalls: number;
  readBacks: number;
  skipped: boolean;
  reason?: string;
  syncRunId: string;
  lastMovementOccurredAt: string | null;
}
