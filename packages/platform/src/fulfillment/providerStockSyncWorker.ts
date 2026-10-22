import { aggregateAtpCompatibleStock, emptyLocal, stockMovementWindow } from "./providerStockAvailability.js";
import type { FulfillmentStockSyncPort, FulfillmentStockSyncProvider, LocalStock, StockSnapshot, StockMovement, SyncCursor } from "./contracts/index.js";
type Threshold = Parameters<FulfillmentStockSyncPort["resolveLowStockEvidence"]>[0]["activeThresholdKinds"][number];
interface StockSyncResult {
  ok: boolean; checked: number; updated: number; mismatches: number; reservationCoverage: number;
  unclassified: number; lowStock: number; movements: number; replayed: number; failures: number;
  providerCalls: number; readBacks: number; skipped: boolean; syncRunId: string;
  lastMovementOccurredAt: string | null; reason?: string;
  rejected: number; items: NonNullable<SyncCursor["items"]>[number][];
  providerError?: NonNullable<SyncCursor["error"]>["providerError"];
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
    rejected: 0,
    items: [],
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

  const alerts: NonNullable<SyncCursor["alerts"]>[number][] = [];
  let stage = "cursor_read_failed";
  let operationalReason: string | undefined;
  let staleSync: SyncCursor["staleSync"];
  let recoverStaleSync = false;
  const currentCoverageGapSkus = new Set<string>();
  try {
    const previousCursor = await input.port.readCursor();

    // Stale-sync alert: if the last successful sync aged past the threshold, open a stale_sync
    // low-stock evidence row (evidence/warn — never blocks sales); a healthy run resolves it
    // below. A never-synced state (no prior cursor) is not "stale".
    const lastSyncedMs = previousCursor?.lastStockSyncedAt ? Date.parse(previousCursor.lastStockSyncedAt) : null;
    const staleGapHours =
      lastSyncedMs !== null && !Number.isNaN(lastSyncedMs) ? (now.getTime() - lastSyncedMs) / 3_600_000 : null;
    const syncIsStale = staleGapHours !== null && staleGapHours >= staleThresholdHours;
    recoverStaleSync = !syncIsStale;
    if (syncIsStale) {
      staleSync = { gapHours: Math.round(staleGapHours! * 10) / 10, thresholdHours: staleThresholdHours, detectedAt: now.toISOString() };
      stage = "stock_evidence_write_failed";
      alerts.push({ skuRef: input.compatibility.staleEvidenceSku, thresholdKind: "stale_sync", severity: "warning",
        providerForSaleQuantity: 0, localAvailableQuantity: 0, ...staleSync });
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

    stage = "cursor_write_failed";
    await input.port.recordCursor({
      syncRunId,
      status: "running",
      lastStockSyncedAt: null,
      lastMovementOccurredAt: null,
      continuation: { nextRef: null, startLocalDate: null, endLocalDate: null },
      coverageGapSkus: [], refusal: null,
    });

    stage = "stock_read_failed";
    result.providerCalls += 1;
    const [localStock, providerStock] = await Promise.all([
      input.port.readLocalInventoryStock(now.toISOString()),
      input.provider.getStock(),
    ]);
    const stockItems: { stock: StockSnapshot; itemIndex: number }[] = [];
    for (const [itemIndex, item] of providerStock.entries()) {
      if ("kind" in item && item.kind === "rejected") {
        result.rejected += 1;
        result.failures += 1;
        result.items.push({ kind: "stock", itemIndex: item.itemIndex, skuRef: null, status: "rejected", reason: item.reason });
      } else if ("skuRef" in item && item.skuRef.trim()) {
        stockItems.push({ stock: item, itemIndex });
      }
    }
    const skus = [...new Set(stockItems.map(({ stock }) => stock.skuRef))];
    stage = "stock_inventory_read_failed";
    const [inventoryClasses, activeReservations] = await Promise.all([
      input.port.readSkuInventoryClasses(skus),
      input.port.readActiveReservations(skus, now.toISOString()),
    ]);

    stage = "stock_movements_read_failed";
    result.providerCalls += 1;
    const movementRows = await input.provider.getStockMovements({ ...stockMovementWindow(previousCursor, now, input.compatibility.timeZone), size: input.movementBatchSize });
    const movements: StockMovement[] = [];
    for (const item of movementRows) {
      if ("kind" in item && item.kind === "rejected") {
        result.rejected += 1;
        result.failures += 1;
        result.items.push({ kind: "movement", itemIndex: item.itemIndex, skuRef: null, status: "rejected", reason: item.reason });
      } else if ("skuRef" in item) {
        movements.push(item);
      }
    }
    if (result.rejected > 0 && stockItems.length + movements.length === 0) {
      result.ok = false;
      result.reason = "invalid_sku_ref";
    }
    result.movements = movements.length;
    result.lastMovementOccurredAt = latestOccurredAt(movements);

    const localBySku = aggregateAtpCompatibleStock(localStock, now);
    const coverageCandidates: Array<{
      stock: StockSnapshot;
      local: LocalStock;
      activeReserved: number;
    }> = [];
    const packagingSkus = new Set<string>();
    const previousCoverageGapSkus = previousCursor?.status === "succeeded"
      ? readStringSet(previousCursor.coverageGapSkus)
      : new Set<string>();

    for (const { stock, itemIndex } of stockItems) {
      try {
        const local = localBySku.get(stock.skuRef) ?? emptyLocal(stock.skuRef);
        const inventoryClass = inventoryClasses.get(stock.skuRef) ?? null;
        const activeReserved = activeReservations.get(stock.skuRef) ?? 0;
        const staleAfter = new Date(now.getTime() + staleThresholdHours * 3_600_000).toISOString();
        stage = "stock_current_write_failed";
        const current = await input.port.recordProviderStockCurrent({
          requestKey: input.compatibility.currentKey(syncRunId, stock.skuRef),
          snapshot: stock, inventoryClass, lastSyncedAt: now.toISOString(), staleAfter,
        });
        stage = "snapshot_write_failed";
        const snapshot = await input.port.recordStockSnapshot({
          requestKey: input.compatibility.snapshotKey(syncRunId, stock.skuRef),
          snapshot: stock, local, mismatchKind: "none", inventoryClass,
        });

        result.items.push({ itemIndex, skuRef: stock.skuRef, status: "recorded", activeReserved,
          sellableNow: inventoryClass === "sellable" ? Math.max(0, stock.forSaleQuantity - activeReserved - local.safetyStock) : null,
          coverageGapQuantity: Math.max(0, activeReserved - stock.forSaleQuantity) });
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
        const reason = safeReason(error, stage);
        operationalReason ??= reason;
        result.items.push({ itemIndex, skuRef: stock.skuRef, status: "failed", reason });
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
          alerts.push({ skuRef: stock.skuRef, thresholdKind: signal.thresholdKind, severity: signal.severity,
            providerForSaleQuantity: stock.forSaleQuantity, localAvailableQuantity: localAvailable, detectedAt: now.toISOString(),
            activeReserved, coverageGapQuantity: Math.max(0, activeReserved - stock.forSaleQuantity) });
          stage = "stock_evidence_write_failed";
          const evidence = await input.port.recordLowStockEvidence({
            requestKey: input.compatibility.lowStockKey(stock.skuRef, signal.thresholdKind),
            skuRef: stock.skuRef, thresholdKind: signal.thresholdKind, severity: signal.severity,
            providerForSaleQuantity: stock.forSaleQuantity, localAvailableQuantity: localAvailable, syncRunId,
          });
          if (evidence.replayed) result.replayed += 1;
          result.lowStock += evidence.replayed ? 0 : 1;
          if (signal.thresholdKind === "reservation_coverage") result.reservationCoverage += 1;
        }
        stage = "stock_evidence_resolve_failed";
        await input.port.resolveLowStockEvidence({
          skuRef: stock.skuRef,
          activeThresholdKinds,
          syncRunId,
        });
      }
      for (const sku of packagingSkus) {
        stage = "stock_evidence_resolve_failed";
        await input.port.resolveLowStockEvidence({
          skuRef: sku,
          activeThresholdKinds: [],
          syncRunId,
        });
      }
    }
  } catch (error) {
    result.ok = false;
    result.failures += 1;
    result.providerError = providerDiagnostic(error);
    operationalReason ??= result.providerError ? `provider_${result.providerError.operation}_failed:${result.providerError.code}` : safeReason(error, stage);
  }

  result.reason = operationalReason ?? result.reason;
  await input.port.recordCursor({
    status: result.ok ? "succeeded" : "failed", syncRunId,
    lastStockSyncedAt: result.ok ? now.toISOString() : null,
    lastMovementOccurredAt: result.lastMovementOccurredAt,
    continuation: { nextRef: null, startLocalDate: null, endLocalDate: null },
    coverageGapSkus: result.ok ? [...currentCoverageGapSkus].sort() : [],
    refusal: result.ok ? null : { reason: result.failures === result.rejected ? "malformed" : "io_failure", phase: "sync", retryable: result.providerError?.retryable ?? result.failures > result.rejected },
    error: result.ok ? null : { reason: result.reason!, ...(result.providerError ? { providerError: result.providerError } : {}) },
    counts: { checked: result.checked, updated: result.updated, movements: result.movements, rejected: result.rejected,
      failures: result.failures, providerCalls: result.providerCalls, readBacks: result.readBacks },
    items: result.items, alerts, staleSync,
  });
  // Recovery follows the durable succeeded cursor; a failed cleanup leaves the completed run intact.
  if (result.ok && recoverStaleSync) {
    try {
      await input.port.resolveLowStockEvidence({
        skuRef: input.compatibility.staleEvidenceSku,
        activeThresholdKinds: [],
        syncRunId,
      });
    } catch { /* Best-effort cleanup must not undo the completed run. */ }
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

/** Keep the operation's closed identity and SQLSTATE only, never arbitrary exception prose. */
function safeReason(error: unknown, operation: string): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `${operation}:${code}`;
  const known = error instanceof Error ? error.message.match(new RegExp(`^${operation}:([0-9A-Z]{5})$`)) : null;
  return known ? `${operation}:${known[1]}` : operation;
}
function providerDiagnostic(error: unknown): StockSyncResult["providerError"] {
  if (!error || typeof error !== "object" || !("providerError" in error)) return undefined;
  const detail = error.providerError;
  if (!detail || typeof detail !== "object" || !("operation" in detail) || !("code" in detail) || !("status" in detail) || !("retryable" in detail)) return undefined;
  if (detail.operation !== "get_stock" && detail.operation !== "get_stock_movements") return undefined;
  if (typeof detail.code !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(detail.code)) return undefined;
  return { operation: detail.operation, code: detail.code,
    status: typeof detail.status === "number" && Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599 ? detail.status : null,
    retryable: detail.retryable === true };
}
