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


it("skips blank stock SKU refs before classification and persistence as in the base worker", async () => {
  const f = fixture(), [stock] = await f.input.provider.getStock();
  if ("kind" in stock) throw Error("expected_stock_fixture");
  f.input.provider.getStock = async () => [{ ...stock, skuRef: "" }, stock, { ...stock, skuRef: "  " }];
  f.input.port.readSkuInventoryClasses = async skus => {
    expect(skus).toEqual(["sku-a"]);
    return new Map([["sku-a", "sellable"]]);
  };
  const written: string[] = [];
  f.input.port.recordProviderStockCurrent = async ({ snapshot }) => {
    written.push(snapshot.skuRef); return { replayed: false, readBack: true };
  };
  expect(await run(f.input)).toMatchObject({ ok: true, checked: 1, rejected: 0, failures: 0 });
  expect(written).toEqual(["sku-a"]);
  expect(f.snapshots.map(value => value.snapshot.skuRef)).toEqual(["sku-a"]);
});

it("keeps mixed-batch alerts, coverage confirmation, resolution and stale recovery successful", async () => {
  const f = fixture(), [stock] = await f.input.provider.getStock();
  if ("kind" in stock) throw Error("expected_stock_fixture");
  f.lines[0].quantity.safetyStock = 1;
  f.input.provider.getStock = async () => [stock, { kind: "rejected", itemIndex: 1, reason: "invalid_sku_ref" }];
  f.input.provider.getStockMovements = async () => [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref" }];
  expect(await run(f.input)).toMatchObject({ ok: true, checked: 1, rejected: 2, lowStock: 1 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at, coverageGapSkus: ["sku-a"],
    counts: { rejected: 2 }, error: null, refusal: null });
  expect(await run(f.input)).toMatchObject({ ok: true, reservationCoverage: 1 });
  expect(f.evidence).toContainEqual(expect.objectContaining({ skuRef: "sku-a", thresholdKind: "reservation_coverage" }));
  expect(f.resolutions).toContainEqual({ skuRef: "sku-a", activeThresholdKinds: ["safety_stock", "reservation_coverage"], syncRunId: "legacy-stock-run" });
  expect(f.resolutions).toContainEqual({ skuRef: "legacy-sentinel", activeThresholdKinds: [], syncRunId: "legacy-stock-run" });
  f.input.port.readActiveReservations = async () => new Map();
  f.evidence.length = 0; f.resolutions.length = 0;
  expect(await run(f.input)).toMatchObject({ ok: true, lowStock: 0, reservationCoverage: 0, rejected: 2 });
  expect(f.evidence).toEqual([]);
  expect(f.resolutions).toContainEqual({ skuRef: "sku-a", activeThresholdKinds: [], syncRunId: "legacy-stock-run" });
  expect(f.cursor()).toMatchObject({ status: "succeeded", coverageGapSkus: [] });
});

it("contains pre-terminal port failures as safe failed results, preserving terminal cursor rejection", async () => {
  for (const [method, reason] of [
    ["readCursor", "cursor_read_failed"], ["readLocalInventoryStock", "stock_read_failed"],
    ["readSkuInventoryClasses", "stock_inventory_read_failed"], ["readActiveReservations", "stock_inventory_read_failed"],
    ["recordProviderStockCurrent", "stock_current_write_failed"], ["recordStockSnapshot", "snapshot_write_failed"],
    ["recordLowStockEvidence", "stock_evidence_write_failed"], ["resolveLowStockEvidence", "stock_evidence_resolve_failed"],
  ] as const) {
    const f = fixture(); f.lines[0].quantity.safetyStock = 1;
    f.input.port[method] = async () => { throw Error("private-transport-error"); };
    expect(await run(f.input), method).toMatchObject({ ok: false, failures: 1, reason });
    expect(f.cursor(), method).toMatchObject({ status: "failed", lastStockSyncedAt: null, error: { reason }, refusal: { reason: "io_failure", retryable: true } });
  }
  const f = fixture(), recordCursor = f.input.port.recordCursor;
  f.input.port.recordCursor = async value => {
    if (value.status === "running") throw Error("private-transport-error");
    await recordCursor(value);
  };
  expect(await run(f.input)).toMatchObject({ ok: false, reason: "cursor_write_failed" });
  expect(f.cursor()).toMatchObject({ status: "failed", error: { reason: "cursor_write_failed" } });
  f.input.port.recordCursor = async value => {
    if (value.status !== "running") throw Error("terminal-cursor-unavailable");
  };
  await expect(run(f.input)).rejects.toThrow("terminal-cursor-unavailable");
});

it("resolves stale recovery only after the terminal cursor and preserves completion if cleanup fails", async () => {
  const f = fixture(), resolve = f.input.port.resolveLowStockEvidence;
  let recoveries = 0;
  f.input.port.resolveLowStockEvidence = async value => {
    if (value.skuRef !== "legacy-sentinel") return resolve(value);
    recoveries += 1;
    expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at });
    throw Error("private-stale-recovery-error");
  };
  expect(await run(f.input)).toMatchObject({ ok: true, failures: 0 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", error: null, refusal: null });
  expect(recoveries).toBe(1);
  f.input.port.recordCursor = async value => {
    if (value.status !== "running") throw Error("terminal-cursor-unavailable");
  };
  await expect(run(f.input)).rejects.toThrow("terminal-cursor-unavailable");
  expect(recoveries).toBe(1);
});

it("preserves successful completion when stale recovery throws synchronously", async () => {
  const f = fixture();
  f.input.provider.getStock = async () => [];
  let recoveries = 0;
  f.input.port.resolveLowStockEvidence = () => {
    recoveries += 1;
    expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at });
    throw Error("synchronous-cleanup-failure");
  };
  expect(await run(f.input)).toMatchObject({ ok: true, failures: 0 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at, error: null, refusal: null });
  expect(recoveries).toBe(1);
});
