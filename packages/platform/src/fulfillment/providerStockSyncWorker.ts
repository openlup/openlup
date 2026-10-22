import { aggregateAtpCompatibleStock, emptyLocal, stockMovementWindow } from "./providerStockAvailability.js";
import type { FulfillmentStockSyncPort, FulfillmentStockSyncProvider, LocalStock, StockSnapshot, StockMovement } from "./contracts/index.js";
type Threshold = Parameters<FulfillmentStockSyncPort["resolveLowStockEvidence"]>[0]["activeThresholdKinds"][number];
interface StockSyncResult {
  ok: boolean; checked: number; updated: number; mismatches: number; reservationCoverage: number;
  unclassified: number; lowStock: number; movements: number; replayed: number; failures: number;
  providerCalls: number; readBacks: number; skipped: boolean; syncRunId: string;
  lastMovementOccurredAt: string | null; reason?: string;
}
export async function runFulfillmentStockSyncWorker(input: {
  port: FulfillmentStockSyncPort;
  provider: FulfillmentStockSyncProvider;
  movementBatchSize: number;
  staleSyncThresholdHours?: number;
  now?: () => Date;
  compatibility: {
    syncRunId(now: Date): string; staleEvidenceSku: string; timeZone: string;
    currentKey(run: string, sku: string): string; snapshotKey(run: string, sku: string): string;
    lowStockKey(sku: string, threshold: Threshold): string; staleKey(lastSyncedAt: string): string;
  };
}): Promise<StockSyncResult> {
  const now = input.now?.() ?? new Date();
  const staleThresholdHours = input.staleSyncThresholdHours && input.staleSyncThresholdHours > 0
    ? input.staleSyncThresholdHours
    : 6;
  const syncRunId = input.compatibility.syncRunId(now);
  const result: StockSyncResult = {
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
      requestKey: input.compatibility.staleKey(previousCursor!.lastStockSyncedAt!),
      skuRef: input.compatibility.staleEvidenceSku,
      thresholdKind: "stale_sync",
      severity: "warning",
      providerForSaleQuantity: 0,
      localAvailableQuantity: 0,
      syncRunId,
    });
  }

  await input.port.recordCursor({
    status: "running",
    lastStockSyncedAt: null,
    lastMovementOccurredAt: null,
    continuation: { nextRef: null, startLocalDate: null, endLocalDate: null },
    coverageGapSkus: [], refusal: null,
  });

  const [localStock, providerStock] = await Promise.all([
    input.port.readLocalInventoryStock(now.toISOString()),
    input.provider.getStock(),
  ]);
  result.providerCalls += 1;

  const stockItems = providerStock.filter((item) => item.skuRef.trim());
  const skus = [...new Set(stockItems.map((item) => item.skuRef))];
  const [inventoryClasses, activeReservations] = await Promise.all([
    input.port.readSkuInventoryClasses(skus),
    input.port.readActiveReservations(skus, now.toISOString()),
  ]);

  const movements = await input.provider.getStockMovements({ ...stockMovementWindow(previousCursor, now, input.compatibility.timeZone), size: input.movementBatchSize });
  result.providerCalls += 1;
  result.movements = movements.length;
  result.lastMovementOccurredAt = latestOccurredAt(movements);

  const localBySku = aggregateAtpCompatibleStock(localStock, now);
  const coverageCandidates: Array<{
    stock: StockSnapshot;
    local: LocalStock;
    activeReserved: number;
  }> = [];
  const currentCoverageGapSkus = new Set<string>();
  const packagingSkus = new Set<string>();
  const previousCoverageGapSkus = previousCursor?.status === "succeeded"
    ? readStringSet(previousCursor.coverageGapSkus)
    : new Set<string>();

  for (const stock of stockItems) {
    try {
      const local = localBySku.get(stock.skuRef) ?? emptyLocal(stock.skuRef);
      const inventoryClass = inventoryClasses.get(stock.skuRef) ?? null;
      const activeReserved = activeReservations.get(stock.skuRef) ?? 0;
      const staleAfter = new Date(now.getTime() + staleThresholdHours * 3_600_000).toISOString();
      const current = await input.port.recordProviderStockCurrent({
        requestKey: input.compatibility.currentKey(syncRunId, stock.skuRef),
        snapshot: stock, inventoryClass, lastSyncedAt: now.toISOString(), staleAfter,
      });
      const snapshot = await input.port.recordStockSnapshot({
        requestKey: input.compatibility.snapshotKey(syncRunId, stock.skuRef),
        snapshot: stock, local, mismatchKind: "none", inventoryClass,
      });

      result.checked += 1;
      result.updated += (snapshot.replayed ? 0 : 1) + (current.replayed ? 0 : 1);
      if (snapshot.replayed) result.replayed += 1;
      if (current.replayed) result.replayed += 1;
      if (snapshot.readBack) result.readBacks += 1;
      if (current.readBack) result.readBacks += 1;
      if (inventoryClass === null) result.unclassified += 1;
      if (inventoryClass === "packaging") packagingSkus.add(stock.skuRef);
      if (inventoryClass === "sellable") {
        coverageCandidates.push({ stock, local, activeReserved });
        if (activeReserved > stock.forSaleQuantity) currentCoverageGapSkus.add(stock.skuRef);
      }
    } catch (error) {
      result.ok = false;
      result.failures += 1;
      result.reason = result.reason ?? "stock_sync_operation_failed";
    }
  }

  if (result.ok) {
    for (const { stock, local, activeReserved } of coverageCandidates) {
      const localAvailable = availableQuantity(local);
      const confirmedCoverageGap = currentCoverageGapSkus.has(stock.skuRef) && previousCoverageGapSkus.has(stock.skuRef);
      const lowStockSignals = lowStockSignalsFor(stock, local, activeReserved, confirmedCoverageGap);
      const activeThresholdKinds: Threshold[] = lowStockSignals.map((signal) => signal.thresholdKind);
      if (currentCoverageGapSkus.has(stock.skuRef) && !activeThresholdKinds.includes("reservation_coverage")) {
        activeThresholdKinds.push("reservation_coverage");
      }
      for (const signal of lowStockSignals) {
        const evidence = await input.port.recordLowStockEvidence({
          requestKey: input.compatibility.lowStockKey(stock.skuRef, signal.thresholdKind),
          skuRef: stock.skuRef, thresholdKind: signal.thresholdKind, severity: signal.severity,
          providerForSaleQuantity: stock.forSaleQuantity, localAvailableQuantity: localAvailable, syncRunId,
        });
        if (evidence.replayed) result.replayed += 1;
        result.lowStock += evidence.replayed ? 0 : 1;
        if (signal.thresholdKind === "reservation_coverage") result.reservationCoverage += 1;
      }
      await input.port.resolveLowStockEvidence({
        skuRef: stock.skuRef,
        activeThresholdKinds,
        syncRunId,
      });
    }
    for (const sku of packagingSkus) {
      await input.port.resolveLowStockEvidence({
        skuRef: sku,
        activeThresholdKinds: [],
        syncRunId,
      });
    }
  }

  await input.port.recordCursor({
    status: result.ok ? "succeeded" : "failed",
    lastStockSyncedAt: result.ok ? now.toISOString() : null,
    lastMovementOccurredAt: result.lastMovementOccurredAt,
    continuation: { nextRef: null, startLocalDate: null, endLocalDate: null },
    coverageGapSkus: result.ok ? [...currentCoverageGapSkus].sort() : [],
    refusal: result.ok ? null : { reason: "io_failure", phase: "sync", retryable: true },
  });

  // Recovery: a healthy run (succeeded, not itself stale) closes any open stale_sync row.
  if (result.ok && !syncIsStale) {
    await input.port.resolveLowStockEvidence({
      skuRef: input.compatibility.staleEvidenceSku,
      activeThresholdKinds: [],
      syncRunId,

    });
  }

  return result;
}

function lowStockSignalsFor(
  stock: StockSnapshot,
  local: LocalStock,
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

function availableQuantity(balance: LocalStock): number {
  return Math.max(0, balance.onHand - balance.reserved - balance.unavailable - balance.safetyStock);
}

function latestOccurredAt(movements: StockMovement[]): string | null {
  return movements
    .map((movement) => movement.occurredAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
