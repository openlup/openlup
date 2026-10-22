import { expect, it } from "vitest";
import type { FulfillmentStockSyncPort, StockSnapshot, SyncCursor } from "../../src/fulfillment/contracts/index.js";
import { runFulfillmentStockSyncWorker as run } from "../../src/fulfillment/index.js";
import { stockMovementWindow } from "../../src/fulfillment/providerStockAvailability.js";
import { at } from "./fixtures.js";

function fixture() {
  let cursor: SyncCursor | null = null, fail = false;
  const evidence: Parameters<FulfillmentStockSyncPort["recordLowStockEvidence"]>[0][] = [], snapshots: Parameters<FulfillmentStockSyncPort["recordStockSnapshot"]>[0][] = [], requested: string[] = [], resolutions: Parameters<FulfillmentStockSyncPort["resolveLowStockEvidence"]>[0][] = [];
  const stock: StockSnapshot = { providerRef: "warehouse-a", syncRunId: "legacy-run", collectedAt: at, sourceRevision: null, revisionSource: "collection", skuRef: "sku-a", quantityKind: "snapshot", totalQuantity: 9, forSaleQuantity: 5, reservedOrUnavailableQuantity: 4 };
  const line: Awaited<ReturnType<FulfillmentStockSyncPort["readLocalInventoryStock"]>>[number] = { skuRef: "sku-a", quantity: { onHand: 10, reserved: 2, unavailable: 1, safetyStock: 0 }, fulfillable: true, locationStatus: "active", lotStatus: "available", expiresAt: null };
  const lines = [line];
  const input: Parameters<typeof run>[0] = {
    now: () => new Date(at), movementBatchSize: 20,
    compatibility: { syncRunId: () => "legacy-stock-run", staleEvidenceSku: "legacy-sentinel", timeZone: "Etc/GMT-2", currentKey: (r, s) => `${r}:current:${s}`, snapshotKey: (r, s) => `${r}:snapshot:${s}`, lowStockKey: (s, t) => `legacy:${s}:${t}`, staleKey: last => `legacy-stale:${last}` },
    provider: { async getStock() { return [stock]; }, async getStockMovements() { return []; } },
    port: { async readCursor() { return cursor; }, async readLocalInventoryStock(requestedAt) { requested.push(requestedAt); return lines; },
      async readSkuInventoryClasses() { return new Map([["sku-a", "sellable"]]); }, async readActiveReservations(_skus, requestedAt) { requested.push(requestedAt); return new Map([["sku-a", 6]]); },
      async recordCursor(value) { cursor = structuredClone(value); },
      async recordStockSnapshot(value) { snapshots.push(value); if (fail) throw new Error("synthetic-private-stock"); return { replayed: false, readBack: true }; },
      async recordProviderStockCurrent() { return { replayed: false, readBack: true }; }, async recordMovement() { return { replayed: false, readBack: false }; },
      async recordLowStockEvidence(value) { evidence.push(value); return { replayed: false }; }, async resolveLowStockEvidence(value) { resolutions.push(value); return { resolved: 1 }; },
    },
  };
  return { input, lines, evidence, snapshots, requested, resolutions, cursor: () => cursor, setCursor(value: SyncCursor | null) { cursor = value; }, fail(value: boolean) { fail = value; } };
}

it("confirms reservation coverage on the second consecutive successful gap run and resets after failure (G15)", async () => {
  const f = fixture();
  expect(await run(f.input)).toMatchObject({ ok: true, reservationCoverage: 0, lowStock: 0 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", coverageGapSkus: ["sku-a"] });
  expect(await run(f.input)).toMatchObject({ ok: true, reservationCoverage: 1 });
  expect(f.evidence).toEqual([expect.objectContaining({ thresholdKind: "reservation_coverage", severity: "critical", providerForSaleQuantity: 5 })]);
  f.fail(true); expect(await run(f.input)).toMatchObject({ ok: false, failures: 1 });
  expect(f.cursor()).toMatchObject({ status: "failed", coverageGapSkus: [] });
  f.fail(false); f.evidence.length = 0;
  expect(await run(f.input)).toMatchObject({ ok: true, reservationCoverage: 0 });
  expect(f.evidence).toEqual([]);
  expect(await run(f.input)).toMatchObject({ reservationCoverage: 1 });
  const legacy = fixture(); legacy.setCursor({ status: "succeeded", lastStockSyncedAt: at, lastMovementOccurredAt: null, continuation: { nextRef: null, startLocalDate: null, endLocalDate: null }, refusal: null });
  expect(await run(legacy.input)).toMatchObject({ reservationCoverage: 0 });
});

it("filters exact-time expiry and unusable locations/lots at captured now while preserving freshness/window rules (G16)", async () => {
  const f = fixture(); const usable = f.lines[0];
  f.lines.push({ ...usable, expiresAt: at }, { ...usable, expiresAt: "2026-10-21T11:59:59.999Z" },
    { ...usable, fulfillable: false }, { ...usable, locationStatus: "inactive" }, { ...usable, lotStatus: "quarantined" },
    { ...usable, expiresAt: "2026-10-21T12:00:00.001Z" });
  expect(await run(f.input)).toMatchObject({ ok: true, readBacks: 2 });
  expect(f.snapshots[0].local).toEqual({ skuRef: "sku-a", onHand: 20, reserved: 4, unavailable: 2, safetyStock: 0 });
  expect(f.requested).toEqual([at, at]);
  f.setCursor({ status: "succeeded", lastStockSyncedAt: "2026-10-21T06:00:00.000Z", lastMovementOccurredAt: null, continuation: { nextRef: null, startLocalDate: null, endLocalDate: null }, coverageGapSkus: [], refusal: null });
  await run(f.input);
  expect(f.evidence).toContainEqual(expect.objectContaining({ skuRef: "legacy-sentinel", thresholdKind: "stale_sync", severity: "warning" }));
  expect(stockMovementWindow(null, new Date("2026-10-21T22:30:00Z"), "Etc/GMT-2")).toEqual({ startLocalDate: "2026-10-21", endLocalDate: "2026-10-21" });
  f.input.port.readSkuInventoryClasses = async () => new Map([["sku-a", "packaging"]]);
  f.evidence.length = 0; await run(f.input);
  expect(f.evidence).toEqual([]); expect(f.resolutions).toContainEqual(expect.objectContaining({ skuRef: "sku-a", activeThresholdKinds: [] }));
});
