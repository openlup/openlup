import { aggregateAtpCompatibleStock, stockMovementWindow } from "./omnipackStockAvailability.js";
import { safeReason } from "./omnipackReconciliationPayload.js";
import type { OmnipackLocalInventoryBalance, OmnipackLowStockThresholdKind, OmnipackStockEvidence, OmnipackStockMovementEvidence, OmnipackStockSyncPort, OmnipackStockSyncProvider, OmnipackStockSyncResult } from "./omnipackStockSyncContracts.js";
export type { OmnipackInventoryClass, OmnipackLocalInventoryBalance, OmnipackLowStockThresholdKind, OmnipackStockEvidence, OmnipackStockMismatchKind, OmnipackStockMovementEvidence, OmnipackStockSyncCursor, OmnipackStockSyncPort, OmnipackStockSyncProvider, OmnipackStockSyncResult } from "./omnipackStockSyncContracts.js";

// Sentinel SKU for the global "stock sync is stale" evidence row (record RPC leaves
// catalog_sku_id NULL when the sku matches no catalog row). Default gap = 6h; evidence/warn only.
export const OMNIPACK_STALE_SYNC_EVIDENCE_SKU = "__omnipack_stock_sync__";
export const OMNIPACK_STALE_SYNC_DEFAULT_THRESHOLD_HOURS = 6;

export async function runOmnipackStockSyncWorker(input: {
  port: OmnipackStockSyncPort;
  provider: OmnipackStockSyncProvider;
  movementBatchSize: number;
  staleSyncThresholdHours?: number;
  now?: () => Date;
}): Promise<OmnipackStockSyncResult> {
  const now = input.now?.() ?? new Date();
  const staleThresholdHours = input.staleSyncThresholdHours && input.staleSyncThresholdHours > 0
    ? input.staleSyncThresholdHours
    : OMNIPACK_STALE_SYNC_DEFAULT_THRESHOLD_HOURS;
  const syncRunId = `omnipack-stock-sync:${now.toISOString()}`;
  const result: OmnipackStockSyncResult = {
    ok: true,
    checked: 0,
    updated: 0,
    mismatches: 0,
    reservationCoverage: 0,
    unclassified: 0,
    lowStock: 0,
    movements: 0,
    replayed: 0,
    failures: 0,
    providerCalls: 0,
    readBacks: 0,
    skipped: false,
    syncRunId,
    lastMovementOccurredAt: null,
  };

  const previousCursor = await input.port.readCursor();

  // Stale-sync alert: if the last successful sync aged past the threshold, open a stale_sync
  // low-stock evidence row (evidence/warn — never blocks sales); a healthy run resolves it
  // below. A never-synced state (no prior cursor) is not "stale".
  const lastSyncedMs = previousCursor?.lastStockSyncedAt ? Date.parse(previousCursor.lastStockSyncedAt) : null;
  const staleGapHours =
    lastSyncedMs !== null && !Number.isNaN(lastSyncedMs) ? (now.getTime() - lastSyncedMs) / 3_600_000 : null;
  const syncIsStale = staleGapHours !== null && staleGapHours >= staleThresholdHours;
  if (syncIsStale) {
    await input.port.recordLowStockEvidence({
      idempotencyKey: `stale_sync:${previousCursor!.lastStockSyncedAt}`,
      sku: OMNIPACK_STALE_SYNC_EVIDENCE_SKU,
      thresholdKind: "stale_sync",
      severity: "warning",
      providerForSaleQuantity: 0,
      localAvailableQuantity: 0,
      evidence: { kind: "stale_stock_sync", lastStockSyncedAt: previousCursor!.lastStockSyncedAt, gapHours: Math.round(staleGapHours! * 10) / 10, thresholdHours: staleThresholdHours, detectedAt: now.toISOString() },
    });
  }

  await input.port.recordCursor({
    status: "running",
    lastStockSyncedAt: null,
    lastMovementOccurredAt: null,
    cursor: { syncRunId },
    error: {},
  });

  const [localStock, providerStock] = await Promise.all([
    input.port.readLocalInventoryStock(),
    input.provider.getStock(),
  ]);
  result.providerCalls += 1;

  const stockItems = providerStock.filter((item) => item.sku.trim());
  const skus = [...new Set(stockItems.map((item) => item.sku))];
  const [inventoryClasses, activeReservations] = await Promise.all([
    input.port.readSkuInventoryClasses(skus),
    input.port.readActiveReservations(skus, now.toISOString()),
  ]);

  const movements = await input.provider.getStockMovements({ ...stockMovementWindow(previousCursor, now), size: input.movementBatchSize });
  result.providerCalls += 1;
  result.movements = movements.length;
  result.lastMovementOccurredAt = latestOccurredAt(movements);

  const localBySku = aggregateAtpCompatibleStock(localStock, now);
  const coverageCandidates: Array<{
    stock: OmnipackStockEvidence;
    local: OmnipackLocalInventoryBalance;
    activeReserved: number;
  }> = [];
  const currentCoverageGapSkus = new Set<string>();
  const packagingSkus = new Set<string>();
  const previousCoverageGapSkus = previousCursor?.status === "succeeded"
    ? readStringSet(previousCursor.cursor.coverageGapSkus)
    : new Set<string>();

  for (const stock of stockItems) {
    try {
      const local = localBySku.get(stock.sku) ?? emptyLocal(stock.sku);
      const inventoryClass = inventoryClasses.get(stock.sku) ?? null;
      const activeReserved = activeReservations.get(stock.sku) ?? 0;
      const staleAfter = new Date(now.getTime() + staleThresholdHours * 3_600_000).toISOString();
      const current = await input.port.recordProviderStockCurrent({
        idempotencyKey: `${syncRunId}:current:${stock.sku}`,
        sku: stock.sku,
        providerTotalQuantity: stock.totalQuantity,
        providerForSaleQuantity: stock.forSaleQuantity,
        providerReservedUnavailableQuantity: stock.reservedOrUnavailableQuantity,
        inventoryClass,
        lastSyncedAt: now.toISOString(),
        staleAfter,
        syncRunId,
        evidence: {
          provider: "omnipack",
          source: "stock_sync",
          stockAuthority: "external_stock_master_with_local_reservations",
        },
      });
      const snapshot = await input.port.recordStockSnapshot({
        idempotencyKey: `${syncRunId}:snapshot:${stock.sku}`,
        sku: stock.sku,
        providerTotalQuantity: stock.totalQuantity,
        providerForSaleQuantity: stock.forSaleQuantity,
        providerReservedUnavailableQuantity: stock.reservedOrUnavailableQuantity,
        localOnHand: local.onHand,
        localReserved: local.reserved,
        localUnavailable: local.unavailable,
        localSafetyStock: local.safetyStock,
        mismatchKind: "none",
        inventoryClass,
        syncRunId,
        evidence: {
          provider: "omnipack",
          source: "stock_sync",
          activeReservedQuantity: activeReserved,
          sellableNow: inventoryClass === "sellable"
            ? Math.max(0, stock.forSaleQuantity - activeReserved - local.safetyStock)
            : null,
          salesLimitMode: "warn",
        },
      });

      result.checked += 1;
      result.updated += (snapshot.replayed ? 0 : 1) + (current.replayed ? 0 : 1);
      if (snapshot.replayed) result.replayed += 1;
      if (current.replayed) result.replayed += 1;
      if (snapshot.readBack) result.readBacks += 1;
      if (current.readBack) result.readBacks += 1;
      if (inventoryClass === null) result.unclassified += 1;
      if (inventoryClass === "packaging") packagingSkus.add(stock.sku);
      if (inventoryClass === "sellable") {
        coverageCandidates.push({ stock, local, activeReserved });
        if (activeReserved > stock.forSaleQuantity) currentCoverageGapSkus.add(stock.sku);
      }
    } catch (error) {
      result.ok = false;
      result.failures += 1;
      result.reason = result.reason ?? safeReason(error);
    }
  }

  if (result.ok) {
    for (const { stock, local, activeReserved } of coverageCandidates) {
      const localAvailable = availableQuantity(local);
      const confirmedCoverageGap = currentCoverageGapSkus.has(stock.sku) && previousCoverageGapSkus.has(stock.sku);
      const lowStockSignals = lowStockSignalsFor(stock, local, activeReserved, confirmedCoverageGap);
      const activeThresholdKinds: OmnipackLowStockThresholdKind[] = lowStockSignals.map((signal) => signal.thresholdKind);
      if (currentCoverageGapSkus.has(stock.sku) && !activeThresholdKinds.includes("reservation_coverage")) {
        activeThresholdKinds.push("reservation_coverage");
      }
      for (const signal of lowStockSignals) {
        const evidence = await input.port.recordLowStockEvidence({
          idempotencyKey: `omnipack-low-stock:${stock.sku}:${signal.thresholdKind}`,
          sku: stock.sku,
          thresholdKind: signal.thresholdKind,
          severity: signal.severity,
          providerForSaleQuantity: stock.forSaleQuantity,
          localAvailableQuantity: localAvailable,
          evidence: {
            provider: "omnipack",
            source: "stock_sync",
            syncRunId,
            activeReservedQuantity: activeReserved,
            coverageGapQuantity: Math.max(0, activeReserved - stock.forSaleQuantity),
            localSafetyStock: local.safetyStock,
          },
        });
        if (evidence.replayed) result.replayed += 1;
        result.lowStock += evidence.replayed ? 0 : 1;
        if (signal.thresholdKind === "reservation_coverage") result.reservationCoverage += 1;
      }
      await input.port.resolveLowStockEvidence({
        sku: stock.sku,
        activeThresholdKinds,
        syncRunId,
        evidence: {
          provider: "omnipack",
          source: "stock_sync",
          providerForSaleQuantity: stock.forSaleQuantity,
          activeReservedQuantity: activeReserved,
        },
      });
    }
    for (const sku of packagingSkus) {
      await input.port.resolveLowStockEvidence({
        sku,
        activeThresholdKinds: [],
        syncRunId,
        evidence: { provider: "omnipack", source: "stock_sync", inventoryClass: "packaging" },
      });
    }
  }

  await input.port.recordCursor({
    status: result.ok ? "succeeded" : "failed",
    lastStockSyncedAt: result.ok ? now.toISOString() : null,
    lastMovementOccurredAt: result.lastMovementOccurredAt,
    cursor: {
      syncRunId,
      checked: result.checked,
      movements: result.movements,
      coverageGapSkus: result.ok ? [...currentCoverageGapSkus].sort() : [],
    },
    error: result.ok ? {} : { reason: result.reason ?? "omnipack_stock_sync_failed" },
  });

  // Recovery: a healthy run (succeeded, not itself stale) closes any open stale_sync row.
  if (result.ok && !syncIsStale) {
    await input.port.resolveLowStockEvidence({
      sku: OMNIPACK_STALE_SYNC_EVIDENCE_SKU,
      activeThresholdKinds: [],
      syncRunId,
      evidence: { kind: "stock_sync_recovered", recoveredAt: now.toISOString() },
    });
  }

  return result;
}

function lowStockSignalsFor(
  stock: OmnipackStockEvidence,
  local: OmnipackLocalInventoryBalance,
  activeReserved: number,
  confirmedCoverageGap: boolean,
): Array<{ thresholdKind: "safety_stock" | "reservation_coverage"; severity: "warning" | "critical" }> {
  const signals: Array<{ thresholdKind: "safety_stock" | "reservation_coverage"; severity: "warning" | "critical" }> = [];
  const remainingAfterReservations = Math.max(0, stock.forSaleQuantity - activeReserved);
  if (local.safetyStock > 0 && remainingAfterReservations <= local.safetyStock) {
    signals.push({ thresholdKind: "safety_stock", severity: remainingAfterReservations <= 0 ? "critical" : "warning" });
  }
  if (confirmedCoverageGap) signals.push({ thresholdKind: "reservation_coverage", severity: "critical" });
  return signals;
}

function readStringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []);
}

function availableQuantity(balance: OmnipackLocalInventoryBalance): number {
  return Math.max(0, balance.onHand - balance.reserved - balance.unavailable - balance.safetyStock);
}

function emptyLocal(sku: string): OmnipackLocalInventoryBalance {
  return { sku, onHand: 0, reserved: 0, unavailable: 0, safetyStock: 0 };
}

function latestOccurredAt(movements: OmnipackStockMovementEvidence[]): string | null {
  return movements
    .map((movement) => movement.occurredAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
