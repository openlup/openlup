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

// Mirror the native SQL fingerprint fence without claiming to refresh stored observations.
async function nativeAlertPort() {
  const { createPostgresFulfillmentStockSyncPort } = await import("../../src/fulfillment/postgresStockSyncPort.js");
  const receipts = new Map<string, unknown>();
  return createPostgresFulfillmentStockSyncPort({ async query(_sql, values = []) {
    const key = String(values[1]), prior = receipts.get(key);
    if (prior && prior !== values[2]) throw Object.assign(Error("fulfillment_stock_evidence_idempotency_conflict"), { code: "23505" });
    receipts.set(key, values[2]);
    return { rows: [{ response: { replayed: Boolean(prior) } }] };
  } }, { sourceKey: "warehouse-a", readLocalInventoryStock: async () => [] });
}

it("replays native alerts across stock runs when quantities and severity change (S4)", async () => {
  const port = await nativeAlertPort(), f = fixture();
  let runNumber = 0, forSaleQuantity = 5;
  const stock = (await f.input.provider.getStock())[0];
  if ("kind" in stock) throw new Error("expected_stock_fixture");
  f.input.provider.getStock = async () => [{ ...stock, forSaleQuantity }];
  f.input.compatibility.syncRunId = () => `run-${++runNumber}`;
  f.input.port.readActiveReservations = async () => new Map([["sku-a", 3]]);
  f.lines[0].quantity.safetyStock = 6;
  f.input.port.recordLowStockEvidence = async value => {
    f.evidence.push(value);
    return port.recordLowStockEvidence(value);
  };
  expect(await run(f.input)).toMatchObject({ ok: true, lowStock: 1, replayed: 0, failures: 0 });
  forSaleQuantity = 3;
  f.lines[0].quantity.onHand = 9;
  expect(await run(f.input)).toMatchObject({ ok: true, lowStock: 0, replayed: 1, failures: 0 });
  expect(f.evidence).toEqual([
    expect.objectContaining({ requestKey: "legacy:sku-a:safety_stock", syncRunId: "run-1", severity: "warning", providerForSaleQuantity: 5, localAvailableQuantity: 1 }),
    expect.objectContaining({ requestKey: "legacy:sku-a:safety_stock", syncRunId: "run-2", severity: "critical", providerForSaleQuantity: 3, localAvailableQuantity: 0 }),
  ]);
  expect(await port.recordLowStockEvidence(f.evidence[1])).toEqual({ replayed: true });
});

it("uses distinct alert keys for different SKUs or thresholds and fences reused identity (S4)", async () => {
  const port = await nativeAlertPort(), f = fixture();
  const alert = { requestKey: f.input.compatibility.lowStockKey("sku-a", "reservation_coverage"), skuRef: "sku-a", thresholdKind: "reservation_coverage" as const,
    severity: "critical" as const, providerForSaleQuantity: 5, localAvailableQuantity: 6, syncRunId: "run-1" };
  expect(await port.recordLowStockEvidence(alert)).toEqual({ replayed: false });
  for (const change of [{ skuRef: "sku-b", thresholdKind: "reservation_coverage" as const },
    { skuRef: "sku-a", thresholdKind: "safety_stock" as const }]) {
    const requestKey = f.input.compatibility.lowStockKey(change.skuRef, change.thresholdKind);
    expect(requestKey).not.toBe(alert.requestKey);
    const changedAlert = { ...alert, ...change, requestKey };
    expect(await port.recordLowStockEvidence(changedAlert)).toEqual({ replayed: false });
    expect(await port.recordLowStockEvidence(changedAlert)).toEqual({ replayed: true });
    await expect(port.recordLowStockEvidence({ ...alert, ...change })).rejects.toMatchObject({ code: "23505" });
  }
});
